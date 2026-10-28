import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 2026-10-25 本地鉴权审查（SJ-A-01 至 SJ-A-05）的定向回归。
 *
 * 这些用例全部通过真实入口驱动（`http.managePost` / `http.loginPost` /
 * `http.totpPost` / `http.enrollPost` / 导入预检路由的 `POST`），不复制路由实现，
 * 也不只测库函数：修复点落在"守卫顺序、预算归属、错误响应"上，只测库函数会漏掉它们。
 */

const root = mkdtempSync(join(tmpdir(), 'sj-auth-hardening-'));
let sequence = 0;
process.env.DATABASE_PATH = join(root, 'boot.sqlite');
process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64url');
delete process.env.TOTP_REQUIRED_FOR;
delete process.env.SITE_URL;
delete process.env.TRUST_PROXY;
delete process.env.TRUST_PROXY_SECRET;

const store = await import('../src/server/store.ts');
const auth = await import('../src/server/auth.ts');
const totp = await import('../src/server/totp.ts');
const http = await import('../src/server/http.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');
const { POST: importPreviewPost } = await import('../src/pages/api/import/preview.ts');

const PASSWORD = 'auth-hardening-password-2026!';
const trusted = (address) => ({ kind: 'client', address });
const unverifiedClient = { kind: 'unverified', reason: 'proxy-secret-mismatch' };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const bucketCount = (scope, identity) => Number(
  database().prepare('SELECT count FROM rate_limits WHERE key=?').get(`${scope}:${hash(identity)}`)?.count ?? 0,
);
const bucketKeys = (pattern) => database().prepare('SELECT key FROM rate_limits WHERE key LIKE ?').all(pattern).map((row) => String(row.key));

let admin;
let editor;

beforeEach(() => {
  closeDatabase();
  process.env.DATABASE_PATH = join(root, `${++sequence}.sqlite`);
  process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64url');
  delete process.env.TOTP_REQUIRED_FOR;
  delete process.env.SITE_URL;
  delete process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY_SECRET;
  admin = store.createInitialAdmin('operator', PASSWORD);
  editor = store.createUser(admin, 'editor', PASSWORD, 'editor');
});

