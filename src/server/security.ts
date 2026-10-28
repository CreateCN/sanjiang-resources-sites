import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { database, transaction } from './db.ts';
import { SiteConfigError, resolveRequestOrigin } from './deployment-config.ts';

export class HttpError extends Error {
  status: number;
  /** How long the caller should wait before retrying (only meaningful for 429). */
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message); this.name = 'HttpError'; this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
  }
}
export function fail(status: number, message: string, retryAfterMs?: number): never {
  throw new HttpError(status, message, retryAfterMs);
}
export function hashToken(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function randomToken(): string { return randomBytes(32).toString('base64url'); }
export function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 256) fail(400, '密码长度必须为 12–256 个字符');
}
export function hashPassword(password: string): string {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}
const dummyHash = hashPassword(randomToken());
export function verifyPassword(password: string, encoded: string = dummyHash): boolean {
  if (password.length > 256) return false;
  const parts = encoded.split('$');
  const [algorithm, salt = '', digest = ''] = parts;
  if (parts.length !== 3 || algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(digest)) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}

export interface LimitState { allowed: boolean; retryAfterMs: number; remaining: number }
export interface LimitRule { scope: string; identity: string; maximum: number; windowMs: number }

function limitKey(scope: string, identity: string): string { return `${scope}:${hashToken(identity)}`; }

/**
 * Persistent, atomic fixed-window counters.
 *
 * Split into three operations so that callers can decide *what* counts:
 * - checkLimit(): read-only peek, safe before doing expensive work.
 * - consumeLimit(): count one event (a request or a failed attempt).
 * - resetLimit(): clear a counter (for example after a successful login).
 *
 * Never use a forwarded header as an identity unless the deployment explicitly
 * declares a trusted proxy (see clientIdentity below).
 */
export function checkLimit(rule: LimitRule, now = Date.now()): LimitState {
  const key = limitKey(rule.scope, rule.identity);
  const row = database().prepare('SELECT count,reset_at FROM rate_limits WHERE key=?').get(key);
  if (!row || Number(row.reset_at) <= now) return { allowed: true, retryAfterMs: 0, remaining: rule.maximum };
  const used = Number(row.count);
  return {
    allowed: used < rule.maximum,
    retryAfterMs: Math.max(0, Number(row.reset_at) - now),
    remaining: Math.max(0, rule.maximum - used),
  };
}

export function consumeLimit(rule: LimitRule, now = Date.now()): LimitState {
  const key = limitKey(rule.scope, rule.identity);
  return transaction((db) => {
    db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);
    const row = db.prepare('SELECT count,reset_at FROM rate_limits WHERE key=?').get(key);
    if (!row) {
      db.prepare('INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?)').run(key, now + rule.windowMs);
      return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, rule.maximum - 1) };
    }
    const used = Number(row.count) + 1;
    db.prepare('UPDATE rate_limits SET count=? WHERE key=?').run(used, key);
    return {
      allowed: used <= rule.maximum,
      retryAfterMs: Math.max(0, Number(row.reset_at) - now),
      remaining: Math.max(0, rule.maximum - used),
    };
  });
}

export function resetLimit(scope: string, identity: string): void {
  database().prepare('DELETE FROM rate_limits WHERE key=?').run(limitKey(scope, identity));
}

/** Throws 429 with an accurate Retry-After when any rule is already exhausted. */
export function enforceLimits(rules: LimitRule[]): void {
  for (const rule of rules) {
    const state = checkLimit(rule);
    if (!state.allowed) fail(429, '请求过于频繁，请稍后重试', state.retryAfterMs);
  }
}

/** Count-all helper: one call consumes one unit and fails when the budget is gone. */
export function rateLimit(scope: string, identity: string, maximum: number, windowMs: number): void {
  const rule = { scope, identity, maximum, windowMs };
  const state = consumeLimit(rule);
  if (!state.allowed) fail(429, '请求过于频繁，请稍后重试', state.retryAfterMs);
}

/** 结算一组规则的失败额度（登录、TOTP 的"先查不扣、失败才计"路径共用）。 */
export function consumeLimits(rules: LimitRule[]): void {
  for (const rule of rules) consumeLimit(rule);
}

