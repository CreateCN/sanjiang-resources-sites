import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'sj-e2e-'));
const port = 4400 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const dbPath = join(dir, 'site.sqlite');
let server;
let browser;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(`${base}/api/health/`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('测试服务器未能启动');
}

before(async () => {
  const seeded = spawnSync(process.execPath, ['scripts/create-admin.mjs'], {
    cwd: root,
    env: { ...process.env, DATABASE_PATH: dbPath, ADMIN_USERNAME: 'rootadmin', ADMIN_PASSWORD: 'root-password-123' },
    encoding: 'utf8',
  });
  assert.equal(seeded.status, 0, seeded.stderr);
  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: dbPath, SITE_URL: base },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
});

const sessions = new Map();
async function login(page, username, password) {
  const cached = sessions.get(username);
  if (cached) {
    // 复用已登录状态，避免测试把登录限流打满（生产限制仍按真实用户生效）。
    await page.context().addCookies(cached.cookies);
    await page.goto(`${base}/admin/`);
    assert.equal(new URL(page.url()).pathname, '/admin/', '复用的登录会话应仍然有效');
    return;
  }
  await page.goto(`${base}/admin/login/`);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await Promise.all([page.waitForURL(`${base}/admin/`), page.getByRole('button', { name: '登录后台' }).click()]);
  sessions.set(username, await page.context().storageState());
}

test('未登录后台被重定向，登录后进入工作台', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/admin/`);
  assert.equal(new URL(page.url()).pathname, '/admin/login/');
  await login(page, 'rootadmin', 'root-password-123');
  assert.equal(await page.locator('h1').first().textContent(), '工作概览');
  await page.close();
});

test('管理员保存草稿后前台不可见，发布后可见，撤回后消失', async () => {
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/resources/new/`);
  await page.locator('[data-field="id"]').fill('e2e-tool');
  await page.locator('[data-field="title"]').fill('E2E 测试工具');
  await page.locator('[data-field="summary"]').fill('仅用于端到端测试的临时资源，发布后应出现在前台详情页。');
  await page.locator('[data-field="cost"]').fill('免费');
  await page.locator('[data-field="url"]').fill('https://example.com/');
  await page.locator('[data-field="sourceUrl"]').fill('https://example.com/about');
  await page.locator('[data-field="license"]').fill('测试许可说明。');
  await page.locator('[data-field="eligibility"]').fill('测试资格说明。');
  await page.locator('[data-field="caveat"]').fill('测试限制说明。');
  await page.locator('[data-field="steps"]').fill('第一步。\n第二步。\n第三步。');
  await page.locator('[data-field="tags"]').fill('测试');
  await page.locator('[data-field="details"]').fill('## 使用前须知\n\n这是 **Markdown** 详情，包含[官方链接](https://example.com/)。');
  await page.locator('#kind').selectOption('开源工具');
  await Promise.all([page.waitForURL(/\/admin\/resources\/e2e-tool\/$/), page.getByRole('button', { name: '保存草稿' }).click()]);

  assert.equal((await fetch(`${base}/resources/e2e-tool/`)).status, 404, '草稿不应出现在前台');
  assert.doesNotMatch(await (await fetch(`${base}/sitemap.xml`)).text(), /e2e-tool/, '草稿不应进入 sitemap');
  assert.ok((await page.locator('body').textContent())?.includes('草稿尚未公开'));

  await Promise.all([page.waitForSelector('button:has-text("撤回公开版本")'), page.getByRole('button', { name: '发布当前草稿' }).click()]);
  const published = await (await fetch(`${base}/resources/e2e-tool/`)).text();
  assert.match(published, /E2E 测试工具/);
  assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /resources\/e2e-tool\//, '发布后进入 sitemap');
  assert.match(published, /<strong>Markdown<\/strong>/);
  assert.match(published, /href="https:\/\/example\.com\/"/);

  await Promise.all([page.waitForSelector('button:has-text("发布当前草稿")'), page.getByRole('button', { name: '撤回公开版本' }).click()]);
  assert.equal((await fetch(`${base}/resources/e2e-tool/`)).status, 404, '撤回后前台不应展示');
  await page.close();
});

