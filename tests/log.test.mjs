import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logRequest } from '../src/server/log.ts';

function capture(run) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try { run(); } finally { console.log = original; }
  return logs;
}

test('请求日志只记录路径，不包含查询串', () => {
  const logs = capture(() => logRequest({ id: 'req-1', request: new Request('http://localhost/resources/zotero/?q=secret&token=abc'), status: 200, startedAt: process.hrtime.bigint() }));
  assert.equal(logs.length, 1);
  const line = JSON.parse(logs[0]);
  assert.equal(line.path, '/resources/zotero/');
  assert.equal(JSON.stringify(line).includes('secret'), false);
  assert.equal(JSON.stringify(line).includes('req-1'), true);
  assert.equal(typeof line.ms, 'number');
});

test('健康检查与静态资源不写日志', () => {
  const logs = capture(() => {
    logRequest({ id: 'a', request: new Request('http://localhost/api/health/'), status: 200, startedAt: process.hrtime.bigint() });
    logRequest({ id: 'b', request: new Request('http://localhost/_astro/app.js'), status: 200, startedAt: process.hrtime.bigint() });
  });
  assert.equal(logs.length, 0);
});
