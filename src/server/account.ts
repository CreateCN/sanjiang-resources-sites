import { database, transaction } from './db.ts';
import { actorUser, bumpAuthVersion, revokeAuthProofs, type Role, type User } from './store.ts';
import { audit, fail, verifyPassword } from './security.ts';
import { createSession, totpAccountState, totpPolicy } from './auth.ts';
import {
  base32Decode, classifyOtpInput, createRecoveryCodes, currentStep, encryptionKey, hashRecoveryCode,
  isFreshStep, openSecret, secretAad, verifyTotp,
} from './totp.ts';

/**
 * 账户认证因子的**变更**入口（停用、重生成恢复码、管理员重置、CLI 重置、策略切换）。
 *
 * 规则（SECURITY-SPEC §4.5 / §9 撤销矩阵）：
 * - 每个变更都递增 auth_version，并撤销该账户的全部会话、挑战与恢复码；
 * - 敏感动作要求新鲜证明（当前口令 + 已启用时还要当前因子），且证明消费与变更同事务；
 * - 管理员不得通过"重置他人"路径重置自己。
 */

type Db = ReturnType<typeof database>;

interface UserRow {
  id: number; username: string; role: Role; active: number; version: number;
  auth_version: number; totp_secret: string | null; totp_confirmed_at: string | null;
  totp_last_step: number | null; password_hash: string;
}

function readUser(db: Db, id: number): UserRow | undefined {
  return db.prepare(`SELECT id,username,role,active,version,auth_version,totp_secret,totp_confirmed_at,totp_last_step,password_hash
    FROM users WHERE id=?`).get(id) as unknown as UserRow | undefined;
}

export interface SecuritySummary {
  state: 'disabled' | 'enabled' | 'invalid';
  confirmedAt: string | null;
  remainingRecoveryCodes: number;
  authVersion: number;
  policyRequired: boolean;
  policyRaw: string;
  keyConfigured: boolean;
}

/** 人员列表用的批量状态（不读 secret、不读恢复码内容）。 */
export function userSecurityStates(): Map<number, { state: 'disabled' | 'enabled' | 'invalid'; remaining: number }> {
  const db = database();
  const rows = db.prepare(`SELECT u.id,u.totp_secret,u.totp_confirmed_at,
    (SELECT COUNT(*) FROM recovery_codes r WHERE r.user_id=u.id AND r.used_at IS NULL) AS remaining
    FROM users u`).all();
  const map = new Map<number, { state: 'disabled' | 'enabled' | 'invalid'; remaining: number }>();
  for (const row of rows) {
    map.set(Number(row.id), {
      state: totpAccountState({ totp_secret: row.totp_secret as string | null, totp_confirmed_at: row.totp_confirmed_at as string | null }),
      remaining: Number(row.remaining ?? 0),
    });
  }
  return map;
}

export function securitySummary(user: User): SecuritySummary | undefined {
  const db = database();
  const row = readUser(db, user.id);
  if (!row) return undefined;
  const policy = totpPolicy();
  const remaining = Number(db.prepare('SELECT COUNT(*) AS total FROM recovery_codes WHERE user_id=? AND used_at IS NULL').get(user.id)?.total ?? 0);
  return {
    state: totpAccountState({ totp_secret: row.totp_secret, totp_confirmed_at: row.totp_confirmed_at }),
    confirmedAt: row.totp_confirmed_at,
    remainingRecoveryCodes: remaining,
    authVersion: row.auth_version,
    policyRequired: policy.valid && policy.requiredFor(row.role),
    policyRaw: policy.raw,
    keyConfigured: Boolean(encryptionKey()),
  };
}

/**
 * 新鲜证明：口令 + （已启用时）当前 TOTP 或恢复码。
 * 条件更新保证同一验证码/恢复码不能被两次敏感操作复用；随调用方事务一起回滚。
 */
