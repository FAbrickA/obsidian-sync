import type { RepositoryV2 } from './repository.ts';
import { RepositoryErrorV2 } from './repository.ts';
import type { StateV2 } from './state.ts';
import type { LocalAccess } from './vault.ts';
import type { DirtyEvents, LocalSnapshot, LocalFile, SyncAction, Entry } from './types.ts';
import type { AppliedFileV2, ApplyObligationV2, OutboxOperationV2, Revision, RevisionCore, EventRecord, RunBoundaryV2,
  RunOutcomeV2, RemoteViewV2, ProjectionV2, IssueV2, CreationProofV2, V2Value } from './v2-types.ts';
import { limitsV2 } from './v2-types.ts';
import { createHistoryIndex, ingestContainers, selectHistory, reduceHistory, adoptLocal, equivalentHeads } from './v2-history.ts';
import { discover } from './v2-discovery.ts';
import { mergeHeads, resolveHeads } from './v2-merge.ts';
import type { ResolutionChoiceV2 } from './v2-merge.ts';
import { revisionId, eventId, encodeEvent } from './v2-codec.ts';
import { makeLocalRevisionV2 } from './planner.ts';
import { hashBytes } from './snapshots.ts';
import { classifyPath, isWithinPath, bookmarksKey } from './paths.ts';
import { validateBookmarks } from './bookmarks.ts';
import { DavError } from './transport.ts';
import {mapLimit} from './queue.ts';

const sameValue = (a: V2Value, b: V2Value) => a.kind === b.kind && a.path === b.path
  && (a.kind === 'tombstone' || b.kind === 'file' && a.hash === b.hash && a.size === b.size);
const matches = (value: V2Value, local: LocalFile | null) => value.kind === 'tombstone' ? !local
  : !!local && local.path === value.path && local.hash === value.hash && local.size === value.size;
