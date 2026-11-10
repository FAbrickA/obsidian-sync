import { hashBytes, canonicalBytes } from '../../src/snapshots.ts';
import { revisionId, eventId, decodeContainer } from '../../src/v2-codec.ts';
import type { StoredContainerV2, SlotRef } from '../../src/v2-types.ts';
import type { Revision, RevisionCore, EventRecord, Container, OutboxOperationV2 } from '../../src/v2-types.ts';
export const bytes = (s: string) => new TextEncoder().encode(s).buffer;
export async function rev(fileId = 'f', text = 'base', parents: string[] = [], operation?: RevisionCore['operation'], path = 'a.md'): Promise<Revision> {
  const data = bytes(text), hash = await hashBytes(data);
  const core: RevisionCore = { schema: 2, repositoryId: 'repo', fileId, parents, value: { kind: 'file', path, hash, size: data.byteLength },
    operation: operation ?? (parents.length ? 'edit' : 'create'), algorithmVersion: operation === 'merge' ? 1 : null, recreates: null };
  return { id: await revisionId(core), core };
}
export async function evt(revisions: Revision[], deviceId = 'device', previous: string | null = null, operationId = crypto.randomUUID()): Promise<EventRecord> {
  const core = { schema: 2 as const, repositoryId: 'repo', deviceId, operationId, previous, revisions };
  return { id: await eventId(core), core };
}
export const packed = (events: EventRecord[]): Container => ({ schema: 2, repositoryId: 'repo', events, sources: [], dependencies: [], previousSources: [] });
export const packedBytes = (events: EventRecord[]) => canonicalBytes(packed(events)).buffer;
export function op(event: EventRecord | null, id = crypto.randomUUID()): OutboxOperationV2 {
  return { id, boundaryId: 'boundary', repositoryId: 'repo', dirtyGeneration: 1, event, pinnedHashes: [], apply: [], proof: null, phase: 'prepared' };
}
export async function recorded(events: EventRecord[]): Promise<StoredContainerV2[]> {
  const refs=new Map<string,{eventId:string,slot:SlotRef}>(),result:StoredContainerV2[]=[];
  for(const event of events){
    const container:Container={schema:2,repositoryId:'repo',events:[event],sources:event.core.revisions.flatMap(r=>r.core.value.kind==='file'?[{
      hash:r.core.value.hash,size:r.core.value.size,slot:{path:`.webdav-sync-v2/repos/repo/blobs/device/b-${r.id}.${r.core.value.hash}.bin`,hash:r.core.value.hash,size:r.core.value.size}}]:[]),dependencies:[],previousSources:[]};
    for(const r of event.core.revisions)for(const id of [...r.core.parents,...(r.core.recreates?.tombstones??[])]){
      if(event.core.revisions.some(v=>v.id===id))continue;const ref=refs.get(id);if(ref)container.dependencies.push({revisionId:id,event:{eventId:ref.eventId,containerSlots:[ref.slot]}});
    }
    const data=canonicalBytes(container),hash=await hashBytes(data.buffer),slot={path:`.webdav-sync-v2/repos/repo/journal/device/0/segment/c-${event.id}.${hash}.json`,hash,size:data.byteLength};
    result.push({slot,decoded:await decodeContainer(data,hash,'repo')});for(const r of event.core.revisions)refs.set(r.id,{eventId:event.id,slot});
  }return result;
}
