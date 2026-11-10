import {mergeInline} from './v2-merge-worker.ts';
import type {MergeJob} from './v2-merge-worker.ts';
self.onmessage=(event:MessageEvent<MergeJob>)=>{
  try{self.postMessage({result:mergeInline(event.data)});}catch{self.postMessage({error:true});}
};
