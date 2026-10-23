import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../compose.release.yml', import.meta.url), 'utf8');

test('Release workflow 不由 PR 触发，权限分离且只构建 amd64', () => {
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.match(workflow, /tags:\s*\n\s*- 'v\*'/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.equal((workflow.match(/^\s+packages: write$/gmu) ?? []).length, 1, 'packages:write 只能出现在镜像 job');
  assert.equal((workflow.match(/^\s+contents: write$/gmu) ?? []).length, 1, 'contents:write 只能出现在 Release job');
  assert.match(workflow, /^\s+actions: read$/mu, '需要读取同提交 CI 结果');
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs\?head_sha=/u);
  assert.match(workflow, /--platform linux\/amd64/u);
  assert.doesNotMatch(workflow, /linux\/arm64|--platform[^\n]*,[^\n]*/u, '不得声明未验证的多架构');
  assert.match(workflow, /password-stdin/u);
  assert.doesNotMatch(workflow, /ghcr\.io[^\n]*:latest/u);
  assert.match(workflow, /scripts\/release-check\.mjs/u);
  assert.match(workflow, /scripts\/verify-image\.sh/u);
  assert.doesNotMatch(workflow, /node\s+-e\b/u, '不要再使用 shell 内联 JS，避免引号被剥离');
  assert.match(workflow, /scripts\/release-metadata\.mjs tag/u);
  assert.match(workflow, /scripts\/release-metadata\.mjs image/u);
  assert.match(workflow, /scripts\/release-metadata\.mjs notes/u);
  assert.match(workflow, /scripts\/check-release-assets\.mjs/u);
  assert.match(workflow, /Check release assets before build/u);
});

test('Release Compose 只拉固定镜像，不构建源码', () => {
  assert.doesNotMatch(compose, /^\s+build:/mu);
  assert.equal((compose.match(/image: \$\{SITE_IMAGE:\?/g) ?? []).length, 2, 'app 与 maintenance 必须使用同一 SITE_IMAGE 变量');
  assert.match(compose, /pull_policy: always/u);
});
