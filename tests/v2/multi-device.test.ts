import test from 'node:test';
import assert from 'node:assert/strict';
import {clientV2} from './client.ts';
import {noCasDav} from './memory-dav.ts';
import {hashBytes,canonicalBytes} from '../../src/snapshots.ts';
import {createHistoryIndex,ingestContainers,reduceHistory} from '../../src/v2-history.ts';
import {decodeContainer} from '../../src/v2-codec.ts';
import {rev,evt,recorded,bytes} from './fixtures.ts';
import type {EventRecord,Revision} from '../../src/v2-types.ts';

test('three offline edits converge, retain original versions and stop publishing after quiescence',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','one\ntwo\nthree\nfour\nfive\n');await a.engine.run();
  const peers=[a,await clientV2(remote),await clientV2(remote)];for(const p of peers.slice(1))await p.engine.run();
  const originals=['ONE\ntwo\nthree\nfour\nfive\n','one\ntwo\nTHREE\nfour\nfive\n','one\ntwo\nthree\nfour\nFIVE\n'];
  for(let i=0;i<3;i++)peers[i].vault.seed('a.md',originals[i]);await Promise.all(peers.map(p=>p.engine.run()));
  for(let round=0;round<4;round++)for(const p of peers)await p.engine.run();
  const fingerprints=await Promise.all(peers.map(async p=>(await p.engine.currentView()).fingerprint));assert(fingerprints.every(f=>f===fingerprints[0]));
  for(const p of peers)assert.equal(await p.vault.read('a.md'),'ONE\ntwo\nTHREE\nfour\nFIVE\n');
  const before=(await a.state.verifiedEvents()).length;for(let n=0;n<3;n++)for(const p of peers)await p.engine.run();assert.equal((await a.state.verifiedEvents()).length,before);
  const all=(await a.state.verifiedEvents()).flatMap(e=>e.core.revisions);
  for(const text of originals){const hash=await hashBytes(bytes(text)),r=all.find(r=>r.core.value.kind==='file'&&r.core.value.hash===hash)!;assert(r);assert.equal(new TextDecoder().decode(await a.engine.readVersion(r.id)),text);}
  for(const p of peers)await p.close();
});

test('late foreign events do not grow a frozen engine boundary',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');await a.engine.run();const b=await clientV2(remote);await b.engine.run();const boundary=await b.engine.captureBoundary(0),fixed=[...boundary.admittedEventIds];
  for(let i=0;i<6;i++){a.vault.seed('a.md','foreign '+i);await a.engine.run();}
  const result=await b.engine.run(boundary,true);assert.deepEqual(result.boundaryCompletion.admittedEventIds,fixed);assert(result.boundaryCompletion.followUpRemote);assert.deepEqual(result.boundaryCompletion.unresolvedAccepted,[]);
  await a.close();await b.close();
});

test('ignored local regions cannot cause remote deletion or upload',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('private/existing.md','remote');a.vault.seed('note.md','keep');await a.engine.run();
  Object.assign(a.policy,{exclude:['private']});a.vault.files.delete('private/existing.md');a.vault.seed('private/new.md','local');assert.equal((await a.engine.run()).state,'clean');
  const values=Object.values((await a.engine.currentView()).headsByFile).flat().map(r=>r.core.value);assert(values.some(v=>v.kind==='file'&&v.path==='private/existing.md'));assert(!values.some(v=>v.path==='private/new.md'));await a.close();
});

test('delete followed by genuine recreation delivers a new identity to an older device',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','old');await a.engine.run();const b=await clientV2(remote);await b.engine.run();
  const old=Object.values(await b.state.appliedFiles())[0];b.vault.files.delete('a.md');await b.state.recordDirtyEvent({kind:'delete',path:'a.md',generation:1});assert.equal((await b.engine.run()).state,'clean');
  b.vault.seed('a.md','new');await b.state.recordDirtyEvent({kind:'create',path:'a.md',generation:2});await b.engine.run();
  let result;for(let i=0;i<3;i++)result=await a.engine.run();assert.equal(result!.state,'clean');assert.equal(await a.vault.read('a.md'),'new');assert.equal((await a.state.outbox()).length,0);
  const view=await a.engine.currentView(),birth=Object.entries(view.headsByFile).find(([id])=>id!==old.fileId)!;assert.equal(view.headsByFile[old.fileId].length,1);assert.equal(view.headsByFile[old.fileId][0].core.value.kind,'tombstone');assert.equal(birth[1][0].core.operation,'recreate');assert.equal(birth[1][0].core.recreates?.oldFileId,old.fileId);await a.close();await b.close();
});

