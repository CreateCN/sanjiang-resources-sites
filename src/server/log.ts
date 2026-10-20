import { randomUUID } from 'node:crypto';

const SKIP_PREFIXES = ['/_astro/', '/favicon.svg', '/og-default.png'];
const SKIP_PATHS = new Set(['/api/health/']);

/** Structured request log without query strings, IPs or user agents. */
export function logRequest(input: { id: string; request: Request; status: number; startedAt: bigint }): void {
  let path = '/';
  try { path = new URL(input.request.url).pathname; } catch { /* keep default */ }
  if (SKIP_PATHS.has(path)) return;
  if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) return;
  const line = {
    time: new Date().toISOString(),
    requestId: input.id,
    method: input.request.method,
    path,
    status: input.status,
    ms: Math.max(0, Math.round(Number(process.hrtime.bigint() - input.startedAt) / 1e6)),
  };
  console.log(JSON.stringify(line));
}

export function newRequestId(): string {
  return randomUUID();
}
