import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildRevision } from '../scripts/build-revision.mjs';
const hash = 'abcdef01'.repeat(5);

test('构建版本优先使用显式版本、其次 CI、最后本地 Git', () => {
  assert.equal(resolveBuildRevision({ COMMIT_SHA: hash.toUpperCase() }, () => 'wrong'), hash);
  assert.equal(resolveBuildRevision({ GITHUB_SHA: hash }, () => 'wrong'), hash);
  assert.equal(resolveBuildRevision({}, () => hash), hash);
});
test('缺失或非法版本不会伪造提交链接，也不回退到无关提交', () => {
  assert.equal(resolveBuildRevision({}, () => { throw new Error('no git'); }), '');
  assert.equal(resolveBuildRevision({ COMMIT_SHA: '<script>' }, () => hash), '');
  assert.equal(resolveBuildRevision({ COMMIT_SHA: 'abcdef0' }, () => hash), '');
});
