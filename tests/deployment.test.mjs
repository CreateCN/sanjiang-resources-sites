import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateDeployment } from '../scripts/check-deployment.mjs';
import { describeChild } from './fixtures/child-report.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'a'.repeat(32);

/**
 * 判定矩阵直接调用 `evaluateDeployment()`，**不起子进程**：
 * 终审在另一台机器上遇到"子进程退出但 stdout 为空"，导致 report=null、矩阵 5/5 失败。
 * 那种失败与配置判定本身无关，却会把真正的结论掩盖掉。判定逻辑在进程内验证；
 * CLI 契约（退出码、JSON 输出）由下面单独两条用例覆盖，失败信息带完整诊断。
 */
const judge = (env, strict = false) => evaluateDeployment({ NODE_ENV: 'production', ...env }, { strict });
const finding = (result, code) => result.findings.find((entry) => entry.code === code);

/** 跑一次 CLI；stdout 不是 JSON 时把子进程诊断一起带给断言，避免 null 上取属性变成 TypeError。 */
function runCli(env, args = []) {
  const run = spawnSync(process.execPath, ['scripts/check-deployment.mjs', ...args], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000,
  });
  let report = null;
  try { report = JSON.parse(run.stdout); } catch { /* 由调用方断言 */ }
  return { run, report, detail: `${describeChild(run)}${report ? '' : `；stdout=${JSON.stringify(String(run.stdout ?? '').slice(0, 400))}`}` };
}

test('判定矩阵：凭据齐全时 HTTPS 通过、HTTP 仅警告（strict 下升级为错误）', () => {
  const https = judge({ SITE_URL: 'https://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: SECRET });
  assert.equal(https.status, 'ok');
  assert.equal(https.strict, false);
  assert.equal(finding(https, 'trust-mode').level, 'info');
  assert.equal(finding(https, 'site-url-not-https'), undefined);

  const httpsStrict = judge({ SITE_URL: 'https://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: SECRET }, true);
  assert.equal(httpsStrict.status, 'ok', '严格模式不该让本来就合规的配置失败');

  const http = judge({ SITE_URL: 'http://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: SECRET });
  assert.equal(http.status, 'ok', '普通模式下 HTTP 只是警告');
  assert.equal(finding(http, 'site-url-not-https').level, 'warn');
  assert.equal(finding(http, 'site-url-not-https').raised, undefined);

  // 终审 P2：strict 必须把这条警告升级为错误，否则发布门禁的"降级也算失败"是空话。
  const httpStrict = judge({ SITE_URL: 'http://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: SECRET }, true);
  assert.equal(httpStrict.status, 'error');
  assert.equal(httpStrict.strict, true);
  const escalated = finding(httpStrict, 'site-url-not-https');
  assert.equal(escalated.level, 'error');
  assert.equal(escalated.raised, true, '要能看出这是被 strict 升级的警告');
  assert.match(escalated.message, /https/i);
});

test('判定矩阵：代理凭据缺失或过短在两种模式下都是错误', () => {
  for (const strict of [false, true]) {
    const missing = judge({ SITE_URL: 'https://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: '' }, strict);
    assert.equal(missing.status, 'error', `缺少凭据必须失败（strict=${strict}）`);
    assert.equal(finding(missing, 'proxy-secret-missing').level, 'error');
    assert.equal(finding(missing, 'proxy-secret-missing').raised, undefined, '这不是被升级的警告，而是原始错误');

    const weak = judge({ SITE_URL: 'https://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: 'short' }, strict);
    assert.equal(weak.status, 'error');
    assert.equal(finding(weak, 'proxy-secret-weak').level, 'error');
  }
});

test('判定矩阵：直连部署的转发头提示在 strict 下阻断', () => {
  const direct = judge({ SITE_URL: 'https://res.example.edu', TRUST_PROXY: '0' });
  assert.equal(direct.status, 'ok');
  assert.equal(finding(direct, 'proxy-header-check').level, 'warn');

  const strict = judge({ SITE_URL: 'https://res.example.edu', TRUST_PROXY: '0' }, true);
  assert.equal(strict.status, 'error');
  const hint = finding(strict, 'proxy-header-check');
  assert.equal(hint.level, 'error');
  assert.equal(hint.raised, true);
  assert.match(hint.message, /X-Forwarded-For|转发头/);
});

test('判定矩阵：SITE_URL 缺失或不合法是错误', () => {
  const missing = judge({ SITE_URL: '', TRUST_PROXY: '0' });
  assert.equal(finding(missing, 'site-url-missing').level, 'error');
  assert.equal(missing.status, 'error');

  const invalid = judge({ SITE_URL: 'res.example.edu', TRUST_PROXY: '0' });
  assert.equal(finding(invalid, 'site-url-invalid').level, 'error');
  assert.equal(invalid.status, 'error');
});

test('CLI 契约：合规配置退出 0 且输出可解析的 JSON', () => {
  const { run, report, detail } = runCli({ NODE_ENV: 'production', SITE_URL: 'https://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: SECRET });
  assert.equal(run.status, 0, detail);
  assert.ok(report, detail);
  assert.equal(report.status, 'ok');
  assert.equal(report.event, 'deployment-check');
});

test('CLI 契约：strict 下生产 HTTP 退出 1，且 JSON 标出被升级的项', () => {
  const { run, report, detail } = runCli({ NODE_ENV: 'production', SITE_URL: 'http://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: SECRET }, ['--strict']);
  assert.equal(run.status, 1, `strict 必须阻断；${detail}`);
  assert.ok(report, detail);
  assert.equal(report.status, 'error');
  assert.equal(report.strict, true);
  assert.equal(report.findings.find((entry) => entry.code === 'site-url-not-https').raised, true);
});

test('判定矩阵：边缘限速只做 info 提示，strict 不因它失败', () => {
  const result = judge({ SITE_URL: 'https://res.example.edu', TRUST_PROXY: '1', TRUST_PROXY_SECRET: SECRET }, true);
  const edge = finding(result, 'edge-rate-limit');
  assert.ok(edge, '必须有一条说明边缘限速无法自动判定的提示');
  assert.equal(edge.level, 'info', '不可自动判定的项必须是 info，否则 --strict 会永远失败');
  assert.match(edge.message, /人工确认|无法自动/);
  assert.doesNotMatch(edge.message, /已检测|已生效|检测到 Nginx/);
  assert.equal(result.status, 'ok', '严格模式不该被这条提示拖成失败');
});

test('部署自检不声称能检测端口发布或容器网络', () => {
  const source = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync("scripts/check-deployment.mjs","utf8"))'], {
    cwd: repo, encoding: 'utf8',
  }).stdout;
  assert.match(source, /不判断.*端口发布|不声称/, '脚本与注释都要明确能力边界');
  assert.doesNotMatch(source, /TRUSTED_PROXIES/, '对端网段方案已移除，不应残留配置项');
});
