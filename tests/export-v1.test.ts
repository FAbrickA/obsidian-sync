import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {memoryDav} from './helpers/memory-dav.ts';
import {initializeV1Fixture} from './helpers/v1-fixture.ts';
import {hashBytes} from '../src/snapshots.ts';
import {exportRepository} from '../tools/migration/export-v1.ts';
const policy={configDir:'.obsidian',include:[],exclude:[],bookmarks:false},bytes=(s:string)=>new TextEncoder().encode(s).buffer;
test('disk export uses canonical current bytes, preserves variants, refuses corrupt sources and never mutates source',async()=>{
  const remote=memoryDav(),repo=await initializeV1Fixture(remote.dav),head=await repo.readHead(),hash=await hashBytes(bytes('canonical')),other=await hashBytes(bytes('variant'));
  await repo.putObject(hash,bytes('canonical'));await repo.putObject(other,bytes('variant'));
  await repo.publish({schema:1,repositoryId:repo.repositoryId,generation:1,parent:head.head.commitId,deviceId:'d',operationId:'edit',entries:{f:{kind:'file',fileId:'f',path:'n.md',hash,size:9}},conflicts:{c:{fileId:'f',base:null,local:hash,remote:other,reason:'overlap'}}},head);
  await remote.dav.put('n.md',bytes('stale readable'),{createOnly:true});remote.resetCounts();
  const base=path.resolve('.lab'),directory=path.join(base,'export-test-'+crypto.randomUUID());await mkdir(base,{recursive:true});
  try{
    const result=await exportRepository(remote.dav,policy,directory);assert.equal(result.files,1);assert.equal(await readFile(path.join(directory,'current/n.md'),'utf8'),'canonical');
    const index=JSON.parse(await readFile(path.join(directory,'index.json'),'utf8'));assert(index.complete);assert(index.originals.some((r:{hash:string})=>r.hash===other));assert.equal(await readFile(path.join(directory,'originals',other+'.bin'),'utf8'),'variant');
    await assert.rejects(access(path.join(directory,'INCOMPLETE.json')));
    await assert.rejects(exportRepository(remote.dav,policy,directory),{code:'EEXIST'});assert.equal(remote.counts.PUT,0);assert.equal(remote.counts.DELETE,0);
    await remote.dav.put('.webdav-sync/objects/'+hash,bytes('corrupt'),{ifMatch:(await remote.dav.read('.webdav-sync/objects/'+hash)).etag!});remote.resetCounts();
    await assert.rejects(exportRepository(remote.dav,policy,directory+'-bad'),/hash/);await assert.rejects(access(directory+'-bad'));assert.equal(remote.counts.PUT,0);
  }finally{if(!directory.startsWith(base+path.sep))throw Error('Unexpected test output');await rm(directory,{recursive:true,force:true});}
});
