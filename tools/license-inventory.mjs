// Include licenses of packages actually embedded in the main bundle or worker.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const metas=await Promise.all(['dist/metafile.json','dist/worker-metafile.json'].map(async f=>JSON.parse(await readFile(f,'utf8'))));
const directories=new Set(metas.flatMap(m=>Object.keys(m.inputs)).filter(p=>p.startsWith('node_modules/')).map(p=>p.split('/').slice(0,p.split('/')[1].startsWith('@')?3:2).join('/')));
const packages=[];
for(const directory of [...directories].sort()){
  const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  const files=(await readdir(directory)).filter(n=>/^(licen[sc]e|copying|notice)(?:[.-]|$)/i.test(n));
  if(!files.length)throw Error('Missing license text: '+pkg.name);
  const texts=await Promise.all(files.map(async f=>({file:f,text:await readFile(path.join(directory,f),'utf8')})));
  packages.push({name:pkg.name,version:pkg.version,license:pkg.license,texts});
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt',packages.map(p=>`${p.name}@${p.version} (${p.license})\n${p.texts.map(t=>`--- ${t.file} ---\n${t.text}`).join('\n')}`).join('\n\n'));
await writeFile('dist/license-inventory.json',JSON.stringify(packages.map(({texts,...p})=>({...p,files:texts.map(t=>t.file)})),null,2));
console.log(`License texts included for ${packages.length} bundled runtime packages.`);
