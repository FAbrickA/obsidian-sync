import test from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { createDavHandler } from '../tools/lab/dav-server.ts';
function request(handler: ReturnType<typeof createDavHandler>, path: string, text: string, headers: Record<string, string>, wait = Promise.resolve()) {
  const captured = { status: 0, headers: {} as Record<string, string> };
  const req = { url: path, method: 'PUT', headers, async *[Symbol.asyncIterator]() { await wait; yield Buffer.from(text); } } as unknown as http.IncomingMessage;
  const res = { writeHead(status: number, headers: Record<string, string> = {}) { captured.status = status; captured.headers = headers; return this; }, end() {} } as unknown as http.ServerResponse;
  return { run: () => handler(req, res), captured };
}
test('fixture checks CAS at mutation after overlapping request bodies (If-Match and create-only)', async () => {
  for (const createOnly of [false, true]) {
    const handler = createDavHandler(); const path = '/lab/HEAD';
    let headers: Record<string, string>;
    if (createOnly) headers = { 'if-none-match': '*' };
    else { const seed = request(handler, path, 'seed', { 'if-none-match': '*' }); await seed.run(); headers = { 'if-match': seed.captured.headers.ETag }; }
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const a = request(handler, path, 'left', headers, wait), b = request(handler, path, 'right', headers, wait);
    const first = a.run(), second = b.run(); release(); await Promise.all([first, second]);
    assert.deepEqual([a.captured.status, b.captured.status].sort(), [createOnly ? 201 : 204, 412].sort());
  }
});
