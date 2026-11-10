import type { App, Vault } from 'obsidian';
import type { RecoveryStore } from './state.ts';
import type { MergeResult } from './types.ts';
import { canonicalBytes, hashBytes } from './snapshots.ts';
import type { ManyMergeResult } from './merge.ts';
import { limitsV2 } from './v2-types.ts';
const text = (bytes: ArrayBuffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n').buffer;
function parse(bytes: ArrayBuffer): Record<string, unknown> & { items: unknown[] } {
  if (bytes.byteLength > 1_000_000) throw new Error('Bookmark size limit.');
  const v = JSON.parse(text(bytes));
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.items)) throw new Error('Unsupported bookmark schema.');
  const validate = (items: unknown[], depth: number) => {
    if (depth > 32) throw new Error('Bookmark nesting limit.');
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') throw new Error('Invalid bookmark item.');
      const item = raw as Record<string, unknown>;
      if (item.type === 'group') { if (!Array.isArray(item.items)) throw new Error('Invalid group.'); validate(item.items, depth + 1); }
    }
  };
  validate(v.items, 0); return v;
}
const equalBytes = (a: ArrayBuffer, b: ArrayBuffer) => { const right = new Uint8Array(b); return a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === right[i]); };
export function validateBookmarks(bytes:ArrayBuffer):void { parse(bytes); }
const key = (value: unknown) => new TextDecoder().decode(canonicalBytes(value));
export function mergeBookmarks(base: ArrayBuffer | null, local: ArrayBuffer, remote: ArrayBuffer): MergeResult {
  const conflict = (reason: string): MergeResult => ({ kind: 'conflict', reason, base: base?.slice(0) ?? null, local: local.slice(0), remote: remote.slice(0) });
  let l: ReturnType<typeof parse>, r: typeof l, b: typeof l | null;
  try { l = parse(local); r = parse(remote); b = base ? parse(base) : null; } catch { return conflict('invalid-bookmarks'); }
  if (equalBytes(local, remote)) return { kind: 'clean', bytes: local.slice(0) };
  if (!base || !b) return conflict('bookmarks-no-base');
  if (equalBytes(base, local)) return { kind: 'clean', bytes: remote.slice(0) };
  if (equalBytes(base, remote)) return { kind: 'clean', bytes: local.slice(0) };
  const metadata = ({ items: _, ...rest }: typeof l) => key(rest);
  if (metadata(b) !== metadata(l) || metadata(b) !== metadata(r)) return conflict('bookmarks-metadata');
  const original = b.items.map(key);
  if (![l, r].every(v => original.every((item, i) => key(v.items[i] ?? null) === item))) return conflict('bookmarks-structural-edit');
  const left = l.items.slice(original.length), right = r.items.slice(original.length);
  const additions = [...left, ...right].map(key);
  if (!left.length || !right.length || new Set(additions).size !== additions.length || additions.some(item => original.includes(item))) return conflict('bookmarks-ambiguous-addition');
  const blocks = [left, right].sort((a, b) => key(a) < key(b) ? -1 : 1);
  return { kind: 'clean', bytes: encode({ ...b, items: [...b.items, ...blocks.flat()] }) };
}
export function mergeBookmarksMany(base: ArrayBuffer | null, variants: ArrayBuffer[]): ManyMergeResult {
  const conflict = (reason: string): ManyMergeResult => ({ kind: 'conflict', reason, base: base?.slice(0) ?? null, variants: variants.map(v => v.slice(0)) });
  if (!variants.length || variants.length > limitsV2.mergeVariants || variants.reduce((n, v) => n + v.byteLength, base?.byteLength ?? 0) > limitsV2.mergeTotalBytes) return conflict('input-limit');
  try {
    const parsed = variants.map(parse), ancestor = base === null ? null : parse(base);
    if (variants.every(v => equalBytes(v, variants[0]))) return { kind: 'clean', bytes: variants[0].slice(0) };
    if (!ancestor || !base) return conflict('bookmarks-no-base');
    const originalKey = key(ancestor), changed = new Map<string, { parsed: ReturnType<typeof parse>; copies: ArrayBuffer[] }>();
    for (let i = 0; i < parsed.length; i++) {
      const k = key(parsed[i]); if (k === originalKey) continue;
      const entry = changed.get(k) ?? { parsed: parsed[i], copies: [] }; entry.copies.push(variants[i]); changed.set(k, entry);
    }
    if (!changed.size) return { kind: 'clean', bytes: base.slice(0) };
    const canonicalEncode = (v: unknown) => encode(JSON.parse(key(v)));
    if (changed.size === 1) {
      const v = [...changed.values()][0]; return { kind: 'clean', bytes: v.copies.every(b => equalBytes(b, v.copies[0])) ? v.copies[0].slice(0) : canonicalEncode(v.parsed) };
    }
    const metadata = ({ items: _, ...rest }: ReturnType<typeof parse>) => key(rest), original = ancestor.items.map(key);
    const blocks: unknown[][] = [], additions = new Set<string>();
    for (const { parsed: value } of changed.values()) {
      if (metadata(value) !== metadata(ancestor)) return conflict('bookmarks-metadata');
      if (!original.every((item, i) => key(value.items[i] ?? null) === item)) return conflict('bookmarks-structural-edit');
      const block = value.items.slice(original.length); if (!block.length) return conflict('bookmarks-ambiguous-addition');
      for (const item of block) { const k = key(item); if (additions.has(k) || original.includes(k)) return conflict('bookmarks-ambiguous-addition'); additions.add(k); }
      blocks.push(block);
    }
    blocks.sort((a, b) => key(a) < key(b) ? -1 : 1);
    return { kind: 'clean', bytes: canonicalEncode({ ...ancestor, items: [...ancestor.items, ...blocks.flat()] }) };
  } catch { return conflict('invalid-bookmarks'); }
}
export async function readBookmarks(vault: Vault): Promise<ArrayBuffer | null> {
  const path = `${vault.configDir}/bookmarks.json`;
  return await vault.adapter.exists(path) ? vault.adapter.readBinary(path) : null;
}
export type BookmarkHost = { flush(): Promise<void>; reload(): Promise<void>; snapshot(): unknown;
  onChanged(callback: () => void): () => void; settled(): Promise<void>; dispose(): void };
