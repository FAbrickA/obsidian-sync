import type {LocalFile} from './types.ts';
import { revisionId } from './v2-codec.ts';
import type { AppliedFileV2, Revision, RevisionCore } from './v2-types.ts';

export async function makeLocalRevisionV2(repositoryId: string, applied: AppliedFileV2, local: LocalFile | null): Promise<Revision | null> {
  if (applied.value.kind === 'tombstone') { if (local) throw new Error('Recreation requires a new identity.'); return null; }
  if (local && local.hash === applied.value.hash && local.size === applied.value.size && local.path === applied.value.path) return null;
  const core: RevisionCore = { schema: 2, repositoryId, fileId: applied.fileId, parents: [...applied.revisionIds].sort(),
    value: local ? { kind: 'file', path: local.path, hash: local.hash, size: local.size } : { kind: 'tombstone', path: applied.value.path },
    operation: local ? (local.path === applied.value.path ? 'edit' : 'rename') : 'delete', algorithmVersion: null, recreates: null };
  return { id: await revisionId(core), core };
}
