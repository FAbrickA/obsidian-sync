import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/queue.ts';
test('bounded parallel work drains issued requests even when another request rejects',async()=>{
  let active=0,maximum=0,settled=0;
  await assert.rejects(mapLimit([0,1,2,3],2,async i=>{active++;maximum=Math.max(maximum,active);
    await new Promise(r=>setTimeout(r,i===0?1:20));active--;settled++;if(i===0)throw Error('failed');}));
  assert.equal(maximum,2);assert.equal(active,0);assert.equal(settled,2);
});
