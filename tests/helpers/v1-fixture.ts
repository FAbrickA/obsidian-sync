// A writer fixture only: production supports v1 exclusively through the read-only export codec.
import type {DavTransport} from '../../tools/lab/legacy-types.ts';
import {canonicalBytes,hashBytes} from '../../src/snapshots.ts';
import type {Head,Manifest} from '../../src/v1-format.ts';
export async function initializeV1Fixture(dav:DavTransport) {
  const repositoryId=crypto.randomUUID(),genesis:Manifest={schema:1,repositoryId,generation:0,parent:null,deviceId:'bootstrap',operationId:'bootstrap',entries:{},conflicts:{}};
  for(const p of['.webdav-sync','.webdav-sync/objects','.webdav-sync/manifests'])await dav.mkdir(p);
  const bytes=canonicalBytes(genesis).buffer,commitId=await hashBytes(bytes),head:Head={schema:1,repositoryId,generation:0,commitId,publishId:'bootstrap'};
  await dav.put('.webdav-sync/repository.json',canonicalBytes({schema:1,repositoryId}).buffer,{createOnly:true});
  await dav.put('.webdav-sync/manifests/'+commitId,bytes,{createOnly:true});await dav.put('.webdav-sync/HEAD',canonicalBytes(head).buffer,{createOnly:true});
  return {repositoryId,
    async readHead(){const read=await dav.read('.webdav-sync/HEAD');return{head:JSON.parse(new TextDecoder().decode(read.bytes)) as Head,etag:read.etag};},
    async putObject(hash:string,data:ArrayBuffer){await dav.put('.webdav-sync/objects/'+hash,data,{createOnly:true});},
    async publish(manifest:Manifest,expected:{head:Head;etag:string|undefined}){const bytes=canonicalBytes(manifest).buffer,commitId=await hashBytes(bytes);
      await dav.put('.webdav-sync/manifests/'+commitId,bytes,{createOnly:true});await dav.put('.webdav-sync/HEAD',canonicalBytes({schema:1,repositoryId,generation:manifest.generation,commitId,publishId:manifest.operationId}).buffer,{ifMatch:expected.etag});},
  };
}
export async function openV1MetaFixture(scope:string,repo:string,factory:IDBFactory) {
  const req=factory.open(`webdav-sync-v1:${encodeURIComponent(scope)}:${encodeURIComponent(repo)}`,1);
  req.onupgradeneeded=()=>{req.result.createObjectStore('meta');};
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  return{async setMeta(key:string,value:unknown){await new Promise<void>((resolve,reject)=>{const t=db.transaction('meta','readwrite');t.objectStore('meta').put(value,key);t.oncomplete=()=>resolve();t.onabort=()=>reject(t.error);});},
    getMeta(key:string){return new Promise<unknown>((resolve,reject)=>{const r=db.transaction('meta').objectStore('meta').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});},close(){db.close();}};
}
