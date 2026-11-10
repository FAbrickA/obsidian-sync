import type {Hash,DirtyEvent,DirtyEvents} from './types.ts';
import { hashBytes, validHash, canonicalBytes } from './snapshots.ts';
import { decodeContainer, decodeIdentity, decodeSeal, decodeArchive, validateEvent, validateSlot, v2Id } from './v2-codec.ts';
import { limitsV2, metadataDirV2 } from './v2-types.ts';
import type { AppliedFileV2, OutboxOperationV2, OutboxPhaseV2, PublicationProofV2, AttemptKindV2, AttemptRecordV2,
  SegmentRef, SegmentRecordV2, FinalizeIntentV2, EventRecord, Revision, StoredContainerV2, SlotRef, DecodedContainer, CreationProofV2 } from './v2-types.ts';

export type RecoveryStore = { getMeta<T>(key: string): Promise<T | undefined>; setMeta(key: string, value: unknown): Promise<void>;
  storeObjects(objects: Record<Hash, ArrayBuffer>): Promise<void>; readObject(hash: Hash): Promise<ArrayBuffer>; hasAppliedPath(path: string): Promise<boolean>; protocol?: 2 };
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function holdV2Scope(scope: string, locks: Pick<LockManager, 'request'> | null) {
  if (!locks) throw new Error('Web Locks unavailable: writes are blocked.');
  let release!: () => void;
  const untilClose = new Promise<void>(resolve => { release = resolve; });
  let held!: Promise<unknown>;
  await new Promise<void>((resolve, reject) => {
    held = locks.request(`webdav-sync-v2:${scope}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('Another instance owns this local scope.')); return; }
      resolve(); await untilClose;
    });
    void held.catch(reject);
  });
  return async () => { release(); await held; };
}

export type StateV2 = Awaited<ReturnType<typeof openStateV2>>;
export async function openStateV2(localScope: string, targetKey: string, factory: IDBFactory,
  locks: Pick<LockManager, 'request'> | null = globalThis.navigator?.locks ?? null) {
  if (!localScope || !targetKey) throw new Error('Missing v2 state identity.');
  const release = await holdV2Scope(localScope, locks);
  const names = ['files', 'operations', 'objects', 'meta', 'attempts', 'segments', 'events', 'revisions', 'sources'];
  const sessionId = crypto.randomUUID();
  let db: IDBDatabase;
  try {
    const request = factory.open(`webdav-sync-v2:${encodeURIComponent(localScope)}:${encodeURIComponent(targetKey)}`, 2);
    request.onupgradeneeded = () => {
      for (const name of names) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      const operations = request.transaction!.objectStore('operations'), attempts = request.transaction!.objectStore('attempts');
      if (!operations.indexNames.contains('phase')) operations.createIndex('phase', 'phase');
      if (!attempts.indexNames.contains('kindHash')) attempts.createIndex('kindHash', ['kind', 'slot.hash']);
      if (!attempts.indexNames.contains('session')) attempts.createIndex('session', 'sessionId');
    };
    db = await result(request);
  } catch (error) { await release(); throw error; }
  let closed = false, sourceVersion=0;
  async function close() { if (!closed) { closed = true; db.close(); await release(); } }
  db.onversionchange = () => { void close(); };
  async function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => Promise<T>): Promise<T> {
    if (closed) throw new Error('V2 state is closed.');
    const t = db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    const done = new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onabort = () => reject(t.error ?? new DOMException('Transaction aborted.', 'AbortError')); t.onerror = () => {}; });
    try { const value = await run(t); await done; return value; }
    catch (error) { try { t.abort(); } catch {} await done.catch(() => {}); throw error; }
  }
  const get = <T>(store: string, key: string) => tx([store], 'readonly', t => result(t.objectStore(store).get(key)) as Promise<T | undefined>);
  const all = <T>(store: string) => tx([store], 'readonly', t => result(t.objectStore(store).getAll()) as Promise<T[]>);
  async function bound(t: IDBTransaction, repoId: string) {
    if (!v2Id(repoId) || await result(t.objectStore('meta').get('boundRepoId')) !== repoId) throw new Error('Repository binding changed.');
  }
  async function copyObjects(objects: Record<Hash, ArrayBuffer>) {
    const entries = Object.entries(objects).map(([hash, data]) => [hash, data.slice(0)] as const);
    for (const [hash, data] of entries) if (!validHash(hash) || await hashBytes(data) !== hash) throw new Error('Invalid object bytes.');
    return entries;
  }
  const deviceId = await tx(['meta'], 'readwrite', async t => {
    const store = t.objectStore('meta'), existing = await result(store.get('deviceId')) as string | undefined;
    await result(store.put(false, 'initial-scan-complete'));
    if (existing) { if (!v2Id(existing)) throw new Error('Invalid device identity.'); return existing; }
    const id = crypto.randomUUID(); await result(store.add(id, 'deviceId')); return id;
  }).catch(async error => { await close(); throw error; });
  async function readObject(hash: Hash): Promise<ArrayBuffer> {
    const data = await get<ArrayBuffer>('objects', hash);
    if (!validHash(hash) || !data || await hashBytes(data) !== hash) throw new Error('Missing/corrupt local object.');
    return data;
  }
  async function retire(t: IDBTransaction, segment: SegmentRecordV2): Promise<FinalizeIntentV2> {
    if (segment.ownerSessionId !== sessionId && !segment.finalization) throw new Error('No durable retirement authority.');
    if (segment.finalization) return segment.finalization;
    const finalization: FinalizeIntentV2 = { segmentId: segment.segmentId, ownerSessionId: segment.ownerSessionId,
      allocatedEventIds: [...segment.allocatedEventIds].sort(), allocationClosed: true };
    await result(t.objectStore('segments').put({ ...segment, retired: true, finalization }, segment.segmentId)); return finalization;
  }
  return {
    localScope, targetKey, sessionId, deviceId, close, protocol: 2 as const,
    getMeta: <T>(key: string) => get<T>('meta', key),
    async setMeta(key: string, value: unknown) {
      if (['deviceId', 'boundRepoId', 'bootstrap-intent'].includes(key) || key.startsWith('active-segment:') || key === 'segment-counter') throw new Error('Protected metadata.');
      await tx(['meta'], 'readwrite', t => result(t.objectStore('meta').put(value, key)));
    },
    async listMeta<T>(prefix: string): Promise<Record<string, T>> {
      return tx(['meta'], 'readonly', async t => { const s = t.objectStore('meta'), keys = await result(s.getAllKeys()), values = await result(s.getAll());
        return Object.fromEntries(keys.flatMap((k, i) => String(k).startsWith(prefix) ? [[String(k), values[i] as T]] : [])); });
    },
    async ensureBootstrapIntent(repositoryId: string) {
      if (!v2Id(repositoryId)) throw new Error('Invalid repository identity.');
      return tx(['meta'], 'readwrite', async t => { const s = t.objectStore('meta'), prior = await result(s.get('bootstrap-intent')) as { repositoryId: string } | undefined;
        if (prior && prior.repositoryId !== repositoryId) throw new Error('Bootstrap identity changed.');
        if (!prior) await result(s.add({ repositoryId }, 'bootstrap-intent')); return prior ?? { repositoryId }; });
    },
    async bindRepository(repositoryId: string) {
      if (!v2Id(repositoryId)) throw new Error('Invalid repository identity.');
      await tx(['meta'], 'readwrite', async t => { const s = t.objectStore('meta'), prior = await result(s.get('boundRepoId'));
        if (prior !== undefined && prior !== repositoryId) throw new Error('Repository binding changed.');
        const intent = await result(s.get('bootstrap-intent')) as { repositoryId: string } | undefined;
        if (intent && intent.repositoryId !== repositoryId) throw new Error('Bootstrap identity changed.');
        await result(s.put(repositoryId, 'boundRepoId')); });
    },
    async storeObjects(objects: Record<Hash, ArrayBuffer>) {
      const copied = await copyObjects(objects);
      await tx(['objects'], 'readwrite', async t => { for (const [hash, data] of copied) await result(t.objectStore('objects').put(data, hash)); });
    },
    readObject,
    async prepare(operation: OutboxOperationV2, objects: Record<Hash, ArrayBuffer>) {
      const op = structuredClone(operation), copied = await copyObjects(objects);
      if (!v2Id(op.id) || op.phase !== 'prepared' || op.proof !== null || !Number.isSafeInteger(op.dirtyGeneration) || op.dirtyGeneration < 0) throw new Error('Invalid operation intent.');
      if (op.event) op.event = await validateEvent(op.event, op.repositoryId);
      await tx(['meta', 'operations', 'objects'], 'readwrite', async t => {
        await bound(t, op.repositoryId); for (const [hash, data] of copied) await result(t.objectStore('objects').put(data, hash));
        for (const hash of op.pinnedHashes) if (!validHash(hash) || !await result(t.objectStore('objects').get(hash))) throw new Error('Pinned snapshot missing.');
        const meta=t.objectStore('meta'), dirty=await result(meta.get('dirty-events')) as DirtyEvents | undefined;
        let unbound=await result(meta.get('unbound-renames')) as {from:string;to:string;generation:number}[] | undefined ?? [];
        for(const a of op.apply) if(a.capturedLocal) {
          const captured=a.capturedGeneration ?? op.dirtyGeneration;
          let path=a.value.path;
          for(const r of [...unbound]) if(r.from===path && r.generation>captured) {
            if(dirty) dirty.renames.push({fileId:a.fileId,...r});path=r.to;unbound=unbound.filter(x=>x!==r);
          }
          if(a.value.kind==='tombstone') {
            const key='create-intent:'+a.value.path, proof=await result(meta.get(key)) as CreationProofV2 | undefined;
            if(proof && proof.generation>captured && !proof.afterTombstone) await result(meta.put({...proof,afterTombstone:{oldFileId:a.fileId,tombstones:[...a.revisionIds].sort()}},key));
          }
        }
        if(dirty) await result(meta.put(dirty,'dirty-events'));
        await result(meta.put(unbound,'unbound-renames'));
        await result(t.objectStore('operations').add(op, op.id));
      });
    },
    async outbox(): Promise<OutboxOperationV2[]> { return tx(['operations'], 'readonly', async t => {
      const index = t.objectStore('operations').index('phase');
      return (await Promise.all(['prepared', 'uploading', 'publication-unknown', 'published', 'applying'].map(phase => result(index.getAll(phase)) as Promise<OutboxOperationV2[]>))).flat();
    }); },
    getOperation: (id: string) => get<OutboxOperationV2>('operations', id),
    operations: () => all<OutboxOperationV2>('operations'),
    async attempts(filter?: { kind?: AttemptKindV2; hash?: Hash; sessionId?: string }): Promise<AttemptRecordV2[]> {
      if (filter?.kind && filter.hash) return tx(['attempts'], 'readonly', t => result(t.objectStore('attempts').index('kindHash').getAll([filter.kind!, filter.hash!])) as Promise<AttemptRecordV2[]>);
      if (filter?.sessionId) return tx(['attempts'], 'readonly', t => result(t.objectStore('attempts').index('session').getAll(filter.sessionId)) as Promise<AttemptRecordV2[]>);
      return all<AttemptRecordV2>('attempts');
    },
    segments: () => all<SegmentRecordV2>('segments'),
    async advanceOperation(id: string, phase: OutboxPhaseV2, proof?: PublicationProofV2) {
      const transitions: Record<OutboxPhaseV2, OutboxPhaseV2[]> = { prepared: ['uploading', 'applying', 'cancelled-before-publication'], uploading: ['publication-unknown', 'published', 'cancelled-before-publication'],
        'publication-unknown': ['uploading', 'published'], published: ['applying'], applying: [], completed: [], 'cancelled-before-publication': [] };
      await tx(['meta', 'operations', 'attempts'], 'readwrite', async t => {
        const store = t.objectStore('operations'), op = await result(store.get(id)) as OutboxOperationV2 | undefined;
        if (!op || op.phase !== phase && !transitions[op.phase].includes(phase)) throw new Error('Invalid operation transition.');
        await bound(t, op.repositoryId);
        if (phase === 'cancelled-before-publication' && op.event && (await result(t.objectStore('attempts').getAll()) as AttemptRecordV2[]).some(a => a.kind === 'container' && a.logicalEventIds.includes(op.event!.id))) throw new Error('Reserved publication cannot be cancelled.');
        if (phase === 'published' && (!proof || proof.eventId !== op.event?.id)) throw new Error('Publication proof missing.');
        if (proof) { validateSlot(proof.container, op.repositoryId, 'journal'); for (const b of proof.blobs) if (validateSlot(b.slot, op.repositoryId, 'blobs').hash !== b.hash || b.size !== b.slot.size) throw new Error('Invalid publication proof.'); }
        if (phase === 'applying' && op.event && !['published', 'applying'].includes(op.phase)) throw new Error('Unpublished operation cannot apply.');
        await result(store.put({ ...op, phase, proof: proof ?? op.proof }, id));
      });
    },
    async currentSegment(eventIds: string[] = []): Promise<SegmentRef> {
      if (eventIds.length > limitsV2.segmentEvents || !eventIds.every(validHash)) throw new Error('Segment capacity exceeded.');
      return tx(['meta', 'segments'], 'readwrite', async t => {
        const meta = t.objectStore('meta'), store = t.objectStore('segments'), repositoryId = await result(meta.get('boundRepoId')) as string;
        if (!v2Id(repositoryId)) throw new Error('Repository is not bound.');
        const active = await result(meta.get('active-segment:' + sessionId)) as string | undefined;
        const prior = active ? await result(store.get(active)) as SegmentRecordV2 | undefined : undefined;
        if (prior && !prior.retired && !prior.sealed && prior.attemptIds.length < limitsV2.segmentAttempts && new Set([...prior.allocatedEventIds, ...eventIds]).size <= limitsV2.segmentEvents) return prior;
        if (prior && !prior.retired) await retire(t, prior);
        const counter = await result(meta.get('segment-counter')) as number | undefined ?? 0;
        const segment: SegmentRecordV2 = { deviceId, group: Math.floor(counter / limitsV2.groupSegments), segmentId: crypto.randomUUID(), repositoryId,
          ownerSessionId: sessionId, attemptIds: [], allocatedEventIds: [], retired: false, sealed: false, lastAllocationMs: Date.now(), finalization: null };
        await result(store.add(segment, segment.segmentId)); await result(meta.put(counter + 1, 'segment-counter')); await result(meta.put(segment.segmentId, 'active-segment:' + sessionId)); return segment;
      });
    },
    async retireSegment(id: string): Promise<FinalizeIntentV2> {
      return tx(['segments'], 'readwrite', async t => { const s = await result(t.objectStore('segments').get(id)) as SegmentRecordV2 | undefined;
        if (!s) throw new Error('Segment missing.'); return retire(t, s); });
    },
    async markSegmentSealed(id:string,attemptId:string) {
      const attempt=await get<AttemptRecordV2>('attempts',attemptId);if(!attempt||attempt.kind!=='seal'||attempt.state!=='settled-verified')throw Error('Verified seal attempt required');
      const record=decodeSeal(attempt.bytes,(await get<string>('meta','boundRepoId'))!);
      await tx(['segments','events'],'readwrite',async t=>{
        const store=t.objectStore('segments'),segment=await result(store.get(id)) as SegmentRecordV2|undefined;
        if(!segment?.finalization || !segment.retired || record.segment.segmentId!==id || record.segment.deviceId!==segment.deviceId || record.segment.group!==segment.group
          || record.members.map(m=>m.eventId).join(',')!==segment.finalization.allocatedEventIds.join(','))throw Error('Seal does not match durable retirement');
        for(const member of record.members)if(!await result(t.objectStore('events').get(member.eventId)))throw Error('Unverified seal member');
        await result(store.put({...segment,sealed:true},id));
      });
    },
    async reserveAttempt(kind: AttemptKindV2, data: ArrayBuffer, placement: { repositoryId: string; segment?: SegmentRef }): Promise<AttemptRecordV2> {
      const exact = data.slice(0), hash = await hashBytes(exact), attemptId = crypto.randomUUID(), repoId = placement.repositoryId;
      if (!v2Id(repoId)) throw new Error('Invalid repository identity.');
      let logicalEventIds: string[] = [];
      if (kind === 'container') { const decoded = await decodeContainer(exact, hash, repoId); if (decoded.issues.length) throw new Error('Cannot publish malformed event.'); logicalEventIds = decoded.events.map(e => e.id).sort(); }
      if (kind === 'identity' && decodeIdentity(exact).repositoryId !== repoId) throw new Error('Invalid identity intent.');
      if (kind === 'seal') decodeSeal(exact, repoId);
      if (kind === 'archive') await decodeArchive(exact,repoId);
      return tx(['meta', 'segments', 'attempts'], 'readwrite', async t => {
        if (kind === 'identity') { const bootstrap = await result(t.objectStore('meta').get('bootstrap-intent')) as { repositoryId: string } | undefined;
          if (bootstrap?.repositoryId !== repoId) throw new Error('Bootstrap intent missing.'); }
        else await bound(t, repoId);
        let relative: string;
        if (kind === 'container') {
          const s = placement.segment ? await result(t.objectStore('segments').get(placement.segment.segmentId)) as SegmentRecordV2 | undefined : undefined;
          if (!s || s.ownerSessionId !== sessionId || s.repositoryId !== repoId || s.retired || s.sealed || s.attemptIds.length >= limitsV2.segmentAttempts
            || new Set([...s.allocatedEventIds, ...logicalEventIds]).size > limitsV2.segmentEvents) throw new Error('Segment is unavailable.');
          relative = `journal/${s.deviceId}/${s.group}/${s.segmentId}/${attemptId}.${hash}.json`;
          await result(t.objectStore('segments').put({ ...s, attemptIds: [...s.attemptIds, attemptId], allocatedEventIds: [...new Set([...s.allocatedEventIds, ...logicalEventIds])].sort(), lastAllocationMs: Date.now() }, s.segmentId));
        } else if (kind === 'blob') relative = `blobs/${deviceId}/${attemptId}.${hash}.bin`;
        else if (kind === 'archive') relative = `archives/${attemptId}.${hash}.json`;
        else if (kind === 'seal' && placement.segment) relative = `seals/${placement.segment.segmentId}/${attemptId}.${hash}.json`;
        else if (kind === 'identity') relative = '';
        else throw new Error('Invalid attempt placement.');
        const path = kind === 'identity' ? `${metadataDirV2}/identities/${attemptId}.${hash}.json` : `${metadataDirV2}/repos/${repoId}/${relative}`;
        const attempt: AttemptRecordV2 = { attemptId, kind, slot: { path, hash, size: exact.byteLength }, bytes: exact, sessionId,
          ...(placement.segment ? { segmentId: placement.segment.segmentId } : {}), logicalEventIds, state: 'planned' };
        await result(t.objectStore('attempts').add(attempt, attemptId)); return attempt;
      });
    },
    async claimIssued(id: string) {
      await tx(['attempts', 'segments'], 'readwrite', async t => { const store = t.objectStore('attempts'), a = await result(store.get(id)) as AttemptRecordV2 | undefined;
        if (!a || a.sessionId !== sessionId || a.state !== 'planned') throw new Error('Upload slot cannot be reused.');
        if (a.kind === 'container') { const s = await result(t.objectStore('segments').get(a.segmentId!)) as SegmentRecordV2;
          if (!s || s.sealed || s.retired && (!s.finalization || !a.logicalEventIds.every(id => s.finalization!.allocatedEventIds.includes(id)))) throw new Error('Segment is closed.'); }
        await result(store.put({ ...a, state: 'issued' }, id));
      });
    },
    async settleAttempt(id: string, verified: boolean) {
      await tx(['attempts'], 'readwrite', async t => { const store = t.objectStore('attempts'), a = await result(store.get(id)) as AttemptRecordV2 | undefined;
        if (!a || a.state === 'planned' && !verified) throw new Error('Request was not issued.');
        await result(store.put({ ...a, state: verified || a.state === 'settled-verified' ? 'settled-verified' : 'settled-unverified' }, id)); });
    },
    async admitEvents(events: EventRecord[]) {
      const validated: EventRecord[] = []; for (const event of events) validated.push(await validateEvent(event, event.core.repositoryId));
      const incoming = new Map(validated.flatMap(e => e.core.revisions.map(r => [r.id, r] as const)));
      await tx(['meta', 'events', 'revisions'], 'readwrite', async t => {
        for (const event of validated) {
          await bound(t, event.core.repositoryId);
          for (const r of event.core.revisions) {
            for (const id of [...r.core.parents, ...(r.core.recreates?.tombstones ?? [])]) {
              const p = incoming.get(id) ?? await result(t.objectStore('revisions').get(id)) as Revision | undefined;
              if (!p || (r.core.parents.includes(id) ? p.core.fileId !== r.core.fileId : p.core.fileId !== r.core.recreates?.oldFileId || p.core.value.kind !== 'tombstone')) throw new Error('Causal dependency is missing or invalid.');
            }
          }
          await result(t.objectStore('events').put(event, event.id));
        }
        for (const r of incoming.values()) await result(t.objectStore('revisions').put(r, r.id));
      });
    },
    verifiedEvents: () => all<EventRecord>('events'),
    async recordContainer(slot: SlotRef, decoded: DecodedContainer) {
      validateSlot(slot, decoded.repositoryId, 'journal'); if (slot.hash !== decoded.hash) throw new Error('Container proof mismatch.');
      await tx(['meta', 'sources'], 'readwrite', async t => { await bound(t, decoded.repositoryId); await result(t.objectStore('sources').put({ slot, decoded }, slot.path)); });
      sourceVersion++;
    },
    sourceVersion:()=>sourceVersion,
    sourceIndex: () => all<StoredContainerV2>('sources'),
    async appliedFiles(): Promise<Record<string, AppliedFileV2>> { return Object.fromEntries((await all<AppliedFileV2>('files')).map(f => [f.fileId, f])); },
    async hasAppliedPath(path: string) { return (await all<AppliedFileV2>('files')).some(f => f.value.kind === 'file' && f.value.path === path); },
    async recordConflictProof(opId: string, fileId: string, variantIds: string[]) {
      for (const id of variantIds) { const r = await get<Revision>('revisions', id); if (!r || r.core.fileId !== fileId) throw new Error('Unknown preserved variant.'); if (r.core.value.kind === 'file') await readObject(r.core.value.hash); }
      await tx(['operations'], 'readwrite', async t => { const store = t.objectStore('operations'), op = await result(store.get(opId)) as OutboxOperationV2 | undefined;
        if (!op || !op.apply.some(a => a.fileId === fileId && a.revisionIds.every(id => variantIds.includes(id)))) throw new Error('Invalid conflict discharge.');
        await result(store.put({ ...op, conflictProofs: { ...op.conflictProofs, [fileId]: [...new Set(variantIds)].sort() } }, opId)); });
    },
    async checkpoint(files: AppliedFileV2[], completedIds: string[]) {
      for (const f of files) {
        if (!v2Id(f.fileId) || !f.revisionIds.length || new Set(f.revisionIds).size !== f.revisionIds.length || !f.revisionIds.every(validHash)) throw new Error('Invalid applied revisions.');
        if (f.value.kind === 'file' && (f.baseHash !== f.value.hash || (await readObject(f.value.hash)).byteLength !== f.value.size)) throw new Error('Applied base bytes missing.');
        if (f.baseHash !== null && (f.value.kind!=='file'||f.baseHash!==f.value.hash)) await readObject(f.baseHash);
      }
      await tx(['meta', 'files', 'operations', 'revisions'], 'readwrite', async t => {
        const store = t.objectStore('files');
        for (const f of files) {
          for (const id of f.revisionIds) { const r = await result(t.objectStore('revisions').get(id)) as Revision | undefined;
            if (!r || r.core.fileId !== f.fileId || new TextDecoder().decode(canonicalBytes(r.core.value)) !== new TextDecoder().decode(canonicalBytes(f.value))) throw new Error('Applied state is not represented by its revisions.'); }
          const prior = await result(store.get(f.fileId)) as AppliedFileV2 | undefined;
          if (!Number.isSafeInteger(f.dirtyGeneration) || f.dirtyGeneration < (prior?.dirtyGeneration ?? 0)) throw new Error('Applied generation cannot regress.');
          await result(store.put(f, f.fileId));
          const meta=t.objectStore('meta'),key='create-intent:'+f.value.path,proof=await result(meta.get(key)) as CreationProofV2 | undefined;
          if(proof && proof.generation<=f.dirtyGeneration) await result(meta.delete(key));
        }
        for (const id of completedIds) {
          const op = await result(t.objectStore('operations').get(id)) as OutboxOperationV2 | undefined;
          if (!op || op.event && (!op.proof || !['published', 'applying'].includes(op.phase)) || !op.event && !['prepared', 'applying'].includes(op.phase)) throw new Error('Unsettled operation cannot checkpoint.');
          await bound(t, op.repositoryId);
          for (const a of op.apply) {
            if (a.revisionIds.every(id => op.conflictProofs?.[a.fileId]?.includes(id))) continue;
            const f = await result(store.get(a.fileId)) as AppliedFileV2 | undefined, seen = new Set<string>(), stack = [...f?.revisionIds ?? []], remaining = new Set(a.revisionIds);
            while (stack.length && remaining.size) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); remaining.delete(id); if (!remaining.size) break;
              const r = await result(t.objectStore('revisions').get(id)) as Revision | undefined; if (r?.core.fileId === a.fileId) stack.push(...r.core.parents); }
            if (!f || remaining.size) throw new Error('Apply obligation is incomplete.');
          }
          await result(t.objectStore('operations').put({ ...op, phase: 'completed' }, id));
        }
        const dirty = await result(t.objectStore('meta').get('dirty-events')) as DirtyEvents | undefined;
        if (dirty) { dirty.renames = dirty.renames.filter(r => !files.some(f => f.fileId === r.fileId && (r.generation ?? Infinity) <= f.dirtyGeneration)); await result(t.objectStore('meta').put(dirty, 'dirty-events')); }
      });
    },
    async recordDirtyEvent(event: DirtyEvent): Promise<DirtyEvents> {
      return tx(['meta', 'files', 'operations'], 'readwrite', async t => {
        const meta = t.objectStore('meta'), dirty = await result(meta.get('dirty-events')) as DirtyEvents | undefined ?? { generation: 0, renames: [] };
        if (event.generation <= dirty.generation) return dirty;
        const relevant = event.kind === 'rename' || event.kind === 'create';
        const files = relevant ? await result(t.objectStore('files').getAll()) as AppliedFileV2[] : [];
        const pending = relevant ? (await Promise.all(['prepared','uploading','publication-unknown','published','applying'].map(p => result(t.objectStore('operations').index('phase').getAll(p)) as Promise<OutboxOperationV2[]>))).flat().sort((a,b)=>b.dirtyGeneration-a.dirtyGeneration) : [];
        const captured = pending.flatMap(o => o.apply.filter(a => a.capturedLocal));
        if (event.kind === 'rename' && event.from) { const id = captured.find(a => a.value.kind === 'file' && a.value.path === event.from)?.fileId
          ?? files.find(f => f.value.kind === 'file' && f.value.path === event.from)?.fileId ?? dirty.renames.filter(r => r.to === event.from).slice(-1)[0]?.fileId;
          if (id) dirty.renames.push({ fileId: id, from: event.from, to: event.path, generation: event.generation });
          else { const unbound=await result(meta.get('unbound-renames')) as unknown[] | undefined ?? [];
            await result(meta.put([...unbound,{from:event.from,to:event.path,generation:event.generation}],'unbound-renames')); } }
        if(event.kind==='delete') await result(meta.delete('create-intent:'+event.path));
        if (event.kind === 'create' && await result(meta.get('initial-scan-complete'))) {
          const tomb = captured.find(a => a.value.kind === 'tombstone' && a.value.path === event.path) ?? files.find(f => f.value.kind === 'tombstone' && f.value.path === event.path);
          await result(meta.put({ path: event.path, generation: event.generation,
            ...(tomb ? { afterTombstone: { oldFileId: tomb.fileId, tombstones: [...tomb.revisionIds].sort() } } : {}) }, 'create-intent:' + event.path));
        }
        dirty.generation = event.generation; dirty.paths = { ...dirty.paths, [event.path]: event.generation, ...(event.from ? { [event.from]: event.generation } : {}) };
        await result(meta.put(dirty, 'dirty-events')); return dirty;
      });
    },
  };
}
