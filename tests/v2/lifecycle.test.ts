import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleV2 } from '../../src/lifecycle.ts';
import type { EngineV2 } from '../../src/engine.ts';
import type { RunOutcomeV2, RunBoundaryV2 } from '../../src/v2-types.ts';
const clean=():RunOutcomeV2=>({state:'clean',publishedEventIds:[],localApplied:true,projectionChecked:true,pending:[],boundaryCompletion:{id:'b',acceptedOperationIds:[],admittedEventIds:[],operations:{},unresolvedAccepted:[],followUpRemote:false,advisoryPending:false}});
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('100 changes coalesce; close freezes one boundary after existing work settles',async()=>{
  let runs=0,generation=1,captures=0,active=0,maximum=0;const received:(RunBoundaryV2|undefined)[]=[];
  const engine={run:async(b?:RunBoundaryV2)=>{received.push(b);runs++;active++;maximum=Math.max(maximum,active);await wait(8);active--;return clean();},captureBoundary:async(g:number)=>{captures++;return{id:'frozen',throughGeneration:g,admittedEventIds:['fixed']}}} as unknown as EngineV2;
  const life=createLifecycleV2({engine,flushEditors:async()=>{},events:{generation:()=>generation,flush:async()=>{}},debounceMs:5});
  await Promise.all(Array.from({length:100},()=>life.requestSync('change')));assert.equal(runs,1);
  const running=life.requestSync('manual');await wait(1);generation=2;const a=life.close(),b=life.close();assert.equal(a,b);
  assert.equal((await a).state,'completed');await running;assert.equal(captures,1);assert.equal(maximum,1);
  assert.deepEqual(received[received.length-1],{id:'frozen',throughGeneration:2,admittedEventIds:['fixed']});life.dispose();
});
test('unknown own work retains close; advisory follow-up and hint repair do not',async()=>{
  let bad=true;const life=createLifecycleV2({engine:{run:async()=>{const r=clean();r.state='pending';r.boundaryCompletion.followUpRemote=true;r.boundaryCompletion.advisoryPending=true;if(bad)r.boundaryCompletion.unresolvedAccepted=['own'];return r;},captureBoundary:async()=>({id:'b',throughGeneration:0,admittedEventIds:[]})} as unknown as EngineV2,flushEditors:async()=>{},events:{generation:()=>0,flush:async()=>{}}});
  assert.equal((await life.close()).state,'cancelled');bad=false;assert.equal((await life.close()).state,'completed');life.dispose();
});

test('a clean label cannot release an unsettled request; recovery exit saves every local buffer',async()=>{
  let recovery=0;
  const life=createLifecycleV2({engine:{run:async()=>{const r=clean();r.boundaryCompletion.operations.own={publication:'published',localCheckpoint:true,issuedRequestsSettled:false,projectionSettled:true,conflictsPreserved:true};return r;},captureBoundary:async()=>({id:'b',throughGeneration:0,admittedEventIds:[]})} as unknown as EngineV2,
    flushEditors:async()=>{},flushForRecovery:async()=>{recovery++;},events:{generation:()=>0,flush:async()=>{}}});
  assert.equal((await life.close()).state,'cancelled');assert.equal((await life.explicitRecoveryExit()).state,'explicit-recovery-exit');assert.equal(recovery,1);life.dispose();
});

test('every explicit manual sync requests a canonical audit even immediately after a prior successful run',async()=>{
  const audits:boolean[]=[];
  const life=createLifecycleV2({engine:{run:async(_boundary:unknown,integrity:boolean)=>{audits.push(integrity);return clean();}} as unknown as EngineV2,
    flushEditors:async()=>{},events:{generation:()=>0,flush:async()=>{}},autoSync:false});
  try{await life.requestSync('manual');await life.requestSync('manual');assert.deepEqual(audits,[true,true]);}finally{life.dispose();}
});
