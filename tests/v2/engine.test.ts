import test from 'node:test';
import assert from 'node:assert/strict';
import { noCasDav } from './memory-dav.ts';
import { clientV2 } from './client.ts';
import { hashBytes } from '../../src/snapshots.ts';
import { bytes, rev, evt, op } from './fixtures.ts';
test('real vault snapshots upload/download and unchanged runs create no logical changes',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');
  const first=await a.engine.run();assert.equal(first.state,'clean');assert.equal(Object.keys(await a.state.appliedFiles()).length,1);
  const count=(await a.state.verifiedEvents()).length;await a.engine.run();assert.equal((await a.state.verifiedEvents()).length,count);
  const b=await clientV2(remote);assert.equal((await b.engine.run()).state,'clean');assert.equal(await b.vault.read('a.md'),'base');await a.close();await b.close();
});
test('editing during an own upload advances only the captured baseline and keeps the next edit causal',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','first');let raced=false;
  remote.setAfterPut(async path=>{if(path.includes('/journal/')&&!raced){raced=true;a.vault.seed('a.md','second');await a.state.recordDirtyEvent({kind:'modify',path:'a.md',generation:1})}});
  await a.engine.run();assert.equal(await a.vault.read('a.md'),'second');const before=Object.values(await a.state.appliedFiles())[0];assert.equal(before.value.kind==='file'&&before.value.hash,await hashBytes(bytes('first')));
  remote.setAfterPut();await a.engine.run();const after=Object.values(await a.state.appliedFiles())[0];
  const revision=(await a.state.verifiedEvents()).flatMap(e=>e.core.revisions).find(r=>r.id===after.revisionIds[0])!;
  assert.deepEqual(revision.core.parents,before.revisionIds);assert.equal((await a.state.outbox()).length,0);await a.close();
});

