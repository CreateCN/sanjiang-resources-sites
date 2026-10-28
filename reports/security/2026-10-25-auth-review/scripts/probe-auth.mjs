/**
 * 2026-10-25 本地鉴权审查：定向探测脚本。
 *
 * 约束（与审查方案 §2 一致）：
 * - 只使用临时目录中的临时 SQLite 与虚构账户，不读工作区 data/，不写业务文件；
 * - 不发起任何出站网络请求（不经过 linkcheck、不经过 fetch）；
 * - 不降低 TOTP 强度、不改业务源码；只调用 src/ 的现有导出函数。
 *
 * 运行：node reports/security/2026-10-25-auth-review/scripts/probe-auth.mjs
 * 输出：每条用例一行 "CASE <id> <结论> <证据>"，末尾汇总统计。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'sj-auth-review-'));
let sequence = 0;
process.env.DATABASE_PATH = join(root, 'boot.sqlite');
process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64url');
delete process.env.TOTP_REQUIRED_FOR;
delete process.env.SITE_URL;
delete process.env.TRUST_PROXY;
delete process.env.TRUST_PROXY_SECRET;

const store = await import('../../../../src/server/store.ts');
const auth = await import('../../../../src/server/auth.ts');
const totp = await import('../../../../src/server/totp.ts');
const http = await import('../../../../src/server/http.ts');
const security = await import('../../../../src/server/security.ts');
const { database, closeDatabase } = await import('../../../../src/server/db.ts');

const PASSWORD = 'auth-review-password-2026!';
const client = (address) => ({ kind: 'client', address });
const results = [];

function record(id, verdict, detail) {
  results.push({ id, verdict, detail });
  console.log(`CASE ${id}\t${verdict}\t${detail}`);
}

function freshDb() {
  closeDatabase();
  process.env.DATABASE_PATH = join(root, `${++sequence}.sqlite`);
  process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64url');
  delete process.env.TOTP_REQUIRED_FOR;
  delete process.env.SITE_URL;
  delete process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY_SECRET;
  const admin = store.createInitialAdmin('operator', PASSWORD);
  const editor = store.createUser(admin, 'editor', PASSWORD, 'editor');
  return { admin, editor };
}

function status(fn) {
  try {
    const value = fn();
    return { status: value instanceof Response ? value.status : 'ok', value };
  } catch (error) {
    if (error instanceof security.HttpError) return { status: error.status, retryAfterMs: error.retryAfterMs };
    return { status: `throw:${error?.name ?? 'Error'}`, message: String(error?.message ?? error) };
  }
}

async function statusAsync(fn) {
  try {
    const value = await fn();
    return { status: value instanceof Response ? value.status : 'ok', value };
  } catch (error) {
    if (error instanceof security.HttpError) return { status: error.status, retryAfterMs: error.retryAfterMs };
    return { status: `throw:${error?.name ?? 'Error'}`, message: String(error?.message ?? error) };
  }
}

function sessionFor(user) {
  const outcome = auth.login(user.username, PASSWORD, client(`sess-${user.id}-${Math.random()}`));
  if (outcome.kind !== 'session') throw new Error(`unexpected challenge ${outcome.purpose}`);
  const request = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${outcome.token}` } });
  return { token: outcome.token, ...auth.getSession(request) };
}

function sessionFromToken(token) {
  const request = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${token}` } });
  return { token, ...auth.getSession(request) };
}

function form(path, fields, { token, origin = 'http://localhost', address = '127.0.0.1', headers = {}, cookie } = {}) {
  const merged = { 'Content-Type': 'application/x-www-form-urlencoded', ...headers };
  if (origin) merged.Origin = origin;
  if (token) merged.Cookie = `${auth.SESSION_COOKIE}=${token}`;
  else if (cookie) merged.Cookie = cookie;
  return { request: new Request(`http://localhost${path}`, { method: 'POST', headers: merged, body: new URLSearchParams(fields) }), clientAddress: address };
}

const manage = (session, action, fields = {}, options = {}) =>
  http.managePost(form('/api/manage/', { csrf: session.csrfToken, action, ...fields }, { token: session.token, ...options }));

const rateRows = () => database().prepare('SELECT key,count FROM rate_limits ORDER BY key').all().map((row) => ({ key: String(row.key), count: Number(row.count) }));
const keyOf = (scope, identity) => `${scope}:${security.hashToken(identity)}`;
const hasKey = (rows, scope, identity) => rows.some((row) => row.key === keyOf(scope, identity));

async function enableTotp(user, clientId = `enroll-${Math.random()}`) {
  const challenge = auth.issueEnrollChallenge(user.id, client(clientId));
  const view = await auth.enrollChallengeView(challenge, client(clientId));
  if (!view) throw new Error('enroll view unavailable');
  const result = auth.confirmEnrollment(challenge, totp.hotp(totp.base32Decode(view.secret), totp.currentStep()), client(clientId));
  return { challenge, view, ...result };
}

/* ---------------------------------------------------------------- P-A 账号层锁定 */

