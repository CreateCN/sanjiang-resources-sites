import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = new URL('..', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'sj-release-metadata-'));
const sha = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);

function run(args) {
  const result = spawnSync(process.execPath, ['scripts/release-metadata.mjs', ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return result;
}
function write(name, value) {
  const file = join(dir, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
function read(name) { return JSON.parse(readFileSync(join(dir, name), 'utf8')); }
after(() => rmSync(dir, { recursive: true, force: true }));

test('tag 元数据脚本可执行并写入完整 SHA', () => {
  const file = write('meta.json', { tag: 'v0.2.0', version: '0.2.0', prerelease: false, packageVersion: '0.2.0' });
  const result = run(['tag', file, sha]);
  assert.equal(result.status, 0, result.stderr);
  const meta = read('meta.json');
  assert.equal(meta.commit, sha);
  assert.equal(meta.version, '0.2.0');
  assert.match(readFileSync(file, 'utf8'), /\n$/);

  const before = readFileSync(file, 'utf8');
  const invalid = run(['tag', file, 'abc123']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /40 位/);
  assert.equal(readFileSync(file, 'utf8'), before, '失败不能改写元数据');
});

test('image 元数据生成 digest 引用；dry-run 与推送状态可区分', () => {
  const file = join(dir, 'image.json');
  const dry = run(['image', file, 'v0.2.0', '0.2.0', sha, 'ghcr.io/example/app:0.2.0', '', 'false']);
  assert.equal(dry.status, 0, dry.stderr);
  const dryMeta = read('image.json');
  assert.equal(dryMeta.pushed, false);
  assert.equal(dryMeta.digest, null);
  assert.equal(dryMeta.imageDigestRef, null);

  const pushed = run(['image', file, 'v0.2.0', '0.2.0', sha, 'ghcr.io/example/app:0.2.0', digest, 'true']);
  assert.equal(pushed.status, 0, pushed.stderr);
  const pushedMeta = read('image.json');
  assert.equal(pushedMeta.pushed, true);
  assert.equal(pushedMeta.imageDigestRef, `ghcr.io/example/app@${digest}`);

  const missingDigest = run(['image', file, 'v0.2.0', '0.2.0', sha, 'ghcr.io/example/app:0.2.0', '', 'true']);
  assert.notEqual(missingDigest.status, 0);
  const wrongVersion = run(['image', file, 'v0.2.1', '0.2.0', sha, 'ghcr.io/example/app:0.2.0', digest, 'true']);
  assert.notEqual(wrongVersion.status, 0);
});

test('notes 只在已推送且有 digest 时生成，含版本/SHA/digest/平台', () => {
  const file = join(dir, 'notes-image.json');
  writeFileSync(file, JSON.stringify({ tag: 'v0.2.0', version: '0.2.0', commit: sha, image: 'ghcr.io/example/app:0.2.0', digest: null, imageDigestRef: null, pushed: false, platform: 'linux/amd64' }));
  const dry = run(['notes', file, join(dir, 'dry.md')]);
  assert.notEqual(dry.status, 0);
  assert.match(dry.stderr, /digest/);

  assert.equal(run(['image', file, 'v0.2.0', '0.2.0', sha, 'ghcr.io/example/app:0.2.0', digest, 'true']).status, 0);
  const output = join(dir, 'release.md');
  const result = run(['notes', file, output]);
  assert.equal(result.status, 0, result.stderr);
  const notes = readFileSync(output, 'utf8');
  assert.match(notes, /0\.2\.0/);
  assert.match(notes, new RegExp(sha));
  assert.match(notes, new RegExp(digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(notes, /linux\/amd64/);
  assert.match(notes, /\n$/);
});

test('完整本地元数据调用与 workflow 使用同一脚本', () => {
  const check = spawnSync(process.execPath, ['scripts/release-check.mjs', 'v0.2.0'], { cwd: repo, encoding: 'utf8' });
  assert.equal(check.error, undefined);
  assert.equal(check.status, 0, check.stderr);
  const meta = write('flow-meta.json', check.stdout);
  assert.equal(run(['tag', meta, sha]).status, 0);
  const image = join(dir, 'flow-image.json');
  assert.equal(run(['image', image, 'v0.2.0', '0.2.0', sha, 'ghcr.io/example/app:0.2.0', digest, 'true']).status, 0);
  const notes = join(dir, 'flow-notes.md');
  assert.equal(run(['notes', image, notes]).status, 0);
  assert.match(readFileSync(notes, 'utf8'), /ghcr\.io\/example\/app@sha256:/);
});
