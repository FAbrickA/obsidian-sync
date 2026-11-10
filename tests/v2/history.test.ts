import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBytes, hashBytes } from '../../src/snapshots.ts';
import { revisionId, decodeContainer } from '../../src/v2-codec.ts';
import { createHistoryIndex, ingestContainers, reduceHistory, bestCommonAncestors, adoptLocal } from '../../src/v2-history.ts';
import { makeLocalRevisionV2 } from '../../src/planner.ts';
import type { EventRecord, Revision, AppliedFileV2 } from '../../src/v2-types.ts';
import { rev, evt, bytes, recorded as records } from './fixtures.ts';
async function history(revisions: Revision[]) {
  const events: EventRecord[]=[];for(const r of revisions)events.push(await evt([r]));
  const entries=await records(events),index=createHistoryIndex('repo');await ingestContainers(index,entries);return{index,events,entries};
}
function permutations<T>(a:T[]):T[][] {return a.length?a.flatMap((v,i)=>permutations(a.filter((_,j)=>i!==j)).map(t=>[v,...t])):[[]]}
const headIds=(view:Awaited<ReturnType<typeof reduceHistory>>,file='f')=>(view.headsByFile[file]??[]).map(r=>r.id).sort();
test('a genuine recreate can reference every represented concurrent tombstone',async()=>{
  const root=await rev(),a=await rev('f','A',[root.id]),b=await rev('f','B',[root.id]);
  const tomb=async(r:Revision)=>{const core={...r.core,parents:[r.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'a.md'}};return{id:await revisionId(core),core};};
  const ta=await tomb(a),tb=await tomb(b),h=await history([root,a,b,ta,tb]),view=await reduceHistory(h.index),hash=await hashBytes(bytes('new'));
  const plan=adoptLocal({files:{'a.md':{path:'a.md',hash,size:3}},excluded:[],complete:true},view,[{path:'a.md',generation:2,afterTombstone:{oldFileId:'f',tombstones:[ta.id,tb.id].sort()}}]);
  assert.equal(plan.births[0]?.operation,'recreate');assert.deepEqual(plan.births[0].recreates?.tombstones,[ta.id,tb.id].sort());
});

