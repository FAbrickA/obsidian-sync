// Never reject while requests already issued by another worker are still pending.
export async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Invalid concurrency.');
  let next=0, failed=false; let error: unknown;
  await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{
    while(!failed && next<items.length) {
      const item=items[next++];
      try { await work(item); } catch(e) { failed=true;error=e; }
    }
  }));
  if(failed) throw error;
}
