import { diff3Merge, diffIndices } from 'node-diff3';
import { limitsV2 } from './v2-types.ts';
import type { Hash, MergeResult } from './types.ts';
import { canonicalBytes, hashBytes, validHash } from './snapshots.ts';
const equal = (a: ArrayBuffer, b: ArrayBuffer) => {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a), right = new Uint8Array(b);
  return left.every((v, i) => v === right[i]);
};
const lines = (text: string) => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
export type ManyMergeResult = { kind: 'clean'; bytes: ArrayBuffer } | { kind: 'conflict'; reason: string; base: ArrayBuffer | null; variants: ArrayBuffer[] };
export function mergeMarkdownMany(base: ArrayBuffer | null, variants: ArrayBuffer[]): ManyMergeResult {
  const conflict = (reason: string): ManyMergeResult => ({ kind: 'conflict', reason, base: base?.slice(0) ?? null, variants: variants.map(v => v.slice(0)) });
  if (!variants.length || variants.length > limitsV2.mergeVariants || [base, ...variants].some(v => v && v.byteLength > limitsV2.mergeInputBytes)
    || variants.reduce((n, v) => n + v.byteLength, base?.byteLength ?? 0) > limitsV2.mergeTotalBytes) return conflict('input-limit');
  let inputs: string[], ancestor: string | null;
  try { const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); inputs = variants.map(v => decoder.decode(v)); ancestor = base === null ? null : decoder.decode(base); }
  catch { return conflict('invalid-utf8'); }
  if (variants.every(v => equal(v, variants[0]))) return { kind: 'clean', bytes: variants[0].slice(0) };
  if (ancestor === null) return conflict('no-base');
  const original = lines(ancestor), patches = new Map<string, { at: number; length: number; replacement: string[] }>();
  for (const value of inputs) for (const diff of diffIndices(original, lines(value))) {
    const patch = { at: diff.buffer1[0], length: diff.buffer1[1], replacement: diff.buffer2Content };
    patches.set(JSON.stringify(patch), patch);
  }
  const sorted = [...patches.values()].sort((a, b) => a.at - b.at || a.length - b.length);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i], endA = a.at + a.length, endB = b.at + b.length;
    const overlap = !a.length && !b.length ? a.at === b.at : !a.length ? a.at >= b.at && a.at <= endB
      : !b.length ? b.at >= a.at && b.at <= endA : Math.max(a.at, b.at) < Math.min(endA, endB);
    if (overlap) return conflict('overlap');
  }
  // Base-relative forward output avoids shifted offsets and large spread/splice calls.
  const output: string[] = []; let cursor = 0;
  for (const patch of sorted) { while (cursor < patch.at) output.push(original[cursor++]); for (const line of patch.replacement) output.push(line); cursor = patch.at + patch.length; }
  while (cursor < original.length) output.push(original[cursor++]);
  return { kind: 'clean', bytes: new TextEncoder().encode(output.join('')).buffer };
}
export function mergeMarkdown(base: ArrayBuffer | null, local: ArrayBuffer, remote: ArrayBuffer): MergeResult {
  const conflict = (reason: string): MergeResult => ({ kind: 'conflict', reason,
    base: base?.slice(0) ?? null, local: local.slice(0), remote: remote.slice(0) });
  if ([base, local, remote].some(b => b && b.byteLength > 1_000_000)) return conflict('input-limit');
  let l: string, r: string, ancestor: string | null;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    l = decoder.decode(local); r = decoder.decode(remote); ancestor = base === null ? null : decoder.decode(base);
  } catch { return conflict('invalid-utf8'); }
  if (equal(local, remote)) return { kind: 'clean', bytes: local.slice(0) };
  if (base === null || ancestor === null) return conflict('no-base');
  if (equal(base, local)) return { kind: 'clean', bytes: remote.slice(0) };
  if (equal(base, remote)) return { kind: 'clean', bytes: local.slice(0) };
  // Tokens retain their separators. Marker-like text is ordinary data, never a merge protocol.
  const regions = diff3Merge(lines(l), lines(ancestor), lines(r), { excludeFalseConflicts: true });
  if (regions.some(region => region.conflict)) return conflict('overlap');
  return { kind: 'clean', bytes: new TextEncoder().encode(regions.flatMap(region => region.ok ?? []).join('')).buffer };
}
export async function makeConflictId(fileId: string, base: Hash | null, local: Hash | null, remote: Hash | null, context?: unknown): Promise<string> {
  if (!fileId || ![base, local, remote].every(hash => hash === null || validHash(hash))) throw new Error('Invalid conflict identity.');
  return hashBytes(canonicalBytes({ fileId, base, local, remote, ...(context === undefined ? {} : { context }) }).buffer);
}