test('all 24 delivery orders, duplicate copies and partial prefixes preserve causal branches',async()=>{
  const base=await rev(),a=await rev('f','A',[base.id]),b=await rev('f','B',[base.id]),c=await rev('f','C',[base.id]);
  const all=await records(await Promise.all([base,a,b,c].map(r=>evt([r]))));let fingerprint='';
  for(const order of permutations(all)) {
    const index=createHistoryIndex('repo');for(const entry of order)await ingestContainers(index,[entry,entry]);
    const view=await reduceHistory(index);assert.deepEqual(headIds(view),[a.id,b.id,c.id].sort());assert.equal(view.conflicts[0].variants.length,3);
    if(fingerprint)assert.equal(view.fingerprint,fingerprint);fingerprint=view.fingerprint;
  }
});
test('unapplied observation cannot become the parent of a local edit; subset resolution leaves C',async()=>{
  const base=await rev(),a=await rev('f','A',[base.id]),b=await rev('f','B',[base.id]),c=await rev('f','C',[base.id]);
  const {index}=await history([base,a,b,c]);const hash=await hashBytes(bytes('A2'));
  const applied:AppliedFileV2={fileId:'f',revisionIds:[a.id],value:a.core.value,baseHash:(a.core.value as{hash:string}).hash,dirtyGeneration:1};
  const edit=await makeLocalRevisionV2('repo',applied,{path:'a.md',hash,size:2});assert(edit);assert.deepEqual(edit.core.parents,[a.id]);
  const resolution=await rev('f','chosen A',[a.id,b.id],'resolve');
  const e=await evt([resolution]),pool=await records([...(await history([base,a,b,c])).events,e]);
  await ingestContainers(index,pool);assert.deepEqual(headIds(await reduceHistory(index)),[c.id,resolution.id].sort());
});
test('missing dependencies defer a whole multi-file event while unrelated valid events still apply',async()=>{
  const base=await rev(),child=await rev('f','child',[base.id]),other=await rev('g','other',[],'create','g.md');
  const e0=await evt([base]),batch=await evt([child,other]),independent=await evt([await rev('h','ok',[],'create','h.md')]);
  const entries=await records([e0,batch,independent]),index=createHistoryIndex('repo');
  await ingestContainers(index,[entries[1],entries[2]]);let view=await reduceHistory(index);
  assert.equal(view.headsByFile.f,undefined);assert.equal(view.headsByFile.g,undefined);assert.equal(view.headsByFile.h.length,1);
  await ingestContainers(index,[entries[0]]);view=await reduceHistory(index);assert.deepEqual(headIds(view),[child.id]);assert.equal(view.headsByFile.g.length,1);
});
test('a missing or incorrect source declaration cannot retire a confirmed base',async()=>{
  const base=await rev(),child=await rev('f','changed',[base.id]),h=await history([base]);
  const events=[h.events[0],await evt([child])],entries=await records(events);
  const c=entries[1].decoded,data=canonicalBytes({schema:2,repositoryId:'repo',events:c.events,sources:c.sources,dependencies:[],previousSources:[]});
  const hash=await hashBytes(data.buffer),missing={slot:{path:`.webdav-sync-v2/repos/repo/journal/device/0/segment/missing.${hash}.json`,hash,size:data.byteLength},decoded:await decodeContainer(data,hash,'repo')};
  await ingestContainers(h.index,[missing]);assert.deepEqual(headIds(await reduceHistory(h.index)),[base.id]);
  await ingestContainers(h.index,[entries[1]]);assert.deepEqual(headIds(await reduceHistory(h.index)),[child.id]);
});
test('delete/edit and criss-cross preserve every original and every best common base',async()=>{
  const root=await rev(),a=await rev('f','A',[root.id]),b=await rev('f','B',[root.id]);
  const x=await rev('f','X',[a.id,b.id],'resolve'),y=await rev('f','Y',[a.id,b.id],'resolve');
  const h=await history([root,a,b,x,y]);assert.deepEqual(bestCommonAncestors('f',[x.id,y.id],h.index),[a.id,b.id].sort());
  const core={...root.core,parents:[root.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'a.md'}};
  const tomb={id:await revisionId(core),core},d=await history([root,tomb,a]);const view=await reduceHistory(d.index);
  assert.deepEqual(headIds(view),[tomb.id,a.id].sort());assert.equal(view.conflicts[0].reason,'delete-edit');
  const restored=await rev('f','old bytes',[tomb.id,a.id],'restore');assert.notEqual(restored.id,root.id);
});
test('forged cycles and wrong-file ancestry never enter an admitted graph',async()=>{
  const base=await rev(),h=await history([base]),bad=structuredClone(h.entries[0]);bad.decoded.events[0].core.revisions[0].core.parents=[base.id];
  await ingestContainers(h.index,[bad]);assert.deepEqual(headIds(await reduceHistory(h.index)),[base.id]);
  const other=await rev('g','bad',[base.id]);const entries=await records([h.events[0],await evt([other])]);
  await ingestContainers(h.index,[entries[1]]);assert.equal((await reduceHistory(h.index)).headsByFile.g,undefined);
});
test('attach adopts exact bytes, branches different bytes and never treats an old tombstone copy as recreate',async()=>{
  const base=await rev(),h=await history([base]),view=await reduceHistory(h.index);
  const snapshot={files:{'a.md':{path:'a.md',hash:(base.core.value as{hash:string}).hash,size:4}},excluded:[],complete:true};
  assert.deepEqual(adoptLocal(snapshot,view,[]).adoptions[0].revisionIds,[base.id]);
  const changed={...snapshot,files:{'a.md':{path:'a.md',hash:'d'.repeat(64),size:5}}};const branch=adoptLocal(changed,view,[]).branches[0];
  assert.equal(branch.fileId,'f');assert.deepEqual(branch.parents,[]);assert.equal(branch.operation,'bootstrap');
  const core={...base.core,parents:[base.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'a.md'}};
  const tomb={id:await revisionId(core),core},deleted=await history([base,tomb]),deletedView=await reduceHistory(deleted.index);
  assert.equal(adoptLocal(snapshot,deletedView,[]).quarantined[0].reason,'unknown-copy-after-delete');
  const intentional=adoptLocal(snapshot,deletedView,[{path:'a.md',generation:2,afterTombstone:{oldFileId:'f',tombstones:[tomb.id]}}]);
  assert.equal(intentional.births[0].operation,'recreate');assert.notEqual(intentional.births[0].fileId,'f');
});
test('independent identities with equal bytes stay distinct; aliases and file-directory collisions are isolated',async()=>{
  const cases=[['a.md','a.md'],['A.md','a.md'],['é.md','e\u0301.md'],['folder','folder/child.md'],['Notes/a.md','notes/b.md']];
  for(const [a,b]of cases) {
    const h=await history([await rev('f','same',[],'create',a),await rev('g','same',[],'create',b),await rev('h','safe',[],'create','unrelated.md')]);
    const view=await reduceHistory(h.index);assert.equal(view.headsByFile.f.length,1);assert.equal(view.headsByFile.g.length,1);assert(view.pathConflicts.length);
    assert(!view.pathConflicts.some(c=>c.fileIds.includes('h')));
  }
});
test('a late historical tombstone quarantines an unknown bootstrap birth at the same path',async()=>{
  const old=await rev('old','old'),core={...old.core,parents:[old.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'a.md'}};
  const tomb={id:await revisionId(core),core},birth=await rev('new','unknown',[],'bootstrap');
  const h=await history([old,tomb,birth]),view=await reduceHistory(h.index);assert(view.pathConflicts.some(c=>c.reason==='unknown-history'&&c.fileIds.includes('new')));
});
test('only a joint explicit resolution acknowledges a different identity; an unseen third identity stays conflicted',async()=>{
  const old=await rev('old','old'),deadCore={...old.core,parents:[old.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'a.md'}};
  const tomb={id:await revisionId(deadCore),core:deadCore},unknown=await rev('new','unknown',[],'bootstrap');
  const oldResolutionCore={...deadCore,parents:[tomb.id],operation:'resolve' as const};
  const oldResolution={id:await revisionId(oldResolutionCore),core:oldResolutionCore},newResolution=await rev('new','chosen',[unknown.id],'resolve');
  const initial=[await evt([old]),await evt([tomb]),await evt([unknown])],joint=await evt([oldResolution,newResolution]);
  const entries=await records([...initial,joint]),index=createHistoryIndex('repo');await ingestContainers(index,entries);
  assert.equal((await reduceHistory(index)).pathConflicts.length,0);
  const third=await rev('third','third'),thirdCore={...third.core,parents:[third.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'a.md'}};
  const thirdTomb={id:await revisionId(thirdCore),core:thirdCore};
  await ingestContainers(index,await records([await evt([third]),await evt([thirdTomb])]));
  assert((await reduceHistory(index)).pathConflicts.some(c=>c.fileIds.includes('third')));
});
test('a discovery-only missing previous event does not prevent applying a complete file ancestry',async()=>{
  const base=await rev(),edit=await rev('f','new',[base.id]),baseEvent=await evt([base]);
  const entries=await records([baseEvent,await evt([edit],'device','d'.repeat(64))]),index=createHistoryIndex('repo');await ingestContainers(index,entries);
  const view=await reduceHistory(index);assert.deepEqual(headIds(view),[edit.id]);assert(view.coverage.pendingEvents.includes('d'.repeat(64)));
});
test('a valid packed event remains usable beside a corrupt semantic neighbor',async()=>{
  const good=await evt([await rev('safe','safe',[],'create','safe.md')]),[entry]=await records([good]);
  const d=entry.decoded,data=canonicalBytes({schema:2,repositoryId:'repo',events:[{id:'a'.repeat(64),core:{}},good],sources:d.sources,dependencies:[],previousSources:[]});
  const hash=await hashBytes(data.buffer),index=createHistoryIndex('repo');
  await ingestContainers(index,[{slot:{path:`.webdav-sync-v2/repos/repo/journal/device/0/segment/pack.${hash}.json`,hash,size:data.byteLength},decoded:await decodeContainer(data,hash,'repo')}]);
  assert.equal((await reduceHistory(index)).headsByFile.safe.length,1);assert.equal(index.events.size,1);
});
test('10,000 revisions are admitted and reduced iteratively without recursive stack overflow',async()=>{
  const revisions:Revision[]=[];let previous:string|undefined;
  for(let i=0;i<10_000;i++){const r=await rev('f',String(i),previous?[previous]:[]);revisions.push(r);previous=r.id}
  const h=await history(revisions);assert.equal(h.index.events.size,10_000);assert.deepEqual(headIds(await reduceHistory(h.index)),[previous]);
});
