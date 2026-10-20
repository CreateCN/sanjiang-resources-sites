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
function session(user = admin) {
  const token = auth.login(user.username, PASSWORD, `session-${user.id}`);
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

test('disabling, resetting passwords, and role changes revoke existing sessions', () => {
  let logged = session(editor);
  store.updateUser(admin, editor.id, 'editor', false);
  assert.equal(auth.getSession(logged.request), undefined);
  assert.throws(() => auth.login('editor', PASSWORD, 'disabled-login'), /密码错误/);
  store.updateUser(admin, editor.id, 'editor', true);
  logged = session(editor);
  store.updateUser(admin, editor.id, 'admin', true);
  assert.equal(auth.getSession(logged.request), undefined);
  logged = session(editor);
  store.updateUser(admin, editor.id, 'editor', true, 'new-test-password!');
  assert.equal(auth.getSession(logged.request), undefined);
  assert.throws(() => auth.login('editor', PASSWORD, 'reset-login'), /密码错误/);
  assert.ok(auth.login('editor', 'new-test-password!', 'reset-login'));
});

test('cannot deactivate, demote, or delete the last active administrator', () => {
  assert.throws(() => store.updateUser(admin, admin.id, 'admin', false), /最后一位/);
  assert.throws(() => store.updateUser(admin, admin.id, 'editor', true), /最后一位/);
  assert.throws(() => store.deleteUser(admin, admin.id), /最后一位/);
  const second = store.createUser(admin, 'second-admin', PASSWORD, 'admin');
  store.updateUser(admin, second.id, 'admin', false);
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
  assert.equal((await manage(session(editor), 'update-report', { id: String(report.id), status: 'resolved', note: '已处理' })).status, 303);
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
  assert.match(String(healthBody.schema), /^00[12]/);
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

test('feedback can link to a revision of its own resource only', () => {
  const current = store.findManagedResource('zotero');
  const saved = store.saveResource(admin, { ...current.draft, title: '反馈修复版本' }, current.version);
  const revision = store.listRevisions('resource', 'zotero')[0];
  assert.ok(revision);
  store.createReport({ resourceId: 'zotero', kind: '信息有误', title: '反馈标题', body: '这是至少十个字符的反馈内容。' });
  const report = store.listReports()[0];
  store.updateReport(editor, report?.id ?? 0, 'resolved', '已按修订处理', revision?.id ?? 0);
  const linked = store.listReports()[0];
  assert.equal(linked?.revisionId, revision?.id);
  assert.equal(linked?.status, 'resolved');

  const python = store.findManagedResource('python');
  store.saveResource(admin, { ...python.draft, title: '别的资源' }, python.version);
  const foreign = store.listRevisions('resource', 'python')[0];
  assert.throws(() => store.updateReport(editor, report?.id ?? 0, 'resolved', '错链', foreign?.id ?? 0), /不属于/);

  store.createReport({ kind: '其他建议', title: '无资源反馈', body: '这是一条没有关联资源的反馈内容。' });
  const general = store.listReports()[0];
  assert.throws(() => store.updateReport(editor, general?.id ?? 0, 'resolved', 'x', revision?.id ?? 0), /没有关联资源/);
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
});

test('batch review updates drafts and history for editors', () => {
  const result = store.bulkReviewResources(editor, ['inkscape', 'smart-education'], 'verified', '2026-10-20');
  assert.equal(result.updated, 2);
  const inkscape = store.findManagedResource('inkscape');
  assert.equal(inkscape?.draft.status, 'verified');
  assert.equal(inkscape?.draft.checkedAt, '2026-10-20');
  assert.equal(store.listRevisions('resource', 'inkscape')[0]?.action, 'save');
  assert.equal(store.getPublishedResources().find((item) => item.id === 'inkscape')?.status, 'review', '批量复核不改公开快照');
  store.bulkReviewResources(editor, ['inkscape'], 'review', null);
  assert.equal(store.findManagedResource('inkscape')?.draft.checkedAt, null);
  assert.throws(() => store.bulkReviewResources(editor, [], 'verified', '2026-10-20'), /选择/);
  assert.throws(() => store.bulkReviewResources(editor, ['inkscape'], 'verified', 'not-a-date'), /日期/);
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

  assert.throws(() => importer.applyImport(editor, payload), /管理员/);
  const applied = importer.applyImport(admin, payload);
  assert.equal(applied.resources, 1);
  assert.equal(applied.guides, 1);
  assert.equal(applied.categoriesCreated, 1);
  assert.equal(store.findManagedResource('import-tool')?.draft.title, '导入工具');
  assert.equal(store.findManagedGuide('import-guide')?.draft.title, '导入指南');

  const exported = importer.exportPayload();
  assert.ok(Array.isArray(exported.resources) && exported.resources.length > 12);
  assert.ok(exported.categories.some((category) => category.id === 'career'));
  assert.equal(exported.schemaVersion, 1);
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
