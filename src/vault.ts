import type { Vault, TFile, Workspace, TextFileView } from 'obsidian';
import type { LocalSnapshot, PathPolicy, SyncAction, DirtyEvents } from './types.ts';
import type { RecoveryStore } from './state.ts';
import { hashBytes, canonicalBytes } from './snapshots.ts';
import { assertPortablePaths, classifyPath, normalizeRelativePath, bookmarksKey, portablePathKey, isWithinPath } from './paths.ts';
import { readBookmarks, applyBookmarks } from './bookmarks.ts';
import type { BookmarkHost } from './bookmarks.ts';
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const decode = (bytes: ArrayBuffer) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
export async function snapshotVault(vault: Vault, policy: PathPolicy, state: RecoveryStore): Promise<LocalSnapshot> {
  policy = structuredClone(policy);
  const snapshot: LocalSnapshot = { files: Object.create(null), excluded: [...policy.exclude], complete: true, policy };
  const objects: Record<string, ArrayBuffer> = {};
  const dirty = await state.getMeta<DirtyEvents>('dirty-events');
  snapshot.capturedGeneration = dirty?.generation ?? 0;
  const files = vault.getFiles();
  for (const file of files) {
    if (portablePathKey(file.path) === portablePathKey(bookmarksKey)) throw new Error('Reserved logical bookmark key exists as a note.');
    if (classifyPath(file.path, policy) !== 'sync') { snapshot.excluded.push(file.path); continue; }
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await vault.adapter.exists(file.path)) break;
      const path = file.path;
      const bytes = await vault.readBinary(file); const hash = await hashBytes(bytes);
      if (file.path !== path || !await vault.adapter.exists(path)) continue;
      const verify = await vault.readBinary(file);
      if (await hashBytes(verify) !== hash) continue;
      snapshot.files[path] = { path, hash, size: bytes.byteLength, mtime: file.stat.mtime, generation: dirty?.paths?.[path] ?? 0 }; objects[hash] = bytes; stable = true; break;
    }
    if (!stable) snapshot.complete = false;
  }
  const latest = await state.getMeta<DirtyEvents>('dirty-events');
  if ((latest?.generation ?? 0) > snapshot.capturedGeneration) {
    snapshot.complete = false;
    for (const [path, generation] of Object.entries(latest?.paths ?? {})) if (generation > snapshot.capturedGeneration) {
      snapshot.excluded.push(path);
      for (const candidate of Object.keys(snapshot.files)) if (isWithinPath(candidate, path)) delete snapshot.files[candidate];
    }
  }
  assertPortablePaths(Object.keys(snapshot.files));
  await state.storeObjects(objects);
  return snapshot;
}
async function parents(vault: Vault, path: string) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (!await vault.adapter.exists(parent)) await vault.createFolder(parent);
  }
}
export type WriteObserver = { write(path: string, hash: string): void; rename(from: string, to: string): void;
  flush?(): Promise<void>; applied?(source: string, target: string | null, backup: string): Promise<void> };
