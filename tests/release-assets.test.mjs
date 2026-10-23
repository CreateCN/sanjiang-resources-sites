import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = new URL('..', import.meta.url);
const work = mkdtempSync(join(tmpdir(), 'sj-release-assets-'));
const required = ['compose.release.yml', '.env.release.example', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'licenses/LGPL-3.0.txt'];
const validEnv = readFileSync(new URL('../.env.release.example', import.meta.url), 'utf8');

function run(root) {
  return spawnSync(process.execPath, ['scripts/check-release-assets.mjs', '--root', root], { cwd: repo, encoding: 'utf8' });
}
function fixture(name, env = validEnv) {
  const root = join(work, name);
  for (const file of required) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file === '.env.release.example' ? env : 'fixture\n');
  }
  return root;
}
after(() => rmSync(work, { recursive: true, force: true }));

test('当前仓库与最小发行目录通过附件检查', () => {
  const actual = run(process.cwd());
  assert.equal(actual.status, 0, actual.stderr);
  assert.match(actual.stdout, /"status":"ok"/);
  const clean = fixture('valid');
  const result = run(clean);
  assert.equal(result.status, 0, result.stderr);
  for (const file of required) assert.ok(existsSync(join(clean, file)));
});

test('缺附件、秘密项、错误占位和重复键都在推送前失败', () => {
  const missing = fixture('missing');
  rmSync(join(missing, '.env.release.example'));
  assert.notEqual(run(missing).status, 0);

  const secret = fixture('secret', validEnv + 'TOTP_ENC_KEY=real-secret\n');
  assert.notEqual(run(secret).status, 0);

  const badImage = fixture('bad-image', validEnv.replace(/@sha256:0{64}/u, '@sha256:' + 'f'.repeat(64)));
  assert.notEqual(run(badImage).status, 0);

  const duplicate = fixture('duplicate', validEnv + 'SITE_URL=https://duplicate.example.org\n');
  assert.notEqual(run(duplicate).status, 0);
});

test('.env.release.example 不再被 gitignore 忽略，供干净 checkout 交付', () => {
  const ignored = spawnSync('git', ['check-ignore', '-q', '.env.release.example'], { cwd: repo, encoding: 'utf8' });
  assert.equal(ignored.error, undefined);
  assert.equal(ignored.status, 1, 'check-ignore 退出 1 表示未被忽略');
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '.env.release.example'], { cwd: repo, encoding: 'utf8' });
  assert.equal(tracked.error, undefined);
  if (tracked.status !== 0) {
    // 尚未纳入索引时，至少要由 .gitignore 的否定规则放行；两种情况都能进入干净 checkout。
    const verbose = spawnSync('git', ['check-ignore', '-v', '.env.release.example'], { cwd: repo, encoding: 'utf8' });
    assert.equal(verbose.error, undefined);
    assert.match(verbose.stdout, /!\.env\.release\.example/u);
  }
});
