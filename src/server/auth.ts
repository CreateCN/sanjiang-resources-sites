import { timingSafeEqual } from 'node:crypto';
import { database, transaction } from './db.ts';
import type { User } from './store.ts';
import { fail, hashToken, randomToken, rateLimit, requireOrigin, verifyPassword } from './security.ts';

export const SESSION_COOKIE = 'sanjiang_session';
export const SESSION_SECONDS = 8 * 60 * 60;
export interface Session { user: User; csrfToken: string }
function tokenFrom(request: Request): string | undefined {
  const cookies = (request.headers.get('cookie') || '').split(';').map((value) => value.trim());
  const values = cookies.filter((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const token = values[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
function csrfFor(token: string): string { return hashToken(`csrf:${token}`); }
export function getSession(request: Request): Session | undefined {
  const token = tokenFrom(request);
  if (!token) return undefined;
  const row = database().prepare(`SELECT u.id,u.username,u.role,u.active FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(hashToken(token), Date.now());
  if (!row) return undefined;
  return { user: { id: Number(row.id), username: String(row.username), role: row.role as User['role'], active: true }, csrfToken: csrfFor(token) };
}
export function requireSession(request: Request): Session {
  return getSession(request) || fail(401, '请先登录后台');
}
export function requireCsrf(request: Request, csrf: string): Session {
  requireOrigin(request);
  const session = requireSession(request);
  const expected = Buffer.from(session.csrfToken);
  const actual = Buffer.from(csrf);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(403, '安全令牌无效，请重新打开后台页面');
  return session;
}
export function login(username: string, password: string, address: string): string {
  const name = username.trim().toLowerCase();
  rateLimit('login-ip', address, 30, 15 * 60 * 1000);
  rateLimit('login-user', name, 10, 15 * 60 * 1000);
  const row = database().prepare('SELECT id,password_hash,active FROM users WHERE username=?').get(name);
  const valid = verifyPassword(password, row ? String(row.password_hash) : undefined);
  if (!valid || !row || !row.active) fail(401, '用户名或密码错误，或账户已停用');
  const token = randomToken();
  transaction((db) => {
    // Another worker may have reset/disabled this account during scrypt work.
    const latest = db.prepare('SELECT password_hash,active FROM users WHERE id=?').get(Number(row.id));
    if (!latest?.active || latest.password_hash !== row.password_hash) fail(401, '用户名或密码错误，或账户已停用');
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    // Bound outstanding sessions without storing any plaintext credential.
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 9)').run(Number(row.id), Number(row.id));
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(hashToken(token), Number(row.id), now + SESSION_SECONDS * 1000, now);
  });
  return token;
}
export function logout(request: Request): void {
  const token = tokenFrom(request);
  if (token) database().prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
}
export function sessionCookie(token: string, clear = false, secure = false): string {
  return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}