/* ------------------------------------------------------------ client identity */

/** 为什么这条请求无法归属到某个客户端。只用于服务端诊断，不进入任何响应。 */
export type UnverifiedReason =
  | 'proxy-secret-not-configured'
  | 'proxy-secret-mismatch'
  | 'forwarded-missing'
  | 'forwarded-multi-hop'
  | 'forwarded-invalid-value'
  | 'forwarded-header-ignored'
  | 'no-peer-address';

/**
 * 限流身份。**这是两种不同的东西，不能用一个字符串混用**：
 * - `client`：可以归属到某个访客（由通过验证的代理写入的单值地址，或直连时的连接对端）；
 * - `unverified`：无法归属到某个客户端。它只能走站点级预算，
 *   绝不允许落进"每访客"的桶——否则所有无法识别的流量会共享一个小额度，
 *   30 个匿名请求就能把所有人的入口关掉（见 SECURITY-SPEC §2.1、§6.1）。
 */
export type ClientIdentity =
  | { readonly kind: 'client'; readonly address: string }
  | { readonly kind: 'unverified'; readonly reason: UnverifiedReason };

/** 每客户端与站点级的额度定义。站点级在不可信身份下单独承担保护职责。 */
export interface ClientBudget { scope: string; maximum: number; windowMs: number }

const TRUST_PROXY_PATTERN = /^(1|true|on|yes)$/i;
/** 代理必须带上的共享凭据头。名称固定，见 docs/deploy/deploy-docker.md。 */
export const PROXY_SECRET_HEADER = 'x-sanjiang-proxy-secret';
/** 过短的共享凭据等于没有：少于 16 字符按"未配置"处理（fail closed）。 */
export const PROXY_SECRET_MIN_LENGTH = 16;

export function trustProxyEnabled(): boolean {
  return TRUST_PROXY_PATTERN.test(process.env.TRUST_PROXY ?? '');
}

/** 规范化后的代理共享凭据；未配置或过短返回 null（调用方据此 fail closed）。 */
export function proxySecret(): Buffer | null {
  const raw = (process.env.TRUST_PROXY_SECRET ?? '').trim();
  if (raw.length < PROXY_SECRET_MIN_LENGTH) return null;
  return Buffer.from(raw, 'utf8');
}

