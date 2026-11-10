import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {openStateV2} from '../../src/state.ts';
import {openV1MetaFixture as openState} from '../helpers/v1-fixture.ts';
import { targetKey, targetKeyV2 } from '../../src/paths.ts';
import { bytes, rev, evt, packedBytes, op } from './fixtures.ts';
import type { AppliedFileV2 } from '../../src/v2-types.ts';

test('a reopened session does not treat loader creates as deliberate new files', async () => {
  const factory = new IDBFactory();
  let s = await openStateV2('reload-creates', 'target', factory);
  await s.setMeta('initial-scan-complete', true); await s.close();
  s = await openStateV2('reload-creates', 'target', factory);
  await s.recordDirtyEvent({kind:'create',path:'old.md',generation:1});
  assert.equal(await s.getMeta('create-intent:old.md'), undefined);
  await s.close();
});

test('a native rename before journal preparation binds to the captured birth', async () => {
  const s=await openStateV2('preparation-race','target',new IDBFactory());await s.bindRepository('repo');
  await s.recordDirtyEvent({kind:'rename',from:'a.md',path:'b.md',generation:2});
  const base=await rev(), operation=op(await evt([base]));operation.dirtyGeneration=2;
  operation.apply=[{fileId:'f',revisionIds:[base.id],value:base.core.value,applicationId:'capture',expected:{path:'a.md',hash:(base.core.value as{hash:string}).hash,size:4,generation:1},prior:null,capturedLocal:true,capturedGeneration:1}];
  await s.prepare(operation,{});
  assert.deepEqual((await s.getMeta<{renames:unknown[]}>('dirty-events'))?.renames,[{fileId:'f',from:'a.md',to:'b.md',generation:2}]);await s.close();
});

