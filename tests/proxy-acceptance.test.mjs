import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeChild } from './fixtures/child-report.mjs';

// 隔离的项目根目录：不移动工作区 dist，不访问真实数据。
function runFixture(entrySource) {
  const root = mkdtempSync(join(tmpdir(), 'sj-proxy-gate-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../scripts/proxy-acceptance.mjs', import.meta.url), join(root, 'scripts/proxy-acceptance.mjs'));
    if (entrySource !== undefined) {
      mkdirSync(join(root, 'dist/server'), { recursive: true });
      writeFileSync(join(root, 'dist/server/entry.mjs'), entrySource);
    }
    const result = spawnSync(process.execPath, [join(root, 'scripts/proxy-acceptance.mjs')], {
      encoding: 'utf8', timeout: 45_000,
    });
    const detail = describeChild(result);
    assert.equal(result.status, 1, detail);
    let report;
    assert.doesNotThrow(() => { report = JSON.parse(result.stdout); }, detail);
    assert.equal(report.status, 'fail');
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('反代验收缺少构建产物时输出失败 JSON 并退出 1', () => {
  const report = runFixture();
  assert.equal(report.checks.find((check) => check.code === 'build-present').ok, false);
});

test('反代验收的应用提前退出时不能把启动失败记为通过', () => {
  const report = runFixture('process.exit(7);');
  const ready = report.checks.find((check) => check.code === 'app-ready');
  assert.equal(ready.ok, false);
  assert.match(ready.detail, /exitCode=7/);
});

test('反代验收的健康探测不响应时请求超时仍能输出失败结果', () => {
  const report = runFixture(`
    import http from 'node:http';
    http.createServer(() => {}).listen(Number(process.env.PORT), process.env.HOST);
  `);
  assert.equal(report.checks.find((check) => check.code === 'app-ready').ok, false);
});
