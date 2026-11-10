import { build } from 'esbuild';
import { mkdir, writeFile, readFile, copyFile, appendFile } from 'node:fs/promises';

const output='dist';
await mkdir(output, { recursive: true });
const worker=await build({entryPoints:['src/v2-merge-worker-entry.ts'],bundle:true,platform:'browser',target:'es2021',format:'iife',write:false,metafile:true,logLevel:'silent'});
const result = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2021',
  external: ['obsidian'],
  outfile: `${output}/main.js`,
  sourcemap: false,
  metafile: true,
  logLevel: 'info',
  define:{__MERGE_WORKER_SOURCE__:JSON.stringify(worker.outputFiles[0].text)},
});
await copyFile('manifest.json',`${output}/manifest.json`);
await copyFile('styles.css',`${output}/styles.css`);
await writeFile(`${output}/metafile.json`, JSON.stringify(result.metafile, null, 2));
await writeFile(`${output}/worker-metafile.json`,JSON.stringify(worker.metafile,null,2));
await import('./license-inventory.mjs');
  await copyFile('LICENSE','dist/LICENSE');
  await copyFile('THIRD_PARTY_NOTICES.md','dist/PROVENANCE.md');
// Obsidian/BRAT installs main.js without downloading the separate license assets.
const legal=await Promise.all(['LICENSE','dist/THIRD_PARTY_NOTICES.txt'].map(f=>readFile(f,'utf8')));
await appendFile('dist/main.js','\n/*!\n'+legal.join('\n\n').replace(/\*\//g,'* /')+'\n*/\n');