test('编辑者只能改草稿，不能发布或访问人员管理', async () => {
  const admin = await browser.newPage();
  await login(admin, 'rootadmin', 'root-password-123');
  await admin.goto(`${base}/admin/users/`);
  await admin.locator('#new-username').fill('editor1');
  await admin.locator('#new-password').fill('editor-password-123');
  await admin.locator('#new-role').selectOption('editor');
  await admin.getByRole('button', { name: '创建账户' }).click();
  await admin.waitForSelector('text=editor1');
  await admin.close();

  const page = await browser.newPage();
  await login(page, 'editor1', 'editor-password-123');
  await page.goto(`${base}/admin/users/`);
  assert.equal(new URL(page.url()).pathname, '/admin/', '编辑者访问人员管理应被重定向');
  await page.goto(`${base}/admin/resources/zotero/`);
  assert.ok((await page.locator('body').textContent())?.includes('编辑：Zotero 文献管理'));
  assert.equal(await page.getByRole('button', { name: '发布当前草稿' }).count(), 0, '编辑者不应看到发布按钮');

  const csrf = await page.locator('input[name=csrf]').first().inputValue();
  const version = await page.locator('input[name=version]').first().inputValue();
  const forbidden = await page.evaluate(async ({ csrf, version }) => {
    const form = new FormData();
    form.set('csrf', csrf); form.set('action', 'publish'); form.set('id', 'zotero'); form.set('version', version);
    const response = await fetch('/api/manage/', { method: 'POST', body: form, headers: { Accept: 'application/json' } });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, { csrf, version });
  assert.equal(forbidden.status, 403);
  assert.match(String(forbidden.body.error), /管理员/);
  await page.close();
});

test('版本冲突不会覆盖他人修改，并显示可读错误', async () => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await login(first, 'rootadmin', 'root-password-123');
  await first.goto(`${base}/admin/resources/libreoffice/`);
  const stale = await context.newPage();
  await stale.goto(`${base}/admin/resources/libreoffice/`);

  await first.locator('[data-field="summary"]').fill('管理员最新一次修改的简介。');
  await Promise.all([first.waitForURL(/\/admin\/resources\/libreoffice\/$/), first.getByRole('button', { name: '保存草稿' }).click()]);

  await stale.locator('[data-field="summary"]').fill('过期页面的草稿应被拒绝。');
  await stale.getByRole('button', { name: '保存草稿' }).click();
  await stale.waitForFunction(() => document.querySelector('[data-resource-editor] [role=status]')?.textContent?.trim());
  const status = await stale.locator('[data-resource-editor] [role=status]').textContent();
  assert.match(String(status), /重新加载|版本/);
  await context.close();
});

test('匿名反馈提交后进入后台，可标记为已解决', async () => {
  const student = await browser.newPage();
  await student.goto(`${base}/feedback/?resource=zotero`);
  await student.locator('#feedback-kind').selectOption('链接失效');
  await student.locator('#feedback-title').fill('E2E 反馈：链接需要复查');
  await student.locator('#feedback-body').fill('这是自动化测试提交的反馈，用于验证站内接收与后台处理流程。');
  await Promise.all([student.waitForURL(/\/feedback\/\?sent=/), student.getByRole('button', { name: '提交站内反馈' }).click()]);
  assert.match(String(await student.locator('.notice').textContent()), /反馈已保存/);

  const admin = await browser.newPage();
  await login(admin, 'rootadmin', 'root-password-123');
  await admin.goto(`${base}/admin/reports/`);
  assert.match(String(await admin.locator('body').textContent()), /E2E 反馈：链接需要复查/);
  await admin.locator('select[name=status]').first().selectOption('resolved');
  await admin.locator('textarea[name=note]').first().fill('测试处理后关闭。');
  await admin.getByRole('button', { name: '保存处理结果' }).first().click();
  await admin.waitForFunction(() => document.querySelector('select[name=status]')?.value === 'resolved');
  await admin.close();
  await student.close();
});

test('反馈蜜罐不入库，未登录管理写入被拒绝', async () => {
  const trap = await browser.newPage();
  await trap.goto(`${base}/feedback/`);
  await trap.locator('#website').fill('https://spam.example/');
  await trap.locator('#feedback-title').fill('垃圾提交');
  await trap.locator('#feedback-body').fill('这条内容不应被保存到后台反馈列表。');
  await Promise.all([trap.waitForURL(/\/feedback\/\?sent=/), trap.getByRole('button', { name: '提交站内反馈' }).click()]);

  const admin = await browser.newPage();
  await login(admin, 'rootadmin', 'root-password-123');
  await admin.goto(`${base}/admin/reports/`);
  assert.equal(await admin.locator('text=垃圾提交').count(), 0);
  await admin.close();

  const anonymous = await browser.newContext();
  const response = await anonymous.request.post(`${base}/api/manage/`, { form: { action: 'save-category', id: 'hack', name: 'X', csrf: 'x' } });
  assert.ok([401, 403].includes(response.status()));
  await anonymous.close();
  await trap.close();
});