export async function applyLocal(vault: Vault, state: RecoveryStore, action: SyncAction, bytes?: ArrayBuffer, observer?: WriteObserver): Promise<'applied' | 'changed' | 'deferred'> {
  await observer?.flush?.();
  normalizeRelativePath(action.path);
  const safePolicy = { configDir: vault.configDir, include: [], exclude: [], bookmarks: false };
  if (classifyPath(action.path, safePolicy) !== 'sync') return 'deferred';
  const deleting = action.kind === 'delete' && action.direction === 'local';
  if (!deleting && !bytes) return 'deferred';
  const desiredHash = bytes ? await hashBytes(bytes) : null;
  if (!deleting && action.remote?.kind === 'file' && action.remote.hash !== desiredHash) throw new Error('Incoming snapshot hash mismatch.');
  const source = action.local?.path ?? action.path;
  normalizeRelativePath(source);
  if (classifyPath(source, safePolicy) !== 'sync') return 'deferred';
  const current = vault.getAbstractFileByPath(source);
  if (current && !('stat' in current)) return 'changed'; // Never delete/move a folder.
  const file = current as TFile | null;
  if(!deleting && source!==action.path && await vault.adapter.exists(action.path)){
    const target=vault.getAbstractFileByPath(action.path);
    // On Windows the adapter may see the same source through a new case/NFC alias.
    // Relocate it through recovery below; recheck the destination before creating bytes.
    if(!file||portablePathKey(source)!==portablePathKey(action.path)||(target&&target!==file))return 'changed';
  }
  if (deleting && !file) return await vault.adapter.exists(source) ? 'changed' : 'applied';
  if (file && source === action.path && desiredHash && await hashBytes(await vault.readBinary(file)) === desiredHash) return 'applied';
  if (!action.local) {
    if (file || await vault.adapter.exists(action.path)) return 'changed';
    await parents(vault, action.path);
    try { observer?.write(action.path, desiredHash!); await vault.createBinary(action.path, bytes!); return 'applied'; }
    catch (error) { if (await vault.adapter.exists(action.path)) return 'changed'; throw error; }
  }
  const effectId = await hashBytes(canonicalBytes({ attempt: action.applicationId ?? 'direct', fileId: action.fileId, source, target: action.path,
    expected: action.local.hash, desired: desiredHash }).buffer);
  const key = `local-effect:${effectId}`;
  let effect = await state.getMeta<{ backup: string; source: string; target: string }>(key);
  if (file) {
    const original = await vault.readBinary(file);
    if (await hashBytes(original) !== action.local.hash) return 'changed';
    await state.storeObjects({ [action.local.hash]: original });
    if (file.path !== source) return 'changed';
    if (!deleting && source === action.path && /\.(?:md|txt)$/i.test(source)) {
      let expectedText: string, incoming: string;
      try { expectedText = decode(original); incoming = decode(bytes!); } catch { return 'deferred'; }
      let changed = false;
      observer?.write(action.path, desiredHash!);
      await vault.process(file, current => { if (current !== expectedText) { changed = true; return current; } return incoming; });
      return changed ? 'changed' : 'applied';
    }
    // A deterministic effect intent survives a crash between relocate and create.
    // Relocate preserves the file itself, including writes to an already-open handle.
    if (effect && await vault.adapter.exists(effect.backup)) return 'changed';
    effect = { backup: `.webdav-sync-v2/recovery/${crypto.randomUUID()}.${file.extension || 'bin'}`, source, target: action.path };
    await state.setMeta(key, effect); await parents(vault, effect.backup);
    if (file.path !== source) return 'changed';
    observer?.rename(source, effect.backup); await vault.rename(file, effect.backup);
  }
  if (!effect || !await vault.adapter.exists(effect.backup)) return deleting && !file ? 'applied' : 'changed';
  await observer?.flush?.();
  const preserved = await vault.adapter.readBinary(effect.backup);
  const preservedHash = await hashBytes(preserved); await state.storeObjects({ [preservedHash]: preserved });
  if (preservedHash !== action.local.hash) {
    if (!await vault.adapter.exists(source)) { await parents(vault, source); await vault.createBinary(source, preserved); }
    await observer?.applied?.(source, source, effect.backup);
    return 'changed';
  }
  if (deleting) { if (await vault.adapter.exists(source)) return 'changed'; await observer?.applied?.(source, null, effect.backup); return 'applied'; }
  if (await vault.adapter.exists(action.path)) {
    if (await hashBytes(await vault.adapter.readBinary(action.path)) !== desiredHash) return 'changed';
    await observer?.applied?.(source, action.path, effect.backup); return 'applied';
  }
  await parents(vault, action.path);
  try { observer?.write(action.path, desiredHash!); await vault.createBinary(action.path, bytes!); await observer?.applied?.(source, action.path, effect.backup); return 'applied'; }
  catch (error) { if (await vault.adapter.exists(action.path)) return 'changed'; throw error; }
}
export async function flushEditors(workspace: Workspace): Promise<void> {
  const views: Partial<TextFileView>[] = [];const buffers=new Map<string,string>();
  workspace.iterateAllLeaves(leaf => {
    const view = leaf.view as Partial<TextFileView> & {editor?:{getValue():string}};
    if (view.getViewType?.() === 'markdown' && typeof view.save === 'function') {
      if(view.file&&view.editor){const value=view.editor.getValue();const previous=buffers.get(view.file.path);
        if(previous!==undefined&&previous!==value)throw Error('Different editor buffers for one note');buffers.set(view.file.path,value);}
      views.push(view);
    }
  });
  await Promise.all(views.map(view=>view.save!()));
}
export async function saveRecoveryEditors(vault:Vault,workspace:Workspace,bookmarkSnapshot?:unknown){
  const id=crypto.randomUUID();const folder=`.webdav-sync-v2/recovery/exit-${id}`;await parents(vault,folder+'/index.json');
  const buffers:{path:string;text:string}[]=[];
  workspace.iterateAllLeaves(leaf=>{const view=leaf.view as {getViewType?():string;file?:TFile;editor?:{getValue():string}};
    if(view.getViewType?.()==='markdown'&&view.file&&view.editor)buffers.push({path:view.file.path,text:view.editor.getValue()});});
  const index=[];
  for(let i=0;i<buffers.length;i++){const file=`${i}.md`;await vault.adapter.writeBinary(folder+'/'+file,encode(buffers[i].text));index.push({source:buffers[i].path,file});}
  if(bookmarkSnapshot!==undefined)await vault.adapter.writeBinary(folder+'/bookmarks.json',encode(JSON.stringify(bookmarkSnapshot)));
  await vault.adapter.writeBinary(folder+'/index.json',encode(JSON.stringify({schema:1,buffers:index,bookmarks:bookmarkSnapshot!==undefined})));
  return folder;
}
export type LocalAccess = { snapshot(): Promise<LocalSnapshot>; apply(action: SyncAction, bytes?: ArrayBuffer): ReturnType<typeof applyLocal> };
export const createVaultAccess = (vault: Vault, policy: PathPolicy, state: RecoveryStore, bookmarks: BookmarkHost | null = null, observer?: WriteObserver): LocalAccess => ({
  snapshot: async () => {
    if (policy.bookmarks) { if (!bookmarks) throw new Error('Bookmark host unsupported.'); await bookmarks.flush(); }
    const snapshot = await snapshotVault(vault, policy, state);
    if (policy.bookmarks) {
      const bytes = await readBookmarks(vault);
      if (bytes) { const hash = await hashBytes(bytes); await state.storeObjects({ [hash]: bytes }); snapshot.files[bookmarksKey] = { path: bookmarksKey, hash, size: bytes.byteLength,
        mtime: (await vault.adapter.stat(`${vault.configDir}/bookmarks.json`))?.mtime, generation: (await state.getMeta<DirtyEvents>('dirty-events'))?.paths?.[bookmarksKey] ?? 0 }; }
      else if (await state.hasAppliedPath(bookmarksKey)) snapshot.excluded.push(bookmarksKey);
    }
    return snapshot;
  },
  apply: async (action, bytes) => action.path === bookmarksKey ? bytes ? applyBookmarks(vault, state, action.local?.hash ?? null, bytes, bookmarks) : 'deferred'
    : applyLocal(vault, state, action, bytes, observer),
});