test('automatic merge never adopts a late unsynced editor value as permission to overwrite it',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','a\nb\nc\n');await a.engine.run();
  const b=await clientV2(remote);await b.engine.run();a.vault.seed('a.md','A\nb\nc\n');await a.engine.run();
  b.vault.seed('a.md','a\nb\nC\n');let raced=false;
  remote.setAfterPut(async path=>{if(path.includes('/journal/')&&!raced){raced=true;b.vault.seed('a.md','LATE USER EDIT\n');await b.state.recordDirtyEvent({kind:'modify',path:'a.md',generation:1});}});
  try{
    const first=await b.engine.run();assert(raced);assert.notEqual(first.state,'clean');assert.equal(await b.vault.read('a.md'),'LATE USER EDIT\n');
    remote.setAfterPut();await b.engine.run();
    const hash=await hashBytes(bytes('LATE USER EDIT\n'));
    assert((await b.state.verifiedEvents()).some(e=>e.core.revisions.some(r=>r.core.value.kind==='file'&&r.core.value.hash===hash)));
    assert.equal(await b.vault.read('a.md'),'LATE USER EDIT\n');
  }finally{remote.setAfterPut();await a.close();await b.close();}
});
test('a remote apply racing a local edit preserves the edit and later merges from the actually applied base',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','a\nb\nc\n');await a.engine.run();const b=await clientV2(remote);await b.engine.run();
  const base=Object.values(await b.state.appliedFiles())[0];a.vault.seed('a.md','A\nb\nc\n');await a.engine.run();
  b.vault.raceProcess(()=>b.vault.seed('a.md','a\nb\nC\n'));await b.engine.run();assert.equal(await b.vault.read('a.md'),'a\nb\nC\n');assert.deepEqual(Object.values(await b.state.appliedFiles())[0].revisionIds,base.revisionIds);
  await b.engine.run();assert.equal(await b.vault.read('a.md'),'A\nb\nC\n');
  const localHash=await hashBytes(bytes('a\nb\nC\n')),localRevision=(await b.state.verifiedEvents()).flatMap(e=>e.core.revisions).find(r=>r.core.value.kind==='file'&&r.core.value.hash===localHash)!;
  assert.deepEqual(localRevision.core.parents,base.revisionIds);assert.equal((await b.state.outbox()).length,0);await a.close();await b.close();
});
test('three overlapping variants and every original remain readable after a fresh client rebuild',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');await a.engine.run();const b=await clientV2(remote),c=await clientV2(remote);await b.engine.run();await c.engine.run();
  for(const [client,value]of [[a,'A'],[b,'B'],[c,'C']] as const){client.vault.seed('a.md',value);await client.engine.run()}
  const d=await clientV2(remote);const outcome=await d.engine.run();assert.equal(outcome.state,'conflicted');const conflicts=await d.engine.conflicts();assert.equal(conflicts[0].variants.length,3);
  const originals=new Set<string>();for(const r of conflicts[0].variants)originals.add(new TextDecoder().decode(await d.engine.readVersion(r.id)));
  assert.deepEqual([...originals].sort(),['A','B','C']);for(const client of[a,b,c,d])await client.close();
});
test('a vanished canonical original is repaired before publishing a local deletion',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','original');await a.engine.run();const baseline=Object.values(await a.state.appliedFiles())[0];
  for(const path of remote.files.keys())if(path.includes('/blobs/'))remote.files.delete(path);
  a.vault.files.delete('a.md');assert.equal((await a.engine.run()).state,'clean');
  const fresh=await clientV2(remote);await fresh.engine.run();assert.equal(new TextDecoder().decode(await fresh.engine.readVersion(baseline.revisionIds[0])),'original');
  assert(remote.puts.filter(p=>p.includes('/blobs/')).length>=2);await a.close();await fresh.close();
});
test('a frozen close boundary reports late remote data as follow-up and does not apply it',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','first');await a.engine.run();const b=await clientV2(remote);await b.engine.run();
  const frozen=await b.engine.captureBoundary();a.vault.seed('a.md','late');await a.engine.run();
  const result=await b.engine.run(frozen);assert.equal(await b.vault.read('a.md'),'first');assert(result.boundaryCompletion.followUpRemote);assert.equal(result.boundaryCompletion.unresolvedAccepted.length,0);
  await b.engine.run();assert.equal(await b.vault.read('a.md'),'late');await a.close();await b.close();
});
for(const phase of ['prepare','recordContainer','admitEvents','checkpoint'] as const)test(`restart after ${phase} retains one logical publication and the actual bytes`,async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','durable');const mutable=a.state as unknown as Record<string,(...args:unknown[])=>Promise<unknown>>,original=mutable[phase];let injected=false;
  mutable[phase]=async(...args:unknown[])=>{const value=await original(...args);if(!injected&&(phase!=='admitEvents'||(args[0] as unknown[])?.length)){injected=true;throw Error('Simulated process loss')}return value};
  await a.engine.run();await a.close();const reopened=await clientV2(remote,'attach-v2',a.factory,a.scope,a.vault);
  const result=await reopened.engine.run();assert.equal(result.state,'clean');assert.equal((await reopened.state.verifiedEvents()).length,1);assert.equal(await reopened.vault.read('a.md'),'durable');assert.equal((await reopened.state.outbox()).length,0);await reopened.close();
});
test('a crash after writing a local file resumes its apply checkpoint instead of treating it as a new birth',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','one');a.vault.seed('b.md','two');await a.engine.run();const b=await clientV2(remote);
  const apply=b.local.apply;let calls=0;b.local.apply=async(...args)=>{const r=await apply(...args);if(++calls===2)throw Error('Simulated process loss');return r};
  await b.engine.run();assert.equal(Object.keys(await b.state.appliedFiles()).length,1);await b.close();
  const reopened=await clientV2(remote,'attach-v2',b.factory,b.scope,b.vault);assert.equal((await reopened.engine.run()).state,'clean');assert.equal(await reopened.vault.read('a.md'),'one');assert.equal(await reopened.vault.read('b.md'),'two');
  assert.equal((await reopened.state.verifiedEvents()).length,1);assert.equal((await reopened.state.outbox()).length,0);await a.close();await reopened.close();
});
test('one unavailable remote body does not prevent another file from applying and checkpointing',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','one');a.vault.seed('b.md','two');await a.engine.run();
  const hash=await hashBytes(bytes('one'));for(const p of remote.files.keys())if(p.endsWith(`.${hash}.bin`))remote.files.delete(p);
  remote.files.delete('a.md'); // Neither immutable source nor hash-anchored readable cache remains.
  const b=await clientV2(remote);const failed=await b.engine.run();assert.equal(failed.state,'pending');assert.equal(await b.vault.read('b.md'),'two');assert.equal(Object.values(await b.state.appliedFiles()).filter(f=>f.value.path==='b.md').length,1);
  const event=(await a.state.verifiedEvents())[0];await a.repository.repairSources(event.id,{[hash]:bytes('one')});
  assert.equal((await b.engine.run()).state,'clean');assert.equal(await b.vault.read('a.md'),'one');await a.close();await b.close();
});
test('a selected conflict subset is frozen before waiting for the engine queue',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');await a.engine.run();const b=await clientV2(remote),c=await clientV2(remote);await b.engine.run();await c.engine.run();
  for(const [client,value]of [[a,'A'],[b,'B'],[c,'C']] as const){client.vault.seed('a.md',value);await client.engine.run()}
  const conflict=(await c.engine.conflicts())[0],ids=conflict.variants.slice(0,2).map(r=>r.id),expected=[...ids].sort();
  const pending=c.engine.resolveConflict({fileId:conflict.fileId,reviewedIds:ids,choice:{kind:'variant',revisionId:ids[0]}});ids.push(conflict.variants[2].id);await pending;
  const resolutions=(await c.state.verifiedEvents()).flatMap(e=>e.core.revisions).filter(r=>r.core.operation==='resolve');assert.equal(resolutions.length,1);assert.deepEqual(resolutions[0].core.parents,expected);
  for(const client of[a,b,c])await client.close();
});
test('equal states with different ancestry use all represented IDs without emitting equality-only joins',async()=>{
  const remote=noCasDav(),publisher=await clientV2(remote,'create-v2'),root=await rev(),origins=await Promise.all(['A','B','C'].map(v=>rev('f',v,[root.id])));
  const leaves=await Promise.all(origins.map(r=>rev('f','same',[r.id]))),events=[];
  for(const [r,value]of [[root,'base'],...origins.map((r,i)=>[r,['A','B','C'][i]] as const),...leaves.map(r=>[r,'same'] as const)] as const){
    const event=await evt([r]);events.push(event);await publisher.state.prepare(op(event),{[(r.core.value as{hash:string}).hash]:bytes(value)});
    await publisher.repository.publish(event,{}, {id:'boundary',throughGeneration:1,admittedEventIds:[]});await publisher.state.admitEvents([event]);
  }
  await publisher.close();const clients=[];
  for(let i=0;i<3;i++){
    const c=await clientV2(remote);clients.push(c);const peer=(i+1)%3;
    await c.engine.run({id:'frozen',throughGeneration:0,admittedEventIds:[events[0].id,events[i+1].id,events[peer+1].id,events[i+4].id,events[peer+4].id]});
    assert.equal(await c.vault.read('a.md'),'same');assert.deepEqual((await c.state.appliedFiles()).f.revisionIds,[leaves[i].id,leaves[peer].id].sort());
  }
  for(let round=0;round<3;round++)for(const c of clients)await c.engine.run();
  for(const c of clients){assert.equal((await c.state.verifiedEvents()).flatMap(e=>e.core.revisions).filter(r=>r.core.operation==='merge').length,0);assert.deepEqual((await c.state.appliedFiles()).f.revisionIds,leaves.map(r=>r.id).sort());await c.close()}
});
test('an older pending apply cannot undo an already applied descendant even when the bytes return to the old base',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');await a.engine.run();const b=await clientV2(remote);await b.engine.run();
  const original=Object.values(await b.state.appliedFiles())[0];a.vault.seed('a.md','remote');await a.engine.run();
  const apply=b.local.apply;let defer=true;b.local.apply=async(...args)=>{if(defer){defer=false;return'changed'}return apply(...args)};
  await b.engine.run();const heads=(await b.engine.currentView()).headsByFile[original.fileId];
  await b.engine.restoreVersion(original.fileId,original.revisionIds[0],heads.map(r=>r.id));
  assert.equal(await b.vault.read('a.md'),'base');assert.equal((await b.state.outbox()).length,0);await a.close();await b.close();
});
test('a durable rename after a binary apply prevents stale replay from recreating the old path',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.bin','base');await a.engine.run();const b=await clientV2(remote);await b.engine.run();
  a.vault.seed('a.bin','remote');await a.engine.run();const apply=b.local.apply;let crash=true;
  b.local.apply=async(...args)=>{const result=await apply(...args);if(crash){crash=false;const file=b.vault.files.get('a.bin')!;
    await b.vault.vault.rename(file as unknown as import('obsidian').TFile,'b.bin');await b.state.recordDirtyEvent({kind:'rename',from:'a.bin',path:'b.bin',generation:1});throw Error('Crash after rename')};return result};
  await b.engine.run();await b.close();const reopened=await clientV2(remote,'attach-v2',b.factory,b.scope,b.vault);await reopened.engine.run();
  assert.equal(reopened.vault.files.has('a.bin'),false);assert.equal(await reopened.vault.read('b.bin'),'remote');assert.equal((await reopened.state.outbox()).length,0);await a.close();await reopened.close();
});
test('a matching local variant is adopted even while another remote variant remains conflicted',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');await a.engine.run();const b=await clientV2(remote);await b.engine.run();a.vault.seed('a.md','A');await a.engine.run();b.vault.seed('a.md','B');await b.engine.run();
  const c=await clientV2(remote);c.vault.seed('a.md','A');await c.engine.run();const actual=Object.values(await c.state.appliedFiles())[0];assert(actual);assert.equal(actual.value.kind==='file'&&actual.value.hash,await hashBytes(bytes('A')));
  c.vault.seed('a.md','C');await c.engine.run();const hashC=await hashBytes(bytes('C')),edit=(await c.state.verifiedEvents()).flatMap(e=>e.core.revisions).find(r=>r.core.value.kind==='file'&&r.core.value.hash===hashC)!;
  assert.deepEqual(edit.core.parents,actual.revisionIds);
  for(const client of[a,b,c])await client.close();
});

