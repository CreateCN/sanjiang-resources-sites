// Local-only, bounded security probes. Uses the dedicated data/security-audit DB.
// Start the production server as documented in reports/security/README.md (or docs/deploy-local.md for a non-Docker setup).
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const directory = resolve('data/security-audit');
process.env.DATABASE_PATH = resolve(directory, 'site.sqlite');
const base = 'http://127.0.0.1:4321';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const { createInitialAdmin, createUser, findManagedResource } = await import('../src/server/store.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');
const { checkResourceLink, assertPublicUrl } = await import('../src/server/linkcheck.ts');
const suffix = randomBytes(5).toString('hex');
const password = randomBytes(24).toString('base64url');
const admin = createInitialAdmin(`audit-admin-${suffix}`, password);
const editor = createUser(admin, `audit-editor-${suffix}`, password, 'editor');
writeFileSync(resolve(directory, 'credentials.json'), JSON.stringify({ admin: admin.username, editor: editor.username, password }, null, 2), { mode: 0o600 });
const evidence = { base, timestamp: new Date().toISOString(), checks: [] };
function record(name, result) { evidence.checks.push({ name, ...result }); console.log(JSON.stringify({ name, ...result })); }
async function get(path, cookie) {
  return fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
}
/** 伪造转发头时必须同时带上代理共享凭据，否则应用会按不可信身份处理（见 SECURITY-SPEC §2.1）。 */
const proxySecret = (process.env.TRUST_PROXY_SECRET ?? '').trim();
async function post(path, fields, { cookie, origin = base, forwarded } = {}) {
  return fetch(base + path, { method: 'POST', redirect: 'manual', headers: {
    origin, accept: 'application/json', ...(cookie ? { cookie } : {}),
    ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
    ...(forwarded && proxySecret ? { 'x-sanjiang-proxy-secret': proxySecret } : {}),
  }, body: new URLSearchParams(fields) });
}
async function session(user) {
  const response = await post('/api/login/', { username: user.username, password });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const page = await get('/admin/', cookie);
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  return { cookie, csrf };
}
// Deliberately send no Content-Length. Pause after exceeding the advertised cap.
async function oversized(path, cookie, contentType, prefix, size, suffix = '') {
  let responded = false;
  let sent = 0;
  const request = http.request(base + path, { method: 'POST', headers: {
    origin: base, 'content-type': contentType, accept: 'application/json', ...(cookie ? { cookie } : {}),
  } });
  request.setTimeout(10000, () => request.destroy(new Error('probe timeout')));
  const result = new Promise((resolveResult, reject) => {
    request.on('response', (response) => { responded = true; response.resume(); response.on('end', () => resolveResult(response.statusCode)); });
    request.on('error', reject);
  });
  const chunk = Buffer.alloc(64 * 1024, 65);
  request.write(prefix);
  for (let offset = 0; offset < size; offset += chunk.length) {
    if (!request.write(chunk)) await once(request, 'drain');
    sent += chunk.length;
  }
  await delay(250);
  const respondedBeforeEnd = responded;
  request.end(suffix);
  return { sentBytes: sent + Buffer.byteLength(prefix + suffix), respondedBeforeEnd, status: await result };
}
let fixture;
try {
  const health = await get('/api/health/');
  assert.equal(health.status, 200);
  record('deployment', { health: await health.json(), home: (await get('/')).status });
  for (const path of ['/admin/', '/admin/users/', '/admin/preview/resources/zotero/', '/api/export/']) {
    const response = await get(path);
    assert.ok([302, 303, 401].includes(response.status));
    record('anonymous-boundary', { path, status: response.status, location: response.headers.get('location') });
  }
  const a = await session(admin), e = await session(editor);
  const exportResponse = await get('/api/export/', e.cookie);
  assert.equal(exportResponse.status, 403);
  record('editor-export-denied', { status: exportResponse.status });
  for (const fields of [
    { action: 'publish', id: 'zotero', version: '1' },
    { action: 'create-user', username: 'probe', password, role: 'admin' },
    { action: 'save-category', id: 'probe', name: 'probe' },
  ]) {
    const response = await post('/api/manage/', { ...fields, csrf: e.csrf }, { cookie: e.cookie });
    assert.equal(response.status, 403);
    record('editor-role-denied', { action: fields.action, status: response.status });
  }
  const resource = findManagedResource('zotero');
  for (const options of [{ cookie: a.cookie, origin: 'https://attacker.invalid' }, { cookie: a.cookie }]) {
    const response = await post('/api/manage/', { action: 'publish', id: 'zotero', version: String(resource.version), csrf: options.origin ? a.csrf : 'bad' }, options);
    assert.equal(response.status, 403);
    record('csrf-denied', { forgedOrigin: Boolean(options.origin), status: response.status });
  }
  const xss = await post('/api/preview/', { csrf: e.csrf, text: '<img src=x onerror=alert(1)> [x](javascript:alert(1))' }, { cookie: e.cookie });
  const rendered = await xss.json();
  assert.ok(!rendered.html.includes('<img') && !rendered.html.includes('href="javascript:'));
  record('markdown-xss-blocked', { status: xss.status, html: rendered.html });
  let hits = [];
  fixture = http.createServer((request, response) => { hits.push({ method: request.method, path: request.url, peer: request.socket.remoteAddress }); response.writeHead(200).end('local audit marker'); });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const url = `http://[::ffff:127.0.0.1]:${fixture.address().port}/audit-marker`;
  const normalized = (await assertPublicUrl(url)).href;
  const checked = await checkResourceLink(url);
  assert.equal(hits.length, 1);
  record('ssrf-ipv4-mapped-loopback', { input: url, normalized, checked, hits });
  record('unbounded-anonymous-event-body', await oversized('/api/event/', undefined, 'application/json', '{"padding":"', 2 * 1024 * 1024, '"}'));
  // 导入预检现在先授权再读体（SJ-A-03），因此不再用"发 4 MiB 体"来探测它：
  // 编辑者会在读取请求体之前就拿到 403，发送大体积只会把探测卡在背压上。
  const deniedImport = await post('/api/import/preview/', { csrf: e.csrf, payload: '{}' }, { cookie: e.cookie });
  assert.equal(deniedImport.status, 403);
  record('editor-import-preview-denied', { status: deniedImport.status });
  // 账号失败桶的契约（2026-10-25 SJ-A-01）：
  // - 成功的登录从不消耗额度，所以这里必须正好发 10 次失败才把它打满（旧脚本写 9 次，
  //   注释还错误地假定先前那次成功登录占了 1 个额度）；
  // - 打满后拒绝的是该账号的**失败尝试**，正确口令仍然必须能登录。
  const attempts = [];
  for (let i = 0; i < 10; i++) attempts.push((await post('/api/login/', { username: admin.username, password: 'wrong' }, { forwarded: '198.51.100.10' })).status);
  const stillFailing = await post('/api/login/', { username: admin.username, password: 'wrong' }, { forwarded: '198.51.100.10' });
  assert.equal(stillFailing.status, 429);
  const legit = await post('/api/login/', { username: admin.username, password });
  assert.equal(legit.status, 303);
  record('account-failure-budget', {
    wrongPasswordAttempts: attempts,
    failureAfterExhaustion: stillFailing.status,
    correctPasswordStatus: legit.status,
  });
} finally {
  // Restore test-account access; never clear limits belonging to other users.
  const { hashToken } = await import('../src/server/security.ts');
  database().prepare('DELETE FROM rate_limits WHERE key=?').run(`login-user:${hashToken(admin.username)}`);
  if (fixture) await new Promise((done) => fixture.close(done));
  closeDatabase();
  writeFileSync(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
