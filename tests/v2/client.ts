import { IDBFactory } from 'fake-indexeddb';
import { openStateV2 } from '../../src/state.ts';
import { openRepositoryV2 } from '../../src/repository.ts';
import { createEngineV2 } from '../../src/engine.ts';
import { createVaultAccess } from '../../src/vault.ts';
import { createProjectionV2 } from '../../src/projection.ts';
import { memoryVault } from '../helpers/memory-vault.ts';
import type { noCasDav } from './memory-dav.ts';
export async function clientV2(remote:Pick<ReturnType<typeof noCasDav>,'dav'>,mode:'create-v2'|'attach-v2'='attach-v2',
  factory=new IDBFactory(),scope=crypto.randomUUID(),vault=memoryVault(),bookmarks=false) {
  const state=await openStateV2(scope,'target',factory);if(mode==='create-v2')await state.ensureBootstrapIntent('repo');
  const repository=await openRepositoryV2(remote.dav,state,{mode,sessionId:state.sessionId}).catch(async error=>{await state.close();throw error;});
  const policy={configDir:'.obsidian',include:[],exclude:[],bookmarks};
  // Data-only bookmark fixture. Native Obsidian bridge is validated separately in host gates.
  let bookmarkData:unknown={items:[]};const reload=async()=>{const file=vault.files.get('.obsidian/bookmarks.json');bookmarkData=file?JSON.parse(new TextDecoder().decode(file.bytes)):{items:[]};};
  const bookmarkHost=bookmarks?{flush:reload,reload,snapshot:()=>structuredClone(bookmarkData),onChanged:()=>()=>{},settled:async()=>{},dispose(){}}:null;
  const local=createVaultAccess(vault.vault,policy,state,bookmarkHost);
  const projection=createProjectionV2(repository,remote.dav,state,policy);
  const engine=createEngineV2({repository,state,local,projection,deletionGuardPercent:100});
  return{state,repository,vault,local,projection,engine,factory,scope,policy,async close(){await state.close()}};
}
