import {mergeMarkdownMany} from './merge.ts';
import {mergeBookmarksMany} from './bookmarks.ts';
import type {ManyMergeResult} from './merge.ts';
declare const __MERGE_WORKER_SOURCE__:string;
export type MergeJob={kind:'markdown'|'bookmarks';base:ArrayBuffer|null;variants:ArrayBuffer[]};
export const mergeInline=(job:MergeJob):ManyMergeResult=>job.kind==='markdown'?mergeMarkdownMany(job.base,job.variants):mergeBookmarksMany(job.base,job.variants);
export async function mergeBackground(kind:MergeJob['kind'],base:ArrayBuffer|null,variants:ArrayBuffer[]):Promise<ManyMergeResult> {
  const job={kind,base,variants},size=(base?.byteLength??0)+variants.reduce((n,v)=>n+v.byteLength,0);
  if(size<524_288||typeof Worker==='undefined'||typeof __MERGE_WORKER_SOURCE__!=='string')return mergeInline(job);
  const url=URL.createObjectURL(new Blob([__MERGE_WORKER_SOURCE__],{type:'text/javascript'}));let worker:Worker|undefined;
  try {
    worker=new Worker(url);
    return await new Promise<ManyMergeResult>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Merge worker timeout')),30_000);
      worker!.onmessage=event=>{clearTimeout(timer);event.data.error?reject(new Error('Merge worker failed')):resolve(event.data.result);};
      worker!.onerror=()=>{clearTimeout(timer);reject(new Error('Merge worker failed'));};
      // Structured cloning keeps the durable original buffers intact for conflict recovery.
      worker!.postMessage(job);
    });
  }finally{worker?.terminate();URL.revokeObjectURL(url);}
}
