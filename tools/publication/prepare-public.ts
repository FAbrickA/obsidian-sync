// Export a reviewed file inventory, never a working-tree copy or old Git history.
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

export async function preparePublicSnapshot(sourceRoot:string,destination:string){
  const root=path.resolve(sourceRoot),output=path.resolve(destination),allowed=path.join(root,'.lab/publication')+path.sep;
  if(!output.startsWith(allowed))throw Error('Forbidden publication destination');
  const inventory:unknown=JSON.parse(await readFile(path.join(root,'.public-files.json'),'utf8'));
  if(!Array.isArray(inventory)||!inventory.length||new Set(inventory).size!==inventory.length)throw Error('Invalid public inventory');
  const prepared:{path:string;bytes:Buffer;sha256:string}[]=[];
  for(const file of inventory){
    if(typeof file!=='string'||file.startsWith('/')||file.includes('\\')||file.split('/').some(p=>!p||p==='.'||p==='..')
      ||/(?:^|\/)(?:\.git|\.lab|\.codex|\.agents|\.aws|upstream|research|node_modules|dist)(?:\/|$)/.test(file)
      ||/(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:env|pem|pfx|p12))$/i.test(file))throw Error('Forbidden publication path');
    let current=root;for(const component of file.split('/')){current=path.join(current,component);if((await lstat(current)).isSymbolicLink())throw Error('Forbidden symbolic link');}
    const bytes=await readFile(current),text=bytes.toString('utf8');
    if(/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|WEBDAV_CONFIG_DPAPI=[A-Za-z0-9+/]{20,}|[A-Z]:[\\/](?:Users|Documents|Programming)[\\/])/i.test(text))throw Error('Sensitive content in '+file);
    prepared.push({path:file,bytes,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  await mkdir(path.dirname(output),{recursive:true});await mkdir(output,{recursive:false});
  for(const file of prepared){const target=path.join(output,file.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,file.bytes,{flag:'wx'});}
  return{files:prepared.map(({path,sha256})=>({path,sha256}))};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const result=await preparePublicSnapshot(process.cwd(),path.resolve('.lab/publication/obsidian-sync'));
  await writeFile('.lab/publication-audit.json',JSON.stringify(result,null,2));console.log('Public snapshot prepared: '+result.files.length+' reviewed files.');
}
