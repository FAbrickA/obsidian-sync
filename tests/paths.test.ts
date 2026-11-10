import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRelativePath, assertPortablePaths, classifyPath, targetKey, deriveLocalScope } from '../src/paths.ts';

test('portable path rules reject traversal, aliases and unsupported Windows names without renaming', () => {
  for (const name of ['../x', '/a', 'a//b', 'a/./b', 'a\\b', 'CON.md', 'a:b', 'a. ', 'a\0b', 'AUX/x', 'LPT1.txt']) {
    assert.throws(() => normalizeRelativePath(name), name);
  }
  assert.equal(normalizeRelativePath('Папка/Заметка.md'), 'Папка/Заметка.md');
  assert.throws(() => assertPortablePaths(['A.md', 'a.md']));
  assert.throws(() => assertPortablePaths(['é.md', 'e\u0301.md']));
  assert.throws(() => assertPortablePaths(['σ.md', 'ς.md']));
  assert.throws(() => assertPortablePaths(['dir', 'DIR/note.md']));
  assert.throws(() => assertPortablePaths(['.webdav-sync/HEAD']));
  assert.throws(() => assertPortablePaths(['.WEBDAV-SYNC-V2/repos/x']));
});
test('scope excludes configuration except exact bookmarks key and respects observation filters', () => {
  const policy = { configDir: '.settings', include: [], exclude: ['private'], bookmarks: true };
  assert.equal(classifyPath('.settings/bookmarks.json', policy), 'bookmarks');
  for (const name of ['.settings/plugins/x/data.json', '.obsidian/a', '.webdav-sync/HEAD', '.webdav-sync-v2/repos/x', 'private/x.md', '.trash/x.md']) assert.equal(classifyPath(name, policy), 'exclude');
  assert.equal(classifyPath('private-notes.md', policy), 'sync');
  assert.equal(classifyPath('other.md', { ...policy, include: ['notes'] }), 'exclude');
});
test('target identity excludes password; changes root/user; local identity isolates same-named vaults', async () => {
  const config = { endpoint: 'https://dav.example/', root: '/notes/', username: 'me', password: 'first' };
  assert.equal(await targetKey(config), await targetKey({ ...config, password: 'second' }));
  assert.equal(await targetKey(config), await targetKey({ ...config, root: 'notes' }));
  assert.notEqual(await targetKey(config), await targetKey({ ...config, username: 'you' }));
  assert.notEqual(await targetKey(config), await targetKey({ ...config, root: 'other' }));
  const vault = (uri: string) => ({ configDir: '.obsidian', adapter: { getResourcePath: (path: string) => uri + '/' + path } });
  assert.notEqual(await deriveLocalScope(vault('app://renderer/vault-a/main'), 'p'), await deriveLocalScope(vault('app://renderer/vault-b/main'), 'p'));
  assert.notEqual(await deriveLocalScope(vault('app://renderer/main'), 'p'), await deriveLocalScope(vault('app://renderer/main'), 'q'));
});
test('Obsidian resource cache-busting query is not part of stable vault identity', async () => {
  let stamp = 1;
  const vault = { configDir: '.obsidian', adapter: { getResourcePath: (path: string) => `app://renderer-${stamp}/main/${path}?${stamp++}` } };
  assert.equal(await deriveLocalScope(vault, 'p'), await deriveLocalScope(vault, 'p'));
  await assert.rejects(deriveLocalScope({ configDir: '.obsidian', adapter: { getResourcePath: () => 'app://resource?file=main' } }, 'p'));
});