after(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

function form(path, fields, { token, origin = 'http://localhost', address = '127.0.0.1', headers = {} } = {}) {
  const merged = { 'Content-Type': 'application/x-www-form-urlencoded', ...headers };
  if (origin) merged.Origin = origin;
  if (token) merged.Cookie = `${auth.SESSION_COOKIE}=${token}`;
  return { request: new Request(`http://localhost${path}`, { method: 'POST', headers: merged, body: new URLSearchParams(fields) }), clientAddress: address };
}

const sessionFromToken = (token) => ({
  token,
  ...auth.getSession(new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${token}` } })),
});

function sessionFor(user, address = `sess-${Math.random()}`) {
  const outcome = auth.login(user.username, PASSWORD, trusted(address));
  if (outcome.kind !== 'session') throw new Error(`unexpected challenge ${outcome.purpose}`);
  return sessionFromToken(outcome.token);
}

const manage = (session, action, fields = {}, options = {}) =>
  http.managePost(form('/api/manage/', { csrf: session.csrfToken, action, ...fields }, { token: session.token, ...options }));

/** 注册因子并返回注册事务签发的会话（启用后口令登录需要第二步，不能再用 sessionFor）。 */
async function enableTotp(user, clientId = `enroll-${Math.random()}`) {
  const challenge = auth.issueEnrollChallenge(user.id, trusted(clientId));
  const view = await auth.enrollChallengeView(challenge, trusted(clientId));
  assert.ok(view, '注册挑战必须可渲染');
  const result = auth.confirmEnrollment(challenge, nextCode(view), trusted(clientId));
  return { challenge, view, ...result, session: sessionFromToken(result.token) };
}
/** 当前步 +1：仍在 ±1 窗口内，且是注册确认没有消费过的一步。 */
const nextCode = (view, offset = 1) => totp.hotp(totp.base32Decode(view.secret), totp.currentStep() + offset);
const rewindLastStep = (userId, steps = 6) => database()
  .prepare('UPDATE users SET totp_last_step = COALESCE(totp_last_step, 0) - ? WHERE id=?')
  .run(steps, userId);

/** 进程内可复现的"时间到了"：把某个桶的 reset_at 推到过去。 */
const expireBucket = (scope, identity) => database()
  .prepare('UPDATE rate_limits SET reset_at=? WHERE key=?')
  .run(Date.now() - 1, `${scope}:${hash(identity)}`);
const wrongPassword = (index) => `wrong-${index}-password-0000`;
/** manage() 的默认请求地址；TRUST_PROXY 关闭时它就是客户端身份。 */
const HTTP_CLIENT = '127.0.0.1';

/* =============================================== SJ-A-02：新鲜证明失败预算 */

test('SJ-A-02：disable-totp 的证明失败有预算，第 6 次 429 且业务未发生', async () => {
  const enabled = await enableTotp(admin, 'proof-basic');
  const session = enabled.session;
  const results = [];
  for (let index = 0; index < 5; index += 1) {
    results.push((await manage(session, 'disable-totp', { password: wrongPassword(index), code: '' })).status);
  }
  assert.deepEqual(results, [403, 403, 403, 403, 403], '前 5 次错误证明必须返回原有的 403');
  assert.equal(bucketCount('proof-user', 'operator'), 5);
  assert.equal(bucketCount('proof-client', HTTP_CLIENT), 5, '可信身份同时消耗客户端预算');

  // 第 6 次在昂贵 KDF 之前就被拦住，并且带真实剩余窗口。
  rewindLastStep(admin.id);
  const blocked = await manage(session, 'disable-totp', { password: PASSWORD, code: nextCode(enabled.view) });
  assert.equal(blocked.status, 429, '第 6 次尝试必须 429');
  const retry = Number(blocked.headers.get('retry-after'));
  assert.ok(retry > 0 && retry <= 900, `Retry-After 必须落在 15 分钟窗口内，实际 ${retry}`);
  assert.equal(bucketCount('proof-user', 'operator'), 5, '预检拒绝不增加计数、不续期');
  assert.equal(auth.accountAuthState(admin.id), 'enabled', '被拦下的请求不得改动因子状态');
});

test('SJ-A-02：错误验证码、重放与畸形证明同样计入预算', async () => {
  const enabled = await enableTotp(admin, 'proof-shape');
  const session = enabled.session;
  assert.equal((await manage(session, 'disable-totp', { password: PASSWORD, code: '000000' })).status, 403);
  assert.equal((await manage(session, 'disable-totp', { password: PASSWORD, code: '12345' })).status, 400);
  // 重放注册确认已经消费过的那一步（用足够早的偏移取回该步）。
  const consumedStep = totp.currentStep();
  const replayed = totp.hotp(totp.base32Decode(enabled.view.secret), consumedStep - 1);
  const replayStatus = (await manage(session, 'disable-totp', { password: PASSWORD, code: replayed })).status;
  assert.ok([403, 409].includes(replayStatus), `重放必须是证明失败，实际 ${replayStatus}`);
  assert.equal(bucketCount('proof-user', 'operator'), 3, '错误码 / 畸形码 / 重放码各计一次');
  assert.equal(auth.accountAuthState(admin.id), 'enabled');
});

test('SJ-A-02：regenerate-recovery 的证明失败同样有预算', async () => {
  const enabled = await enableTotp(admin, 'proof-regen');
  const liveCodes = () => Number(database().prepare('SELECT COUNT(*) AS total FROM recovery_codes WHERE user_id=? AND used_at IS NULL').get(admin.id).total);
  const before = liveCodes();
  assert.equal(before, 10);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await manage(enabled.session, 'regenerate-recovery', { password: wrongPassword(index), code: '' })).status, 403);
  }
  assert.equal(bucketCount('proof-user', 'operator'), 5);
  rewindLastStep(admin.id);
  const blocked = await manage(enabled.session, 'regenerate-recovery', { password: PASSWORD, code: nextCode(enabled.view) });
  assert.equal(blocked.status, 429, '第 6 次尝试必须 429');
  assert.equal(liveCodes(), before, '被拦下的请求不得重建恢复码');
  assert.equal(auth.accountAuthState(admin.id), 'enabled');
});

test('SJ-A-02：客户端证明预算到 30 后，后续请求不再推进账号桶（第 31 次边界）', async () => {
  const session = sessionFor(admin, 'proof-client-bound');
  // 直接把客户端历史累计摆到 29（等价于"别的操作者/别的动作已经打了 29 次"）。
  database().prepare(`INSERT INTO rate_limits (key,count,reset_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET count=excluded.count, reset_at=excluded.reset_at`)
    .run(`proof-client:${hash(HTTP_CLIENT)}`, 29, Date.now() + 10 * 60 * 1000);
  assert.equal((await manage(session, 'begin-totp-enroll', { password: wrongPassword(0) })).status, 403);
  assert.equal(bucketCount('proof-client', HTTP_CLIENT), 30);
  assert.equal(bucketCount('proof-user', 'operator'), 1);

  // 第 31 次在账号校验之前就被客户端预算挡住：账号桶不得继续增长。
  assert.equal((await manage(session, 'begin-totp-enroll', { password: PASSWORD })).status, 429);
  assert.equal(bucketCount('proof-user', 'operator'), 1, '被客户端预算拒绝的请求不得推进账号桶');
  assert.equal(bucketCount('proof-client', HTTP_CLIENT), 30, '预检拒绝不增计数、不续期');
});

test('SJ-A-02：跨动作、跨会话、跨目标累计到同一个操作者预算', async () => {
  const first = sessionFor(admin, 'proof-cross-a');
  const second = sessionFor(admin, 'proof-cross-b');
  const target = store.createUser(admin, 'reset-target', PASSWORD, 'editor');
  // begin-totp-enroll 只校验口令（账户未启用因子），reset-totp 校验口令 + 目标版本。
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await manage(first, 'begin-totp-enroll', { password: wrongPassword(index) })).status, 403);
  }
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await manage(second, 'reset-totp', {
      id: String(target.id), version: '1', password: wrongPassword(index), code: '', reason: '跨动作累计原因',
    })).status, 403);
  }
  assert.equal(bucketCount('proof-user', 'operator'), 5, '换动作换会话换目标都不能拆散操作者预算');
  const third = sessionFor(admin, 'proof-cross-c');
  assert.equal((await manage(third, 'begin-totp-enroll', { password: PASSWORD })).status, 429, '第 6 次跨动作尝试必须 429');
});

test('SJ-A-02：reset-totp 按操作者记账，不牵连目标账号', async () => {
  const target = store.createUser(admin, 'target-user', PASSWORD, 'editor');
  const session = sessionFor(admin, 'proof-operator');
  for (let index = 0; index < 5; index += 1) {
    const response = await manage(session, 'reset-totp', {
      id: String(target.id), version: '1', password: wrongPassword(index), code: '', reason: '测试重置原因',
    });
    assert.equal(response.status, 403, '错误口令必须 403');
  }
  assert.equal(bucketCount('proof-user', 'operator'), 5, '记在操作者名下');
  assert.equal(bucketCount('proof-user', 'target-user'), 0, '目标账号不得被扣额度');
  assert.equal((await manage(session, 'reset-totp', {
    id: String(target.id), version: '1', password: PASSWORD, code: '', reason: '测试重置原因',
  })).status, 429);
});

test('SJ-A-02：不可信身份只结算账号预算，不建 proof-client 桶', async () => {
  const enabled = await enableTotp(admin, 'proof-unverified');
  // 带转发头但不带代理凭据 → 不可信身份（TRUST_PROXY 关闭时转发头一律不参与身份）。
  const unverifiedHeaders = { 'X-Forwarded-For': '203.0.113.91' };
  for (let index = 0; index < 5; index += 1) {
    const response = await manage(enabled.session, 'disable-totp', { password: wrongPassword(index), code: '' }, { address: '203.0.113.90', headers: unverifiedHeaders });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(bucketKeys('proof-client:%'), [], '不可信身份不得创建 proof-client 桶');
  assert.equal(bucketCount('proof-user', 'operator'), 5);
});

test('SJ-A-02：成功只清账号桶，不清客户端历史预算', async () => {
  const enabled = await enableTotp(admin, 'proof-success');
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await manage(enabled.session, 'disable-totp', { password: wrongPassword(index), code: '' })).status, 403);
  }
  rewindLastStep(admin.id);
  const ok = await manage(enabled.session, 'disable-totp', { password: PASSWORD, code: nextCode(enabled.view) });
  assert.equal(ok.status, 303, '正确的口令 + 验证码必须成功');
  assert.equal(auth.accountAuthState(admin.id), 'disabled');
  assert.equal(bucketCount('proof-user', 'operator'), 0, '成功后清账号桶');
  assert.equal(bucketCount('proof-client', HTTP_CLIENT), 2, '客户端历史累计不得被清零');
});

test('SJ-A-02：begin-totp-enroll 成功不清其他动作累计的因子失败', async () => {
  const session = sessionFor(admin, 'proof-begin');
  const enabled = await enableTotp(editor, 'proof-begin-editor');
  // 让编辑者（另一个人）累计一次因子失败，确认不会波及管理员；同一个人用管理员的 begin。
  assert.equal((await manage(session, 'begin-totp-enroll', { password: wrongPassword(0) })).status, 403);
  assert.equal(bucketCount('proof-user', 'operator'), 1);
  const ok = await manage(session, 'begin-totp-enroll', { password: PASSWORD });
  assert.equal(ok.status, 303, '正确口令必须能开始绑定');
  assert.equal(bucketCount('proof-user', 'operator'), 1, '只校验口令的流程成功后不得清账号桶');
  assert.equal(bucketCount('proof-user', 'editor'), 0, '不得波及他人');
  assert.ok(enabled.session);
});

test('SJ-A-02：策略拒绝 / 版本冲突 / 审计失败不扣证明预算', async () => {
  const enabled = await enableTotp(admin, 'proof-nonproof');
  const session = enabled.session;

  // 策略拒绝：发生在证明校验之前。
  process.env.TOTP_REQUIRED_FOR = 'admin';
  const policy = await manage(session, 'disable-totp', { password: PASSWORD, code: '' });
  assert.equal(policy.status, 403);
  delete process.env.TOTP_REQUIRED_FOR;

  // 业务版本冲突：证明本身是对的，失败来自目标版本。
  const target = store.createUser(admin, 'other-target', PASSWORD, 'editor');
  rewindLastStep(admin.id);
  const conflict = await manage(session, 'reset-totp', {
    id: String(target.id), version: '99', password: PASSWORD, code: nextCode(enabled.view), reason: '版本冲突原因',
  });
  assert.equal(conflict.status, 409);

  // 审计失败：证明通过后，业务事务内部失败。
  // 这里要直接断言"因子的消费也回滚了"，不能只看因子状态：`consumeFreshProof()`
  // 会把命中的时间步写进 `totp_last_step`，审计失败必须把它一起撤掉。
  rewindLastStep(admin.id);
  const stepBefore = Number(database().prepare('SELECT totp_last_step FROM users WHERE id=?').get(admin.id).totp_last_step);
  database().exec(`CREATE TRIGGER fail_disable_audit BEFORE INSERT ON audit WHEN NEW.action='disable-totp' BEGIN SELECT RAISE(ABORT,'audit down'); END;`);
  const auditDown = await manage(session, 'disable-totp', { password: PASSWORD, code: nextCode(enabled.view) });
  database().exec('DROP TRIGGER fail_disable_audit');
  assert.equal(auditDown.status, 500);
  assert.equal(
    Number(database().prepare('SELECT totp_last_step FROM users WHERE id=?').get(admin.id).totp_last_step),
    stepBefore,
    '审计失败必须回滚因子消费（totp_last_step）',
  );

  assert.equal(bucketCount('proof-user', 'operator'), 0, '非证明失败不得冒充证明错误扣额度');
  assert.equal(auth.accountAuthState(admin.id), 'enabled', '审计失败与版本冲突都不得改动因子');
});

test('SJ-A-02：失败计数不会被业务回滚带走，窗口到期后恢复', async () => {
  const enabled = await enableTotp(admin, 'proof-window');
  const session = enabled.session;
  assert.equal((await manage(session, 'disable-totp', { password: 'wrong-password-000', code: '' })).status, 403);
  assert.equal(bucketCount('proof-user', 'operator'), 1, '证明失败必须在独立事务里留下计数');
  assert.equal(auth.accountAuthState(admin.id), 'enabled', '同时业务不得生效');

  for (let index = 1; index < 5; index += 1) {
    assert.equal((await manage(session, 'disable-totp', { password: wrongPassword(index), code: '' })).status, 403);
  }
  assert.equal((await manage(session, 'disable-totp', { password: 'wrong-again-password', code: '' })).status, 429);

  expireBucket('proof-user', 'operator');
  expireBucket('proof-client', enabled.session.token);
  // 窗口到期后应回到原有的证明错误，而不是继续 429（客户端桶按登录地址计，这里一并清掉）。
  database().prepare("DELETE FROM rate_limits WHERE key LIKE 'proof-client:%'").run();
  const afterWindow = await manage(session, 'disable-totp', { password: 'wrong-after-window', code: '' });
  assert.equal(afterWindow.status, 403, '窗口到期后应回到原有的证明错误，而不是继续 429');
});

/* ============================================ SJ-A-01：正确口令不被账号桶封锁 */

test('SJ-A-01：第三方耗尽账号桶后，正确口令仍能完成单因子登录', async () => {
  const attacker = '203.0.113.11';
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await http.loginPost(form('/api/login/', { username: 'operator', password: `wrong-${index}-password` }, { address: attacker }))).status, 401);
  }
  assert.equal(bucketCount('login-user', 'operator'), 10);
  // 攻击者继续用错误口令：仍然被账号桶拒绝（"拒绝失败尝试"的语义保持不变）。
  assert.equal((await http.loginPost(form('/api/login/', { username: 'operator', password: 'wrong-still' }, { address: attacker }))).status, 429);
  // 合法来源用正确口令：必须放行。
  const legit = await http.loginPost(form('/api/login/', { username: 'operator', password: PASSWORD }, { address: '198.51.100.42' }));
  assert.equal(legit.status, 303, '正确口令不得因为别人的失败被封锁');
  assert.equal(legit.headers.get('location'), '/admin/');
});

test('SJ-A-01：耗尽账号桶后，TOTP 账户仍进入第二步、强制注册账户仍进入注册', async () => {
  await enableTotp(admin, 'sj-a-01');
  for (let index = 0; index < 10; index += 1) {
    await http.loginPost(form('/api/login/', { username: 'operator', password: `wrong-${index}-password` }, { address: '203.0.113.12' }));
  }
  const second = await http.loginPost(form('/api/login/', { username: 'operator', password: PASSWORD }, { address: '198.51.100.43' }));
  assert.equal(second.status, 303, '正确口令必须进入第二步');
  assert.equal(second.headers.get('location'), '/admin/login/totp/', '不得因为口令正确就直接签发会话');

  // 强制注册：策略要求 admin 且账户未启用因子。
  store.createUser(admin, 'forced-enroll', PASSWORD, 'admin');
  process.env.TOTP_REQUIRED_FOR = 'admin';
  try {
    for (let index = 0; index < 10; index += 1) {
      await http.loginPost(form('/api/login/', { username: 'forced-enroll', password: `wrong-${index}-password` }, { address: '203.0.113.13' }));
    }
    const enroll = await http.loginPost(form('/api/login/', { username: 'forced-enroll', password: PASSWORD }, { address: '198.51.100.44' }));
    assert.equal(enroll.status, 303);
    assert.equal(enroll.headers.get('location'), '/admin/login/enroll/');
  } finally {
    delete process.env.TOTP_REQUIRED_FOR;
  }
});

test('SJ-A-01：客户端桶与站点熔断仍在昂贵校验前拦截', async () => {
  // 客户端桶：同一来源 30 次失败后，即使口令正确也必须被拒。
  for (let index = 0; index < 30; index += 1) {
    await http.loginPost(form('/api/login/', { username: `ghost-${index}`, password: 'wrong-password-0000' }, { address: '203.0.113.14' }));
  }
  const clientBlocked = await http.loginPost(form('/api/login/', { username: 'operator', password: PASSWORD }, { address: '203.0.113.14' }));
  assert.equal(clientBlocked.status, 429, '客户端层仍在 KDF 之前准入');

  // 站点熔断：另一来源的正确口令同样被拒绝。
  const security = await import('../src/server/security.ts');
  for (let index = 0; index < 500; index += 1) security.consumeLimit({ scope: 'login-site', identity: 'site', maximum: 500, windowMs: 300_000 });
  const siteBlocked = await http.loginPost(form('/api/login/', { username: 'operator', password: PASSWORD }, { address: '198.51.100.45' }));
  assert.equal(siteBlocked.status, 429, '站点熔断对正确口令同样生效');
});

/* ================================== SJ-A-03：导入预检测试（路由级，含读体探针） */

/**
 * 读体探针。**不能**用 `bodyUsed` 或"首块是否被取走"判断：Node 的 Request 在
 * 构造时就会预取第一块（实测 pull 次数 = 1、`bodyUsed` 仍为 false）。
 * 因此这里让流必须被**读到底**才会产出超过 1 块：预取恒为 1，应用读完 ≥ 4。
 */
function streamingPreviewRequest({ token, origin = 'http://localhost', fields = {} }) {
  const encoder = new TextEncoder();
  // 整体必须是**一份**合法的 urlencoded 表单：重复发送同一块会产生重复字段，
  // 被 readForm 的重复字段拒绝挡成 400，那就测不到授权顺序了。
  const payload = new URLSearchParams(fields).toString();
  const size = Math.max(1, Math.ceil(payload.length / 4));
  const parts = [0, 1, 2, 3].map((index) => payload.slice(index * size, (index + 1) * size));
  const state = { pulls: 0 };
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(parts[state.pulls] ?? ''));
      state.pulls += 1;
      if (state.pulls >= 4) controller.close();
    },
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}) };
  if (token) headers.Cookie = `${auth.SESSION_COOKIE}=${token}`;
  return {
    request: new Request('http://localhost/api/import/preview/', { method: 'POST', headers, body, duplex: 'half' }),
    pulls: () => state.pulls,
  };
}
const PREFETCHED = 1;

test('SJ-A-03：匿名 401、编辑者 403，且两者都不读请求体', async () => {
  const anonymous = streamingPreviewRequest({ fields: { payload: '{}' } });
  const anonymousResponse = await importPreviewPost({ request: anonymous.request });
  assert.equal(anonymousResponse.status, 401);
  assert.equal(anonymousResponse.headers.get('cache-control'), 'no-store');
  assert.ok(anonymous.pulls() <= PREFETCHED, `未授权请求不得读取请求体（pull=${anonymous.pulls()}）`);

  const editorSession = sessionFor(editor, 'import-editor');
  const editorProbe = streamingPreviewRequest({ token: editorSession.token, fields: { csrf: editorSession.csrfToken, payload: '{}' } });
  const editorResponse = await importPreviewPost({ request: editorProbe.request });
  assert.equal(editorResponse.status, 403);
  assert.ok(editorProbe.pulls() <= PREFETCHED, `越权请求不得读取请求体（pull=${editorProbe.pulls()}）`);
  assert.match(JSON.parse(await editorResponse.text()).error, /管理员/);
});

test('SJ-A-03：管理员正常预检仍可用（正向对照：请求体确实被读完）', async () => {
  const session = sessionFor(admin, 'import-admin');
  const probe = streamingPreviewRequest({
    token: session.token,
    fields: { csrf: session.csrfToken, payload: JSON.stringify({ resources: [] }) },
  });
  const response = await importPreviewPost({ request: probe.request });
  assert.equal(response.status, 200);
  assert.ok(probe.pulls() >= 4, `管理员路径必须真的读完请求体（pull=${probe.pulls()}）`);
  assert.ok(JSON.parse(await response.text()).plan);
});

test('SJ-A-03：Origin 守卫保留，且跨站请求在计费与读体之前被拒', async () => {
  const session = sessionFor(admin, 'import-guards');
  const probe = streamingPreviewRequest({ token: session.token, origin: 'https://evil.invalid', fields: { csrf: session.csrfToken, payload: '{}' } });
  const crossOrigin = await importPreviewPost({ request: probe.request });
  assert.equal(crossOrigin.status, 403);
  assert.ok(probe.pulls() <= PREFETCHED, `跨站请求不得读取请求体（pull=${probe.pulls()}）`);
  assert.equal(bucketCount('import-user', 'operator'), 0, '未通过 Origin 的请求不消耗导入预算');

  // CSRF 守卫必须长在**这个路由**上：删掉它，下面两条会变成 200。
  const field = (csrf) => importPreviewPost(form('/api/import/preview/', { csrf, payload: '{}' }, { token: session.token }));
  assert.equal((await field('')).status, 403, '缺少 CSRF 令牌必须 403');
  assert.equal((await field('not-the-session-token-0000000000000000')).status, 403, '错误的 CSRF 令牌必须 403');
  assert.equal((await field(session.csrfToken)).status, 200, '正确令牌仍然放行');
  assert.equal(bucketCount('import-user', 'operator'), 3, '三条请求各计一次请求预算（CSRF 在读体之后）');
});

test('SJ-A-03：import-user 预算 10 次/小时，第 11 次 429 且不再读体', async () => {
  const session = sessionFor(admin, 'import-budget');
  const send = () => importPreviewPost(form('/api/import/preview/', { csrf: session.csrfToken, payload: '{}' }, { token: session.token }));
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await send()).status, 200, `第 ${index + 1} 次预检应放行`);
  }
  assert.equal(bucketCount('import-user', 'operator'), 10);
  const probe = streamingPreviewRequest({ token: session.token, fields: { csrf: session.csrfToken, payload: '{}' } });
  const blocked = await importPreviewPost({ request: probe.request });
  assert.equal(blocked.status, 429);
  assert.ok(probe.pulls() <= PREFETCHED, `超出预算后不得继续读取请求体（pull=${probe.pulls()}）`);
  const retry = Number(blocked.headers.get('retry-after'));
  assert.ok(retry > 3000 && retry <= 3600, `Retry-After 必须落在 1 小时窗口内，实际 ${retry}`);

  // 畸形请求同样计数：另一个管理员 10 次非法 JSON 之后也会被挡住。
  const other = sessionFor(store.createUser(admin, 'second-admin', PASSWORD, 'admin'), 'import-malformed');
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await importPreviewPost(form('/api/import/preview/', { csrf: other.csrfToken, payload: '{not json' }, { token: other.token }))).status, 400);
  }
  assert.equal((await importPreviewPost(form('/api/import/preview/', { csrf: other.csrfToken, payload: '{}' }, { token: other.token }))).status, 429);
});

test('SJ-A-03：非 HttpError 只返回固定文案，不泄露内部文本', async () => {
  const session = sessionFor(admin, 'import-fault');
  // 受控故障：让 previewImport 内部真的抛一个普通 Error（"no such table: settings"）。
  database().exec('ALTER TABLE settings RENAME TO settings_under_test');
  let response;
  try {
    response = await importPreviewPost(form('/api/import/preview/', {
      csrf: session.csrfToken,
      payload: JSON.stringify({ settings: { featuredResourceId: '' } }),
    }, { token: session.token }));
  } finally {
    database().exec('ALTER TABLE settings_under_test RENAME TO settings');
  }
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.doesNotMatch(body, /no such table|settings_under_test|SQLITE|at \w+ \(/i, `500 响应不得包含内部文本：${body}`);
  // 文案来自 http.ts#errorShape() 的公共实现（与 /api/manage/ 同一句），不是这里另写的。
  assert.match(body, /服务暂时不可用/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('SJ-A-03：payload 上限与非法 JSON 由预检路由自身拒绝', async () => {
  const { IMPORT_MAX_BYTES, MANAGE_MAX_BYTES } = await import('../src/server/http.ts');
  const session = sessionFor(admin, 'import-limits');
  // 4 MiB ＜ MANAGE_MAX_BYTES（≈5.2 MiB，读体阶段放行）但 ＞ IMPORT_MAX_BYTES（3 MiB），
  // 所以 413 只能来自本路由的 payload 上限检查；删掉该检查会退回 200。
  const payload = JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) });
  assert.ok(new TextEncoder().encode(payload).length > IMPORT_MAX_BYTES);
  assert.ok(new TextEncoder().encode(payload).length < MANAGE_MAX_BYTES);
  const oversize = await importPreviewPost(form('/api/import/preview/', { csrf: session.csrfToken, payload }, { token: session.token }));
  assert.equal(oversize.status, 413, 'payload 超过 IMPORT_MAX_BYTES 必须 413');
  assert.match(JSON.parse(await oversize.text()).error, /过大/);

  assert.equal((await importPreviewPost(form('/api/import/preview/', { csrf: session.csrfToken, payload: '{not json' }, { token: session.token }))).status, 400);
});

/* ============================ SJ-A-04 / SJ-A-05：挑战失败结算与占位键碰撞 */

test('SJ-A-05：真实用户名为 unknown 时，垃圾挑战 token 不影响其注册与登录', async () => {
  // `unknown` 是合法用户名（[a-z0-9_.-]{3,64}）。旧实现拿同一个字符串当占位身份，
  // 于是垃圾 token 记的正是这个真实账号的桶。
  const ghost = store.createUser(admin, 'unknown', PASSWORD, 'editor');
  const address = '203.0.113.70';
  const challenge = auth.issueEnrollChallenge(ghost.id, trusted(address));
  const view = await auth.enrollChallengeView(challenge, trusted(address));
  assert.ok(view);

  // 10 次不存在的 login 挑战 token（垃圾），按不可信身份提交。
  for (let index = 0; index < 10; index += 1) {
    const response = await http.totpPost(form('/api/login/totp/', { code: '123456' }, {
      address,
      headers: { Cookie: `${auth.CHALLENGE_COOKIE}=${'A'.repeat(43)}`, 'X-Forwarded-For': '203.0.113.71' },
    }));
    assert.equal(response.status, 401);
  }
  assert.equal(bucketCount('totp-user', 'unknown'), 0, '垃圾 token 不得写入任何账号桶（含同名的真实账号）');
  assert.equal(bucketCount('login-site', 'site'), 10, '垃圾 token 改由站点熔断计数');

  // 该账号自己的注册仍然成功。
  const code = nextCode(view);
  const enrolled = await http.enrollPost(form('/api/login/enroll/', { code }, { address, headers: { Cookie: `${auth.CHALLENGE_COOKIE}=${challenge}` } }));
  assert.equal(enrolled.status, 200, '同名的真实账号不得被垃圾 token 连带锁死');
  assert.equal(auth.accountAuthState(ghost.id), 'enabled');
});

test('SJ-A-04：TOTP 与恢复码失败都计入 login-site（可信与不可信身份）', async () => {
  const enabled = await enableTotp(admin, 'site-fuse');
  const trustedChallenge = auth.login('operator', PASSWORD, trusted('site-fuse'));
  assert.equal(trustedChallenge.kind, 'challenge');
  assert.throws(() => auth.verifyLoginChallenge(trustedChallenge.token, '000000', trusted('site-fuse')), /验证码|尝试次数/);
  assert.equal(bucketCount('login-site', 'site'), 1, '可信身份的 TOTP 失败也要记站点熔断');
  assert.equal(bucketCount('totp-user', 'operator'), 1);

  const unverified = auth.login('operator', PASSWORD, unverifiedClient);
  assert.equal(unverified.kind, 'challenge');
  assert.throws(() => auth.verifyLoginChallenge(unverified.token, '111111', unverifiedClient), /验证码|尝试次数/);
  assert.equal(bucketCount('login-site', 'site'), 2, '不可信身份的 TOTP 失败同样记站点熔断');
  assert.equal(bucketCount('totp-client', 'unverified-peer'), 0, '不可信身份不得创建 totp-client 桶');
  assert.equal(bucketKeys('totp-client:%').length, 1, '只有可信身份建 totp-client 桶');
  assert.ok(enabled.view.secret);
});

test('SJ-A-04：绑定不符 / 失效 / 用途不符的挑战不进账号桶，也不推进尝试次数', async () => {
  const enabled = await enableTotp(admin, 'binding');
  const challenge = auth.login('operator', PASSWORD, trusted('binding'));
  assert.equal(challenge.kind, 'challenge');
  const attempts = () => Number(database().prepare('SELECT attempts FROM login_challenges WHERE consumed_at IS NULL').get()?.attempts ?? -1);

  // 换了客户端：token 不再属于这个请求。
  assert.throws(() => auth.verifyLoginChallenge(challenge.token, nextCode(enabled.view), trusted('someone-else')), /验证码/);
  assert.equal(attempts(), 0, '绑定不符不得推进尝试次数');
  assert.equal(bucketCount('totp-user', 'operator'), 0, '绑定不符不得扣账号额度');
  assert.equal(bucketCount('login-site', 'site'), 1, '但仍按不可归属的失败结算站点层');

  // 用途不符：拿 enroll 挑战走 login 验证。
  const enrollPurpose = auth.issueEnrollChallenge(editor.id, trusted('purpose'));
  assert.throws(() => auth.verifyLoginChallenge(enrollPurpose, '123456', trusted('purpose')), /验证码/);
  assert.equal(bucketCount('totp-user', 'editor'), 0);
  assert.equal(bucketCount('login-site', 'site'), 2);
});

test('SJ-A-04：畸形证明也必须先准入账号预算，再结算（复核 P3 顺序契约）', async () => {
  await enableTotp(editor, 'malformed-order');
  // 打满 `totp-user`（5 次/挑战 × 2 个挑战）。
  for (let round = 0; round < 2; round += 1) {
    const challenge = auth.login('editor', PASSWORD, trusted('malformed-order'));
    assert.equal(challenge.kind, 'challenge');
    for (let index = 0; index < 5; index += 1) {
      try { auth.verifyLoginChallenge(challenge.token, '000000', trusted('malformed-order')); } catch { /* 预期失败 */ }
    }
  }
  assert.equal(bucketCount('totp-user', 'editor'), 10, '账号桶已打满');

  const fresh = auth.login('editor', PASSWORD, trusted('malformed-order'));
  assert.equal(fresh.kind, 'challenge');
  const attemptsBefore = Number(database().prepare('SELECT attempts FROM login_challenges WHERE consumed_at IS NULL').get()?.attempts ?? -1);
  // '12' 既不是 6 位数字也不是 8 位 base32 → 畸形证明。
  assert.throws(() => auth.verifyLoginChallenge(fresh.token, '12', trusted('malformed-order')), /请求过于频繁|尝试次数过多|验证码/);
  assert.equal(bucketCount('totp-user', 'editor'), 10, '被账号预算拒绝的畸形提交不得把计数推到 11');
  assert.equal(
    Number(database().prepare('SELECT attempts FROM login_challenges WHERE consumed_at IS NULL').get()?.attempts ?? -1),
    attemptsBefore,
    '被账号预算拒绝的畸形提交不得额外消耗挑战尝试',
  );
});

test('SJ-A-04/05：两个因子的账号桶双向独立，成功不清另一因子的累计', async () => {
  const enabled = await enableTotp(editor, 'independence');

  // 先用错误恢复码把恢复码桶打满（3 次）。
  const recoveryChallenge = auth.login('editor', PASSWORD, trusted('independence'));
  assert.equal(recoveryChallenge.kind, 'challenge');
  for (let index = 0; index < 3; index += 1) {
    assert.throws(() => auth.verifyLoginChallenge(recoveryChallenge.token, 'AAAA-BBBB', trusted('independence')), /验证码|尝试次数/);
  }
  assert.equal(bucketCount('totp-recovery-user', 'editor'), 3);
  assert.equal(bucketCount('totp-user', 'editor'), 0, '恢复码失败不得消耗 TOTP 账号预算');

  // 恢复码桶耗尽时，正确的 TOTP 仍然可以登录。
  rewindLastStep(editor.id);
  const totpChallenge = auth.login('editor', PASSWORD, trusted('independence'));
  assert.equal(totpChallenge.kind, 'challenge');
  const totpLogin = auth.verifyLoginChallenge(totpChallenge.token, nextCode(enabled.view), trusted('independence'));
  assert.ok(totpLogin.token, '恢复码预算耗尽不得阻断合法 TOTP');
  assert.equal(totpLogin.usedRecovery, false);

  // 反过来：先把 TOTP 账号桶**打满**（10 次），再用正确的恢复码登录。
  // 只累计 1 次测不出"打满后的 TOTP 桶是否会挡住恢复码"这件事。
  const second = await enableTotp(store.createUser(admin, 'second-user', PASSWORD, 'editor'), 'independence-2');
  for (let round = 0; round < 2; round += 1) {
    const failChallenge = auth.login('second-user', PASSWORD, trusted('independence-2'));
    assert.equal(failChallenge.kind, 'challenge');
    for (let index = 0; index < 5; index += 1) {
      try { auth.verifyLoginChallenge(failChallenge.token, '000000', trusted('independence-2')); } catch { /* 预期失败 */ }
    }
  }
  assert.equal(bucketCount('totp-user', 'second-user'), 10, 'TOTP 账号桶已打满');

  // 打满之后，另一因子的正确凭据仍然必须能登录（账号桶按因子分开）。
  const recoveryLogin = auth.login('second-user', PASSWORD, trusted('independence-2'));
  assert.equal(recoveryLogin.kind, 'challenge');
  const viaRecovery = auth.verifyLoginChallenge(recoveryLogin.token, second.recoveryCodes[0], trusted('independence-2'));
  assert.equal(viaRecovery.usedRecovery, true, 'TOTP 桶打满不得阻断合法恢复码');
  assert.equal(bucketCount('totp-user', 'second-user'), 10, '恢复码成功不得清空 TOTP 账号失败桶');
  assert.equal(bucketCount('totp-recovery-user', 'second-user'), 0, '但清掉自己这个因子的失败桶');
});

test('SJ-A-04：可信客户端的 30 次上限必须真正保护站点熔断（复核 P2）', async () => {
  // 复核复现的形态：同一可信来源连续提交垃圾挑战 token。
  // 修复前：前 30 次结算把两个桶都推到 30，之后每次仍结算 → 两个桶一路涨到 500，
  // 站点熔断被打满，别的来源用正确口令也 429。
  const address = '203.0.113.200';
  const send = () => http.totpPost(form('/api/login/totp/', { code: '123456' }, {
    address,
    headers: { Cookie: `${auth.CHALLENGE_COOKIE}=${'A'.repeat(43)}` },
  }));
  const statuses = [];
  for (let index = 0; index < 35; index += 1) statuses.push((await send()).status);
  assert.deepEqual([...new Set(statuses.slice(0, 30))], [401], '前 30 次是普通失败');
  assert.deepEqual([...new Set(statuses.slice(30))], [429], '第 31 次起被客户端预算挡住');
  assert.equal(bucketCount('totp-client', address), 30, '客户端桶停在 30');
  assert.equal(bucketCount('login-site', 'site'), 30, '已耗尽的客户端不得继续推进站点桶');

  const other = await http.loginPost(form('/api/login/', { username: 'operator', password: PASSWORD }, { address: '198.51.100.201' }));
  assert.equal(other.status, 303, '站点熔断未被单个来源打满，另一来源仍可登录');
});

test('SJ-A-04：两个因子都耗尽时由账号桶收口，站点层照常累计', async () => {
  await enableTotp(editor, 'both');
  for (let round = 0; round < 3; round += 1) {
    const challenge = auth.login('editor', PASSWORD, trusted('both'));
    if (challenge.kind !== 'challenge') break;
    for (let index = 0; index < 5; index += 1) {
      try { auth.verifyLoginChallenge(challenge.token, '000000', trusted('both')); } catch { /* 预期失败 */ }
    }
  }
  assert.equal(bucketCount('totp-user', 'editor'), 10, 'TOTP 账号桶打满');
  const recovery = auth.login('editor', PASSWORD, trusted('both'));
  if (recovery.kind === 'challenge') {
    for (let index = 0; index < 3; index += 1) {
      try { auth.verifyLoginChallenge(recovery.token, 'CCCC-DDDD', trusted('both')); } catch { /* 预期失败 */ }
    }
  }
  assert.equal(bucketCount('totp-recovery-user', 'editor'), 3);
  assert.equal(bucketCount('login-site', 'site'), 13, '每一次认证失败都恰好记一次站点层');
});
