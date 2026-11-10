import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHeads, resolveHeads } from '../../src/v2-merge.ts';
import { mergeMarkdownMany } from '../../src/merge.ts';
import { mergeBookmarksMany } from '../../src/bookmarks.ts';
import { createHistoryIndex, ingestContainers, reduceHistory } from '../../src/v2-history.ts';
import { revisionId } from '../../src/v2-codec.ts';
import { hashBytes } from '../../src/snapshots.ts';
import type { Revision } from '../../src/v2-types.ts';
import { bytes, rev, evt, recorded } from './fixtures.ts';
const text=(b:ArrayBuffer)=>new TextDecoder('utf-8',{ignoreBOM:true}).decode(b);
const permutations=<T>(v:T[]):T[][]=>v.length?v.flatMap((x,i)=>permutations(v.filter((_,j)=>i!==j)).map(t=>[x,...t])):[[]];
async function scenario(base:string,variants:string[],paths=variants.map(()=>'a.md')){
  const root=await rev('f',base),heads:Revision[]=[];for(let i=0;i<variants.length;i++)heads.push(await rev('f',variants[i],[root.id],paths[i]==='a.md'?'edit':'rename',paths[i]));
  const events=await Promise.all([root,...heads].map(r=>evt([r]))),index=createHistoryIndex('repo');await ingestContainers(index,await recorded(events));
  const objects=new Map<string,ArrayBuffer>();for(const s of [base,...variants])objects.set(await hashBytes(bytes(s)),bytes(s));
  const read=async(hash:string)=>{const data=objects.get(hash);if(!data)throw Error('Missing synthetic bytes');return data};
  return{root,heads,events,index,read,objects};
}
test('three independent edits merge identically in all six orders, retaining BOM and every newline convention',async()=>{
  for(const eol of ['\n','\r\n','\r'])for(const bom of ['', '\ufeff'])for(const final of ['',eol]){
    const base=bom+['a','b','c','d','e'].join(eol)+final,variants=[['A','b','c','d','e'],['a','b','C','d','e'],['a','b','c','d','E']].map(a=>bytes(bom+a.join(eol)+final));
    for(const order of permutations(variants)){const result=mergeMarkdownMany(bytes(base),order);assert.equal(result.kind,'clean');if(result.kind==='clean')assert.equal(text(result.bytes),bom+['A','b','C','d','E'].join(eol)+final)}
  }
  const s=await scenario('a\nb\nc\nd\ne\n',['A\nb\nc\nd\ne\n','a\nb\nC\nd\ne\n','a\nb\nc\nd\nE\n']);let id='';
  for(const order of permutations(s.heads)){const d=await mergeHeads('f',order,s.index,s.read);assert.equal(d.kind,'merged');const next=await revisionId(d.core);if(id)assert.equal(next,id);id=next;assert.deepEqual(d.core.parents,s.heads.map(h=>h.id).sort())}
});
test('identical hunks deduplicate while distinct inserts, overlaps and insertion boundaries stay conflicts',()=>{
  const base=bytes('a\nb\nc\nd\ne\n');
  const d=mergeMarkdownMany(base,[bytes('A\nb\nc\nd\ne\n'),bytes('A\nb\nc\nd\ne\n'),bytes('a\nb\nc\nd\nE\n')]);
  assert.equal(d.kind,'clean');if(d.kind==='clean')assert.equal(text(d.bytes),'A\nb\nc\nd\nE\n');
  for(const variants of [['X\na\nb\n','Y\na\nb\n'],['X\nb\n','Y\nb\n'],['a\nX\nb\n','A\nb\n']])
    assert.equal(mergeMarkdownMany(bytes('a\nb\n'),variants.map(bytes)).kind,'conflict');
});
test('invalid encoding and resource limits preserve detached original variants',()=>{
  const bad=new Uint8Array([255]).buffer,oversized=new ArrayBuffer(1_000_001);
  for(const variants of [[bad,bytes('a')],[oversized,bytes('a')],Array.from({length:33},()=>bytes('a'))]){
    const result=mergeMarkdownMany(bytes('base'),variants);assert.equal(result.kind,'conflict');if(result.kind==='conflict'){assert.deepEqual(result.variants[0],variants[0]);new Uint8Array(variants[0]).fill(0);assert.notEqual(result.variants[0],variants[0])}
  }
});
test('rename plus independent edit merges; conflicting rename targets and ambiguous bases do not',async()=>{
  const s=await scenario('a\nb\nc\n',['a\nb\nc\n','a\nb\nC\n'],['renamed.md','a.md']);const d=await mergeHeads('f',s.heads,s.index,s.read);
  assert.equal(d.kind,'merged');assert.equal(d.core.value.path,'renamed.md');assert.equal(text(d.bytes!),'a\nb\nC\n');
  const renamed=await scenario('base',['base','base'],['one.md','two.md']);assert.equal((await mergeHeads('f',renamed.heads,renamed.index,renamed.read)).kind,'conflict');
  const a=s.heads[0],b=s.heads[1],x=await rev('f','X',[a.id,b.id],'resolve'),y=await rev('f','Y',[a.id,b.id],'resolve');
  await ingestContainers(s.index,await recorded([...s.events,await evt([x]),await evt([y])]));
  const ambiguous=await mergeHeads('f',[x,y],s.index,s.read);assert.equal(ambiguous.kind,'conflict');if(ambiguous.kind==='conflict')assert.equal(ambiguous.baseCandidates.length,2);
});
test('equal binary states and equal tombstones join before text merge, with stable revision identity',async()=>{
  const s=await scenario('base',['A','B'],['a.bin','a.bin']);
  const equalHeads=await Promise.all(s.heads.map(r=>rev('f','same',[r.id],'edit','a.bin')));
  await ingestContainers(s.index,await recorded([...s.events,...await Promise.all(equalHeads.map(r=>evt([r])))]));
  const d=await mergeHeads('f',equalHeads,s.index,s.read);
  assert.equal(d.kind,'join');assert.equal(d.core.value.kind,'file');
  const t1={...s.root.core,parents:[s.root.id],operation:'delete' as const,value:{kind:'tombstone' as const,path:'a.md'}};
  const other=await rev('f','intermediate',[s.root.id]),t2={...t1,parents:[other.id]};
  const tombs=[{id:await revisionId(t1),core:t1},{id:await revisionId(t2),core:t2}];
  await ingestContainers(s.index,await recorded([...s.events,await evt([other]),...await Promise.all(tombs.map(r=>evt([r])))]));
  assert.equal((await mergeHeads('f',tombs,s.index,s.read)).kind,'join');
});
test('one binary content change and an independent rename combine without choosing between two changed binaries',async()=>{
  const s=await scenario('base',['base','new'],['renamed.bin','a.md']);
  const d=await mergeHeads('f',s.heads,s.index,s.read);assert.equal(d.kind,'merged');assert.equal(d.core.value.path,'renamed.bin');assert.equal(d.core.value.kind==='file'&&d.core.value.hash,await hashBytes(bytes('new')));
  const both=await scenario('base',['left','right'],['renamed.bin','a.md']);assert.equal((await mergeHeads('f',both.heads,both.index,both.read)).kind,'conflict');
});
test('already admitted automatic merge is reused rather than published as a new generation',async()=>{
  const s=await scenario('a\nb\nc\n',['A\nb\nc\n','a\nb\nC\n']),first=await mergeHeads('f',s.heads,s.index,s.read);assert.notEqual(first.kind,'conflict');if(first.kind==='conflict')return;
  const revision={id:await revisionId(first.core),core:first.core};await ingestContainers(s.index,await recorded([...s.events,await evt([revision],'other-device')]));
  const again=await mergeHeads('f',[...s.heads].reverse(),s.index,s.read);assert.notEqual(again.kind,'conflict');if(again.kind!=='conflict')assert.equal(again.existingRevisionId,revision.id);
});
test('manual resolution uses only reviewed IDs and rejects invalid edited bookmarks',async()=>{
  const s=await scenario('base',['A','B','C']),ids=s.heads.slice(0,2).map(r=>r.id);
  const core=await resolveHeads('f',ids,{kind:'variant',revisionId:ids[0]},s.index);assert.deepEqual(core.parents,[...ids].sort());
  const r={id:await revisionId(core),core};await ingestContainers(s.index,await recorded([...s.events,await evt([r])]));
  assert.deepEqual((await reduceHistory(s.index)).headsByFile.f.map(v=>v.id).sort(),[r.id,s.heads[2].id].sort());
  await assert.rejects(resolveHeads('f',ids,{kind:'variant',revisionId:s.heads[2].id},s.index));
  await assert.rejects(resolveHeads('f',ids,{kind:'edit',path:'@bookmarks.json',bytes:bytes('{broken')},s.index));
});
test('mutating the caller selection during draft hashing cannot consume an unseen branch',async()=>{
  const s=await scenario('base',['A','B','C']),ids=s.heads.slice(0,2).map(r=>r.id),expected=[...ids].sort();
  const pending=resolveHeads('f',ids,{kind:'edit',path:'a.md',bytes:bytes('chosen')},s.index);ids.push(s.heads[2].id);
  assert.deepEqual((await pending).parents,expected);
});
test('N-way bookmarks preserve equal ctimes, groups, unknown fields and distinct duplicate targets',()=>{
  const root={items:[{type:'group',title:'Group',ctime:1,items:[{type:'url',url:'base',custom:true}]}],unknown:{value:7}};
  const variants=['A','B','C'].map(title=>bytes(JSON.stringify({...root,items:[...root.items,{type:'url',url:'same',ctime:1,title,custom:'kept'}]})));
  let first:ArrayBuffer|undefined;for(const order of permutations(variants)){const d=mergeBookmarksMany(bytes(JSON.stringify(root)),order);assert.equal(d.kind,'clean');if(d.kind==='clean'){if(first)assert.deepEqual(d.bytes,first);first=d.bytes;const p=JSON.parse(text(d.bytes));assert.equal(p.items.length,4);assert.deepEqual(p.items[0],root.items[0]);assert.deepEqual(p.unknown,root.unknown)}}
  const base=bytes('{"items":[]}'),x={type:'url',url:'X'},y={type:'url',url:'Y'},z={type:'url',url:'Z'};
  assert.equal(mergeBookmarksMany(base,[[x],[x,y],[z]].map(items=>bytes(JSON.stringify({items})))).kind,'conflict');
  assert.equal(mergeBookmarksMany(base,[bytes('{bad'),base,base]).kind,'conflict');
});
