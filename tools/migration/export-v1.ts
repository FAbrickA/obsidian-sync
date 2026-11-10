// Explicit read-only source export. Never invoked automatically by the plugin.
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {previewImportSource,readLegacyImport} from '../../src/migration.ts';
import type {ImportSource} from '../../src/migration.ts';
import type {PathPolicy} from '../../src/types.ts';
import {createNativeDav} from '../../src/transport.ts';
import type {DavConfig} from '../../src/transport.ts';
import {DOMParser} from '@xmldom/xmldom';

export async function exportRepository(source:ImportSource,policy:PathPolicy,destination:string) {
  const preview=await previewImportSource(source,policy),data=await readLegacyImport(source,preview,policy),output=path.resolve(destination);
  // Validate the complete source before creating any output, and refuse an existing destination.
  await mkdir(output,{recursive:false});
  const write=async(relative:string,bytes:ArrayBuffer|string)=>{
    const target=path.resolve(output,relative);if(!target.startsWith(output+path.sep))throw Error('Unsafe export path');
    await mkdir(path.dirname(target),{recursive:true});await writeFile(target,typeof bytes==='string'?bytes:new Uint8Array(bytes),{flag:'wx'});
  };
  await write('INCOMPLETE.json',JSON.stringify({purpose:'webdav-sync-read-only-export',complete:false}));
  for(const f of preview.files)await write('current/'+f.path,data.objects[f.hash]);
  const originals=data.archives??[];for(const hash of new Set(originals.map(f=>f.hash)))await write('originals/'+hash+'.bin',data.objects[hash]);
  await write('index.json',JSON.stringify({schema:1,complete:true,sourceKind:preview.kind??'plain',sourceCommit:preview.sourceCommit??null,fingerprint:preview.fingerprint,
    current:preview.files.map(f=>({path:f.path,hash:f.hash,size:f.size,file:'current/'+f.path})),originals:originals.map(f=>({...f,file:'originals/'+f.hash+'.bin'}))},null,2));
  await unlink(path.join(output,'INCOMPLETE.json'));
  return{exported:true,files:preview.files.length,originals:originals.length,fingerprint:preview.fingerprint};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  let config:DavConfig|undefined;
  try{
    try{config=JSON.parse(process.env.WEBDAV_EXPORT_CONFIG??'') as DavConfig;}finally{delete process.env.WEBDAV_EXPORT_CONFIG;}
    const position=process.argv.indexOf('--out'),destination=position<0?undefined:process.argv[position+1];if(!destination||!config.root)throw Error('Explicit export destination/source required');
    Object.defineProperty(globalThis,'DOMParser',{value:DOMParser,configurable:true});
    const endpoint=new URL(config.endpoint),base=new URL(endpoint);base.pathname=base.pathname.replace(/\/+$/,'')+'/'+config.root.split('/').map(encodeURIComponent).join('/')+'/';
    const dav=createNativeDav(config,async options=>{const u=new URL(options.url);if(u.origin!==endpoint.origin||!u.pathname.startsWith(base.pathname))throw Error('Scope');
      const r=await fetch(u,{method:options.method,headers:options.headers,body:options.body as BodyInit|undefined,redirect:'error',signal:AbortSignal.timeout(30_000)});
      return{status:r.status,headers:Object.fromEntries(r.headers),arrayBuffer:await r.arrayBuffer(),text:'',json:null};});
    try{console.log(JSON.stringify(await exportRepository({read:dav.read,list:dav.list},{configDir:'.obsidian',include:[],exclude:[],bookmarks:true},destination)));}finally{dav.dispose();}
  }catch{console.error('Export not completed. No source writes are performed. Use a new output directory and verify the source configuration.');process.exitCode=1;}
  finally{config=undefined;}
}
