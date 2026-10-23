import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from '../lib/private-address.ts';

export { isPrivateAddress };

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);
/** Only web ports are worth checking; anything else widens the probe surface. */
const ALLOWED_PORTS = new Set(['', '80', '443']);
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 32 * 1024;

export interface ResolvedAddress { address: string; family: number }
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
const defaultResolve: HostResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

interface ResolvedTarget { url: URL; addresses: ResolvedAddress[] }

/** 供测试替换解析器；生产固定使用系统解析。 */
export type LinkCheckTransport = (url: URL, init: RequestInit, target: ResolvedTarget) => Promise<Response>;
export interface LinkCheckOptions {
  resolve?: HostResolver;
  transport?: LinkCheckTransport;
  timeoutMs?: number;
}

/**
 * Reject non-http(s), credentialed, non-web-port and private/loopback targets,
 * then return the addresses that were actually validated. The caller pins the
 * connection to one of them, so a second DNS answer cannot redirect the fetch
 * into the internal network (DNS rebinding / TOCTOU).
 */
export async function resolvePublicTarget(input: string, resolve: HostResolver = defaultResolve): Promise<ResolvedTarget> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('链接格式不正确'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只检查 http/https 链接');
  if (url.username || url.password) throw new Error('链接不能包含账号信息');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) throw new Error('不允许检查内网或本机地址');
  // Reject literal private addresses before the port rule so the message stays specific.
  if (isIP(host) !== 0 && isPrivateAddress(host)) throw new Error('不允许检查内网或本机地址');
  if (!ALLOWED_PORTS.has(url.port)) throw new Error('只检查 80/443 端口的链接');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
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

/**
 * 固定连接的 lookup。Node/undici 在 `options.all` 为真时期待地址数组，
 * 只回 `(null, address, family)` 会被判成 `Invalid IP address: undefined`，
 * 连接随即失败——这正是上一版回退到普通 fetch 并重新解析域名的触发条件。
 */
export type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (error: Error | null, address?: string | ResolvedAddress[], family?: number) => void,
) => void;
export function pinnedLookup(pinned: ResolvedAddress): PinnedLookup {
  const family = pinned.family === 6 ? 6 : 4;
  return (_hostname, options, callback) => {
    const wantsAll = typeof options === 'object' && options !== null && 'all' in options && (options as { all?: unknown }).all === true;
    if (wantsAll) callback(null, [{ address: pinned.address, family }]);
    else callback(null, pinned.address, family);
  };
}

/**
 * Pinned dispatcher: the socket connects to the address we validated, not a fresh DNS answer.
 * 这里**不允许**任何形式的回退：依赖加载失败、lookup 异常、连接错误都必须终止本次检查，
 * 否则重新解析域名的普通请求会把 DNS 重绑定重新放回来。
 */
async function pinnedFetch(url: URL, init: RequestInit, target: ResolvedTarget): Promise<Response> {
  const ip = target.addresses[0];
  if (!ip) throw new Error('没有可用的目标地址');
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0) return fetch(url, init);
  const { Agent, fetch: undiciFetch } = await import('undici');
  // undici 的 LookupFunction 类型比 Node 的 dns.lookup 回调更窄，这里按运行时契约转换。
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(ip) as unknown as (hostname: string, options: unknown, callback: (...args: never[]) => void) => void } });
  try {
    return await (undiciFetch as unknown as (input: URL, init: RequestInit) => Promise<Response>)(url, { ...init, dispatcher } as RequestInit);
  } finally {
    await dispatcher.close();
  }
}

async function request(url: URL, method: 'HEAD' | 'GET', target: ResolvedTarget, transport: LinkCheckTransport, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method, redirect: 'manual', signal: controller.signal,
      headers: { 'user-agent': 'SanjiangLinkCheck/1.0 (+resource directory)', accept: 'text/html,*/*;q=0.5' },
    };
    const response = await transport(url, init, target);
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
export async function checkResourceLink(rawUrl: string, options: LinkCheckOptions = {}): Promise<LinkCheckResult> {
  const resolve = options.resolve ?? defaultResolve;
  const transport = options.transport ?? pinnedFetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  try {
    let target = await resolvePublicTarget(rawUrl, resolve);
    let url = target.url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await request(url, 'HEAD', target, transport, timeoutMs);
      if (response.status === 405 || response.status === 501) response = await request(url, 'GET', target, transport, timeoutMs);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) break;
      // Every hop is validated again, and the next request is pinned to the
      // address that was validated for that hop.
      target = await resolvePublicTarget(new URL(location, url).href, resolve);
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