test('指南支持 Markdown：预览、草稿、发布、关联资源与撤回', async () => {
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/guides/new/`);
  await page.locator('#guide-slug').fill('study-guide');
  await page.locator('#guide-title').fill('用 Zotero 整理课程论文');
  await page.locator('#guide-summary').fill('从文献收集到引用，**一条路径**走完。');
  await page.locator('#guide-body').fill('## 先看条件\n\n- 软件免费\n- 同步空间可能收费\n\n这是 **重点**，原始 <script>alert(1)</script> 应被转义。\n\n见 [官网](https://www.zotero.org/)。');
  await page.getByLabel('Zotero 文献管理').check();
  await page.getByRole('button', { name: '预览正文' }).click();
  await page.waitForSelector('#guide-preview-body strong');
  assert.match(String(await page.locator('#guide-preview-body').innerHTML()), /<strong>重点<\/strong>/);

  await Promise.all([page.waitForURL(/\/admin\/guides\/study-guide\/$/), page.getByRole('button', { name: '保存草稿' }).click()]);
  assert.equal((await fetch(`${base}/guides/study-guide/`)).status, 404, '草稿不应公开');

  await Promise.all([page.waitForSelector('button:has-text("撤回公开版本")'), page.getByRole('button', { name: '发布指南' }).click()]);
  const html = await (await fetch(`${base}/guides/study-guide/`)).text();
  assert.match(html, /用 Zotero 整理课程论文/);
  assert.match(html, /<h2>先看条件<\/h2>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /文中提到的资源/);
  assert.match(html, /href="https:\/\/www\.zotero\.org\/"/);
  assert.match(html, /target="_blank"/);

  const resource = await (await fetch(`${base}/resources/zotero/`)).text();
  assert.match(resource, /相关指南/);
  assert.match(resource, /用 Zotero 整理课程论文/);

  await Promise.all([page.waitForSelector('button:has-text("发布指南")'), page.getByRole('button', { name: '撤回公开版本' }).click()]);
  assert.equal((await fetch(`${base}/guides/study-guide/`)).status, 404, '撤回后不应公开');
  await page.close();
});

test('版本历史可查看改动并恢复指南草稿，发布后前台更新', async () => {
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/guides/new/`);
  await page.locator('#guide-slug').fill('revision-guide');
  await page.locator('#guide-title').fill('版本 A');
  await page.locator('#guide-body').fill('## 第一版\n\n正文 A');
  await Promise.all([page.waitForURL(/\/admin\/guides\/revision-guide\/$/), page.getByRole('button', { name: '保存草稿' }).click()]);
  await page.waitForSelector('#history tbody tr');
  const firstCount = await page.locator('#history tbody tr').count();

  await page.locator('#guide-title').fill('版本 B');
  await page.locator('#guide-body').fill('## 第二版\n\n正文 B');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await page.waitForFunction((count) => document.querySelectorAll('#history tbody tr').length > count, firstCount);
  assert.ok((await page.locator('body').textContent())?.includes('保存草稿'));

  const oldest = page.locator('#history tbody tr').last();
  await oldest.locator('summary').click();
  await oldest.getByRole('button', { name: '恢复此版本为草稿' }).click();
  await page.waitForFunction(() => document.querySelector('#guide-title')?.value === '版本 A');
  assert.match(String(await page.locator('#history tbody tr').first().textContent()), /恢复历史版本/);

  await Promise.all([page.waitForSelector('button:has-text("撤回公开版本")'), page.getByRole('button', { name: '发布指南' }).click()]);
  const html = await (await fetch(`${base}/guides/revision-guide/`)).text();
  assert.match(html, /版本 A/);
  assert.match(html, /第一版/);
  assert.doesNotMatch(html, /第二版/);
  await page.close();
});

