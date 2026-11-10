import test from 'node:test';
import assert from 'node:assert/strict';
import {clientV2} from './client.ts';
import {noCasDav} from './memory-dav.ts';
import {DavError} from '../../src/transport.ts';

test('incomplete canonical listing cannot report clean or bootstrap an unassociated local file',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('remote.md','known');await a.engine.run();const b=await clientV2(remote);b.vault.seed('local.md','local');
  const list=remote.dav.list;remote.dav.list=async path=>{if(path.endsWith('/journal'))throw new DavError('CorruptData');return list(path);};
  const outcome=await b.engine.run();assert.equal(outcome.state,'pending');assert.equal((await b.state.verifiedEvents()).filter(e=>e.core.deviceId===b.state.deviceId).length,0);assert.equal(await b.vault.read('local.md'),'local');
  remote.dav.list=list;assert.equal((await b.engine.run()).state,'clean');assert.equal(await b.vault.read('remote.md'),'known');await a.close();await b.close();
});
test('a native deletion after boundary freeze is neither published nor undone by a download',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','base');await a.engine.run();const b=await clientV2(remote);await b.engine.run();
  a.vault.seed('a.md','remote');await a.engine.run();await b.engine.previewAdoption();const boundary=await b.engine.captureBoundary(0),known=(await b.state.verifiedEvents()).length;
  b.vault.files.delete('a.md');await b.state.recordDirtyEvent({kind:'delete',path:'a.md',generation:1});const result=await b.engine.run(boundary);
  assert.equal(result.state,'pending');assert.equal(b.vault.files.has('a.md'),false);assert.equal((await b.state.verifiedEvents()).length,known);await a.close();await b.close();
});

test('unknown publication retries use fresh immutable URLs and preserve a single logical event',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','body');let drop=true;
  remote.setAfterPut(async path=>{if(drop&&path.includes('/journal/')){remote.files.delete(path);throw new DavError('Transient',500);}});
  assert.equal((await a.engine.run()).state,'pending');await a.close();drop=false;
  const b=await clientV2(remote,'attach-v2',a.factory,a.scope,a.vault);assert.equal((await b.engine.run()).state,'clean');
  const immutable=remote.puts.filter(p=>/\/(blobs|journal|seals|archives)\//.test(p));assert.equal(new Set(immutable).size,immutable.length);assert.equal((await b.state.verifiedEvents()).length,1);await b.close();
});

test('a corrupt physical alias does not poison a positively verified identical container',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');a.vault.seed('a.md','body');let partial=true;
  remote.setAfterPut(async(path,data)=>{if(partial&&path.includes('/journal/')){partial=false;remote.files.set(path,data.slice(0,12));}});
  assert.equal((await a.engine.run()).state,'pending');assert.equal((await a.engine.run()).state,'clean');
  const b=await clientV2(remote);assert.equal((await b.engine.run()).state,'clean');assert.equal(await b.vault.read('a.md'),'body');await a.close();await b.close();
});

test('an orphan external file remains pending until repaired and its archive survives a fresh client',async()=>{
  const remote=noCasDav(),a=await clientV2(remote,'create-v2');remote.files.set('orphan.md',new TextEncoder().encode('external').buffer);
  assert.equal((await a.engine.run(undefined,true)).state,'pending');assert.equal((await a.engine.run()).state,'pending');
  const archive=(await a.projection.archives())[0];assert(archive);assert.equal((await a.engine.resolveDrift(archive.id,'repair-from-canonical')).state,'clean');assert.equal(remote.files.has('orphan.md'),false);
  const b=await clientV2(remote);assert.equal((await b.engine.run()).state,'clean');assert.equal((await b.projection.archives())[0].id,archive.id);await a.close();await b.close();
});
