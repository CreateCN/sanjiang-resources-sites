#!/usr/bin/env node
/**
 * 验证 `docs/deploy/edge-cdn-hardening.md §3b.3` 里那条"假通过陷阱"：
 *
 * 不带 `Origin`（或与 `SITE_URL` 不一致）的认证请求会在**限流之前**被 `requireOrigin()`
 * 挡成 403，`rate_limits` 一条都不写。因此"站点计数远小于 500"这条检查在边缘规则
 * 完全没生效时也会通过——它证明不了任何事。
 *
 * 本脚本用真实 HTTP 处理函数复现这一点，并给出正向对照（带 Origin → 401 且计数 +1）。
 *
 * 运行：node reports/security/2026-10-25-auth-review/scripts/verify-origin-gate.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'sj-origin-gate-'));
process.env.DATABASE_PATH = join(root, 'site.sqlite');
process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64url');
delete process.env.SITE_URL;
delete process.env.TRUST_PROXY;
delete process.env.TRUST_PROXY_SECRET;

const store = await import('../../../../src/server/store.ts');
const http = await import('../../../../src/server/http.ts');
const auth = await import('../../../../src/server/auth.ts');
const { database, closeDatabase } = await import('../../../../src/server/db.ts');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const siteCount = () => Number(database().prepare('SELECT count FROM rate_limits WHERE key=?').get(`login-site:${hash('site')}`)?.count ?? 0);
const totalRows = () => Number(database().prepare('SELECT COUNT(*) AS total FROM rate_limits').get().total);

store.createInitialAdmin('operator', 'origin-gate-password-2026!');

const post = (origin) => http.totpPost({
  request: new Request('http://localhost/api/login/totp/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(origin === null ? {} : { Origin: origin }),
      Cookie: `${auth.CHALLENGE_COOKIE}=${'A'.repeat(43)}`,
    },
    body: new URLSearchParams({ code: '123456' }),
  }),
  clientAddress: '203.0.113.5',
});

const cases = [
  ['不带 Origin', null],
  ['跨站 Origin', 'https://evil.invalid'],
  ['同站但不同端口', 'http://localhost:9999'],
  ['正确 Origin', 'http://localhost'],
];

const rows = [];
for (const [label, origin] of cases) {
  const before = { site: siteCount(), total: totalRows() };
  const response = await post(origin);
  rows.push({
    label,
    status: response.status,
    siteDelta: siteCount() - before.site,
    keyDelta: totalRows() - before.total,
  });
}

console.log(JSON.stringify({ event: 'origin-gate', cases: rows }, null, 2));

const rejected = rows.filter((row) => row.label !== '正确 Origin');
const accepted = rows.find((row) => row.label === '正确 Origin');
const ok = rejected.every((row) => row.status === 403 && row.siteDelta === 0 && row.keyDelta === 0)
  && accepted.status === 401 && accepted.siteDelta === 1;
console.log(ok
  ? 'OK：无/错 Origin 在限流前就 403 且不写任何计数；正确 Origin 才计数'
  : 'FAIL：预期行为未复现');

closeDatabase();
rmSync(root, { recursive: true, force: true });
if (!ok) process.exitCode = 1;
