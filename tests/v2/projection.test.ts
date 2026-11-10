import test from 'node:test';
import assert from 'node:assert/strict';
import { noCasDav } from './memory-dav.ts';
import { clientV2 } from './client.ts';
import { createProjectionV2 } from '../../src/projection.ts';
import { bytes } from './fixtures.ts';
const text=(b:ArrayBuffer)=>new TextDecoder().decode(b);
const boundary={id:'test',throughGeneration:0,admittedEventIds:[]};
async function setup(){const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');await a.engine.run();
  const projection=createProjectionV2(a.repository,remote.dav,a.state);return{remote,a,projection,view:await a.engine.currentView()};}
test('projection drift is archived before repair and discoverable by another state',async()=>{
  const{remote,a,projection,view}=await setup();await projection.materialize(view,boundary);remote.files.set('a.md',bytes('external'));
  const result=await projection.materialize(view,boundary,true);assert.deepEqual(result.pendingPaths,['a.md']);assert.equal(text(remote.files.get('a.md')!),'external');
  const archive=(await projection.archives())[0];assert.equal(text(await a.repository.readSlot(archive.blob.slot)),'external');
  const b=await clientV2(remote),fresh=createProjectionV2(b.repository,remote.dav,b.state);assert.equal((await fresh.archives())[0].id,archive.id);
  await projection.resolveDrift(archive.id,'repair-from-canonical');assert.deepEqual((await projection.materialize(view,boundary)).pendingPaths,[]);
  assert.equal(text(remote.files.get('a.md')!),'base');await a.close();await b.close();
});
test('a stale projection writer cannot change canonical history and a current writer repairs it',async()=>{
  const{remote,a,projection,view:old}=await setup();await projection.materialize(old,boundary);a.vault.seed('a.md','new');await a.engine.run();
  const current=await a.engine.currentView(),ids=Object.values(current.headsByFile).flat().map(r=>r.id);
  await projection.materialize(old,boundary);await projection.materialize(current,boundary);
  assert.equal(text(remote.files.get('a.md')!),'new');assert.deepEqual(Object.values((await a.engine.currentView()).headsByFile).flat().map(r=>r.id),ids);await a.close();
});
test('all historical paths of a path-conflicted identity remain untouched',async()=>{
  const{remote,a,projection}=await setup();const b=await clientV2(remote);b.vault.seed('a.md','other');await b.state.setMeta('initial-scan-complete',true);
  await b.state.recordDirtyEvent({kind:'create',path:'a.md',generation:1});await b.engine.run();await a.engine.run();const view=await a.engine.currentView();
  remote.files.set('a.md',bytes('keep'));const result=await projection.materialize(view,boundary,true);
  assert.equal(text(remote.files.get('a.md')!),'keep');assert.equal(result.pendingPaths.length,0);await a.close();await b.close();
});
test('canonical cache bytes repair a lost immutable source before being replaced',async()=>{
  const{remote,a,projection,view}=await setup();await projection.materialize(view,boundary);const old=Object.values(view.headsByFile).flat()[0];
  a.vault.seed('a.md','new');await a.engine.run();const next=await a.engine.currentView();
  remote.files.set('a.md',bytes('base')); // A delayed projection writer restores the old readable cache.
  if(old.core.value.kind!=='file')throw Error('fixture');for(const path of remote.files.keys())if(path.endsWith(`.${old.core.value.hash}.bin`))remote.files.delete(path);
  await projection.materialize(next,boundary,true);assert.equal(text(remote.files.get('a.md')!),'new');
  assert.equal(text((await a.repository.readBlob(old.core.value.hash,old.core.value.size)).bytes),'base');await a.close();
});

test('a fresh client can recover a missing immutable blob from matching readable bytes only',async()=>{
  const{remote,a,view}=await setup(),old=Object.values(view.headsByFile).flat()[0];if(old.core.value.kind!=='file')throw Error('fixture');
  for(const path of remote.files.keys())if(path.endsWith(`.${old.core.value.hash}.bin`))remote.files.delete(path);
  const b=await clientV2(remote);assert.equal((await b.engine.run()).state,'clean');assert.equal(await b.vault.read('a.md'),'base');
  assert.equal(text((await b.repository.readBlob(old.core.value.hash,old.core.value.size)).bytes),'base');await a.close();await b.close();
});

test('an unverified archive write never authorizes overwriting unknown bytes',async()=>{
  const{remote,a,projection,view}=await setup();remote.files.set('a.md',bytes('external'));
  remote.setAfterPut(async path=>{if(path.includes('/archives/')){remote.files.delete(path);throw Error('lost catalog');}});
  const result=await projection.materialize(view,boundary,true);assert(result.pendingPaths.includes('a.md'));assert.equal(text(remote.files.get('a.md')!),'external');
  assert.equal((await projection.archives()).length,0);await a.close();
});

test('integrity walks ancestors of explicitly included folders to find external drift',async()=>{
  const{remote,a,view}=await setup();remote.directories.add('a');remote.directories.add('a/b');remote.files.set('a/b/external.md',bytes('external'));
  const projection=createProjectionV2(a.repository,remote.dav,a.state,{configDir:'.obsidian',include:['a/b'],exclude:[],bookmarks:false});
  assert.deepEqual((await projection.materialize(view,boundary,true)).pendingPaths,['a/b/external.md']);await a.close();
});

test('a settled warm projection avoids unchanged body GETs until its integrity audit',async()=>{
  const{remote,a,projection,view}=await setup();await projection.materialize(view,boundary,true);let reads=0;
  const read=remote.dav.read;remote.dav.read=async path=>{if(path==='a.md')reads++;return read(path);};
  assert.deepEqual((await projection.materialize(view,boundary)).pendingPaths,[]);assert.equal(reads,0);
  await projection.materialize(view,boundary,true);assert.equal(reads,1);await a.close();
});

test('a batch proves a newly created parent once without repeatedly listing its growing contents',async()=>{
  const{remote,a}=await setup();let lists=0;const list=remote.dav.list;remote.dav.list=async path=>{if(path==='folder')lists++;return list(path);};
  a.vault.seed('folder/a.md','A');a.vault.seed('folder/b.md','B');assert.equal((await a.engine.run()).state,'clean');assert.equal(lists,0);await a.close();
});

test('a freshly verified publication supplies projection bytes without a duplicate blob GET',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');let reads=0;const read=remote.dav.read;remote.dav.read=async path=>{if(path.includes('/blobs/'))reads++;return read(path);};
  a.vault.seed('a.md','new');assert.equal((await a.engine.run()).state,'clean');assert.equal(reads,1);await a.close();
});
