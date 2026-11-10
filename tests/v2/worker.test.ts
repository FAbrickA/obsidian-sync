import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeBackground} from '../../src/v2-merge-worker.ts';
import {mergeMarkdownMany} from '../../src/merge.ts';
test('background merge uses identical semantics and retains original input buffers',async()=>{
  const encode=(s:string)=>new TextEncoder().encode(s).buffer,lines=Array.from({length:2000},(_,i)=>'line '+i+' '+('x'.repeat(60))+'\n'),base=encode(lines.join(''));
  const variants=[0,1,2].map(i=>{const copy=[...lines];copy[(i+1)*400]='edit '+i+'\n';return encode(copy.join(''));});
  const sizes=[base,...variants].map(v=>v.byteLength),expected=mergeMarkdownMany(base,variants),actual=await mergeBackground('markdown',base,variants);
  assert.deepEqual(actual,expected);assert.deepEqual([base,...variants].map(v=>v.byteLength),sizes);
});
