#!/usr/bin/env node
/**
 * 反代联调验收（本地可重复执行）：把"必须在目标环境做一次"的那部分验证，
 * 在本地用**真实套接字**跑一遍，而不是靠单元测试的 `Request` 对象推断。
 *
 *   node scripts/proxy-acceptance.mjs            # 跑全部检查
 *   node scripts/proxy-acceptance.mjs --keep     # 失败时保留临时目录（含 server 日志与数据库）
 *
 * 它验证的是这件事：应用能否只凭"代理共享凭据 + 覆盖写的转发头"把请求归属到某个客户端，
 * 并在归属失败时**退化为站点级预算而不是共享一个访客额度**。
 *
 * 1. 起真实构建产物（`dist/server/entry.mjs`，`HOST=127.0.0.1`）；
 * 2. 起一个本地反代替身：覆盖写 `X-Forwarded-For`/`X-Real-IP`、剥掉客户端伪造的
 *    `X-Sanjiang-Proxy-Secret`、注入真实凭据——与 nginx/Caddy 片段做同样的三件事；
 * 3. 客户端 A 提交 6 次 → 前 5 次 303、第 6 次 429；客户端 B 仍拿独立额度；
 * 4. `rate_limits` 里出现**两个** `reports-client` 键（而不是一个共享的访客桶）；
 * 5. 直连应用端口伪造 `X-Forwarded-For`（无凭据/错凭据/有凭据无 XFF）→ **不产生任何**
 *    `reports-client` 键，全部只计入站点预算（终审 N-01 的回归点）；
 * 6. 凭据不出现在 server 日志、数据库文件与 WAL 里；
 * 7. 监听地址为回环（能用 `ss` 时核对，否则明确记为 skipped——不假装检测过）。
 *
 * **不替代**目标环境验收：真实反代软件的配置错误、CDN 回源改写、端口发布与
 * `log_format` 都属于部署侧，本地替身只能证明应用这一侧的行为。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const keep = process.argv.includes('--keep');
const clientBudget = 5;      // REPORTS_CLIENT_BUDGET.maximum
const CLIENT_A = '203.0.113.7';
const CLIENT_B = '203.0.113.8';
const FORM = new URLSearchParams({
  resourceId: '', kind: 'broken', title: '反代联调', body: '本地反代联调用的反馈正文', website: '',
});

const checks = [];
const record = (code, ok, detail) => checks.push({ code, ok, detail });
let retainedWorkdir;

function freePort() {
  return new Promise((done, fail) => {
    const probe = http.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/**
 * 提交一次反馈。`target` 是实际连的地址（直连还是走反代），`origin` 是浏览器会带上的站点源——
 * 两者必须分开：直连应用端口的那组请求仍然带**正确**的 Origin，否则它会在 Origin 校验处就被 403，
 * 根本走不到限流分支，测出来的"没有访客桶"就是假证据。
 */
async function submit(target, headers, origin = target) {
  const response = await fetch(`${target}/api/reports/`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: FORM,
    signal: AbortSignal.timeout(5_000),
  });
  return response.status;
}

function limitKeys(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare('SELECT key,count FROM rate_limits ORDER BY key').all().map((row) => ({ key: String(row.key), count: Number(row.count) }));
  } finally {
    db.close();
  }
}

function clearLimits(databasePath) {
  const db = new DatabaseSync(databasePath);
  try { db.exec('DELETE FROM rate_limits'); } finally { db.close(); }
}

