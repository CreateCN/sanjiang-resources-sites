import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^127\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^198\.1[89]\./, /^22[4-9]\./, /^23\d\./, /^24\d\./, /^25[0-5]\./,
];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);
/** Only web ports are worth checking; anything else widens the probe surface. */
const ALLOWED_PORTS = new Set(['', '80', '443']);
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 32 * 1024;

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (isIP(value) === 6) {
    if (value === '::1' || value === '::') return true;
    if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value)) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1] ?? '') : false;
  }
  return PRIVATE_V4.some((pattern) => pattern.test(value));
}

interface ResolvedTarget { url: URL; addresses: { address: string; family: number }[] }

/**
 * Reject non-http(s), credentialed, non-web-port and private/loopback targets,
 * then return the addresses that were actually validated. The caller pins the
 * connection to one of them, so a second DNS answer cannot redirect the fetch
 * into the internal network (DNS rebinding / TOCTOU).
 */
export async function resolvePublicTarget(input: string): Promise<ResolvedTarget> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('链接格式不正确'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只检查 http/https 链接');
  if (url.username || url.password) throw new Error('链接不能包含账号信息');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) throw new Error('不允许检查内网或本机地址');
  // Reject literal private addresses before the port rule so the message stays specific.
  if (isIP(host) !== 0 && isPrivateAddress(host)) throw new Error('不允许检查内网或本机地址');
  if (!ALLOWED_PORTS.has(url.port)) throw new Error('只检查 80/443 端口的链接');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('域名无法解析');
  if (addresses.some((record) => isPrivateAddress(record.address))) throw new Error('不允许检查内网或本机地址');
  return { url, addresses };
}

/** Backwards-compatible helper used by tests and callers that only need validation. */
export async function assertPublicUrl(input: string): Promise<URL> {
  return (await resolvePublicTarget(input)).url;
}

export interface LinkCheckResult {
  status: 'ok' | 'warn' | 'broken' | 'error';
  statusCode: number | null;
  finalUrl: string | null;
  message: string;
}

function classify(status: number): Pick<LinkCheckResult, 'status' | 'message'> {
  if (status >= 200 && status < 400) return { status: 'ok', message: '链接可访问' };
  if (status === 401 || status === 403 || status === 429) return { status: 'warn', message: '对方拒绝自动检查，需人工确认' };
  if (status === 404 || status === 410) return { status: 'broken', message: '链接已失效（404/410）' };
  if (status >= 500) return { status: 'warn', message: '对方服务异常，稍后再试' };
  return { status: 'warn', message: `返回 ${status}，需人工确认` };
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/** Pinned dispatcher: the socket connects to the address we validated, not a fresh DNS answer. */
async function pinnedFetch(url: URL, init: RequestInit, target: ResolvedTarget): Promise<Response> {
  const ip = target.addresses[0]!;
  if (isIP(url.hostname) !== 0) return fetch(url, init);
  try {
    const { Agent, fetch: undiciFetch } = await import('undici');
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) => {
          callback(null, ip.address, ip.family === 6 ? 6 : 4);
        },
      },
    });
    try {
      return await (undiciFetch as unknown as FetchLike)(url, { ...init, dispatcher } as RequestInit);
    } finally {
      await dispatcher.close();
    }
  } catch {
    // Pinning unavailable (bundler/edge runtime): fall back to a normal fetch.
    return fetch(url, init);
  }
}

async function request(url: URL, method: 'HEAD' | 'GET', target?: ResolvedTarget): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init: RequestInit = {
      method, redirect: 'manual', signal: controller.signal,
      headers: { 'user-agent': 'SanjiangLinkCheck/1.0 (+resource directory)', accept: 'text/html,*/*;q=0.5' },
    };
    const response = target ? await pinnedFetch(url, init, target) : await fetch(url, init);
    if (method === 'GET') {
      // We only need the status line: never download an unbounded body.
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) return response;
      await response.body?.cancel().catch(() => undefined);
    }
    return response;
  } finally { clearTimeout(timer); }
}

/** Manual/scheduled link check. Never changes publication state. */
export async function checkResourceLink(rawUrl: string): Promise<LinkCheckResult> {
  try {
    let target = await resolvePublicTarget(rawUrl);
    let url = target.url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await request(url, 'HEAD', target);
      if (response.status === 405 || response.status === 501) response = await request(url, 'GET', target);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) break;
      // Every hop is validated again, and the next request is pinned to the
      // address that was validated for that hop.
      target = await resolvePublicTarget(new URL(location, url).href);
      url = target.url;
      response = undefined;
    }
    if (!response) return { status: 'error', statusCode: null, finalUrl: url.href, message: '重定向次数过多' };
    const verdict = classify(response.status);
    return { status: verdict.status, statusCode: response.status, finalUrl: url.href, message: verdict.message };
  } catch (error) {
    const message = error instanceof Error ? error.message : '检查失败';
    return { status: 'error', statusCode: null, finalUrl: null, message: message.includes('abort') ? '请求超时' : message };
  }
}