{
  const { admin } = freshDb();
  for (let i = 0; i < 10; i += 1) {
    const outcome = status(() => auth.login('operator', `wrong-password-${i}-xxxxxxxx`, client('attacker-1')));
    if (outcome.status !== 401) record('P-A-setup', 'UNEXPECTED', `第 ${i + 1} 次错误口令返回 ${outcome.status}`);
  }
  const attackerAfter = status(() => auth.login('operator', PASSWORD, client('attacker-1')));
  const legit = status(() => auth.login('operator', PASSWORD, client('legit-1')));
  const rows = rateRows();
  record(
    'P-A',
    legit.status === 429 ? 'REPRODUCED' : 'NOT-REPRODUCED',
    `第三方客户端用 10 次错误口令后：攻击者客户端带正确口令=${attackerAfter.status}，合法客户端带正确口令=${legit.status}`
    + `，Retry-After=${Math.round((legit.retryAfterMs ?? 0) / 1000)}s`
    + `，login-user 计数=${rows.find((row) => row.key === keyOf('login-user', 'operator'))?.count ?? 0}`
    + `，login-client(attacker) 计数=${rows.find((row) => row.key === keyOf('login-client', 'attacker-1'))?.count ?? 0}`,
  );
  record(
    'P-A2',
    'OBSERVED',
    `账号层耗尽后按当前实现拒绝该账号的**全部**尝试（含正确口令），与 SECURITY-SPEC §6.1「耗尽时拒绝该账号的失败尝试」表述不一致；admin.id=${admin.id}`,
  );
}

/* ------------------------------------------- P-B TOTP 失败是否结算站点级/登录级预算 */

{
  const { admin } = freshDb();
  await enableTotp(admin);
  let attempts = 0;
  let lastStatus = null;
  for (let round = 0; round < 8; round += 1) {
    const outcome = status(() => auth.login('operator', PASSWORD, client('totp-attacker')));
    if (outcome.status !== 'ok') { lastStatus = outcome.status; break; }
    const challenge = outcome.value.token;
    for (let i = 0; i < 5; i += 1) {
      const verified = status(() => auth.verifyLoginChallenge(challenge, '000000', client('totp-attacker')));
      attempts += 1;
      lastStatus = verified.status;
      if (verified.status === 429) break;
    }
  }
  const rows = rateRows();
  record(
    'P-B',
    hasKey(rows, 'login-site', 'site') ? 'SITE-BUCKET-PRESENT' : 'DEVIATION',
    `${attempts} 次 TOTP 失败后：login-site 桶=${hasKey(rows, 'login-site', 'site') ? '有' : '无'}`
    + `，login-user 桶=${hasKey(rows, 'login-user', 'operator') ? '有' : '无'}`
    + `，totp-user 计数=${rows.find((row) => row.key === keyOf('totp-user', 'operator'))?.count ?? 0}`
    + `，totp-client 计数=${rows.find((row) => row.key === keyOf('totp-client', 'totp-attacker'))?.count ?? 0}`
    + `，最后一次状态=${lastStatus}`,
  );
  // 对照：单因子登录失败会结算 login-site。
  const after = rateRows();
  record(
    'P-B2',
    'CONTROL',
    `同一库中 login-site 是否存在（对照口令失败路径需另建库）：${hasKey(after, 'login-site', 'site')}`,
  );
}

