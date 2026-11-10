import { DavError } from '../../src/transport.ts';
import type { DavV2 } from '../../src/transport.ts';
export function noCasDav() {
  const files = new Map<string, ArrayBuffer>(), directories = new Set(['']), puts: string[] = [];
  let afterPut: ((path: string, bytes: ArrayBuffer) => Promise<void>) | undefined;
  let beforeList: ((path: string) => Promise<void>) | undefined;
  const parent = (p: string) => p.includes('/') ? p.slice(0,p.lastIndexOf('/')) : '';
  const dav: DavV2 = {
    async read(path) { const b = files.get(path); if (!b) throw new DavError('NotFound',404); return {bytes:b.slice(0),etag:undefined}; },
    async put(path, bytes) { if (!directories.has(parent(path))) throw new DavError('Transient',409); puts.push(path); files.set(path,bytes.slice(0)); await afterPut?.(path,bytes.slice(0)); },
    async remove(path) { files.delete(path); },
    async mkdir(path) { if(directories.has(path))throw new DavError('Unsupported',405);if(!directories.has(parent(path)))throw new DavError('Transient',409);directories.add(path); },
    async list(path) { await beforeList?.(path); if(!directories.has(path))throw new DavError('NotFound',404);const prefix=path?path+'/':'';
      return [...Array.from(files,([p,b])=>({path:p,kind:'file' as const,size:b.byteLength})),...Array.from(directories,p=>({path:p,kind:'directory' as const,size:0}))].filter(x=>x.path!==path&&x.path.startsWith(prefix)&&!x.path.slice(prefix.length).includes('/')); },
    dispose() {},
  };
  return {dav,files,directories,puts,setAfterPut(fn?:typeof afterPut){afterPut=fn},setBeforeList(fn?:typeof beforeList){beforeList=fn}};
}