function consumeFreshProof(db: Db, row: UserRow, password: string, code: string): void {
  if (!verifyPassword(password, row.password_hash)) fail(403, '当前口令不正确');
  const state = totpAccountState({ totp_secret: row.totp_secret, totp_confirmed_at: row.totp_confirmed_at });
  if (state === 'invalid') fail(503, '账户认证状态异常，请联系运维重置双因素');
  if (state === 'disabled') return;

  const input = classifyOtpInput(code);
  if (!input) fail(400, '请输入当前验证器中的 6 位验证码，或一枚恢复码');
  const key = encryptionKey();
  if (!key) fail(503, '双因素加密密钥未配置，暂时无法修改双因素设置');

  if (input.kind === 'totp') {
    let secret: Buffer;
    try {
      secret = base32Decode(openSecret(String(row.totp_secret), key, secretAad(row.id)));
    } catch {
      fail(503, '双因素密钥无法解密，请联系管理员重置双因素');
    }
    const matched = verifyTotp(secret!, input.code, currentStep());
    if (matched === null || !isFreshStep(row.totp_last_step, matched)) fail(403, '验证码不正确或已使用');
    const updated = db.prepare(`UPDATE users SET totp_last_step=? WHERE id=? AND auth_version=?
      AND (totp_last_step IS NULL OR totp_last_step < ?)`).run(matched, row.id, row.auth_version, matched).changes;
    if (updated !== 1) fail(409, '验证码已被使用，请等待下一个验证码');
    return;
  }

  const codeHash = hashRecoveryCode(row.id, input.normalized);
  const consumed = db.prepare('UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL')
    .run(new Date().toISOString(), row.id, codeHash).changes;
  if (consumed !== 1) fail(403, '恢复码不正确或已使用');
}

/** 停用双因素：策略要求该角色时拒绝（必须由另一位管理员或 CLI 处理）。 */
export function disableTotp(actor: User, password: string, code: string): void {
  transaction((db) => {
    const current = actorUser(actor);
    const policy = totpPolicy();
    if (!policy.valid) fail(503, '认证策略配置错误（TOTP_REQUIRED_FOR），请联系管理员');
    const row = readUser(db, current.id);
    if (!row || !row.active) fail(401, '登录已失效，请重新登录');
    if (policy.requiredFor(row.role)) fail(403, '当前策略要求该角色必须启用双因素；请联系另一位管理员或使用运维命令');
    if (totpAccountState({ totp_secret: row.totp_secret, totp_confirmed_at: row.totp_confirmed_at }) !== 'enabled') fail(409, '该账户未启用双因素');
    consumeFreshProof(db, row, password, code);
    db.prepare('UPDATE users SET totp_secret=NULL,totp_confirmed_at=NULL,totp_last_step=NULL,version=version+1 WHERE id=?').run(row.id);
    bumpAuthVersion(db, row.id);
    revokeAuthProofs(db, row.id, { recoveryCodes: true });
    audit(current.username, 'disable-totp', `user:${row.id}`);
  });
}

/** 重生成恢复码：旧码全部作废；本人会话重建（旧会话与旧挑战全部撤销）。 */
export function regenerateRecoveryCodes(actor: User, password: string, code: string): { codes: string[]; token: string } {
  const codes = createRecoveryCodes();
  const token = transaction((db) => {
    const current = actorUser(actor);
    const row = readUser(db, current.id);
    if (!row || !row.active) fail(401, '登录已失效，请重新登录');
    if (totpAccountState({ totp_secret: row.totp_secret, totp_confirmed_at: row.totp_confirmed_at }) !== 'enabled') {
      fail(409, '该账户尚未启用双因素；请先完成绑定');
    }
    consumeFreshProof(db, row, password, code);
    revokeAuthProofs(db, row.id, { recoveryCodes: true });
    bumpAuthVersion(db, row.id);
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT INTO recovery_codes (user_id,code_hash,created_at) VALUES (?,?,?)');
    for (const entry of codes) insert.run(row.id, hashRecoveryCode(row.id, entry.replace('-', '')), now);
    const sessionToken = createSession(db, row.id);
    audit(current.username, 'regenerate-recovery', `user:${row.id}`);
    return sessionToken;
  });
  return { codes, token };
}