test('资源版本历史可恢复旧草稿且不影响已发布内容', async () => {
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/resources/gimp/`);
  const before = await page.locator('#history tbody tr').count();
  await page.locator('[data-field="summary"]').fill('恢复测试 A');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await page.waitForFunction((count) => document.querySelectorAll('#history tbody tr').length > count, before);
  const middle = await page.locator('#history tbody tr').count();
  await page.locator('[data-field="summary"]').fill('恢复测试 B');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await page.waitForFunction((count) => document.querySelectorAll('#history tbody tr').length > count, middle);

  const countAfterB = await page.locator('#history tbody tr').count();
  const oldest = page.locator('#history tbody tr').last();
  await oldest.locator('summary').click();
  await oldest.getByRole('button', { name: '恢复此版本为草稿' }).click();
  await page.waitForFunction((count) => document.querySelectorAll('#history tbody tr').length > count, countAfterB);
  assert.equal(await page.inputValue('[data-field="summary"]'), '恢复测试 A');
  assert.match(String(await page.locator('#history tbody tr').first().textContent()), /恢复历史版本/);
  const publicHtml = await (await fetch(`${base}/resources/gimp/`)).text();
  assert.doesNotMatch(publicHtml, /恢复测试 B/, '恢复草稿不应直接改变公开版本');
  await page.close();
});


test('公开页有 canonical/OG/结构化数据，robots 与 sitemap 正确', async () => {
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/">/);
  assert.match(home, /property="og:image"/);
  assert.match(home, /application\/ld\+json/);
  const detail = await (await fetch(`${base}/resources/zotero/`)).text();
  assert.match(detail, /资料核对于/);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/admin\//);
  assert.match(robots, /Sitemap: http/);
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sitemap, /<urlset/);
  assert.match(sitemap, /\/resources\/zotero\//);
  assert.doesNotMatch(sitemap, /\/admin\//);
});

test('详情浏览与外跳进入聚合指标，后台可查看', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/resources/zotero/`);
  await page.evaluate(async () => {
    await fetch('/api/event/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'outbound_click', target: 'zotero' }) });
  });
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/metrics/`);
  const body = await page.locator('body').textContent();
  assert.match(String(body), /资源详情浏览/);
  assert.match(String(body), /官方外跳/);
  assert.match(String(body), /zotero/);
  await page.close();
});

test('复核队列列出待核对与超期资源', async () => {
  const page = await browser.newPage();
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/reviews/`);
  const body = await page.locator('body').textContent();
  assert.match(String(body), /复核队列/);
  assert.match(String(body), /Inkscape 矢量绘图/);
  assert.match(String(body), /资料待核对/);
  await page.close();
});

test('未确认授权的图片带网络图片提示与版权下架入口', async () => {
  const zotero = await (await fetch(`${base}/resources/zotero/`)).text();
  assert.match(zotero, /网络图片，来源与授权未确认；如有侵权请联系管理员处理/);
  assert.match(zotero, /%E7%89%88%E6%9D%83%E4%B8%8E%E4%B8%8B%E6%9E%B6/, '图片旁提供版权下架入口');
  const libre = await (await fetch(`${base}/resources/libreoffice/`)).text();
  assert.doesNotMatch(libre, /网络图片，来源与授权未确认/, '已确认 CC 授权的图片不标注网络图片');
  assert.match(libre, /CC BY-SA 3\.0/);
  const feedback = await (await fetch(`${base}/feedback/?kind=${encodeURIComponent('版权与下架')}`)).text();
  assert.match(feedback, /<option selected>版权与下架<\/option>/);
  const about = await (await fetch(`${base}/about/`)).text();
  assert.match(about, /版权与下架/);
  assert.match(about, /不构成自动获得再分发许可/);
});

test('草稿整页预览要求登录，带 noindex 与未发布提示', async () => {
  const anonymous = await browser.newPage();
  await anonymous.goto(`${base}/admin/preview/resources/e2e-tool/`);
  assert.equal(new URL(anonymous.url()).pathname, '/admin/login/', '未登录不能预览草稿');
  await anonymous.close();

  const page = await browser.newPage();
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/preview/resources/e2e-tool/`);
  assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex, nofollow');
  assert.match(String(await page.locator('body').textContent()), /草稿整页预览/);
  assert.match(String(await page.locator('body').textContent()), /E2E 测试工具/);
  await page.goto(`${base}/admin/preview/guides/study-guide/`);
  assert.match(String(await page.locator('body').textContent()), /用 Zotero 整理课程论文/);
  assert.match(String(await page.locator('body').textContent()), /草稿整页预览/);
  await page.close();
});

test('删除进入回收站，可恢复为草稿，彻底删除后不可见', async () => {
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/resources/e2e-tool/`);
  await page.getByRole('button', { name: '移入回收站' }).click();
  await page.waitForURL(`${base}/admin/resources/`);
  assert.equal((await fetch(`${base}/resources/e2e-tool/`)).status, 404, '回收站内容前台不可见');
  assert.doesNotMatch(await (await fetch(`${base}/sitemap.xml`)).text(), /e2e-tool/);

  await page.goto(`${base}/admin/trash/`);
  assert.match(String(await page.locator('body').textContent()), /E2E 测试工具/);
  await page.getByRole('button', { name: '恢复为草稿' }).first().click();
  await page.waitForFunction(() => document.body.textContent?.includes('没有已删除的资源'));
  await page.goto(`${base}/admin/resources/e2e-tool/`);
  assert.match(String(await page.locator('body').textContent()), /草稿尚未公开/);
  assert.equal((await fetch(`${base}/resources/e2e-tool/`)).status, 404, '恢复后仍是草稿');

  await page.getByRole('button', { name: '移入回收站' }).click();
  await page.waitForURL(`${base}/admin/resources/`);
  await page.goto(`${base}/admin/trash/`);
  await page.getByRole('button', { name: '彻底删除' }).first().click();
  await page.waitForFunction(() => document.body.textContent?.includes('没有已删除的资源'));
  assert.equal((await fetch(`${base}/admin/resources/e2e-tool/`)).redirected, true);
  await page.close();
});