function localEntry(value: V2Value, fileId: string, priorHash: string | null): Entry | null {
  return value.kind === 'file' ? { ...value, fileId } : priorHash ? { kind: 'tombstone', fileId, path: value.path, lastHash: priorHash } : null;
}
export function toLocalAction(revision: Revision, applied: AppliedFileV2 | null, snapshot: LocalSnapshot, applicationId?: string): SyncAction {
  const local = snapshot.files[applied?.value.path ?? revision.core.value.path] ?? snapshot.files[revision.core.value.path] ?? null;
  const priorHash = applied?.value.kind === 'file' ? applied.value.hash : applied?.baseHash ?? null;
  return { kind: revision.core.value.kind === 'tombstone' ? 'delete' : 'download', direction: 'local', fileId: revision.core.fileId,
    path: revision.core.value.path, base: applied ? localEntry(applied.value, applied.fileId, priorHash) : null,
    remote: localEntry(revision.core.value, revision.core.fileId, priorHash), local, applicationId };
}
export type EngineV2 = ReturnType<typeof createEngineV2>;
export function createEngineV2({ repository, state, local, projection, deletionGuardPercent = 20 }: {
  repository: RepositoryV2; state: StateV2; local: LocalAccess; projection: ProjectionV2; deletionGuardPercent?: number;
}) {
  const index = createHistoryIndex(repository.repositoryId);
  let initialDiscoveryComplete=false;
  let initialized: Promise<void> | undefined, queue = Promise.resolve(), positiveBlobs = new Set<string>(), positiveEvents = new Set<string>(), scopedIssues: IssueV2[] = [];
  const serialized = <T>(work: () => Promise<T>) => { const task = queue.then(work); queue = task.then(() => {}, () => {}); return task; };
  async function boot() {
    initialized ??= (async () => {
      await ingestContainers(index, await state.sourceIndex()); if (index.events.size) await state.admitEvents([...index.events.values()]);
      const baselines = await state.appliedFiles(), missing = () => Object.values(baselines).some(f => f.revisionIds.some(id => !index.revisions.has(id)));
      if (missing()) await discover(repository, index, { mode: 'canonical' });
      if (missing()) throw new RepositoryErrorV2('Incomplete');
    })().catch(error => { initialized = undefined; throw error; });
    return initialized;
  }
  let ingestion=Promise.resolve();
  function ingestFresh() {const task=ingestion.then(async()=>{
    const fresh = (await state.sourceIndex()).filter(c => !index.containers.has(c.slot.path));
    if (fresh.length) { const result = await ingestContainers(index, fresh); if (result.admitted.length) await state.admitEvents(result.admitted); }
  });ingestion=task.catch(()=>{});return task;}
  function owner(revision: Revision): string {
    const id = index.revisionEvents.get(revision.id)?.values().next().value; if (!id) throw new RepositoryErrorV2('Incomplete'); return id;
  }
  async function ensureMetadata(revision: Revision) {
    const id = owner(revision); if (!positiveEvents.has(id)) { await repository.ensureEventAvailable(id); positiveEvents.add(id); await ingestFresh(); }
  }
  async function readRevision(revision: Revision, remote = false): Promise<ArrayBuffer> {
    const value = revision.core.value; if (value.kind !== 'file') throw new Error('Deleted version has no content.');
    if (!remote || positiveBlobs.has(value.hash)) {
      try { const bytes = await state.readObject(value.hash); if (bytes.byteLength !== value.size) throw new Error('Invalid local size.'); if (remote) await ensureMetadata(revision); return bytes; }
      catch { /* Use verified remote aliases; never infer deletion from a missing local cache. */ }
    }
    try {
      const found = await repository.readBlob(value.hash, value.size); await state.storeObjects({ [value.hash]: found.bytes }); positiveBlobs.add(value.hash); index.bodyStates.set(value.hash, 'verified');
      if (remote) await ensureMetadata(revision);
      return found.bytes;
    } catch (error) {
      if (!(error instanceof RepositoryErrorV2 && error.code === 'Incomplete')) throw error;
      let bytes: ArrayBuffer;
      try { bytes = await state.readObject(value.hash); if (bytes.byteLength !== value.size) throw new RepositoryErrorV2('Corrupt'); }
      catch (localError) { if (localError instanceof DOMException) throw localError;
        if(projection.readCanonicalBytes) {try {bytes=await projection.readCanonicalBytes(revision);}catch{index.bodyStates.set(value.hash,'missing');throw new RepositoryErrorV2('Incomplete');}}
        else {index.bodyStates.set(value.hash, 'missing'); throw new RepositoryErrorV2('Incomplete');} }
      const proof = await repository.repairSources(owner(revision), { [value.hash]: bytes }); await ingestFresh(); positiveBlobs.add(value.hash); positiveEvents.add(proof.eventId); index.bodyStates.set(value.hash, 'verified'); return bytes;
    }
  }
  async function currentView() { await boot(); return reduceHistory(index); }
  async function captureBoundary(throughGeneration?: number): Promise<RunBoundaryV2> {
    await boot();
    const boundary:RunBoundaryV2={id:crypto.randomUUID(),throughGeneration:throughGeneration??(await state.getMeta<DirtyEvents>('dirty-events'))?.generation??0,admittedEventIds:[]};
    // A fresh attached vault cannot infer births from an empty frozen history.
    // Failed initial scans must be retried even though canonicalStarted is already true.
    if(!initialDiscoveryComplete){
      // Repair our already durable publication before its partial physical alias can
      // block discovery. This captures no new local edits and respects the generation cutoff.
      const allowed=new Set(index.events.keys());
      for(const op of (await state.outbox()).sort((a,b)=>a.dirtyGeneration-b.dirtyGeneration))
        if(op.event&&!op.proof&&op.dirtyGeneration<=boundary.throughGeneration)await publishOperation(op,boundary,allowed);
      const found=await discover(repository,index,{mode:'canonical'});
      if(!found.canonicalScanSettled||found.issues.some(p=>p.kind!=='hint')||found.view.coverage.pendingEvents.length)throw new RepositoryErrorV2('Incomplete');
      initialDiscoveryComplete=true;
    }
    return {...boundary,admittedEventIds:[...index.events.keys()].sort()};
  }
  function selected(snapshot: LocalSnapshot, path: string) {
    return (!snapshot.policy || classifyPath(path, snapshot.policy) !== 'exclude') && !snapshot.excluded.some(p => isWithinPath(path, p));
  }
  const blockedPath = (view: RemoteViewV2, path: string) => view.pathConflicts.some(c => c.paths.some(p => isWithinPath(path, p) || isWithinPath(p, path)));
  function recordScoped(error: unknown, fileId: string) {
    if (!(error instanceof RepositoryErrorV2 && ['Incomplete','Corrupt'].includes(error.code))) throw error;
    scopedIssues.push({ kind: 'source', code: error.code, relatedIds: [fileId] });
  }
  function covers(represented: string[], required: string[]): boolean {
    const pending = new Set(required), seen = new Set<string>(), stack = [...represented];
    while (stack.length && pending.size) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); pending.delete(id); if (pending.size) stack.push(...index.revisions.get(id)?.core.parents ?? []); }
    return pending.size === 0;
  }
  async function preservePrior(applied: AppliedFileV2 | null) {
    if (!applied || applied.value.kind !== 'file') return;
    const revision = index.revisions.get(applied.revisionIds[0]); if (!revision) throw new RepositoryErrorV2('Incomplete'); await readRevision(revision, true);
  }
  function obligation(revision: Revision, prior: AppliedFileV2 | null, expected: LocalFile | null, id: string, capturedGeneration: number): ApplyObligationV2 {
    return { fileId: revision.core.fileId, revisionIds: [revision.id], value: revision.core.value, expected: structuredClone(expected), prior: structuredClone(prior),
      applicationId: id, capturedLocal: matches(revision.core.value, expected), capturedGeneration };
  }
  async function applyOperation(op: OutboxOperationV2) {
    if (op.event && !['published', 'applying'].includes(op.phase)) return;
    if (op.phase !== 'applying') await state.advanceOperation(op.id, 'applying');
    const actual=await state.appliedFiles(),sources=new Map(op.apply.flatMap(a=>a.prior?.value.kind==='file'?[[a.prior.value.path,a]as const]:[]));
    const pathView=op.apply.some(a=>!a.capturedLocal)?await currentView():null;
    const waiting=new Map<string,ApplyObligationV2[]>(),ready:ApplyObligationV2[]=[],ordered:ApplyObligationV2[]=[];
    for(const a of op.apply){const owner=a.value.kind==='file'?sources.get(a.value.path):undefined;
      if(!a.capturedLocal&&owner&&owner.fileId!==a.fileId&&(owner.value.kind==='tombstone'||owner.value.path!==owner.prior!.value.path)
        && !(actual[owner.fileId]&&covers(actual[owner.fileId].revisionIds,owner.revisionIds))) {
        const users=waiting.get(owner.fileId)??[];users.push(a);waiting.set(owner.fileId,users);
      }else ready.push(a);}
    for(let i=0;i<ready.length;i++){const a=ready[i];ordered.push(a);ready.push(...waiting.get(a.fileId)??[]);}
    if(ordered.length!==op.apply.length){const ids=new Set(ordered.map(a=>a.fileId));scopedIssues.push({kind:'local',code:'Collision',relatedIds:op.apply.filter(a=>!ids.has(a.fileId)).map(a=>a.fileId)});}
    for (const a of ordered) {
      try {
      const current = actual[a.fileId]; if (current && covers(current.revisionIds, a.revisionIds)) continue;
      if (op.conflictProofs?.[a.fileId]) continue;
      const revision = index.revisions.get(a.revisionIds[0]); if (!revision) throw new RepositoryErrorV2('Incomplete');
      if (current && !covers(a.revisionIds, current.revisionIds)) {
        if (sameValue(current.value, a.value)) {const next={ ...current, revisionIds: [...new Set([...current.revisionIds, ...a.revisionIds])].sort(), dirtyGeneration: Math.max(current.dirtyGeneration, a.capturedGeneration??op.dirtyGeneration) };await state.checkpoint([next], []);actual[a.fileId]=next;}
        continue; // A different concurrent state must be preserved as a conflict, never overwritten.
      }
      const dirty = await state.getMeta<DirtyEvents>('dirty-events');
      if (!a.capturedLocal && Math.max(dirty?.paths?.[a.expected?.path ?? a.value.path] ?? 0, dirty?.paths?.[a.value.path] ?? 0,
        ...dirty?.renames.filter(r => r.fileId === a.fileId).map(r => r.generation ?? 0) ?? []) > (a.capturedGeneration ?? op.dirtyGeneration)) continue;
      if (!a.capturedLocal && pathView && blockedPath(pathView,a.value.path)) continue;
      if (!a.capturedLocal) await preservePrior(a.prior);
      let applied = !!a.capturedLocal;
      if (!applied) {
        let expected=a.expected;
        const vacated=expected&&expected.path===a.value.path?sources.get(expected.path):undefined;
        if(vacated&&vacated.fileId!==a.fileId&&vacated.prior?.value.kind==='file'&&vacated.prior.value.hash===expected?.hash
          && (vacated.value.kind==='tombstone'||vacated.value.path!==expected.path)
          && actual[vacated.fileId]&&covers(actual[vacated.fileId].revisionIds,vacated.revisionIds))expected=null;
        const snapshot: LocalSnapshot = { files: expected ? { [expected.path]: expected } : {}, complete: true, excluded: [] };
        const action = toLocalAction(revision, a.prior, snapshot, a.applicationId);
        const bytes = a.value.kind === 'file' ? await readRevision(revision, true) : undefined;
        applied = await local.apply(action, bytes) === 'applied';
      }
      if (applied) {
        const baseHash = a.value.kind === 'file' ? a.value.hash : a.prior?.baseHash ?? null;
        const checkpoint={ fileId: a.fileId, revisionIds: a.revisionIds, value: a.value, baseHash, dirtyGeneration: Math.max(a.capturedGeneration ?? op.dirtyGeneration, current?.dirtyGeneration ?? 0) };
        await state.checkpoint([checkpoint], []);actual[a.fileId]=checkpoint;
      }
      } catch (error) { recordScoped(error, a.fileId); }
    }
  }
  async function publishOperation(op: OutboxOperationV2, boundary: RunBoundaryV2, allowed: Set<string>) {
    if (!op.event) return;
    let proof = op.proof;
    if (!['published', 'applying'].includes(op.phase)) {
      const known = await repository.reconcile(op.id); proof = known === 'unknown' ? await repository.publish(op.event, {}, boundary) : known;
    }
    if (!proof) throw new RepositoryErrorV2('UnknownWrite');
    positiveEvents.add(op.event.id); for (const b of proof.blobs) positiveBlobs.add(b.hash); await ingestFresh(); allowed.add(op.event.id);
    if (op.event.core.deviceId === state.deviceId) await state.setMeta('own-tip', op.event.id);
  }
  async function prepareChanges(rows: { revision: Revision; expected: LocalFile | null; prior: AppliedFileV2 | null }[], boundary: RunBoundaryV2,
    allowed: Set<string>, accepted: Set<string>, capturedGeneration = boundary.throughGeneration) {
    let batch: typeof rows = [];
    async function flush() {
      if (!batch.length) return;
      const id = crypto.randomUUID(), previous = await state.getMeta<string>('own-tip') ?? null;
      const core = { schema: 2 as const, repositoryId: repository.repositoryId, deviceId: state.deviceId, operationId: id, previous, revisions: batch.map(r => r.revision) };
      const event: EventRecord = { id: await eventId(core), core };
      const apply = batch.map((r, i) => obligation(r.revision, r.prior, r.expected, `${id}:${i}`,capturedGeneration));
      const pinnedHashes = [...new Set(apply.flatMap(a => [a.value.kind === 'file' ? a.value.hash : null, a.expected?.hash, a.prior?.baseHash].filter((h): h is string => !!h)))];
      const op: OutboxOperationV2 = { id, boundaryId: boundary.id, repositoryId: repository.repositoryId, dirtyGeneration: boundary.throughGeneration,
        event, pinnedHashes, apply, proof: null, phase: 'prepared' };
      await state.prepare(op, {}); accepted.add(id); await publishOperation(op, boundary, allowed);
      await applyOperation((await state.getOperation(id))!); batch = [];
    }
    for (const row of rows) {
      const previous = await state.getMeta<string>('own-tip') ?? null;
      const trial = { schema: 2 as const, repositoryId: repository.repositoryId, deviceId: state.deviceId, operationId: 'size-check', previous, revisions: [...batch.map(r => r.revision), row.revision] };
      let fits = batch.length < limitsV2.revisions;
      if (fits) { try { encodeEvent(trial); } catch { fits = false; } }
      if (!fits) await flush(); batch.push(row);
    }
    await flush();
  }
  async function receive(revisions: Revision[], snapshot: LocalSnapshot, boundary: RunBoundaryV2, accepted: Set<string>, represented = new Map<string, string[]>()) {
    if (!revisions.length) return;
    const ready=new Set<string>();
    await mapLimit(revisions,repository.concurrency,async r=>{try{if(r.core.value.kind==='file')await readRevision(r,true);ready.add(r.id);}catch(error){recordScoped(error,r.core.fileId);}});
    revisions = revisions.filter(r=>ready.has(r.id)); if (!revisions.length) return;
    const prior = await state.appliedFiles(), id = crypto.randomUUID();
    const apply = revisions.map((r, i) => ({ ...obligation(r, prior[r.core.fileId] ?? null,
      snapshot.files[prior[r.core.fileId]?.value.path ?? r.core.value.path] ?? snapshot.files[r.core.value.path] ?? null, `${id}:${i}`,snapshot.capturedGeneration ?? boundary.throughGeneration), revisionIds: represented.get(r.core.fileId) ?? [r.id] }));
    const pinnedHashes: string[] = [];
    for (const r of revisions) if (r.core.value.kind === 'file') pinnedHashes.push(r.core.value.hash);
    const op: OutboxOperationV2 = { id, boundaryId: boundary.id, repositoryId: repository.repositoryId, dirtyGeneration: boundary.throughGeneration,
      event: null, pinnedHashes, apply, proof: null, phase: 'prepared' };
    await state.prepare(op, {}); accepted.add(id); await applyOperation(op);
  }
  async function perform(frozen?: RunBoundaryV2, integrity = false): Promise<RunOutcomeV2> {
    const accepted = new Set<string>(), allowed = new Set(frozen?.admittedEventIds ?? []), pending: IssueV2[] = [];
    let boundary = frozen ?? { id: crypto.randomUUID(), throughGeneration: 0, admittedEventIds: [] }, view: RemoteViewV2 | undefined;
    let projected = false, followUpRemote = false, advisoryPending = false;
    positiveBlobs = new Set(); positiveEvents = new Set(); scopedIssues = [];
    try {
      await boot();
      const recovering = (await state.outbox()).sort((a, b) => a.dirtyGeneration - b.dirtyGeneration || (a.id < b.id ? -1 : 1));
      if (!frozen) for (const id of index.events.keys()) allowed.add(id);
      for (const op of recovering) {
        if (frozen && op.dirtyGeneration > frozen.throughGeneration) continue;
        accepted.add(op.id); if (!frozen) boundary.throughGeneration = Math.max(boundary.throughGeneration, op.dirtyGeneration);
        await publishOperation(op, boundary, allowed); await applyOperation((await state.getOperation(op.id))!);
      }
      const knownPaths = new Set(index.containers.keys());
      let found = await discover(repository, index, { mode: integrity || !initialDiscoveryComplete || [...index.bodyStates.values()].includes('missing') ? 'canonical' : 'hint', frozenEventIds: frozen?.admittedEventIds });
      if (!integrity && found.requiresCanonical && !found.canonicalScanSettled) found = await discover(repository, index, { mode: 'canonical', frozenEventIds: frozen?.admittedEventIds });
      const incompleteDiscovery=!found.canonicalScanSettled&&found.requiresCanonical || found.issues.some(p=>p.kind!=='hint') || found.view.coverage.pendingEvents.length>0;
      if(found.canonicalScanSettled&&!incompleteDiscovery)initialDiscoveryComplete=true;
      if(!frozen&&incompleteDiscovery){pending.push(...found.issues.filter(p=>p.kind!=='hint'));
        if(!pending.length)pending.push({kind:'metadata',code:'Incomplete',relatedIds:found.view.coverage.pendingEvents});}
      for (const [path, c] of index.containers) if (!knownPaths.has(path)) for (const e of c.decoded.events) positiveEvents.add(e.id);
      if (!frozen) for (const id of index.events.keys()) allowed.add(id);
      const snapshot = await local.snapshot(), dirty = await state.getMeta<DirtyEvents>('dirty-events') ?? { generation: 0, renames: [] };
      if (!frozen) boundary.throughGeneration = Math.max(boundary.throughGeneration, dirty.generation, ...Object.values(snapshot.files).map(f => f.generation ?? 0));
      boundary = { ...boundary, admittedEventIds: [...allowed].sort() };
      view = await reduceHistory(selectHistory(index, allowed));
      const prior = await state.appliedFiles(), consumed = new Set<string>(), rows: { revision: Revision; expected: LocalFile | null; prior: AppliedFileV2 | null }[] = [];
      const creation = Object.values(await state.listMeta<CreationProofV2>('create-intent:')).filter(p => p.generation <= boundary.throughGeneration);
      let deletions = 0, live = 0;
      for (const baseline of Object.values(prior)) {
        let path = baseline.value.path;
        for (const rename of dirty.renames.filter(r => r.fileId === baseline.fileId && (r.generation ?? 0) <= boundary.throughGeneration)) {
          if (rename.from !== path) throw new Error('Disconnected rename proof.'); path = rename.to;
        }
        if (!selected(snapshot, path) || !selected(snapshot, baseline.value.path)) { consumed.add(path); continue; }
        if(Math.max(dirty.paths?.[path]??0,dirty.paths?.[baseline.value.path]??0)>boundary.throughGeneration) {
          consumed.add(path);pending.push({kind:'local',code:'Incomplete',relatedIds:[baseline.fileId]});continue;
        }
        if (baseline.value.kind === 'tombstone') continue;
        live++;
        const file = snapshot.files[path] ?? null; consumed.add(path);
        if (!file && !snapshot.complete) continue;
        if (file && (file.generation ?? 0) > boundary.throughGeneration) { pending.push({ kind: 'local', code: 'Incomplete', relatedIds: [baseline.fileId] }); continue; }
        const revision = await makeLocalRevisionV2(repository.repositoryId, baseline, file);
        if (revision) { if (!file) { deletions++; try { await preservePrior(baseline); } catch (error) { recordScoped(error, baseline.fileId); continue; } } rows.push({ revision, expected: file, prior: baseline }); }
      }
      if (live && deletions / live * 100 > deletionGuardPercent) throw new RepositoryErrorV2('Unsupported');
      const unmatched: LocalSnapshot = { ...snapshot, files: Object.fromEntries(Object.entries(snapshot.files).filter(([path, f]) => !consumed.has(path) && (f.generation ?? 0) <= boundary.throughGeneration)) };
      const adoption = !frozen&&incompleteDiscovery?{adoptions:[],births:[],branches:[],quarantined:[]}:adoptLocal(unmatched, view, creation);
      for(const [key,q]of Object.entries(await state.listMeta<{path:string;hash:string;active?:boolean}>('quarantine:')))
        if(!adoption.quarantined.some(a=>a.path===q.path&&snapshot.files[q.path]?.hash===q.hash))await state.setMeta(key,{...q,active:false});
      for (const item of [...adoption.births, ...adoption.branches]) {
        const file = snapshot.files[item.path], core: RevisionCore = { schema: 2, repositoryId: repository.repositoryId, fileId: item.fileId, parents: [],
          value: { kind: 'file', path: file.path, hash: file.hash, size: file.size }, operation: item.operation, algorithmVersion: null, recreates: 'recreates' in item ? item.recreates : null };
        rows.push({ revision: { id: await revisionId(core), core }, expected: file, prior: null });
      }
      for (const q of adoption.quarantined) {
        const file = snapshot.files[q.path]; const archived = await projection.archiveUnknown(q.path, await state.readObject(file.hash), 'local-quarantine');
        await state.setMeta('quarantine:' + archived.id, { ...q, archiveId: archived.id, hash: file.hash, active:true });
      }
      const adopted = adoption.adoptions.map(a => index.revisions.get(a.revisionIds[0])!);
      await receive(adopted, snapshot, boundary, accepted, new Map(adoption.adoptions.map(a => [a.fileId, a.revisionIds])));
      if (snapshot.complete) await state.setMeta('initial-scan-complete', true);
      await prepareChanges(rows, boundary, allowed, accepted,snapshot.capturedGeneration ?? boundary.throughGeneration);
      const selectedIndex = selectHistory(index, allowed); view = await reduceHistory(selectedIndex);
      // At most one deterministic merge per accepted file. Later foreign events are a separate cycle.
      for (const [fileId, heads] of Object.entries(view.headsByFile)) if (heads.length > 1 && heads.every(r => selected(snapshot, r.core.value.path) && !blockedPath(view!, r.core.value.path))) {
        const decision = await mergeHeads(fileId, heads, selectedIndex, async hash => {
          const r = [...selectedIndex.revisions.values()].find(r => r.core.value.kind === 'file' && r.core.value.hash === hash); if (!r) throw new RepositoryErrorV2('Incomplete'); return readRevision(r);
        });
        if (decision.kind === 'conflict') { if (decision.reason === 'unavailable-source') pending.push({ kind: 'source', code: 'Incomplete', relatedIds: heads.map(r => r.id) }); continue; }
        if (decision.existingRevisionId || decision.kind === 'join') continue;
        if (decision.bytes && decision.core.value.kind === 'file') await state.storeObjects({ [decision.core.value.hash]: decision.bytes });
        else if (decision.core.value.kind === 'file') {
          const value = decision.core.value, source = heads.find(r => r.core.value.kind === 'file' && r.core.value.hash === value.hash && r.core.value.size === value.size);
          if (!source) throw new RepositoryErrorV2('Incomplete'); await readRevision(source, true);
        }
        const revision = { id: await revisionId(decision.core), core: decision.core }, current = (await state.appliedFiles())[fileId] ?? null;
        await prepareChanges([{ revision, expected: snapshot.files[current?.value.path ?? revision.core.value.path] ?? null, prior: current }], boundary, allowed, accepted,snapshot.capturedGeneration ?? boundary.throughGeneration);
      }
      view = await reduceHistory(selectHistory(index, allowed));
      const latest = await local.snapshot(), applied = await state.appliedFiles(), downloads: Revision[] = [], represented = new Map<string, string[]>();
      const pendingDownloads=await state.outbox();
      for (const [fileId, heads] of Object.entries(view.headsByFile)) {
        if (heads.some(r => !selected(latest, r.core.value.path) || blockedPath(view!, r.core.value.path))) continue;
        if (!equivalentHeads(heads)) continue;
        const r = heads[0], base = applied[fileId];
        const ids = heads.map(r => r.id).sort(); represented.set(fileId, ids);
        if (base && ids.every(id => base.revisionIds.includes(id))) continue;
        const file = latest.files[base?.value.path ?? r.core.value.path] ?? latest.files[r.core.value.path] ?? null;
        const latestDirty=await state.getMeta<DirtyEvents>('dirty-events');
        if(Math.max(latestDirty?.paths?.[base?.value.path??r.core.value.path]??0,latestDirty?.paths?.[r.core.value.path]??0)>boundary.throughGeneration)continue;
        if (base?.value.kind === 'file' && file && !matches(base.value, file) && !matches(r.core.value, file)) continue;
        if (!base && r.core.value.kind === 'tombstone' && file) continue;
        if (!latest.complete && !file) continue;
        const duplicate = pendingDownloads.some(o => o.dirtyGeneration >= boundary.throughGeneration && o.apply.some(a => a.fileId === fileId && ids.every(id => a.revisionIds.includes(id))
          && (!a.expected&&!file||a.expected?.path===file?.path&&a.expected?.hash===file?.hash)));
        if (!duplicate) downloads.push(r);
      }
      await receive(downloads, latest, boundary, accepted, represented);
      // Every conflicting current original is preserved before a pending apply can be discharged.
      const conflictedIds = new Set([...view.conflicts.map(c => c.fileId), ...view.pathConflicts.flatMap(c => c.fileIds)]);
      const unavailable = new Set<string>();
      for (const id of conflictedIds) for (const r of view.headsByFile[id] ?? []) if (r.core.value.kind === 'file') {
        try { await readRevision(r, true); } catch (error) { recordScoped(error, id); unavailable.add(id); }
      }
      for (const op of await state.outbox()) if (accepted.has(op.id)) for (const a of op.apply) if (conflictedIds.has(a.fileId)) {
        if (unavailable.has(a.fileId)) continue;
        const variants = [...new Set([...a.revisionIds, ...(view.headsByFile[a.fileId] ?? []).map(r => r.id)])];
        try { for (const id of variants) { const r = index.revisions.get(id); if (r?.core.value.kind === 'file') await readRevision(r, true); }
          await state.recordConflictProof(op.id, a.fileId, variants);
        } catch (error) { recordScoped(error, a.fileId); }
      }
      const projectionResult = await projection.materialize(view, boundary, integrity,positiveBlobs); followUpRemote = projectionResult.followUpRemote;
      projected = projectionResult.pendingPaths.length === 0; pending.push(...projectionResult.issues);
      if(!projected)pending.push({kind:'projection',code:'Incomplete',relatedIds:projectionResult.pendingPaths});
      for (const op of await state.outbox()) if (accepted.has(op.id) && !projectionResult.pendingPaths.some(p => op.apply.some(a => a.value.path === p || a.prior?.value.path === p))) {
        try { await state.checkpoint([], [op.id]); }
        catch (error) { if (!(error instanceof Error && error.message === 'Apply obligation is incomplete.')) throw error; }
      }
      const tip = await state.getMeta<string>('own-tip');
      if (tip && positiveEvents.has(tip)) {
        const slots = [...index.eventSources.get(tip)?.values() ?? []];
        if (slots.length) { try { await repository.writeHint({ eventId: tip, containerSlots: slots.slice(0, 128) }); } catch { advisoryPending = true; } }
      }
      if (!snapshot.complete || ((await state.getMeta<DirtyEvents>('dirty-events'))?.generation ?? 0) > boundary.throughGeneration) pending.push({ kind: 'local', code: 'Incomplete', relatedIds: [] });
    } catch (error) {
      pending.push({ kind: error instanceof DavError ? 'publication' : error instanceof DOMException ? 'local' : 'source',
        code: error instanceof DOMException && error.name === 'QuotaExceededError' ? 'Quota' : error instanceof RepositoryErrorV2 ? error.code
          : error instanceof DavError && ['Auth','Permission'].includes(error.kind) ? 'Auth' : error instanceof DavError ? 'Network' : 'Incomplete', relatedIds: [] });
    }
    pending.push(...scopedIssues);
    const operations: RunOutcomeV2['boundaryCompletion']['operations'] = {}, unresolved: string[] = [], published: string[] = [];
    const requestsSettled = !(await state.attempts({ sessionId: state.sessionId })).some(a => a.state === 'issued');
    for (const id of accepted) {
      const op = await state.getOperation(id); if (!op) { unresolved.push(id); continue; }
      const done = op.phase === 'completed'; if (op.event && op.proof) published.push(op.event.id);
      operations[id] = { publication: op.event ? op.proof ? 'published' : 'unknown' : 'not-required', localCheckpoint: done,
        issuedRequestsSettled: requestsSettled, projectionSettled: done && projected, conflictsPreserved: done };
      if (!done || !requestsSettled || !projected) unresolved.push(id);
    }
    followUpRemote ||= [...index.events.keys()].some(id => !allowed.has(id));
    const localProblem = pending.some(p => p.kind !== 'hint');
    if (localProblem && !unresolved.length) unresolved.push('boundary:' + boundary.id);
    const conflicted = !!view && (view.conflicts.length > 0 || view.pathConflicts.length > 0) || Object.values(await state.listMeta<{active?:boolean}>('quarantine:')).some(q=>q.active!==false);
    return { state: unresolved.length ? 'pending' : conflicted ? 'conflicted' : followUpRemote ? 'pending' : 'clean', publishedEventIds: [...new Set(published)],
      localApplied: unresolved.length === 0, projectionChecked: projected, pending,
      boundaryCompletion: { id: boundary.id, acceptedOperationIds: [...accepted], admittedEventIds: [...allowed].sort(), operations, unresolvedAccepted: unresolved, followUpRemote, advisoryPending } };
  }
  async function mutate(fileId: string, make: () => Promise<RevisionCore>, newBytes?: ArrayBuffer): Promise<RunOutcomeV2> {
    const before=await perform();if(before.pending.some(p=>p.kind==='local'||p.kind==='publication'))return before;
    await boot(); positiveBlobs = new Set(); positiveEvents = new Set();
    const core = await make(), revision = { id: await revisionId(core), core }; if (newBytes && core.value.kind === 'file') await state.storeObjects({ [core.value.hash]: newBytes });
    const snapshot = await local.snapshot(), prior = (await state.appliedFiles())[fileId] ?? null, boundary = await captureBoundary();
    const allowed = new Set(boundary.admittedEventIds), accepted = new Set<string>();
    await prepareChanges([{ revision, prior, expected: snapshot.files[prior?.value.path ?? core.value.path] ?? snapshot.files[core.value.path] ?? null }], boundary, allowed, accepted);
    return perform();
  }
  return { run: (boundary?: RunBoundaryV2, integrity = false) => serialized(() => perform(boundary, integrity)), recover: () => serialized(() => perform()),
    retireForClose:()=>serialized(async()=>{for(const segment of await state.segments())if(segment.ownerSessionId===state.sessionId&&!segment.retired)await state.retireSegment(segment.segmentId);}),
    maintenance:(manual=false)=>serialized(async()=>{
      await boot();if((await state.outbox()).length)return;
      const packed=new Set(await state.getMeta<string[]>('packed-events')??[]),fresh=(await state.verifiedEvents()).filter(e=>!packed.has(e.id));
      if(fresh.length&&(manual||fresh.length>=512)){await repository.publishPack(fresh);for(const e of fresh)packed.add(e.id);await state.setMeta('packed-events',[...packed].sort());await ingestFresh();}
      for(const segment of await state.segments()) {
        if(segment.ownerSessionId===state.sessionId&&!segment.retired&&Date.now()-segment.lastAllocationMs>=limitsV2.idleMs)await state.retireSegment(segment.segmentId);
      }
      for(const segment of await state.segments())if(segment.retired&&!segment.sealed&&segment.finalization)await repository.finishFinalization(segment.finalization);
    }),
    captureBoundary, currentView,
    previewAdoption:()=>serialized(async()=>{await boot();await discover(repository,index,{mode:'canonical'});
      const snapshot=await local.snapshot(),view=await currentView(),applied=await state.appliedFiles();
      const paths=new Set(Object.values(applied).filter(f=>f.value.kind==='file').map(f=>f.value.path));
      return adoptLocal({...snapshot,files:Object.fromEntries(Object.entries(snapshot.files).filter(([path])=>!paths.has(path)))},view,Object.values(await state.listMeta<CreationProofV2>('create-intent:')));}),
    async conflicts() { return (await currentView()).conflicts; }, async pathConflicts() { return (await currentView()).pathConflicts; },
    async readVersion(id: string) { await boot(); const r = index.revisions.get(id); if (!r) throw new Error('Unknown revision.'); return readRevision(r); },
    async history(fileId: string) { await boot(); return [...index.revisions.values()].filter(r => r.core.fileId === fileId).reverse(); },
    resolveConflict(request: { fileId: string; reviewedIds: string[]; choice: ResolutionChoiceV2 }) {
      const fileId = request.fileId, reviewedIds = [...request.reviewedIds];
      const choice = request.choice.kind === 'edit' ? { ...request.choice, bytes: request.choice.bytes.slice(0) } : structuredClone(request.choice);
      return serialized(() => mutate(fileId, () => resolveHeads(fileId, reviewedIds, choice, index), choice.kind === 'edit' ? choice.bytes : undefined));
    },
    restoreVersion(fileId: string, id: string, reviewedIds?: string[]) {
      const reviewed = reviewedIds ? [...reviewedIds] : [...index.heads.get(fileId) ?? []];
      return serialized(async () => { await boot(); const old = index.revisions.get(id); if (!old || old.core.fileId !== fileId || old.core.value.kind !== 'file') throw new Error('Unknown restorable version.');
        const bytes = await readRevision(old); if (old.core.value.path === bookmarksKey) validateBookmarks(bytes);
        return mutate(fileId, async () => ({ ...(await resolveHeads(fileId, reviewed, { kind: 'edit', path: old.core.value.path, bytes }, index)), operation: 'restore' }), bytes); });
    },
    resolveDrift(id:string,choice:'import-as-edit'|'repair-from-canonical') {
      return serialized(async()=>{
        if(!projection.resolveDrift)throw Error('Drift resolution unavailable');
        const data=await projection.resolveDrift(id,choice);if(!data)return perform(undefined,true);
        await boot();const view=await currentView(),matches=Object.entries(view.headsByFile).filter(([,heads])=>heads.some(r=>r.core.value.path===data.archive.path));
        if(matches.length>1)throw Error('Resolve file identity collision first');
        const [fileId,heads]=matches[0]??[crypto.randomUUID(),[]],bytes=data.bytes;
        const result=await mutate(fileId,async()=>heads.length?resolveHeads(fileId,heads.map(r=>r.id),{kind:'edit',path:data.archive.path,bytes},index):
          {schema:2,repositoryId:repository.repositoryId,fileId,parents:[],value:{kind:'file',path:data.archive.path,hash:await hashBytes(bytes),size:bytes.byteLength},operation:'create',algorithmVersion:null,recreates:null},bytes);
        return result;
      });
    },
    resolvePaths(requests:{fileId:string;reviewedIds:string[];choice:ResolutionChoiceV2}[]) {
      const frozen=structuredClone(requests);
      return serialized(async()=>{
        await perform();const snapshot=await local.snapshot(),prior=await state.appliedFiles(),boundary=await captureBoundary();
        const rows=[];for(const request of frozen){const core=await resolveHeads(request.fileId,request.reviewedIds,request.choice,index);
          if(request.choice.kind==='edit'&&core.value.kind==='file')await state.storeObjects({[core.value.hash]:request.choice.bytes});
          rows.push({revision:{id:await revisionId(core),core},expected:snapshot.files[prior[request.fileId]?.value.path??core.value.path]??null,prior:prior[request.fileId]??null});}
        const allowed=new Set(boundary.admittedEventIds),accepted=new Set<string>();await prepareChanges(rows,boundary,allowed,accepted,snapshot.capturedGeneration);
        return perform();
      });
    },
  };
}
