import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import jsQR from 'jsqr';

// 所有数据库访问在导入实现前重定向到临时目录；绝不触碰工作区的 data/。
const root = mkdtempSync(join(tmpdir(), 'sj-totp-'));
let sequence = 0;
process.env.DATABASE_PATH = join(root, 'boot.sqlite');
process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64url');
delete process.env.TOTP_REQUIRED_FOR;
delete process.env.SITE_URL;

const store = await import('../src/server/store.ts');
const auth = await import('../src/server/auth.ts');
const account = await import('../src/server/account.ts');
const totp = await import('../src/server/totp.ts');
const http = await import('../src/server/http.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');
const siteConfig = await import('../src/server/site-config.ts');
const { DEFAULT_BRANDING } = await import('../src/lib/site-config.ts');

const PASSWORD = 'totp-test-password-2026!';
let admin;
let editor;

beforeEach(() => {
  closeDatabase();
  process.env.DATABASE_PATH = join(root, `${++sequence}.sqlite`);
  process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64url');
  delete process.env.TOTP_REQUIRED_FOR;
  delete process.env.SITE_URL;
  admin = store.createInitialAdmin('operator', PASSWORD);
  editor = store.createUser(admin, 'editor', PASSWORD, 'editor');
});
after(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

const stepNow = () => totp.currentStep();
const codeFor = (secret, step = stepNow()) => totp.hotp(totp.base32Decode(secret), step);

const directToken = (user) => {
  const outcome = auth.login(user.username, PASSWORD, `direct-${Math.random()}`);
  if (outcome.kind !== 'session') throw new Error(`unexpected ${outcome.purpose} challenge`);
  return outcome.token;
};
/**
 * 模拟"时间已经过去"：把已记录步数回退，让当前步的验证码重新成为"未使用"。
 * 生产环境靠等待 30 秒；测试里改状态等价且不依赖系统时钟。
 */
function rewindLastStep(userId, steps = 5) {
  database().prepare('UPDATE users SET totp_last_step = COALESCE(totp_last_step, 0) - ? WHERE id=?').run(steps, userId);
}

const readSession = (token) => auth.getSession(new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${token}` } }));

async function enableTotp(user, clientId = `enroll-${Math.random()}`) {
  const challenge = auth.issueEnrollChallenge(user.id, clientId);
  const view = await auth.enrollChallengeView(challenge, clientId);
  assert.ok(view, '注册挑战必须可渲染');
  const result = auth.confirmEnrollment(challenge, codeFor(view.secret), clientId);
  return { challenge, view, ...result };
}

function request(path, fields, { origin = 'http://localhost', token, cookie, address = '127.0.0.1', method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (origin) headers.Origin = origin;
  if (token) headers.Cookie = `${auth.SESSION_COOKIE}=${token}`;
  else if (cookie) headers.Cookie = cookie;
  return { request: new Request(`http://localhost${path}`, { method, headers, body: new URLSearchParams(fields) }), clientAddress: address };
}

function throwsStatus(fn, status, pattern) {
  try {
    fn();
  } catch (error) {
    if (pattern) assert.match(String(error.message), pattern);
    assert.equal(error.status, status, `期望 ${status}，实际 ${error?.status}: ${error?.message}`);
    return error;
  }
  assert.fail(`期望抛出 ${status}，但没有抛错`);
}

function count(table) {
  return Number(database().prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total);
}

/* --------------------------------------------------------------------- 1 */

test('未启用且策略 off：口令直接签发会话，不产生挑战', async () => {
  const token = directToken(admin);
  assert.ok(readSession(token));
  assert.equal(count('login_challenges'), 0);
  assert.equal(count('sessions'), 1);
});

test('已启用：第一步只给挑战，第二步才签发会话', async () => {
  const enabled = await enableTotp(admin, 'client-login');
  const outcome = auth.login('operator', PASSWORD, 'client-login-2');
  assert.equal(outcome.kind, 'challenge');
  assert.equal(outcome.purpose, 'login');
  assert.equal(readSession(outcome.token), undefined, '挑战令牌不是会话');
  assert.equal(count('sessions'), 1, '只有注册时写入的那一个会话');

  // 注册时已用掉当前步，等一步（模拟 30 秒后）再用下一个验证码。
  const verified = auth.verifyLoginChallenge(outcome.token, codeFor(enabled.view.secret, stepNow() + 1), 'client-login-2');
  assert.ok(readSession(verified.token), '第二步成功后才是完全认证');
  assert.equal(verified.usedRecovery, false);
});

test('HTTP：挑战 Cookie Path=/、无会话；第二步成功签发会话并清除挑战', async () => {
  const enabled = await enableTotp(admin, 'http-client');
  const login = await http.loginPost(request('/api/login/', { username: 'operator', password: PASSWORD }, { address: '198.51.100.10', origin: 'http://localhost' }));
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/admin/login/totp/');
  const cookies = login.headers.getSetCookie();
  const challengeCookie = cookies.find((value) => value.startsWith(`${auth.CHALLENGE_COOKIE}=`));
  const sessionCookie = cookies.find((value) => value.startsWith(`${auth.SESSION_COOKIE}=`));
  assert.ok(challengeCookie, '必须下发挑战 Cookie');
  assert.match(challengeCookie, /Path=\//);
  assert.match(challengeCookie, /HttpOnly/);
  assert.match(challengeCookie, /SameSite=Strict/);
  assert.match(challengeCookie, /Max-Age=300/);
  assert.ok(sessionCookie && /Max-Age=0/.test(sessionCookie), '第一步必须清除会话 Cookie');

  const token = challengeCookie.split(';')[0].split('=')[1];
  const bad = await http.totpPost(request('/api/login/totp/', { code: '000000' }, { cookie: `${auth.CHALLENGE_COOKIE}=${token}`, address: '198.51.100.10' }));
  assert.equal(bad.status, 401);
  assert.equal((await http.healthGet().json()).status, 'ok');

  rewindLastStep(admin.id);
  const good = await http.totpPost(request('/api/login/totp/', { code: codeFor(enabled.view.secret, stepNow()) }, { cookie: `${auth.CHALLENGE_COOKIE}=${token}`, address: '198.51.100.10' }));
  assert.equal(good.status, 303);
  assert.equal(good.headers.get('location'), '/admin/');
  const issued = good.headers.getSetCookie().find((value) => value.startsWith(`${auth.SESSION_COOKIE}=`) && !value.includes('Max-Age=0'));
  assert.ok(issued, '第二步成功必须签发会话');
  const cleared = good.headers.getSetCookie().find((value) => value.startsWith(`${auth.CHALLENGE_COOKIE}=`));
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Path=\//);
  const sessionValue = issued.split(';')[0].split('=')[1];
  assert.ok(readSession(sessionValue));
});

test('HTTPS 站点下挑战 Cookie 带 Secure，清除时属性一致', async () => {
  process.env.SITE_URL = 'https://resources.example.invalid';
  const issued = auth.challengeCookie('a'.repeat(43));
  assert.match(issued, /; Secure$/);
  assert.match(issued, /Path=\//);
  const cleared = auth.challengeCookie();
  assert.match(cleared, /Max-Age=0; Secure$/);
  assert.match(cleared, /Path=\//);
});

test('五次失败作废挑战；重新发行不重置账号失败预算', async () => {
  const enabled = await enableTotp(admin, 'brute-client');
  const outcome = auth.login('operator', PASSWORD, 'brute-client');
  assert.equal(outcome.kind, 'challenge');
  for (let index = 0; index < 5; index++) throwsStatus(() => auth.verifyLoginChallenge(outcome.token, '000000', 'brute-client'), 401, /验证码不正确/);
  const row = database().prepare('SELECT attempts,consumed_at FROM login_challenges').get();
  assert.equal(Number(row.attempts), 5);
  assert.ok(row.consumed_at, '第五次失败必须作废挑战');
  throwsStatus(() => auth.verifyLoginChallenge(outcome.token, codeFor(enabled.view.secret, stepNow()), 'brute-client'), 401);

  const budgets = Number(database().prepare("SELECT count FROM rate_limits WHERE key LIKE 'totp-user:%'").get()?.count ?? 0);
  assert.equal(budgets, 5, '失败预算按次累计');
  const next = auth.login('operator', PASSWORD, 'brute-client');
  assert.equal(next.kind, 'challenge', '重新发行挑战仍然允许（凭据有效）');
  const after = Number(database().prepare("SELECT count FROM rate_limits WHERE key LIKE 'totp-user:%'").get()?.count ?? 0);
  assert.equal(after, 5, '重新获取挑战不得清零失败预算');
});

test('过期挑战、用途不符与客户端不符都会被拒绝', async () => {
  const enabled = await enableTotp(admin, 'match-client');
  const loginChallenge = auth.login('operator', PASSWORD, 'match-client');
  assert.equal(loginChallenge.kind, 'challenge');
  throwsStatus(() => auth.verifyLoginChallenge(loginChallenge.token, codeFor(enabled.view.secret, stepNow()), 'other-client'), 401, /验证码/);

  const fresh = auth.login('operator', PASSWORD, 'match-client-2');
  assert.equal(fresh.kind, 'challenge');
  // 同时前移 created_at，保持 expires_at > created_at 的 CHECK 成立。
  database().prepare('UPDATE login_challenges SET created_at=created_at-2000, expires_at=expires_at-2000 WHERE consumed_at IS NULL').run();
  throwsStatus(() => auth.verifyLoginChallenge(fresh.token, codeFor(enabled.view.secret, stepNow()), 'match-client-2'), 401);

  const enrollPurpose = auth.issueEnrollChallenge(editor.id, 'purpose-client');
  throwsStatus(() => auth.verifyLoginChallenge(enrollPurpose, '123456', 'purpose-client'), 401);
});

test('改密/改角色/停用后旧挑战与旧会话立即失效', async () => {
  const enabled = await enableTotp(editor, 'revoke-client');
  const oldSession = enabled.token;
  const challenge = auth.login('editor', PASSWORD, 'revoke-client');
  assert.equal(challenge.kind, 'challenge');

  store.updateUser(admin, editor.id, store.listUsers().find((user) => user.id === editor.id).version, 'editor', true, 'new-password-123456');
  throwsStatus(() => auth.verifyLoginChallenge(challenge.token, codeFor(enabled.view.secret, stepNow()), 'revoke-client'), 401);
  assert.equal(readSession(oldSession), undefined, '改密会撤销全部旧会话');
  assert.equal(count('login_challenges'), 0, '改密会撤销全部旧挑战');
});

test('恢复码只能用一次，且与 TOTP 分桶计数', async () => {
  const enabled = await enableTotp(editor, 'recovery-client');
  const code = enabled.recoveryCodes[0];
  const first = auth.login('editor', PASSWORD, 'recovery-client');
  assert.equal(first.kind, 'challenge');
  const verified = auth.verifyLoginChallenge(first.token, code, 'recovery-client');
  assert.equal(verified.usedRecovery, true);

  const second = auth.login('editor', PASSWORD, 'recovery-client');
  assert.equal(second.kind, 'challenge');
  throwsStatus(() => auth.verifyLoginChallenge(second.token, code, 'recovery-client'), 401, /验证码/);
  const used = Number(database().prepare('SELECT COUNT(*) AS total FROM recovery_codes WHERE used_at IS NOT NULL').get().total);
  assert.equal(used, 1, '恢复码只消费一次');
  assert.equal(Number(database().prepare("SELECT count FROM rate_limits WHERE key LIKE 'totp-recovery-user:%'").get()?.count ?? 0), 1);
});

test('并发：两个挑战提交同一步验证码，只有一个成功', async () => {
  const enabled = await enableTotp(admin, 'race-client');
  const one = auth.login('operator', PASSWORD, 'race-client');
  const two = auth.login('operator', PASSWORD, 'race-client');
  assert.ok(one.kind === 'challenge' && two.kind === 'challenge');
  rewindLastStep(admin.id);
  const step = stepNow();
  const code = codeFor(enabled.view.secret, stepNow());
  const ok = auth.verifyLoginChallenge(one.token, code, 'race-client');
  assert.ok(ok.token);
  throwsStatus(() => auth.verifyLoginChallenge(two.token, code, 'race-client'), 401, /验证码/);
  const lastStep = Number(database().prepare('SELECT totp_last_step FROM users WHERE id=?').get(admin.id).totp_last_step);
  assert.equal(lastStep, step);
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id=?').get(admin.id).total), 2, '注册会话 + 一次登录会话');
});

test('并发：两个 enroll 挑战只有一个能安装因子，旧挑战不能覆盖新密钥', async () => {
  const clientA = 'enroll-race-a';
  const clientB = 'enroll-race-b';
  const challengeA = auth.issueEnrollChallenge(admin.id, clientA);
  const challengeB = auth.issueEnrollChallenge(admin.id, clientB);
  const viewA = await auth.enrollChallengeView(challengeA, clientA);
  const viewB = await auth.enrollChallengeView(challengeB, clientB);
  assert.notEqual(viewA.secret, viewB.secret, '两个挑战必须各自持有独立秘密');
  assert.equal(await auth.enrollChallengeView(challengeA, clientA).then((view) => view.secret), viewA.secret, '刷新复用同一秘密');

  const first = auth.confirmEnrollment(challengeA, codeFor(viewA.secret), clientA);
  assert.ok(first.token);
  throwsStatus(() => auth.confirmEnrollment(challengeB, codeFor(viewB.secret), clientB), 401, /验证码|失效/);
  assert.equal(count('login_challenges'), 0, '成功后撤销全部挑战');
  throwsStatus(() => auth.issueEnrollChallenge(admin.id, clientB), 409, /已启用/);

  rewindLastStep(admin.id);
  const step = stepNow();
  rewindLastStep(admin.id);
  const loginChallenge = auth.login('operator', PASSWORD, 'after-race');
  assert.equal(loginChallenge.kind, 'challenge');
  const verified = auth.verifyLoginChallenge(loginChallenge.token, codeFor(viewA.secret, step), 'after-race');
  assert.ok(verified.token, '保留下来的必须是第一个密钥');
});

test('issuer 按实例冻结：改品牌不改二维码，也不撤销会话或认证代次', async () => {
  database().prepare("INSERT INTO metadata (key,value) VALUES ('auth_issuer','星河验证器') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const token = directToken(admin);
  const authVersionBefore = Number(database().prepare('SELECT auth_version FROM users WHERE id=?').get(admin.id).auth_version);
  const { schemaVersion, version, ...rest } = DEFAULT_BRANDING;
  siteConfig.saveBranding(admin, { ...rest, name: '改名后的站点', subtitle: '新副标题' }, siteConfig.getBrandingAdminView().version ?? 0);
  assert.equal(Number(database().prepare('SELECT auth_version FROM users WHERE id=?').get(admin.id).auth_version), authVersionBefore, '改名不递增认证代次');
  assert.ok(readSession(token), '改名不清会话');

  process.env.TOTP_REQUIRED_FOR = 'admin';
  const outcome = auth.login('operator', PASSWORD, 'issuer-client');
  assert.equal(outcome.kind, 'challenge');
  const view = await auth.enrollChallengeView(outcome.token, 'issuer-client');
  assert.ok(view);
  assert.equal(view.issuer, '星河验证器');
  assert.equal(view.uri, totp.buildOtpauthUri('operator', view.secret, '星河验证器'));
  const parsed = new URL(view.uri);
  assert.equal(parsed.searchParams.get('issuer'), '星河验证器');
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), '星河验证器:operator');
  const { data, info } = await sharp(Buffer.from(view.svg)).resize(480, 480).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  assert.ok(decoded);
  assert.equal(decoded.data, view.uri, '页面文案与二维码使用同一个冻结 issuer');
  process.env.TOTP_REQUIRED_FOR = 'off';
});

test('注册二维码解码出的 secret 可以走真实 HTTP 接口完成绑定', async () => {
  // 模拟旧实例：issuer 在初始化时冻结为改造前的展示名。
  database().prepare("INSERT INTO metadata (key,value) VALUES ('auth_issuer','三江资源') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  process.env.TOTP_REQUIRED_FOR = 'admin';
  const login = await http.loginPost(request('/api/login/', { username: 'operator', password: PASSWORD }, { address: '198.51.100.30' }));
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/admin/login/enroll/');
  const cookie = login.headers.getSetCookie().find((value) => value.startsWith(`${auth.CHALLENGE_COOKIE}=`));
  const token = cookie.split(';')[0].split('=')[1];
  const view = await auth.enrollChallengeView(token, '198.51.100.30');
  assert.ok(view);
  // 独立解码二维码，得到 URI；secret 必须与挑战记录一致。
  const { data, info } = await sharp(Buffer.from(view.svg)).resize(480, 480).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  assert.ok(decoded);
  const uri = new URL(decoded.data);
  assert.equal(uri.searchParams.get('secret'), view.secret);
  assert.equal(uri.searchParams.get('issuer'), '三江资源');
  assert.equal(decodeURIComponent(uri.pathname.slice(1)), '三江资源:operator');

  const code = totp.hotp(totp.base32Decode(uri.searchParams.get('secret')), stepNow());
  const confirm = await http.enrollPost(request('/api/login/enroll/', { code }, { cookie: `${auth.CHALLENGE_COOKIE}=${token}`, address: '198.51.100.30' }));
  assert.equal(confirm.status, 200);
  const body = await confirm.text();
  assert.match(body, /恢复码/);
  assert.equal((body.match(/<code>[A-Z2-7]{4}-[A-Z2-7]{4}<\/code>/g) ?? []).length, 10);
  assert.match(confirm.headers.get('cache-control'), /no-store/);
  const sessionCookie = confirm.headers.getSetCookie().find((value) => value.startsWith(`${auth.SESSION_COOKIE}=`) && !value.includes('Max-Age=0'));
  assert.ok(sessionCookie);
  assert.ok(readSession(sessionCookie.split(';')[0].split('=')[1]));
  process.env.TOTP_REQUIRED_FOR = 'off';
});

test('未提交验证码、错误码与仅凭“已扫码”都不能完成注册', async () => {
  process.env.TOTP_REQUIRED_FOR = 'admin';
  const clientId = 'enroll-no-code';
  const challenge = (() => {
    const outcome = auth.login('operator', PASSWORD, clientId);
    assert.equal(outcome.kind, 'challenge');
    assert.equal(outcome.purpose, 'enroll');
    return outcome.token;
  })();
  const view = await auth.enrollChallengeView(challenge, clientId);
  throwsStatus(() => auth.confirmEnrollment(challenge, '', clientId), 401);
  throwsStatus(() => auth.confirmEnrollment(challenge, '000000', clientId), 401);
  // 错误码不更换二维码：同一挑战的秘密保持不变。
  const again = await auth.enrollChallengeView(challenge, clientId);
  assert.equal(again.secret, view.secret);
  const result = auth.confirmEnrollment(challenge, codeFor(view.secret), clientId);
  assert.equal(result.recoveryCodes.length, 10);
  process.env.TOTP_REQUIRED_FOR = 'off';
});

test('密钥缺失或状态异常时 fail-closed，不降级为口令登录', async () => {
  await enableTotp(admin, 'key-client');
  const original = process.env.TOTP_ENC_KEY;
  delete process.env.TOTP_ENC_KEY;
  try {
    throwsStatus(() => auth.login('operator', PASSWORD, 'key-client'), 503, /密钥/);
  } finally { process.env.TOTP_ENC_KEY = original; }

  // secret 与 confirmed 只有一半：属于异常状态，登录必须拒绝。
  database().prepare('UPDATE users SET totp_confirmed_at=NULL WHERE id=?').run(editor.id);
  database().prepare('UPDATE users SET totp_secret=? WHERE id=?').run('GEZDGNBVGY3TQOJQ', editor.id);
  throwsStatus(() => auth.login('editor', PASSWORD, 'anomaly-client'), 503, /状态异常/);
});

test('非法策略值拒绝认证；off 下不强制注册', async () => {
  process.env.TOTP_REQUIRED_FOR = 'everyone';
  throwsStatus(() => auth.login('operator', PASSWORD, 'policy-client'), 503, /策略/);
  process.env.TOTP_REQUIRED_FOR = 'off';
  assert.ok(directToken(admin));
});

test('账户安全：停用/重生成恢复码/管理员重置遵循撤销矩阵', async () => {
  const enabled = await enableTotp(editor, 'settings-client');
  const code = () => { rewindLastStep(editor.id); return codeFor(enabled.view.secret); };

  // 策略要求 admin 时，管理员自己不能停用
  process.env.TOTP_REQUIRED_FOR = 'admin';
  throwsStatus(() => account.disableTotp(admin, PASSWORD, ''), 403, /策略/);
  process.env.TOTP_REQUIRED_FOR = 'off';

  const regenerated = account.regenerateRecoveryCodes(store.listUsers().find((user) => user.id === editor.id), PASSWORD, code());
  assert.equal(regenerated.codes.length, 10);
  const oldCodeChallenge = auth.login('editor', PASSWORD, 'settings-client');
  assert.equal(oldCodeChallenge.kind, 'challenge');
  throwsStatus(() => auth.verifyLoginChallenge(oldCodeChallenge.token, enabled.recoveryCodes[0], 'settings-client'), 401, /验证码/);
  const newCodeChallenge = auth.login('editor', PASSWORD, 'settings-client');
  assert.equal(newCodeChallenge.kind, 'challenge');
  assert.ok(auth.verifyLoginChallenge(newCodeChallenge.token, regenerated.codes[0], 'settings-client').token);

  // 管理员重置他人：编辑者越权被拒，管理员成功后目标因子与证明全部清空
  throwsStatus(() => account.resetTotpByAdmin(store.listUsers().find((user) => user.id === editor.id), admin.id, 1, PASSWORD, '', '越权尝试'), 403);
  const target = store.listUsers().find((user) => user.id === editor.id);
  throwsStatus(() => account.resetTotpByAdmin(admin, admin.id, 1, PASSWORD, '', '重置自己'), 400);
  throwsStatus(() => account.resetTotpByAdmin(admin, editor.id, target.version + 99, PASSWORD, '', '版本不符'), 409);
  account.resetTotpByAdmin(admin, editor.id, target.version, PASSWORD, '', '手机丢失，已核验身份');
  const reset = database().prepare('SELECT totp_secret,totp_confirmed_at,auth_version FROM users WHERE id=?').get(editor.id);
  assert.equal(reset.totp_secret, null);
  assert.equal(reset.totp_confirmed_at, null);
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM recovery_codes WHERE user_id=?').get(editor.id).total), 0);
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id=?').get(editor.id).total), 0);
  assert.ok(auth.login('editor', PASSWORD, 'after-reset').kind === 'session', 'off 下重置后可口令登录');
});

test('CLI 重置与策略切换都会撤销旧证明并写审计', async () => {
  await enableTotp(admin, 'cli-client');
  const sessionsBefore = count('sessions');
  assert.ok(sessionsBefore >= 1);
  const result = account.cliResetTotp('operator', '唯一管理员丢失设备');
  assert.equal(result.hadFactor, true);
  assert.equal(count('sessions'), 0);
  assert.equal(count('login_challenges'), 0);
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM audit WHERE action=?').get('reset-totp').total), 1);
  // 同值策略切换仍然撤销旧证明（幂等，不复活任何东西）
  const direct = directToken(admin);
  assert.ok(readSession(direct));
  const editorToken = directToken(editor);
  const applied = account.applyTotpPolicy('off', 'admin');
  assert.equal(applied.affected, 1, '只有管理员受影响');
  assert.equal(readSession(direct), undefined, '策略变更必须撤销受影响账户的旧会话');
  assert.ok(readSession(editorToken), '未受影响角色保持登录');
  const same = account.applyTotpPolicy('off', 'off');
  assert.equal(same.affected, 0, '同值切换不恢复任何旧证明');
  assert.equal(readSession(direct), undefined);
  throwsStatus(() => account.applyTotpPolicy('off', 'root'), 400);
});

test('审计写入失败时因子安装/挑战消费/会话全部回滚', async () => {
  const clientId = 'audit-client';
  const challenge = auth.issueEnrollChallenge(admin.id, clientId);
  const view = await auth.enrollChallengeView(challenge, clientId);
  database().exec(`CREATE TRIGGER fail_enroll_audit BEFORE INSERT ON audit WHEN NEW.action='enroll-totp' BEGIN SELECT RAISE(ABORT,'audit down'); END;`);
  assert.throws(() => auth.confirmEnrollment(challenge, codeFor(view.secret), clientId), /audit down/);
  const row = database().prepare('SELECT totp_secret,totp_confirmed_at FROM users WHERE id=?').get(admin.id);
  assert.equal(row.totp_secret, null, '因子不得安装');
  assert.equal(row.totp_confirmed_at, null);
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id=?').get(admin.id).total), 0, '失败时不得签发任何会话');
  const state = database().prepare('SELECT consumed_at FROM login_challenges WHERE token_hash IS NOT NULL').get();
  assert.equal(state?.consumed_at ?? null, null, '挑战不得被消费');
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM recovery_codes').get().total), 0);

  database().exec('DROP TRIGGER fail_enroll_audit');
  const retry = auth.confirmEnrollment(challenge, codeFor(view.secret), clientId);
  assert.ok(retry.token, '回滚后同一挑战仍可完成注册');
});

test('登录审计失败同样回滚会话与步数消费', async () => {
  const enabled = await enableTotp(admin, 'audit-login');
  const challenge = auth.login('operator', PASSWORD, 'audit-login');
  assert.equal(challenge.kind, 'challenge');
  database().exec(`CREATE TRIGGER fail_login_audit BEFORE INSERT ON audit WHEN NEW.action='login-totp' BEGIN SELECT RAISE(ABORT,'audit down'); END;`);
  rewindLastStep(admin.id);
  const step = stepNow();
  assert.throws(() => auth.verifyLoginChallenge(challenge.token, codeFor(enabled.view.secret, step), 'audit-login'), /audit down/);
  assert.equal(Number(database().prepare('SELECT totp_last_step FROM users WHERE id=?').get(admin.id).totp_last_step ?? 0) < step, true, '步数消费必须回滚');
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id=?').get(admin.id).total), 1);
  const row = database().prepare('SELECT consumed_at FROM login_challenges').get();
  assert.equal(row?.consumed_at ?? null, null);
  database().exec('DROP TRIGGER fail_login_audit');
  assert.ok(auth.verifyLoginChallenge(challenge.token, codeFor(enabled.view.secret, step), 'audit-login').token, '回滚后同一步码仍可用一次');
});

test('管理动作：begin-totp-enroll 需要 CSRF 与新口令', async () => {
  const token = directToken(admin);
  const session = readSession(token);
  const withoutCsrf = await http.managePost(request('/api/manage/', { action: 'begin-totp-enroll', password: PASSWORD }, { token }));
  assert.equal(withoutCsrf.status, 403);
  const wrongPassword = await http.managePost(request('/api/manage/', { action: 'begin-totp-enroll', password: 'wrong-password-123', csrf: session.csrfToken }, { token }));
  assert.equal(wrongPassword.status, 403);
  const ok = await http.managePost(request('/api/manage/', { action: 'begin-totp-enroll', password: PASSWORD, csrf: session.csrfToken }, { token }));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/admin/login/enroll/');
  assert.ok(ok.headers.getSetCookie().some((value) => value.startsWith(`${auth.CHALLENGE_COOKIE}=`)));
});

test('二维码生成失败时退回手输密钥，且仍可用验证码完成绑定', async () => {
  const clientId = 'qr-failure';
  const challenge = auth.issueEnrollChallenge(admin.id, clientId);
  const view = await auth.enrollChallengeView(challenge, clientId, { renderSvg: async () => { throw new Error('qr encoder down'); } });
  assert.ok(view, '二维码失败不能导致整页失败');
  assert.equal(view.svg, '');
  assert.match(String(view.qrError), /手动密钥/);
  assert.ok(view.secret.length >= 16);
  const result = auth.confirmEnrollment(challenge, codeFor(view.secret), clientId);
  assert.equal(result.recoveryCodes.length, 10);
});
