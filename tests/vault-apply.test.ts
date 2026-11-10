import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openStateV2 as openState } from '../src/state.ts';
import { hashBytes } from '../src/snapshots.ts';
import { snapshotVault, applyLocal, flushEditors } from '../src/vault.ts';
import { memoryVault } from './helpers/memory-vault.ts';
import type { SyncAction } from '../src/types.ts';
import type { Workspace } from 'obsidian';
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const policy = { configDir: '.obsidian', include: [], exclude: ['private'], bookmarks: false };
test('a native rename during another file read excludes the stale captured path', async () => {
  const mem = memoryVault(); mem.seed('a.md','a'); mem.seed('b.md','b');
  const state = await openState('snapshot-race', 'repo', new IDBFactory());
  const read = mem.vault.readBinary.bind(mem.vault); let changed = false;
  mem.vault.readBinary = async file => {
    if (file.path === 'b.md' && !changed) {
      changed = true; await mem.vault.rename(mem.vault.getAbstractFileByPath('a.md')!, 'c.md');
      await state.recordDirtyEvent({kind:'rename',from:'a.md',path:'c.md',generation:1});
    }
    return read(file);
  };
  const snapshot = await snapshotVault(mem.vault,policy,state);
  assert.equal(snapshot.files['a.md'], undefined); assert.equal(snapshot.complete,false);
  assert(snapshot.excluded.includes('a.md')); assert(snapshot.files['b.md']); await state.close();
});
async function fixture(path = 'a.md') {
  const mem = memoryVault(); mem.seed(path, 'old'); const state = await openState(crypto.randomUUID(), 'repo', new IDBFactory());
  const action: SyncAction = { kind: 'download', fileId: 'f', path, base: null,
    local: { path, hash: await hashBytes(bytes('old')), size: 3 }, remote: { kind: 'file', fileId: 'f', path, hash: await hashBytes(bytes('new')), size: 3 } };
  return { mem, state, action };
}

test('a case-only rename on a case-insensitive adapter relocates the source and preserves recovery bytes',async()=>{
  const{mem,state,action}=await fixture('note.md');
  mem.vault.adapter.exists=async path=>[...mem.files.keys(),...mem.folders].some(p=>p.toLowerCase()===path.toLowerCase());
  try{
    const renamed={...action,path:'Note.md',remote:{...action.remote!,path:'Note.md'}} as SyncAction;
    assert.equal(await applyLocal(mem.vault,state,renamed,bytes('new')),'applied');
    assert.equal(mem.files.has('note.md'),false);assert.equal(await mem.read('Note.md'),'new');
    assert([...mem.files].some(([path,file])=>path.startsWith('.webdav-sync-v2/recovery/')&&new TextDecoder().decode(file.bytes)==='old'));
  }finally{await state.close();}
});

test('a separately occupied case alias is never mistaken for the source even when its bytes match',async()=>{
  const{mem,state,action}=await fixture('note.md');mem.seed('Note.md','new');
  try{
    const renamed={...action,path:'Note.md',remote:{...action.remote!,path:'Note.md'}} as SyncAction;
    assert.equal(await applyLocal(mem.vault,state,renamed,bytes('new')),'changed');
    assert.equal(await mem.read('note.md'),'old');assert.equal(await mem.read('Note.md'),'new');
  }finally{await state.close();}
});
test('atomic text processing preserves a user edit made after scanning or immediately before callback', async () => {
  for (const late of [false, true]) {
    const { mem, state, action } = await fixture();
    if (late) mem.raceProcess(() => mem.seed('a.md', 'late')); else mem.seed('a.md', 'late');
    assert.equal(await applyLocal(mem.vault, state, action, bytes('new')), 'changed');
    assert.equal(await mem.read('a.md'), 'late'); await state.close();
  }
});
test('new binary never overwrites an existing file; destructive binary replace retains original', async () => {
  const { mem, state, action } = await fixture('image.png');
  assert.equal(await applyLocal(mem.vault, state, { ...action, local: null }, bytes('new')), 'changed');
  assert.equal(await applyLocal(mem.vault, state, action, bytes('new')), 'applied');
  assert.equal(await mem.read('image.png'), 'new');
  assert([...mem.files.keys()].some(p => p.startsWith('.webdav-sync-v2/recovery/')));
  assert([...mem.files.values()].some(f => new TextDecoder().decode(f.bytes) === 'old')); await state.close();
});
test('an edit racing a destructive relocation is retained and restored, not replaced', async () => {
  const { mem, state, action } = await fixture('image.png');
  mem.raceRename(() => mem.seed('image.png', 'late'));
  assert.equal(await applyLocal(mem.vault, state, action, bytes('new')), 'changed');
  assert.equal(await mem.read('image.png'), 'late'); await state.close();
});
test('file deletion retains recovery bytes and never removes its parent or ignored children', async () => {
  const { mem, state, action } = await fixture('folder/a.md'); mem.seed('folder/private.bin', 'keep');
  assert.equal(await applyLocal(mem.vault, state, { ...action, kind: 'delete', direction: 'local' }), 'applied');
  assert.equal(await mem.read('folder/private.bin'), 'keep'); assert(mem.folders.has('folder')); await state.close();
});
test('snapshot hashes bytes despite unchanged metadata and excludes settings and ignored children', async () => {
  const { mem, state } = await fixture(); mem.seed('private/x.md', 'hidden'); mem.seed('.obsidian/plugins/x/data.json', 'secret');
  const first = await snapshotVault(mem.vault, policy, state);
  mem.files.get('a.md')!.bytes = bytes('NEW');
  const second = await snapshotVault(mem.vault, policy, state);
  assert.notEqual(first.files['a.md'].hash, second.files['a.md'].hash);
  assert.deepEqual(Object.keys(second.files), ['a.md']); assert.equal(new TextDecoder().decode(await state.readObject(second.files['a.md'].hash)), 'NEW'); await state.close();
});
test('flush waits for all markdown views, including multiple leaves', async () => {
  let saves = 0;
  await flushEditors({ iterateAllLeaves(fn: (leaf: unknown) => void) { for (let i = 0; i < 3; i++) fn({ view: { getViewType: () => 'markdown', save: async () => { await Promise.resolve(); saves++; } } }); } } as unknown as Workspace);
  assert.equal(saves, 3);
});
test('different open buffers for one note block normal flush before either is overwritten',async()=>{
  let saves=0;
  const workspace={iterateAllLeaves(fn:(leaf:unknown)=>void){for(const value of ['first unsaved','second unsaved'])fn({view:{file:{path:'note.md'},editor:{getValue:()=>value},getViewType:()=> 'markdown',save:async()=>{saves++;}}});}} as unknown as Workspace;
  await assert.rejects(flushEditors(workspace),/Different editor buffers/);assert.equal(saves,0);
});