test('rename, edit and delete remain three preserved variants until an explicit resolution',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('image.bin','base');await a.engine.run();const peers=[a,await clientV2(remote),await clientV2(remote)];
  for(const p of peers.slice(1))await p.engine.run();a.vault.seed('image.bin','edited');
  const b=peers[1],c=peers[2];await b.vault.vault.rename(b.vault.vault.getAbstractFileByPath('image.bin')!,'renamed.bin');await b.state.recordDirtyEvent({kind:'rename',from:'image.bin',path:'renamed.bin',generation:1});
  c.vault.files.delete('image.bin');await c.state.recordDirtyEvent({kind:'delete',path:'image.bin',generation:1});await Promise.all(peers.map(p=>p.engine.run()));
  for(const p of peers)await p.engine.run();const conflict=(await a.engine.conflicts())[0];assert.equal(conflict.variants.length,3);
  for(const r of conflict.variants)if(r.core.value.kind==='file')assert(await a.engine.readVersion(r.id));
  const hash=await hashBytes(bytes('edited')),chosen=conflict.variants.find(r=>r.core.value.kind==='file'&&r.core.value.hash===hash)!;
  await a.engine.resolveConflict({fileId:conflict.fileId,reviewedIds:conflict.variants.map(r=>r.id),choice:{kind:'variant',revisionId:chosen.id}});
  for(const p of peers)await p.engine.run();for(const p of peers){assert.equal(await p.vault.read('image.bin'),'edited');assert.equal((await p.engine.conflicts()).length,0);await p.close();}
});

test('a local rename cycle preserves originals and an explicit free-path resolution completes its old obligations',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','A');a.vault.seed('b.md','B');await a.engine.run();const b=await clientV2(remote);await b.engine.run();
  for(const[from,to,generation]of[['a.md','temporary.md',1],['b.md','a.md',2],['temporary.md','b.md',3]]as const){await b.vault.vault.rename(b.vault.vault.getAbstractFileByPath(from)!,to);await b.state.recordDirtyEvent({kind:'rename',from,path:to,generation});}
  await b.engine.run();const pending=await a.engine.run();assert(pending.pending.some(p=>p.code==='Collision'));assert.equal(await a.vault.read('a.md'),'A');assert.equal(await a.vault.read('b.md'),'B');
  const heads=Object.values((await a.engine.currentView()).headsByFile).map(r=>r[0]),hashA=await hashBytes(bytes('A'));
  const rows=await Promise.all(heads.map(async r=>({fileId:r.core.fileId,reviewedIds:[r.id],choice:{kind:'edit' as const,path:r.core.value.kind==='file'&&r.core.value.hash===hashA?'spare.md':'a.md',bytes:await a.engine.readVersion(r.id)}})));
  const result=await a.engine.resolvePaths(rows);assert.equal(result.state,'clean');assert.equal(await a.vault.read('spare.md'),'A');assert.equal(await a.vault.read('a.md'),'B');assert.equal((await a.state.outbox()).length,0);await a.close();await b.close();
});

test('binary A-B-A-B transitions keep distinct recovery intents and preserve prior bodies',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('image.bin','A');await a.engine.run();const b=await clientV2(remote);await b.engine.run();const ids=new Set(Object.values(await a.state.appliedFiles())[0].revisionIds);
  for(const value of['B','A','B']){a.vault.seed('image.bin',value);assert.equal((await a.engine.run()).state,'clean');assert.equal((await b.engine.run()).state,'clean');assert.equal(await b.vault.read('image.bin'),value);for(const id of Object.values(await a.state.appliedFiles())[0].revisionIds)ids.add(id);}
  assert.equal(ids.size,4);assert.equal(Object.keys(await b.state.listMeta('local-effect:')).length,3);await a.close();await b.close();
});

test('generated shuffled prefixes, packs and duplicates have the same final semantic view',async()=>{
  for(let seed=1;seed<=12;seed++) {
    let random=seed;const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
    const events:EventRecord[]=[],known:Revision[][]=[[],[],[]];
    for(let n=0;n<45;n++){const file=next()%3,parents=known[file].length?[known[file][next()%known[file].length].id]:[];
      const r=await rev('f'+file,'v'+n,parents,undefined,'file'+file+'.md');known[file].push(r);events.push(await evt([r],'actor'+(next()%3)));}
    const raw=await recorded(events),baseline=createHistoryIndex('repo');await ingestContainers(baseline,raw);
    const sources=[...new Map(raw.flatMap(c=>c.decoded.sources).map(s=>[s.hash,s])).values()],data=canonicalBytes({schema:2,repositoryId:'repo',events,sources,dependencies:[],previousSources:[]}),hash=await hashBytes(data.buffer);
    const pack={slot:{path:'.webdav-sync-v2/repos/repo/journal/pack/0/seg/copy.'+hash+'.json',hash,size:data.byteLength},decoded:await decodeContainer(data,hash,'repo')};
    const delivery=[...raw,pack,...raw.slice(0,10)];for(let n=delivery.length-1;n>0;n--){const i=next()%(n+1);[delivery[i],delivery[n]]=[delivery[n],delivery[i]];}
    const index=createHistoryIndex('repo');for(const copy of delivery){await ingestContainers(index,[copy]);for(const r of index.revisions.values())assert(r.core.parents.every(p=>index.revisions.has(p)));}
    assert.equal((await reduceHistory(index)).fingerprint,(await reduceHistory(baseline)).fingerprint,'seed '+seed);
  }
});
