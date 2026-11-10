import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, validateSettings } from '../src/settings.ts';
import { classifyPath } from '../src/paths.ts';
test('settings validate HTTPS, root, numeric bounds and protect credential/state scope', () => {
  const base = { ...defaultSettings(), endpoint: 'https://dav.example', root: '/notes/', username: 'user' };
  assert.equal(validateSettings(base).root, 'notes');
  for (const patch of [{ endpoint: 'http://dav.example' }, { endpoint: 'https://u:p@dav.example' }, { root: '../escape' },
    { root: '.webdav-sync' }, { concurrency: 0 }, { debounceMs: -1 }, { intervalSeconds: 0 }, { include: ['.obsidian/plugins'] }]) {
    assert.throws(() => validateSettings({ ...base, ...patch }));
  }
  assert.equal(classifyPath('.obsidian/plugins/webdav-sync-lab/data.json', validateSettings(base)), 'exclude');
  assert.equal(defaultSettings().concurrency, 2); assert.equal(defaultSettings().debounceMs, 1000);
});
