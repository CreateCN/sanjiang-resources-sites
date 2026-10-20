import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { database, transaction } from './db.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = 'HttpError'; this.status = status; }
}
export function fail(status: number, message: string): never { throw new HttpError(status, message); }
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

/** Persistent, atomic fixed-window limits. Never use forwarded headers as an address. */
export function rateLimit(scope: string, identity: string, maximum: number, windowMs: number): void {
  const now = Date.now();
  const key = `${scope}:${hashToken(identity)}`;
  const allowed = transaction((db) => {
    db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').run(now);
    const row = db.prepare('SELECT count,reset_at FROM rate_limits WHERE key=?').get(key);
    if (row && Number(row.count) >= maximum) return false;
    if (row) db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);
    else db.prepare('INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?)').run(key, now + windowMs);
    return true;
  });
  if (!allowed) fail(429, '请求过于频繁，请稍后重试');
}

export function requireOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const host = request.headers.get('host');
  let expected: string;
  if (process.env.SITE_URL) {
    expected = new URL(process.env.SITE_URL).origin;
  } else if (host && url.hostname === 'localhost' && !url.port) {
    // The Node adapter rebuilds the URL as bare `localhost` when host validation
    // is not configured; the browser-set Host header is the reliable origin here.
    // X-Forwarded-Proto is only honoured for the scheme: it cannot widen the host.
    const protocol = request.headers.get('x-forwarded-proto') === 'https' ? 'https' : url.protocol.replace(':', '');
    expected = `${protocol}://${host}`;
  } else {
    expected = url.origin;
  }
  if (!origin || origin !== expected) fail(403, '请求来源验证失败，请从本站页面提交');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') fail(403, '禁止跨站提交');
}

export function audit(actor: string, action: string, target: string): void {
  database().prepare('INSERT INTO audit (actor,action,target,created_at) VALUES (?,?,?,?)').run(actor, action, target, new Date().toISOString());
}
