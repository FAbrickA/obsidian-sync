// Read-only format support for explicit export of a v1 repository.
import type {Hash,RepositoryId,Entry} from './types.ts';
import {canonicalBytes,validHash} from './snapshots.ts';
import {normalizeRelativePath,assertPortablePaths} from './paths.ts';
export type Conflict = { fileId: string; base: Hash | null; local: Hash | null; remote: Hash | null; reason: string;
  basePath?: string; localPath?: string; remotePath?: string };
export type Manifest = { schema: 1; repositoryId: RepositoryId; generation: number; parent: Hash | null;
  deviceId: string; operationId: string; entries: Record<string, Entry>; conflicts: Record<string, Conflict>;
  resolutions?: Record<string, Conflict & { chosen: Hash | null }> };
export type Head = { schema: 1; repositoryId: RepositoryId; generation: number; commitId: Hash; publishId: string };

export const encodeManifest=(value:Manifest)=>canonicalBytes(value);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
function record(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid record.');
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, expected: string[]) {
  if (Object.keys(v).sort().join(',') !== expected.sort().join(',')) throw new Error('Invalid schema fields.');
}
export function validateManifest(bytes: ArrayBuffer | Uint8Array, repositoryId: string): Manifest {
  const m = record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
  keys(m, ['schema', 'repositoryId', 'generation', 'parent', 'deviceId', 'operationId', 'entries', 'conflicts', ...('resolutions' in m ? ['resolutions'] : [])]);
  if (m.schema !== 1 || m.repositoryId !== repositoryId || !id(m.repositoryId) || !id(m.deviceId) || !id(m.operationId)
    || !Number.isSafeInteger(m.generation) || (m.generation as number) < 0
    || (m.generation === 0 ? m.parent !== null : !validHash(m.parent))) throw new Error('Invalid manifest identity/ancestry.');
  const entries = record(m.entries);
  const live: string[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    const e = record(raw);
    if (!id(key) || e.fileId !== key || typeof e.path !== 'string') throw new Error('Invalid file identity.');
    normalizeRelativePath(e.path);
    if (e.kind === 'file') {
      keys(e, ['kind', 'fileId', 'path', 'hash', 'size']);
      if (!validHash(e.hash) || !Number.isSafeInteger(e.size) || (e.size as number) < 0) throw new Error('Invalid file snapshot.');
      live.push(e.path);
    } else if (e.kind === 'tombstone') {
      keys(e, ['kind', 'fileId', 'path', 'lastHash']);
      if (!validHash(e.lastHash)) throw new Error('Missing deleted version.');
    }
    else throw new Error('Unknown entry kind.');
  }
  assertPortablePaths(live);
  const conflicts = record(m.conflicts); const resolutions = 'resolutions' in m ? record(m.resolutions) : undefined;
  for (const [key, raw, resolved] of [...Object.entries(conflicts).map(([k,v]) => [k,v,false] as const), ...Object.entries(resolutions ?? {}).map(([k,v]) => [k,v,true] as const)]) {
    const c = record(raw);
    keys(c, ['fileId', 'base', 'local', 'remote', 'reason', ...['basePath', 'localPath', 'remotePath'].filter(k => k in c), ...(resolved ? ['chosen'] : [])]);
    for (const field of ['basePath', 'localPath', 'remotePath']) if (field in c) { if (typeof c[field] !== 'string') throw new Error('Invalid conflict path.'); normalizeRelativePath(c[field] as string); }
    if (resolved && c.chosen !== null && !validHash(c.chosen)) throw new Error('Invalid resolution.');
    if (!id(key) || typeof c.fileId !== 'string' || !Object.prototype.hasOwnProperty.call(entries, c.fileId)
      || ![c.base, c.local, c.remote].every(x => x === null || validHash(x))
      || typeof c.reason !== 'string' || c.reason.length > 128) throw new Error('Invalid conflict reference.');
  }
  return { schema: 1, repositoryId, generation: m.generation as number, parent: m.parent as Hash | null,
    deviceId: m.deviceId as string, operationId: m.operationId as string,
    entries: entries as Record<string, Entry>, conflicts: conflicts as Record<string, Conflict>,
    ...(resolutions ? { resolutions: resolutions as NonNullable<Manifest['resolutions']> } : {}) };
}
