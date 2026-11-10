import { canonicalBytes, hashBytes, validHash } from './snapshots.ts';
import { assertPortablePaths, normalizeRelativePath } from './paths.ts';
import { limitsV2, metadataDirV2 } from './v2-types.ts';
import type { RevisionCore, Revision, SemanticEvent, EventRecord, SlotRef, BlobRef, EventRef, RevisionSource,
  DecodedContainer, IdentityRecord, SealRecord, HintRecord, IssueV2, ArchiveRecordV2 } from './v2-types.ts';

function invalid(): never { throw new Error('Invalid v2 metadata.'); }
export function v2Id(v: unknown): v is string { return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v); }
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) invalid();
  return v as Record<string, unknown>;
}
function fields(v: Record<string, unknown>, names: string[]) {
  if (Object.keys(v).sort().join(',') !== [...names].sort().join(',')) invalid();
}
function list(v: unknown, max: number, min = 0): unknown[] { if (!Array.isArray(v) || v.length > max || v.length < min) invalid(); return v; }
function hashes(v: unknown, max: number, min = 0): string[] {
  const a = list(v, max, min); if (!a.every(validHash) || new Set(a).size !== a.length) invalid(); return [...a].sort() as string[];
}
function size(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) >= 0; }
function json(bytes: ArrayBuffer | Uint8Array, max: number): unknown {
  if (bytes.byteLength > max) invalid();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
}
function bounded(value: unknown, max: number): Uint8Array<ArrayBuffer> { const bytes = canonicalBytes(value); if (bytes.byteLength > max) invalid(); return bytes; }
function revisionCore(raw: unknown): RevisionCore {
  const c = object(raw); fields(c, ['schema', 'repositoryId', 'fileId', 'parents', 'value', 'operation', 'algorithmVersion', 'recreates']);
  if (c.schema !== 2 || !v2Id(c.repositoryId) || !v2Id(c.fileId)) invalid();
  const parents = hashes(c.parents, limitsV2.parents), value = object(c.value);
  if (typeof value.path !== 'string') invalid(); assertPortablePaths([value.path]);
  if (value.kind === 'file') { fields(value, ['kind', 'path', 'hash', 'size']); if (!validHash(value.hash) || !size(value.size)) invalid(); }
  else if (value.kind === 'tombstone') fields(value, ['kind', 'path']); else invalid();
  const operations = ['create', 'bootstrap', 'edit', 'rename', 'delete', 'merge', 'resolve', 'restore', 'recreate'];
  if (!operations.includes(c.operation as string)) invalid();
  const birth = ['create', 'bootstrap', 'recreate'].includes(c.operation as string);
  if (birth ? parents.length !== 0 : parents.length === 0) invalid();
  if (c.operation === 'delete' && value.kind !== 'tombstone') invalid();
  if (['create', 'bootstrap', 'recreate', 'edit', 'rename', 'restore'].includes(c.operation as string) && value.kind !== 'file') invalid();
  if (c.operation === 'merge' ? c.algorithmVersion !== 1 : c.algorithmVersion !== null) invalid();
  let recreates: RevisionCore['recreates'] = null;
  if (c.operation === 'recreate') {
    const r = object(c.recreates); fields(r, ['oldFileId', 'tombstones']);
    if (!v2Id(r.oldFileId) || r.oldFileId === c.fileId) invalid();
    recreates = { oldFileId: r.oldFileId, tombstones: hashes(r.tombstones, limitsV2.parents, 1) };
  } else if (c.recreates !== null) invalid();
  return { ...c, parents, value: { ...value }, recreates } as RevisionCore;
}
export function encodeRevision(raw: unknown): Uint8Array<ArrayBuffer> { return bounded(revisionCore(raw), limitsV2.eventBytes); }
export async function revisionId(raw: unknown): Promise<string> { return hashBytes(encodeRevision(raw).buffer); }
function revision(raw: unknown): Revision {
  const r = object(raw); fields(r, ['id', 'core']); if (!validHash(r.id)) invalid();
  return { id: r.id, core: revisionCore(r.core) };
}
function semanticEvent(raw: unknown): SemanticEvent {
  const e = object(raw); fields(e, ['schema', 'repositoryId', 'deviceId', 'operationId', 'previous', 'revisions']);
  if (e.schema !== 2 || !v2Id(e.repositoryId) || !v2Id(e.deviceId) || !v2Id(e.operationId) || (e.previous !== null && !validHash(e.previous))) invalid();
  const revisions = list(e.revisions, limitsV2.revisions, 1).map(revision);
  if (revisions.some(r => r.core.repositoryId !== e.repositoryId) || new Set(revisions.map(r => r.core.fileId)).size !== revisions.length) invalid();
  revisions.sort((a, b) => a.core.fileId < b.core.fileId ? -1 : a.core.fileId > b.core.fileId ? 1 : 0);
  return { ...e, revisions } as SemanticEvent;
}
export function encodeEvent(raw: unknown): Uint8Array<ArrayBuffer> { return bounded(semanticEvent(raw), limitsV2.eventBytes); }
export async function eventId(raw: unknown): Promise<string> {
  const e = semanticEvent(raw);
  for (const r of e.revisions) if (r.id !== await revisionId(r.core)) invalid();
  return hashBytes(encodeEvent(e).buffer);
}
export async function validateEvent(raw: unknown, repoId: string): Promise<EventRecord> {
  const e = object(raw); fields(e, ['id', 'core']); if (!validHash(e.id)) invalid();
  const core = semanticEvent(e.core);
  if (core.repositoryId !== repoId || await eventId(core) !== e.id) invalid();
  return { id: e.id, core };
}
export function validateSlot(raw: unknown, repoId: string, kind?: 'blobs' | 'journal' | 'seals' | 'archives'): SlotRef {
  const s = object(raw); fields(s, ['path', 'hash', 'size']);
  if (!validHash(s.hash) || !size(s.size) || typeof s.path !== 'string' || !v2Id(repoId)) invalid();
  normalizeRelativePath(s.path);
  const prefix = `${metadataDirV2}/repos/${repoId}/`; if (!s.path.startsWith(prefix)) invalid();
  const p = s.path.slice(prefix.length).split('/'), filename = p[p.length - 1];
  const match = /^([a-zA-Z0-9_-]{1,128})\.([0-9a-f]{64})\.(bin|json)$/.exec(filename);
  if (!match || match[2] !== s.hash || !v2Id(match[1]) || (kind && p[0] !== kind)) invalid();
  if (p[0] === 'blobs') { if (p.length !== 3 || !v2Id(p[1]) || match[3] !== 'bin') invalid(); }
  else if (p[0] === 'journal') {
    if (p.length !== 5 || !v2Id(p[1]) || !/^(0|[1-9]\d*)$/.test(p[2]) || !size(Number(p[2])) || !v2Id(p[3]) || match[3] !== 'json') invalid();
  } else if (p[0] === 'seals') { if (p.length !== 3 || !v2Id(p[1]) || match[3] !== 'json') invalid(); }
    else if (p[0] === 'archives') { if (p.length !== 2 || match[3] !== 'json') invalid(); }
    else invalid();
  return { path: s.path, hash: s.hash, size: s.size };
}
function blob(raw: unknown, repoId: string): BlobRef {
  const b = object(raw); fields(b, ['hash', 'size', 'slot']); const slot = validateSlot(b.slot, repoId, 'blobs');
  if (b.hash !== slot.hash || b.size !== slot.size) invalid(); return { hash: slot.hash, size: slot.size, slot };
}
export async function decodeArchive(bytes:ArrayBuffer | Uint8Array,repoId:string):Promise<ArchiveRecordV2> {
  const a=object(json(bytes,65_536));fields(a,['schema','repositoryId','id','path','hash','size','origin','blob']);
  if(a.schema!==2 || a.repositoryId!==repoId || !v2Id(repoId) || typeof a.path!=='string' || !validHash(a.id)
    || !validHash(a.hash) || !size(a.size) || !['local-quarantine','projection-drift'].includes(String(a.origin)))invalid();
  assertPortablePaths([a.path]);const source=blob(a.blob,repoId);
  if(source.hash!==a.hash || source.size!==a.size || await hashBytes(canonicalBytes({schema:2,repositoryId:repoId,path:a.path,hash:a.hash,size:a.size,origin:a.origin}).buffer)!==a.id)invalid();
  return {...a,blob:source} as ArchiveRecordV2;
}
function eventRef(raw: unknown, repoId: string): EventRef {
  const e = object(raw); fields(e, ['eventId', 'containerSlots']); if (!validHash(e.eventId)) invalid();
  const containerSlots = list(e.containerSlots, 128, 1).map(s => validateSlot(s, repoId, 'journal'));
  if (new Set(containerSlots.map(s => s.path)).size !== containerSlots.length) invalid();
  return { eventId: e.eventId, containerSlots };
}
function dependency(raw: unknown, repoId: string): RevisionSource {
  const d = object(raw); fields(d, ['revisionId', 'event']); if (!validHash(d.revisionId)) invalid();
  return { revisionId: d.revisionId, event: eventRef(d.event, repoId) };
}
export async function decodeContainer(bytes: ArrayBuffer | Uint8Array, expectedHash: string, repoId: string): Promise<DecodedContainer> {
  if (!validHash(expectedHash) || bytes.byteLength > limitsV2.containerBytes
    || await hashBytes(new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.slice()).buffer as ArrayBuffer) !== expectedHash) invalid();
  const c = object(json(bytes, limitsV2.containerBytes)); fields(c, ['schema', 'repositoryId', 'events', 'sources', 'dependencies', 'previousSources']);
  if (c.schema !== 2 || c.repositoryId !== repoId || !v2Id(repoId)) invalid();
  const rawEvents = list(c.events, limitsV2.events, 1), sources = list(c.sources, 65_536).map(b => blob(b, repoId));
  const dependencies = list(c.dependencies, 65_536).map(d => dependency(d, repoId));
  const previousSources = list(c.previousSources, limitsV2.events).map(e => eventRef(e, repoId));
  const events: EventRecord[] = [], issues: IssueV2[] = [];
  for (const raw of rawEvents) {
    try { const event = await validateEvent(raw, repoId); if (!events.some(e => e.id === event.id)) events.push(event); }
    catch { issues.push({ kind: 'metadata', code: 'Corrupt', relatedIds: [] }); }
  }
  return { hash: expectedHash, repositoryId: repoId, events, sources, dependencies, previousSources, issues };
}
export function decodeIdentity(bytes: ArrayBuffer | Uint8Array): IdentityRecord {
  const i = object(json(bytes, 1024)); fields(i, ['schema', 'repositoryId']);
  if (i.schema !== 2 || !v2Id(i.repositoryId)) invalid(); return { schema: 2, repositoryId: i.repositoryId };
}
export function decodeSeal(bytes: ArrayBuffer | Uint8Array, repoId: string): SealRecord {
  const s = object(json(bytes, limitsV2.sealBytes)); fields(s, ['schema', 'repositoryId', 'segment', 'members']);
  const segment = object(s.segment); fields(segment, ['deviceId', 'group', 'segmentId']);
  if (s.schema !== 2 || s.repositoryId !== repoId || !v2Id(segment.deviceId) || !v2Id(segment.segmentId) || !size(segment.group)) invalid();
  const members = list(s.members, limitsV2.segmentEvents).map(e => eventRef(e, repoId));
  if (new Set(members.map(e => e.eventId)).size !== members.length || members.some((e,i)=>i>0&&members[i-1].eventId>=e.eventId)) invalid();
  return { schema: 2, repositoryId: repoId, segment: segment as SealRecord['segment'], members };
}
export function decodeHint(bytes: ArrayBuffer | Uint8Array, repoId: string): HintRecord {
  const h = object(json(bytes, limitsV2.containerBytes)); fields(h, ['schema', 'repositoryId', 'deviceId', 'tip']);
  if (h.schema !== 2 || h.repositoryId !== repoId || !v2Id(h.deviceId)) invalid();
  return { schema: 2, repositoryId: repoId, deviceId: h.deviceId, tip: h.tip === null ? null : eventRef(h.tip, repoId) };
}
