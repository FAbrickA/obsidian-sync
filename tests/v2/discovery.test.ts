import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openStateV2 } from '../../src/state.ts';
import { openRepositoryV2 } from '../../src/repository.ts';
import { createHistoryIndex } from '../../src/v2-history.ts';
import { discover, createAuditScheduler } from '../../src/v2-discovery.ts';
import { noCasDav } from './memory-dav.ts';
import { DavError } from '../../src/transport.ts';
import { rev, evt, op, bytes } from './fixtures.ts';
import { canonicalBytes, hashBytes } from '../../src/snapshots.ts';
import type { Revision, EventRecord, Container } from '../../src/v2-types.ts';
const boundary={id:'boundary',throughGeneration:1,admittedEventIds:[]};
async function setup(){
  const remote=noCasDav(),factory=new IDBFactory(),writer=await openStateV2(crypto.randomUUID(),'target',factory);await writer.ensureBootstrapIntent('repo');
  const repo=await openRepositoryV2(remote.dav,writer,{mode:'create-v2',sessionId:writer.sessionId});
  const reader=await openStateV2(crypto.randomUUID(),'target',factory),readRepo=await openRepositoryV2(remote.dav,reader,{mode:'attach-v2',sessionId:reader.sessionId});
  return{remote,writer,repo,reader,readRepo,index:createHistoryIndex('repo'),async close(){await writer.close();await reader.close()}};
}
async function publish(s:Awaited<ReturnType<typeof setup>>,r:Revision,text:string,previous:string|null=null){
  const event=await evt([r],s.writer.deviceId,previous);const hash=r.core.value.kind==='file'?r.core.value.hash:'';
  await s.writer.prepare(op(event),hash?{[hash]:bytes(text)}:{});const proof=await s.repo.publish(event,{},boundary);await s.writer.admitEvents([event]);return{event,proof};
}
test('canonical discovery finds an unhinted fork, ignores hint rollback and never forgets a missing listing entry',async()=>{
  const s=await setup(),base=await rev(),first=await publish(s,base,'base');await s.repo.writeHint({eventId:first.event.id,containerSlots:[first.proof.container]});
  await discover(s.readRepo,s.index,{mode:'canonical'});
  const a=await rev('f','A',[base.id]),b=await rev('f','B',[base.id]),ea=await publish(s,a,'A',first.event.id),eb=await publish(s,b,'B',first.event.id);
  await s.repo.writeHint({eventId:ea.event.id,containerSlots:[ea.proof.container]});
  const hinted=await discover(s.readRepo,s.index,{mode:'hint'});assert.deepEqual(hinted.view.headsByFile.f.map(r=>r.id),[a.id]);
  await s.repo.writeHint({eventId:first.event.id,containerSlots:[first.proof.container]});
  assert((await discover(s.readRepo,s.index,{mode:'hint'})).requiresCanonical);
  const canonical=await discover(s.readRepo,s.index,{mode:'canonical'});assert.deepEqual(canonical.view.headsByFile.f.map(r=>r.id).sort(),[a.id,b.id].sort());
  s.remote.files.delete(eb.proof.container.path);const again=await discover(s.readRepo,s.index,{mode:'canonical'});assert.deepEqual(again.view.headsByFile.f.map(r=>r.id).sort(),[a.id,b.id].sort());
  assert.equal((await s.reader.verifiedEvents()).length,3);await s.close();
});
test('missing hints request canonical fallback; a fixed close event set is never enlarged',async()=>{
  const s=await setup(),first=await publish(s,await rev(),'base');
  const frozen=Object.freeze([first.event.id]);const hinted=await discover(s.readRepo,s.index,{mode:'hint',frozenEventIds:frozen});assert(hinted.requiresCanonical);
  await discover(s.readRepo,s.index,{mode:'canonical',frozenEventIds:frozen});
  const next=await publish(s,await rev('f','remote',[first.event.core.revisions[0].id]),'remote');
  const result=await discover(s.readRepo,s.index,{mode:'canonical',frozenEventIds:frozen});assert.deepEqual(frozen,[first.event.id]);assert(result.followUpEventIds.includes(next.event.id));await s.close();
});
test('a corrupt physical alias cannot suppress a good event at a nonconsecutive group',async()=>{
  const s=await setup(),first=await publish(s,await rev(),'base');
  const original=s.remote.files.get(first.proof.container.path)!;s.remote.files.set(first.proof.container.path,bytes('{partial'));
  const path=`${s.repo.prefix}/journal/other-device/99/segment/alias.${first.proof.container.hash}.json`;
  for(let i=1;i<path.split('/').length;i++)s.remote.directories.add(path.split('/').slice(0,i).join('/'));
  s.remote.files.set(path,original);const result=await discover(s.readRepo,s.index,{mode:'canonical'});
  assert.equal(result.view.headsByFile.f.length,1);assert(result.advisories.some(i=>i.code==='Corrupt'));assert(!result.issues.some(i=>i.kind==='source'&&i.code==='Corrupt'));await s.close();
});
test('parents within one pack are admitted without external locators or historical body downloads',async()=>{
  const s=await setup(),base=await rev(),edit=await rev('f','edit',[base.id]),events:EventRecord[]=[await evt([base]),await evt([edit])];
  const container:Container={schema:2,repositoryId:'repo',events,sources:[base,edit].map(r=>{
    const v=r.core.value as {hash:string,size:number};return{hash:v.hash,size:v.size,slot:{path:`${s.repo.prefix}/blobs/device/b-${r.id}.${v.hash}.bin`,hash:v.hash,size:v.size}};
  }),dependencies:[],previousSources:[]};
  const data=canonicalBytes(container),hash=await hashBytes(data.buffer),path=`${s.repo.prefix}/journal/device/3/segment/pack.${hash}.json`;
  for(let i=1;i<path.split('/').length;i++)s.remote.directories.add(path.split('/').slice(0,i).join('/'));s.remote.files.set(path,data.buffer);
  const result=await discover(s.readRepo,s.index,{mode:'canonical'});assert.deepEqual(result.view.headsByFile.f.map(r=>r.id),[edit.id]);assert.equal(result.view.bodyStates[(edit.core.value as{hash:string}).hash],'unchecked');await s.close();
});
test('audit deadlines survive a busy run, hidden state and foreground without overlap',()=>{
  const s=createAuditScheduler();assert.equal(s.scheduleAudit(0,{visible:true,running:false}),'canonical');
  assert.equal(s.scheduleAudit(59_999,{visible:true,running:false}),'none');assert.equal(s.scheduleAudit(60_000,{visible:true,running:false}),'hint');
  assert.equal(s.scheduleAudit(300_000,{visible:true,running:true}),'none');assert.equal(s.scheduleAudit(310_000,{visible:true,running:false}),'canonical');
  assert.equal(s.scheduleAudit(600_000,{visible:true,running:false}),'canonical');
  assert.equal(s.scheduleAudit(600_001,{visible:false,running:false}),'none');assert.equal(s.scheduleAudit(600_002,{visible:true,running:true}),'none');
  assert.equal(s.scheduleAudit(600_003,{visible:true,running:false}),'canonical');
  assert.equal(s.scheduleAudit(900_000,{visible:true,running:false}),'canonical');
});
test('a stale GET404 does not retire the confirmed base and can be recovered by the next canonical scan',async()=>{
  const s=await setup(),base=await rev();await publish(s,base,'base');await discover(s.readRepo,s.index,{mode:'canonical'});
  const edit=await rev('f','edit',[base.id]),next=await publish(s,edit,'edit'),read=s.remote.dav.read;let stale=true;
  s.remote.dav.read=async(path)=>{if(path===next.proof.container.path&&stale){stale=false;throw new DavError('NotFound',404)}return read(path)};
  const first=await discover(s.readRepo,s.index,{mode:'canonical'});assert.deepEqual(first.view.headsByFile.f.map(r=>r.id),[base.id]);assert(first.issues.some(i=>i.code==='Incomplete'));
  const recovered=await discover(s.readRepo,s.index,{mode:'canonical'});assert.deepEqual(recovered.view.headsByFile.f.map(r=>r.id),[edit.id]);await s.close();
});
test('a previous-event locator finds an independent file even while its listing entry is missing',async()=>{
  const s=await setup(),first=await publish(s,await rev('g','prior',[],'create','g.md'),'prior');
  await publish(s,await rev(),'base',first.event.id);const list=s.remote.dav.list;
  s.remote.dav.list=async(path)=>(await list(path)).filter(e=>e.path!==first.proof.container.path);
  const found=await discover(s.readRepo,s.index,{mode:'canonical'});assert.equal(found.view.headsByFile.g?.length,1);await s.close();
});