test('a claimed upload slot is single-use across reopen and cloned durable state', async () => {
  const factory = new IDBFactory(); let s = await openStateV2('slot', 'target', factory); await s.bindRepository('repo');
  const event = await evt([await rev()]); await s.prepare(op(event), {});
  const segment = await s.currentSegment([event.id]);
  const attempt = await s.reserveAttempt('container', packedBytes([event]), { repositoryId: 'repo', segment });
  const oldPlanned = await s.reserveAttempt('blob', bytes('planned snapshot'), { repositoryId: 'repo' });
  await s.claimIssued(attempt.attemptId); await assert.rejects(s.claimIssued(attempt.attemptId));
  const sessionId = s.sessionId; await s.close(); s = await openStateV2('slot', 'target', factory);
  assert.notEqual(s.sessionId, sessionId); await assert.rejects(s.claimIssued(attempt.attemptId));
  await assert.rejects(s.claimIssued(oldPlanned.attemptId));
  const replacement = await s.reserveAttempt('container', packedBytes([event]), { repositoryId: 'repo', segment: await s.currentSegment([event.id]) });
  assert.notEqual(replacement.slot.path, attempt.slot.path); assert.notEqual(replacement.segmentId, attempt.segmentId);
  assert.equal((await s.attempts()).find(a => a.attemptId === attempt.attemptId)?.state, 'issued'); await s.close();
});
test('retirement captures planned logical events and forbids new allocation, not recovery of the same publication', async () => {
  const s = await openStateV2('retire', 'target', new IDBFactory()); await s.bindRepository('repo');
  const event = await evt([await rev()]), segment = await s.currentSegment([event.id]);
  const attempt = await s.reserveAttempt('container', packedBytes([event]), { repositoryId: 'repo', segment });
  const intent = await s.retireSegment(segment.segmentId); assert.deepEqual(intent.allocatedEventIds, [event.id]);
  await assert.rejects(s.reserveAttempt('container', packedBytes([event]), { repositoryId: 'repo', segment }));
  await s.claimIssued(attempt.attemptId); // Existing session may finish a captured planned request.
  assert.notEqual((await s.currentSegment([event.id])).segmentId, segment.segmentId); await s.close();
});
test('repository binding and v2 target isolate schema1 data; concurrent scope writer is refused', async () => {
  const factory = new IDBFactory(), legacy = await openState('bind', 'repo', factory); await legacy.setMeta('keep', 'v1');
  const s = await openStateV2('bind', 'target', factory); await s.bindRepository('repo');
  await assert.rejects(s.bindRepository('different')); await assert.rejects(s.setMeta('boundRepoId', 'different'));
  await assert.rejects(s.prepare({ ...op(null), repositoryId: 'different' }, {}));
  await assert.rejects(openStateV2('bind', 'other-target', factory)); await assert.rejects(openStateV2('nolock', 'target', factory, null));
  await s.close(); assert.equal(await legacy.getMeta('keep'), 'v1'); legacy.close();
  const other = await openStateV2('bind', 'other-target', factory); assert.equal(await other.getMeta('boundRepoId'), undefined); await other.close();
  const cfg = { endpoint: 'https://dav.example/', username: 'me', root: 'notes', password: 'fake' };
  assert.notEqual(await targetKey(cfg), await targetKeyV2(cfg)); assert.equal(await targetKeyV2(cfg), await targetKeyV2({ ...cfg, password: 'new' }));
});
test('an aborted checkpoint never advances applied revision parents or clears its operation', async () => {
  const factory = new IDBFactory(), s = await openStateV2('checkpoint', 'target', factory); await s.bindRepository('repo');
  const revision = await rev(), event = await evt([revision]), operation = op(null);
  await s.prepare(operation, { [(revision.core.value as { hash: string }).hash]: bytes('base') }); await s.admitEvents([event]);
  const applied: AppliedFileV2 = { fileId: 'f', revisionIds: [revision.id], value: revision.core.value,
    baseHash: (revision.core.value as { hash: string }).hash, dirtyGeneration: 1 };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) { const r = put.apply(this, args); if (this.name === 'files') this.transaction.abort(); return r; };
  try { await assert.rejects(s.checkpoint([applied], [operation.id])); } finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual(await s.appliedFiles(), {}); assert.equal((await s.outbox())[0].phase, 'prepared');
  await s.checkpoint([applied], [operation.id]); assert.deepEqual((await s.appliedFiles()).f.revisionIds, [revision.id]); assert.equal((await s.outbox()).length, 0);
  await s.close(); const reopened = await openStateV2('checkpoint', 'target', factory);
  assert.deepEqual((await reopened.appliedFiles()).f.revisionIds, [revision.id]); await reopened.close();
});
test('invalid hashes, missing baseline bytes and quota preserve the durable outbox', async () => {
  const s = await openStateV2('quota', 'target', new IDBFactory()); await s.bindRepository('repo'); const operation = op(null);
  await s.prepare(operation, {}); await assert.rejects(s.storeObjects({ ['a'.repeat(64)]: bytes('bad') }));
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) { if (this.name === 'operations') throw new DOMException('Full', 'QuotaExceededError'); return add.apply(this,args); };
  try { await assert.rejects(s.prepare(op(null), {}), { name: 'QuotaExceededError' }); } finally { IDBObjectStore.prototype.add = add; }
  assert.equal((await s.outbox()).length, 1);
  const revision = await rev(), event = await evt([revision]); await s.admitEvents([event]);
  await assert.rejects(s.checkpoint([{ fileId: 'f', revisionIds: [revision.id], value: revision.core.value, baseHash: null, dirtyGeneration: 1 }], [operation.id]));
  assert.deepEqual(await s.appliedFiles(), {}); await s.close();
});
test('dirty generation and rename proof survive while observed events do not advance applied parents', async () => {
  const s = await openStateV2('dirty', 'target', new IDBFactory()); await s.bindRepository('repo');
  const revision = await rev(), event = await evt([revision]); await s.admitEvents([event]);
  await s.storeObjects({ [(revision.core.value as { hash: string }).hash]: bytes('base') });
  await s.checkpoint([{ fileId:'f', revisionIds:[revision.id], value:revision.core.value, baseHash:(revision.core.value as {hash:string}).hash, dirtyGeneration:0 }], []);
  await s.setMeta('initial-scan-complete', true); await s.recordDirtyEvent({ kind:'rename', from:'a.md', path:'b.md', generation:2 });
  const edit = await rev('f','remote',[revision.id]); await s.admitEvents([await evt([edit])]);
  assert.deepEqual((await s.appliedFiles()).f.revisionIds,[revision.id]);
  assert.deepEqual((await s.getMeta<{renames:unknown[]}>('dirty-events'))?.renames,[{fileId:'f',from:'a.md',to:'b.md',generation:2}]);
  await s.close();
});
test('loader creates carry no creation proof; a later real create freezes the exact known tombstone IDs', async()=>{
  const s=await openStateV2('creation-proof','target',new IDBFactory());await s.bindRepository('repo');
  await s.recordDirtyEvent({kind:'create',path:'a.md',generation:1});assert.equal(await s.getMeta('create-intent:a.md'),undefined);
  const base=await rev(),core={...base.core,parents:[base.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'a.md'}};
  const {revisionId}=await import('../../src/v2-codec.ts'),tomb={id:await revisionId(core),core};await s.admitEvents([await evt([base]),await evt([tomb])]);
  await s.checkpoint([{fileId:'f',revisionIds:[tomb.id],value:core.value,baseHash:null,dirtyGeneration:1}],[]);
  await s.setMeta('initial-scan-complete',true);await s.recordDirtyEvent({kind:'create',path:'a.md',generation:2});
  assert.deepEqual(await s.getMeta('create-intent:a.md'),{path:'a.md',generation:2,afterTombstone:{oldFileId:'f',tombstones:[tomb.id]}});
  await s.close();
});
test('rename and recreate evidence can refer to a captured local publication still in flight',async()=>{
  const s=await openStateV2('pending-native','target',new IDBFactory());await s.bindRepository('repo');await s.setMeta('initial-scan-complete',true);
  const base=await rev(),event=await evt([base]),operation=op(event);operation.apply=[{fileId:'f',revisionIds:[base.id],value:base.core.value,applicationId:'capture',expected:{path:'a.md',hash:(base.core.value as{hash:string}).hash,size:4},prior:null,capturedLocal:true}];
  await s.prepare(operation,{});await s.recordDirtyEvent({kind:'rename',from:'a.md',path:'b.md',generation:2});
  assert.equal((await s.getMeta<{renames:{fileId:string}[]}>('dirty-events'))?.renames[0]?.fileId,'f');
  const core={...base.core,parents:[base.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'b.md'}},codec=await import('../../src/v2-codec.ts'),tomb={id:await codec.revisionId(core),core};
  const deletion=op(await evt([tomb]));deletion.dirtyGeneration=3;deletion.apply=[{fileId:'f',revisionIds:[tomb.id],value:core.value,applicationId:'delete',expected:null,prior:null,capturedLocal:true}];
  await s.prepare(deletion,{});await s.recordDirtyEvent({kind:'create',path:'b.md',generation:4});
  assert.deepEqual((await s.getMeta<{afterTombstone:unknown}>('create-intent:b.md'))?.afterTombstone,{oldFileId:'f',tombstones:[tomb.id]});await s.close();
});
