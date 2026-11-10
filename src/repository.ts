import { DavError } from './transport.ts';
import type { DavV2, DavEntry } from './transport.ts';
import type { StateV2 } from './state.ts';
import { canonicalBytes, hashBytes } from './snapshots.ts';
import { normalizeRelativePath } from './paths.ts';
import { decodeContainer, decodeIdentity, decodeHint, decodeSeal, validateEvent, validateSlot, v2Id } from './v2-codec.ts';
import { metadataDirV2, limitsV2 } from './v2-types.ts';
import type { SlotRef, BlobRef, EventRecord, EventRef, RevisionSource, Container, PublicationProofV2,
  RunBoundaryV2, AttemptKindV2, SegmentRef, OutboxOperationV2, FinalizeIntentV2, SealRecord, SealProofV2, StoredContainerV2, DecodedContainer } from './v2-types.ts';
import { mapLimit } from './queue.ts';

export class RepositoryErrorV2 extends Error {
  readonly code: 'Incomplete' | 'IdentityChanged' | 'Collision' | 'UnknownWrite' | 'Corrupt' | 'Unsupported';
  constructor(code: RepositoryErrorV2['code']) {
    super(`WebDAV v2 ${code}.`); this.name = 'RepositoryErrorV2'; this.code = code;
  }
}
export type RepositoryV2 = Awaited<ReturnType<typeof openRepositoryV2>>;
const absent = (e: unknown) => e instanceof DavError && e.kind === 'NotFound';
const fatalRead = (e: unknown) => e instanceof DOMException || e instanceof DavError && ['Auth', 'Permission', 'RateLimited', 'Transient'].includes(e.kind);

