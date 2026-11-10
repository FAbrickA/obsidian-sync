import type { EngineV2 } from './engine.ts';
import type { ResolutionChoiceV2 } from './v2-merge.ts';
import type { RunBoundaryV2 as RunBoundary, RunOutcomeV2 as RunOutcome } from './v2-types.ts';
type CloseOutcome={state:'completed'|'cancelled'|'explicit-recovery-exit';outcome:RunOutcome};
export type TriggerSource = 'change' | 'manual' | 'startup' | 'poll' | 'focus' | 'hidden' | 'visible' | 'quit' | 'integrity';
type Events = { generation(): number; flush(): Promise<void> };
type Status = RunOutcome | { state: 'running' | 'closing' };
type Job = { sync: boolean; promise: Promise<RunOutcome>; resolve(value: RunOutcome): void;
  work(generation: number): Promise<RunOutcome>; frozen?: number; integrity?: boolean };
export type LifecycleV2 = ReturnType<typeof createLifecycleV2>;
const failure = (reason: string): RunOutcome => ({ state: 'blocked', localApplied: false, projectionChecked: false, publishedEventIds: [], pending: [{kind:'local',code:'Incomplete',relatedIds:[reason]}],
  boundaryCompletion: { id:crypto.randomUUID(), acceptedOperationIds: [], admittedEventIds: [], advisoryPending:false, operations: {}, unresolvedAccepted: [reason], followUpRemote: false } });
export function createLifecycleV2(options: { engine: EngineV2; flushEditors(): Promise<void>; flushForRecovery?(): Promise<void>; events: Events;
  status?(value: Status): void; debounceMs?: number; pollMs?: number; autoSync?: boolean }) {
  const { engine, events } = options; const jobs: Job[] = []; const idleWaiters: (() => void)[] = [];
  let active = false, disposed = false, closing = false, hidden = false, epoch = 0, lastAudit=0;
  let pendingSync: Job | undefined, debounce: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<CloseOutcome> | undefined; let last = failure('not-run');
  const notify = (value: Status) => { try { options.status?.(value); } catch { /* UI failures must never strand accepted work. */ } };
  const clearDebounce = () => { if (debounce) clearTimeout(debounce); debounce = undefined; };
  const announceIdle = () => { if (!active && !jobs.length) for (const resolve of idleWaiters.splice(0)) resolve(); };
  const pump = async () => {
    if (active || !jobs.length || jobs[0] === pendingSync && debounce) return;
    active = true; const job = jobs.shift()!; if (job === pendingSync) pendingSync = undefined;
    notify({ state: 'running' });
    try {
      await options.flushEditors(); await events.flush();
      last = await job.work(job.frozen ?? events.generation());
    } catch { last = failure('local-flush-or-operation-failed'); }
    finally { job.resolve(last); active = false; notify(last); announceIdle(); void pump(); }
  };
  const enqueue = (work: Job['work'], sync: boolean, frozen?: number) => {
    let resolve!: Job['resolve']; const promise = new Promise<RunOutcome>(r => { resolve = r; });
    const job: Job = { work, sync, promise, resolve, frozen }; jobs.push(job); return job;
  };
  const request = (source: TriggerSource, frozen?: number): Promise<RunOutcome> => {
    if (disposed) return Promise.resolve(failure('disposed'));
    if (closing && source !== 'quit') return closePromise?.then(r => r.outcome) ?? Promise.resolve(last);
    if (!pendingSync) {
      const job = enqueue(async generation => {if(job.frozen!==undefined)await engine.retireForClose?.();return engine.run(job.frozen === undefined ? undefined : await engine.captureBoundary(generation), !!job.integrity);}, true, frozen); pendingSync = job;
    }
    pendingSync.integrity ||= ['manual','integrity','visible','focus'].includes(source) || Date.now()-lastAudit >= 300_000;
    if(pendingSync.integrity)lastAudit=Date.now();
    if (source === 'quit') pendingSync.frozen = frozen;
    const promise = pendingSync.promise;
    clearDebounce();
    if (source === 'change') debounce = setTimeout(() => { debounce = undefined; void pump(); }, options.debounceMs ?? 1000);
    else void pump();
    return promise;
  };
  const mutation = (work: () => Promise<RunOutcome>) => {
    if (disposed || closing) return Promise.resolve(failure('closing-or-disposed'));
    const job = enqueue(work, false); clearDebounce(); void pump(); return job.promise;
  };
  const poll = options.autoSync !== false && options.pollMs ? setInterval(() => {
    if (!hidden && !closing && !disposed) void request('poll');
  }, options.pollMs) : undefined;
  const maintenance=options.autoSync!==false?setInterval(()=>{
    if(!hidden&&!closing&&!disposed&&!active&&!jobs.length&&engine.maintenance)void mutation(async()=>{await engine.maintenance();return last;});
  },30_000):undefined;
  const safeToClose = (outcome: RunOutcome) => outcome.state !== 'blocked'
    && (outcome.state !== 'pending' || outcome.boundaryCompletion.followUpRemote)
    && outcome.boundaryCompletion.unresolvedAccepted.length === 0
    && Object.values(outcome.boundaryCompletion.operations).every(op => op.localCheckpoint && op.issuedRequestsSettled && op.projectionSettled && op.conflictsPreserved && op.publication !== 'unknown');
  return {
    requestSync: (source: TriggerSource) => request(source),
    exclusive: (work:()=>Promise<RunOutcome>) => mutation(work),
    resolveConflict: (request:{fileId:string;reviewedIds:string[];choice:ResolutionChoiceV2}) => {const frozen=structuredClone(request);return mutation(() => engine.resolveConflict(frozen));},
    restoreVersion: (fileId: string, hash: string, reviewedIds?:string[]) => {const reviewed=reviewedIds?[...reviewedIds]:undefined;return mutation(() => engine.restoreVersion(fileId, hash,reviewed));},
    resolveDrift: (id: string, choice: 'import-as-edit' | 'repair-from-canonical') => mutation(() => engine.resolveDrift(id, choice)),
    close(): Promise<CloseOutcome> {
      if (closePromise) return closePromise;
      closing = true; const attempt = ++epoch; clearDebounce(); notify({ state: 'closing' });
      closePromise = (async () => {
        let outcome: RunOutcome;
        try {
          await options.flushEditors(); await events.flush();
          outcome = await request('quit', events.generation());
        } catch { outcome = failure('local-flush-failed'); }
        const completed = attempt === epoch && safeToClose(outcome);
        if (!completed && attempt === epoch) { closing = false; closePromise = undefined; }
        return { state: completed ? 'completed' : 'cancelled', outcome } as CloseOutcome;
      })();
      return closePromise;
    },
    cancelClose() { epoch++; closing = false; closePromise = undefined; },
    async explicitRecoveryExit(): Promise<CloseOutcome> {
      await (options.flushForRecovery ?? options.flushEditors)();
      if(options.flushForRecovery)await events.flush().catch(()=>{});else await events.flush();
      return { state: 'explicit-recovery-exit', outcome: last };
    },
    visibilityChanged(value: boolean) {
      hidden = value;
      if (options.autoSync !== false) { clearDebounce(); void request(value ? 'hidden' : 'visible'); }
    },
    idle() { return !active && !jobs.length ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve); }); },
    dispose() {
      disposed = true; clearDebounce(); if (poll) clearInterval(poll);
      if(maintenance)clearInterval(maintenance);
      for (const job of jobs.splice(0)) job.resolve(failure('disposed'));
      pendingSync = undefined; announceIdle();
    },
  };
}
