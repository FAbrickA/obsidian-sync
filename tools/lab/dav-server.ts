// Disposable loopback-only DAV fixture. No filesystem or user credentials.
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
type Entry = { body: Buffer; etag: string; directory: boolean };
export type DavFixtureOptions={mode?:'strict'|'mailru-like';etag?:'quoted'|'weak'|'unquoted'|'none';
  afterPut?(path:string,body:Buffer):Promise<number|undefined>;transformPut?(path:string,body:Buffer):Buffer;
  transformListing?(path:string,xml:string):string};
export function createDavHandler(options:DavFixtureOptions={}) {
const entries = new Map<string, Entry>([['/lab', { body: Buffer.alloc(0), etag: '"root"', directory: true }]]);
let revision = 0;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
return async (request: http.IncomingMessage, response: http.ServerResponse) => {
  let key: string;
  try { key = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/\/$/, ''); }
  catch { response.writeHead(400).end(); return; }
  if (!key.startsWith('/lab/')) { response.writeHead(403).end(); return; }
  let current = entries.get(key);
  const precondition = () => options.mode==='mailru-like' || (request.headers['if-match'] === undefined || request.headers['if-match'] === current?.etag)
    && (request.headers['if-none-match'] !== '*' || !current);
  const tag=(entry:Entry):Record<string,string>=>options.etag==='none'?{}:{ETag:options.etag==='weak'?'W/'+entry.etag:options.etag==='unquoted'?entry.etag.slice(1,-1):entry.etag};
  if (request.method !== 'PUT' && !precondition()) { response.writeHead(412).end(); return; }
  if (request.method === 'MKCOL') {
    if (current) { response.writeHead(405).end(); return; }
    entries.set(key, { body: Buffer.alloc(0), directory: true, etag: `"r${++revision}"` });
    response.writeHead(201).end(); return;
  }
  if (request.method === 'PUT') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024 * 1024) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    current = entries.get(key);
    if (!precondition()) { response.writeHead(412).end(); return; }
    const etag = `"r${++revision}"`;
    const body=options.transformPut?.(key,Buffer.concat(chunks))??Buffer.concat(chunks);
    entries.set(key, { body, directory: false, etag });
    const forced=await options.afterPut?.(key,body);if(forced){response.writeHead(forced).end();return;}
    const delay = Number(key.match(/\/slow-(\d+)$/)?.[1] ?? 0);
    if (delay > 0 && delay <= 120_000) await new Promise(resolve => setTimeout(resolve, delay));
    response.writeHead(current ? 204 : 201, tag(entries.get(key)!)).end(); return;
  }
  if (request.method === 'DELETE') {
    if (key.endsWith('/refuse-delete')) { response.writeHead(503, { 'Retry-After': '1' }).end(); return; }
    if (!current) { response.writeHead(404).end(); return; }
    if (current.directory) { response.writeHead(403).end(); return; }
    entries.delete(key); response.writeHead(204).end(); return;
  }
  if (!current) { response.writeHead(404).end(); return; }
  if(request.method==='MOVE') {
    let destination:string;try{destination=decodeURIComponent(new URL(String(request.headers.destination),'http://localhost').pathname).replace(/\/$/,'');}catch{response.writeHead(400).end();return;}
    if(!destination.startsWith('/lab/')){response.writeHead(403).end();return;}
    if(options.mode!=='mailru-like'&&request.headers.overwrite==='F'&&entries.has(destination)){response.writeHead(412).end();return;}
    entries.set(destination,current);entries.delete(key);response.writeHead(201).end();return;
  }
  if (request.method === 'HEAD') { response.writeHead(200,{ETag:current.etag,'Content-Length':current.body.length}).end();return; }
  if (request.method === 'GET') {
    const delay=Number(new URL(request.url??'/','http://localhost').searchParams.get('lab-delay-ms')??0);
    if(delay>0&&delay<=60_000)await new Promise(r=>setTimeout(r,delay));
    response.writeHead(200, { ...tag(current), 'Content-Type': 'application/octet-stream' }).end(current.body); return;
  }
  if (request.method === 'PROPFIND') {
    let xml: string;
    if (key.endsWith('/broken')) xml = `<d:response><d:href>${escape(key)}</d:href><d:status>HTTP/1.1 503 Unavailable</d:status></d:response>`;
    else xml = [...entries].filter(([name]) => name === key || name.startsWith(key + '/') && !name.slice(key.length + 1).includes('/'))
      .map(([name, item]) => `<d:response><d:href>${escape(encodeURI(name))}${item.directory ? '/' : ''}</d:href><d:propstat><d:prop><d:resourcetype>${item.directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${item.body.length}</d:getcontentlength><d:getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</d:getlastmodified><d:getetag>${escape(item.etag)}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('');
    const body=`<d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`;
    response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' }).end(options.transformListing?.(key,body)??body); return;
  }
  response.writeHead(405).end();
};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
const server = http.createServer(createDavHandler(process.argv.includes('--mailru-like')?{mode:'mailru-like',etag:'none'}:{}));
server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as { port: number }).port;
  await mkdir('.lab', { recursive: true });
  await writeFile('.lab/dav-server.json', JSON.stringify({ port, purpose: 'webdav-sync-lab', pid: process.pid }));
  console.log(JSON.stringify({ port, purpose: 'webdav-sync-lab' }));
});
}
