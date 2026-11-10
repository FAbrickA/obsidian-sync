import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const load=async file=>JSON.parse(await readFile(file,'utf8'));
const manifest=await load('dist/manifest.json');const versions=await load('versions.json');const pkg=await load('package.json');
if(manifest.id!=='webdav-sync-lab'||manifest.version!==pkg.version||versions[manifest.version]!==manifest.minAppVersion||manifest.isDesktopOnly!==false)throw Error('Manifest mismatch');
const metas=await Promise.all(['metafile.json','worker-metafile.json'].map(f=>load('dist/'+f)));
const inputs=new Set(metas.flatMap(meta=>Object.keys(meta.inputs)));
for(const input of inputs){
 if(!input.startsWith('src/')&&!input.startsWith('node_modules/'))throw Error('Non-product source bundled: '+input);
 if(input.startsWith('node_modules/')&&!input.startsWith('node_modules/node-diff3/'))throw Error('Unexpected bundled runtime package: '+input);
}
for(const meta of metas)for(const output of Object.values(meta.outputs))for(const item of output.imports)if(item.external&&item.path!=='obsidian')throw Error('Unexpected external: '+item.path);
if(Object.keys(pkg.dependencies).join(',')!=='node-diff3')throw Error('Unexpected runtime dependencies');
const lock=await load('package-lock.json');if(lock.version!==manifest.version||lock.packages[''].version!==manifest.version)throw Error('Lock version mismatch');
if(Object.keys(lock.packages).some(p=>p==='node_modules/webdav'||p.startsWith('node_modules/webdav/')))throw Error('Retired SDK in lockfile');
const notices=await readFile('dist/THIRD_PARTY_NOTICES.txt','utf8');
for(const directory of new Set([...inputs].filter(p=>p.startsWith('node_modules/')).map(p=>p.split('/').slice(0,p.split('/')[1].startsWith('@')?3:2).join('/')))){
 const dependency=await load(directory+'/package.json');if(!notices.includes(dependency.name+'@'+dependency.version))throw Error('Missing bundled dependency notice: '+dependency.name);
}
const code=await readFile('dist/main.js','utf8');const module={exports:{}};
for(const legal of [await readFile('LICENSE','utf8'),notices])if(!code.includes(legal.replace(/\*\//g,'* /')))throw Error('License missing from standalone main.js');
if(/(?:process\.env|fetch\s*=|\.lab\/|WEBDAV_EXPORT_CONFIG|If-Match|If-None-Match|candidateGeneration|expectedETag)/.test(code))throw Error('Research, environment, global patch or retired CAS code in runtime');
vm.runInNewContext(code,{module,exports:module.exports,require:id=>{if(id!=='obsidian')throw Error('Unexpected require');return{Plugin:class{},PluginSettingTab:class{},Modal:class{}};},fetch:()=>{throw Error('Release smoke must not perform network requests');},TextEncoder,TextDecoder,crypto:globalThis.crypto,URL,Response,Headers,Request,AbortController,AbortSignal,Buffer:undefined,setTimeout,clearTimeout,console},{timeout:5000});
if(typeof module.exports.default!=='function')throw Error('No CJS plugin export');
const artifacts=['main.js','manifest.json','styles.css','LICENSE','THIRD_PARTY_NOTICES.txt','PROVENANCE.md'];const hashes={};
for(const file of artifacts)hashes[file]=createHash('sha256').update(await readFile('dist/'+file)).digest('hex');
await writeFile('dist/SHA256SUMS.json',JSON.stringify(hashes,null,2));console.log('Release structure, CJS load, browser inputs, bundled notices and hashes: PASS');
