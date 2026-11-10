import type { Vault } from 'obsidian';
import type { DavConfig } from './transport.ts';
import type { PathPolicy } from './types.ts';
import { hashBytes, canonicalBytes } from './snapshots.ts';

export const metadataDir = '.webdav-sync';
export const metadataPrefixes = [metadataDir, '.webdav-sync-v2'];
export const bookmarksKey = '@bookmarks.json';
export const portablePathKey = (s: string) => s.normalize('NFC').toUpperCase();
export function normalizeRelativePath(raw: string): string {
  if (!raw || raw.startsWith('/') || /[\\\u0000-\u001f\u007f<>:"|?*]/.test(raw)) throw new Error('Unsafe path.');
  for (const part of raw.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('Non-portable path.');
  }
  return raw;
}
export function assertPortablePaths(paths: string[]): void {
  const nodes = new Map<string, { original: string; file: boolean }>();
  for (const path of paths) {
    normalizeRelativePath(path);
    if (metadataPrefixes.some(prefix => portablePathKey(path.split('/')[0]) === portablePathKey(prefix))) throw new Error('Reserved metadata path.');
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const original = parts.slice(0, i).join('/');
      const key = portablePathKey(original);
      const file = i === parts.length;
      const previous = nodes.get(key);
      if (previous && (previous.original !== original || previous.file || file)) throw new Error('Path collision.');
      nodes.set(key, { original, file });
    }
  }
}
export const isWithinPath = (p: string, prefix: string) => portablePathKey(p) === portablePathKey(prefix) || portablePathKey(p).startsWith(portablePathKey(prefix) + '/');
export function classifyPath(path: string, config: PathPolicy): 'sync' | 'bookmarks' | 'exclude' {
  normalizeRelativePath(path);
  if (portablePathKey(path) === portablePathKey(bookmarksKey)) return config.bookmarks ? 'bookmarks' : 'exclude';
  if (path === `${config.configDir}/bookmarks.json` && config.bookmarks) return 'bookmarks';
  if ([config.configDir, '.obsidian', ...metadataPrefixes, '.trash', '.git', '.webdav-sync-lab-results'].some(p => isWithinPath(path, p))
    || path === '.webdav-sync-lab.json') return 'exclude';
  if (config.exclude.some(p => isWithinPath(path, normalizeRelativePath(p)))) return 'exclude';
  if (config.include.length && !config.include.some(p => isWithinPath(path, normalizeRelativePath(p)))) return 'exclude';
  return 'sync';
}
export async function targetKey(config: Omit<DavConfig, 'password'> & { password?: string }): Promise<string> {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Unsafe endpoint.');
  const root = normalizeRelativePath(config.root.replace(/^\/+|\/+$/g, ''));
  return hashBytes(canonicalBytes({ endpoint: endpoint.href.replace(/\/+$/, ''), root, username: config.username }).buffer);
}
export async function targetKeyV2(config: Omit<DavConfig, 'password'> & { password?: string }): Promise<string> {
  // Scope includes the protocol; credentials can rotate without creating a new history.
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Unsafe endpoint.');
  const root = normalizeRelativePath(config.root.replace(/^\/+|\/+$/g, ''));
  return hashBytes(canonicalBytes({ protocol: 2, endpoint: endpoint.href.replace(/\/+$/, ''), root, username: config.username }).buffer);
}
export async function deriveLocalScope(vault: Pick<Vault, 'configDir'> & {
  adapter: Pick<Vault['adapter'], 'getResourcePath'> }, profileId: string): Promise<string> {
  if (!profileId) throw new Error('Missing profile identity.');
  const marker = `${vault.configDir}/plugins/webdav-sync/local-scope`;
  const resource = new URL(vault.adapter.getResourcePath(marker));
  // Obsidian appends a fresh cache-busting query on every call. Only adapters
  // exposing the requested file in the URI path are supported by this strategy.
  if (!decodeURIComponent(resource.pathname).endsWith('/' + marker) || resource.username || resource.password) throw new Error('Stable local identity unavailable.');
  if (decodeURIComponent(resource.pathname).length <= marker.length + 2) throw new Error('Vault resource root unavailable.');
  // Desktop app:// authority is a new renderer nonce, not a vault identifier.
  // The absolute resource pathname identifies the vault; keep other schemes intact.
  if (resource.protocol === 'app:') { resource.hostname = 'local'; resource.port = ''; }
  resource.search = ''; resource.hash = '';
  return hashBytes(canonicalBytes({ uri: resource.href, profileId }).buffer);
}
