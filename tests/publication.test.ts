import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {preparePublicSnapshot} from '../tools/publication/prepare-public.ts';

async function fixture(){
  const base=path.resolve('.lab/publication-tests'),root=path.join(base,crypto.randomUUID());await mkdir(root,{recursive:true});
  await mkdir(path.join(root,'src'));await writeFile(path.join(root,'README.md'),'Public project');await writeFile(path.join(root,'src/main.ts'),'export const version=1;');
  await writeFile(path.join(root,'.public-files.json'),JSON.stringify(['README.md','src/main.ts','.public-files.json']));
  const destination=path.join(root,'.lab/publication/output');
  return{root,destination,async close(){if(!root.startsWith(base+path.sep))throw Error('Unexpected fixture');await rm(root,{recursive:true,force:true});}};
}
test('public snapshot includes only the explicit inventory and refuses overwriting an existing checkout',async()=>{
  const f=await fixture();try{
    await mkdir(path.join(f.root,'.lab/secrets'),{recursive:true});await writeFile(path.join(f.root,'.lab/secrets/private.env'),'private');
    await mkdir(path.join(f.root,'docs'));await writeFile(path.join(f.root,'docs/internal.md'),'internal');
    const result=await preparePublicSnapshot(f.root,f.destination);assert.equal(result.files.length,3);
    assert.deepEqual((await readdir(f.destination)).sort(),['.public-files.json','README.md','src']);
    assert.equal(await readFile(path.join(f.destination,'src/main.ts'),'utf8'),'export const version=1;');
    await assert.rejects(preparePublicSnapshot(f.root,f.destination),{code:'EEXIST'});
  }finally{await f.close();}
});
test('public snapshot rejects traversal, private files and credential material before writing output',async()=>{
  for(const item of ['../private','.lab/secrets/private.env','.git/config']){
    const f=await fixture();try{await writeFile(path.join(f.root,'.public-files.json'),JSON.stringify([item]));await assert.rejects(preparePublicSnapshot(f.root,f.destination),/Forbidden/);await assert.rejects(readdir(f.destination));}finally{await f.close();}
  }
  const f=await fixture();try{
    await writeFile(path.join(f.root,'README.md'),'token '+'ghp_'+'x'.repeat(40));
    await assert.rejects(preparePublicSnapshot(f.root,f.destination),/Sensitive content in README.md/);await assert.rejects(readdir(f.destination));
  }finally{await f.close();}
});
