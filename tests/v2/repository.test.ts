import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openStateV2 } from '../../src/state.ts';
import { openRepositoryV2 } from '../../src/repository.ts';
import { DavError } from '../../src/transport.ts';
import { canonicalBytes, hashBytes } from '../../src/snapshots.ts';
import { noCasDav } from './memory-dav.ts';
import { bytes, rev, evt, op } from './fixtures.ts';
const boundary={id:'boundary',throughGeneration:1,admittedEventIds:[]};
async function setup(scope=crypto.randomUUID()) {
  const remote=noCasDav(),state=await openStateV2(scope,'target',new IDBFactory());await state.ensureBootstrapIntent('repo');
  const repo=await openRepositoryV2(remote.dav,state,{mode:'create-v2',sessionId:state.sessionId});return{remote,state,repo};
}
test('bootstrap intent precedes the first mutation and attach never silently creates an identity',async()=>{
  const remote=noCasDav(),factory=new IDBFactory(),state=await openStateV2('bootstrap','target',factory);
  const put=remote.dav.put;let intentBeforeWrite=false;
  remote.dav.put=async(path,data)=>{intentBeforeWrite=!!await state.getMeta('bootstrap-intent');await put(path,data)};
  const repo=await openRepositoryV2(remote.dav,state,{mode:'create-v2',sessionId:state.sessionId});
  assert(intentBeforeWrite);assert.equal(await state.getMeta('boundRepoId'),repo.repositoryId);await state.close();
  const attached=await openStateV2('attach','target',factory),writes=remote.puts.length;
  const r=await openRepositoryV2(remote.dav,attached,{mode:'attach-v2',sessionId:attached.sessionId});assert.equal(r.repositoryId,repo.repositoryId);assert.equal(remote.puts.length,writes);await attached.close();
  const empty=noCasDav(),fresh=await openStateV2('empty','target',factory);
  await assert.rejects(openRepositoryV2(empty.dav,fresh,{mode:'attach-v2',sessionId:fresh.sessionId}));assert.equal(empty.puts.length,0);await fresh.close();
});
test('legacy root, missing bound identity and incomplete identity cannot become a new repository',async()=>{
  const remote=noCasDav();remote.files.set('legacy.md',bytes('original'));
  const state=await openStateV2('legacy','target',new IDBFactory());await assert.rejects(openRepositoryV2(remote.dav,state,{mode:'create-v2',sessionId:state.sessionId}));assert.equal(remote.puts.length,0);await state.close();
  const {state:s,remote:m,repo}=await setup();for(const path of m.files.keys())if(path.includes('/identities/'))m.files.delete(path);
  await assert.rejects(repo.assertIdentity());assert.equal(await s.getMeta('boundRepoId'),'repo');await s.close();
});
test('concurrent bootstrap identities are preserved and detected without a winner overwrite',async()=>{
  const remote=noCasDav(),factory=new IDBFactory();let release!:()=>void;
  const ready=new Promise<void>(r=>{release=r});let count=0;
  remote.setBeforeList(async path=>{if(path===''&&count<2){if(++count===2)release();await ready}});
  const a=await openStateV2('creator-a','target',factory),b=await openStateV2('creator-b','target',factory);
  const results=await Promise.allSettled([openRepositoryV2(remote.dav,a,{mode:'create-v2',sessionId:a.sessionId}),openRepositoryV2(remote.dav,b,{mode:'create-v2',sessionId:b.sessionId})]);
  assert.equal([...remote.files.keys()].filter(p=>p.includes('/identities/')).length,2);
  for(const r of results)if(r.status==='fulfilled')await assert.rejects(r.value.assertIdentity());
  assert.notEqual((await a.getMeta<{repositoryId:string}>('bootstrap-intent'))?.repositoryId,(await b.getMeta<{repositoryId:string}>('bootstrap-intent'))?.repositoryId);await a.close();await b.close();
});
test('duplicate identity aliases are one identity; an unknown corrupt identity blocks attach',async()=>{
  const {state,remote,repo}=await setup();const [path,data]=[...remote.files].find(([p])=>p.includes('/identities/'))!;
  const hash=path.split('.').slice(-2)[0];remote.files.set(`.webdav-sync-v2/identities/duplicate.${hash}.json`,data);await repo.assertIdentity();
  remote.files.set(`.webdav-sync-v2/identities/partial.${'b'.repeat(64)}.json`,bytes('{'));
  await assert.rejects(repo.assertIdentity());assert.equal((await state.getMeta('boundRepoId')),'repo');await state.close();
});
test('publication readback accepts a server effect followed by HTTP500 without retrying the same URL',async()=>{
  const {state,remote,repo}=await setup();const revision=await rev(),event=await evt([revision]),operation=op(event);
  await state.prepare(operation,{[(revision.core.value as{hash:string}).hash]:bytes('base')});
  remote.setAfterPut(async path=>{if(path.includes('/blobs/')||path.includes('/journal/'))throw new DavError('Transient',500)});
  const proof=await repo.publish(event,{},boundary);assert.equal(proof.eventId,event.id);assert.equal((await state.outbox())[0].phase,'published');
  assert.equal(remote.puts.length,new Set(remote.puts).size);assert.equal(await hashBytes(await repo.readSlot(proof.blobs[0].slot)),(revision.core.value as{hash:string}).hash);await state.close();
});
test('lost publication ack plus stale404 is unknown; a fresh alias survives a late original request',async()=>{
  const {state,remote,repo}=await setup();const event=await evt([await rev()]),operation=op(event);await state.prepare(operation,{[(event.core.revisions[0].core.value as{hash:string}).hash]:bytes('base')});
  let late:(()=>void)|undefined,failed='';remote.setAfterPut(async(path,data)=>{if(path.includes('/journal/')&&!late){failed=path;remote.files.delete(path);late=()=>remote.files.set(path,data);throw new DavError('UnknownWrite')}});
  await assert.rejects(repo.publish(event,{},boundary));assert.equal(await repo.reconcile(operation.id),'unknown');assert.equal((await state.outbox())[0].phase,'publication-unknown');
  remote.setAfterPut();const proof=await repo.publish(event,{},boundary);assert.notEqual(proof.container.path,failed);late!();
  const reconciled=await repo.reconcile(operation.id);assert.notEqual(reconciled,'unknown');if(reconciled!=='unknown')assert.equal(reconciled.eventId,event.id);
  assert.equal(remote.puts.length,new Set(remote.puts).size);await state.close();
});
test('partial blob cannot poison a confirmed alias; retries never PUT the same physical hash path',async()=>{
  const {state,remote,repo}=await setup();const event=await evt([await rev()]);await state.prepare(op(event),{[(event.core.revisions[0].core.value as{hash:string}).hash]:bytes('base')});
  let badPath='';remote.setAfterPut(async(path)=>{if(path.includes('/blobs/')&&!badPath){badPath=path;remote.files.set(path,bytes('b'));throw new DavError('UnknownWrite')}});
  await assert.rejects(repo.publish(event,{},boundary));remote.setAfterPut();const proof=await repo.publish(event,{},boundary);
  assert.notEqual(proof.blobs[0].slot.path,badPath);assert.equal(new TextDecoder().decode(remote.files.get(badPath)),'b');
  assert.equal(new TextDecoder().decode(await repo.readSlot(proof.blobs[0].slot)),'base');assert.equal(remote.puts.length,new Set(remote.puts).size);await state.close();
});
test('a child event carries retrievable parent locators and sources can be repaired without a new revision',async()=>{
  const {state,remote,repo}=await setup();const base=await rev(),first=await evt([base]);await state.prepare(op(first),{[(base.core.value as{hash:string}).hash]:bytes('base')});
  await repo.publish(first,{},boundary);await state.admitEvents([first]);
  const edit=await rev('f','edited',[base.id]),event=await evt([edit]);await state.prepare(op(event),{[(edit.core.value as{hash:string}).hash]:bytes('edited')});
  const proof=await repo.publish(event,{},boundary),container=JSON.parse(new TextDecoder().decode(await repo.readSlot(proof.container)));
  assert.equal(container.dependencies[0].revisionId,base.id);assert.equal(container.dependencies[0].event.eventId,first.id);
  await state.admitEvents([event]);remote.files.delete(proof.blobs[0].slot.path);
  const repaired=await repo.repairSources(event.id,{[(edit.core.value as{hash:string}).hash]:bytes('edited')});assert.equal(repaired.eventId,event.id);assert.notEqual(repaired.container.path,proof.container.path);
  assert.equal(new TextDecoder().decode(await repo.readSlot(repaired.blobs[0].slot)),'edited');await state.close();
});
