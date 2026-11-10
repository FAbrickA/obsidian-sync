import { hashBytes, canonicalBytes } from './snapshots.ts';
import { portablePathKey, assertPortablePaths, classifyPath } from './paths.ts';
import { validateEvent } from './v2-codec.ts';
import type { EventRecord, Revision, StoredContainerV2, BlobRef, SlotRef, RemoteViewV2, ConflictV2, PathConflictV2, SealProofV2,
  IssueV2, CreationProofV2, AdoptionPlanV2, EventRef } from './v2-types.ts';
import type { LocalSnapshot } from './types.ts';
type Copy = { stored: StoredContainerV2; event: EventRecord; localRevisions: Set<string>; invalid: boolean };
export function createHistoryIndex(repositoryId: string) {
  return { repositoryId, events: new Map<string, EventRecord>(), proposals: new Map<string, EventRecord>(),
    containers: new Map<string, StoredContainerV2>(), hintTips: new Map<string, string | null>(),seals:new Map<string,SealProofV2>(),
    revisions: new Map<string, Revision>(), candidates: new Map<string, Revision>(), copies: new Map<string, Copy[]>(),
    sources: new Map<string, Map<string, BlobRef>>(), eventSources: new Map<string, Map<string, SlotRef>>(),
    heads: new Map<string, Set<string>>(), retired: new Set<string>(), rejected: new Set<string>(),
    revisionEvents: new Map<string, Set<string>>(), bootstrapFiles: new Map<string,Set<string>>(),
    waiting: new Map<string, Set<string>>(), waitKeys: new Map<string, Set<string>>(), issues: new Map<string, IssueV2>(),
    bodyStates: new Map<string, 'unchecked' | 'verified' | 'missing' | 'corrupt'>(), canonicalStarted: false };
}
export type HistoryIndexV2 = ReturnType<typeof createHistoryIndex>;
export function equivalentHeads(heads: Revision[]): boolean {
  if (!heads.length) return false; const first = heads[0].core.value;
  return heads.every(({ core: { value } }) => value.kind === first.kind && value.path === first.path
    && (value.kind === 'tombstone' || first.kind === 'file' && value.hash === first.hash && value.size === first.size));
}
export function selectHistory(index: HistoryIndexV2, eventIds: Set<string>): HistoryIndexV2 {
  const selected = createHistoryIndex(index.repositoryId); selected.sources = index.sources; selected.bodyStates = index.bodyStates; selected.eventSources = index.eventSources;
  for (const id of eventIds) { const e = index.events.get(id); if (!e) throw new Error('Boundary event is not admitted.'); selected.events.set(id,e); selected.proposals.set(id,e);
    for (const r of e.core.revisions) { selected.revisions.set(r.id,r); selected.candidates.set(r.id,r); const emitters=selected.revisionEvents.get(r.id)??new Set<string>();emitters.add(id);selected.revisionEvents.set(r.id,emitters);
      if(!r.core.parents.length&&r.core.operation==='bootstrap'){const paths=selected.bootstrapFiles.get(r.core.fileId)??new Set<string>();paths.add(portablePathKey(r.core.value.path));selected.bootstrapFiles.set(r.core.fileId,paths);}
      const heads=selected.heads.get(r.core.fileId)??new Set<string>();for(const p of r.core.parents){selected.retired.add(p);heads.delete(p)}if(!selected.retired.has(r.id))heads.add(r.id);selected.heads.set(r.core.fileId,heads);
    }
  }
  for(const r of selected.revisions.values())if([...r.core.parents,...(r.core.recreates?.tombstones??[])].some(id=>!selected.revisions.has(id)))throw new Error('Boundary ancestry is incomplete.');
  selected.canonicalStarted=index.canonicalStarted;return selected;
}
const digest = (v: unknown) => hashBytes(canonicalBytes(v).buffer);
export async function ingestContainers(index: HistoryIndexV2, containers: StoredContainerV2[]) {
  const queue: string[] = [], queued = new Set<string>(), newlyAdmitted: EventRecord[] = [];
  const enqueue = (id: string) => { if (!queued.has(id)) { queue.push(id); queued.add(id); } };
  const wake = (key: string) => { for (const id of index.waiting.get(key) ?? []) enqueue(id); };
  const issue = (id: string, code: IssueV2['code']) => index.issues.set(id, { kind: 'metadata', code, relatedIds: [id] });
  for (const stored of containers) {
    const c = stored.decoded;
    if (c.repositoryId !== index.repositoryId || stored.slot.hash !== c.hash) { issue(stored.slot.hash, 'Corrupt'); continue; }
    index.containers.set(stored.slot.path, stored);
    for (const b of c.sources) {
      const refs = index.sources.get(b.hash) ?? new Map<string, BlobRef>(); refs.set(b.slot.path, b); index.sources.set(b.hash, refs); wake('source:' + b.hash);
    }
    const validated: EventRecord[] = [];
    for (const raw of c.events) {
      try {
        const e = await validateEvent(raw, index.repositoryId); validated.push(e);
        index.proposals.set(e.id, e);
        for (const r of e.core.revisions) index.candidates.set(r.id, r);
        wake('event:' + e.id);
      } catch { issue(stored.slot.hash, 'Corrupt'); }
    }
    const localRevisions = new Set(validated.flatMap(e => e.core.revisions.map(r => r.id)));
    for (const e of validated) {
      const copies = index.copies.get(e.id) ?? [];
      if (!copies.some(copy => copy.stored.slot.path === stored.slot.path)) copies.push({ stored, event: e, localRevisions, invalid: false });
      index.copies.set(e.id, copies); enqueue(e.id);
    }
    if (c.issues.length) issue(stored.slot.hash, 'Corrupt');
  }
  function clearWaits(id: string) {
    for (const key of index.waitKeys.get(id) ?? []) { const set = index.waiting.get(key); set?.delete(id); if (!set?.size) index.waiting.delete(key); }
    index.waitKeys.delete(id);
  }
  function wait(id: string, keys: Set<string>) {
    index.waitKeys.set(id, keys);
    for (const key of keys) { const set = index.waiting.get(key) ?? new Set<string>(); set.add(id); index.waiting.set(key, set); }
  }
  for (let at = 0; at < queue.length; at++) {
    const id = queue[at]; queued.delete(id); clearWaits(id);
    if (index.rejected.has(id)) continue;
    const event = index.proposals.get(id)!; const pending = new Set<string>(); let usable = false;
    for (const copy of index.copies.get(id) ?? []) {
      if (copy.invalid) continue;
      const needed = new Set<string>(); let bad = false;
      for (const r of event.core.revisions) {
        if (r.core.value.kind === 'file' && ![...(index.sources.get(r.core.value.hash)?.values() ?? [])].some(b => b.size === (r.core.value as { size: number }).size)) needed.add('source:' + r.core.value.hash);
        for (const ref of [...r.core.parents, ...(r.core.recreates?.tombstones ?? [])]) {
          if (copy.localRevisions.has(ref)) continue;
          const hints = copy.stored.decoded.dependencies.filter(d => d.revisionId === ref);
          if (!hints.length) { bad = true; continue; }
          if (!hints.some(h => index.proposals.get(h.event.eventId)?.core.revisions.some(p => p.id === ref))) {
            const unknown = hints.filter(h => !index.proposals.has(h.event.eventId));
            if (!unknown.length) bad = true;
            else for (const h of unknown) needed.add('event:' + h.event.eventId);
          }
        }
      }
      if (bad) { copy.invalid = true; issue(copy.stored.slot.hash, 'Corrupt'); continue; }
      if (!needed.size) {
        usable = true; const refs = index.eventSources.get(id) ?? new Map<string, SlotRef>(); refs.set(copy.stored.slot.path, copy.stored.slot); index.eventSources.set(id, refs);
      } else for (const key of needed) pending.add(key);
    }
    if (!usable) { wait(id, pending); continue; }
    if (index.events.has(id)) continue;
    pending.clear(); let badCore = false;
    const own = new Map(event.core.revisions.map(r => [r.id, r]));
    for (const r of event.core.revisions) {
      for (const parent of [...r.core.parents, ...(r.core.recreates?.tombstones ?? [])]) {
        const candidate = index.candidates.get(parent);
        if (candidate && (r.core.parents.includes(parent) ? candidate.core.fileId !== r.core.fileId || parent === r.id
          : candidate.core.fileId !== r.core.recreates?.oldFileId || candidate.core.value.kind !== 'tombstone')) badCore = true;
        if (!index.revisions.has(parent) && !own.has(parent)) pending.add('revision:' + parent);
      }
    }
    if (badCore) { index.rejected.add(id); issue(id, 'Corrupt'); continue; }
    if (pending.size) { wait(id, pending); continue; }
    // The whole semantic event enters together. No filesystem transaction is implied.
    index.events.set(id, event); newlyAdmitted.push(event);
    for (const r of event.core.revisions) {
      index.revisions.set(r.id, r);
      const emitters = index.revisionEvents.get(r.id) ?? new Set<string>(); emitters.add(id); index.revisionEvents.set(r.id, emitters);
      if (!r.core.parents.length && r.core.operation === 'bootstrap') {const paths=index.bootstrapFiles.get(r.core.fileId)??new Set<string>();paths.add(portablePathKey(r.core.value.path));index.bootstrapFiles.set(r.core.fileId,paths);}
      const heads = index.heads.get(r.core.fileId) ?? new Set<string>();
      for (const parent of r.core.parents) { index.retired.add(parent); heads.delete(parent); }
      if (!index.retired.has(r.id)) heads.add(r.id); index.heads.set(r.core.fileId, heads); wake('revision:' + r.id);
    }
  }
  const pendingEvents = [...index.proposals.keys()].filter(id => !index.events.has(id)).sort();
  const pendingRevisions = [...index.waiting.keys()].filter(k => k.startsWith('revision:')).map(k => k.slice(9)).sort();
  const locatorEvents: EventRef[] = [];
  for (const copies of index.copies.values()) for (const copy of copies) if (!copy.invalid && !index.events.has(copy.event.id)) {
    for (const ref of copy.stored.decoded.dependencies) if (!index.proposals.has(ref.event.eventId)) locatorEvents.push(ref.event);
  }
  return { admitted: newlyAdmitted, pendingEvents, pendingRevisions, locatorEvents, issues: [...index.issues.values()] };
}
function ancestors(index: HistoryIndexV2, starts: string[]): Set<string> {
  const seen = new Set<string>(), stack = [...starts];
  while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; const r = index.revisions.get(id); if (!r) throw new Error('Unadmitted ancestry.'); seen.add(id); stack.push(...r.core.parents); }
  return seen;
}
export function bestCommonAncestors(fileId: string, heads: string[], index: HistoryIndexV2): string[] {
  if (!heads.length) return [];
  if (heads.some(id => index.revisions.get(id)?.core.fileId !== fileId)) throw new Error('Invalid ancestry scope.');
  let common = ancestors(index, [heads[0]]);
  for (const head of heads.slice(1)) { const set = ancestors(index, [head]); common = new Set([...common].filter(id => set.has(id))); }
  const retired = new Set<string>();
  for (const id of common) for (const parent of index.revisions.get(id)!.core.parents) if (common.has(parent)) retired.add(parent);
  return [...common].filter(id => !retired.has(id)).sort();
}
function acknowledgesHistory(index: HistoryIndexV2, live: Revision, oldId: string): boolean {
  // Only an explicit multi-identity user resolution can acknowledge a vacated/deleted identity.
  for (const id of ancestors(index, [live.id])) {
    const r = index.revisions.get(id)!;
    if (r.core.operation !== 'resolve' || r.core.value.kind !== 'file' || r.core.value.path !== live.core.value.path) continue;
    for (const e of index.revisionEvents.get(id) ?? []) if (index.events.get(e)!.core.revisions.some(other => other.core.fileId === oldId && other.core.operation === 'resolve'
      && (other.core.value.kind === 'tombstone' || portablePathKey(other.core.value.path) !== portablePathKey(live.core.value.path)))) return true;
  }
  return false;
}
export async function reduceHistory(index: HistoryIndexV2): Promise<RemoteViewV2> {
  const headsByFile = Object.fromEntries([...index.heads].sort(([a], [b]) => a < b ? -1 : 1).map(([fileId, ids]) => [fileId, [...ids].sort().map(id => index.revisions.get(id)!)]));
  const conflicts: ConflictV2[] = [];
  for (const [fileId, variants] of Object.entries(headsByFile)) if (variants.length > 1 && !equivalentHeads(variants)) {
    conflicts.push({ id: await digest({ repositoryId: index.repositoryId, fileId, variants: variants.map(r => r.id) }), fileId, variants,
      reason: variants.some(r => r.core.value.kind === 'file') && variants.some(r => r.core.value.kind === 'tombstone') ? 'delete-edit' : 'concurrent-versions',
      baseCandidates: bestCommonAncestors(fileId, variants.map(r => r.id), index) });
  }
  type Claim = { fileId: string; path: string };
  const nodes = new Map<string, { spellings: Set<string>; claims: Claim[]; terminal: Claim[] }>();
  const live = Object.values(headsByFile).flat().filter(r => r.core.value.kind === 'file');
  for (const r of live) {
    const parts = r.core.value.path.split('/'), claim = { fileId: r.core.fileId, path: r.core.value.path };
    for (let n = 1; n <= parts.length; n++) { const spelling = parts.slice(0, n).join('/'), key = portablePathKey(spelling);
      const node = nodes.get(key) ?? { spellings: new Set<string>(), claims: [], terminal: [] }; node.spellings.add(spelling); node.claims.push(claim);
      if (n === parts.length) node.terminal.push(claim); nodes.set(key, node);
    }
  }
  const pathConflicts: PathConflictV2[] = [];
  async function addPath(key: string, claims: Claim[], reason: string) {
    const fileIds = [...new Set(claims.map(c => c.fileId))].sort(), paths = [...new Set(claims.map(c => c.path))].sort();
    pathConflicts.push({ id: await digest({ repositoryId: index.repositoryId, key, fileIds, paths, reason }), fileIds, paths, reason });
  }
  for (const [key, node] of nodes) {
    if (node.spellings.size > 1) await addPath(key, node.claims, 'path-alias');
    else if (new Set(node.terminal.map(c => c.fileId)).size > 1) await addPath(key, node.claims, 'identity-collision');
    else if (node.terminal.length && node.claims.length > node.terminal.length) await addPath(key, node.claims, 'file-directory');
  }
  const history = new Map<string, Map<string, RemoteViewV2['pathHistory'][string][number]>>();
  for (const r of index.revisions.values()) {
    const key = portablePathKey(r.core.value.path), claims = history.get(key) ?? new Map();
    const claimKey = `${r.core.fileId}:${r.core.value.kind}:${r.core.value.path}${r.core.value.kind==='tombstone'?':'+r.id:''}`, prior = claims.get(claimKey);
    if (!prior || r.id < prior.revisionId) claims.set(claimKey, { fileId: r.core.fileId, revisionId: r.id, kind: r.core.value.kind, path: r.core.value.path }); history.set(key, claims);
  }
  const pathHistory = Object.fromEntries([...history].map(([key, claims]) => [key, [...claims.values()].sort((a, b) => a.revisionId < b.revisionId ? -1 : 1)]));
  for (const r of live) if (index.bootstrapFiles.get(r.core.fileId)?.has(portablePathKey(r.core.value.path))) {
    const key = portablePathKey(r.core.value.path), currentOwners = new Set(nodes.get(key)?.terminal.map(c => c.fileId));
    const others = (pathHistory[key] ?? []).filter(c => c.fileId !== r.core.fileId && !currentOwners.has(c.fileId) && !acknowledgesHistory(index, r, c.fileId));
    if (others.length) await addPath(key, [{ fileId: r.core.fileId, path: r.core.value.path }, ...others], 'unknown-history');
  }
  const admittedEventIds = [...index.events.keys()].sort(), pendingEvents = [...index.proposals.keys()].filter(id => !index.events.has(id)).sort();
  const pendingDependencies = [...index.waiting.keys()].filter(k => k.startsWith('revision:')).map(k => k.slice(9)).sort();
  const gaps = [...new Set([...index.events.values()].flatMap(e => e.core.previous && !index.proposals.has(e.core.previous) ? [e.core.previous] : []))];
  const issues = [...index.issues.values(), ...gaps.map(id => ({ kind: 'metadata' as const, code: 'Incomplete' as const, relatedIds: [id] }))];
  const bodyStates = Object.fromEntries([...index.sources.keys()].map(hash => [hash, index.bodyStates.get(hash) ?? 'unchecked']));
  return { fingerprint: await digest(admittedEventIds), admittedEventIds, headsByFile, conflicts, pathConflicts: pathConflicts.sort((a, b) => a.id < b.id ? -1 : 1),
    pendingDependencies, bodyStates, pathHistory, coverage: { canonicalStarted: index.canonicalStarted, pendingEvents: [...new Set([...pendingEvents, ...gaps])].sort(), pendingRevisions: pendingDependencies, issues } };
}
export function adoptLocal(snapshot: LocalSnapshot, view: RemoteViewV2, creationProofs: CreationProofV2[]): AdoptionPlanV2 {
  const plan: AdoptionPlanV2 = { adoptions: [], branches: [], births: [], quarantined: [] };
  assertPortablePaths(Object.values(snapshot.files).map(f => f.path));
  for (const file of Object.values(snapshot.files)) {
    if (snapshot.policy && classifyPath(file.path, snapshot.policy) === 'exclude') continue;
    const proof = creationProofs.find(p => p.path === file.path), key = portablePathKey(file.path);
      if(proof) {
        const recreated=proof.afterTombstone, historical=view.pathHistory[key] ?? [];
        if(recreated && !recreated.tombstones.every(id=>historical.some(r=>r.revisionId===id && r.fileId===recreated.oldFileId && r.kind==='tombstone'))) {
          plan.quarantined.push({path:file.path,fileIds:[recreated.oldFileId],reason:'unknown-recreation-proof'});continue;
        }
        plan.births.push({fileId:crypto.randomUUID(),path:file.path,parents:[],operation:recreated?'recreate':'create',recreates:recreated?structuredClone(recreated):null});continue;
      }
    const collisions = view.pathConflicts.filter(c => c.paths.some(path => portablePathKey(path) === key || key.startsWith(portablePathKey(path) + '/') || portablePathKey(path).startsWith(key + '/')));
    const identities = Object.entries(view.headsByFile).filter(([, heads]) => heads.some(r => portablePathKey(r.core.value.path) === key));
    const quarantine = (reason: string, ids: string[]) => plan.quarantined.push({ path: file.path, fileIds: [...new Set(ids)].sort(), reason });
    if (collisions.length || identities.length > 1) { quarantine('path-conflict', [...collisions.flatMap(c => c.fileIds), ...identities.map(([id]) => id)]); continue; }
    if (identities.length === 1) {
      const [fileId, heads] = identities[0];
      if (heads.every(r => r.core.value.kind === 'tombstone')) {
        quarantine('unknown-copy-after-delete', [fileId]);
      } else {
        const matching = heads.filter(r => r.core.value.kind === 'file' && r.core.value.path === file.path && r.core.value.hash === file.hash && r.core.value.size === file.size);
        if (matching.length) plan.adoptions.push({ fileId, revisionIds: matching.map(r => r.id).sort(), value: matching[0].core.value, baseHash: file.hash, dirtyGeneration: file.generation ?? 0 });
        else if (heads.every(r => r.core.value.path === file.path)) plan.branches.push({ fileId, path: file.path, operation: 'bootstrap', parents: [] });
        else quarantine('ambiguous-identity', [fileId]);
      }
      continue;
    }
    const historical = view.pathHistory[key] ?? [];
    if (historical.length && !proof) { quarantine('historical-path', historical.map(c => c.fileId)); continue; }
    plan.births.push({ fileId: crypto.randomUUID(), path: file.path, parents: [], operation: proof ? 'create' : 'bootstrap', recreates: null });
  }
  return plan;
}
