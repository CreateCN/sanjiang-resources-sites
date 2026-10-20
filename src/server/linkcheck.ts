import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^127\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^198\.1[89]\./, /^22[4-9]\./, /^23\d\./, /^24\d\./, /^25[0-5]\./,
];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

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

/** Reject non-http(s), credentialed and private/loopback targets before fetching. */
export async function assertPublicUrl(input: string): Promise<URL> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('链接格式不正确'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只检查 http/https 链接');
  if (url.username || url.password) throw new Error('链接不能包含账号信息');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) throw new Error('不允许检查内网或本机地址');
  const records = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (records.length === 0) throw new Error('域名无法解析');
  if (records.some((record) => isPrivateAddress(record.address))) throw new Error('不允许检查内网或本机地址');
  return url;
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

async function request(url: URL, method: 'HEAD' | 'GET'): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { method, redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'SanjiangLinkCheck/1.0 (+resource directory)' } });
  } finally { clearTimeout(timer); }
}

/** Manual/scheduled link check. Never changes publication state. */
export async function checkResourceLink(rawUrl: string): Promise<LinkCheckResult> {
  try {
    let url = await assertPublicUrl(rawUrl);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await request(url, 'HEAD');
      if (response.status === 405 || response.status === 501) response = await request(url, 'GET');
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) break;
      url = await assertPublicUrl(new URL(location, url).href);
      response = undefined;
    }
    if (!response) return { status: 'error', statusCode: null, finalUrl: url.href, message: '重定向次数过多' };
    const verdict = classify(response.status);
    return { status: verdict.status, statusCode: response.status, finalUrl: response.url || url.href, message: verdict.message };
  } catch (error) {
    const message = error instanceof Error ? error.message : '检查失败';
    return { status: 'error', statusCode: null, finalUrl: null, message: message.includes('abort') ? '请求超时' : message };
  }
}
