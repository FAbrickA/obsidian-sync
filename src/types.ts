export type Hash = string;
export type RepositoryId = string;
export type FileEntry = { kind: 'file'; fileId: string; path: string; hash: Hash; size: number };
export type Tombstone = { kind: 'tombstone'; fileId: string; path: string; lastHash: Hash };
export type Entry = FileEntry | Tombstone;
export type LocalFile = { path: string; hash: Hash; size: number; mtime?: number; generation?: number };
export type LocalSnapshot = { files: Record<string, LocalFile>; excluded: string[]; complete: boolean; policy?: PathPolicy; capturedGeneration?: number };
export type DirtyEvents = { generation: number; renames: { fileId: string; from: string; to: string; generation?: number }[];
  paths?: Record<string, number> };
export type DirtyEvent = { generation: number; kind: 'create' | 'modify' | 'delete' | 'rename' | 'rescan'; path: string; from?: string };
export type SyncAction = { kind: 'upload' | 'download' | 'delete' | 'merge' | 'conflict' | 'confirm';
  applicationId?: string;
  fileId: string | null; path: string; base: Entry | null; local: LocalFile | null; remote: Entry | null;
  direction?: 'local' | 'remote'; reason?: string };
export type PathPolicy = { configDir: string; include: string[]; exclude: string[]; bookmarks: boolean };
export type MergeResult = { kind: 'clean'; bytes: ArrayBuffer } | {
  kind: 'conflict'; reason: string; base: ArrayBuffer | null; local: ArrayBuffer; remote: ArrayBuffer };
