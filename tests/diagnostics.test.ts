import test from 'node:test';
import assert from 'node:assert/strict';
import { redactEvent, createDiagnostics } from '../src/diagnostics.ts';
test('diagnostic export is an allowlist without credentials, URL/query, paths or note bodies', () => {
  const secret = 'must-never-appear'; const event = { ts: 7, phase: 'publish', code: 'Transient', status: 'blocked', durationMs: 3,
    password: secret, token: secret, path: secret, message: secret, url: `https://u:${secret}@example?q=${secret}`, body: secret, headers: { Authorization: secret, Cookie: secret } };
  const safe = redactEvent(event); assert.equal(safe.phase, 'publish'); assert(!JSON.stringify(safe).includes(secret));
  assert(!JSON.stringify(redactEvent({ code: secret, phase: secret, status: secret })).includes(secret));
  const log = createDiagnostics(2); for (let i = 0; i < 4; i++) log.add(event); assert.equal(log.entries().length, 2); assert(!log.export().includes(secret));
});
