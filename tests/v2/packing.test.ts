import test from 'node:test';
import assert from 'node:assert/strict';
import {clientV2} from './client.ts';
import {noCasDav} from './memory-dav.ts';
import {rev,evt,op,bytes,packedBytes} from './fixtures.ts';
import {createHistoryIndex,reduceHistory} from '../../src/v2-history.ts';
import {discover} from '../../src/v2-discovery.ts';
const boundary={id:'b',throughGeneration:1,admittedEventIds:[]};
async function publish(c:Awaited<ReturnType<typeof clientV2>>,r:Awaited<ReturnType<typeof rev>>,value:string){const e=await evt([r],c.state.deviceId);await c.state.prepare(op(e),{[(r.core.value as{hash:string}).hash]:bytes(value)});await c.repository.publish(e,{},boundary);await c.state.admitEvents([e]);return e;}
test('only durable retirement of positively available members can finalize a segment',async()=>{
  const remote=noCasDav(),c=await clientV2(remote,'create-v2'),event=await publish(c,await rev(),'base');
  const segment=(await c.state.segments())[0],intent=await c.state.retireSegment(segment.segmentId);
  await assert.rejects(c.repository.finishFinalization({...intent,allocatedEventIds:[]}));
  const proof=await c.repository.finishFinalization(intent);assert.deepEqual(proof.record.members.map(m=>m.eventId),[event.id]);
  await assert.rejects(c.state.reserveAttempt('container',packedBytes([event]),{repositoryId:'repo',segment}),/unavailable/);
  assert((await c.state.segments())[0].sealed);await c.close();
});

test('close retirement is permanent while further edits allocate a new segment',async()=>{
  const remote=noCasDav(),c=await clientV2(remote,'create-v2');c.vault.seed('a.md','base');await c.engine.run();const first=(await c.state.segments())[0];
  await c.engine.retireForClose();c.vault.seed('a.md','later');await c.engine.run();const segments=await c.state.segments();
  assert(segments.find(s=>s.segmentId===first.segmentId)?.retired);assert(segments.some(s=>s.segmentId!==first.segmentId&&!s.retired));await c.close();
});

test('reopened recovery may finish a pre-retired intent but cannot retire a foreign active segment',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');await publish(a,await rev(),'base');
  const segment=(await a.state.segments())[0];await a.close();const b=await clientV2(remote,'attach-v2',a.factory,a.scope,a.vault);
  await assert.rejects(b.state.retireSegment(segment.segmentId),/authority/);await b.close();
  const c=await clientV2(remote,'attach-v2');await publish(c,await rev('g','other',[],'create','b.md'),'other');const retired=await c.state.retireSegment((await c.state.segments())[0].segmentId);await c.close();
  const reopened=await clientV2(remote,'attach-v2',c.factory,c.scope,c.vault);await reopened.repository.finishFinalization(retired);assert((await reopened.state.segments())[0].sealed);await reopened.close();
});

test('pack batches split before exceeding the immutable wire limit',async()=>{
  const remote=noCasDav(),c=await clientV2(remote,'create-v2'),base=await publish(c,await rev(),'base'),events=[];
  const long='p'.repeat(2500);
  for(let i=0;i<15;i++) {const revisions=await Promise.all(Array.from({length:256},(_,j)=>rev('f_'+i+'_'+j,'base',[],'create',long+i+'_'+j+'.md')));events.push(await evt(revisions,c.state.deviceId));}
  await c.state.admitEvents(events);const slots=await c.repository.publishPack(events);assert(slots.length>1);
  for(const slot of slots)assert(slot.size<=8_388_608);
  const seen=new Set<string>();for(const slot of slots)for(const e of (await c.repository.readContainer(slot)).decoded.events)seen.add(e.id);
  assert.deepEqual([...seen].sort(),events.map(e=>e.id).sort());assert(base);await c.close();
});
test('an allocated unknown event is retained in finalization intent and prevents a false seal',async()=>{
  const remote=noCasDav(),c=await clientV2(remote,'create-v2'),event=await evt([await rev()]);
  const {packedBytes}=await import('./fixtures.ts'),segment=await c.state.currentSegment([event.id]);
  await c.state.reserveAttempt('container',packedBytes([event]),{repositoryId:'repo',segment});
  const intent=await c.state.retireSegment(segment.segmentId);await assert.rejects(c.repository.finishFinalization(intent));assert.equal((await c.state.segments())[0].sealed,false);await c.close();
});
test('sealed segments skip raw listings while a missing member locator falls back to raw replay',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2'),event=await publish(a,await rev(),'base');
  const segment=(await a.state.segments())[0];await a.repository.finishFinalization(await a.state.retireSegment(segment.segmentId));
  const b=await clientV2(remote),index=createHistoryIndex('repo');await discover(b.repository,index,{mode:'canonical'});
  const raw:string[]=[];remote.setBeforeList(async p=>{if(p.endsWith('/'+segment.segmentId)&&p.includes('/journal/'))raw.push(p)});
  await discover(b.repository,index,{mode:'canonical'});assert.deepEqual(raw,[]);assert(index.events.has(event.id));
  for(const p of [...remote.files.keys()])if(p.includes('/journal/'))remote.files.delete(p);
  const c=await clientV2(remote);raw.length=0;await discover(c.repository,createHistoryIndex('repo'),{mode:'canonical'});assert.equal(raw.length,1);
  for(const peer of[a,b,c])await peer.close();
});
test('packs, raw tail and duplicate aliases preserve the exact causal view including a late branch',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2'),root=await rev(),events=[await publish(a,root,'base')];
  let parent=root;for(let n=0;n<14;n++){parent=await rev('f','v'+n,[parent.id]);events.push(await publish(a,parent,'v'+n));}
  const before=createHistoryIndex('repo');await discover(a.repository,before,{mode:'canonical'});const fingerprint=(await reduceHistory(before)).fingerprint;
  const slots=await a.repository.publishPack(events);assert.equal(slots.length,1);
  const packed=createHistoryIndex('repo');await discover(a.repository,packed,{mode:'canonical'});assert.equal((await reduceHistory(packed)).fingerprint,fingerprint);
  await publish(a,await rev('f','late',[root.id]),'late');const next=createHistoryIndex('repo');await discover(a.repository,next,{mode:'canonical'});
  assert.equal((await reduceHistory(next)).headsByFile.f.length,2);
  const untrusted=await evt([await rev('g','unverified')]);await assert.rejects(a.repository.publishPack([untrusted]));await a.close();
});

test('one verified pack satisfies every sealed member without reading their raw aliases',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2'),events=[];let parent=await rev();events.push(await publish(a,parent,'base'));
  for(let i=0;i<5;i++){parent=await rev('f','v'+i,[parent.id]);events.push(await publish(a,parent,'v'+i));}
  const packs=await a.repository.publishPack(events);for(const s of await a.state.segments())if(!s.retired)await a.state.retireSegment(s.segmentId);
  for(const s of await a.state.segments())await a.repository.finishFinalization(s.finalization!);
  let raw=0;const read=remote.dav.read;remote.dav.read=async path=>{if(path.includes('/journal/')&&!packs.some(p=>p.path===path))raw++;return read(path);};
  const b=await clientV2(remote),index=createHistoryIndex('repo');await discover(b.repository,index,{mode:'canonical'});assert.equal(index.events.size,events.length);assert.equal(raw,0);await a.close();await b.close();
});
