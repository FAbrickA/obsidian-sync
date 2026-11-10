import type { Vault } from 'obsidian';
export function memoryVault() {
  const files = new Map<string, { path: string; extension: string; stat: { size: number; mtime: number; ctime: number }; bytes: ArrayBuffer }>();
  const folders = new Set(['']); let clock = 0;
  let beforeProcess: (() => void) | undefined, beforeRead: (() => void) | undefined, beforeRename: (() => void) | undefined;
  const seed = (path: string, bytes: ArrayBuffer | string) => {
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes).buffer : bytes.slice(0);
    const parts = path.split('/'); for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    files.set(path, { path, extension: path.split('.').pop()!, stat: { size: data.byteLength, mtime: ++clock, ctime: clock }, bytes: data });
  };
  const get = (path: string) => files.get(path) ?? (folders.has(path) ? { path, children: [] } : null);
  const adapter = {
    async exists(path: string) { return files.has(path) || folders.has(path); },
    async readBinary(path: string) { const f = files.get(path); if (!f) throw new Error('Missing file.'); return f.bytes.slice(0); },
    async read(path: string) { return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await adapter.readBinary(path)); },
    async stat(path:string){return files.get(path)?.stat??null;},
    async process(path:string,transform:(text:string)=>string){seed(path,transform(await adapter.read(path)));},
    async mkdir(path: string) { if (await adapter.exists(path)) throw new Error('Exists.'); folders.add(path); },
  };
  const vault = {
    configDir: '.obsidian', adapter, getFiles: () => [...files.values()], getAbstractFileByPath: get,
    async readBinary(file: { path: string }) { const hook = beforeRead; beforeRead = undefined; hook?.(); return adapter.readBinary(file.path); },
    async createBinary(path: string, bytes: ArrayBuffer) {
      if (await adapter.exists(path)) throw new Error('Already exists.'); seed(path, bytes); return files.get(path)!;
    },
    async create(path: string, text: string) { return vault.createBinary(path, new TextEncoder().encode(text).buffer); },
    async createFolder(path: string) { await adapter.mkdir(path); return get(path); },
    async process(file: { path: string }, transform: (text: string) => string) {
      const hook = beforeProcess; beforeProcess = undefined; hook?.();
      const output = transform(await adapter.read(file.path)); seed(file.path, output); return output;
    },
    async rename(file: { path: string }, target: string) {
      const hook = beforeRename; beforeRename = undefined; hook?.();
      if (await adapter.exists(target)) throw new Error('Target exists.');
      const old = files.get(file.path); if (!old) throw new Error('Source missing.');
      files.delete(file.path); old.path = target; files.set(target, old);
    },
  };
  return { vault: vault as unknown as Vault, files, folders, seed, read: adapter.read, readBinary: adapter.readBinary,
    raceProcess(fn: () => void) { beforeProcess = fn; }, raceRead(fn: () => void) { beforeRead = fn; }, raceRename(fn: () => void) { beforeRename = fn; } };
}