export async function openRepositoryV2(dav: DavV2, state: StateV2, options: { mode: 'create-v2' | 'attach-v2'; sessionId: string; concurrency?:number }) {
  if (state.sessionId !== options.sessionId) throw new RepositoryErrorV2('Unsupported');
  const concurrency=options.concurrency??limitsV2.concurrency;
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw new RepositoryErrorV2('Unsupported');
  const knownDirs = new Set<string>();
  async function ensureDir(path: string) {
    if (knownDirs.has(path)) return;
    if (path) normalizeRelativePath(path);
    try { await dav.mkdir(path); }
    catch (error) {
      if (fatalRead(error)) throw error;
      // MKCOL may have taken effect despite its response; listing proves a directory.
      try { await dav.list(path); } catch { throw error; }
    }
    knownDirs.add(path);
  }
  async function ensureParent(path: string) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) await ensureDir(parts.slice(0, i).join('/'));
  }
  async function identities(): Promise<string> {
    let entries: DavEntry[];
    try { entries = await dav.list(`${metadataDirV2}/identities`); }
    catch (error) { if (absent(error)) throw new RepositoryErrorV2('Incomplete'); throw error; }
    const valid = new Map<string, string>(), unresolved = new Set<string>();
    for (const entry of entries) {
      const name = entry.path.slice(`${metadataDirV2}/identities/`.length);
      const match = /^([a-zA-Z0-9_-]{1,128})\.([0-9a-f]{64})\.json$/.exec(name);
      if (entry.kind !== 'file' || !entry.path.startsWith(`${metadataDirV2}/identities/`) || !match || !v2Id(match[1])) throw new RepositoryErrorV2('Corrupt');
      try {
        const bytes = (await dav.read(entry.path)).bytes;
        if (bytes.byteLength !== entry.size || await hashBytes(bytes) !== match[2]) throw new RepositoryErrorV2('Corrupt');
        valid.set(match[2], decodeIdentity(bytes).repositoryId);
      } catch (error) { if (fatalRead(error)) throw error; unresolved.add(match[2]); }
    }
    if ([...unresolved].some(hash => !valid.has(hash)) || !valid.size) throw new RepositoryErrorV2('Incomplete');
    const repos = new Set(valid.values()); if (repos.size !== 1) throw new RepositoryErrorV2('Collision');
    return [...repos][0];
  }
  const boundId = await state.getMeta<string>('boundRepoId');
  let repositoryId: string;
  if (options.mode === 'create-v2') {
    const prior = await state.getMeta<{ repositoryId: string }>('bootstrap-intent');
    if (boundId && !prior) throw new RepositoryErrorV2('Unsupported');
    let entries: DavEntry[] = [], missing = false;
    try { entries = await dav.list(''); } catch (error) { if (!absent(error)) throw error; missing = true; }
    if ((!prior && entries.length) || prior && entries.some(e => e.path !== metadataDirV2 && !boundId)) throw new RepositoryErrorV2('Unsupported');
    const intent = await state.ensureBootstrapIntent(prior?.repositoryId ?? crypto.randomUUID());
    repositoryId = intent.repositoryId;
    if (boundId && boundId !== repositoryId) throw new RepositoryErrorV2('IdentityChanged');
    if (missing) await ensureDir('');
    await ensureDir(metadataDirV2); await ensureDir(`${metadataDirV2}/identities`);
    // Reconcile the deterministic identity payload before allocating a new physical alias.
    const payload = canonicalBytes({ schema: 2, repositoryId }).buffer, identityHash = await hashBytes(payload);
    let proven = false;
    for (const attempt of await state.attempts()) if (attempt.kind === 'identity' && attempt.slot.hash === identityHash) {
      try { const read = (await dav.read(attempt.slot.path)).bytes; if (await hashBytes(read) === identityHash) { proven = true; break; } }
      catch (error) { if (fatalRead(error)) throw error; }
    }
    if (!proven) {
      const attempt = await state.reserveAttempt('identity', payload, { repositoryId });
      await state.claimIssued(attempt.attemptId);
      let verified = false;
      try {
        try { await dav.put(attempt.slot.path, attempt.bytes); } catch { /* Only readback can settle an issued immutable write. */ }
        const read = (await dav.read(attempt.slot.path)).bytes;
        verified = await hashBytes(read) === identityHash;
        if (!verified) throw new RepositoryErrorV2('UnknownWrite');
      } finally { await state.settleAttempt(attempt.attemptId, verified); }
    }
    if (await identities() !== repositoryId) throw new RepositoryErrorV2('Collision');
  } else repositoryId = await identities();
  if (boundId && boundId !== repositoryId) throw new RepositoryErrorV2('IdentityChanged');
  await state.bindRepository(repositoryId);
  const prefix = `${metadataDirV2}/repos/${repositoryId}`;
  await ensureDir(`${metadataDirV2}/repos`); await ensureDir(prefix);

  async function assertIdentity() { if (await identities() !== repositoryId) throw new RepositoryErrorV2('IdentityChanged'); }
  async function readSlot(ref: SlotRef): Promise<ArrayBuffer> {
    validateSlot(ref, repositoryId);
    const data = (await dav.read(ref.path)).bytes;
    if (data.byteLength !== ref.size || await hashBytes(data) !== ref.hash) throw new RepositoryErrorV2('Corrupt');
    return data;
  }
  async function putFresh(kind: Exclude<AttemptKindV2, 'identity'>, bytes: ArrayBuffer, segment?: SegmentRef): Promise<SlotRef> {
    const attempt = await state.reserveAttempt(kind, bytes, { repositoryId, ...(segment ? { segment } : {}) });
    await ensureParent(attempt.slot.path); await state.claimIssued(attempt.attemptId);
    let verified = false;
    try {
      try { await dav.put(attempt.slot.path, attempt.bytes); } catch { /* Possible effect, even for HTTP500/403. */ }
      try { await readSlot(attempt.slot); verified = true; }
      catch (error) { if (fatalRead(error)) throw error; throw new RepositoryErrorV2('UnknownWrite'); }
      return attempt.slot;
    } finally { await state.settleAttempt(attempt.attemptId, verified); }
  }
  async function eventRef(eventId: string,checked?:Map<string,DecodedContainer>): Promise<EventRef> {
    await refreshSources();const candidates = [...eventIndex.get(eventId)?.values()??[]]
      .sort((a,b)=>b.decoded.events.length-a.decoded.events.length||a.slot.path.localeCompare(b.slot.path)).map(c => c.slot);
    for (const slot of candidates) {
      try {
        const decoded = checked?.get(slot.path)??await decodeContainer(await readSlot(slot), slot.hash, repositoryId);checked?.set(slot.path,decoded);
        if (!decoded.events.some(e => e.id === eventId)) continue;
        const slots = [slot, ...candidates.filter(s => s.path !== slot.path)].slice(0, 128);
        return { eventId, containerSlots: slots };
      } catch (error) { if (fatalRead(error)) throw error; }
    }
    throw new RepositoryErrorV2('Incomplete');
  }
  async function dependenciesFor(event: EventRecord, repair = false, knownRefs?: Map<string, EventRef>): Promise<RevisionSource[]> {
    const events = await state.verifiedEvents(), revisions = new Map(events.flatMap(e => e.core.revisions.map(r => [r.id, { revision: r, eventId: e.id }] as const)));
    const needed = new Map<string, string>(), internal = new Set(event.core.revisions.map(r => r.id));
    for (const r of event.core.revisions) for (const id of [...r.core.parents, ...(r.core.recreates?.tombstones ?? [])]) {
      if (internal.has(id)) continue;
      const parent = revisions.get(id);
      if (!parent || (r.core.parents.includes(id) ? parent.revision.core.fileId !== r.core.fileId
        : parent.revision.core.fileId !== r.core.recreates?.oldFileId || parent.revision.core.value.kind !== 'tombstone')) throw new RepositoryErrorV2('Incomplete');
      needed.set(id, parent.eventId);
    }
    const refs = new Map<string, EventRef>();
    for (const id of new Set(needed.values())) refs.set(id, knownRefs?.get(id) ?? await (repair ? ensureEventAvailable(id) : eventRef(id)));
    return [...needed].sort(([a], [b]) => a < b ? -1 : 1).map(([revisionId, id]) => ({ revisionId, event: refs.get(id)! }));
  }
  let sourceVersion=-1,bodyIndex=new Map<string,Map<string,BlobRef>>(),eventIndex=new Map<string,Map<string,StoredContainerV2>>();
  function indexSource(c:StoredContainerV2){
    for(const b of c.decoded.sources){const refs=bodyIndex.get(b.hash)??new Map<string,BlobRef>();refs.set(b.slot.path,b);bodyIndex.set(b.hash,refs);}
    for(const e of c.decoded.events){const copies=eventIndex.get(e.id)??new Map<string,StoredContainerV2>();copies.set(c.slot.path,c);eventIndex.set(e.id,copies);}
  }
  async function refreshSources(){
    const version=state.sourceVersion();if(sourceVersion===version)return;
    const frames=await state.sourceIndex();bodyIndex=new Map();eventIndex=new Map();for(const c of frames)indexSource(c);sourceVersion=version;
  }
  async function recordSource(slot:SlotRef,decoded:DecodedContainer){const before=state.sourceVersion();await state.recordContainer(slot,decoded);
    if(sourceVersion===before){indexSource({slot,decoded});sourceVersion=state.sourceVersion();}}
  async function indexedBodies(hash:string) {
    await refreshSources();return [...bodyIndex.get(hash)?.values()??[]];
  }
  async function knownBlob(hash: string, size: number, cached?: BlobRef[]): Promise<{ ref: BlobRef; bytes: ArrayBuffer } | undefined> {
    const refs = (cached ?? await indexedBodies(hash)).filter(b => b.hash === hash && b.size === size);
    for (const attempt of await state.attempts({ kind: 'blob', hash })) if (attempt.slot.size === size) refs.push({ hash, size, slot: attempt.slot });
    for (const ref of new Map(refs.map(r => [r.slot.path, r])).values()) {
      try { return { ref, bytes: await readSlot(ref.slot) }; } catch (error) { if (fatalRead(error)) throw error; }
    }
    return undefined;
  }
  async function markPublished(operation: OutboxOperationV2, proof: PublicationProofV2) {
    if (operation.phase === 'prepared') await state.advanceOperation(operation.id, 'uploading');
    if (!['applying', 'completed'].includes(operation.phase)) await state.advanceOperation(operation.id, 'published', proof);
  }
  async function publish(eventRaw: EventRecord, newObjects: Record<string, ArrayBuffer>, boundary: RunBoundaryV2): Promise<PublicationProofV2> {
    const event = await validateEvent(eventRaw, repositoryId);
    const pending = (await state.outbox()).filter(o => o.event?.id === event.id);
    const operation = pending.find(o => o.boundaryId === boundary.id) ?? pending[0];
    if (!operation || operation.dirtyGeneration > boundary.throughGeneration) throw new RepositoryErrorV2('Unsupported');
    await assertIdentity(); await state.storeObjects(newObjects);
    if (operation.phase === 'published' || operation.phase === 'applying') {
      const proof = await reconcile(operation.id); if (proof !== 'unknown') return proof;
      // A previously positive copy may now be missing. Keep its logical event; repair using a fresh operation.
      return repairSources(event.id, newObjects);
    }
    await state.advanceOperation(operation.id, 'uploading');
    try {
      const dependencies = await dependenciesFor(event, true), sources: BlobRef[] = [], cachedSources = (await state.sourceIndex()).flatMap(c => c.decoded.sources);
      const values = new Map(event.core.revisions.flatMap(r => r.core.value.kind === 'file' ? [[r.core.value.hash, r.core.value] as const] : []));
      await mapLimit([...values], concurrency, async ([hash, value]) => {
        const existing = await knownBlob(hash, value.size, cachedSources); if (existing) { sources.push(existing.ref); return; }
        const data = await state.readObject(hash); if (data.byteLength !== value.size) throw new RepositoryErrorV2('Corrupt');
        sources.push({ hash, size: value.size, slot: await putFresh('blob', data) });
      });
      const previousSources: EventRef[] = [];
      if (event.core.previous) {
        try { previousSources.push(await eventRef(event.core.previous)); } catch (error) { if (fatalRead(error)) throw error; /* previous is discovery-only. */ }
      }
      const container: Container = { schema: 2, repositoryId, events: [event], sources: sources.sort((a, b) => a.hash < b.hash ? -1 : 1), dependencies, previousSources };
      const data = canonicalBytes(container).buffer, segment = await state.currentSegment([event.id]);
      const slot = await putFresh('container', data, segment), decoded = await decodeContainer(data, slot.hash, repositoryId);
      await recordSource(slot, decoded);
      const proof = { eventId: event.id, container: slot, blobs: sources };
      await markPublished(operation, proof); return proof;
    } catch (error) { await state.advanceOperation(operation.id, 'publication-unknown'); throw error; }
  }
  async function reconcile(opId: string): Promise<PublicationProofV2 | 'unknown'> {
    const operation = await state.getOperation(opId); if (!operation?.event) return 'unknown';
    await assertIdentity();
    const event = operation.event;
    const candidates = (await state.sourceIndex()).filter(c => c.decoded.events.some(e => e.id === event.id)).map(c => c.slot);
    for (const a of await state.attempts()) if (a.kind === 'container' && a.logicalEventIds.includes(event.id)) candidates.push(a.slot);
    for (const slot of new Map(candidates.map(s => [s.path, s])).values()) {
      try {
        const decoded = await decodeContainer(await readSlot(slot), slot.hash, repositoryId);
        if (!decoded.events.some(e => e.id === event.id)) continue;
        await recordSource(slot, decoded);
        const blobs: BlobRef[] = [], cachedSources = (await state.sourceIndex()).flatMap(c => c.decoded.sources);
        for (const r of event.core.revisions) if (r.core.value.kind === 'file') {
          const source = await knownBlob(r.core.value.hash, r.core.value.size, cachedSources); if (!source) throw new RepositoryErrorV2('Incomplete');
          if (!blobs.some(b => b.hash === source.ref.hash)) blobs.push(source.ref);
        }
        await dependenciesFor(event);
        const proof = { eventId: event.id, container: slot, blobs }; await markPublished(operation, proof); return proof;
      } catch (error) { if (fatalRead(error)) throw error; }
    }
    return 'unknown';
  }
  async function repairSources(eventId: string, bytesByHash: Record<string, ArrayBuffer>): Promise<PublicationProofV2> {
    const event = (await state.verifiedEvents()).find(e => e.id === eventId)
      ?? (await state.operations()).find(o => o.event?.id === eventId)?.event;
    if (!event) throw new RepositoryErrorV2('Incomplete');
    await assertIdentity(); await state.storeObjects(bytesByHash); const dependencies = await dependenciesFor(event, true);
    const blobs: BlobRef[] = [];
    for (const [hash, data] of Object.entries(bytesByHash)) {
      if (!event.core.revisions.some(r => r.core.value.kind === 'file' && r.core.value.hash === hash && r.core.value.size === data.byteLength)) throw new RepositoryErrorV2('Corrupt');
      const old = await knownBlob(hash, data.byteLength);
      blobs.push(old?.ref ?? { hash, size: data.byteLength, slot: await putFresh('blob', data) });
    }
    return { eventId, container: await republishMetadata(event, blobs, dependencies), blobs };
  }
  async function republishMetadata(event: EventRecord, overrides: BlobRef[] = [], dependencies?: RevisionSource[]): Promise<SlotRef> {
    const cached = (await state.sourceIndex()).flatMap(c => c.decoded.sources), sources: BlobRef[] = [];
    for (const r of event.core.revisions) if (r.core.value.kind === 'file') {
      const value = r.core.value, refs = [...overrides, ...cached].filter(b => b.hash === value.hash && b.size === value.size);
      if (!refs.length) throw new RepositoryErrorV2('Incomplete');
      sources.push(...[...new Map(refs.map(b => [b.slot.path, b])).values()].slice(0, 128));
    }
    const container: Container = { schema: 2, repositoryId, events: [event], sources: [...new Map(sources.map(b => [b.slot.path, b])).values()],
      dependencies: dependencies ?? await dependenciesFor(event), previousSources: [] };
    const bytes = canonicalBytes(container).buffer, slot = await putFresh('container', bytes, await state.currentSegment([event.id]));
    await recordSource(slot, await decodeContainer(bytes, slot.hash, repositoryId)); return slot;
  }
  async function ensureEventAvailable(eventId: string): Promise<EventRef> {
    try { return await eventRef(eventId); } catch (error) { if (!(error instanceof RepositoryErrorV2 && error.code === 'Incomplete')) throw error; }
    const events = new Map((await state.verifiedEvents()).map(e => [e.id, e])), owners = new Map([...events.values()].flatMap(e => e.core.revisions.map(r => [r.id, e.id] as const)));
    const stack = [{ id: eventId, expanded: false }], done = new Map<string, EventRef>(), unavailable = new Set([eventId]), visiting = new Set<string>();
    while (stack.length) {
      const task = stack.pop()!; if (done.has(task.id)) continue;
      if (!unavailable.has(task.id)) {
        try { done.set(task.id, await eventRef(task.id)); continue; } catch (error) { if (!(error instanceof RepositoryErrorV2 && error.code === 'Incomplete')) throw error; unavailable.add(task.id); }
      }
      const event = events.get(task.id); if (!event) throw new RepositoryErrorV2('Incomplete');
      if (!task.expanded) {
        await validateEvent(event, repositoryId); if (visiting.has(task.id)) throw new RepositoryErrorV2('Corrupt'); visiting.add(task.id);
        stack.push({ ...task, expanded: true });
        for (const r of event.core.revisions) for (const id of [...r.core.parents, ...(r.core.recreates?.tombstones ?? [])]) {
          if (event.core.revisions.some(r => r.id === id)) continue;
          const owner = owners.get(id); if (!owner) throw new RepositoryErrorV2('Incomplete'); if (!done.has(owner)) stack.push({ id: owner, expanded: false });
        }
      } else { const slot = await republishMetadata(event, [], await dependenciesFor(event, false, done)); done.set(task.id, { eventId: task.id, containerSlots: [slot] }); visiting.delete(task.id); }
    }
    return done.get(eventId)!;
  }
  async function finishFinalization(intent:FinalizeIntentV2):Promise<SealProofV2> {
    await assertIdentity();
    const segment=(await state.segments()).find(s=>s.segmentId===intent.segmentId);
    if(!segment?.finalization || JSON.stringify(segment.finalization)!==JSON.stringify(intent))throw new RepositoryErrorV2('Unsupported');
    if((await state.attempts()).some(a=>a.kind==='container'&&a.segmentId===segment.segmentId&&a.state==='issued'))throw new RepositoryErrorV2('UnknownWrite');
    const admitted=new Set((await state.verifiedEvents()).map(e=>e.id)),members:EventRef[]=[],checked=new Map<string,DecodedContainer>();
    for(const id of intent.allocatedEventIds){if(!admitted.has(id))throw new RepositoryErrorV2('Incomplete');try{members.push(await eventRef(id,checked));}catch(e){if(!(e instanceof RepositoryErrorV2&&e.code==='Incomplete'))throw e;await ensureEventAvailable(id);members.push(await eventRef(id,checked));}}
    const record:SealRecord={schema:2,repositoryId,segment:{deviceId:segment.deviceId,group:segment.group,segmentId:segment.segmentId},members};
    const slot=await putFresh('seal',canonicalBytes(record).buffer,segment);await state.markSegmentSealed(segment.segmentId,slot.path.split('/').pop()!.split('.')[0]);
    const proof={slot,record};await state.setMeta('seal-proof:'+segment.segmentId,proof);return proof;
  }
  async function readSegmentSeals(segment:SegmentRef):Promise<SealProofV2[]> {
    let entries:DavEntry[];try{entries=await dav.list(`${prefix}/seals/${segment.segmentId}`);}catch(e){if(absent(e))return[];throw e;}
    const proofs:SealProofV2[]=[];
    for(const e of entries){const hash=/\.([0-9a-f]{64})\.json$/.exec(e.path)?.[1];if(e.kind!=='file'||!hash)throw new RepositoryErrorV2('Corrupt');
      const slot=validateSlot({path:e.path,hash,size:e.size},repositoryId,'seals'),record=decodeSeal(await readSlot(slot),repositoryId);
      if(record.segment.deviceId!==segment.deviceId||record.segment.group!==segment.group||record.segment.segmentId!==segment.segmentId)throw new RepositoryErrorV2('Corrupt');
      proofs.push({slot,record});}
    return proofs;
  }
  async function publishPack(input:EventRecord[]):Promise<SlotRef[]> {
    await assertIdentity();
    const known=new Map((await state.verifiedEvents()).map(e=>[e.id,e]));
    let events=[...new Map(input.map(e=>[e.id,e])).values()].sort((a,b)=>a.id.localeCompare(b.id));
    for(const event of events){await validateEvent(event,repositoryId);if(!known.has(event.id))throw new RepositoryErrorV2('Unsupported');}
    const cached=await state.sourceIndex(),blobs=new Map<string,BlobRef>();for(const c of cached)for(const b of c.decoded.sources)if(!blobs.has(b.hash))blobs.set(b.hash,b);
    const owners=new Map([...known.values()].flatMap(e=>e.core.revisions.map(r=>[r.id,e.id]as const))),refs=new Map<string,EventRef>();
    const included=new Set(events.map(e=>e.id)),degree=new Map<string,number>(),users=new Map<string,EventRecord[]>(),ready:EventRecord[]=[];
    for(const e of events){const dependencies=new Set(e.core.revisions.flatMap(r=>[...r.core.parents,...r.core.recreates?.tombstones??[]]).map(id=>owners.get(id)).filter((id):id is string=>!!id&&id!==e.id&&included.has(id)));
      if(e.core.previous&&included.has(e.core.previous))dependencies.add(e.core.previous);
      degree.set(e.id,dependencies.size);if(!dependencies.size)ready.push(e);
      for(const id of dependencies){const children=users.get(id)??[];children.push(e);users.set(id,children);}}
    const ordered:EventRecord[]=[];for(let at=0;at<ready.length;at++){const e=ready[at];ordered.push(e);for(const child of users.get(e.id)??[]){const count=degree.get(child.id)!-1;degree.set(child.id,count);if(!count)ready.push(child);}}
    if(ordered.length!==events.length)throw new RepositoryErrorV2('Corrupt');events=ordered;
    async function ref(id:string){if(!refs.has(id))refs.set(id,await eventRef(id));return refs.get(id)!;}
    async function container(batch:EventRecord[]):Promise<Container>{
      const included=new Set(batch.map(e=>e.id)),sources=new Map<string,BlobRef>(),dependencies=new Map<string,RevisionSource>(),previousSources=new Map<string,EventRef>();
      for(const e of batch){
        for(const r of e.core.revisions){if(r.core.value.kind==='file'){const b=blobs.get(r.core.value.hash);if(!b||b.size!==r.core.value.size)throw new RepositoryErrorV2('Incomplete');sources.set(b.hash,b);}
          for(const id of [...r.core.parents,...r.core.recreates?.tombstones??[]]){const owner=owners.get(id);if(!owner)throw new RepositoryErrorV2('Incomplete');if(!included.has(owner))dependencies.set(id,{revisionId:id,event:await ref(owner)});}}
        if(e.core.previous&&!included.has(e.core.previous)&&known.has(e.core.previous))previousSources.set(e.core.previous,await ref(e.core.previous));
      }
      return{schema:2,repositoryId,events:batch,sources:[...sources.values()],dependencies:[...dependencies.values()],previousSources:[...previousSources.values()]};
    }
    const result:SlotRef[]=[];let batch:EventRecord[]=[];
    async function flush(){if(!batch.length)return;const c=await container(batch),data=canonicalBytes(c).buffer;
      if(data.byteLength>limitsV2.containerBytes)throw new RepositoryErrorV2('Unsupported');
      const slot=await putFresh('container',data,await state.currentSegment(batch.map(e=>e.id)));await recordSource(slot,await decodeContainer(data,slot.hash,repositoryId));result.push(slot);batch=[];}
    for(const e of events){if(batch.length>=limitsV2.events)await flush();
      if(batch.length&&canonicalBytes(await container([...batch,e])).byteLength>limitsV2.containerBytes)await flush();batch.push(e);}
    await flush();return result;
  }
  return { repositoryId, deviceId: state.deviceId, prefix, concurrency, assertIdentity, readSlot, publish, reconcile, repairSources, ensureEventAvailable,finishFinalization,readSegmentSeals,publishPack,
    async readBlob(hash: string, size: number) { const found = await knownBlob(hash, size); if (!found) throw new RepositoryErrorV2('Incomplete'); return found; },
    async readContainer(slot: SlotRef) {
      const decoded = await decodeContainer(await readSlot(slot), slot.hash, repositoryId); await recordSource(slot, decoded); return { slot, decoded };
    },
    admitEvents: (events: EventRecord[]) => state.admitEvents(events),
    async readHint(deviceId: string) {
      if (!v2Id(deviceId)) throw new RepositoryErrorV2('Unsupported');
      const hint = decodeHint((await dav.read(`${prefix}/hints/${deviceId}.json`)).bytes, repositoryId);
      if (hint.deviceId !== deviceId) throw new RepositoryErrorV2('Corrupt'); return hint;
    },
    async writeHint(tip: EventRef | null) {
      if (tip && !(await state.verifiedEvents()).some(e => e.id === tip.eventId && e.core.deviceId === state.deviceId)) throw new RepositoryErrorV2('Unsupported');
      const data = canonicalBytes({ schema: 2, repositoryId, deviceId: state.deviceId, tip }).buffer; decodeHint(data, repositoryId);
      await ensureDir(`${prefix}/hints`); await dav.put(`${prefix}/hints/${state.deviceId}.json`, data);
    },
    async list(path: string) {
      normalizeRelativePath(path); if (path !== prefix && !path.startsWith(prefix + '/')) throw new RepositoryErrorV2('Unsupported');
      return dav.list(path);
    },
  };
}
