import type {RepositoryV2} from './repository.ts';
import {openRepositoryV2} from './repository.ts';
import {openStateV2} from './state.ts';
import type {StateV2} from './state.ts';
import type {DavV2} from './transport.ts';
import type {LocalSnapshot} from './types.ts';
import {createHistoryIndex,reduceHistory} from './v2-history.ts';
import {discover} from './v2-discovery.ts';
import {createEngineV2} from './engine.ts';
import {createProjectionV2} from './projection.ts';
export async function importIntoV2(repository:RepositoryV2,active:StateV2,dav:DavV2,
  data:{snapshot:LocalSnapshot;objects:Record<string,ArrayBuffer>;archives?:{path:string;hash:string;size:number}[]},fingerprint:string,factory:IDBFactory=indexedDB) {
  const state=await openStateV2(active.localScope+'-migration',active.targetKey,factory);
  try {
    const repo=await openRepositoryV2(dav,state,{mode:'attach-v2',sessionId:state.sessionId});
    if(repo.repositoryId!==repository.repositoryId)throw Error('Import target changed');
    const index=createHistoryIndex(repo.repositoryId);await discover(repo,index,{mode:'canonical'});const view=await reduceHistory(index);
    const prior=await state.getMeta<string>('migration-fingerprint');
    if(Object.keys(view.headsByFile).length && (prior!==fingerprint || Object.values(view.headsByFile).some(heads=>heads.length!==1 || heads[0].core.value.kind!=='file' || data.snapshot.files[heads[0].core.value.path]?.hash!==heads[0].core.value.hash)))throw Error('Migration target must be empty or exactly match this import');
    await state.setMeta('migration-fingerprint',fingerprint);await state.storeObjects(data.objects);
    const projection=createProjectionV2(repo,dav,state,data.snapshot.policy);
    for(const archive of data.archives??[])await projection.archiveUnknown(archive.path,data.objects[archive.hash],'local-quarantine');
    const engine=createEngineV2({repository:repo,state,projection,local:{snapshot:async()=>data.snapshot,apply:async()=>{throw Error('Import cannot mutate local files');}}});
    return await engine.run();
  }finally{await state.close();}
}
