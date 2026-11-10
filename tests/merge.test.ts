import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMarkdown, makeConflictId } from '../src/merge.ts';
const b = (s: string) => new TextEncoder().encode(s).buffer;
const text = (x: ArrayBuffer) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(x);
test('independent edits merge cleanly with exact line separators and BOM', () => {
  for (const newline of ['\n', '\r\n', '\r']) for (const bom of ['', '\ufeff']) for (const final of ['', newline]) {
    const base = b(bom + ['a', 'b', 'c', 'd', 'e'].join(newline) + final);
    const left = b(bom + ['A', 'b', 'c', 'd', 'e'].join(newline) + final);
    const right = b(bom + ['a', 'b', 'c', 'd', 'E'].join(newline) + final);
    const result = mergeMarkdown(base, left, right);
    assert.equal(result.kind, 'clean');
    if (result.kind === 'clean') assert.equal(text(result.bytes), bom + ['A', 'b', 'c', 'd', 'E'].join(newline) + final);
  }
});
test('overlap, absent ancestor, invalid encoding and input limit preserve versions as conflict', () => {
  for (const [base, left, right] of [
    [b('a\n'), b('left\n'), b('right\n')], [null, b('left'), b('right')],
    [b('a'), new Uint8Array([255]).buffer, b('right')],
    [new ArrayBuffer(1000001), b('left'), b('right')],
    [b('a'), new ArrayBuffer(1000001), b('right')],
    [b('a'), b('left'), new ArrayBuffer(1000001)],
  ] as const) {
    const result = mergeMarkdown(base, left, right); assert.equal(result.kind, 'conflict');
    if (result.kind === 'conflict') { assert.deepEqual(result.base, base); assert.deepEqual(result.local, left); assert.deepEqual(result.remote, right); }
  }
});
test('identical bytes, empty edits and marker-looking user text retain their meaning', () => {
  for (const [base, local, remote, expected] of [
    [null, '', '', ''], ['old\n', '', 'old\n', ''],
    ['old\n', '<<<<<<< user\n', 'old\n', '<<<<<<< user\n'],
    ['a\n', 'a', 'a\n', 'a'],
  ] as const) {
    const result = mergeMarkdown(base === null ? null : b(base), b(local), b(remote));
    assert.equal(result.kind, 'clean'); if (result.kind === 'clean') assert.equal(text(result.bytes), expected);
  }
});
test('conflict snapshots are detached copies and IDs are stable including deletion sides', async () => {
  const left = b('left'); const result = mergeMarkdown(null, left, b('right'));
  new Uint8Array(left).fill(0);
  assert.equal(result.kind, 'conflict'); if (result.kind === 'conflict') assert.equal(text(result.local), 'left');
  assert.equal(await makeConflictId('f', null, 'a'.repeat(64), null), await makeConflictId('f', null, 'a'.repeat(64), null));
  assert.notEqual(await makeConflictId('f', null, 'a'.repeat(64), null), await makeConflictId('g', null, 'a'.repeat(64), null));
});
