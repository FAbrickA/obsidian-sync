import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifecycleV2} from '../src/lifecycle.ts';
const createLifecycle=(options:Parameters<typeof createLifecycleV2>[0])=>{options.engine.captureBoundary??=async generation=>({id:'test',throughGeneration:generation??0,admittedEventIds:[]});return createLifecycleV2(options);};
import type { EngineV2 as SyncEngine } from '../src/engine.ts';
import type {RunOutcomeV2 as RunOutcome} from '../src/v2-types.ts';
const clean = (): RunOutcome => ({ state: 'clean', localApplied: true, projectionChecked: true, pending: [], publishedEventIds:[], boundaryCompletion: {
  id:'test', acceptedOperationIds: [], admittedEventIds:[], advisoryPending:false, operations: {}, unresolvedAccepted: [], followUpRemote: false } });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('100 debounced triggers coalesce; an event during a run is not lost; all mutations serialize', async () => {
  let generation = 1, active = 0, maximum = 0, runs = 0;
  const execute = async () => { active++; maximum = Math.max(maximum, active); runs++; await wait(10); active--; return clean(); };
  const engine = { run: execute, resolveConflict: execute, restoreVersion: execute, resolveDrift: execute } as unknown as SyncEngine;
  const lifecycle = createLifecycle({ engine, flushEditors: async () => {}, events: { generation: () => generation, flush: async () => {} }, debounceMs: 15 });
  const batch = Array.from({ length: 100 }, () => lifecycle.requestSync('change'));
  await Promise.all(batch); assert.equal(runs, 1);
  const running = lifecycle.requestSync('manual'); await wait(1); generation++;
  const next = lifecycle.requestSync('change'); const resolution = lifecycle.resolveConflict({fileId:'f',reviewedIds:['revision'],choice:{kind:'delete',path:'note.md'}});
  await Promise.all([running, next, resolution]); assert.equal(maximum, 1); assert.equal(runs, 4); lifecycle.dispose();
});
test('repeated close shares a barrier and cannot resolve before final checkpoint or editor flush', async () => {
  let checkpoint!: () => void; const final = new Promise<void>(r => { checkpoint = r; }); let saved = false, finished = false;
  const lifecycle = createLifecycle({ engine: { run: async () => { await final; return clean(); } } as unknown as SyncEngine,
    flushEditors: async () => { saved = true; }, events: { generation: () => 3, flush: async () => {} } });
  const a = lifecycle.close(), b = lifecycle.close(); assert.equal(a, b);
  void a.then(() => { finished = true; }); await wait(1); assert(saved); assert(!finished);
  checkpoint(); assert.equal((await a).state, 'completed'); lifecycle.dispose();
});
test('rejected work cancels close, releases scheduler and allows retry; status callback cannot strand it', async () => {
  let fail = true;
  const lifecycle = createLifecycle({ engine: { run: async () => { if (fail) throw new Error('failure'); return clean(); } } as unknown as SyncEngine,
    flushEditors: async () => {}, events: { generation: () => 1, flush: async () => {} }, status: () => { throw new Error('UI failure'); } });
  assert.equal((await lifecycle.close()).state, 'cancelled'); fail = false;
  assert.equal((await lifecycle.close()).state, 'completed'); lifecycle.dispose();
});
test('mobile hide starts one finite drain; later foreign work is follow-up, not an endless close barrier', async () => {
  let runs = 0; const result = clean(); result.boundaryCompletion.followUpRemote = true; result.projectionChecked = false;
  const lifecycle = createLifecycle({ engine: { run: async () => { runs++; return result; } } as unknown as SyncEngine,
    flushEditors: async () => {}, events: { generation: () => 1, flush: async () => {} } });
  lifecycle.visibilityChanged(true); await lifecycle.idle(); assert.equal(runs, 1);
  assert.equal((await lifecycle.close()).state, 'completed'); lifecycle.dispose();
});
test('explicit recovery exit flushes local data, while cancelling close never stops active transfer', async () => {
  let finish!: () => void; const transfer = new Promise<void>(r => { finish = r; }); let localSaved = 0;
  const lifecycle = createLifecycle({ engine: { run: async () => { await transfer; return clean(); } } as unknown as SyncEngine,
    flushEditors: async () => { localSaved++; }, events: { generation: () => 1, flush: async () => {} } });
  const closing = lifecycle.close(); await wait(1); lifecycle.cancelClose();
  assert.equal((await lifecycle.explicitRecoveryExit()).state, 'explicit-recovery-exit'); assert(localSaved >= 2);
  finish(); assert.equal((await closing).state, 'cancelled'); await lifecycle.idle(); lifecycle.dispose();
});

test('an integrity request upgrades an already debounced change run',async()=>{
  const checks:boolean[]=[];const lifecycle=createLifecycle({engine:{run:async (_b:unknown,integrity:boolean)=>{checks.push(integrity);return clean();}} as unknown as SyncEngine,
    flushEditors:async()=>{},events:{generation:()=>1,flush:async()=>{}},debounceMs:100});
  const change=lifecycle.requestSync('change');await lifecycle.requestSync('integrity');await change;
  assert.deepEqual(checks,[true]);lifecycle.dispose();
});