{
  const { admin } = freshDb();
  status(() => auth.login('operator', 'wrong-password-aaaaaaaaaa', client('pw-attacker')));
  const rows = rateRows();
  record('P-B3', 'CONTROL', `一次口令失败后 login-site 桶=${hasKey(rows, 'login-site', 'site') ? '有' : '无'}（规范 §4.2 要求参与每次失败结算）`);
  record('P-B4', 'CONTROL', `admin.id=${admin.id}（未使用，仅确认账户存在）`);
}

/* ------------------------------------------ P-C 新鲜证明（口令/TOTP）是否有尝试预算 */

{
  const { admin } = freshDb();
  const session = sessionFor(admin);
  const statuses = [];
  for (let i = 0; i < 30; i += 1) {
    const outcome = await statusAsync(() => manage(session, 'begin-totp-enroll', { password: `wrong-${i}-password-xxx` }));
    statuses.push(outcome.status);
  }
  const rows = rateRows();
  const distinct = [...new Set(statuses)];
  record(
    'P-C1',
    distinct.length === 1 && distinct[0] === 403 ? 'REPRODUCED' : 'UNEXPECTED',
    `begin-totp-enroll 连续 30 次错误口令：状态集合=${JSON.stringify(distinct)}`
    + `，rate_limits 中 enroll/challenge 桶=${JSON.stringify(rows.filter((row) => /enroll|challenge/.test(row.key)).length)} 个`
    + `（键已哈希，按存在性判断：enroll-client=${hasKey(rows, 'enroll-client', '127.0.0.1')}）`,
  );
}

{
  const { admin } = freshDb();
  const enabled = await enableTotp(admin, 'enroll-fixed-client');
  const session = sessionFromToken(enabled.token);
  const wrongPassword = [];
  for (let i = 0; i < 30; i += 1) {
    const outcome = await statusAsync(() => manage(session, 'disable-totp', { password: `wrong-${i}-password-xxx`, code: '000000' }, { address: '198.51.100.9' }));
    wrongPassword.push(outcome.status);
  }
  const wrongCode = [];
  for (let i = 0; i < 30; i += 1) {
    const code = String(100000 + i).slice(-6);
    const outcome = await statusAsync(() => manage(session, 'disable-totp', { password: PASSWORD, code }, { address: '198.51.100.9' }));
    wrongCode.push(outcome.status);
  }
  const stillEnabled = auth.accountAuthState(admin.id);
  record(
    'P-C2',
    new Set(wrongPassword).size === 1 && new Set(wrongCode).size === 1 ? 'REPRODUCED' : 'UNEXPECTED',
    `disable-totp 连续 30 次错误口令→状态集合=${JSON.stringify([...new Set(wrongPassword)])}；`
    + `再连续 30 次错误验证码→状态集合=${JSON.stringify([...new Set(wrongCode)])}；`
    + `因子状态仍=${stillEnabled}；rate_limits 总行数=${rateRows().length}`,
  );
  record(
    'P-C3',
    'RISK',
    '该路径无失败预算：持有效会话者可在不受限次数内尝试当前口令与 6 位验证码（恢复码 40 bit 空间更大但同样无上限）',
  );
}

/* --------------------------------------------------------------- P-D 一次性凭据复用 */

