import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * 私网/保留网段的判定必须基于地址字节，而不是字符串正则：
 * URL 解析器会把 http://[::ffff:127.0.0.1]/ 规范化成 [::ffff:7f00:1]，
 * 只在点分形式里匹配 IPv4 会把实际指向回环的地址放行。
 */
const BLOCKED_V4_RANGES: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);
/** Only web ports are worth checking; anything else widens the probe surface. */
const ALLOWED_PORTS = new Set(['', '80', '443']);
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 32 * 1024;

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}
function blockedV4(value: number): boolean {
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const text = ipv4ToInt(base);
    if (text === null) return false;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (text & mask);
  });
}
/** 解析 IPv6（含 :: 压缩、IPv4 尾巴与 zone id）；无法解析返回 null。 */
function ipv6Bytes(input: string): Uint8Array | null {
  let value = input.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value.includes('.')) {
    const cut = value.lastIndexOf(':');
    const embedded = ipv4ToInt(value.slice(cut + 1));
    if (embedded === null) return null;
    value = `${value.slice(0, cut + 1)}${((embedded >>> 16) & 0xffff).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(value)) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 ? groups < 1 : head.length !== 8) return null;
  const filled = [...head, ...Array<string>(groups).fill('0'), ...tail];
  if (filled.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (const [index, group] of filled.entries()) {
    if (group.length === 0 || group.length > 4 || !/^[0-9a-f]+$/.test(group)) return null;
    const number = Number.parseInt(group, 16);
    bytes[index * 2] = (number >> 8) & 0xff;
    bytes[index * 2 + 1] = number & 0xff;
  }
  return bytes;
}
function v4At(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}
function blockedV6(bytes: Uint8Array): boolean {
  // IPv4-mapped（::ffff:a.b.c.d 与 ::ffff:7f00:1）与 NAT64（64:ff9b::/96）：低 32 位就是 IPv4。
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return blockedV4(v4At(bytes, 12));
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return blockedV4(v4At(bytes, 12));
  // ::/96 里的其余兼容地址（含 ::、::1）在公网没有正当用途，直接拒绝。
  if (bytes.slice(0, 10).every((byte) => byte === 0)) return true;
  // 6to4 2002::/16 内嵌 IPv4；6bone 2001::/32 与文档前缀 2001:db8::/32 一律拒绝。
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return blockedV4(v4At(bytes, 2));
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0xff) return true; // 组播
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // 唯一本地 fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // 链路本地 fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true; // 站点本地（已废弃但仍可能配置）
  return false;
}

/** 无法解析的地址按危险处理（fail closed）：宁可拒绝检查，也不放行未识别的写法。 */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().replace(/^\[|\]$/g, '');
  const v6 = ipv6Bytes(value);
  if (v6) return blockedV6(v6);
  const v4 = ipv4ToInt(value);
  if (v4 !== null) return blockedV4(v4);
  return true;
}

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
