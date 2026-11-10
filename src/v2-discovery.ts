import { DavError } from './transport.ts';
import type { DavEntry } from './transport.ts';
import { RepositoryErrorV2 } from './repository.ts';
import type { RepositoryV2 } from './repository.ts';
import { ingestContainers, reduceHistory } from './v2-history.ts';
import type { HistoryIndexV2 } from './v2-history.ts';
import { v2Id, validateSlot } from './v2-codec.ts';
import { limitsV2 } from './v2-types.ts';
import type { EventRef, HintRecord, IssueV2, Revision, SlotRef, StoredContainerV2 } from './v2-types.ts';
import { mapLimit } from './queue.ts';
const absent = (e: unknown) => e instanceof DavError && e.kind === 'NotFound';
const fatal = (e: unknown) => e instanceof DOMException || e instanceof DavError && ['Auth', 'Permission', 'RateLimited', 'Transient'].includes(e.kind);
function issue(error: unknown, kind: IssueV2['kind'], id = ''): IssueV2 {
  return { kind, code: error instanceof RepositoryErrorV2 ? error.code : error instanceof DavError && ['Auth', 'Permission'].includes(error.kind) ? 'Auth'
    : error instanceof DavError && ['Transient', 'RateLimited'].includes(error.kind) ? 'Network' : absent(error) ? 'Incomplete' : 'Corrupt', relatedIds: id ? [id] : [] };
}
export async function observeHint(repo: RepositoryV2, deviceId: string): Promise<{ hint: HintRecord | null; issues: IssueV2[] }> {
  try { return { hint: await repo.readHint(deviceId), issues: [] }; }
  catch (error) { if (fatal(error)) throw error; return { hint: null, issues: absent(error) ? [] : [issue(error, 'hint')] }; }
}
function slotFromEntry(entry: DavEntry, repoId: string): SlotRef {
  const match = /\/([a-zA-Z0-9_-]{1,128})\.([0-9a-f]{64})\.json$/.exec(entry.path);
  if (!match || entry.kind !== 'file' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limitsV2.containerBytes) throw new RepositoryErrorV2('Corrupt');
  return validateSlot({ path: entry.path, hash: match[2], size: entry.size }, repoId, 'journal');
}
async function followReferences(repo: RepositoryV2, index: HistoryIndexV2, initial: EventRef[], maxReads: number) {
  const queue: EventRef[] = [], enqueued = new Set<string>(), tried = new Set<string>(), issues: IssueV2[] = []; let reads = 0, requiresCanonical = false;
  function append(refs: EventRef[]) { for (const ref of refs) { const key = ref.eventId + ':' + ref.containerSlots.map(s => `${s.path}:${s.size}`).sort().join(','); if (!enqueued.has(key)) { enqueued.add(key); queue.push(ref); } } }
  append(initial);
  const before = new Set(index.events.keys());
  for (let at = 0; at < queue.length; at++) {
    const ref = queue[at];
    for (const slot of ref.containerSlots) {
      if(index.events.has(ref.eventId)&&index.eventSources.get(ref.eventId)?.has(slot.path))break;
      if (tried.has(slot.path)) continue; tried.add(slot.path);
      let stored = index.containers.get(slot.path); const cached = !!stored;
      if (!stored) {
        if (reads >= maxReads) { requiresCanonical = true; break; }
        try { reads++; stored = await repo.readContainer(slot); }
        catch (error) { if (fatal(error)) throw error; issues.push(issue(error, 'source', slot.hash)); continue; }
      }
      if (!cached || !index.events.has(ref.eventId)) await ingestContainers(index, [stored]);
      if (!stored.decoded.events.some(e => e.id === ref.eventId)) { issues.push({ kind: 'source', code: 'Corrupt', relatedIds: [ref.eventId] }); continue; }
      append(stored.decoded.dependencies.filter(d => !index.proposals.has(d.event.eventId)).map(d => d.event));
      for (const event of stored.decoded.events) if (event.core.previous && !index.proposals.has(event.core.previous)) {
        const sources = stored.decoded.previousSources.filter(p => p.eventId === event.core.previous);
        if (sources.length) append(sources); else requiresCanonical = true;
      }
      break; // One positive physical alias is sufficient; other canonical aliases remain discoverable.
    }
  }
  const admitted = [...index.events.values()].filter(e => !before.has(e.id));
  if (admitted.length) await repo.admitEvents(admitted);
  return { reads, issues, requiresCanonical };
}
export async function readRequiredRevision(repo: RepositoryV2, index: HistoryIndexV2, id: string, sourceHints: EventRef[]): Promise<Revision> {
  if (!index.revisions.has(id)) await followReferences(repo, index, sourceHints, Number.MAX_SAFE_INTEGER);
  const revision = index.revisions.get(id); if (!revision) throw new RepositoryErrorV2('Incomplete'); return revision;
}
export async function discover(repo: RepositoryV2, index: HistoryIndexV2, options: { mode: 'hint' | 'canonical'; frozenEventIds?: readonly string[] }) {
  await repo.assertIdentity();
  const before = new Set(index.events.keys()), issues: IssueV2[] = [], incoming: StoredContainerV2[] = [];
  let requiresCanonical = false, canonicalScanSettled = options.mode === 'canonical', scannedSlots = 0;
  const journal = `${repo.prefix}/journal`, devices = new Set<string>();
  async function list(path: string) {
    try { return await repo.list(path); }
    catch (error) { if (absent(error)) return []; if (fatal(error)) throw error; issues.push(issue(error, 'metadata')); canonicalScanSettled = false; return []; }
  }
  function child(entry: DavEntry, parent: string): string {
    const name = entry.path.slice(parent.length + 1);
    if (!entry.path.startsWith(parent + '/') || !name || name.includes('/')) throw new RepositoryErrorV2('Corrupt'); return name;
  }
  for (const device of await list(journal)) {
    let deviceId: string;
    try { deviceId = child(device, journal); if (device.kind !== 'directory' || !v2Id(deviceId)) throw new RepositoryErrorV2('Corrupt'); }
    catch (error) { issues.push(issue(error, 'metadata')); continue; }
    devices.add(deviceId); if (options.mode !== 'canonical') continue;
    for (const group of await list(device.path)) {
      try { const name = child(group, device.path); if (group.kind !== 'directory' || !/^(0|[1-9]\d*)$/.test(name) || !Number.isSafeInteger(Number(name))) throw new RepositoryErrorV2('Corrupt'); }
      catch (error) { issues.push(issue(error, 'metadata')); continue; }
      for (const segment of await list(group.path)) {
        try { if (segment.kind !== 'directory' || !v2Id(child(segment, group.path))) throw new RepositoryErrorV2('Corrupt'); }
        catch (error) { issues.push(issue(error, 'metadata')); continue; }
        const cachedSeal=index.seals.get(segment.path);
        if(cachedSeal&&cachedSeal.record.members.every(m=>index.events.has(m.eventId)))continue;
        let sealed=false;
        try {
          const summaries=await repo.readSegmentSeals({deviceId,group:Number(child(group,device.path)),segmentId:child(segment,group.path)});
          for(const summary of summaries){
            const followed=await followReferences(repo,index,summary.record.members,Number.MAX_SAFE_INTEGER);
            if(summary.record.members.every(m=>index.events.has(m.eventId))){index.seals.set(segment.path,summary);sealed=true;break;}
            issues.push(...followed.issues);
          }
        }catch(error){if(fatal(error))throw error;issues.push(issue(error,'metadata'));}
        if(sealed)continue;
        const slots: SlotRef[] = [];
        for (const entry of await list(segment.path)) {
          try { child(entry, segment.path); const slot = slotFromEntry(entry, repo.repositoryId); scannedSlots++; if (!index.containers.has(slot.path)) slots.push(slot); }
          catch (error) { issues.push(issue(error, 'metadata')); }
        }
        await mapLimit(slots, repo.concurrency, async slot => {
          try { incoming.push(await repo.readContainer(slot)); }
          catch (error) { if (fatal(error)) throw error; issues.push(issue(error, 'source', slot.hash)); }
        });
      }
    }
  }
  for (const entry of await list(`${repo.prefix}/hints`)) {
    try { const name = child(entry, `${repo.prefix}/hints`); if (entry.kind !== 'file' || !name.endsWith('.json') || !v2Id(name.slice(0, -5))) throw new RepositoryErrorV2('Corrupt'); devices.add(name.slice(0, -5)); }
    catch (error) { issues.push(issue(error, 'hint')); }
  }
  if (incoming.length) { const result = await ingestContainers(index, incoming); if (result.admitted.length) await repo.admitEvents(result.admitted); }
  const refs: EventRef[] = [], observed: { deviceId: string; tip: string | null }[] = [];
  for (const deviceId of devices) {
    const result = await observeHint(repo, deviceId); issues.push(...result.issues);
    if (!result.hint) { requiresCanonical = true; continue; }
    observed.push({ deviceId, tip: result.hint.tip?.eventId ?? null });
    if (result.hint.tip) refs.push(result.hint.tip);
    else if (!index.hintTips.has(deviceId)) requiresCanonical = true;
  }
  // Outstanding parent locators may predate this pass. Missing bytes are not metadata requests.
  for (const copies of index.copies.values()) for (const copy of copies) if (!index.events.has(copy.event.id) && !copy.invalid)
    for (const dep of copy.stored.decoded.dependencies) if (!index.proposals.has(dep.event.eventId)) refs.push(dep.event);
  for (const stored of index.containers.values()) for (const ref of stored.decoded.previousSources) if (!index.proposals.has(ref.eventId)) refs.push(ref);
  const followed = await followReferences(repo, index, refs, options.mode === 'hint' ? 128 : Number.MAX_SAFE_INTEGER);
  issues.push(...followed.issues); requiresCanonical ||= followed.requiresCanonical;
  for (const { deviceId, tip } of observed) {
    const prior = index.hintTips.get(deviceId);
    if (tip) {
      const event = index.proposals.get(tip);
      if (!event || event.core.deviceId !== deviceId) { requiresCanonical = true; continue; }
      if (prior && prior !== tip) {
        const seen = new Set<string>(); let next: string | null = tip;
        while (next && next !== prior && !seen.has(next)) { seen.add(next); next = index.proposals.get(next)?.core.previous ?? null; }
        if (next !== prior) requiresCanonical = true;
      }
    } else if (prior) requiresCanonical = true;
    index.hintTips.set(deviceId, tip);
  }
  if (options.mode === 'canonical') index.canonicalStarted = true;
  const view = await reduceHistory(index), admitted = [...index.events.values()].filter(e => !before.has(e.id));
  if (view.coverage.pendingEvents.length) requiresCanonical = true;
  const frozen = new Set(options.frozenEventIds ?? []);
  const healthyHashes=new Set([...index.containers.values()].map(c=>c.slot.hash));
  const outstanding=issues.filter(i=>!(i.kind==='source'&&['Corrupt','Incomplete'].includes(i.code)&&i.relatedIds.length>0&&i.relatedIds.every(id=>healthyHashes.has(id))));
  const advisories=issues.filter(i=>!outstanding.includes(i));
  return { view, admitted, issues: [...outstanding, ...view.coverage.issues], advisories, requiresCanonical, canonicalScanSettled, scannedSlots,
    followUpEventIds: options.frozenEventIds ? admitted.filter(e => !frozen.has(e.id)).map(e => e.id) : [] };
}
export function createAuditScheduler() {
  let deadline = 0, nextPoll = 0, wasVisible = false, foreground = true;
  return { scheduleAudit(nowVisibleMs: number, options: { visible: boolean; running: boolean; manual?: boolean }): 'canonical' | 'hint' | 'none' {
    if (!Number.isFinite(nowVisibleMs) || nowVisibleMs < 0) throw new Error('Invalid visible clock.');
    if (options.visible && !wasVisible) foreground = true; wasVisible = options.visible;
    if ((!options.visible && !options.manual) || options.running) return 'none';
    if (foreground || options.manual || nowVisibleMs >= deadline) {
      foreground = false;
      if (deadline === 0) deadline = nowVisibleMs + limitsV2.auditMs;
      else if (nowVisibleMs >= deadline) deadline += (Math.floor((nowVisibleMs - deadline) / limitsV2.auditMs) + 1) * limitsV2.auditMs;
      nextPoll = nowVisibleMs + limitsV2.pollMs; return 'canonical';
    }
    if (nowVisibleMs >= nextPoll) { nextPoll = nowVisibleMs + limitsV2.pollMs; return 'hint'; }
    return 'none';
  } };
}