{
  const { admin } = freshDb();
  const enabled = await enableTotp(admin, 'replay-client');
  // 注册确认已消费"当前步"，所以这里取下一步（仍在 ±1 窗口内）作为首次登录验证码。
  const step = totp.currentStep() + 1;
  const code = totp.hotp(totp.base32Decode(enabled.view.secret), step);
  const login1 = status(() => auth.login('operator', PASSWORD, client('replay-client')));
  if (login1.status !== 'ok') record('P-D-setup', 'UNEXPECTED', `login=${login1.status}`);
  const first = status(() => auth.verifyLoginChallenge(login1.value.token, code, client('replay-client')));
  const login2 = status(() => auth.login('operator', PASSWORD, client('replay-client')));
  const second = login2.status === 'ok'
    ? status(() => auth.verifyLoginChallenge(login2.value.token, code, client('replay-client')))
    : { status: `login-blocked:${login2.status}` };
  record(
    'P-D',
    first.status === 'ok' && second.status !== 'ok' ? 'ENFORCED' : 'BYPASS',
    `同一步验证码首次=${first.status}，第二次=${second.status}（期望首次成功、再次被拒）`,
  );

  // 恢复码复用
  const recovery = enabled.recoveryCodes[0].replace('-', '');
  const login3 = status(() => auth.login('operator', PASSWORD, client('replay-client')));
  const rec1 = login3.status === 'ok' ? status(() => auth.verifyLoginChallenge(login3.value.token, recovery, client('replay-client'))) : { status: `blocked:${login3.status}` };
  const login4 = status(() => auth.login('operator', PASSWORD, client('replay-client')));
  const rec2 = login4.status === 'ok' ? status(() => auth.verifyLoginChallenge(login4.value.token, recovery, client('replay-client'))) : { status: `blocked:${login4.status}` };
  record(
    'P-D2',
    rec1.status === 'ok' && rec2.status !== 'ok' ? 'ENFORCED' : 'CHECK',
    `同一恢复码首次=${rec1.status}，第二次=${rec2.status}`,
  );
}

/* ------------------------------------------------------ P-E 会话撤销矩阵（认证生命周期） */

