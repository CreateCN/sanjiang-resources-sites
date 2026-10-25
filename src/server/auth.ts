import { timingSafeEqual } from 'node:crypto';
import { database, transaction } from './db.ts';
import type { User, Role } from './store.ts';
import { isSecureSite } from './deployment-config.ts';
import { getFrozenAuthIssuer } from './site-config.ts';
import { audit, clientKey, clientLimitRules, consumeLimit, consumeLimits, enforceLimits, fail, hashToken, randomToken, rateLimit, rateLimitClient, requireOrigin, resetLimit, verifyPassword, type ClientBudget, type ClientIdentity, type LimitRule } from './security.ts';
import {
  base32Decode, buildOtpauthUri, classifyOtpInput, createRecoveryCodes, currentStep, encryptionKey,
  generateSecret, hashRecoveryCode, isFreshStep, openSecret, renderOtpauthSvg, requireEncryptionKey,
  sealSecret, secretAad, verifyTotp, TotpKeyError,
} from './totp.ts';

export const SESSION_COOKIE = 'sanjiang_session';
export const SESSION_SECONDS = 8 * 60 * 60;
/** 挑战 Cookie 与有效期；Path=/ 同时覆盖 /admin/login/* 与 /api/login/*。 */
export const CHALLENGE_COOKIE = 'sanjiang_mfa';
export const CHALLENGE_SECONDS = 5 * 60;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const MAX_ACTIVE_CHALLENGES = 3;

export interface Session { user: User; csrfToken: string }

export const INVALID_CREDENTIALS = '用户名或密码错误，或账户已停用';
/** 第二步与注册确认的失败文案：不区分挑战、验证码与恢复码。 */
export const INVALID_CHALLENGE = '验证码不正确或登录请求已失效';

