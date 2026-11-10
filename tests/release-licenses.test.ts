import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
test('standalone main.js retains project and bundled dependency licenses for BRAT installations',async()=>{
  execFileSync(process.execPath,['tools/build.mjs'],{stdio:'pipe'});
  const[code,license,notices]=await Promise.all(['dist/main.js','LICENSE','dist/THIRD_PARTY_NOTICES.txt'].map(f=>readFile(f,'utf8')));
  assert(code.includes(license.replace(/\*\//g,'* /')),'Project license missing from standalone main.js');
  assert(code.includes(notices.replace(/\*\//g,'* /')),'Dependency notices missing from standalone main.js');
});