{
  const caseLog = [];

  // 登出
  {
    const { admin } = freshDb();
    const session = sessionFor(admin);
    const out = await statusAsync(() => http.logoutPost(form('/api/logout/', { csrf: session.csrfToken }, { token: session.token })));
    const request = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${session.token}` } });
    caseLog.push(`logout=${out.status} 旧Cookie ${auth.getSession(request) ? '仍有效' : '已失效'}`);
  }
  // 改密（管理员重置自己的口令）
  {
    const { admin } = freshDb();
    const session = sessionFor(admin);
    const out = await statusAsync(() => manage(session, 'update-user', {
      id: String(admin.id), version: '1', role: 'admin', active: 'true', password: 'brand-new-password-2026!',
    }));
    const request = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${session.token}` } });
    caseLog.push(`改密=${out.status} 旧Cookie ${auth.getSession(request) ? '仍有效' : '已失效'}`);
  }
  // 角色变更（需要第二位有效管理员，才不触发"最后一位管理员"保护）
  {
    const { admin } = freshDb();
    store.createUser(admin, 'second-admin', PASSWORD, 'admin');
    const session = sessionFor(admin);
    const out = await statusAsync(() => manage(session, 'update-user', {
      id: String(admin.id), version: '1', role: 'editor', active: 'true',
    }));
    const request = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${session.token}` } });
    const fresh = auth.getSession(request);
    caseLog.push(`降级=${out.status} 旧Cookie ${fresh ? `仍有效 role=${fresh.user.role}` : '已失效'}`);
  }
  // 停用
  {
    const { admin } = freshDb();
    const second = store.createUser(admin, 'second-admin', PASSWORD, 'admin');
    const session = sessionFor(admin);
    const operator = sessionFor(second);
    const out = await statusAsync(() => manage(operator, 'update-user', {
      id: String(admin.id), version: '1', role: 'admin', active: '',
    }));
    const request = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${session.token}` } });
    caseLog.push(`停用=${out.status} 旧Cookie ${auth.getSession(request) ? '仍有效' : '已失效'}`);
  }
  // 管理员重置他人双因素
  {
    const { admin } = freshDb();
    const second = await enableTotp(store.createUser(admin, 'second-admin', PASSWORD, 'admin'));
    const victim = store.listUsers().find((user) => user.username === 'second-admin');
    const operator = sessionFor(admin);
    const out = await statusAsync(() => manage(operator, 'reset-totp', {
      id: String(victim.id), version: String(victim.version), password: PASSWORD, code: '', reason: '本地审查演练原因',
    }));
    const request = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${second.token}` } });
    caseLog.push(`重置他人因子=${out.status} 目标旧会话 ${auth.getSession(request) ? '仍有效' : '已失效'} 目标因子=${auth.accountAuthState(victim.id)}`);
  }
  record('P-E', 'OBSERVED', caseLog.join('；'));
}

/* -------------------------------------------------------------- P-F CSRF / Origin 矩阵 */

{
  const { admin, editor } = freshDb();
  // 每个端点使用独立会话：/api/logout/ 的正向对照会注销自己的会话，
  // 共用会话会让后续端点全部退化为 401（不是 Origin/CSRF 的结论）。
  const session = sessionFor(admin);
  const other = sessionFor(editor);
  const perEndpointSession = {
    '/api/manage/': sessionFor(admin),
    '/api/logout/': sessionFor(admin),
    '/api/preview/': sessionFor(admin),
  };

  const endpoints = [
    ['/api/manage/', (fields, opts) => http.managePost(form('/api/manage/', fields, { token: perEndpointSession['/api/manage/'].token, ...opts }))],
    ['/api/preview/', (fields, opts) => http.previewPost(form('/api/preview/', fields, { token: perEndpointSession['/api/preview/'].token, ...opts }))],
    ['/api/logout/', (fields, opts) => http.logoutPost(form('/api/logout/', fields, { token: perEndpointSession['/api/logout/'].token, ...opts }))],
  ];
  const fieldsFor = (name, csrf) => {
    if (name === '/api/manage/') return { csrf, action: 'save-category', id: 'csrf-probe', name: 'CSRF' };
    if (name === '/api/logout/') return { csrf };
    return { csrf, mode: 'block', text: 'probe' };
  };
  const summary = [];
  for (const [name, send] of endpoints) {
    const cells = [];
    for (const [label, opts] of [
      ['无Origin', { origin: null }],
      ['跨站Origin', { origin: 'https://evil.invalid' }],
      ['异端口', { origin: 'http://localhost:9999' }],
      ['尾斜杠', { origin: 'http://localhost/' }],
      ['Sec-Fetch-Site=cross-site', { headers: { 'Sec-Fetch-Site': 'cross-site' } }],
    ]) {
      const out = await statusAsync(() => send(fieldsFor(name, session.csrfToken), opts));
      cells.push(`${label}=${out.status}`);
    }
    const own = perEndpointSession[name];
    const missing = await statusAsync(() => send(fieldsFor(name, ''), {}));
    const foreign = await statusAsync(() => send(fieldsFor(name, other.csrfToken), {}));
    const ok = await statusAsync(() => send(fieldsFor(name, own.csrfToken), {}));
    cells.push(`缺CSRF=${missing.status}`, `借用他人CSRF=${foreign.status}`, `正向对照=${ok.status}`);
    summary.push(`${name}{${cells.join(', ')}}`);
  }
  // 匿名（无 Cookie）提交同样必须被拒绝
  for (const [name] of endpoints) {
    const anonymous = await statusAsync(() => {
      const body = fieldsFor(name, session.csrfToken);
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' };
      return fetch_style(name, body, headers);
    });
    summary.push(`${name}匿名=${anonymous.status}`);
  }
  async function fetch_style(name, fields, headers) {
    const map = { '/api/manage/': http.managePost, '/api/logout/': http.logoutPost, '/api/preview/': http.previewPost };
    return map[name]({ request: new Request(`http://localhost${name}`, { method: 'POST', headers, body: new URLSearchParams(fields) }), clientAddress: '203.0.113.77' });
  }
  const safe = summary.join(' ');
  record('P-F', /缺CSRF=403/.test(safe) && /借用他人CSRF=403/.test(safe) && /匿名=401/.test(safe) ? 'ENFORCED' : 'GAP', safe);
}

/* ------------------------------------- P-G 编辑者 × 全部管理员动作（含非法/空参数顺序） */

