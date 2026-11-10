import { DavError } from '../../src/transport.ts';
import type {DavTransport} from '../../tools/lab/legacy-types.ts';
export function memoryDav() {
  const files = new Map<string, { bytes: ArrayBuffer; etag: string }>();
  const directories = new Set(['']); let revision = 0; let loseHeadResponse = false;
  const counts = { GET: 0, PUT: 0, DELETE: 0, MKCOL: 0, PROPFIND: 0 };
  const dav: DavTransport = {
    async read(path) { counts.GET++; const f = files.get(path); if (!f) throw new DavError('NotFound', 404); return { bytes: f.bytes.slice(0), etag: f.etag }; },
    async put(path, bytes, options) {
      counts.PUT++;
      const old = files.get(path);
      if (options.createOnly ? !!old : old?.etag !== options.ifMatch) throw new DavError('PreconditionFailed', 412);
      const etag = `"v${++revision}"`; files.set(path, { bytes: bytes.slice(0), etag });
      if (path.endsWith('/HEAD') && loseHeadResponse) { loseHeadResponse = false; throw new DavError('UnknownWrite'); }
      return { etag };
    },
    async remove(path, options) { counts.DELETE++; const f = files.get(path); if (!f) return; if (f.etag !== options.ifMatch) throw new DavError('PreconditionFailed', 412); files.delete(path); },
    async mkdir(path) { counts.MKCOL++; if (directories.has(path)) throw new DavError('Unsupported', 405); directories.add(path); },
    async list(path) {
      counts.PROPFIND++;
      if (!directories.has(path)) throw new DavError('NotFound', 404);
      const prefix = path ? path + '/' : '';
      return [...Array.from(files, ([p, f]) => ({ path: p, kind: 'file' as const, size: f.bytes.byteLength })),
        ...Array.from(directories, p => ({ path: p, kind: 'directory' as const, size: 0 }))]
        .filter(x => x.path.startsWith(prefix) && x.path !== path && !x.path.slice(prefix.length).includes('/'));
    }, dispose() {},
  };
  return { dav, files, counts, resetCounts() { for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0; }, loseNextHeadResponse() { loseHeadResponse = true; } };
}
