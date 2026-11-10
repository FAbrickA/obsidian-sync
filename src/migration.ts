import type { DavEntry } from './transport.ts';
import { DavError } from './transport.ts';
import type { PathPolicy, LocalSnapshot } from './types.ts';
import { classifyPath, normalizeRelativePath, bookmarksKey, assertPortablePaths, isWithinPath } from './paths.ts';
import { canonicalBytes, hashBytes, validHash } from './snapshots.ts';
import {validateManifest,encodeManifest} from './v1-format.ts';
import type {Head,Manifest} from './v1-format.ts';
import { mergeBookmarks } from './bookmarks.ts';
export type MigrationPreview = { files: { path:string; sourcePath:string; hash:string; size:number }[]; bytes:number; fingerprint:string;
  kind?:'plain'|'cas1'; archives?:{path:string;hash:string;size:number}[]; sourceCommit?:string };
export type ImportSource={read(path:string):Promise<{bytes:ArrayBuffer}>;list(path:string):Promise<DavEntry[]>};
async function scan(source:ImportSource,policy:PathPolicy,canonicalExport=false) {
  const files:MigrationPreview['files']=[];const objects:Record<string,ArrayBuffer>={};const visited=new Set<string>();
  const read=async(sourcePath:string,path:string)=>{
    const bytes=(await source.read(sourcePath)).bytes;
    if(path===bookmarksKey&&mergeBookmarks(null,bytes,bytes).kind!=='clean')throw Error('Unsupported legacy bookmarks');
    const hash=await hashBytes(bytes);objects[hash]=bytes;files.push({path,sourcePath,hash,size:bytes.byteLength});
  };
  const walk=async(path:string,depth:number)=>{
    if(depth>64||visited.has(path))throw Error('Invalid legacy tree');visited.add(path);
    for(const entry of await source.list(path)) {
      normalizeRelativePath(entry.path);
      if(entry.path==='.webdav-sync-v2')throw Error('A v2 source requires a dedicated canonical export');
      if(entry.path==='.webdav-sync'&&!canonicalExport)throw Error('CAS1 metadata requires canonical export');
      if(entry.path===bookmarksKey) {if(!canonicalExport)throw Error('Reserved logical path in legacy tree');if(policy.bookmarks)await read(entry.path,bookmarksKey);continue;}
      const parent=entry.kind==='directory'&&policy.include.some(p=>isWithinPath(p,entry.path));
      if(classifyPath(entry.path,parent?{...policy,include:[]}:policy)!=='sync')continue;
      if(entry.kind==='directory')await walk(entry.path,depth+1);else await read(entry.path,entry.path);
    }
  };
  await walk('',0);
  if(policy.bookmarks&&!files.some(f=>f.path===bookmarksKey))try{await read(`${policy.configDir}/bookmarks.json`,bookmarksKey);}catch(e){if(!(e instanceof DavError&&e.kind==='NotFound'))throw e;}
  assertPortablePaths(files.map(f=>f.path));files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const preview:MigrationPreview={files,bytes:files.reduce((n,f)=>n+f.size,0),fingerprint:await hashBytes(canonicalBytes(files).buffer)};
  return{preview,objects};
}
// Both calls are read-only. Source writers must be stopped; no multi-file DAV snapshot exists.
export async function previewLegacy(source:ImportSource,policy:PathPolicy):Promise<MigrationPreview>{return(await scan(source,policy)).preview;}
async function exportCanonical(source:ImportSource,policy:PathPolicy) {
  const parse=(b:ArrayBuffer)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
  const marker=parse((await source.read('.webdav-sync/repository.json')).bytes);
  if(!marker || Object.keys(marker).sort().join(',')!=='repositoryId,schema' || marker.schema!==1 || typeof marker.repositoryId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(marker.repositoryId))throw Error('Invalid CAS1 repository');
  const headBytes=(await source.read('.webdav-sync/HEAD')).bytes,head=parse(headBytes) as Head;
  if(!head || Object.keys(head).sort().join(',')!=='commitId,generation,publishId,repositoryId,schema' || head.schema!==1 || head.repositoryId!==marker.repositoryId || !validHash(head.commitId) || !Number.isSafeInteger(head.generation)||head.generation<0 || !/^[a-zA-Z0-9_-]{1,128}$/.test(head.publishId))throw Error('Invalid CAS1 HEAD');
  const objects:Record<string,ArrayBuffer>={},archives=new Map<string,{path:string;hash:string;size:number}>(),files:MigrationPreview['files']=[];
  const selected=(path:string)=>classifyPath(path,policy)!=='exclude';
  async function body(path:string,hash:string,size?:number) {
    normalizeRelativePath(path);if(!validHash(hash))throw Error('Invalid CAS1 body reference');
    const bytes=objects[hash]??(await source.read('.webdav-sync/objects/'+hash)).bytes;
    if(await hashBytes(bytes)!==hash || size!==undefined&&bytes.byteLength!==size)throw Error('CAS1 body hash/size mismatch');
    objects[hash]=bytes;archives.set(path+'\0'+hash,{path,hash,size:bytes.byteLength});return bytes;
  }
  const seen=new Set<string>();let id:string|null=head.commitId,generation=head.generation,first=true;
  while(id){
    if(seen.has(id))throw Error('Cyclic CAS1 history');seen.add(id);
    const bytes=(await source.read('.webdav-sync/manifests/'+id)).bytes,manifest:Manifest=validateManifest(bytes,head.repositoryId);
    if(await hashBytes(bytes)!==id || await hashBytes(encodeManifest(manifest).buffer)!==id || manifest.generation!==generation--)throw Error('Invalid CAS1 canonical ancestry');
    for(const entry of Object.values(manifest.entries))if(selected(entry.path)) {
      const hash=entry.kind==='file'?entry.hash:entry.lastHash;await body(entry.path,hash,entry.kind==='file'?entry.size:undefined);
      if(first&&entry.kind==='file')files.push({path:entry.path,sourcePath:'.webdav-sync/objects/'+hash,hash,size:entry.size});
    }
    for(const conflict of [...Object.values(manifest.conflicts),...Object.values(manifest.resolutions??{})]) {
      const entry=manifest.entries[conflict.fileId];
      for(const side of ['base','local','remote']as const){const hash=conflict[side],path=conflict[`${side}Path`]??entry.path;if(hash&&selected(path))await body(path,hash);}
      const chosen=(conflict as {chosen?:string|null}).chosen;if(chosen&&selected(entry.path))await body(entry.path,chosen);
    }
    first=false;id=manifest.parent;
  }
  if(generation!==-1)throw Error('Incomplete CAS1 ancestry');
  for(const dir of ['drifts','versions']) {
    let entries;try{entries=await source.list('.webdav-sync/'+dir);}catch(e){if(!(e instanceof DavError&&e.kind==='NotFound'))throw e;continue;}
    for(const entry of entries){if(entry.kind!=='file')throw Error('Invalid CAS1 archive');const bytes=(await source.read(entry.path)).bytes,hash=await hashBytes(bytes),record=parse(bytes);
      const name=entry.path.split('/').pop()!;if(dir==='drifts'?name!==hash:!name.endsWith('-'+hash))throw Error('Invalid CAS1 archive hash');
      if(!record||record.schema!==1||record.repositoryId!==head.repositoryId||typeof record.path!=='string'||!validHash(record.hash))throw Error('Invalid CAS1 archive record');
      const expected=dir==='drifts'?'hash,path,repositoryId,schema':'fileId,hash,path,repositoryId,schema';if(Object.keys(record).sort().join(',')!==expected)throw Error('Invalid CAS1 archive fields');
      if(selected(record.path))await body(record.path,record.hash);
    }
  }
  // Unknown readable bytes are preserved separately, never substituted for canonical entries.
  const plain=await scan(source,policy,true);Object.assign(objects,plain.objects);
  for(const f of plain.preview.files)archives.set(f.path+'\0'+f.hash,{path:f.path,hash:f.hash,size:f.size});
  files.sort((a,b)=>a.path.localeCompare(b.path,'en'));assertPortablePaths(files.map(f=>f.path));
  const preserved=[...archives.values()].sort((a,b)=>(a.path+a.hash).localeCompare(b.path+b.hash));
  const fingerprint=await hashBytes(canonicalBytes({head:await hashBytes(headBytes),files,archives:preserved}).buffer);
  if(await hashBytes((await source.read('.webdav-sync/HEAD')).bytes)!==await hashBytes(headBytes))throw Error('CAS1 source changed during export');
  return{preview:{kind:'cas1' as const,sourceCommit:head.commitId,files,archives:preserved,bytes:files.reduce((n,f)=>n+f.size,0),fingerprint},objects};
}
async function scanImport(source:ImportSource,policy:PathPolicy) {
  const root=await source.list('');
  if(root.some(e=>e.path==='.webdav-sync-v2'))throw Error('A v2 source requires a dedicated canonical export');
  return root.some(e=>e.path==='.webdav-sync')?exportCanonical(source,policy):scan(source,policy);
}
export async function previewImportSource(source:ImportSource,policy:PathPolicy):Promise<MigrationPreview>{return(await scanImport(source,policy)).preview;}
export async function readLegacyImport(source:ImportSource,preview:MigrationPreview,policy:PathPolicy){
  const read=await scanImport(source,policy);
  if(read.preview.fingerprint!==preview.fingerprint)throw Error('Legacy source changed since preview');
  const snapshot:LocalSnapshot={files:Object.fromEntries(preview.files.map(f=>[f.path,{path:f.path,hash:f.hash,size:f.size}])),excluded:[],complete:true,policy:structuredClone(policy)};
  return{snapshot,objects:read.objects,archives:read.preview.archives};
}
