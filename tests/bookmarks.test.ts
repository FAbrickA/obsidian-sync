import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBookmarks, createBookmarkHost } from '../src/bookmarks.ts';
import { memoryVault } from './helpers/memory-vault.ts';
import type { App } from 'obsidian';
import type { RecoveryStore } from '../src/state.ts';
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer;
const item = (url: string) => ({ type: 'url', ctime: 1000, url, title: url, customField: 'kept' });
test('independent append preserves equal ctimes, duplicate targets, unknown fields and deterministic order', () => {
  const base = { items: [item('base')], customRoot: { value: 7 } };
  const l = { ...base, items: [...base.items, item('left')] }, r = { ...base, items: [...base.items, item('right')] };
  const result = mergeBookmarks(bytes(base), bytes(l), bytes(r)); assert.equal(result.kind, 'clean');
  const swapped = mergeBookmarks(bytes(base), bytes(r), bytes(l)); assert.deepEqual(swapped, result);
  if (result.kind === 'clean') { const parsed = JSON.parse(new TextDecoder().decode(result.bytes)); assert.equal(parsed.items.length, 3); assert.deepEqual(parsed.customRoot, base.customRoot); assert(parsed.items.every((i: { ctime: number; customField: string }) => i.ctime === 1000 && i.customField === 'kept')); }
  const duplicateTarget = mergeBookmarks(bytes(base), bytes({ ...base, items: [...base.items, { ...item('same'), title: 'one' }] }), bytes({ ...base, items: [...base.items, { ...item('same'), title: 'two' }] }));
  assert.equal(duplicateTarget.kind, 'clean'); if (duplicateTarget.kind === 'clean') assert.equal(JSON.parse(new TextDecoder().decode(duplicateTarget.bytes)).items.length, 3);
});
test('reorder/delete/edit and ambiguous duplicate append conflict without inventing identities', () => {
  const a = item('a'), b = item('b'); const base = { items: [a, b] };
  for (const [l, r] of [[{ items: [b] }, { items: [a, { ...b, title: 'edited' }] }],
    [{ items: [b, a] }, { items: [a, { ...b, title: 'edited' }] }],
    [{ items: [a, b, item('same')] }, { items: [a, b, item('same'), item('other')] }]]) {
    assert.equal(mergeBookmarks(bytes(base), bytes(l), bytes(r)).kind, 'conflict');
  }
});
test('identical and single-side changes preserve exact bytes; malformed input is archived as conflict', () => {
  const base = bytes({ items: [] }), changed = bytes({ items: [item('new')] });
  assert.deepEqual(mergeBookmarks(base, base, changed), { kind: 'clean', bytes: changed });
  assert.deepEqual(mergeBookmarks(null, changed, changed), { kind: 'clean', bytes: changed });
  assert.equal(mergeBookmarks(base, new TextEncoder().encode('{broken').buffer, changed).kind, 'conflict');
  assert.equal(mergeBookmarks(base, bytes({ items: 'wrong' }), changed).kind, 'conflict');
});
test('journal quota never prevents the native Bookmarks plugin from saving user edits to disk', async () => {
  const mem = memoryVault(); mem.seed('.obsidian/bookmarks.json', JSON.stringify({ items: [] }));
  const change = Object.assign((_save: boolean) => {}, { run() {}, cancel() {} });
  const core = { enabled: true, instance: { items: [], getBookmarks: () => [], onItemsChanged: change,
    async onExternalSettingsChange() {}, on() {}, off() {} },
    async saveData(value: unknown) { mem.seed('.obsidian/bookmarks.json', JSON.stringify(value)); } };
  const state = { async storeObjects() { throw new Error('Quota'); }, async setMeta() {}, async getMeta() { return null; } } as unknown as RecoveryStore;
  const host = createBookmarkHost({ vault: mem.vault, internalPlugins: { plugins: { bookmarks: core } } } as unknown as App, state)!;
  try { await assert.rejects(core.saveData({ items: [item('new')] }));
    assert.equal(JSON.parse(await mem.read('.obsidian/bookmarks.json')).items.length, 1);
  } finally { host.dispose(); }
});
test('native grouped bookmarks use root items, never the flattened search enumeration', async () => {
  const mem = memoryVault(); const child = item('nested'); const roots = [{ type: 'group', ctime: 1000, title: 'Group', items: [child] }];
  mem.seed('.obsidian/bookmarks.json', JSON.stringify({ items: roots }));
  const change = Object.assign((_save: boolean) => {}, { run() {}, cancel() {} });
  const core = { enabled: true, instance: { items: roots, getBookmarks: () => [roots[0], child], onItemsChanged: change,
    async onExternalSettingsChange() {}, on() {}, off() {} }, async saveData(value: unknown) { mem.seed('.obsidian/bookmarks.json', JSON.stringify(value)); } };
  const state = { async storeObjects() {}, async setMeta() {}, async getMeta() { return null; } } as unknown as RecoveryStore;
  const host = createBookmarkHost({ vault: mem.vault, internalPlugins: { plugins: { bookmarks: core } } } as unknown as App, state)!;
  try { core.instance.onItemsChanged(true); await host.flush(); assert.deepEqual(JSON.parse(await mem.read('.obsidian/bookmarks.json')).items, roots); }
  finally { host.dispose(); }
});
test('re-enabling the bookmark bridge cannot let an older queued save overwrite a newer edit', async () => {
  const mem = memoryVault(); mem.seed('.obsidian/bookmarks.json', JSON.stringify({ items: [] }));
  const change = Object.assign((_save: boolean) => {}, { run() {}, cancel() {} });
  const core = { enabled: true, instance: { items: [], getBookmarks: () => [], onItemsChanged: change,
    async onExternalSettingsChange() {}, on() {}, off() {} }, async saveData(value: unknown) { mem.seed('.obsidian/bookmarks.json', JSON.stringify(value)); } };
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const firstState = { async storeObjects() { await gate; }, async setMeta() {}, async getMeta() { return null; } } as unknown as RecoveryStore;
  const fastState = { async storeObjects() {}, async setMeta() {}, async getMeta() { return null; } } as unknown as RecoveryStore;
  const app = { vault: mem.vault, internalPlugins: { plugins: { bookmarks: core } } } as unknown as App;
  const first = createBookmarkHost(app, firstState)!; const old = core.saveData({ items: [item('old')] });
  await new Promise(r => setTimeout(r, 1)); first.dispose();
  const second = createBookmarkHost(app, fastState)!; const newest = core.saveData({ items: [item('new')] });
  await new Promise(r => setTimeout(r, 1)); release(); await Promise.all([old, newest]);
  assert.equal(JSON.parse(await mem.read('.obsidian/bookmarks.json')).items[0].url, 'new'); second.dispose();
});
