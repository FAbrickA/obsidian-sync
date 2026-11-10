import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDav } from './helpers/memory-dav.ts';
import { previewLegacy, readLegacyImport } from '../src/migration.ts';
import {previewImportSource} from '../src/migration.ts';
import {initializeV1Fixture as initializeRepository} from './helpers/v1-fixture.ts';
import {canonicalBytes,hashBytes} from '../src/snapshots.ts';
const policy={configDir:'.obsidian',include:[],exclude:['ignored'],bookmarks:true};
test('legacy preview reads only notes attachments and bookmarks without mutating its source',async()=>{
  const r=memoryDav();for(const [p,s]of Object.entries({'n.md':'note','a.bin':'binary','.obsidian/data.json':'secret','.obsidian/bookmarks.json':'{"items":[]}','ignored/n.md':'skip'}))await r.dav.put(p,new TextEncoder().encode(s).buffer,{createOnly:true});
  r.resetCounts();const preview=await previewLegacy(r.dav,policy);assert.deepEqual(preview.files.map(f=>f.path),['@bookmarks.json','a.bin','n.md']);
  assert.equal(r.counts.PUT,0);assert.equal(r.counts.DELETE,0);const data=await readLegacyImport(r.dav,preview,policy);assert.equal(Object.keys(data.snapshot.files).length,3);
  await r.dav.put('n.md',new TextEncoder().encode('changed').buffer,{ifMatch:(await r.dav.read('n.md')).etag!});
  await assert.rejects(readLegacyImport(r.dav,preview,policy),/changed/);
});
test('legacy preview descends through parents of explicitly included folders',async()=>{
  const r=memoryDav();await r.dav.mkdir('a');await r.dav.mkdir('a/b');await r.dav.put('a/b/n.md',new ArrayBuffer(0),{createOnly:true});
  assert.equal((await previewLegacy(r.dav,{...policy,include:['a/b'],bookmarks:false})).files.length,1);
});

test('CAS1 export follows verified canonical history and preserves variants rather than stale projection',async()=>{
  const r=memoryDav(),repo=await initializeRepository(r.dav),head=await repo.readHead();
  const bytes=new TextEncoder().encode('canonical').buffer,hash=await hashBytes(bytes),variant=new TextEncoder().encode('other').buffer,other=await hashBytes(variant);
  await repo.putObject(hash,bytes);await repo.putObject(other,variant);
  const manifest={schema:1 as const,repositoryId:repo.repositoryId,generation:1,parent:head.head.commitId,deviceId:'d',operationId:'edit',entries:{f:{kind:'file' as const,fileId:'f',path:'n.md',hash,size:bytes.byteLength}},conflicts:{c:{fileId:'f',base:null,local:hash,remote:other,reason:'overlap'}}};
  await repo.publish(manifest,head);await r.dav.put('n.md',new TextEncoder().encode('stale').buffer,{createOnly:true});r.resetCounts();
  await assert.rejects(previewLegacy(r.dav,policy),/canonical/i);
  const preview=await previewImportSource(r.dav,policy);assert.equal(preview.kind,'cas1');assert.equal(preview.files[0].hash,hash);assert(preview.archives?.some(a=>a.hash===other));
  const data=await readLegacyImport(r.dav,preview,policy);assert.equal(new TextDecoder().decode(data.objects[hash]),'canonical');assert.equal(new TextDecoder().decode(data.objects[other]),'other');
  assert.equal(r.counts.PUT,0);assert.equal(r.counts.DELETE,0);
  await r.dav.put('.webdav-sync/HEAD',canonicalBytes({...head.head,publishId:'changed'}).buffer,{ifMatch:(await r.dav.read('.webdav-sync/HEAD')).etag!});
  await assert.rejects(readLegacyImport(r.dav,preview,policy),/changed/);
});
