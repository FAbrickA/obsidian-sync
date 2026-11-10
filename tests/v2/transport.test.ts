import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { createNativeDav, DavError } from '../../src/transport.ts';
import type { NativeRequest } from '../../src/transport.ts';
Object.defineProperty(globalThis, 'DOMParser', { value: DOMParser, configurable: true });
const config = { endpoint: 'https://dav.example/', root: 'lab', username: 'юзер', password: 'пароль' };
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const response = (status: number, text = '', headers: Record<string, string> = {}) => ({ status, text, headers, arrayBuffer: bytes(text), json: null });
const item = (href: string, dir = false, size = '3') => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${dir ? '<d:collection/>' : ''}</d:resourcetype>${dir ? '' : `<d:getcontentlength>${size}</d:getcontentlength>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const xml = (inner: string) => `<d:multistatus xmlns:d="DAV:">${inner}</d:multistatus>`;
const self = item('/lab/', true);

test('native transport encodes UTF-8 Basic and literal paths without global routing or conditional writes', async () => {
  const requests: Parameters<NativeRequest>[0][] = [];
  const dav = createNativeDav(config, async r => { requests.push(r); return response(r.method === 'GET' ? 200 : 201, '✓', { ETag: 'unquoted' }); });
  const result = await dav.read('Кириллица #%.md'); await dav.put('literal %2F & name.md', new ArrayBuffer(0));
  assert.equal(new TextDecoder().decode(result.bytes), '✓'); assert.equal(result.etag, 'unquoted');
  assert.equal(requests[0].url, 'https://dav.example/lab/%D0%9A%D0%B8%D1%80%D0%B8%D0%BB%D0%BB%D0%B8%D1%86%D0%B0%20%23%25.md');
  assert.equal(requests[1].url, 'https://dav.example/lab/literal%20%252F%20%26%20name.md');
  assert.equal(requests[0].headers?.Authorization, 'Basic '+Buffer.from('юзер:пароль').toString('base64'));
  assert.equal((requests[1].body as ArrayBuffer).byteLength, 0);
  assert(!Object.keys(requests[1].headers??{}).some(k => /if-|x-webdav-sync/i.test(k)));
  assert.equal(requests[1].throw, false);
  await dav.mkdir('');
  assert.equal(requests[2].method, 'MKCOL');
  assert.equal(requests[2].url, 'https://dav.example/lab/');
});
test('native errors are redacted, isolated and never retry an issued mutation', async () => {
  let issued = 0;
  const a = createNativeDav(config, async () => { issued++; throw Error('secret'); });
  const b = createNativeDav(config, async () => response(429, 'secret', { 'ReTrY-AfTeR': '19' }));
  await assert.rejects(a.put('a.md', bytes('a')), (e: DavError) => e.kind === 'UnknownWrite' && !e.message.includes('secret'));
  assert.equal(issued, 1);
  await assert.rejects(a.read('a.md'), (e: DavError) => e.kind === 'Transient');
  await assert.rejects(b.read('a.md'), (e: DavError) => e.kind === 'RateLimited' && e.retryAfter === '19');
  for (const [status, kind] of [[401,'Auth'],[403,'Permission'],[503,'Transient'],[404,'NotFound']] as const) {
    const d = createNativeDav(config, async () => response(status));
    await assert.rejects(d.read('a.md'), (e: DavError) => e.kind === kind);
  }
  await createNativeDav(config, async () => response(404)).remove('absent.md');
  a.dispose(); await assert.rejects(a.read('a.md'));
});
test('native endpoint and request paths cannot escape scope or smuggle URL credentials', async () => {
  for (const endpoint of ['http://dav.example/', 'https://user:pass@dav.example/', 'https://dav.example/?x=1', 'https://dav.example/#x'])
    assert.throws(() => createNativeDav({ ...config, endpoint }, async () => response(200)));
  const dav = createNativeDav(config, async () => { throw Error('network must not run'); });
  for (const path of ['../x','/x','a//b','a\\b','a/./b']) await assert.rejects(dav.read(path), (e: DavError) => e.kind === 'Unsupported');
});
test('Depth1 list validates self, direct children and single decoding of literal percent paths', async () => {
  let request: Parameters<NativeRequest>[0] | undefined;
  const dav = createNativeDav(config, async r => { request = r; return response(207, xml(self + item('/lab/literal%20%252F%20%26amp%3B.md') + item('https://dav.example/lab/folder/', true))); });
  assert.deepEqual(await dav.list(''), [{ path: 'literal %2F &amp;.md', kind: 'file', size: 3 }, { path: 'folder', kind: 'directory', size: 0 }]);
  assert.equal(request?.headers?.Depth, '1'); assert.equal(request?.method, 'PROPFIND');
});
test('malformed or incomplete DAV responses fail closed, including both prototype counterexamples', async () => {
  const bad = [xml(''), xml('<d:response><d:href>/lab/</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>'),
    xml(item('/lab/a.md')), xml(self+item('/lab/a.md',false,'-1')), xml(self+item('/lab/a.md',false,'9007199254740992')),
    xml(self+item('/lab/a.md')+item('/lab/a.md')), xml(self+item('/lab/nested/a.md')), xml(self+item('/lab/a%2Fb.md')),
    xml(self+item('/lab/%2e%2e/x')), xml(self+item('/lab/a.md?q=1')), xml(self+item('/lab/a.md#x')),
    xml(self+item('https://evil.example/lab/a.md')), xml(self+item('https://user:pass@dav.example/lab/a.md')),
    xml(self+item('/lab/a%ZZ.md')), xml(self+item('/lab/a.md')+'<x:response xmlns:x="wrong"/>'),
    xml(self).replace('xmlns:d="DAV:"','xmlns:d="wrong"'), '<!DOCTYPE x [<!ENTITY y "x">]>'+xml(self),
    xml(self).replace('</d:multistatus>',''), xml(self+'<d:response><d:href>/lab/missing</d:href><d:status>HTTP/1.1 503 Fail</d:status></d:response>')];
  for (const body of bad) {
    const dav = createNativeDav(config, async () => response(207, body));
    await assert.rejects(dav.list(''), (e: DavError) => e.kind === 'CorruptData', body);
  }
});
