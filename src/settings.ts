import type { DavConfig } from './transport.ts';
import type { PathPolicy } from './types.ts';
import { normalizeRelativePath, isWithinPath } from './paths.ts';
export type Settings = DavConfig & PathPolicy & { schema: 2; protocol:2; repositoryMode:'create-v2'|'attach-v2'; profileId: string; autoSync: boolean;
  intervalSeconds: number; debounceMs: number; concurrency: number; deletionGuardPercent: number;
  syncOnStartup: boolean; syncOnSave: boolean; syncOnFocus: boolean; rememberPassword: boolean;
  repositoryId: string; verifiedTarget: string; secretId: string };
export const defaultSettings = (): Settings => ({ schema: 2, protocol:2, repositoryMode:'attach-v2', endpoint: '', root: '', username: '', password: '',
  configDir: '.obsidian', include: [], exclude: [], bookmarks: true, profileId: crypto.randomUUID(),
  autoSync: true, intervalSeconds: 60, debounceMs: 1000, concurrency: 2, deletionGuardPercent: 20,
  syncOnStartup: true, syncOnSave: true, syncOnFocus: true, rememberPassword: false, repositoryId: '', verifiedTarget: '', secretId: '' });
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings.');
  const defaults = defaultSettings(); const raw = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, raw[key] ?? fallback])) as Settings;
  for (const [key, fallback] of Object.entries(defaults)) {
    const field = (result as unknown as Record<string, unknown>)[key];
    if (Array.isArray(fallback) ? !Array.isArray(field) || !field.every(v => typeof v === 'string') : typeof field !== typeof fallback) throw new Error('Invalid setting type.');
  }
  if(raw.schema===1) {result.schema=2;result.protocol=2;result.repositoryMode='attach-v2';result.repositoryId='';result.verifiedTarget='';}
  if (result.schema !== 2 || result.protocol!==2 || !['create-v2','attach-v2'].includes(result.repositoryMode) || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.profileId)) throw new Error('Unsupported settings schema/identity.');
  if (result.endpoint) {
    const url = new URL(result.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('HTTPS endpoint without URL secrets required.');
    result.endpoint = url.href;
  }
  if (result.root) {
    result.root = normalizeRelativePath(result.root.replace(/^\/+|\/+$/g, ''));
    if (result.root.split('/').some(p => ['.webdav-sync','.webdav-sync-v2'].some(m=>isWithinPath(p,m)))) throw new Error('Reserved remote root.');
  }
  normalizeRelativePath(result.configDir);
  for (const path of [...result.include, ...result.exclude]) normalizeRelativePath(path);
  if (result.include.some(path => [result.configDir, '.obsidian', '.webdav-sync','.webdav-sync-v2'].some(p => isWithinPath(path, p)))) throw new Error('Settings/state cannot be included.');
  for (const [key, minimum, maximum] of [['concurrency', 1, 8], ['debounceMs', 100, 10000], ['intervalSeconds', 10, 3600], ['deletionGuardPercent', 0, 100]] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < minimum || result[key] > maximum) throw new Error('Setting outside supported range.');
  }
  return result;
}