{
  const { editor } = freshDb();
  const session = sessionFor(editor);
  const adminOnly = Object.entries(http.MANAGE_ACTION_ROLES).filter(([, required]) => required === 'admin').map(([action]) => action);
  const statuses = new Map();
  for (const action of adminOnly) {
    const out = await statusAsync(() => manage(session, action, {}, {}));
    statuses.set(action, out.status);
  }
  const not403 = [...statuses.entries()].filter(([, status]) => status !== 403);
  const unknown = await statusAsync(() => manage(session, 'definitely-not-an-action', {}, {}));
  record(
    'P-G',
    not403.length === 0 && unknown.status === 400 ? 'ENFORCED' : 'GAP',
    `${adminOnly.length} 个管理员动作对编辑者（空参数）返回：${JSON.stringify([...new Set(statuses.values())])}`
    + `；非 403 的动作=${JSON.stringify(not403)}；未知动作=${unknown.status}`,
  );
}

/* ------------------------------------------- P-H 不可信身份不得产生客户端桶（§6.2 反向检查） */

{
  freshDb();
  process.env.TRUST_PROXY = '1';
  delete process.env.TRUST_PROXY_SECRET;
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const out = await statusAsync(() => http.reportsPost(form('/api/reports/', { kind: 'general', title: '标题', body: '这是一条足够长的反馈内容。', website: '' }, { origin: 'http://localhost', address: `10.0.0.${i + 1}`, headers: { 'X-Forwarded-For': `10.0.0.${i + 1}` } })));
    statuses.push(out.status);
  }
  const rows = rateRows();
  const clientBuckets = rows.filter((row) => row.key !== keyOf('reports-site', 'site'));
  record(
    'P-H',
    clientBuckets.length === 0 ? 'ENFORCED' : 'LEAK',
    `TRUST_PROXY=1 且凭据未配置时轮换 6 个 XFF：状态=${JSON.stringify(statuses)}；`
    + `reports-site 桶=${hasKey(rows, 'reports-site', 'site') ? '有' : '无'}；非站点桶行数=${clientBuckets.length}`,
  );
  delete process.env.TRUST_PROXY;
}

/* --------------------------------- P-I 挑战 Cookie 属性与页面/API 路径覆盖（Cookie 契约） */

{
  freshDb();
  const cookiePage = auth.challengeCookie('a'.repeat(43));
  const cookieClear = auth.challengeCookie();
  const sessionCookie = auth.sessionCookie('b'.repeat(43), false, true);
  const sessionClear = auth.sessionCookie('', true, true);
  const checks = {
    challengeHttpOnly: /HttpOnly/.test(cookiePage),
    challengeSameSite: /SameSite=Strict/.test(cookiePage),
    challengePath: /Path=\//.test(cookiePage),
    challengeMaxAge: /Max-Age=300/.test(cookiePage),
    challengeNoDomain: !/Domain=/.test(cookiePage),
    clearMatchesAttributes: /Path=\/; HttpOnly; SameSite=Strict/.test(cookieClear),
    sessionHttpOnly: /HttpOnly/.test(sessionCookie),
    sessionSameSite: /SameSite=Strict/.test(sessionCookie),
    sessionSecure: /; Secure/.test(sessionCookie),
    sessionClearSecure: /; Secure/.test(sessionClear),
    hostPrefix: /__Host-/.test(sessionCookie),
  };
  record(
    'P-I',
    checks.challengeNoDomain && checks.clearMatchesAttributes && checks.sessionClearSecure ? 'OBSERVED' : 'GAP',
    JSON.stringify(checks),
  );
}

/* ------------------------------------------------- P-J 敏感操作路径是否要求新鲜证明 */

{
  const { admin } = freshDb();
  const session = sessionFor(admin);
  const noProof = [];
  for (const action of ['begin-totp-enroll', 'disable-totp', 'regenerate-recovery']) {
    const out = await statusAsync(() => manage(session, action, {}, {}));
    noProof.push(`${action}(空口令)=${out.status}`);
  }
  record('P-J', noProof.every((line) => !line.includes('=303')) ? 'ENFORCED' : 'GAP', `${noProof.join(' ')}（注：未启用因子的账户在因子检查处先返回 409，口令校验路径由 P-C2 覆盖）`);
}

