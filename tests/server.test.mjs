import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

// All database access is redirected before importing the implementation.
const directory = mkdtempSync(join(tmpdir(), 'sanjiang-server-'));
let sequence = 0;
process.env.DATABASE_PATH = join(directory, 'bootstrap.sqlite');
delete process.env.SITE_URL;
const store = await import('../src/server/store.ts');
const { noticeBoard } = await import('../src/lib/notices.ts');
const settings = await import('../src/server/settings.ts');
const importer = await import('../src/lib/importer.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');
const auth = await import('../src/server/auth.ts');
const http = await import('../src/server/http.ts');
const { hashToken, hashPassword, verifyPassword } = await import('../src/server/security.ts');
const { withRequestCache } = await import('../src/server/request-cache.ts');
const PASSWORD = 'test-password-2026!';
let admin, editor;
beforeEach(() => {
  closeDatabase();
  process.env.DATABASE_PATH = join(directory, `${++sequence}.sqlite`);
  delete process.env.SITE_URL;
  admin = store.createInitialAdmin('operator', PASSWORD);
  editor = store.createUser(admin, 'editor', PASSWORD, 'editor');
});
after(() => {
  closeDatabase();
  const target = realpathSync(directory);
  assert.ok(target.startsWith(realpathSync(tmpdir()) + sep + 'sanjiang-server-'));
  assert.equal(target, resolve(directory));
  rmSync(target, { recursive: true, force: true });
});
function context(path, fields = {}, { token, origin = 'http://localhost', address = '127.0.0.1', headers = {} } = {}) {
  return { request: new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}), ...(token ? { Cookie: `${auth.SESSION_COOKIE}=${token}` } : {}), ...headers },
    body: new URLSearchParams(fields),
  }), clientAddress: address };
}
function directLogin(user = admin) {
  const outcome = auth.login(user.username, PASSWORD, `session-${user.id}-${Math.random().toString(36).slice(2)}`);
  // 这些用例都使用未启用双因素的账户且 TOTP_REQUIRED_FOR=off，因此必须是单步会话。
  if (outcome.kind !== 'session') throw new Error(`unexpected challenge: ${outcome.purpose}`);
  return outcome.token;
}
function session(user = admin) {
  const token = directLogin(user);
  const request = new Request('http://localhost/admin/', { headers: { Cookie: `${auth.SESSION_COOKIE}=${token}` } });
  return { token, request, ...auth.getSession(request) };
}
function manage(session, action, fields = {}, options = {}) {
  return http.managePost(context('/api/manage/', { csrf: session.csrfToken, action, ...fields }, { token: session.token, ...options }));
}
function draft(id = 'new-resource') { return { ...store.getPublishedResources()[0], id, title: 'Unpublished draft title' }; }

test('first boot seeds resources only once and never creates a default account', () => {
  closeDatabase(); process.env.DATABASE_PATH = join(directory, 'unseeded.sqlite');
  assert.equal(store.listUsers().length, 0);
  assert.ok(store.getPublishedResources().length > 0);
  assert.ok(store.listCategories().every((category) => category.id !== 'all'));
  database().prepare('DELETE FROM resources').run();
  closeDatabase();
  assert.equal(store.getPublishedResources().length, 0);
  assert.equal(store.listUsers().length, 0);
});

test('unauthorized management is rejected and form role cannot grant permission', async () => {
  const before = store.listManagedResources().length;
  const response = await http.managePost(context('/api/manage/', { action: 'save-resource', role: 'admin', resource: JSON.stringify(draft()) }));
  assert.equal(response.status, 401);
  assert.equal(store.listManagedResources().length, before);
  const editorSession = session(editor);
  for (const action of ['publish', 'unpublish', 'delete-resource']) {
    const response = await manage(editorSession, action, { id: 'zotero', version: '1', role: 'admin' });
    assert.equal(response.status, 403, action);
  }
  assert.equal((await manage(editorSession, 'save-category', { id: 'new', name: 'New' })).status, 403);
  assert.equal((await manage(editorSession, 'create-user', { username: 'attacker', password: PASSWORD, role: 'admin' })).status, 403);
  assert.equal((await manage(editorSession, 'update-user', { id: String(editor.id), role: 'admin', active: 'true' })).status, 403);
});

test('drafts and public snapshots are separate, including first save and withdrawal', async () => {
  const editorSession = session(editor);
  assert.equal((await manage(editorSession, 'save-resource', { resource: JSON.stringify(draft()), version: '' })).status, 303);
  assert.equal(store.findManagedResource('new-resource').published, null);
  assert.ok(!store.getPublishedResources().some((resource) => resource.id === 'new-resource'));
  const old = store.getPublishedResources().find((r) => r.id === 'zotero');
  store.saveResource(editor, { ...old, title: 'Secret updated title' }, 1);
  assert.equal(store.getPublishedResources().find((r) => r.id === 'zotero').title, old.title);
  store.changePublication(admin, 'zotero', 2, 'publish');
  assert.equal(store.getPublishedResources().find((r) => r.id === 'zotero').title, 'Secret updated title');
  store.changePublication(admin, 'zotero', 3, 'unpublish');
  assert.ok(!store.getPublishedResources().some((resource) => resource.id === 'zotero'));
  assert.equal(store.findManagedResource('zotero').draft.title, 'Secret updated title');
});

test('optimistic versions reject stale saves, stale publication, and resurrection', async () => {
  const current = store.findManagedResource('zotero');
  store.saveResource(editor, { ...current.draft, title: 'First update' }, 1);
  const response = await manage(session(editor), 'save-resource', { resource: JSON.stringify({ ...current.draft, title: 'My unsaved update </textarea><script>alert(1)</script>' }), version: '1' });
  assert.equal(response.status, 409);
  const body = await response.text();
  assert.match(body, /My unsaved update/);
  assert.ok(!body.includes('</textarea><script>'));
  assert.equal(store.findManagedResource('zotero').draft.title, 'First update');
  assert.throws(() => store.changePublication(admin, 'zotero', 1, 'publish'), /其他维护者/);
  assert.throws(() => store.saveResource(editor, current.draft, null), /版本号/);
  store.changePublication(admin, 'zotero', 2, 'delete-resource');
  assert.throws(() => store.saveResource(editor, current.draft, 2), /回收站|已被删除/);
});

test('categories cannot be deleted while referenced by draft or snapshot', () => {
  store.saveCategory(admin, 'temporary', 'Temporary');
  const item = store.findManagedResource('zotero');
  store.saveResource(editor, { ...item.draft, category: 'temporary' }, item.version);
  assert.throws(() => store.deleteCategory(admin, 'temporary'), /引用/);
  store.changePublication(admin, 'zotero', 2, 'publish');
  store.saveResource(editor, item.draft, 3);
  assert.throws(() => store.deleteCategory(admin, 'temporary'), /引用/);
  store.changePublication(admin, 'zotero', 4, 'unpublish');
  store.deleteCategory(admin, 'temporary');
  assert.ok(!store.listCategories().some((c) => c.id === 'temporary'));
  assert.throws(() => store.saveCategory(admin, 'all', 'Reserved'), /保留/);
});

const userVersion = (id) => store.listUsers().find((entry) => entry.id === id).version;

test('disabling, resetting passwords, and role changes revoke existing sessions', () => {
  let logged = session(editor);
  store.updateUser(admin, editor.id, userVersion(editor.id), 'editor', false);
  assert.equal(auth.getSession(logged.request), undefined);
  assert.throws(() => auth.login('editor', PASSWORD, 'disabled-login'), /密码错误/);
  store.updateUser(admin, editor.id, userVersion(editor.id), 'editor', true);
  logged = session(editor);
  store.updateUser(admin, editor.id, userVersion(editor.id), 'admin', true);
  assert.equal(auth.getSession(logged.request), undefined);
  logged = session(editor);
  store.updateUser(admin, editor.id, userVersion(editor.id), 'editor', true, 'new-test-password!');
  assert.equal(auth.getSession(logged.request), undefined);
  assert.throws(() => auth.login('editor', PASSWORD, 'reset-login'), /密码错误/);
  assert.ok(auth.login('editor', 'new-test-password!', 'reset-login'));
});

test('stale user forms cannot overwrite a newer deactivation or role change', async () => {
  const stale = store.listUsers().find((entry) => entry.id === editor.id);
  const response = await manage(session(admin), 'update-user', {
    id: String(editor.id), version: String(stale.version), role: 'editor', active: '', password: '',
  });
  assert.equal(response.status, 303);
  const disabled = store.listUsers().find((entry) => entry.id === editor.id);
  assert.equal(disabled.active, false);
  const staleResponse = await manage(session(admin), 'update-user', {
    id: String(editor.id), version: String(stale.version), role: 'editor', active: 'true', password: '',
  });
  assert.equal(staleResponse.status, 409);
  assert.match(await staleResponse.text(), /重新加载人员与权限页面/);
  assert.equal(store.listUsers().find((entry) => entry.id === editor.id).active, false, '旧表单不能重新启用账户');
  const fresh = store.listUsers().find((entry) => entry.id === editor.id);
  assert.equal((await manage(session(admin), 'update-user', {
    id: String(editor.id), version: String(fresh.version), role: 'editor', active: 'true', password: '',
  })).status, 303);
  assert.equal(store.listUsers().find((entry) => entry.id === editor.id).active, true);
});

