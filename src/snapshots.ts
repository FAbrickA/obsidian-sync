import type {Hash} from './types.ts';
export async function hashBytes(bytes: ArrayBuffer): Promise<Hash> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  function ordered(v: unknown): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(ordered);
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, ordered((v as Record<string, unknown>)[k])]));
    }
    throw new Error('Unsupported canonical value.');
  }
  return new TextEncoder().encode(JSON.stringify(ordered(value)));
}
export const validHash=(v:unknown):v is Hash=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