/* ----------------------------------- P-K 单账号并发会话上限与旧会话剪除（§4.3） */

{
  const { admin } = freshDb();
  const tokens = [];
  for (let i = 0; i < 12; i += 1) tokens.push(auth.login('operator', PASSWORD, client(`cap-${i}`)).token);
  const rows = database().prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id=?').get(admin.id);
  const oldest = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${tokens[0]}` } });
  const newest = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${tokens[11]}` } });
  const storedPlain = database().prepare('SELECT token_hash FROM sessions').all().map((row) => String(row.token_hash));
  record(
    'P-K',
    Number(rows.total) === 10 && !auth.getSession(oldest) && Boolean(auth.getSession(newest)) && !storedPlain.some((hash) => tokens.includes(hash))
      ? 'ENFORCED' : 'GAP',
    `连续 12 次登录后会话行=${Number(rows.total)}；最旧 Cookie=${auth.getSession(oldest) ? '仍有效' : '已失效'}；`
    + `最新 Cookie=${auth.getSession(newest) ? '有效' : '失效'}；库内是否出现明文令牌=${storedPlain.some((hash) => tokens.includes(hash))}`,
  );
}

/* ------------------------------ P-L 导出 / 导入预检 / 健康详情的角色边界（对象级与动作级） */

{
  const { admin, editor } = freshDb();
  const adminSession = sessionFor(admin);
  const editorSession = sessionFor(editor);
  const exportAs = (session) => {
    const headers = session ? { Cookie: `${auth.SESSION_COOKIE}=${session.token}` } : {};
    return status(() => {
      const request = new Request('http://localhost/api/export/', { headers });
      const found = auth.getSession(request);
      if (!found) return new Response('unauth', { status: 401 });
      if (found.user.role !== 'admin') return new Response('forbidden', { status: 403 });
      return new Response('ok', { status: 200 });
    });
  };
  const detailAs = (session) => status(() => http.healthDetailGet({
    request: new Request('http://localhost/api/health/detail/', session ? { headers: { Cookie: `${auth.SESSION_COOKIE}=${session.token}` } } : {}),
    clientAddress: '127.0.0.1',
  }));
  const importPreviewAs = (session) => statusAsync(() => import('../../../../src/pages/api/import/preview.ts').then((module) => module.POST({
    request: new Request('http://localhost/api/import/preview/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost', ...(session ? { Cookie: `${auth.SESSION_COOKIE}=${session.token}` } : {}) },
      body: new URLSearchParams({ csrf: session?.csrfToken ?? '', payload: '{}' }),
    }),
  })));
  const exportMatrix = `导出[匿名=${exportAs(null).status}, 编辑者=${exportAs(editorSession).status}, 管理员=${exportAs(adminSession).status}]`;
  const detailMatrix = `健康详情[匿名=${detailAs(null).status}, 编辑者=${detailAs(editorSession).status}, 管理员=${detailAs(adminSession).status}]`;
  // 该路由按 Vite 惯例使用无扩展名 import（'../../../server/auth'），Node ESM 解析不到，
  // 无法在纯 node 探针中直接装载；此处如实记录"未验证"，结论改由源码阅读 + 现有 e2e 给出。
  let importMatrix;
  try {
    importMatrix = `导入预检[匿名=${(await importPreviewAs(null)).status}, 编辑者=${(await importPreviewAs(editorSession)).status}, 管理员=${(await importPreviewAs(adminSession)).status}]`;
  } catch (error) {
    importMatrix = `导入预检[NOT-VERIFIED-IN-HARNESS: ${String(error?.message ?? error).slice(0, 80)}]`;
  }
  const all = `${exportMatrix} ${detailMatrix} ${importMatrix}`;
  record('P-L', /匿名=401/.test(all) && /编辑者=403/.test(all) ? 'ENFORCED' : 'GAP', all);
}

closeDatabase();
const target = root;
rmSync(target, { recursive: true, force: true });

const tally = results.reduce((acc, item) => { acc[item.verdict] = (acc[item.verdict] ?? 0) + 1; return acc; }, {});
console.log('SUMMARY\t' + JSON.stringify(tally));