/** 管理员重置他人：目标 version 乐观锁 + 操作者新鲜证明 + 理由。 */
export function resetTotpByAdmin(actor: User, targetId: number, targetVersion: number | null, password: string, code: string, reason: string): void {
  const text = reason.trim();
  if (text.length < 4 || text.length > 200) fail(400, '请填写 4–200 个字符的重置理由');
  if (!Number.isSafeInteger(targetId) || targetId < 1) fail(400, '无效账户编号');
  if (targetVersion === null || !Number.isSafeInteger(targetVersion) || targetVersion < 1) fail(400, '缺少有效版本号，请重新加载人员页面');
  transaction((db) => {
    const current = actorUser(actor, true);
    if (current.id === targetId) fail(400, '不能通过“重置他人”路径重置自己；请使用账户安全页');
    const operator = readUser(db, current.id);
    if (!operator) fail(401, '登录已失效，请重新登录');
    consumeFreshProof(db, operator, password, code);
    const target = readUser(db, targetId);
    if (!target) fail(404, '账户不存在');
    if (target.version !== Number(targetVersion)) fail(409, '该账户已被其他维护者修改；请重新加载人员与权限页面');
    db.prepare(`UPDATE users SET totp_secret=NULL,totp_confirmed_at=NULL,totp_last_step=NULL,
      auth_version=auth_version+1,version=version+1 WHERE id=?`).run(target.id);
    revokeAuthProofs(db, target.id, { recoveryCodes: true });
    audit(current.username, 'reset-totp', `user:${target.id} (${text})`);
  });
}

/**
 * 离线 CLI 重置：不依赖加密密钥，也不改口令、不改策略。
 * 必须先停止 app/maintenance 等全部写入者再运行（脚本会做离线检查）。
 */
export function cliResetTotp(username: string, reason: string): { id: number; username: string; hadFactor: boolean } {
  const name = username.trim().toLowerCase();
  if (!name) fail(400, '请指定用户名');
  const text = reason.trim();
  if (text.length < 4) fail(400, '请用 --reason 说明重置原因（至少 4 个字符）');
  return transaction((db) => {
    const row = db.prepare('SELECT id,username,totp_secret,totp_confirmed_at FROM users WHERE username=?').get(name) as unknown as UserRow | undefined;
    if (!row) fail(404, `找不到账户：${name}`);
    const hadFactor = Boolean(row.totp_secret || row.totp_confirmed_at);
    db.prepare(`UPDATE users SET totp_secret=NULL,totp_confirmed_at=NULL,totp_last_step=NULL,
      auth_version=auth_version+1,version=version+1 WHERE id=?`).run(row.id);
    revokeAuthProofs(db, row.id, { recoveryCodes: true });
    audit('cli', 'reset-totp', `user:${row.id} (${text})`);
    return { id: row.id, username: String(row.username), hadFactor };
  });
}

function rolesFor(raw: string): Role[] | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'off') return [];
  if (normalized === 'admin') return ['admin'];
  if (normalized === 'admin,editor') return ['admin', 'editor'];
  return undefined;
}

/**
 * 离线策略切换：递增受影响账户的 auth_version 并撤销证明。
 * 仅改环境变量不算完成策略变更——旧会话必须在这里失效。
 */
export function applyTotpPolicy(from: string, to: string): { from: string; to: string; affected: number } {
  const fromRoles = rolesFor(from);
  const toRoles = rolesFor(to);
  if (!fromRoles) fail(400, `无效的策略值：${from}`);
  if (!toRoles) fail(400, `无效的策略值：${to}`);
  const affectedRoles = new Set<Role>([...fromRoles, ...toRoles]);
  return transaction((db) => {
    const rows = db.prepare('SELECT id,role FROM users').all();
    let affected = 0;
    for (const row of rows) {
      if (!affectedRoles.has(row.role as Role)) continue;
      bumpAuthVersion(db, Number(row.id));
      revokeAuthProofs(db, Number(row.id));
      affected += 1;
    }
    audit('cli', 'set-totp-policy', `${from.trim()}->${to.trim()} (${affected} accounts)`);
    return { from: from.trim().toLowerCase(), to: to.trim().toLowerCase(), affected };
  });
}

/** 供 /admin/security 页面使用的新鲜口令校验（不消费因子）。 */
export function verifyFreshPassword(user: User, password: string): boolean {
  const row = database().prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
  return Boolean(row) && verifyPassword(password, String(row!.password_hash));
}