test('independent deliberate creations retain separate identities even when their bytes match',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2'),b=await clientV2(remote);await a.engine.run();await b.engine.run();
  for(const c of[a,b]) {c.vault.seed('a.md','same');await c.state.recordDirtyEvent({kind:'create',path:'a.md',generation:1});}
  await a.engine.run();await b.engine.run();
  assert.equal(Object.keys((await b.engine.currentView()).headsByFile).length,2);
  assert.equal((await b.engine.pathConflicts()).length,1);await a.close();await b.close();
});

test('manual resolution captures a late unsynced local edit without absorbing it into reviewed parents',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');await a.engine.run();const b=await clientV2(remote);await b.engine.run();
  a.vault.seed('a.md','A');await a.engine.run();b.vault.seed('a.md','B');await b.engine.run();const conflict=(await b.engine.conflicts())[0],reviewed=conflict.variants.map(r=>r.id);
  const hashA=await hashBytes(bytes('A')),chosen=conflict.variants.find(r=>r.core.value.kind==='file'&&r.core.value.hash===hashA)!;
  b.vault.seed('a.md','late');await b.engine.resolveConflict({fileId:conflict.fileId,reviewedIds:reviewed,choice:{kind:'variant',revisionId:chosen.id}});
  assert.equal(await b.vault.read('a.md'),'late');const heads=(await b.engine.currentView()).headsByFile[conflict.fileId];assert.equal(heads.length,2);
  const late=await hashBytes(bytes('late'));assert(heads.some(r=>r.core.value.kind==='file'&&r.core.value.hash===late));
  await a.close();await b.close();
});