function tokenFrom(request: Request): string | undefined {
  const cookies = (request.headers.get('cookie') || '').split(';').map((value) => value.trim());
  const values = cookies.filter((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const token = values[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

/** 只读取挑战凭据；是否有效由 challengeRow()/最终事务判定。 */
export function challengeTokenFrom(request: Request): string | undefined {
  const cookies = (request.headers.get('cookie') || '').split(';').map((value) => value.trim());
  const values = cookies.filter((value) => value.startsWith(`${CHALLENGE_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const token = values[0]!.slice(CHALLENGE_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

function csrfFor(token: string): string { return hashToken(`csrf:${token}`); }

export function getSession(request: Request): Session | undefined {
  const token = tokenFrom(request);
  if (!token) return undefined;
  const row = database().prepare(`SELECT u.id,u.username,u.role,u.active,u.version FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(hashToken(token), Date.now());
  if (!row) return undefined;
  return { user: { id: Number(row.id), username: String(row.username), role: row.role as User['role'], active: true, version: Number(row.version ?? 1) }, csrfToken: csrfFor(token) };
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

/** Login throttling: successful logins never consume budget, failures do. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_USER_MAX_FAILURES = 10;
export const LOGIN_CLIENT_MAX_FAILURES = 30;
/** 站点级熔断：只统计全站失败次数，用于身份不可信或分布式攻击时压制（规范 §4.2）。 */
export const LOGIN_SITE_MAX_FAILURES = 500;
export const LOGIN_SITE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_CLIENT_BUDGET: ClientBudget = { scope: 'login-client', maximum: LOGIN_CLIENT_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS };
const LOGIN_SITE_BUDGET: ClientBudget = { scope: 'login-site', maximum: LOGIN_SITE_MAX_FAILURES, windowMs: LOGIN_SITE_WINDOW_MS };

/** Second-factor budgets (SECURITY-SPEC §4.2). */
export const TOTP_WINDOW_MS = 15 * 60 * 1000;
export const TOTP_USER_MAX_FAILURES = 10;
export const TOTP_CLIENT_MAX_FAILURES = 30;
export const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
export const RECOVERY_USER_MAX_FAILURES = 3;
export const ENROLL_WINDOW_MS = 60 * 60 * 1000;
export const ENROLL_CLIENT_MAX = 5;
export const CHALLENGE_WINDOW_MS = 15 * 60 * 1000;
export const CHALLENGE_USER_MAX = 10;
export const CHALLENGE_CLIENT_MAX = 30;
const TOTP_CLIENT_BUDGET: ClientBudget = { scope: 'totp-client', maximum: TOTP_CLIENT_MAX_FAILURES, windowMs: TOTP_WINDOW_MS };
const ENROLL_CLIENT_BUDGET: ClientBudget = { scope: 'enroll-client', maximum: ENROLL_CLIENT_MAX, windowMs: ENROLL_WINDOW_MS };
const CHALLENGE_CLIENT_BUDGET: ClientBudget = { scope: 'challenge-client', maximum: CHALLENGE_CLIENT_MAX, windowMs: CHALLENGE_WINDOW_MS };

/* ------------------------------------------------------------------ policy */

const POLICY_VALUES = new Map<string, Role[]>([
  ['off', []],
  ['admin', ['admin']],
  ['admin,editor', ['admin', 'editor']],
]);

export interface TotpPolicy { raw: string; valid: boolean; requiredFor(role: Role): boolean }

/** 未知值不是 off：策略非法时所有认证相关操作 fail-closed。 */
export function totpPolicy(raw: string = process.env.TOTP_REQUIRED_FOR ?? 'off'): TotpPolicy {
  const normalized = raw.trim().toLowerCase();
  const roles = POLICY_VALUES.get(normalized);
  return {
    raw: normalized,
    valid: roles !== undefined,
    requiredFor: (role: Role) => (roles ?? []).includes(role),
  };
}

function requireValidPolicy(): TotpPolicy {
  const policy = totpPolicy();
  if (!policy.valid) fail(503, '认证策略配置错误（TOTP_REQUIRED_FOR），请联系管理员');
  return policy;
}

/* ------------------------------------------------------- account TOTP state */

export type TotpAccountState = 'disabled' | 'enabled' | 'invalid';

export interface AccountAuthRow {
  id: number; username: string; role: Role; active: boolean;
  auth_version: number; totp_secret: string | null; totp_confirmed_at: string | null; totp_last_step: number | null;
}

export function totpAccountState(row: { totp_secret: string | null; totp_confirmed_at: string | null }): TotpAccountState {
  const hasSecret = Boolean(row.totp_secret);
  const hasConfirmed = Boolean(row.totp_confirmed_at);
  if (!hasSecret && !hasConfirmed) return 'disabled';
  if (hasSecret && hasConfirmed) return 'enabled';
  return 'invalid';
}

function readAccount(id: number): AccountAuthRow | undefined {
  const row = database().prepare('SELECT id,username,role,active,auth_version,totp_secret,totp_confirmed_at,totp_last_step FROM users WHERE id=?').get(id);
  return row ? (row as unknown as AccountAuthRow) : undefined;
}

export function accountAuthState(userId: number): TotpAccountState | undefined {
  const row = readAccount(userId);
  return row ? totpAccountState(row) : undefined;
}

/* ------------------------------------------------------------- challenge I/O */

interface ChallengeRow {
  token_hash: string; user_id: number; auth_version: number; purpose: 'login' | 'enroll';
  client_hash: string; attempts: number; pending_secret: string | null;
  created_at: number; expires_at: number; consumed_at: number | null;
}

function challengeRow(token: string): ChallengeRow | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const row = database().prepare('SELECT * FROM login_challenges WHERE token_hash=?').get(hashToken(token));
  return row ? (row as unknown as ChallengeRow) : undefined;
}

function clientHashFor(identity: ClientIdentity): string { return hashToken(`client:${clientKey(identity)}`); }

function secureCookies(): boolean {
  // 与 canonical、Origin 校验共用同一个 SITE_URL 解析；配置非法时按不安全处理。
  return isSecureSite();
}

/** 挑战 Cookie。清除时除 Max-Age 外的属性与下发完全一致，避免留下同名的第二份 Cookie。 */
export function challengeCookie(token?: string): string {
  const secure = secureCookies() ? '; Secure' : '';
  if (!token) return `${CHALLENGE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  return `${CHALLENGE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${CHALLENGE_SECONDS}${secure}`;
}

export function logout(request: Request): void {
  const token = tokenFrom(request);
  if (token) database().prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
}

export function sessionCookie(token: string, clear = false, secure = false): string {
  return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

/* ------------------------------------------------------------- login outcome */

export type LoginOutcome =
  | { kind: 'session'; token: string }
  | { kind: 'challenge'; token: string; purpose: 'login' | 'enroll' };

/** 会话签发的唯一实现（含上限修剪）；认证状态变更模块复用它，不另写 INSERT。 */
export function createSession(db: ReturnType<typeof database>, userId: number, now = Date.now()): string {
  const token = randomToken();
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(hashToken(token), userId, now + SESSION_SECONDS * 1000, now);
  db.prepare(`DELETE FROM sessions WHERE user_id=? AND rowid NOT IN
    (SELECT rowid FROM sessions WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 10)`).run(userId, userId);
  return token;
}

/**
 * 单因子登录：仅当账户未启用因子且策略不要求时。事务内复查密码证明与状态，
 * 防止并发的改密/停用被绕过。
 */
function commitDirectLogin(userId: number, expectedPasswordHash: string): string {
  return transaction((db) => {
    const row = db.prepare('SELECT id,username,active,password_hash FROM users WHERE id=?').get(userId);
    if (!row || !row.active || String(row.password_hash) !== expectedPasswordHash) fail(401, INVALID_CREDENTIALS);
    const token = createSession(db, Number(row.id), Date.now());
    audit(String(row.username), 'login', `user:${row.id}`);
    return token;
  });
}

function issueChallenge(input: {
  userId: number; authVersion: number; purpose: 'login' | 'enroll';
  client: ClientIdentity; pendingSecret?: string | null; now?: number;
}): string {
  const now = input.now ?? Date.now();
  const token = randomToken();
  transaction((db) => {
    const row = db.prepare('SELECT id,username,role,active,auth_version,totp_secret,totp_confirmed_at FROM users WHERE id=?').get(input.userId);
    if (!row || !row.active) fail(401, INVALID_CREDENTIALS);
    if (Number(row.auth_version) !== input.authVersion) fail(401, INVALID_CREDENTIALS);
    const state = totpAccountState({ totp_secret: row.totp_secret as string | null, totp_confirmed_at: row.totp_confirmed_at as string | null });
    if (state === 'invalid') fail(503, '账户认证状态异常，请联系运维重置双因素');
    if (input.purpose === 'login' && state !== 'enabled') fail(409, '该账户未启用双因素，请重新登录');
    if (input.purpose === 'enroll' && state !== 'disabled') fail(409, '该账户已启用双因素，不能重复注册');
    db.prepare('DELETE FROM login_challenges WHERE user_id=? AND (expires_at<=? OR consumed_at IS NOT NULL)').run(input.userId, now);
    const active = Number(db.prepare('SELECT COUNT(*) AS total FROM login_challenges WHERE user_id=? AND consumed_at IS NULL AND expires_at>?').get(input.userId, now)?.total ?? 0);
    // 容量上限而不是自动作废别人的挑战：另一个浏览器可能正在输码。
    if (active >= MAX_ACTIVE_CHALLENGES) fail(429, '登录请求过多，请先完成或等待现有请求过期', CHALLENGE_SECONDS * 1000);
    db.prepare(`INSERT INTO login_challenges
      (token_hash,user_id,auth_version,purpose,client_hash,attempts,pending_secret,created_at,expires_at)
      VALUES (?,?,?,?,?,0,?,?,?)`)
      .run(hashToken(token), input.userId, input.authVersion, input.purpose, clientHashFor(input.client), input.pendingSecret ?? null, now, now + CHALLENGE_SECONDS * 1000);
    audit(String(row.username), 'issue-challenge', `user:${row.id} ${input.purpose}`);
  });
  return token;
}

function requireEncryptionKeyOrFail(): Buffer {
  try {
    return requireEncryptionKey();
  } catch (error) {
    if (error instanceof TotpKeyError) fail(503, '双因素加密密钥未配置或格式不正确');
    throw error;
  }
}

/**
 * 第一步：口令 → 直接会话（未启用且策略不要求）或挑战。
 * 口令通过但还需第二步时不清 `login-user` 失败计数：知道口令的人不该能刷掉失败预算。
 */
export function login(username: string, password: string, client: ClientIdentity): LoginOutcome {
  const policy = requireValidPolicy();
  const name = username.trim().toLowerCase();
  // 失败预算分三层：客户端（可信身份）或站点（不可信身份）、账号，以及站点熔断。
  const userRule = { scope: 'login-user', identity: name, maximum: LOGIN_USER_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS };
  const rules = [...clientLimitRules(client, LOGIN_CLIENT_BUDGET, LOGIN_SITE_BUDGET), userRule];
  enforceLimits(rules);

  const row = database().prepare('SELECT id,username,role,active,auth_version,password_hash,totp_secret,totp_confirmed_at FROM users WHERE username=?').get(name);
  const valid = verifyPassword(password, row ? String(row.password_hash) : undefined);
  if (!valid || !row || !row.active) {
    consumeLimits(rules);
    fail(401, INVALID_CREDENTIALS);
  }

  const userId = Number(row.id);
  const authVersion = Number(row.auth_version ?? 1);
  const role = row.role as Role;
  const state = totpAccountState({ totp_secret: row.totp_secret as string | null, totp_confirmed_at: row.totp_confirmed_at as string | null });
  if (state === 'invalid') fail(503, '账户认证状态异常，请联系运维重置双因素');

  if (state === 'enabled') {
    if (!encryptionKey()) fail(503, '双因素加密密钥未配置，暂时无法完成登录，请联系管理员');
    rateLimit('challenge-user', name, CHALLENGE_USER_MAX, CHALLENGE_WINDOW_MS);
    rateLimitClient(client, CHALLENGE_CLIENT_BUDGET, null);
    const token = issueChallenge({ userId, authVersion, purpose: 'login', client });
    return { kind: 'challenge', token, purpose: 'login' };
  }

  if (policy.requiredFor(role)) {
    const key = requireEncryptionKeyOrFail();
    rateLimitClient(client, ENROLL_CLIENT_BUDGET, null);
    rateLimit('challenge-user', name, CHALLENGE_USER_MAX, CHALLENGE_WINDOW_MS);
    rateLimitClient(client, CHALLENGE_CLIENT_BUDGET, null);
    const pendingSecret = sealSecret(generateSecret(), key, secretAad(userId));
    const token = issueChallenge({ userId, authVersion, purpose: 'enroll', client, pendingSecret });
    return { kind: 'challenge', token, purpose: 'enroll' };
  }

  const token = commitDirectLogin(userId, String(row.password_hash));
  resetLimit('login-user', name);
  return { kind: 'session', token };
}

/** 已登录用户主动开始注册（/admin/security/）。只对未启用账户发行 enroll 挑战。 */
export function issueEnrollChallenge(userId: number, client: ClientIdentity): string {
  requireValidPolicy();
  const row = readAccount(userId);
  if (!row || !row.active) fail(401, INVALID_CREDENTIALS);
  if (totpAccountState(row) !== 'disabled') fail(409, '该账户已启用双因素；请使用停用流程后再重新绑定');
  const key = requireEncryptionKeyOrFail();
  rateLimitClient(client, ENROLL_CLIENT_BUDGET, null);
  rateLimit('challenge-user', row.username, CHALLENGE_USER_MAX, CHALLENGE_WINDOW_MS);
  rateLimitClient(client, CHALLENGE_CLIENT_BUDGET, null);
  const pendingSecret = sealSecret(generateSecret(), key, secretAad(userId));
  return issueChallenge({ userId, authVersion: row.auth_version, purpose: 'enroll', client, pendingSecret });
}

/** 失败结算：预算与尝试次数各走独立短事务，绝不随后续业务事务回滚。 */
function settleChallengeFailure(tokenHash: string | null, client: ClientIdentity, account: LimitRule): never {
  // 不可信身份没有"每客户端"桶：此时只结算账号预算，不给攻击者一个可共享的小额度。
  let clientRetryAfter = 0;
  for (const rule of clientLimitRules(client, TOTP_CLIENT_BUDGET, null)) {
    const state = consumeLimit(rule);
    if (!state.allowed) clientRetryAfter = Math.max(clientRetryAfter, state.retryAfterMs);
  }
  const accountState = consumeLimit(account);
  if (tokenHash) {
    transaction((db) => {
      const row = db.prepare('SELECT attempts FROM login_challenges WHERE token_hash=?').get(tokenHash);
      if (!row) return;
      const attempts = Number(row.attempts) + 1;
      if (attempts >= CHALLENGE_MAX_ATTEMPTS) {
        db.prepare('UPDATE login_challenges SET attempts=?, consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(attempts, Date.now(), tokenHash);
      } else {
        db.prepare('UPDATE login_challenges SET attempts=? WHERE token_hash=?').run(attempts, tokenHash);
      }
    });
  }
  if (clientRetryAfter > 0 || !accountState.allowed) {
    fail(429, '尝试次数过多，请稍后重试', Math.max(clientRetryAfter, accountState.retryAfterMs));
  }
  fail(401, INVALID_CHALLENGE);
}

function assertChallengeUsable(challenge: ChallengeRow, client: ClientIdentity, purpose: 'login' | 'enroll', now: number): void {
  if (challenge.consumed_at !== null) fail(401, INVALID_CHALLENGE);
  if (challenge.expires_at <= now) fail(401, INVALID_CHALLENGE);
  if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) fail(401, INVALID_CHALLENGE);
  if (challenge.purpose !== purpose) fail(401, INVALID_CHALLENGE);
  if (challenge.client_hash !== clientHashFor(client)) fail(401, INVALID_CHALLENGE);
}

export interface VerifiedLogin { token: string; usedRecovery: boolean }

/**
 * 最终兑换事务：重读挑战与用户 → 全部状态再校验 → 条件更新 last_step / 恢复码 →
 * 条件消费挑战 → 签发会话 → 审计。任何一步失败（含审计）整体回滚。
 */
function commitVerifiedChallenge(input: {
  challenge: ChallengeRow; account: AccountAuthRow; sealed: string; client: ClientIdentity;
  kind: 'totp' | 'recovery'; step?: number; recoveryHash?: string;
}): string {
  return transaction((db) => {
    const now = Date.now();
    const fresh = db.prepare('SELECT * FROM login_challenges WHERE token_hash=?').get(input.challenge.token_hash) as unknown as ChallengeRow | undefined;
    if (!fresh) fail(401, INVALID_CHALLENGE);
    assertChallengeUsable(fresh!, input.client, 'login', now);
    const user = db.prepare('SELECT id,username,role,active,auth_version,totp_secret,totp_confirmed_at,totp_last_step FROM users WHERE id=?').get(input.account.id) as unknown as AccountAuthRow | undefined;
    if (!user || !user.active) fail(401, INVALID_CHALLENGE);
    if (user.auth_version !== input.challenge.auth_version) fail(401, INVALID_CHALLENGE);
    if (totpAccountState(user) !== 'enabled' || String(user.totp_secret) !== input.sealed) fail(409, INVALID_CHALLENGE);

    if (input.kind === 'totp') {
      const step = Number(input.step);
      const updated = db.prepare(`UPDATE users SET totp_last_step=?
        WHERE id=? AND auth_version=? AND (totp_last_step IS NULL OR totp_last_step < ?)`)
        .run(step, user.id, user.auth_version, step).changes;
      if (updated !== 1) fail(409, INVALID_CHALLENGE);
    } else {
      const consumedCode = db.prepare('UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL')
        .run(new Date(now).toISOString(), user.id, input.recoveryHash ?? '').changes;
      if (consumedCode !== 1) fail(409, INVALID_CHALLENGE);
    }

    const consumed = db.prepare('UPDATE login_challenges SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND attempts < ?')
      .run(now, input.challenge.token_hash, CHALLENGE_MAX_ATTEMPTS).changes;
    if (consumed !== 1) fail(409, INVALID_CHALLENGE);

    const sessionToken = createSession(db, user.id, now);
    audit(user.username, 'login-totp', `user:${user.id}${input.kind === 'recovery' ? ' recovery' : ''}`);
    return sessionToken;
  });
}

/* --------------------------------------------------------------- login step */

export function verifyLoginChallenge(challengeToken: string, rawCode: string, client: ClientIdentity): VerifiedLogin {
  requireValidPolicy();
  const now = Date.now();
  const challenge = challengeRow(challengeToken);
  const unknownAccount = { scope: 'totp-user', identity: 'unknown', maximum: TOTP_USER_MAX_FAILURES, windowMs: TOTP_WINDOW_MS };
  if (!challenge) settleChallengeFailure(null, client, unknownAccount);
  assertChallengeUsable(challenge!, client, 'login', now);

  const account = readAccount(challenge!.user_id);
  if (!account || !account.active || account.auth_version !== challenge!.auth_version || totpAccountState(account) !== 'enabled') {
    settleChallengeFailure(challenge!.token_hash, client, unknownAccount);
  }

  const input = classifyOtpInput(rawCode);
  if (!input) settleChallengeFailure(challenge!.token_hash, client, unknownAccount);

  // 账号失败预算按输入形状分桶：恢复码失败不得消耗 TOTP 的账号预算，反之亦然。
  // 规则必须是具名常量，**不能**用 clientLimitRules() 返回数组的下标来取：
  // 不可信身份不会生成客户端规则，数组长度会变，按下标取会拿到 undefined
  // （2026-10-25 终审 P1：错误恢复码因此抛 TypeError、HTTP 500、预算与尝试次数都不增加）。
  const totpAccountRule: LimitRule = { scope: 'totp-user', identity: account!.username, maximum: TOTP_USER_MAX_FAILURES, windowMs: TOTP_WINDOW_MS };
  const recoveryAccountRule: LimitRule = { scope: 'totp-recovery-user', identity: account!.username, maximum: RECOVERY_USER_MAX_FAILURES, windowMs: RECOVERY_WINDOW_MS };
  const rules: LimitRule[] = [totpAccountRule, ...clientLimitRules(client, TOTP_CLIENT_BUDGET, null)];
  if (input!.kind === 'recovery') rules.push(recoveryAccountRule);
  enforceLimits(rules);
  const accountRule = input!.kind === 'recovery' ? recoveryAccountRule : totpAccountRule;

  const key = requireEncryptionKeyOrFail();
  const sealed = String(account!.totp_secret ?? '');
  let secret: Buffer;
  try {
    secret = base32Decode(openSecret(sealed, key, secretAad(account!.id)));
  } catch {
    fail(503, '双因素密钥无法解密，请联系管理员重置双因素');
  }

  if (input!.kind === 'totp') {
    const matched = verifyTotp(secret!, input!.code, currentStep(now));
    if (matched === null || !isFreshStep(account!.totp_last_step, matched)) settleChallengeFailure(challenge!.token_hash, client, accountRule);
    const token = commitVerifiedChallenge({ challenge: challenge!, account: account!, sealed, kind: 'totp', step: matched!, client });
    resetLimit('login-user', account!.username);
    resetLimit('totp-user', account!.username);
    return { token, usedRecovery: false };
  }

  const codeHash = hashRecoveryCode(account!.id, input!.normalized);
  const usable = database().prepare('SELECT 1 FROM recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL').get(account!.id, codeHash);
  if (!usable) settleChallengeFailure(challenge!.token_hash, client, accountRule);
  const token = commitVerifiedChallenge({ challenge: challenge!, account: account!, sealed, kind: 'recovery', recoveryHash: codeHash, client });
  resetLimit('login-user', account!.username);
  resetLimit('totp-user', account!.username);
  resetLimit('totp-recovery-user', account!.username);
  return { token, usedRecovery: true };
}

/* ------------------------------------------------------------ enrollment flow */

export interface EnrollView {
  username: string;
  /** 实例冻结的 issuer；页面文案与二维码必须显示同一个值。 */
  issuer: string;
  secret: string;
  uri: string;
  /** 二维码 SVG；生成失败时为空字符串，页面退回手输密钥。 */
  svg: string;
  qrError: string | null;
  expiresAt: number;
}

/**
 * 注册页视图：解密**该挑战**的 pending_secret 并生成二维码。
 * 刷新页面复用同一 secret；不接受任何客户端传入的 secret/账号/issuer。
 */
export async function enrollChallengeView(
  challengeToken: string,
  client: ClientIdentity,
  options: { renderSvg?: (uri: string) => Promise<string> } = {},
): Promise<EnrollView | undefined> {
  const now = Date.now();
  const challenge = challengeRow(challengeToken);
  if (!challenge) return undefined;
  try {
    assertChallengeUsable(challenge, client, 'enroll', now);
  } catch { return undefined; }
  const account = readAccount(challenge.user_id);
  if (!account || !account.active || account.auth_version !== challenge.auth_version) return undefined;
  if (totpAccountState(account) !== 'disabled') return undefined;
  const key = encryptionKey();
  if (!key || !challenge.pending_secret) return undefined;
  let secret: string;
  try {
    secret = openSecret(challenge.pending_secret, key, secretAad(account.id));
  } catch { return undefined; }
  const issuer = getFrozenAuthIssuer();
  const uri = buildOtpauthUri(account.username, secret, issuer);
  // 二维码只是配置入口：生成失败不能让整页 500，也不能因此跳过验证码确认。
  let svg = '';
  let qrError: string | null = null;
  try {
    svg = await (options.renderSvg ?? renderOtpauthSvg)(uri);
  } catch {
    qrError = '二维码暂时无法生成，请使用下方的手动密钥';
  }
  return { username: account.username, issuer, secret, uri, svg, qrError, expiresAt: challenge.expires_at };
}

export interface EnrollResult { token: string; recoveryCodes: string[] }

/**
 * 注册确认：只接受 6 位验证码；secret 来自挑战记录。
 * 同一事务安装因子、消费挑战、撤销旧证明、生成恢复码并签发会话。
 */
export function confirmEnrollment(challengeToken: string, rawCode: string, client: ClientIdentity): EnrollResult {
  requireValidPolicy();
  const now = Date.now();
  const challenge = challengeRow(challengeToken);
  const unknownAccount = { scope: 'totp-user', identity: 'unknown', maximum: TOTP_USER_MAX_FAILURES, windowMs: TOTP_WINDOW_MS };
  if (!challenge) settleChallengeFailure(null, client, unknownAccount);
  assertChallengeUsable(challenge!, client, 'enroll', now);

  const account = readAccount(challenge!.user_id);
  if (!account || !account.active || account.auth_version !== challenge!.auth_version || totpAccountState(account) !== 'disabled') {
    settleChallengeFailure(challenge!.token_hash, client, unknownAccount);
  }

  const input = classifyOtpInput(rawCode);
  // 注册确认不接受恢复码：本次绑定尚未生成恢复码。
  if (!input || input.kind !== 'totp') settleChallengeFailure(challenge!.token_hash, client, unknownAccount);

  enforceLimits([
    { scope: 'totp-user', identity: account!.username, maximum: TOTP_USER_MAX_FAILURES, windowMs: TOTP_WINDOW_MS },
    ...clientLimitRules(client, TOTP_CLIENT_BUDGET, null),
  ]);

  const key = requireEncryptionKeyOrFail();
  const pendingSealed = String(challenge!.pending_secret ?? '');
  let secret: Buffer;
  try {
    secret = base32Decode(openSecret(pendingSealed, key, secretAad(account!.id)));
  } catch {
    fail(503, '注册密钥无法解密，请重新开始绑定');
  }
  const matched = verifyTotp(secret!, input!.code, currentStep(now));
  if (matched === null || !isFreshStep(account!.totp_last_step, matched)) {
    settleChallengeFailure(challenge!.token_hash, client, { scope: 'totp-user', identity: account!.username, maximum: TOTP_USER_MAX_FAILURES, windowMs: TOTP_WINDOW_MS });
  }

  const codes = createRecoveryCodes();
  const sessionToken = transaction((db) => {
    const fresh = db.prepare('SELECT * FROM login_challenges WHERE token_hash=?').get(challenge!.token_hash) as unknown as ChallengeRow | undefined;
    if (!fresh) fail(401, INVALID_CHALLENGE);
    assertChallengeUsable(fresh!, client, 'enroll', now);
    if (String(fresh!.pending_secret) !== pendingSealed) fail(409, INVALID_CHALLENGE);
    const user = db.prepare('SELECT id,username,active,auth_version,totp_secret,totp_confirmed_at FROM users WHERE id=?').get(account!.id) as unknown as AccountAuthRow | undefined;
    if (!user || !user.active || user.auth_version !== fresh!.auth_version) fail(401, INVALID_CHALLENGE);
    if (totpAccountState(user) !== 'disabled') fail(409, INVALID_CHALLENGE);

    const installed = db.prepare(`UPDATE users SET totp_secret=?, totp_confirmed_at=?, totp_last_step=?,
      auth_version=auth_version+1, version=version+1
      WHERE id=? AND auth_version=? AND totp_secret IS NULL AND totp_confirmed_at IS NULL`)
      .run(pendingSealed, new Date(now).toISOString(), matched, user.id, user.auth_version).changes;
    if (installed !== 1) fail(409, INVALID_CHALLENGE);

    const consumed = db.prepare('UPDATE login_challenges SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(now, fresh!.token_hash).changes;
    if (consumed !== 1) fail(409, INVALID_CHALLENGE);

    // 只允许一个 enroll 成功：其余挑战、会话与旧恢复码全部失效。
    db.prepare('DELETE FROM login_challenges WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(user.id);
    const insertCode = db.prepare('INSERT INTO recovery_codes (user_id,code_hash,created_at) VALUES (?,?,?)');
    for (const code of codes) insertCode.run(user.id, hashRecoveryCode(user.id, code.replace('-', '')), new Date(now).toISOString());

    const token = createSession(db, user.id, now);
    audit(user.username, 'enroll-totp', `user:${user.id}`);
    return token;
  });

  resetLimit('login-user', account!.username);
  resetLimit('totp-user', account!.username);
  return { token: sessionToken, recoveryCodes: codes };
}