/** 用 `ss` 读真实监听地址；没有该命令则返回 null（表示"未核对"，不是"通过"）。 */
function socketAddress(port) {
  return new Promise((done) => {
    const probe = spawn('ss', ['-lntH', `sport = :${port}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    probe.stdout.on('data', (chunk) => { out += chunk; });
    probe.once('error', () => done(null));
    probe.once('close', () => {
      const first = out.trim().split('\n').find((line) => line.trim());
      done(first ? first.trim().split(/\s+/)[3] ?? '' : '');
    });
  });
}

async function main() {
  const entry = join(root, 'dist', 'server', 'entry.mjs');
  if (!existsSync(entry)) {
    record('build-present', false, '缺少 dist/server/entry.mjs：先运行 npm run build（本检查只跑真实产物）');
    return;
  }
  record('build-present', true, statSync(entry).mtime.toISOString());

  const workdir = mkdtempSync(join(tmpdir(), 'sj-proxy-acceptance-'));
  if (keep) retainedWorkdir = workdir;
  const databasePath = join(workdir, 'site.db');
  const appPort = await freePort();
  const proxyPort = await freePort();
  const secretValue = randomBytes(32).toString('hex');
  const appBase = `http://127.0.0.1:${appPort}`;
  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  let output = '';
  let startupError;
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      // 只带必要变量：不继承调用者的 .env，避免把真实凭据混进实验。
      HOST: '127.0.0.1', PORT: String(appPort),
      SITE_URL: proxyBase,
      TRUST_PROXY: '1', TRUST_PROXY_SECRET: secretValue,
      DATABASE_PATH: databasePath, SITE_INIT_MODE: 'empty',
      ASTRO_TELEMETRY_DISABLED: '1',
    },
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.once('error', (error) => { startupError = error; });

  const proxy = http.createServer((request, response) => {
    const headers = { ...request.headers };
    // 客户端自己带的凭据头必须被丢弃：否则"知道头名"就等于能自证身份。
    delete headers['x-sanjiang-proxy-secret'];
    const who = String(headers['x-demo-client'] ?? '').toUpperCase();
    delete headers['x-demo-client'];
    if (who === 'A' || who === 'B') {
      const address = who === 'A' ? CLIENT_A : CLIENT_B;
      headers['x-forwarded-for'] = address;   // 覆盖写，与部署文档一致
      headers['x-real-ip'] = address;
    }
    headers['x-sanjiang-proxy-secret'] = secretValue;
    headers.host = `127.0.0.1:${proxyPort}`;
    const upstream = http.request({ host: '127.0.0.1', port: appPort, method: request.method, path: request.url, headers }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.setTimeout(5_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (error) => { response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  });

  try {
    await new Promise((done, fail) => {
      proxy.once('error', fail);
      proxy.listen(proxyPort, '127.0.0.1', done);
    });

    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (startupError || child.exitCode !== null || child.signalCode !== null) break;
      try {
        const probe = await fetch(`${appBase}/api/health/`, { redirect: 'manual', signal: AbortSignal.timeout(1_000) });
        if (probe.status === 200) { ready = true; break; }
      } catch { /* 还没监听 */ }
      await delay(200);
    }
    record('app-ready', ready, ready ? appBase : `应用未就绪（exitCode=${child.exitCode}，signal=${child.signalCode}）：${startupError?.message ?? output.slice(-400)}`);
    if (!ready) return;

    /* 1. 可信客户端：A 打满自己的额度，B 仍有独立额度。 */
    const a = [];
    for (let i = 0; i < clientBudget + 1; i += 1) a.push(await submit(proxyBase, { 'x-demo-client': 'A' }));
    const b = [];
    for (let i = 0; i < 2; i += 1) b.push(await submit(proxyBase, { 'x-demo-client': 'B' }));
    const expectedA = [...Array(clientBudget).fill(303), 429];
    record('client-a-budget', JSON.stringify(a) === JSON.stringify(expectedA), `A=${a.join(',')}（期望 ${expectedA.join(',')}）`);
    record('client-b-independent', JSON.stringify(b) === JSON.stringify([303, 303]), `B=${b.join(',')}（期望 303,303）`);

    const trusted = limitKeys(databasePath);
    const clientKeys = trusted.filter((row) => row.key.startsWith('reports-client:'));
    record('two-client-buckets', clientKeys.length === 2,
      `reports-client 键 ${clientKeys.length} 个：${clientKeys.map((row) => `${row.key.slice(-8)}=${row.count}`).join(',') || '(无)'}；`
      + `站点桶：${trusted.filter((row) => row.key.startsWith('reports-site:')).map((row) => row.count).join(',') || '(无)'}`);
    record('keys-are-hashed', !clientKeys.some((row) => row.key.includes(CLIENT_A) || row.key.includes(CLIENT_B)),
      '键里不出现明文本机地址（不可用于反查访客）');

    /* 2. 不可信身份：直连应用端口伪造转发头，只能落站点预算（N-01 回归）。 */
    clearLimits(databasePath);
    const spoof = [];
    for (let i = 0; i < 8; i += 1) spoof.push(await submit(appBase, { 'x-forwarded-for': `198.51.100.${10 + i}` }, proxyBase));
    for (let i = 0; i < 3; i += 1) spoof.push(await submit(appBase, { 'x-forwarded-for': `198.51.100.${50 + i}`, 'x-sanjiang-proxy-secret': 'f'.repeat(64) }, proxyBase));
    for (let i = 0; i < 3; i += 1) spoof.push(await submit(appBase, { 'x-sanjiang-proxy-secret': secretValue }, proxyBase));
    const untrusted = limitKeys(databasePath);
    const spoofedKeys = untrusted.filter((row) => row.key.startsWith('reports-client:'));
    const siteRow = untrusted.find((row) => row.key.startsWith('reports-site:'));
    record('no-client-bucket-without-secret', spoofedKeys.length === 0,
      `直连伪造 ${spoof.length} 次（状态 ${[...new Set(spoof)].join('/')}）产生 reports-client 键 ${spoofedKeys.length} 个`);
    record('site-budget-still-counts', Number(siteRow?.count ?? 0) === spoof.length,
      `站点桶计数 ${siteRow?.count ?? 0}（期望 ${spoof.length}）`);

    /* 3. 凭据不得落进日志与数据库。 */
    record('secret-not-in-logs', !output.includes(secretValue), output.includes(secretValue) ? '进程输出里出现了凭据' : '进程输出无凭据');
    const files = [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path));
    const leaked = files.filter((path) => readFileSync(path).includes(secretValue));
    record('secret-not-in-database', leaked.length === 0, leaked.length ? `出现于：${leaked.join(',')}` : `${files.length} 个数据库文件均无凭据`);

    /* 4. 监听地址：只采信 `ss` 的真实输出；没有 `ss` 就明确跳过，不假装检测过。 */
    const listening = await socketAddress(appPort);
    if (listening === null) {
      checks.push({ code: 'listen-loopback-only', ok: true, skipped: true, detail: '本机没有可用的 ss，跳过监听地址核对（用 ss -lntp / docker ps 人工确认）' });
    } else {
      record('listen-loopback-only', listening.startsWith('127.0.0.1:') || listening.startsWith('[::1]:'),
        `实际监听地址 ${listening}`);
    }
  } finally {
    proxy.close();
    proxy.closeAllConnections();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 5_000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (!keep) rmSync(workdir, { recursive: true, force: true });
  }

}

let executionError;
try {
  await main();
} catch (error) {
  executionError = error instanceof Error ? error.message : String(error);
}
// 所有路径（包括缺产物与启动失败时的提前返回）统一输出结果并设置失败退出码。
const failed = checks.some((check) => !check.ok);
process.stdout.write(`${JSON.stringify({
  event: 'proxy-acceptance',
  status: executionError || failed ? 'fail' : 'ok',
  error: executionError,
  workdir: retainedWorkdir,
  note: '本地反代替身只证明应用一侧；目标环境的真实反代、端口发布与 log_format 仍需人工确认',
  checks,
}, null, 2)}\n`);
process.exitCode = executionError ? 2 : failed ? 1 : 0;
