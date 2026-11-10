const phases = new Set(['connect', 'snapshot', 'publish', 'apply', 'projection', 'recovery', 'idle', 'close']);
const statuses = new Set(['running', 'closing', 'clean', 'conflicted', 'pending', 'blocked', 'offline']);
const codes = new Set(['NotFound', 'PreconditionFailed', 'Auth', 'Permission', 'RateLimited', 'Transient', 'UnknownWrite', 'CorruptData', 'Unsupported', 'LocalIOFailure']);
export type DiagnosticEvent = { ts: number; phase?: string; status?: string; code?: string; durationMs?: number; files?: number; bytes?: number; httpStatus?: number };
export function redactEvent(value: unknown): DiagnosticEvent {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result: DiagnosticEvent = { ts: typeof v.ts === 'number' && Number.isFinite(v.ts) ? v.ts : Date.now() };
  if (typeof v.phase === 'string' && phases.has(v.phase)) result.phase = v.phase;
  if (typeof v.status === 'string' && statuses.has(v.status)) result.status = v.status;
  if (typeof v.code === 'string') result.code = codes.has(v.code) ? v.code : 'LocalIOFailure';
  for (const key of ['durationMs', 'files', 'bytes', 'httpStatus'] as const) if (typeof v[key] === 'number' && Number.isFinite(v[key]) && v[key] >= 0) result[key] = v[key];
  return result;
}
export function createDiagnostics(limit = 500) {
  const events: DiagnosticEvent[] = [];
  return { add(value: unknown) { events.push(redactEvent(value)); if (events.length > limit) events.shift(); },
    entries: () => structuredClone(events), export: () => JSON.stringify({ schema: 1, events }, null, 2) };
}