/** 恒定时间比较；长度不同直接失败（长度本身不是秘密）。 */
export function secretMatches(presented: string | null, expected: Buffer | null): boolean {
  if (!expected) return false;
  if (presented === null) return false;
  const actual = Buffer.from(presented, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

let proxyWarned = false;

/** 仅供测试：清掉"只告警一次"的状态。 */
export function resetTrustedProxyCache(): void {
  proxyWarned = false;
}

function warnOnceOnMisconfiguration(): void {
  if (proxyWarned) return;
  proxyWarned = true;
  if (!trustProxyEnabled()) return;
  if (proxySecret()) return;
  // 不含任何地址、头内容或凭据：部署告警不需要 PII。
  console.warn(
    'TRUST_PROXY 已启用，但 TRUST_PROXY_SECRET 未配置或长度不足 16；'
    + '应用无法验证"这个转发头确实来自我们的代理"，因此所有请求按不可信身份处理（仅站点级限流）。'
    + '请配置共享凭据并让代理写入 X-Sanjiang-Proxy-Secret，或关闭 TRUST_PROXY。',
  );
}

function forwardedParts(request: Request): string[] {
  return (request.headers.get('x-forwarded-for') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

/**
 * 解析一条请求的限流身份。
 *
 * **为什么不用"连接对端 IP 是否在可信网段"来判断代理**：本项目跑在
 * `@astrojs/node` standalone 模式，适配器构造 Request 时把 `X-Forwarded-For`
 * 的第一个值写进 `clientAddress`（node_modules/astro/dist/core/app/node.js），
 * 于是"对端地址"和"客户端自己写的头"是同一个值——用它做信任判断是循环论证：
 * 直连者只要写 `X-Forwarded-For: 10.0.0.1` 就会被当成"来自私网代理"。
 * 因此改用**共享凭据**：只有真正持有 `TRUST_PROXY_SECRET` 的代理才能让应用采信
 * 它写的转发头；拿不到凭据的请求一律 `unverified`（只吃站点级预算）。
 */
export function clientIdentity(request: Request, clientAddress?: string): ClientIdentity {
  warnOnceOnMisconfiguration();
  const forwarded = forwardedParts(request);
  const forwardedHeader = request.headers.get('x-forwarded-for');

  if (trustProxyEnabled()) {
    const expected = proxySecret();
    if (!expected) return { kind: 'unverified', reason: 'proxy-secret-not-configured' };
    if (!secretMatches(request.headers.get(PROXY_SECRET_HEADER), expected)) {
      return { kind: 'unverified', reason: 'proxy-secret-mismatch' };
    }
    if (forwarded.length === 1 && isIP(forwarded[0]!) !== 0) {
      return { kind: 'client', address: forwarded[0]!.toLowerCase() };
    }
    if (forwardedHeader === null || forwardedHeader.trim() === '') return { kind: 'unverified', reason: 'forwarded-missing' };
    if (forwarded.length > 1) return { kind: 'unverified', reason: 'forwarded-multi-hop' };
    return { kind: 'unverified', reason: 'forwarded-invalid-value' };
  }

  // TRUST_PROXY 关闭：转发头是客户端可控数据，绝不参与身份。带头的请求连
  // clientAddress 都不可信（适配器会取头的首值），所以只能按不可信处理。
  if (forwardedHeader !== null) return { kind: 'unverified', reason: 'forwarded-header-ignored' };
  const peer = (clientAddress ?? '').trim();
  if (peer !== '') return { kind: 'client', address: peer.toLowerCase() };
  return { kind: 'unverified', reason: 'no-peer-address' };
}

/** 挑战绑定用的稳定键；不可信身份共用固定值（此时"绑定到客户端"本就无从谈起）。 */
export function clientKey(identity: ClientIdentity): string {
  return identity.kind === 'client' ? identity.address : 'unverified-peer';
}

/**
 * 把"每客户端额度"翻译成实际规则。
 * - 可信身份：自己的客户端桶 + 站点桶（站点桶统计全部流量，才看得出分布式攻击）；
 * - 不可信身份：**只有**站点桶——绝不落进"每访客"的小额度，否则所有无法识别的
 *   流量共享一个预算，30 个匿名请求就能关掉所有人的入口（SJ-02）。
 * 未给出站点预算时（例如 TOTP 的客户端预算），不可信身份不额外计数，
 * 由调用方的账号级预算兜底。
 */
export function clientLimitRules(identity: ClientIdentity, client: ClientBudget, site: ClientBudget | null): LimitRule[] {
  const siteRule: LimitRule[] = site ? [{ scope: site.scope, identity: 'site', maximum: site.maximum, windowMs: site.windowMs }] : [];
  if (identity.kind === 'client') {
    return [{ scope: client.scope, identity: identity.address, maximum: client.maximum, windowMs: client.windowMs }, ...siteRule];
  }
  return siteRule;
}

/** 计数型（请求计数）的客户端预算，一次调用即消费。 */
export function rateLimitClient(identity: ClientIdentity, client: ClientBudget, site: ClientBudget | null): void {
  for (const rule of clientLimitRules(identity, client, site)) {
    rateLimit(rule.scope, rule.identity, rule.maximum, rule.windowMs);
  }
}

export function requireOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  // 期望 origin 只有一个来源：SITE_URL（生产必须配置），开发环境才允许请求回退。
  // 配置异常按 503 处理，不能伪装成来源校验失败去误导部署者。
  let expected: string;
  try {
    expected = resolveRequestOrigin(request);
  } catch (error) {
    if (error instanceof SiteConfigError) fail(503, '站点地址配置异常，请联系维护者');
    throw error;
  }
  if (!origin || origin !== expected) fail(403, '请求来源验证失败，请从本站页面提交');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') fail(403, '禁止跨站提交');
}

export function audit(actor: string, action: string, target: string): void {
  database().prepare('INSERT INTO audit (actor,action,target,created_at) VALUES (?,?,?,?)').run(actor, action, target, new Date().toISOString());
}
