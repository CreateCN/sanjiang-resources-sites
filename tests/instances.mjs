import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withChildDiagnostics } from './fixtures/child-report.mjs';

// 两个实例使用同一套代码、不同的数据库与媒体目录；不需要浏览器。
const repo = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'sj-instances-'));
process.env.DATABASE_PATH = join(root, 'boot.sqlite');
process.env.MEDIA_DIR = join(root, 'boot-media');
process.env.SITE_INIT_MODE = 'empty';
const store = await import('../src/server/store.ts');
const siteConfig = await import('../src/server/site-config.ts');
const sponsors = await import('../src/server/sponsors.ts');
const { closeDatabase } = await import('../src/server/db.ts');

const PASSWORD_A = 'instance-a-password-2026!';
const PASSWORD_B = 'instance-b-password-2026!';
const USERNAME = 'shared-admin';

function run(script, args, env) {
  const result = withChildDiagnostics(spawnSync(process.execPath, [script, ...args], { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 }));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
async function waitUp(base) {
  for (let index = 0; index < 150; index++) {
    try { if ((await fetch(base + '/api/health/')).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('实例未启动：' + base);
}
async function startInstance(prefix, mode, name, port, password) {
  const dir = join(root, prefix);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    DATABASE_PATH: join(dir, 'site.sqlite'), MEDIA_DIR: join(dir, 'media'),
    SITE_URL: base, SITE_INIT_MODE: mode, SITE_INIT_NAME: name,
  };
  run('scripts/init-site.mjs', ['--mode', mode, '--name', name], env);
  run('scripts/create-admin.mjs', [], { ...env, ADMIN_USERNAME: USERNAME, ADMIN_PASSWORD: password });
  const child = spawn(process.execPath, ['dist/server/entry.mjs'], {
    cwd: repo,
    env: { ...process.env, ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[${prefix}] ${chunk}`));
  await waitUp(base);
  return { dir, base, env, child, password };
}
async function login(instance, password) {
  const response = await fetch(instance.base + '/api/login/', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: instance.base, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USERNAME, password }),
  });
  return { status: response.status, cookie: response.headers.getSetCookie().find((value) => value.startsWith('sanjiang_session=')) };
}
function withInstance(instance, operation) {
  closeDatabase();
  process.env.DATABASE_PATH = instance.env.DATABASE_PATH;
  process.env.SITE_INIT_MODE = 'empty';
  try { return operation(); } finally { closeDatabase(); }
}
async function page(base, path, cookie) {
  return fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie.split(';')[0] } : {} });
}

let a;
let b;
before(async () => {
  // 端口避开 admin-e2e 的 4400–4700 随机区间，避免串行执行时残留进程冲突。
  a = await startInstance('instance-a', 'empty', '甲实例', 4861, PASSWORD_A);
  b = await startInstance('instance-b', 'demo', '乙实例', 4862, PASSWORD_B);
});
after(async () => {
  a?.child.kill('SIGTERM');
  b?.child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

test('Empty 与 Demo 初始化互不共享内容', async () => {
    const homeA = await (await fetch(a.base + '/')).text();
    const homeB = await (await fetch(b.base + '/')).text();
    assert.match(homeA, /甲实例/);
    assert.match(homeA, /共 0 项/);
    assert.doesNotMatch(homeA, /演示内容/);
    assert.doesNotMatch(homeA, /class="sponsor-slot/, '没有生效赞助时不渲染容器');
    assert.match(homeB, /乙实例/);
    assert.match(homeB, /演示内容，请替换并重新核验/);
    assert.match(homeB, /共 2 项/);
    assert.notEqual(a.env.DATABASE_PATH, b.env.DATABASE_PATH);
  });

  test('相同用户名仍是两个独立账户，Cookie 不能跨实例使用', async () => {
    const loginA = await login(a, PASSWORD_A);
    const loginB = await login(b, PASSWORD_B);
    assert.equal(loginA.status, 303);
    assert.equal(loginB.status, 303);
    assert.ok(loginA.cookie && loginB.cookie);
    assert.equal((await page(a.base, '/admin/', loginA.cookie)).status, 200);
    assert.equal((await page(b.base, '/admin/', loginB.cookie)).status, 200);
    const crossed = await page(b.base, '/admin/', loginA.cookie);
    assert.ok([302, 303].includes(crossed.status), 'A 的会话不能进入 B');
    assert.match(String(crossed.headers.get('location')), /login/);
    // A 的口令不能用于 B。
    const wrong = await login(b, PASSWORD_A);
    assert.equal(wrong.status, 401, '账户凭据不共享');
  });

  test('品牌与内容修改只影响本实例', async () => {
    closeDatabase();
    process.env.DATABASE_PATH = a.env.DATABASE_PATH;
    process.env.SITE_INIT_MODE = 'empty';
    const admin = store.listUsers().find((user) => user.username === USERNAME);
    const current = siteConfig.getBranding();
    const { schemaVersion, version, ...input } = current;
    siteConfig.saveBranding(admin, { ...input, name: '甲实例改名' }, siteConfig.getBrandingAdminView().version);
    closeDatabase();

    assert.match(await (await fetch(a.base + '/')).text(), /甲实例改名/);
    const homeB = await (await fetch(b.base + '/')).text();
    assert.match(homeB, /乙实例/);
    assert.doesNotMatch(homeB, /甲实例改名/);
});

test('赞助数据与总开关只属于本实例', () => {
  withInstance(a, () => {
    const admin = store.listUsers().find((user) => user.username === USERNAME);
    sponsors.createSponsor(admin, {
      title: '甲实例赞助', body: '', sponsorName: '赞助方',
      mediaId: null, imageAlt: '', targetUrl: 'https://sponsor.example.com/',
      placement: 'home-sidebar', enabled: true, startsAt: null, endsAt: null,
    });
    sponsors.saveSponsorSettings(admin, { enabled: true }, 0);
    assert.equal(sponsors.listSponsors().length, 1);
    assert.equal(sponsors.getActiveSponsors().length, 1);
  });
  withInstance(b, () => {
    assert.equal(sponsors.listSponsors().length, 0, 'B 不能看到 A 的赞助');
    assert.equal(sponsors.isSponsorEnabled(), false, 'B 的总开关仍关闭');
  });
});