type Change = ((save: boolean) => void) & { run(): void; cancel(): void };
type CoreInstance = { items: unknown[]; getBookmarks(): unknown[]; onItemsChanged: Change; onExternalSettingsChange(): Promise<void>;
  on(name: 'changed', fn: () => void): unknown; off(name: 'changed', fn: () => void): void };
type CorePlugin = { enabled: boolean; instance: CoreInstance; saveData(value: unknown): Promise<void> };
export function createBookmarkHost(app: App, state: RecoveryStore): BookmarkHost | null {
  const core = (app as unknown as { internalPlugins?: { plugins?: { bookmarks?: CorePlugin } } }).internalPlugins?.plugins?.bookmarks;
  const instance = core?.instance;
  if (!core?.enabled || !instance || typeof core.saveData !== 'function' || typeof instance.getBookmarks !== 'function'
    || !Array.isArray(instance.items) || typeof instance.onExternalSettingsChange !== 'function' || typeof instance.onItemsChanged?.run !== 'function') return null;
  const save = core.saveData; const change = instance.onItemsChanged; const reload = instance.onExternalSettingsChange;
  const slot = Symbol.for('webdav-sync.bookmark-save-queue');
  const sharedCore = core as CorePlugin & { [slot]?: { queue: Promise<void> } };
  const shared = sharedCore[slot] ??= { queue: Promise.resolve() };
  let queue = shared.queue; let failed = false; let generation = 0; let active = true;
  const observers = new Set<() => void>();
  const snapshot = () => JSON.parse(JSON.stringify({ items: instance.items }));
  const wrappedSave = (value: unknown) => {
    const captured = JSON.parse(JSON.stringify(value)); generation++;
    for (const callback of observers) { try { callback(); } catch { /* Observation must not prevent core save. */ } }
    queue = shared.queue.catch(() => {}).then(async () => {
      const before = await readBookmarks(app.vault); const disk = before ? parse(before) : { items: [] };
      const output = { ...disk, ...captured }; const bytes = encode(output); const hash = await hashBytes(bytes);
      let backupFailed = false;
      try { await state.storeObjects({ [hash]: bytes }); await state.setMeta('bookmarks-unsaved', hash); }
      catch { backupFailed = true; }
      await save.call(core, output); // Native local persistence takes priority over our archive quota.
      if (backupFailed) throw new Error('Bookmark archive unavailable; local core save completed.');
      await state.setMeta('bookmarks-unsaved', null); failed = false;
    });
    shared.queue = queue;
    void queue.catch(() => { failed = true; }); return queue;
  };
  const wrappedChange = Object.assign((shouldSave: boolean) => {
    if (shouldSave) void wrappedSave(snapshot());
    change(false);
  }, { run: () => change.run(), cancel: () => change.cancel() });
  const wrappedReload = async () => {
    await queue; const before = generation; await reload.call(instance);
    if (generation !== before) { await queue; await reload.call(instance); }
  };
  core.saveData = wrappedSave; instance.onItemsChanged = wrappedChange; instance.onExternalSettingsChange = wrappedReload;
  return {
    snapshot,
    settled: () => shared.queue,
    async flush() {
      if (!active || !core.enabled || core.instance !== instance) throw new Error('Bookmark host unavailable.');
      change.run(); await queue;
      if (failed || await state.getMeta('bookmarks-unsaved')) throw new Error('Bookmark save requires recovery.');
    },
    reload: wrappedReload,
    onChanged(callback) { observers.add(callback); return () => { observers.delete(callback); }; },
    dispose() {
      active = false;
      if (core.saveData === wrappedSave) core.saveData = save;
      if (instance.onItemsChanged === wrappedChange) instance.onItemsChanged = change;
      if (instance.onExternalSettingsChange === wrappedReload) instance.onExternalSettingsChange = reload;
    },
  };
}
export async function applyBookmarks(vault: Vault, state: RecoveryStore, expectedHash: string | null, bytes: ArrayBuffer,
  host: BookmarkHost | null): Promise<'applied' | 'deferred'> {
  if (!host) return 'deferred'; parse(bytes); await host.flush();
  const before = await readBookmarks(vault); const incomingHash = await hashBytes(bytes);
  if (before && await hashBytes(before) === incomingHash) { await host.reload(); return 'applied'; }
  if ((before ? await hashBytes(before) : null) !== expectedHash) return 'deferred';
  const saved: Record<string, ArrayBuffer> = { [incomingHash]: bytes };
  if (before) saved[await hashBytes(before)] = before;
  await state.storeObjects(saved);
  const memory = key(host.snapshot()); const path = `${vault.configDir}/bookmarks.json`;
  let changed = false;
  if (before) await vault.adapter.process(path, current => {
    if (current !== text(before)) { changed = true; return current; }
    return text(bytes);
  });
  else {
    if (await vault.adapter.exists(path)) return 'deferred';
    try { await vault.create(path, text(bytes)); } catch { return 'deferred'; }
  }
  if (changed || key(host.snapshot()) !== memory) return 'deferred';
  await host.reload();
  const after = await readBookmarks(vault);
  return after && await hashBytes(after) === incomingHash && key((host.snapshot() as { items: unknown[] }).items) === key(parse(bytes).items) ? 'applied' : 'deferred';
}
