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

/**
 * Resolve a rate-limit identity for one request.
 *
 * Deployment contract: when TRUST_PROXY is enabled the application is only
 * reachable through our own reverse proxy, and that proxy overwrites
 * `X-Forwarded-For` with the single peer address it observed
 * (`proxy_set_header X-Forwarded-For $remote_addr;`). Anything else - a
 * missing header, a malformed value, or a multi-hop chain - is not usable as an
 * identity: it collapses to a dedicated "unverified" bucket that is protected by
 * a site-wide circuit breaker instead of a tiny per-visitor budget.
 */
export function clientIdentity(request: Request, clientAddress?: string): string {
  const trusted = /^(1|true|on|yes)$/i.test(process.env.TRUST_PROXY ?? '');
  const raw = request.headers.get('x-forwarded-for');
  if (trusted) {
    const parts = (raw ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    if (parts.length === 1 && isIP(parts[0]!) !== 0) return parts[0]!.toLowerCase();
    if (raw === null && clientAddress) return clientAddress;
    return 'unverified-peer';
  }
  // Without TRUST_PROXY we cannot tell a socket peer from a spoofed header:
  // the Node adapter derives clientAddress from XFF when the header exists.
  if (raw !== null) return 'unverified-peer';
  return clientAddress || 'unknown-peer';
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
