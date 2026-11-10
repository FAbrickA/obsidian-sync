import type {RequestUrlParam,RequestUrlResponse} from 'obsidian';
export type NativeRequest = (request: RequestUrlParam) => Promise<RequestUrlResponse>;
export type DavConfig = { endpoint: string; root: string; username: string; password: string };
export type DavErrorKind = 'NotFound' | 'PreconditionFailed' | 'Auth' | 'Permission' | 'RateLimited'
  | 'Transient' | 'UnknownWrite' | 'CorruptData' | 'Unsupported';
export class DavError extends Error {
  readonly kind: DavErrorKind;
  readonly status?: number;
  readonly retryAfter?: string;
  constructor(kind: DavErrorKind, status?: number, retryAfter?: string) {
    super(`WebDAV ${kind}${status === undefined ? '' : ` (${status})`}.`);
    this.name = 'DavError'; this.kind = kind; this.status = status; this.retryAfter = retryAfter;
  }
}
export type DavEntry = { path: string; kind: 'file' | 'directory'; size: number };
export type DavV2=ReturnType<typeof createNativeDav>;
function statusError(status: number, retryAfter?: string): DavError {
  const kind: DavErrorKind = status === 404 ? 'NotFound' : status === 412 ? 'PreconditionFailed'
    : status === 401 ? 'Auth' : status === 403 ? 'Permission' : status === 429 ? 'RateLimited'
      : status >= 500 || status === 408 || status === 423 ? 'Transient' : 'Unsupported';
  return new DavError(kind, status, retryAfter);
}
export function createNativeDav(config: DavConfig, native: NativeRequest) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !config.username || /[:\u0000-\u001f\u007f]/.test(config.username)) throw new DavError('Unsupported');
  function safeParts(value: string, empty = false): string[] {
    if (empty && value === '') return [];
    const parts = value.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[\\\u0000-\u001f\u007f]/.test(p))) throw new DavError('Unsupported');
    return parts;
  }
  const root = safeParts(config.root.replace(/^\/+|\/+$/g, ''));
  const base = endpoint.href.replace(/\/+$/, '') + '/' + root.map(encodeURIComponent).join('/') + '/';
  const baseURL = new URL(base);
  let auth = '';
  for (const byte of new TextEncoder().encode(`${config.username}:${config.password}`)) auth += String.fromCharCode(byte);
  let authorization = 'Basic ' + btoa(auth), disposed = false;
  async function request(method: string, value: string, body?: ArrayBuffer, headers: Record<string, string> = {}) {
    if (disposed) throw new DavError('Unsupported');
    const url = base + safeParts(value, method === 'PROPFIND' || method === 'MKCOL').map(encodeURIComponent).join('/');
    let response: RequestUrlResponse;
    try { response = await native({ url, method, throw: false, headers: { Authorization: authorization, ...headers },
      ...(body !== undefined ? { body: body.slice(0), contentType: headers['Content-Type'] ?? 'application/octet-stream' } : {}) }); }
    catch { throw new DavError(['GET', 'PROPFIND'].includes(method) ? 'Transient' : 'UnknownWrite'); }
    const lower = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (response.status < 200 || response.status >= 300) throw statusError(response.status, lower['retry-after']);
    if ((method === 'PROPFIND' && response.status !== 207) || (method !== 'PROPFIND' && response.status === 207)) throw new DavError('CorruptData');
    return { response, headers: lower, url };
  }
  return {
    async read(value: string): Promise<{ bytes: ArrayBuffer; etag?: string }> {
      const { response, headers } = await request('GET', value, undefined, { 'Cache-Control': 'no-cache' });
      return { bytes: response.arrayBuffer, etag: headers.etag };
    },
    async put(value: string, data: ArrayBuffer) { await request('PUT', value, data, { 'Content-Type': 'application/octet-stream' }); },
    async remove(value: string) {
      try { await request('DELETE', value); }
      catch (error) { if (!(error instanceof DavError && error.kind === 'NotFound')) throw error; }
    },
    async mkdir(value: string) { await request('MKCOL', value); },
    async list(value: string): Promise<DavEntry[]> {
      const body = new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>').buffer;
      const { response, url } = await request('PROPFIND', value, body, { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' });
      return parseNativeListing(response.arrayBuffer, new URL(url), baseURL);
    },
    dispose() { disposed = true; authorization = ''; },
  };
}

function parseNativeListing(bytes: ArrayBuffer, requested: URL, base: URL): DavEntry[] {
  const corrupt = (): never => { throw new DavError('CorruptData'); };
  if (bytes.byteLength > 8_388_608) corrupt();
  let document: Document;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/<!DOCTYPE/i.test(text)) corrupt();
    document = new DOMParser().parseFromString(text, 'application/xml');
  } catch { return corrupt(); }
  const doc = document!;
  if (doc.documentElement?.localName !== 'multistatus' || doc.documentElement.namespaceURI !== 'DAV:'
    || Array.from(doc.getElementsByTagName('*')).some(e => e.localName === 'parsererror')) corrupt();
  function children(e: Element, name: string): Element[] {
    return Array.from(e.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === 'DAV:' && (n as Element).localName === name);
  }
  function one(e: Element, name: string): Element { const a = children(e, name); if (a.length !== 1) return corrupt(); return a[0]; }
  function decodePath(raw: string): string[] {
    try {
      const parts = raw.replace(/\/$/, '').split('/');
      if (parts.shift() !== '') return corrupt();
      return parts.map(p => { const decoded = decodeURIComponent(p); if (!decoded || decoded === '.' || decoded === '..' || /[\/\\\u0000-\u001f\u007f]/.test(decoded)) corrupt(); return decoded; });
    } catch { return corrupt(); }
  }
  const baseParts = decodePath(base.pathname), requestParts = decodePath(requested.pathname);
  const requestedPath = requestParts.join('/');
  const responses = children(doc.documentElement, 'response');
  if (!responses.length || responses.length !== doc.getElementsByTagNameNS('DAV:', 'response').length
    || Array.from(doc.documentElement.childNodes).some(n => n.nodeType === 1 && (n as Element).localName === 'response' && (n as Element).namespaceURI !== 'DAV:')) corrupt();
  const entries: DavEntry[] = [], seen = new Set<string>(); let selfSeen = false;
  for (const r of responses) {
    const href = one(r, 'href').textContent?.trim() ?? ''; if (!href || /[?#]/.test(href)) corrupt();
    let rawPath: string;
    if (href.startsWith('/') && !href.startsWith('//')) rawPath = href;
    else {
      const match = /^https:\/\/[^/]+(\/.*)$/.exec(href); if (!match) return corrupt(); rawPath = match[1];
    }
    // Inspect before URL normalization could erase encoded or literal dot segments.
    const parts = decodePath(rawPath);
    let target: URL; try { target = new URL(href, requested); } catch { return corrupt(); }
    if (target.origin !== base.origin || target.username || target.password || target.search || target.hash) corrupt();
    const full = parts.join('/');
    if (seen.has(full)) corrupt(); seen.add(full);
    const directStatus = children(r, 'status');
    if (directStatus.length > 1 || directStatus.some(s => !/^HTTP\/[\d.]+\s+2\d\d\b/.test(s.textContent ?? ''))) corrupt();
    const props = new Map<string, Element>();
    for (const ps of children(r, 'propstat')) {
      const status = one(ps, 'status').textContent ?? '';
      if (!/^HTTP\/[\d.]+\s+\d{3}\b/.test(status)) corrupt();
      if (!/^HTTP\/[\d.]+\s+2\d\d\b/.test(status)) continue;
      for (const p of Array.from(one(ps, 'prop').childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === 'DAV:')) {
        if (props.has(p.localName)) corrupt(); props.set(p.localName, p);
      }
    }
    const type = props.get('resourcetype'); if (!type) return corrupt();
    const directory = children(type, 'collection').length === 1;
    if (Array.from(type.childNodes).some(n => n.nodeType === 1 && ((n as Element).localName !== 'collection' || (n as Element).namespaceURI !== 'DAV:'))
      || children(type, 'collection').length > 1) corrupt();
    let size = 0;
    if (!directory) { const raw = props.get('getcontentlength')?.textContent ?? ''; if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) corrupt(); size = Number(raw); }
    if (full === requestedPath) { if (!directory || selfSeen) corrupt(); selfSeen = true; continue; }
    if (parts.length !== requestParts.length + 1 || !requestParts.every((p, i) => parts[i] === p) || !baseParts.every((p, i) => parts[i] === p)) corrupt();
    entries.push({ path: parts.slice(baseParts.length).join('/'), kind: directory ? 'directory' : 'file', size });
  }
  if (!selfSeen) corrupt();
  return entries;
}
