import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBytes, hashBytes } from '../../src/snapshots.ts';
import { encodeRevision, revisionId, eventId, validateEvent, decodeContainer, decodeIdentity, decodeSeal, decodeHint } from '../../src/v2-codec.ts';
import type { RevisionCore, SemanticEvent, Container } from '../../src/v2-types.ts';

const hash = 'a'.repeat(64), parent = 'b'.repeat(64), other = 'c'.repeat(64);
const core: RevisionCore = { schema: 2, repositoryId: 'repo', fileId: 'file', parents: [],
  value: { kind: 'file', path: 'Папка/заметка.md', hash, size: 3 }, operation: 'create', algorithmVersion: null, recreates: null };
async function record(c = core) { return { id: await revisionId(c), core: c }; }
async function event(c = core): Promise<SemanticEvent> {
  return { schema: 2, repositoryId: 'repo', deviceId: 'device', operationId: 'operation', previous: null, revisions: [await record(c)] };
}
async function container(): Promise<Container> {
  const e = await event();
  return { schema: 2, repositoryId: 'repo', events: [{ id: await eventId(e), core: e }], sources: [
    { hash, size: 3, slot: { path: `.webdav-sync-v2/repos/repo/blobs/device/attempt.${hash}.bin`, hash, size: 3 } }], dependencies: [], previousSources: [] };
}
async function decode(c: unknown) { const bytes = canonicalBytes(c); return decodeContainer(bytes, await hashBytes(bytes.buffer), 'repo'); }

test('revision IDs normalize parent order and exclude actor and physical envelopes', async () => {
  const edit = { ...core, operation: 'edit' as const, parents: [parent, other] };
  const a = { actor: 'a', slot: '/a', core: edit }, b = { actor: 'b', slot: '/b', core: { ...edit, parents: [other, parent] } };
  assert.equal(await revisionId(a.core), await revisionId(b.core));
  assert.notEqual(await revisionId(edit), await revisionId({ ...edit, parents: [parent] }));
  const reordered = Object.fromEntries(Object.entries(core).reverse());
  assert.deepEqual(encodeRevision(reordered), encodeRevision(core));
  assert.throws(() => encodeRevision({ ...core, actor: 'unexpected' }));
});
test('strict revision schema rejects invalid paths, impossible operations and excessive ancestry', () => {
  const bad = [{ ...core, repositoryId: '../escape' }, { ...core, extra: true }, { ...core, parents: [parent, parent] },
    { ...core, operation: 'edit', parents: [] }, { ...core, operation: 'delete' }, { ...core, value: { ...core.value, size: -1 } },
    { ...core, operation: 'edit', parents: Array.from({ length: 257 }, (_, i) => i.toString(16).padStart(64, '0')) }];
  for (const value of bad) assert.throws(() => encodeRevision(value));
  for (const path of ['../x', '.webdav-sync/HEAD', '.WEBDAV-SYNC-V2/repos/x', 'dir\\x'])
    assert.throws(() => encodeRevision({ ...core, value: { ...core.value, path } }));
});
test('recreate references are semantic and must point to a different identity', async () => {
  const c = { ...core, operation: 'recreate' as const, recreates: { oldFileId: 'old', tombstones: [parent] } };
  assert.notEqual(await revisionId(c), await revisionId({ ...c, recreates: { oldFileId: 'old', tombstones: [other] } }));
  assert.throws(() => encodeRevision({ ...c, recreates: { oldFileId: 'file', tombstones: [parent] } }));
  assert.throws(() => encodeRevision({ ...c, recreates: null }));
});
test('event hashes verify every revision and never accept a half-valid multi-file batch', async () => {
  const e = await event(), id = await eventId(e);
  assert.equal((await validateEvent({ id, core: e }, 'repo')).id, id);
  await assert.rejects(validateEvent({ id, core: e }, 'wrong'));
  await assert.rejects(validateEvent({ id: other, core: e }, 'repo'));
  await assert.rejects(eventId({ ...e, revisions: [...e.revisions, ...e.revisions] }));
  await assert.rejects(validateEvent({ id, core: { ...e, revisions: [{ ...e.revisions[0], id: other }] } }, 'repo'));
});
test('a corrupt independent semantic event cannot suppress a good packed event; a bad frame can', async () => {
  const c = await container();
  const decoded = await decode({ ...c, events: [...c.events, { id: other, core: {} }] });
  assert.equal(decoded.events.length, 1); assert.equal(decoded.issues.length, 1);
  const bytes = canonicalBytes(c);
  await assert.rejects(decodeContainer(bytes, other, 'repo'));
  await assert.rejects(decode({ ...c, schema: 1 }));
  await assert.rejects(decode({ ...c, extra: true }));
  await assert.rejects(decode({ ...c, events: Array(129).fill(c.events[0]) }));
});
test('source locators stay within the exact repository and bind object hash and size', async () => {
  const c = await container();
  for (const path of ['https://evil.example/x', `.webdav-sync-v2/repos/other/blobs/device/attempt.${hash}.bin`,
    `.webdav-sync-v2/repos/repo/blobs/device/../attempt.${hash}.bin`, `.webdav-sync-v2/repos/repo/blobs/device/a%2Fb.${hash}.bin`])
    await assert.rejects(decode({ ...c, sources: [{ ...c.sources[0], slot: { ...c.sources[0].slot, path } }] }));
  await assert.rejects(decode({ ...c, sources: [{ ...c.sources[0], hash: other }] }));
  await assert.rejects(decode({ ...c, sources: [{ ...c.sources[0], size: 4 }] }));
  assert.equal((await decode(c)).sources[0].hash, hash);
});
test('identity, seal and hint decoders reject unsupported schema and malformed source references', () => {
  assert.deepEqual(decodeIdentity(canonicalBytes({ schema: 2, repositoryId: 'repo' })), { schema: 2, repositoryId: 'repo' });
  assert.throws(() => decodeIdentity(canonicalBytes({ schema: 1, repositoryId: 'repo' })));
  assert.throws(() => decodeIdentity(canonicalBytes({ schema: 2, repositoryId: 'repo', account: 'pro' })));
  const seal = { schema: 2, repositoryId: 'repo', segment: { deviceId: 'device', group: 0, segmentId: 'segment' }, members: [] };
  assert.deepEqual(decodeSeal(canonicalBytes(seal), 'repo'), seal);
  assert.throws(() => decodeSeal(canonicalBytes({ ...seal, members: [{ eventId: hash, containerSlots: [] }] }), 'repo'));
  assert.deepEqual(decodeHint(canonicalBytes({ schema: 2, repositoryId: 'repo', deviceId: 'device', tip: null }), 'repo').tip, null);
});