test('a sole administrator can reset their own password and old sessions are revoked', () => {
  const logged = session(admin);
  store.updateUser(admin, admin.id, userVersion(admin.id), 'admin', true, 'replacement-password-2026!');
  assert.equal(auth.getSession(logged.request), undefined, '改密后旧会话立即失效');
  assert.throws(() => auth.login('operator', PASSWORD, 'self-reset-old'), /密码错误/);
  assert.ok(auth.login('operator', 'replacement-password-2026!', 'self-reset-new'));
});

test('cannot deactivate, demote, or delete the last active administrator', () => {
  assert.throws(() => store.updateUser(admin, admin.id, userVersion(admin.id), 'admin', false), /最后一位/);
  assert.throws(() => store.updateUser(admin, admin.id, userVersion(admin.id), 'editor', true), /最后一位/);
  assert.throws(() => store.deleteUser(admin, admin.id), /最后一位/);
  const second = store.createUser(admin, 'second-admin', PASSWORD, 'admin');
  store.updateUser(admin, second.id, userVersion(second.id), 'admin', false);
  assert.throws(() => store.deleteUser(admin, admin.id), /最后一位/);
  assert.ok(store.listUsers().find((u) => u.id === admin.id).active);
});

test('management and logout require both same Origin and a session-bound CSRF token', async () => {
  const logged = session();
  assert.equal((await manage(logged, 'save-category', { id: 'safe', name: 'Safe', csrf: '' })).status, 403);
  assert.equal((await manage(logged, 'save-category', { id: 'safe', name: 'Safe' }, { origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await manage(logged, 'save-category', { id: 'safe', name: 'Safe' }, { origin: null })).status, 403);
  const other = session(editor);
  assert.equal((await manage(logged, 'save-category', { id: 'safe', name: 'Safe', csrf: other.csrfToken })).status, 403);
  assert.equal((await manage(logged, 'save-category', { id: 'safe', name: 'Safe' })).status, 303);
  assert.equal((await http.logoutPost(context('/api/logout/', { csrf: '' }, { token: logged.token }))).status, 403);
  assert.equal((await http.logoutPost(context('/api/logout/', { csrf: logged.csrfToken }, { token: logged.token }))).status, 303);
  assert.equal(auth.getSession(logged.request), undefined);
});

test('session cookies are secure, expire, and database only contains hashes', () => {
  const logged = session();
  const row = database().prepare('SELECT * FROM sessions WHERE token_hash=?').get(hashToken(logged.token));
  assert.ok(row);
  assert.ok(!JSON.stringify(row).includes(logged.token));
  assert.equal(Object.hasOwn(row, 'csrf_token'), false);
  assert.match(auth.sessionCookie(logged.token), /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(auth.sessionCookie(logged.token, false, false), /; Secure/);
  assert.match(auth.sessionCookie(logged.token, false, true), /; Secure$/);
  database().prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal(auth.getSession(logged.request), undefined);
  const stored = database().prepare('SELECT password_hash FROM users WHERE id=?').get(admin.id).password_hash;
  assert.ok(!stored.includes(PASSWORD));
  assert.ok(verifyPassword(PASSWORD, stored));
  assert.notEqual(hashPassword(PASSWORD), hashPassword(PASSWORD));
});

test('login works as a normal form; origin and persistent limits apply; XFF is not trusted', async () => {
  const response = await http.loginPost(context('/api/login/', { username: 'operator', password: PASSWORD }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin/');
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await http.loginPost(context('/api/login/', { username: 'operator', password: PASSWORD }, { origin: 'https://other.invalid' }))).status, 403);
  for (let index = 0; index < 10; index++) {
    assert.equal((await http.loginPost(context('/api/login/', { username: 'missing-user', password: 'wrong' }, { address: 'limited-ip', headers: { 'X-Forwarded-For': `spoof-${index}` } }))).status, 401);
  }
  closeDatabase();
  assert.equal((await http.loginPost(context('/api/login/', { username: 'missing-user', password: 'wrong' }, { address: 'another-ip' }))).status, 429);
});

test('anonymous feedback is persisted, handled by maintainers, and receipt exposes no ID', async () => {
  const response = await http.reportsPost(context('/api/reports/', { kind: 'broken-link', title: '链接问题', body: '这是超过十个字符的反馈说明内容', resourceId: 'zotero', website: '' }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /^\/feedback\/\?sent=[A-Za-z0-9_-]{43}$/);
  const report = store.listReports()[0];
  assert.equal(report.resourceId, 'zotero'); assert.equal(report.status, 'new');
  assert.equal((await manage(session(editor), 'update-report', { id: String(report.id), status: 'resolved', note: '已处理', version: String(report.version) })).status, 303);
  assert.equal(store.listReports()[0].note, '已处理');
  assert.equal((await http.reportsPost(context('/api/reports/', { kind: 'general', title: '一般反馈', body: '另一个长度足够的一般反馈说明' }, { address: 'general-ip' }))).status, 303);
  assert.equal(store.listReports()[0].resourceId, null);
});

test('feedback blocks cross-origin, short bodies, drafts, and honeypots; rate limits persist', async () => {
  const fields = { kind: 'general', title: '反馈', body: '这是长度足够的反馈说明内容' };
  assert.equal((await http.reportsPost(context('/api/reports/', fields, { origin: 'https://other.invalid' }))).status, 403);
  assert.equal((await http.reportsPost(context('/api/reports/', { ...fields, body: '短' }, { address: 'short-ip' }))).status, 400);
  store.saveResource(editor, draft(), null);
  assert.equal((await http.reportsPost(context('/api/reports/', { ...fields, resourceId: 'new-resource' }, { address: 'draft-ip' }))).status, 400);
  assert.equal((await http.reportsPost(context('/api/reports/', { ...fields, website: 'https://spam.invalid' }, { address: 'bot-ip' }))).status, 303);
  assert.equal(store.listReports().length, 0);
  for (let index = 0; index < 5; index++) assert.equal((await http.reportsPost(context('/api/reports/', fields, { address: 'report-limit', headers: { 'X-Forwarded-For': `fake-${index}` } }))).status, 303);
  closeDatabase();
  assert.equal((await http.reportsPost(context('/api/reports/', fields, { address: 'spoofed-client-address', headers: { 'X-Forwarded-For': 'different-spoofed-address' } }))).status, 429);
  assert.equal(store.listReports().length, 5);
});

test('SQL-shaped inputs remain data and malformed identifiers are rejected', () => {
  const injection = "x'); DROP TABLE users; --";
  store.createReport({ kind: 'general', title: injection, body: injection.repeat(2) });
  assert.equal(store.listReports()[0].title, injection);
  store.saveCategory(admin, 'sql-safe', injection);
  assert.equal(store.listCategories().find((c) => c.id === 'sql-safe').name, injection);
  assert.equal(store.findManagedResource("zotero' OR 1=1 --"), undefined);
  assert.throws(() => store.createUser(admin, injection, PASSWORD, 'admin'), /用户名/);
  assert.throws(() => store.saveResource(editor, { ...draft(), id: injection }, null), /校验失败/);
  assert.equal(store.listUsers().length, 2);
});

test('audit entries commit together with changes and failed operations leave no audit entry', () => {
  const baseline = store.listAudit().length;
  store.saveCategory(admin, 'audited', 'Audited');
  assert.equal(store.listAudit().length, baseline + 1);
  assert.equal(store.listAudit()[0].actor, 'operator');
  database().exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN NEW.action='save-category' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
  assert.throws(() => store.saveCategory(admin, 'rollback', 'Rollback'), /test audit failure/);
  assert.ok(!store.listCategories().some((c) => c.id === 'rollback'));
  assert.equal(store.listAudit().length, baseline + 1);
});

test('expired sessions and invalid CSRF preserve the submitted unsaved draft', async () => {
  const logged = session(editor);
  const resource = JSON.stringify(draft());
  let response = await manage(logged, 'save-resource', { resource, version: '', csrf: 'invalid' });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Unpublished draft title/);
  database().prepare('DELETE FROM sessions').run();
  response = await manage(logged, 'save-resource', { resource, version: '' });
  assert.equal(response.status, 401);
  assert.match(await response.text(), /Unpublished draft title/);
  assert.equal(store.findManagedResource('new-resource'), undefined);
});

test('administrator CLI requires explicit credentials and uses only its selected database', () => {
  const path = join(directory, 'cli.sqlite');
  const environment = { ...process.env, DATABASE_PATH: path };
  delete environment.ADMIN_USERNAME; delete environment.ADMIN_PASSWORD;
  let result = spawnSync(process.execPath, ['scripts/create-admin.mjs'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_USERNAME/);
  result = spawnSync(process.execPath, ['scripts/create-admin.mjs'], { env: { ...environment, ADMIN_USERNAME: 'cli-admin', ADMIN_PASSWORD: PASSWORD }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cli-admin/);
  assert.ok(!result.stdout.includes(PASSWORD));
  assert.equal(store.listUsers().length, 2);
  closeDatabase(); process.env.DATABASE_PATH = path;
  assert.equal(store.listUsers()[0].username, 'cli-admin');
  assert.ok(auth.login('cli-admin', PASSWORD, 'cli-login'));
});

test('form input limits, JSON errors, configured Origin, and health expose minimal information', async () => {
  const logged = session();
  const response = await manage(logged, 'save-resource', { resource: 'x'.repeat(100 * 1024) }, { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 413);
  assert.equal(typeof (await response.json()).error, 'string');
  process.env.SITE_URL = 'https://resources.example.invalid';
  assert.equal((await manage(logged, 'save-category', { id: 'blocked', name: 'Blocked' })).status, 403);
  const health = http.healthGet();
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.db, 'ok');
  assert.match(String(healthBody.schema), /^0\d{2}-[a-z0-9-]+$/);
  assert.equal(typeof healthBody.uptime, 'number');
  assert.equal(health.headers.get('cache-control'), 'no-store');
});

function guideInput(overrides = {}) {
  return { slug: 'first-guide', title: '第一篇指南', summary: '用 **Markdown** 写的摘要', body: '## 先看条件\n\n- 费用\n- 资格\n\n见 [Zotero](https://www.zotero.org/)。', resources: ['zotero'], ...overrides };
}

test('guides stay private as drafts, publish as snapshots, and reject stale versions', () => {
  const input = guideInput();
  const saved = store.saveGuide(editor, input, null);
  assert.equal(saved.version, 1);
  assert.equal(store.getPublishedGuides().length, 0, '草稿不应公开');

  const published = store.changeGuidePublication(admin, 'first-guide', saved.version, 'publish-guide');
  assert.equal(published, undefined);
  assert.equal(store.getPublishedGuides().length, 1);
  assert.match(store.getPublishedGuides()[0].body, /先看条件/);

  const changed = store.saveGuide(editor, guideInput({ title: '改过的标题' }), store.findManagedGuide('first-guide')?.version ?? null);
  assert.equal(store.getPublishedGuides()[0].title, '第一篇指南', '发布快照不应被草稿覆盖');
  assert.throws(() => store.changeGuidePublication(admin, 'first-guide', saved.version, 'unpublish-guide'), /其他维护者修改/);
  const current = store.findManagedGuide('first-guide');
  assert.equal(current?.draft.title, '改过的标题');
  assert.equal(current?.version, changed.version);
});

test('editors may save guides but not publish or delete them', () => {
  const saved = store.saveGuide(editor, guideInput({ slug: 'editor-guide' }), null);
  assert.throws(() => store.changeGuidePublication(editor, 'editor-guide', saved.version, 'publish-guide'), /仅限管理员/);
  assert.throws(() => store.changeGuidePublication(editor, 'editor-guide', saved.version, 'delete-guide'), /仅限管理员/);
  assert.equal(store.findManagedGuide('editor-guide')?.published, null);
});

test('guide validation rejects bad slugs and unknown resources', () => {
  assert.throws(() => store.saveGuide(admin, guideInput({ slug: 'Bad Slug' }), null), /校验失败/);
  assert.throws(() => store.saveGuide(admin, guideInput({ slug: 'unknown-link', resources: ['missing-resource'] }), null), /资源不存在/);
  assert.throws(() => store.saveGuide(admin, guideInput({ body: '' }), null), /校验失败/);
});

test('markdown preview requires a session and escapes raw HTML', async () => {
  const logged = session(admin);
  const response = await http.previewPost(context('/api/preview/', { csrf: logged.csrfToken, mode: 'block', text: '<script>alert(1)</script>\n\n**粗体**' }, { token: logged.token }));
  assert.equal(response.status, 200);
  const { html } = await response.json();
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.doesNotMatch(html, /<script/i);
  assert.equal((await http.previewPost(context('/api/preview/', { mode: 'block', text: 'x' }))).status, 401);
  assert.equal((await http.previewPost(context('/api/preview/', { csrf: 'wrong', mode: 'block', text: 'x' }, { token: logged.token }))).status, 403);
});

test('revisions capture saves, publications, restores, and keep a bounded history', () => {
  const first = store.saveResource(admin, { ...seedResource('rev-tool'), summary: '第一版简介' }, null);
  let history = store.listRevisions('resource', first.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.action, 'save');
  assert.equal(history[0]?.version, 1);

  const second = store.saveResource(admin, { ...seedResource('rev-tool'), summary: '第二版简介' }, first.version);
  store.changePublication(admin, 'rev-tool', second.version, 'publish');
  history = store.listRevisions('resource', 'rev-tool');
  assert.deepEqual(history.map((entry) => entry.action), ['publish', 'save', 'save']);

  const restored = store.restoreResourceRevision(admin, 'rev-tool', history[2]?.id ?? 0, store.findManagedResource('rev-tool')?.version ?? null);
  assert.equal(restored.draft.summary, '第一版简介');
  assert.equal(store.getPublishedResources().find((item) => item.id === 'rev-tool')?.summary, '第二版简介', '恢复不能改动已发布快照');
  assert.equal(store.listRevisions('resource', 'rev-tool')[0]?.action, 'restore');

  assert.throws(() => store.restoreResourceRevision(admin, 'rev-tool', history[0]?.id ?? 0, 1), /重新加载/);
  assert.throws(() => store.restoreResourceRevision(admin, 'rev-tool', 999999, restored.version), /版本记录不存在/);

  const base = store.saveGuide(editor, guideInput({ slug: 'rev-guide' }), null);
  store.restoreGuideRevision(editor, 'rev-guide', store.listRevisions('guide', 'rev-guide')[0]?.id ?? 0, base.version);
  assert.equal(store.listRevisions('guide', 'rev-guide')[0]?.action, 'restore');

  let version = store.findManagedResource('rev-tool')?.version ?? 0;
  for (let index = 0; index < 55; index++) {
    const saved = store.saveResource(admin, { ...seedResource('rev-tool'), summary: `循环 ${index}` }, version);
    version = saved.version;
  }
  assert.equal(store.listRevisions('resource', 'rev-tool', 100).length, 50, '版本历史应有上限');
});

function seedResource(id) {
  return {
    id, title: '版本测试资源', summary: '简介', category: 'writing', kind: '开源工具', cost: '免费',
    platforms: ['网页'], tags: ['测试'], url: 'https://example.com/', sourceUrl: 'https://example.com/about',
    license: '测试许可', eligibility: '测试资格', caveat: '测试限制', steps: ['第一步'], status: 'review', checkedAt: null,
  };
}

test('anonymous metrics accept only allow-listed events and aggregate counters', async () => {
  const post = (body, headers = {}) => http.eventPost({ request: new Request('http://localhost/api/event/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...headers }, body: JSON.stringify(body) }), clientAddress: '127.0.0.1' });
  assert.equal((await post({ name: 'resource_view', target: 'zotero' })).status, 200);
  assert.equal((await post({ name: 'resource_view', target: 'zotero' })).status, 200);
  assert.equal((await post({ name: 'outbound_click', target: 'zotero' })).status, 200);
  assert.equal((await post({ name: 'search_miss', target: '找不到的工具' })).status, 200);
  assert.equal((await post({ name: 'made_up', target: 'x' })).status, 400);
  assert.equal((await post({ name: 'resource_view', target: 'x'.repeat(200) })).status, 400);
  assert.equal((await post({ name: 'resource_view', target: 'zotero' }, { Origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await http.eventPost({ request: new Request('http://localhost/api/event/', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'http://localhost' }, body: 'x' }), clientAddress: '127.0.0.1' })).status, 415);
  assert.equal((await http.eventPost({ request: new Request('http://localhost/api/event/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"resource_view","target":"zotero"}' }), clientAddress: '127.0.0.1' })).status, 403, '缺少来源的请求被拒绝');

  const summary = store.metricsSummary(30);
  assert.equal(summary.totals.resource_view, 2);
  assert.equal(summary.totals.outbound_click, 1);
  assert.equal(summary.totals.search_miss, 1);
  assert.equal(summary.rows.find((row) => row.name === 'resource_view' && row.target === 'zotero')?.total, 2);
});

test('health endpoint reports database availability', async () => {
  const response = http.healthGet();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'ok');
  closeDatabase();
  const blocked = join(directory, 'blocked.sqlite');
  mkdirSync(blocked, { recursive: true });
  process.env.DATABASE_PATH = blocked;
  closeDatabase();
  assert.equal(http.healthGet().status, 503, '数据库不可用时健康检查必须失败');
});

test('soft delete moves content to trash, restore keeps it a draft, purge removes history', () => {
  const before = store.findManagedResource('zotero');
  store.changePublication(admin, 'zotero', before.version, 'delete-resource');
  assert.equal(store.getPublishedResources().some((item) => item.id === 'zotero'), false);
  assert.equal(store.listManagedResources().some((item) => item.id === 'zotero'), false);
  assert.ok(store.listDeletedResources().some((item) => item.id === 'zotero'));
  const trashed = store.findManagedResource('zotero');
  assert.ok(trashed.deletedAt);
  assert.equal(trashed.published, null);
  assert.throws(() => store.changePublication(editor, 'zotero', trashed.version, 'delete-resource'), /回收站|已被删除|仅限管理员/);

  store.restoreTrashResource(admin, 'zotero');
  const restored = store.findManagedResource('zotero');
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.published, null, '恢复后应回到草稿状态');
  assert.equal(store.listDeletedResources().length, 0);
  assert.throws(() => store.restoreTrashResource(editor, 'zotero'), /仅限管理员|回收站/);

  store.changePublication(admin, 'zotero', restored.version, 'delete-resource');
  store.purgeTrashResource(admin, 'zotero');
  assert.equal(store.findManagedResource('zotero'), undefined);
  assert.equal(store.listRevisions('resource', 'zotero').length, 0);
});

test('purging a resource is blocked while a guide draft or published snapshot references it', () => {
  const guide = store.saveGuide(editor, guideInput({ slug: 'ref-guide', resources: ['python'] }), null);
  store.changeGuidePublication(admin, 'ref-guide', guide.version, 'publish-guide');
  const python = store.findManagedResource('python');
  store.changePublication(admin, 'python', python.version, 'delete-resource');
  assert.throws(() => store.purgeTrashResource(admin, 'python'), /ref-guide|仍被这些指南引用/);
  assert.ok(store.findManagedResource('python'), '有引用时不能彻底删除');

  const current = store.findManagedGuide('ref-guide');
  const saved = store.saveGuide(editor, { ...current.draft, resources: [] }, current.version);
  assert.throws(() => store.purgeTrashResource(admin, 'python'), /公开版本/, '只改草稿仍不能消除公开快照里的引用');
  store.changeGuidePublication(admin, 'ref-guide', saved.version, 'publish-guide');
  store.purgeTrashResource(admin, 'python');
  assert.equal(store.findManagedResource('python'), undefined, '解除草稿和公开版本引用后才允许彻底删除');
});

test('an existing dangling guide association requires explicit removal on save', () => {
  const saved = store.saveGuide(editor, guideInput({ slug: 'dangling-guide', resources: ['python'] }), null);
  // Simulate data left behind by an older purge path; the new purge guard prevents creating this state.
  database().prepare('DELETE FROM resources WHERE id=?').run('python');
  const current = store.findManagedGuide('dangling-guide');
  assert.throws(() => store.saveGuide(editor, { ...current.draft, resources: [] }, current.version), /已被彻底删除|失效关联/);
  assert.deepEqual(store.findManagedGuide('dangling-guide').draft.resources, ['python'], '普通保存不能静默清空悬空关联');
  const cleaned = store.saveGuide(editor, { ...current.draft, resources: [] }, saved.version, true);
  assert.deepEqual(cleaned.draft.resources, [], '只有显式同意后才移除失效关联');
});

test('announcements keep text but stop linking after withdraw, soft delete, or purge', () => {
  const body = '这条公告的正文应继续公开，即使关联资源已经下架。';
  store.createReport({ resourceId: 'zotero', kind: '信息有误', title: '公告来源反馈', body: '这是一条用于公告测试的反馈正文。' });
  const report = store.listReports()[0];
  store.updateReport(admin, report.id, 'resolved', '', null, report.version, { title: '资源变化公告', body });
  let item = store.listAnnouncements()[0];
  assert.equal(item.resourceId, 'zotero');
  assert.equal(item.resourceRemoved, false);

  store.discontinueResource(admin, 'zotero', store.findManagedResource('zotero').version, null, '暂时停止展示');
  item = store.listAnnouncements()[0];
  assert.equal(item.resourceId, 'zotero', '停用资源仍有解释页，公告可以继续链接');
  assert.equal(item.resourceRemoved, false);

  store.changePublication(admin, 'zotero', store.findManagedResource('zotero').version, 'unpublish');
  item = store.listAnnouncements()[0];
  assert.equal(item.resourceId, null);
  assert.equal(item.resourceRemoved, true);
  assert.equal(item.body, body, '撤回后保留公告正文');

  store.changePublication(admin, 'zotero', store.findManagedResource('zotero').version, 'publish');
  assert.equal(store.listAnnouncements()[0].resourceId, 'zotero');
  store.changePublication(admin, 'zotero', store.findManagedResource('zotero').version, 'delete-resource');
  item = store.listAnnouncements()[0];
  assert.equal(item.resourceId, null);
  assert.equal(item.resourceRemoved, true, '软删除后不输出 404 链接');

  store.restoreTrashResource(admin, 'zotero');
  store.changePublication(admin, 'zotero', store.findManagedResource('zotero').version, 'publish');
  store.changePublication(admin, 'zotero', store.findManagedResource('zotero').version, 'delete-resource');
  store.purgeTrashResource(admin, 'zotero');
  item = store.listAnnouncements()[0];
  assert.equal(item.resourceId, null);
  assert.equal(item.resourceRemoved, true, '彻底删除后不输出 404 链接');
  assert.equal(item.title, '资源变化公告');
});

test('feedback can link to a revision of its own resource only', () => {
  const current = store.findManagedResource('zotero');
  store.saveResource(admin, { ...current.draft, title: '反馈修复版本' }, current.version);
  const revision = store.listRevisions('resource', 'zotero')[0];
  assert.ok(revision);
  store.createReport({ resourceId: 'zotero', kind: '信息有误', title: '反馈标题', body: '这是至少十个字符的反馈内容。' });
  const report = store.listReports()[0];
  store.updateReport(editor, report?.id ?? 0, 'resolved', '已按修订处理', revision?.id ?? 0, report?.version ?? null);
  const linked = store.listReports()[0];
  assert.equal(linked?.revisionId, revision?.id);
  assert.equal(linked?.status, 'resolved');

  const python = store.findManagedResource('python');
  store.saveResource(admin, { ...python.draft, title: '别的资源' }, python.version);
  const foreign = store.listRevisions('resource', 'python')[0];
  const linkedVersion = store.listReports()[0].version;
  assert.throws(() => store.updateReport(editor, report?.id ?? 0, 'resolved', '错链', foreign?.id ?? 0, linkedVersion), /不属于/);

  store.createReport({ kind: '其他建议', title: '无资源反馈', body: '这是一条没有关联资源的反馈内容。' });
  const general = store.listReports()[0];
  assert.throws(() => store.updateReport(editor, general?.id ?? 0, 'resolved', 'x', revision?.id ?? 0, general?.version ?? null), /没有关联资源/);
});

test('notice board summarises new feedback and overdue resources', () => {
  store.createReport({ resourceId: 'zotero', kind: '链接失效', title: '新反馈一', body: '这是一条新的反馈内容，长度足够。' });
  const stale = { ...store.findManagedResource('python').draft, status: 'verified', checkedAt: '2025-01-01' };
  store.saveResource(admin, stale, store.findManagedResource('python').version);
  const board = noticeBoard();
  assert.ok(board.newReports >= 1);
  assert.ok(board.overdueResources >= 1);
  assert.ok(board.items.some((item) => item.href === '/admin/reviews/'));
});

test('manual link check stores the result without changing publication', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    const logged = session(admin);
    const base = { ...store.findManagedResource('zotero').draft, id: 'link-test', title: '链接检查示例', url: 'https://93.184.216.34/', sourceUrl: 'https://93.184.216.34/about' };
    store.saveResource(admin, base, null);
    const publishedBefore = store.getPublishedResources().length;
    const response = await manage(logged, 'check-link', { id: 'link-test' });
    assert.equal(response.status, 303);
    const check = store.listLinkChecks().find((item) => item.resourceId === 'link-test');
    assert.equal(check?.status, 'ok');
    assert.equal(store.getPublishedResources().length, publishedBefore, '检查不应改变发布状态');
  } finally { globalThis.fetch = original; }
});

test('home settings are admin-only, validated and merged with defaults', () => {
  const defaults = settings.getSettings();
  assert.equal(defaults.featuredResourceId, 'zotero');
  assert.equal(defaults.scenarios.writing?.task, '写好一篇报告');
  assert.throws(() => settings.saveSettings(editor, { featuredResourceId: 'python', scenarios: {} }), /仅限管理员/);
  settings.saveSettings(admin, { featuredResourceId: 'python', scenarios: { writing: { task: '写课程论文', detail: '从选题到引用', glyph: '文' } } });
  const saved = settings.getSettings();
  assert.equal(saved.featuredResourceId, 'python');
  assert.equal(saved.scenarios.writing?.task, '写课程论文');
  assert.equal(saved.scenarios.development?.task, '开始写代码', '未填写的场景保留默认');
  assert.throws(() => settings.saveSettings(admin, { featuredResourceId: 'missing', scenarios: {} }), /不存在/);
  assert.throws(() => settings.saveSettings(admin, { featuredResourceId: 'zotero', scenarios: { nope: { task: 'x', detail: '', glyph: 'x' } } }), /分类不存在/);

  const draftResource = store.saveResource(editor, draft('featured-draft'), null);
  assert.throws(() => settings.saveSettings(admin, { featuredResourceId: draftResource.id, scenarios: {} }), /公开目录/, '草稿不能成为精选');
  store.discontinueResource(admin, 'python', store.findManagedResource('python').version, null, '暂时停止展示');
  assert.throws(() => settings.saveSettings(admin, { featuredResourceId: 'python', scenarios: {} }), /公开目录|已停用/, '停用资源不能成为精选');
  settings.saveSettings(admin, { featuredResourceId: 'zotero', scenarios: {} });
  assert.equal(settings.getSettings().featuredResourceId, 'zotero', '正常精选仍能保存');
});

test('batch review updates drafts and history for editors', () => {
  const seen = (id) => ({ id, version: store.findManagedResource(id).version });
  const result = store.bulkReviewResources(editor, [seen('inkscape'), seen('smart-education')], 'verified', '2026-10-20');
  assert.equal(result.updated, 2);
  const inkscape = store.findManagedResource('inkscape');
  assert.equal(inkscape?.draft.status, 'verified');
  assert.equal(inkscape?.draft.checkedAt, '2026-10-20');
  assert.equal(store.listRevisions('resource', 'inkscape')[0]?.action, 'save');
  assert.equal(store.getPublishedResources().find((item) => item.id === 'inkscape')?.status, 'review', '批量复核不改公开快照');
  store.bulkReviewResources(editor, [seen('inkscape')], 'review', null);
  assert.equal(store.findManagedResource('inkscape')?.draft.checkedAt, null);
  assert.throws(() => store.bulkReviewResources(editor, [], 'verified', '2026-10-20'), /选择/);
  assert.throws(() => store.bulkReviewResources(editor, [seen('inkscape')], 'verified', 'not-a-date'), /日期/);
  assert.throws(() => store.bulkReviewResources(editor, [{ id: 'inkscape' }], 'verified', '2026-10-20'), /版本号/);
});

test('batch review never approves content changed after the page was rendered', () => {
  const before = store.findManagedResource('inkscape');
  const seenVersion = before.version;
  // 编辑者在管理员打开队列之后改了链接并保存
  store.saveResource(editor, { ...before.draft, url: 'https://example.org/changed' }, before.version);
  const result = store.bulkReviewResources(admin, [{ id: 'inkscape', version: seenVersion }], 'verified', '2026-10-20');
  assert.equal(result.updated, 0);
  assert.deepEqual(result.changed, ['inkscape']);
  const after = store.findManagedResource('inkscape');
  assert.equal(after.draft.status, 'review', '没看过的新内容不能被标成已核对');
  assert.equal(after.draft.url, 'https://example.org/changed');
});

test('import preview and apply restore drafts, categories and guides', () => {
  const base = store.findManagedResource('zotero')?.draft;
  assert.ok(base);
  const payload = {
    schemaVersion: 1,
    categories: [{ id: 'career', name: '求职实习' }],
    resources: [{ ...base, id: 'import-tool', title: '导入工具', category: 'career' }],
    guides: [{ slug: 'import-guide', title: '导入指南', summary: '', body: '## 正文\n\n内容。', resources: ['import-tool'] }],
  };
  const preview = importer.previewImport(payload);
  assert.deepEqual(preview.categories.create, ['career']);
  assert.deepEqual(preview.resources.create, ['import-tool']);
  assert.deepEqual(preview.guides.create, ['import-guide']);
  const invalid = importer.previewImport({ resources: [{ id: 'Bad Slug' }] });
  assert.equal(invalid.resources.invalid.length, 1);

  assert.throws(() => importer.applyImport(editor, payload, preview.plan), /管理员/);
  // 没有预检计划就不允许应用：等于跳过"确认后才写库"这一步。
  assert.throws(() => importer.applyImport(admin, payload), /预检/);
  const applied = importer.applyImport(admin, payload, preview.plan);
  assert.equal(applied.resources, 1);
  assert.equal(applied.guides, 1);
  assert.equal(applied.categoriesCreated, 1);
  assert.equal(store.findManagedResource('import-tool')?.draft.title, '导入工具');
  assert.equal(store.findManagedGuide('import-guide')?.draft.title, '导入指南');

  const exported = importer.exportPayload();
  assert.ok(Array.isArray(exported.resources) && exported.resources.length > 12);
  assert.ok(exported.categories.some((category) => category.id === 'career'));
  assert.equal(exported.schemaVersion, 2, '导出升到 v2：包含媒体元数据（不含二进制）');
  assert.ok(Array.isArray(exported.media), '导出必须带媒体清单字段');
});

test('request-scoped reads reuse results and publication invalidates them immediately', () => {
  withRequestCache(() => {
    assert.equal(store.listCategories(), store.listCategories());
    assert.equal(store.getPublishedResources(), store.getPublishedResources());
    const resource = store.getPublishedResources()[0];
    assert.equal(store.findPublishedResource(resource.id), store.findPublishedResource(resource.id));
    const current = store.findManagedResource(resource.id);
    store.saveResource(admin, { ...current.draft, title: '发布后的新标题' }, current.version);
    assert.notEqual(store.findPublishedResource(resource.id).title, '发布后的新标题');
    store.changePublication(admin, resource.id, store.findManagedResource(resource.id).version, 'publish');
    assert.equal(store.findPublishedResource(resource.id).title, '发布后的新标题');
    store.changePublication(admin, resource.id, store.findManagedResource(resource.id).version, 'delete-resource');
    assert.equal(store.findPublishedResource(resource.id), undefined);
    store.saveGuide(admin, { slug: 'lookup-guide', title: '测试指南', summary: '', body: '正文', resources: [] }, null);
    assert.equal(store.findPublishedGuide('lookup-guide'), undefined);
    store.changeGuidePublication(admin, 'lookup-guide', store.findManagedGuide('lookup-guide').version, 'publish-guide');
    assert.equal(store.findPublishedGuide('lookup-guide').title, '测试指南');
  });
});

test('metrics retention is handled by maintenance, preserving the exact 90-day boundary', () => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  database().prepare('INSERT INTO events (day,name,target,count) VALUES (?,?,?,1)').run('2000-01-01', 'resource_view', 'old');
  database().prepare('INSERT INTO events (day,name,target,count) VALUES (?,?,?,1)').run(cutoff, 'resource_view', 'boundary');
  store.recordEvent('resource_view', 'zotero');
  assert.ok(database().prepare("SELECT 1 FROM events WHERE target='old'").get(), '浏览请求不执行历史清理');
  assert.equal(store.pruneEvents(now), 1);
  assert.ok(database().prepare("SELECT 1 FROM events WHERE target='boundary'").get());
  assert.ok(database().prepare("SELECT 1 FROM events WHERE target='zotero'").get());
});

test('client identity only trusts a single proxy-written address', async () => {
  const { clientIdentity } = await import('../src/server/security.ts');
  const request = (xff) => new Request('http://localhost/', { headers: xff === null ? {} : { 'X-Forwarded-For': xff } });
  const original = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(clientIdentity(request('203.0.113.5'), '10.0.0.1'), 'unverified-peer', '未声明可信代理时忽略转发头');
    assert.equal(clientIdentity(request(null), '10.0.0.1'), '10.0.0.1');
    process.env.TRUST_PROXY = '1';
    assert.equal(clientIdentity(request('203.0.113.5'), '10.0.0.1'), '203.0.113.5');
    assert.equal(clientIdentity(request('203.0.113.5, 10.0.0.1'), '10.0.0.1'), 'unverified-peer', '多跳链不是身份');
    assert.equal(clientIdentity(request('not-an-ip'), '10.0.0.1'), 'unverified-peer');
    assert.equal(clientIdentity(request(null), '10.0.0.1'), '10.0.0.1');
  } finally {
    if (original === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = original;
  }
});

test('login throttling counts failures only and keeps clients separate', async () => {
  const original = process.env.TRUST_PROXY;
  try {
    process.env.TRUST_PROXY = '1';
    const signIn = (fields, xff) => http.loginPost(context('/api/login/', fields, { headers: { 'X-Forwarded-For': xff } }));
    for (let index = 0; index < 20; index++) {
      assert.equal((await signIn({ username: 'operator', password: PASSWORD }, '203.0.113.7')).status, 303, '成功登录不得消耗额度');
    }
    for (let index = 0; index < 10; index++) {
      assert.equal((await signIn({ username: 'missing-user', password: 'wrong' }, '203.0.113.8')).status, 401);
    }
    const blocked = await signIn({ username: 'missing-user', password: 'wrong' }, '203.0.113.8');
    assert.equal(blocked.status, 429);
    const retry = Number(blocked.headers.get('retry-after'));
    assert.ok(retry > 0 && retry <= 900, `Retry-After 应反映真实窗口，实际 ${retry}`);
    assert.equal((await signIn({ username: 'missing-other', password: 'wrong' }, '203.0.113.9')).status, 401, '别的客户端/账号不受影响');
    assert.equal((await signIn({ username: 'missing-chain', password: 'wrong' }, '1.2.3.4, 203.0.113.8')).status, 401, '多值转发头不作为身份');
  } finally {
    if (original === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = original;
  }
});

test('feedback keeps per-client budgets and reports an accurate Retry-After', async () => {
  const fields = { kind: 'general', title: '反馈', body: '这是长度足够的反馈说明内容' };
  for (let index = 0; index < 5; index++) {
    assert.equal((await http.reportsPost(context('/api/reports/', fields, { address: 'reports-client-a' }))).status, 303);
  }
  const blocked = await http.reportsPost(context('/api/reports/', fields, { address: 'reports-client-a' }));
  assert.equal(blocked.status, 429);
  const retry = Number(blocked.headers.get('retry-after'));
  assert.ok(retry > 3000 && retry <= 3600, `反馈窗口为 1 小时，Retry-After 实际 ${retry}`);
  assert.equal((await http.reportsPost(context('/api/reports/', fields, { address: 'reports-client-b' }))).status, 303, '另一个客户端仍有自己的额度');
});

test('metrics accept only published targets and cap distinct targets per day', async () => {
  const post = (body) => http.eventPost({ request: new Request('http://localhost/api/event/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(body) }), clientAddress: '198.51.100.21' });
  const countEvents = () => Number(database().prepare('SELECT COUNT(*) AS total FROM events').get().total);
  const before = countEvents();
  assert.equal((await post({ name: 'resource_view', target: 'no-such-resource' })).status, 204);
  assert.equal(countEvents(), before, '未知目标不写库也不报错');
  assert.equal((await post({ name: 'resource_view', target: 'zotero' })).status, 200);
  assert.equal(countEvents(), before + 1);
  for (let index = 0; index < 200; index++) assert.equal(store.recordEvent('search_miss', `budget-${index}`), true);
  assert.equal(store.recordEvent('search_miss', 'budget-overflow'), false, '超过每日目标预算后新目标被丢弃');
});

test('exported JSON imports back without loss (export → preview → apply)', async () => {
  const importer = await import('../src/lib/importer.ts');
  const exported = importer.exportPayload();
  const preview = importer.previewImport(exported);
  assert.equal(preview.resources.invalid.length, 0, '导出的资源条目必须能通过导入预检');
  assert.equal(preview.guides.invalid.length, 0, '导出的指南条目必须能通过导入预检');
  const applied = importer.applyImport(admin, exported, preview.plan, { restoreSettings: true });
  assert.equal(applied.errors.length, 0);
  assert.equal(applied.resources, store.listManagedResources().length, '资源数量应与导出时一致');
  assert.ok(applied.resources > 0);
});

test('import payload larger than the form limit still applies through the manage endpoint', async () => {
  const resources = [];
  // details 上限 20000 字符：用 8 条 × 约 16 KB，使整个 payload 稳定超过 96 KiB 且每条都合法
  for (let index = 0; index < 8; index++) {
    resources.push({ ...draft(`bulk-${index}`), title: `批量资源 ${index}`, details: 'x'.repeat(16000) });
  }
  const payload = JSON.stringify({ schemaVersion: 1, resources });
  assert.ok(payload.length > 96 * 1024, '样本必须超过普通表单上限');
  assert.ok(payload.length < 3 * 1024 * 1024);

  const logged = session(admin);
  // 预检接口与应用入口共用 previewImport，这里直接用同一个函数拿到计划（页面模块只能由 Astro 加载）。
  const { plan } = importer.previewImport(JSON.parse(payload));
  const imported = await manage(logged, 'import-apply', { payload, plan: JSON.stringify(plan) });
  assert.equal(imported.status, 303, '导入不应被 96 KiB 的表单上限拦住');
  assert.ok(store.findManagedResource('bulk-0'));

  const tooBigForSave = await manage(session(admin), 'save-resource', {
    resource: JSON.stringify({ ...draft('oversized-save'), caveat: 'x'.repeat(100 * 1024) }),
  });
  assert.equal(tooBigForSave.status, 413, '非导入动作仍受普通表单上限约束');
});

test('reserved identifier new cannot be used for resources or guides', () => {
  assert.throws(() => store.saveResource(editor, draft('new'), null), /保留/);
  assert.throws(() => store.saveGuide(editor, { slug: 'new', title: '新', summary: '', body: '正文', resources: [] }, null), /保留/);
  assert.throws(() => store.saveResource(editor, draft('NEW'), null), /校验失败/, '大写形式先被 schema 拒绝');
});

test('linked revision outside the recent window is still findable', async () => {
  const importer = await import('../src/lib/importer.ts');
  const input = { slug: 'rev-window', title: '窗口测试', summary: '', body: '正文', resources: [] };
  let version = store.saveGuide(editor, input, null).version;
  for (let index = 0; index < 24; index++) {
    version = store.saveGuide(editor, { ...input, title: `窗口测试 ${index}` }, version).version;
  }
  const revisions = store.listRevisions('guide', 'rev-window', 20);
  assert.equal(revisions.length, 20);
  const oldest = store.listRevisions('guide', 'rev-window', 100).at(-1);
  assert.ok(oldest);
  assert.equal(revisions.some((revision) => revision.id === oldest.id), false, '最早的修订应已滑出最近 20 条');
  assert.equal(store.findRevisionById('guide', 'rev-window', oldest.id)?.id, oldest.id, '按 ID 仍能补载');
  assert.equal(store.findRevisionById('guide', 'other-guide', oldest.id), undefined);
  assert.ok(importer);
});

test('link checks record what they checked and go stale after the draft changes', () => {
  const resource = store.saveResource(editor, draft('check-target'), null);
  const check = store.saveLinkCheck('check-target', { status: 'ok', statusCode: 200, finalUrl: 'https://example.com/', message: '链接可访问' }, { url: resource.draft.url, version: resource.version, scope: 'draft' });
  assert.equal(check.url, resource.draft.url);
  assert.equal(check.version, resource.version);
  assert.equal(check.scope, 'draft');
  assert.equal(store.linkCheckStaleReason(check, resource), null);

  const edited = store.saveResource(editor, { ...resource.draft, url: 'https://example.org/' }, resource.version);
  assert.match(store.linkCheckStaleReason(check, edited) ?? '', /草稿链接已修改/, '链接变更后旧结果必须标记为过期');
  const stored = store.listLinkChecks().find((row) => row.resourceId === 'check-target');
  assert.equal(stored?.url, resource.draft.url, '旧结果保留当时检查的目标，便于追溯');
});

test('import preview flags reserved identifiers instead of failing later', async () => {
  const importer = await import('../src/lib/importer.ts');
  const preview = importer.previewImport({ schemaVersion: 1, resources: [{ ...draft('new') }] });
  assert.equal(preview.resources.invalid.length, 1);
  assert.match(preview.resources.invalid[0].error, /保留/);
});

test('import plan is bound to the versions seen at preview time', () => {
  const statement = { ...store.findManagedResource('zotero').draft, id: 'concurrent-tool', title: '预检时的标题' };
  const payload = { schemaVersion: 1, resources: [statement] };
  const plan = importer.previewImport(payload).plan;
  assert.deepEqual(plan.resources, { 'concurrent-tool': null });

  // 另一位编辑者在预检之后创建并保存了这个条目（此前不存在，所以版本为 1）。
  store.saveResource(editor, { ...statement, title: '另一位编辑者的标题' }, null);
  assert.equal(store.findManagedResource('concurrent-tool')?.draft.title, '另一位编辑者的标题');
  assert.throws(() => importer.applyImport(admin, payload, plan), /预检后/, '预检计划必须拦住覆盖他人修改');
  assert.equal(store.findManagedResource('concurrent-tool')?.draft.title, '另一位编辑者的标题', '导入不能覆盖预检后保存的内容');

  // 重新预检后可以正常导入。
  const fresh = importer.previewImport(payload).plan;
  assert.equal(importer.applyImport(admin, payload, fresh).resources, 1);
  assert.equal(store.findManagedResource('concurrent-tool')?.draft.title, '预检时的标题');
});

test('import rejects content that changed after preview, and a missing plan', () => {
  const base = store.findManagedResource('zotero').draft;
  const first = { schemaVersion: 1, resources: [{ ...base, id: 'digest-tool', title: '第一份内容' }] };
  const plan = importer.previewImport(first).plan;
  const second = { schemaVersion: 1, resources: [{ ...base, id: 'digest-tool', title: '没预检的第二份内容' }] };
  assert.throws(() => importer.applyImport(admin, second, plan), /不一致/);
  assert.equal(store.findManagedResource('digest-tool'), undefined, '内容与计划不一致时不能写库');
  assert.throws(() => importer.applyImport(admin, first, null), /预检/);
});

test('a failed import entry leaves no partial state, including its audit row', () => {
  const created = store.saveResource(admin, { ...store.findManagedResource('zotero').draft, id: 'trash-target', title: '回收站导入' }, null);
  store.changePublication(admin, 'trash-target', created.version, 'delete-resource');
  const trashed = store.findManagedResource('trash-target');
  assert.ok(trashed?.deletedAt);

  const payload = { schemaVersion: 1, resources: [{ ...trashed.draft, title: '导入标题' }] };
  const plan = importer.previewImport(payload).plan;
  // 让条目审计写入失败：条目、版本历史与审计必须一起回滚，而不是"内容已提交、审计缺失"。
  database().exec("CREATE TRIGGER fail_import_audit BEFORE INSERT ON audit WHEN NEW.action='import-resource' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  try {
    const result = importer.applyImport(admin, payload, plan);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /audit/);
  } finally { database().exec('DROP TRIGGER fail_import_audit'); }

  const after = store.findManagedResource('trash-target');
  assert.ok(after?.deletedAt, '保存失败时不能把资源留在"已离开回收站"的半截状态');
  assert.equal(after?.version, trashed.version, '回滚后版本号也不能前进');
  assert.equal(after?.draft.title, '回收站导入');
  assert.equal(store.listRevisions('resource', 'trash-target').filter((revision) => revision.action === 'save' && revision.version > trashed.version).length, 0);
});

test('import cannot create the virtual category all', () => {
  const payload = { schemaVersion: 1, categories: [{ id: 'all', name: '隐藏分类' }], resources: [] };
  const preview = importer.previewImport(payload);
  assert.equal(preview.categories.create.length, 0);
  assert.equal(preview.categories.invalid.length, 1);
  assert.match(preview.categories.invalid[0].error, /保留/);
  const result = importer.applyImport(admin, payload, preview.plan);
  assert.equal(result.categoriesCreated, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(store.listCategories().some((category) => category.id === 'all'), false);
});

test('exported home settings only come back when the import asks for them', () => {
  const exported = importer.exportPayload();
  assert.ok(exported.settings);
  settings.saveSettings(admin, { featuredResourceId: 'inkscape', scenarios: {} });
  const payload = { schemaVersion: 1, settings: exported.settings };
  const preview = importer.previewImport(payload);
  assert.equal(preview.settings?.featuredResourceId, exported.settings.featuredResourceId);
  assert.equal(preview.settings?.changed, true);

  const skipped = importer.applyImport(admin, payload, preview.plan);
  assert.equal(skipped.settings, false);
  assert.equal(settings.getSettings().featuredResourceId, 'inkscape', '未勾选时不能改动首页编排');

  const restored = importer.applyImport(admin, payload, preview.plan, { restoreSettings: true });
  assert.equal(restored.settings, true);
  assert.equal(settings.getSettings().featuredResourceId, exported.settings.featuredResourceId);
});

test('long identifiers are counted separately and accepted by the event API', async () => {
  const post = (body) => http.eventPost({ request: new Request('http://localhost/api/event/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(body) }), clientAddress: '198.51.100.22' });
  const prefix = 'x'.repeat(60);
  const first = `${prefix}-aaaaaaa`;
  const second = `${prefix}-bbbbbbb`;
  assert.equal(store.recordEvent('resource_view', first), true);
  assert.equal(store.recordEvent('resource_view', second), true);
  const rows = database().prepare("SELECT target,count FROM events WHERE name='resource_view'").all();
  assert.equal(rows.length, 2, '前 60 字符相同的不同 ID 不能合并计数');
  assert.ok(rows.every((row) => row.count === 1));

  const longId = `y${'z'.repeat(80)}`;
  assert.equal(longId.length, 81);
  const saved = store.saveResource(admin, { ...store.findManagedResource('zotero').draft, id: longId }, null);
  store.changePublication(admin, longId, saved.version, 'publish');
  assert.equal((await post({ name: 'resource_view', target: longId })).status, 200, '合法的 81 字符 ID 必须能上报');
  assert.equal((await post({ name: 'resource_view', target: 'z'.repeat(101) })).status, 400);
});

test('scheduled public-snapshot checks stay valid until the public snapshot changes', () => {
  const published = store.getPublishedResources().find((item) => item.id === 'zotero');
  assert.ok(published);
  const managed = store.findManagedResource('zotero');
  const check = store.saveLinkCheck('zotero', { status: 'ok', statusCode: 200, finalUrl: null, message: '链接可访问' }, { url: published.url, version: managed.version, scope: 'published' });
  assert.equal(store.linkCheckStaleReason(check, managed), null, '公开快照未变时定时检查结果不应立即过期');

  const saved = store.saveResource(admin, { ...managed.draft, title: '只改标题' }, managed.version);
  assert.equal(store.linkCheckStaleReason(check, saved), null, '只改草稿不影响公开快照的检查结论');

  const moved = store.saveResource(admin, { ...saved.draft, url: 'https://example.org/moved' }, saved.version);
  store.changePublication(admin, 'zotero', moved.version, 'publish');
  const republished = store.findManagedResource('zotero');
  assert.match(store.linkCheckStaleReason(check, republished) ?? '', /链接已更换/);
});

test('guide keeps a trashed linked resource but refuses new trash links', () => {
  store.saveResource(admin, { ...store.findManagedResource('zotero').draft, id: 'keep-link' }, null);
  const guide = { slug: 'keep-guide', title: '关联保留', summary: '', body: '正文', resources: ['keep-link'] };
  let version = store.saveGuide(editor, guide, null).version;
  store.changePublication(admin, 'keep-link', store.findManagedResource('keep-link').version, 'delete-resource');

  // 编辑页仍会提交这条关联（回收站里的勾选框还在），只改标题时关联必须保留。
  version = store.saveGuide(editor, { ...guide, title: '只改标题' }, version).version;
  assert.deepEqual(store.findManagedGuide('keep-guide')?.draft.resources, ['keep-link']);

  const other = store.saveResource(admin, { ...store.findManagedResource('zotero').draft, id: 'other-trash' }, null);
  store.changePublication(admin, 'other-trash', other.version, 'delete-resource');
  assert.throws(() => store.saveGuide(editor, { ...guide, resources: ['keep-link', 'other-trash'] }, version), /回收站/);

  // 显式取消勾选就是解除关联，这是允许的。
  store.saveGuide(editor, { ...guide, resources: [] }, version);
  assert.deepEqual(store.findManagedGuide('keep-guide')?.draft.resources, []);
});

test('restoring a revision whose category was deleted asks for a replacement category', () => {
  store.saveCategory(admin, 'old-category', '旧分类');
  const base = { ...store.findManagedResource('zotero').draft, id: 'historic-cat', category: 'old-category' };
  const first = store.saveResource(admin, base, null);
  const second = store.saveResource(admin, { ...base, category: 'writing' }, first.version);
  store.deleteCategory(admin, 'old-category');
  const revision = store.listRevisions('resource', 'historic-cat', 100).at(-1);
  assert.ok(revision);

  assert.throws(() => store.restoreResourceRevision(admin, 'historic-cat', revision.id, second.version), /分类/, '缺分类不能变成通用 500');
  const restored = store.restoreResourceRevision(admin, 'historic-cat', revision.id, second.version, 'writing');
  assert.equal(restored.draft.category, 'writing');
  assert.equal(store.findManagedResource('historic-cat')?.version, second.version + 1);
});

test('feedback handling is version bound so an old form cannot revert a resolution', () => {
  store.createReport({ kind: 'general', title: '并发处理', body: '这是长度足够的反馈内容说明，用于并发测试。' });
  const report = store.listReports()[0];
  store.updateReport(editor, report.id, 'resolved', '编辑者备注：已完成核验', null, report.version);
  assert.throws(() => store.updateReport(admin, report.id, 'processing', '旧表单备注', null, report.version), /已被其他维护者处理/, '旧表单必须被拒绝');

  const after = store.listReports()[0];
  assert.equal(after.status, 'resolved');
  assert.equal(after.note, '编辑者备注：已完成核验', '被覆盖的备注不能靠审计找回，所以必须拒绝写入');
  store.updateReport(admin, report.id, 'processing', '管理员看过最新状态后的备注', null, after.version);
  assert.equal(store.listReports()[0].note, '管理员看过最新状态后的备注');
});

test('guide restore refuses dangling resource links unless the operator drops them', () => {
  store.saveResource(admin, { ...store.findManagedResource('zotero').draft, id: 'restore-res', title: '待删资源' }, null);
  const first = store.saveGuide(editor, { slug: 'restore-guide', title: 'v1', summary: '', body: '正文', resources: ['restore-res'] }, null);
  const cleared = store.saveGuide(editor, { slug: 'restore-guide', title: 'v2', summary: '', body: '正文', resources: [] }, first.version);
  const v1 = store.listRevisions('guide', 'restore-guide', 100).at(-1);
  assert.deepEqual(v1.data.resources, ['restore-res']);

  // 资源进回收站：与普通保存同一规则，不能借历史恢复新增回收站关联
  store.changePublication(admin, 'restore-res', store.findManagedResource('restore-res').version, 'delete-resource');
  assert.throws(() => store.restoreGuideRevision(editor, 'restore-guide', v1.id, cleared.version), /回收站/);

  store.purgeTrashResource(admin, 'restore-res');
  assert.throws(() => store.restoreGuideRevision(editor, 'restore-guide', v1.id, cleared.version), /已不存在/);
  const restored = store.restoreGuideRevision(editor, 'restore-guide', v1.id, cleared.version, true);
  assert.deepEqual(restored.draft.resources, [], '显式同意后才移除失效关联');
  assert.equal(store.findManagedGuide('restore-guide').draft.title, 'v1');
});

test('import plan detects a deleted-and-recreated entity with the same id', () => {
  const base = store.findManagedResource('zotero').draft;
  const original = store.saveResource(admin, { ...base, id: 'recreate-me', title: '原始标题' }, null);
  const payload = { schemaVersion: 1, resources: [{ ...base, id: 'recreate-me', title: '导入文件里的标题' }] };
  const plan = importer.previewImport(payload).plan;

  store.changePublication(admin, 'recreate-me', original.version, 'delete-resource');
  store.purgeTrashResource(admin, 'recreate-me');
  const rebuilt = store.saveResource(editor, { ...base, id: 'recreate-me', title: '重建的新对象' }, null);
  assert.ok(rebuilt.version > original.version, '版本号永不复用：同名重建会接着墓碑继续编号');

  assert.throws(() => importer.applyImport(admin, payload, plan), /删除并重建/);
  assert.equal(store.findManagedResource('recreate-me').draft.title, '重建的新对象', '不能把旧文件写进新对象');
});

test('import freezes the current home settings too', () => {
  const exported = importer.exportPayload();
  const payload = { schemaVersion: 1, settings: exported.settings };
  const plan = importer.previewImport(payload).plan;
  settings.saveSettings(admin, { featuredResourceId: 'inkscape', scenarios: {} });
  assert.throws(() => importer.applyImport(admin, payload, plan, { restoreSettings: true }), /首页设置在预检后被修改/);
  assert.equal(settings.getSettings().featuredResourceId, 'inkscape', '预检后别人的编排不能被旧文件覆盖');

  const fresh = importer.previewImport(payload).plan;
  assert.equal(importer.applyImport(admin, payload, fresh, { restoreSettings: true }).settings, true);
});

test('exported settings drop scenarios for categories that no longer exist', () => {
  // 把 writing 下的资源（草稿与公开快照）全部移到 design，然后删除该分类
  for (const item of store.listManagedResources().filter((entry) => entry.draft.category === 'writing' || entry.published?.category === 'writing')) {
    const draft = { ...item.draft, category: 'design' };
    const saved = store.saveResource(admin, draft, item.version);
    if (saved.published) store.changePublication(admin, item.id, saved.version, 'publish');
  }
  store.deleteCategory(admin, 'writing');
  const exported = importer.exportPayload();
  assert.equal('writing' in exported.settings.scenarios, false, '导出不能带上已删除分类的默认文案');

  // 手工构造的旧文件仍含死分类：恢复设置要报出来，而不是整体失败
  const payload = { schemaVersion: 1, settings: { featuredResourceId: 'gimp', scenarios: { writing: { task: '写报告', detail: '', glyph: '文' } } } };
  const preview = importer.previewImport(payload);
  assert.deepEqual(preview.settings?.missingCategories, ['writing'], '预检就要报出失效的场景分类');
  const result = importer.applyImport(admin, payload, preview.plan, { restoreSettings: true });
  assert.equal(result.settings, true);
  assert.ok(result.errors.some((entry) => /writing/.test(entry.error)), '失效场景文案必须显式告知');
  assert.equal(settings.getSettings().featuredResourceId, 'gimp');
});

test('import failure details survive the redirect through the run record', async () => {
  const payload = JSON.stringify({ schemaVersion: 1, categories: [{ id: 'all', name: '保留分类' }], resources: [] });
  const parsed = JSON.parse(payload);
  const plan = importer.previewImport(parsed).plan;
  const response = await manage(session(admin), 'import-apply', { payload, plan: JSON.stringify(plan) });
  assert.equal(response.status, 303);
  const location = response.headers.get('location') ?? '';
  const runId = Number(new URL(location, 'http://localhost').searchParams.get('run'));
  assert.ok(runId > 0, location);
  const run = store.findImportRun(runId);
  assert.ok(run, '导入结果必须可回查');
  const errors = run.summary.errors;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 'all');
  assert.match(errors[0].error, /保留/);
});

test('a stale page cannot save or publish a recreated entity', () => {
  const base = seedResource('stale-target');
  const first = store.saveResource(admin, base, null);
  store.changePublication(admin, 'stale-target', first.version, 'delete-resource');
  store.purgeTrashResource(admin, 'stale-target');
  const rebuilt = store.saveResource(editor, { ...base, title: '重建的新草稿' }, null);
  assert.ok(rebuilt.version > first.version, '同名重建的版本号接着墓碑继续，不复用旧值');

  assert.throws(() => store.saveResource(admin, { ...base, title: '旧页面提交的内容' }, first.version), /重新加载/);
  assert.throws(() => store.changePublication(admin, 'stale-target', first.version, 'publish'), /重新加载/);
  const after = store.findManagedResource('stale-target');
  assert.equal(after.draft.title, '重建的新草稿');
  assert.equal(after.published, null, '旧页面不能发布没看过的新对象');

  // 指南同样适用
  const guide = { slug: 'stale-guide', title: '旧标题', summary: '', body: '正文', resources: [] };
  const guideFirst = store.saveGuide(editor, guide, null);
  store.changeGuidePublication(admin, 'stale-guide', guideFirst.version, 'delete-guide');
  store.purgeTrashGuide(admin, 'stale-guide');
  const guideRebuilt = store.saveGuide(editor, { ...guide, title: '重建的指南' }, null);
  assert.ok(guideRebuilt.version > guideFirst.version);
  assert.throws(() => store.saveGuide(editor, { ...guide, title: '旧页面正文' }, guideFirst.version), /重新加载/);
  assert.throws(() => store.changeGuidePublication(admin, 'stale-guide', guideFirst.version, 'publish-guide'), /重新加载/);
  assert.equal(store.findManagedGuide('stale-guide').draft.title, '重建的指南');
});

test('import applies valid entries even when a sibling entry is semantically invalid', () => {
  const base = store.findManagedResource('zotero').draft;
  const payload = {
    schemaVersion: 1,
    resources: [
      { ...base, id: 'valid-entry', title: '合法条目' },
      { ...base, id: 'bad-category-entry', category: 'missing-category' },
    ],
    guides: [
      { slug: 'guide-ok', title: '正常指南', summary: '', body: '正文', resources: ['zotero'] },
      { slug: 'guide-bad', title: '坏关联', summary: '', body: '正文', resources: ['no-such-resource'] },
    ],
  };
  const preview = importer.previewImport(payload);
  assert.deepEqual(preview.resources.create, ['valid-entry']);
  assert.equal(preview.resources.invalid.length, 1);
  assert.equal(preview.guides.invalid.length, 1);

  const result = importer.applyImport(admin, payload, preview.plan);
  assert.equal(result.resources, 1, '合法条目不能被无效条目拖住');
  assert.equal(result.guides, 1);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.map((entry) => entry.error).join(' '), /预检已判定该条目无效/);
  assert.equal(store.findManagedResource('valid-entry').draft.title, '合法条目');
  assert.equal(store.findManagedGuide('guide-ok').draft.title, '正常指南');
  assert.equal(store.findManagedResource('bad-category-entry'), undefined);
  assert.equal(store.findManagedGuide('guide-bad'), undefined);
});

test('importing only categories still leaves an audit entry', () => {
  const before = store.listAudit().length;
  const payload = { schemaVersion: 1, categories: [{ id: 'imported-only', name: '仅导入分类' }] };
  const result = importer.applyImport(admin, payload, importer.previewImport(payload).plan);
  assert.equal(result.categoriesCreated, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(store.listAudit().length, before + 1, '分类导入也必须留审计');
  assert.equal(store.listAudit()[0].action, 'save-category');
  assert.equal(store.listAudit()[0].target, 'imported-only');
});

test('pending drafts surface in the notice board until an admin publishes them', () => {
  assert.equal(noticeBoard().pendingDrafts, 0, '初始种子全部已发布');
  store.saveResource(editor, { ...store.getPublishedResources()[0], id: 'draft-queue', title: '等待发布的草稿' }, null);
  const board = noticeBoard();
  assert.equal(board.pendingDrafts, 1);
  assert.ok(board.items.some((item) => item.id === 'pending-drafts'), '待发布应进入待办摘要');
  const pending = store.findManagedResource('draft-queue');
  store.changePublication(admin, 'draft-queue', pending.version, 'publish');
  assert.equal(noticeBoard().pendingDrafts, 0, '发布后队列清空');
});

test('discontinued resources leave the catalogue but keep an explanation page', () => {
  const target = store.findManagedResource('python');
  assert.throws(() => store.discontinueResource(editor, 'python', target.version, null, ''), /仅限管理员/);
  assert.throws(() => store.discontinueResource(admin, 'python', target.version, 'python', ''), /本身/);
  assert.throws(() => store.discontinueResource(admin, 'python', target.version, 'missing-resource', ''), /替代资源/);
  store.discontinueResource(admin, 'python', target.version, 'inkscape', '课程已停止更新');
  assert.equal(store.getPublishedResources().some((item) => item.id === 'python'), false, '停用后不再进入公开目录');
  assert.ok(store.findPublishedResource('python'), '详情解释页仍然可读，旧链接不会 404');
  const lifecycle = store.findResourceLifecycle('python');
  assert.ok(lifecycle?.discontinuedAt);
  assert.equal(lifecycle?.replacedBy, 'inkscape');
  assert.ok(store.listPublishedResourcesIncludingDiscontinued().some((item) => item.id === 'python'));
  const stopped = store.findManagedResource('python');
  store.reactivateResource(admin, 'python', stopped.version);
  assert.ok(store.getPublishedResources().some((item) => item.id === 'python'), '恢复后回到目录');
  assert.equal(store.findResourceLifecycle('python')?.discontinuedAt, null);
  assert.throws(() => store.reactivateResource(admin, 'python', store.findManagedResource('python').version), /未处于停用/);
});

test('unpublished drafts cannot be discontinued', () => {
  store.saveResource(editor, { ...store.getPublishedResources()[0], id: 'draft-only', title: '仅草稿' }, null);
  const draft = store.findManagedResource('draft-only');
  assert.throws(() => store.discontinueResource(admin, 'draft-only', draft.version, null, ''), /尚未发布/);
});

test('resolved feedback can publish a public announcement without leaking the report body', () => {
  store.createReport({ resourceId: 'zotero', kind: '费用或资格变化', title: '内部反馈标题', body: '内部反馈正文，包含不应该公开的细节。' });
  const report = store.listReports()[0];
  assert.throws(() => store.updateReport(admin, report.id, 'processing', '', null, report.version, { title: '公告', body: '' }), /已解决/);
  store.updateReport(admin, report.id, 'resolved', '内部备注', null, report.version, { title: '费用说明已更新', body: '已按官方页面核对。' });
  const announcements = store.listAnnouncements();
  assert.equal(announcements.length, 1);
  assert.equal(announcements[0]?.title, '费用说明已更新');
  assert.ok(announcements[0]?.resourceTitle, '公告可回链到关联资源');
  assert.equal(JSON.stringify(announcements).includes('不应该公开'), false, '公告不得透传反馈正文或备注');
  const current = store.listReports()[0];
  store.updateReport(admin, current.id, 'processing', '内部备注', null, current.version, null);
  assert.equal(store.listAnnouncements().length, 0, '取消勾选即撤下公告');
});