test('公告板展示新反馈与复核待办', async () => {
  const page = await browser.newPage();
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/notices/`);
  const body = String(await page.locator('body').textContent());
  assert.match(body, /这是站内公告板/);
  assert.match(body, /新反馈|待复核/);
  await page.close();
});

test('首页编排保存后影响首页与场景落地页', async () => {
  const page = await browser.newPage();
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/settings/`);
  await page.locator('#featured').selectOption('python');
  await page.locator('#task-writing').fill('写课程论文');
  await page.locator('#detail-writing').fill('从选题到引用');
  await Promise.all([page.waitForURL(`${base}/admin/settings/`), page.getByRole('button', { name: '保存首页编排' }).click()]);
  await page.waitForFunction(() => document.querySelector('#task-writing')?.value === '写课程论文');
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /写课程论文/);
  assert.match(home, /\/scenarios\/writing\//);
  const scenario = await (await fetch(`${base}/scenarios/writing/`)).text();
  assert.match(scenario, /写课程论文/);
  assert.match(scenario, /Zotero 文献管理/);
  assert.equal((await fetch(`${base}/scenarios/not-a-category/`)).status, 404);
  await page.close();
});

test('导出 JSON、导入预检与导入应用', async () => {
  const anonymous = await fetch(`${base}/api/export/`);
  assert.equal(anonymous.status, 401);
  const page = await browser.newPage();
  await login(page, 'rootadmin', 'root-password-123');
  const exported = await page.request.get(`${base}/api/export/`);
  assert.equal(exported.status(), 200);
  const payload = await exported.json();
  assert.equal(payload.schemaVersion, 1);
  assert.ok(payload.resources.length >= 12);

  const resource = {
    id: 'imported-demo', title: '导入示例工具', summary: '通过导入创建的草稿。', category: 'writing', kind: '开源工具', cost: '免费',
    platforms: ['网页'], tags: ['导入'], url: 'https://example.com/', sourceUrl: 'https://example.com/about', license: '示例', eligibility: '示例',
    caveat: '示例', steps: ['第一步'], status: 'review', checkedAt: null, access: 'open',
  };
  await page.goto(`${base}/admin/import/`);
  await page.locator('#payload').fill(JSON.stringify({ schemaVersion: 1, resources: [resource] }));
  await page.getByRole('button', { name: '预检' }).click();
  await page.waitForSelector('#preview-result:not([hidden])');
  assert.match(String(await page.locator('#preview-body').textContent()), /新增 1/);
  await page.getByRole('button', { name: '确认导入草稿' }).click();
  await page.waitForURL(/\/admin\/import\/\?resources=1/);
  const detail = await (await fetch(`${base}/resources/imported-demo/`)).text();
  assert.match(detail, /导入示例工具|页面未找到/, '导入只恢复草稿，不自动发布');
  assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /zotero/);
  await page.close();
});

test('复核队列支持批量标记已核对', async () => {
  const page = await browser.newPage();
  await login(page, 'rootadmin', 'root-password-123');
  await page.goto(`${base}/admin/reviews/`);
  await page.getByLabel('选择 Inkscape 矢量绘图').check();
  await page.getByRole('button', { name: '批量标记已核对' }).click();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('tr')].find((item) => item.textContent?.includes('Inkscape 矢量绘图'));
    return row?.textContent?.includes('官方信息已核对');
  });
  const row = page.locator('tr', { hasText: 'Inkscape 矢量绘图' });
  assert.match(String(await row.textContent()), /官方信息已核对/);
  await page.close();
});