test('cold download indexes body locators once instead of rereading all metadata for every file',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');for(let i=0;i<100;i++)a.vault.seed('n'+i+'.md','value '+i);await a.engine.run();
  const b=await clientV2(remote),read=b.state.sourceIndex;let calls=0;b.state.sourceIndex=async()=>{calls++;return read();};
  assert.equal((await b.engine.run()).state,'clean');assert(calls<20,'source index reads: '+calls);
  a.vault.seed('n0.md','new');await a.engine.run();assert.equal((await b.engine.run()).state,'clean');assert.equal(await b.vault.read('n0.md'),'new');await a.close();await b.close();
});

test('remote body downloads honor the bounded parallel transfer setting',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','A');a.vault.seed('b.md','B');await a.engine.run();const b=await clientV2(remote);
  let release!:()=>void,started!:()=>void,active=0,maximum=0;const gate=new Promise<void>(r=>{release=r;}),both=new Promise<void>(r=>{started=r;}),read=remote.dav.read;
  remote.dav.read=async path=>{if(!path.includes('/blobs/'))return read(path);active++;maximum=Math.max(maximum,active);if(active===2)started();await gate;try{return await read(path);}finally{active--;}};
  const running=b.engine.run();let timeout:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([both,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Second transfer did not start')),1000);})]);release();assert.equal((await running).state,'clean');assert.equal(maximum,2);}
  finally{if(timeout)clearTimeout(timeout);release();await running;await a.close();await b.close();}
});
