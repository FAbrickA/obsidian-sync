import { DavError } from './transport.ts';
import type { DavV2 } from './transport.ts';
import type { StateV2 } from './state.ts';
import { RepositoryErrorV2 } from './repository.ts';
import type { RepositoryV2 } from './repository.ts';
import type { ArchiveRefV2, ArchiveRecordV2, SlotRef, Revision, RemoteViewV2, RunBoundaryV2, ProjectionResultV2 } from './v2-types.ts';
import type { PathPolicy } from './types.ts';
import { canonicalBytes, hashBytes } from './snapshots.ts';
import { classifyPath, isWithinPath, normalizeRelativePath } from './paths.ts';
import { decodeArchive, validateSlot } from './v2-codec.ts';
import {mapLimit} from './queue.ts';

type Drift = {id:string;path:string;hash:string;resolved:boolean};
type Cache = {known:Record<string,string|null>;drifts:Record<string,Drift>;approvals:Record<string,string>;initialized:boolean};
export function createProjectionV2(repository:RepositoryV2,dav:DavV2,state:StateV2,
  policy:PathPolicy={configDir:'.obsidian',include:[],exclude:[],bookmarks:true}) {
  const absent=(e:unknown)=>e instanceof DavError && e.kind==='NotFound';
  const load=async():Promise<Cache>=>await state.getMeta<Cache>('projection-v2') ?? {known:{},drifts:{},approvals:{},initialized:false};
  const save=(s:Cache)=>state.setMeta('projection-v2',s);
  async function read(path:string) {try{return(await dav.read(path)).bytes;}catch(e){if(!absent(e))throw e;return null;}}
  async function parents(path:string,verified=new Map<string,Promise<void>>()) {
    const parts=path.split('/');for(let i=1;i<parts.length;i++) {const p=parts.slice(0,i).join('/');
      let proof=verified.get(p);if(!proof){proof=(async()=>{try{await dav.mkdir(p);}catch(e){if(e instanceof DavError && ['Auth','Permission','RateLimited','Transient'].includes(e.kind))throw e;await dav.list(p);}})();verified.set(p,proof);}await proof;}
  }
  async function fresh(kind:'archive'|'blob',bytes:ArrayBuffer):Promise<SlotRef> {
    await repository.assertIdentity();const a=await state.reserveAttempt(kind,bytes,{repositoryId:repository.repositoryId});
    await parents(a.slot.path);await state.claimIssued(a.attemptId);let verified=false;
    try {try{await dav.put(a.slot.path,a.bytes);}catch{/* An HTTP error cannot prove the write had no effect. */}
      await repository.readSlot(a.slot);verified=true;return a.slot;
    }finally{await state.settleAttempt(a.attemptId,verified);}
  }
  async function archives():Promise<ArchiveRefV2[]> {
    let entries;try{entries=await dav.list(repository.prefix+'/archives');}catch(e){if(absent(e))return[];throw e;}
    const values=new Map<string,ArchiveRefV2>();
    for(const entry of entries) {
      const match=/\.([a-f0-9]{64})\.json$/.exec(entry.path);if(entry.kind!=='file'||!match)throw new RepositoryErrorV2('Corrupt');
      const slot=validateSlot({path:entry.path,hash:match[1],size:entry.size},repository.repositoryId,'archives');
      const record=await decodeArchive(await repository.readSlot(slot),repository.repositoryId);
      // An archive is recoverable only if a positive, hash-verified body source exists.
      try{await repository.readSlot(record.blob.slot);}catch(e){if(!absent(e))throw e;continue;}
      values.set(record.id,{id:record.id,path:record.path,hash:record.hash,size:record.size,origin:record.origin,blob:record.blob,slot});
    }
    return [...values.values()].sort((a,b)=>a.id.localeCompare(b.id));
  }
  async function archiveUnknown(path:string,bytes:ArrayBuffer,origin:ArchiveRefV2['origin']):Promise<ArchiveRefV2> {
    normalizeRelativePath(path);const data=bytes.slice(0),hash=await hashBytes(data),size=data.byteLength;
    const core={schema:2 as const,repositoryId:repository.repositoryId,path,hash,size,origin},id=await hashBytes(canonicalBytes(core).buffer);
    const cached=await state.getMeta<ArchiveRefV2>('archive:'+id);
    if(cached){try{await repository.readSlot(cached.slot);await repository.readSlot(cached.blob.slot);return cached;}catch(e){if(e instanceof DOMException)throw e;}}
    await state.storeObjects({[hash]:data});const blob={hash,size,slot:await fresh('blob',data)};
    const record:ArchiveRecordV2={...core,id,blob},slot=await fresh('archive',canonicalBytes(record).buffer),ref={id,path,hash,size,origin,blob,slot};
    await state.setMeta('archive:'+id,ref);return ref;
  }
  async function canonicalBytesFor(revision:Revision,verified?:ReadonlySet<string>):Promise<ArrayBuffer> {
    const value=revision.core.value;if(value.kind!=='file')throw new Error('Deleted version.');
    if(verified?.has(value.hash)){try{const bytes=await state.readObject(value.hash);if(bytes.byteLength===value.size)return bytes;}catch(e){if(e instanceof DOMException)throw e;}}
    try{return(await repository.readBlob(value.hash,value.size)).bytes;}catch(e){if(!(e instanceof RepositoryErrorV2 && e.code==='Incomplete'))throw e;}
    let bytes:ArrayBuffer|null=null;
    try{bytes=await state.readObject(value.hash);}catch(e){if(e instanceof DOMException)throw e;}
    if(!bytes)bytes=await read(value.path);
    if(!bytes || bytes.byteLength!==value.size || await hashBytes(bytes)!==value.hash)throw new RepositoryErrorV2('Incomplete');
    const event=(await state.verifiedEvents()).find(e=>e.core.revisions.some(r=>r.id===revision.id));if(!event)throw new RepositoryErrorV2('Incomplete');
    await state.storeObjects({[value.hash]:bytes});await repository.repairSources(event.id,{[value.hash]:bytes});return bytes;
  }
  async function materialize(view:RemoteViewV2,_boundary:RunBoundaryV2,integrity=false,verifiedBodies?:ReadonlySet<string>):Promise<ProjectionResultV2> {
    await repository.assertIdentity();const cache=await load(),result:ProjectionResultV2={checkedFingerprint:view.fingerprint,pendingPaths:[],issues:[],followUpRemote:false};
    const conflicts=new Set([...view.pathConflicts.flatMap(c=>c.fileIds),...view.conflicts.map(c=>c.fileId)]);
    const protectedPaths=Object.values(view.pathHistory).flat().filter(r=>conflicts.has(r.fileId)).map(r=>r.path);
    const protectedPath=(path:string)=>protectedPaths.some(p=>isWithinPath(path,p)||isWithinPath(p,path));
    const desired=new Map<string,Revision>(),paths=new Set([...Object.keys(cache.known),...Object.values(cache.drifts).filter(d=>!d.resolved).map(d=>d.path)]);
    const revisions=(await state.verifiedEvents()).flatMap(e=>e.core.revisions);
    const verifiedParents=new Map<string,Promise<void>>();
    for(const heads of Object.values(view.headsByFile))for(const r of heads){paths.add(r.core.value.path);
      if(heads.every(h=>h.core.value.kind===r.core.value.kind && h.core.value.path===r.core.value.path && (h.core.value.kind==='tombstone'||r.core.value.kind==='file'&&h.core.value.hash===r.core.value.hash)) && r.core.value.kind==='file')desired.set(r.core.value.path,r);}
    for(const claims of Object.values(view.pathHistory))for(const c of claims)paths.add(c.path);
    if(integrity||!cache.initialized) {
      const pending=[''];while(pending.length){const parent=pending.pop()!;
        for(const entry of await dav.list(parent)) {normalizeRelativePath(entry.path);
          const ancestor=entry.kind==='directory'&&policy.include.some(p=>isWithinPath(p,entry.path));
          if(classifyPath(entry.path,ancestor?{...policy,include:[]}:policy)==='exclude')continue;
          if(entry.kind==='directory')pending.push(entry.path);else paths.add(entry.path);}}
    }
    // Preserve all content-conflicted paths as well, until an explicit semantic resolution exists.
    for(const c of view.conflicts)for(const r of view.headsByFile[c.fileId]??[])protectedPaths.push(r.core.value.path);
    await mapLimit([...paths].sort(),repository.concurrency,async path=>{
      if(classifyPath(path,policy)==='exclude'||protectedPath(path))return;
      const desiredValue=desired.get(path)?.core.value,desiredHash=desiredValue?.kind==='file'?desiredValue.hash:null;
      if(!integrity&&cache.initialized&&Object.prototype.hasOwnProperty.call(cache.known,path)&&cache.known[path]===desiredHash
        && !Object.values(cache.drifts).some(d=>d.path===path&&!d.resolved))return;
      try {
        const wanted=desired.get(path),value=wanted?.core.value,observed=await read(path),hash=observed?await hashBytes(observed):null;
        if(value?.kind==='file'&&hash===value.hash){cache.known[path]=hash;delete cache.approvals[path];for(const d of Object.values(cache.drifts))if(d.path===path)d.resolved=true;return;}
        if(observed){
          const known=revisions.find(r=>r.core.value.kind==='file'&&r.core.value.path===path&&r.core.value.hash===hash&&r.core.value.size===observed.byteLength);
          if(known)await canonicalBytesFor(known,verifiedBodies);
          else {
            const archive=await archiveUnknown(path,observed,'projection-drift');cache.drifts[archive.id]={id:archive.id,path,hash:archive.hash,resolved:false};await save(cache);
            if(cache.approvals[path]!==hash){result.pendingPaths.push(path);return;}
          }
        }
        if(wanted&&value?.kind==='file'){const bytes=await canonicalBytesFor(wanted,verifiedBodies);await parents(path,verifiedParents);await dav.put(path,bytes);}
        else if(observed)await dav.remove(path);
        const after=await read(path);
        if(value?.kind==='file'? !after||await hashBytes(after)!==value.hash:!!after){result.pendingPaths.push(path);return;}
        cache.known[path]=value?.kind==='file'?value.hash:null;delete cache.approvals[path];
        for(const drift of Object.values(cache.drifts))if(drift.path===path)drift.resolved=true;
      } catch(e) {
        if(e instanceof DOMException || e instanceof DavError && ['Auth','Permission'].includes(e.kind))throw e;
        result.pendingPaths.push(path);result.issues.push({kind:'projection',code:e instanceof RepositoryErrorV2?e.code:'Network',relatedIds:[path]});
      }
    });
    result.pendingPaths.sort();
    cache.initialized=true;await save(cache);return result;
  }
  return {materialize,archiveUnknown,archives,readCanonicalBytes:canonicalBytesFor,
    async drifts(){return Object.values((await load()).drifts).filter(d=>!d.resolved);},
    async resolveDrift(id:string,choice:'import-as-edit'|'repair-from-canonical') {
      const ref=(await archives()).find(a=>a.id===id);if(!ref)throw new RepositoryErrorV2('Incomplete');
      if(choice==='import-as-edit')return{archive:ref,bytes:await repository.readSlot(ref.blob.slot)};
      const cache=await load();cache.approvals[ref.path]=ref.hash;await save(cache);return null;
    },
  };
}
