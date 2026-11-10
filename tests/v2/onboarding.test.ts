import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,validateSettings} from '../../src/settings.ts';
import {clientV2} from './client.ts';
import {noCasDav} from './memory-dav.ts';
import {bytes} from './fixtures.ts';
import {hashBytes} from '../../src/snapshots.ts';
import {importIntoV2} from '../../src/v2-migration.ts';
import {RepositoryErrorV2} from '../../src/repository.ts';
import {DavError} from '../../src/transport.ts';
test('v2 requires explicit onboarding and invalidates v1 verification without discarding useful preferences',()=>{
  const defaults=defaultSettings();assert.equal(defaults.protocol,2);assert.equal(defaults.repositoryMode,'attach-v2');
  const old=validateSettings({...defaults,schema:1,protocol:undefined,root:'old',repositoryId:'v1',verifiedTarget:'old-proof',bookmarks:false});
  assert.equal(old.repositoryId,'');assert.equal(old.verifiedTarget,'');assert.equal(old.repositoryMode,'attach-v2');assert.equal(old.bookmarks,false);
  assert.throws(()=>validateSettings({...defaults,root:'.webdav-sync-v2'}));
});

test('first close after attach discovers existing identities before freezing an adoption boundary',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','same');await a.engine.run();
  const b=await clientV2(remote);b.vault.seed('a.md','same');
  try{
    const boundary=await b.engine.captureBoundary(),closed=await b.engine.run(boundary);
    const next=await b.engine.run(),view=await b.engine.currentView();
    assert.equal(Object.keys(view.headsByFile).length,1);assert.deepEqual(view.pathConflicts,[]);
    assert.equal(closed.state,'clean');assert.equal(next.state,'clean');assert.equal(await b.vault.read('a.md'),'same');
  }finally{await a.close();await b.close();}
});

test('an incomplete first discovery cannot freeze adoption and is retried before initial close',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','same');await a.engine.run();
  const b=await clientV2(remote);b.vault.seed('a.md','same');let scans=0;
  remote.setBeforeList(async path=>{if(path.endsWith('/journal')){scans++;throw new RepositoryErrorV2('Incomplete');}});
  try{
    await assert.rejects(b.engine.captureBoundary(),{code:'Incomplete'});
    remote.setBeforeList(async path=>{if(path.endsWith('/journal'))scans++;});
    const boundary=await b.engine.captureBoundary();assert(scans>=2);assert(boundary.admittedEventIds.length>0);
    assert.equal((await b.engine.run(boundary)).state,'clean');assert.equal(Object.keys((await b.engine.currentView()).headsByFile).length,1);
  }finally{remote.setBeforeList();await a.close();await b.close();}
});

test('initial close repairs its own interrupted publication before requiring complete discovery',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','recover this');let interrupted=false;
  remote.setAfterPut(async path=>{if(!interrupted&&path.includes('/journal/')){interrupted=true;remote.files.set(path,bytes('partial'));throw new DavError('UnknownWrite',0);}});
  assert.notEqual((await a.engine.run()).state,'clean');assert(interrupted);await a.close();remote.setAfterPut();
  const b=await clientV2(remote,'attach-v2',a.factory,a.scope,a.vault);
  try{
    const boundary=await b.engine.captureBoundary();assert.equal((await b.engine.run(boundary)).state,'clean');
    assert.equal((await b.state.outbox()).length,0);assert.equal((await b.state.verifiedEvents()).length,1);assert.equal(await b.vault.read('a.md'),'recover this');
  }finally{await b.close();}
});

test('import uses a separate baseline, leaves local notes untouched and rejects a changed target',async()=>{
  const remote=noCasDav(),c=await clientV2(remote,'create-v2');c.vault.seed('unrelated.md','local only');
  const hash=await hashBytes(bytes('imported')),data={snapshot:{files:{'import.md':{path:'import.md',hash,size:8}},complete:true,excluded:[],policy:c.policy},objects:{[hash]:bytes('imported')}};
  assert.equal((await importIntoV2(c.repository,c.state,remote.dav,data,'source',c.factory)).state,'clean');
  assert.equal(await c.vault.read('unrelated.md'),'local only');assert.equal(c.vault.files.has('import.md'),false);
  assert.deepEqual(await c.state.appliedFiles(),{});await c.engine.run();assert.equal(await c.vault.read('import.md'),'imported');
  await assert.rejects(importIntoV2(c.repository,c.state,remote.dav,data,'different',c.factory),/empty/);await c.close();
});
