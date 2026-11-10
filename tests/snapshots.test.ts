import { test } from 'node:test';
import assert from 'node:assert/strict';
import {hashBytes} from '../src/snapshots.ts';
import {encodeManifest,validateManifest} from '../src/v1-format.ts';
import type { Manifest } from '../src/v1-format.ts';

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const hash = 'a'.repeat(64);
const manifest: Manifest = { schema: 1, repositoryId: 'repo-1', generation: 0, parent: null, deviceId: 'device-1', operationId: 'bootstrap', entries: {
  f1: { fileId: 'f1', path: 'Note.md', kind: 'file', hash, size: 4 },
}, conflicts: {} };
test('snapshots hash original bytes; deterministic JSON ignores insertion order', async () => {
  assert.notEqual(await hashBytes(bytes('AAAA')), await hashBytes(bytes('BBBB')));
  assert.deepEqual(encodeManifest(manifest), encodeManifest({ ...manifest, entries: { f1: { size: 4, hash, kind: 'file', path: 'Note.md', fileId: 'f1' } } }));
  assert.deepEqual(validateManifest(encodeManifest(manifest), 'repo-1'), manifest);
});
test('manifest validation fails closed on identity, graph, schema, hash and path collisions', () => {
  const check = (m: unknown) => validateManifest(bytes(JSON.stringify(m)), 'repo-1');
  for (const patch of [{ schema: 2 }, { repositoryId: 'other' }, { generation: -1 }, { parent: hash },
    { entries: { f1: { ...manifest.entries.f1, hash: 'bad' } } },
    { entries: { f1: manifest.entries.f1, f2: { ...manifest.entries.f1, fileId: 'f2', path: 'note.md' } } },
    { entries: { f1: { ...manifest.entries.f1, path: '.webdav-sync/HEAD' } } },
    { conflicts: { c1: { fileId: 'missing', base: null, local: hash, remote: hash, reason: 'overlap' } } },
  ]) assert.throws(() => check({ ...manifest, ...patch }), JSON.stringify(patch));
  assert.throws(() => validateManifest(new Uint8Array([255]), 'repo-1'));
});
test('a tombstone may share a live path; two live file identities may not', () => {
  const m: Manifest = { ...manifest, generation: 1, parent: hash, entries: { ...manifest.entries,
    old: { kind: 'tombstone', fileId: 'old', path: 'Note.md', lastHash: hash } } };
  assert.deepEqual(validateManifest(encodeManifest(m), 'repo-1'), m);
});
