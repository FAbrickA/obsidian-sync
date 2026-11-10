import { bestCommonAncestors } from './v2-history.ts';
import type { HistoryIndexV2 } from './v2-history.ts';
import { revisionId, encodeRevision } from './v2-codec.ts';
import { hashBytes, canonicalBytes } from './snapshots.ts';
import { mergeBackground } from './v2-merge-worker.ts';
import { validateBookmarks } from './bookmarks.ts';
import { bookmarksKey } from './paths.ts';
import { limitsV2 } from './v2-types.ts';
import type { Revision, RevisionCore, V2Value } from './v2-types.ts';
export type MergeDecisionV2 = { kind: 'join' | 'merged'; core: RevisionCore; bytes: ArrayBuffer | null; existingRevisionId: string | null }
  | { kind: 'conflict'; reason: string; variants: Revision[]; baseCandidates: string[] };
export type ResolutionChoiceV2 = { kind: 'variant'; revisionId: string } | { kind: 'edit'; path: string; bytes: ArrayBuffer } | { kind: 'delete'; path: string };
export async function mergeHeads(fileId: string, input: Revision[], index: HistoryIndexV2,
  readBytes: (hash: string) => Promise<ArrayBuffer>): Promise<MergeDecisionV2> {
  const heads = [...new Map(input.map(r => [r.id, r])).values()].sort((a, b) => a.id < b.id ? -1 : 1);
  if (heads.some(r => r.core.fileId !== fileId || !index.revisions.has(r.id))) throw new Error('Invalid merge scope.');
  const conflict = (reason: string, baseCandidates: string[] = []): MergeDecisionV2 => ({ kind: 'conflict', reason, variants: heads, baseCandidates });
  if (heads.length < 2) return conflict('not-concurrent');
  if (heads.length > limitsV2.mergeVariants) return conflict('variant-limit');
  async function proposed(kind: 'join' | 'merged', value: V2Value, bytes: ArrayBuffer | null): Promise<MergeDecisionV2> {
    const core: RevisionCore = { schema: 2, repositoryId: index.repositoryId, fileId, parents: heads.map(r => r.id), value,
      operation: 'merge', algorithmVersion: 1, recreates: null };
    const id = await revisionId(core); return { kind, core, bytes, existingRevisionId: index.revisions.has(id) ? id : null };
  }
  const first = new TextDecoder().decode(canonicalBytes(heads[0].core.value));
  if (heads.every(r => new TextDecoder().decode(canonicalBytes(r.core.value)) === first)) return proposed('join', structuredClone(heads[0].core.value), null);
  if (heads.some(r => r.core.value.kind === 'tombstone')) return conflict('delete-edit');
  const bases = bestCommonAncestors(fileId, heads.map(r => r.id), index);
  if (bases.length !== 1) return conflict(bases.length ? 'multiple-bases' : 'no-base', bases);
  const ancestor = index.revisions.get(bases[0])!.core.value;
  if (ancestor.kind !== 'file') return conflict('non-file-base', bases);
  const changedPaths = [...new Set(heads.map(r => r.core.value.path).filter(p => p !== ancestor.path))];
  if (changedPaths.length > 1) return conflict('rename-rename', bases);
  const path = changedPaths[0] ?? ancestor.path;
  if (path !== bookmarksKey && !path.toLowerCase().endsWith('.md')) {
    const changed = new Map(heads.flatMap(r => r.core.value.kind === 'file' && (r.core.value.hash !== ancestor.hash || r.core.value.size !== ancestor.size)
      ? [[`${r.core.value.hash}:${r.core.value.size}`, r.core.value] as const] : []));
    if (changed.size > 1) return conflict('binary-change', bases);
    const content = [...changed.values()][0] ?? ancestor;
    return proposed('merged', { kind: 'file', path, hash: content.hash, size: content.size }, null);
  }
  if (heads.some(r => r.core.value.kind === 'file' && r.core.value.size > limitsV2.mergeInputBytes) || ancestor.size > limitsV2.mergeInputBytes
    || heads.reduce((n, r) => n + (r.core.value.kind === 'file' ? r.core.value.size : 0), ancestor.size) > limitsV2.mergeTotalBytes) return conflict('input-limit', bases);
  async function read(value: V2Value): Promise<ArrayBuffer> {
    if (value.kind !== 'file') throw new Error('Not a file.');
    const bytes = (await readBytes(value.hash)).slice(0); if (bytes.byteLength !== value.size || await hashBytes(bytes) !== value.hash) throw new Error('Unverified merge input.'); return bytes;
  }
  let baseBytes: ArrayBuffer, variants: ArrayBuffer[];
  try { baseBytes = await read(ancestor); variants = []; for (const head of heads) variants.push(await read(head.core.value)); }
  catch { return conflict('unavailable-source', bases); }
  let result;try{result=await mergeBackground(path===bookmarksKey?'bookmarks':'markdown',baseBytes,variants);}catch{return conflict('worker-unavailable',bases);}
  if (result.kind === 'conflict') return conflict(result.reason, bases);
  return proposed('merged', { kind: 'file', path, hash: await hashBytes(result.bytes), size: result.bytes.byteLength }, result.bytes);
}
export async function resolveHeads(fileId: string, reviewedIds: string[], choice: ResolutionChoiceV2, index: HistoryIndexV2): Promise<RevisionCore> {
  reviewedIds = [...reviewedIds];
  if (!reviewedIds.length || reviewedIds.length > limitsV2.parents || new Set(reviewedIds).size !== reviewedIds.length
    || reviewedIds.some(id => index.revisions.get(id)?.core.fileId !== fileId)) throw new Error('Invalid reviewed variants.');
  let value: V2Value;
  if (choice.kind === 'variant') {
    if (!reviewedIds.includes(choice.revisionId)) throw new Error('Variant was not reviewed.'); value = structuredClone(index.revisions.get(choice.revisionId)!.core.value);
  } else if (choice.kind === 'delete') value = { kind: 'tombstone', path: choice.path };
  else {
    const bytes = choice.bytes.slice(0); if (choice.path === bookmarksKey) validateBookmarks(bytes);
    value = { kind: 'file', path: choice.path, hash: await hashBytes(bytes), size: bytes.byteLength };
  }
  const core: RevisionCore = { schema: 2, repositoryId: index.repositoryId, fileId, parents: [...reviewedIds].sort(), value,
    operation: 'resolve', algorithmVersion: null, recreates: null };
  encodeRevision(core); return core;
}
