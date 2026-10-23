import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseTag, assertReleaseVersion, releaseInfo } from '../scripts/release-version.mjs';

test('发行标签只接受 vX.Y.Z 与 vX.Y.Z-rc.N', () => {
  assert.deepEqual(parseReleaseTag('v0.2.0'), { tag: 'v0.2.0', version: '0.2.0', prerelease: false });
  assert.deepEqual(parseReleaseTag('v0.3.0-rc.1'), { tag: 'v0.3.0-rc.1', version: '0.3.0-rc.1', prerelease: true });
  for (const tag of ['0.2.0', 'v0.2', 'v0.2.0.1', 'v0.2.0-beta.1', 'v0.2.0-rc', 'v0.2.0-rc.1-extra', 'v 0.2.0', '']) {
    assert.throws(() => parseReleaseTag(tag), /发行标签/);
  }
});

test('标签版本必须与 package.json 完全一致', () => {
  assert.equal(assertReleaseVersion('v0.2.0', '0.2.0').version, '0.2.0');
  assert.throws(() => assertReleaseVersion('v0.2.1', '0.2.0'), /package.json/);
  assert.throws(() => assertReleaseVersion('v0.3.0-rc.1', '0.3.0'), /package.json/);
  assert.deepEqual(releaseInfo('v0.3.0-rc.2', '0.3.0-rc.2'), {
    tag: 'v0.3.0-rc.2', version: '0.3.0-rc.2', prerelease: true, packageVersion: '0.3.0-rc.2',
  });
});
