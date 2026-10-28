#!/usr/bin/env node
/**
 * 断言敏感度检查：逐个把修复点改回旧行为（或删掉一处守卫），确认对应回归会失败。
 *
 * 为什么需要它：整文件回退到修复前的实现会在**模块加载阶段**就失败
 * （旧 `/api/import/preview.ts` 用无扩展名 import，测试无法装载），那只能证明
 * "旧代码跑不起来"，证明不了"某条断言真的盯着这个修复"。
 *
 * 用法：
 *   node reports/security/2026-10-25-auth-review/scripts/mutation-check.mjs
 *   node ... --only=M6,M7      # 只跑指定变异
 *
 * 约束：只临时改写工作区里的源码文件，**每个变异结束立即从内存中的原文恢复**；
 * 不提交、不构建、不联网。中途中断时工作区可能残留某个变异，`git diff` 可核对。
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

const AUTH = 'src/server/auth.ts';
const HTTP = 'src/server/http.ts';
const ACC = 'src/server/account.ts';
const ROUTE = 'src/pages/api/import/preview.ts';

/** 每个变异：撤销哪一处修复 + 应该因此变红的用例名前缀。 */
const MUTATIONS = [
  {
    id: 'M1', label: 'login() 把账号桶重新放进 enforceLimits', file: AUTH, pattern: 'SJ-A-01',
    from: '  enforceLimits(clientRules);\n',
    to: '  enforceLimits([...clientRules, userRule]);\n',
  },
  {
    id: 'M2', label: 'disable-totp 去掉证明预算', file: HTTP, pattern: 'SJ-A-02',
    from: "        withProofBudget(session.user.username, identity(context), { clearsOnSuccess: true }, () => {\n          disableTotp(session.user, text(form, 'password'), text(form, 'code'));\n        });\n",
    to: "        disableTotp(session.user, text(form, 'password'), text(form, 'code'));\n",
  },
  {
    id: 'M3', label: '垃圾 token 恢复 unknown 账号桶', file: AUTH, pattern: 'SJ-A-05',
    from: '  if (!challenge) settleChallengeFailure(null, client, null);\n',
    to: "  if (!challenge) settleChallengeFailure(null, client, { scope: 'totp-user', identity: 'unknown', maximum: TOTP_USER_MAX_FAILURES, windowMs: TOTP_WINDOW_MS });\n",
  },
  {
    id: 'M4', label: '失败结算去掉站点熔断', file: AUTH, pattern: 'SJ-A-04',
    from: '  const rules: LimitRule[] = [...clientLimitRules(client, TOTP_CLIENT_BUDGET, LOGIN_SITE_BUDGET)];\n',
    to: '  const rules: LimitRule[] = [...clientLimitRules(client, TOTP_CLIENT_BUDGET, null)];\n',
  },
  {
    id: 'M5', label: '导入预检授权退回读体之后', file: ROUTE, pattern: 'SJ-A-03',
    from: "    if (session.user.role !== 'admin') fail(403, '导入仅限管理员');\n\n    requireOrigin(request);\n    rateLimit('import-user', session.user.username, IMPORT_PREVIEW_USER_MAX, IMPORT_PREVIEW_WINDOW_MS);\n\n    // 与 /api/manage/ 共用同一套上限：预检能过的体积，提交也必须能过。\n    const { form } = await readForm(request, MANAGE_MAX_BYTES);\n    requireCsrf(request, String(form.get('csrf') ?? ''));\n",
    to: "    // 与 /api/manage/ 共用同一套上限：预检能过的体积，提交也必须能过。\n    const { form } = await readForm(request, MANAGE_MAX_BYTES);\n    if (session.user.role !== 'admin') fail(403, '导入仅限管理员');\n    requireOrigin(request);\n    rateLimit('import-user', session.user.username, IMPORT_PREVIEW_USER_MAX, IMPORT_PREVIEW_WINDOW_MS);\n    requireCsrf(request, String(form.get('csrf') ?? ''));\n",
  },
  {
    id: 'M6', label: '挑战验证去掉入口准入（已耗尽客户端仍推进站点桶）', file: AUTH, pattern: 'SJ-A-04',
    from: '  enforceLimits(clientLimitRules(client, TOTP_CLIENT_BUDGET, LOGIN_SITE_BUDGET));\n  const challenge = challengeRow(challengeToken);\n  // 垃圾/未知 token：',
    to: '  const challenge = challengeRow(challengeToken);\n  // 垃圾/未知 token：',
  },
  {
    id: 'M7', label: '预检路由删掉 CSRF 校验', file: ROUTE, pattern: 'SJ-A-03',
    from: "    requireCsrf(request, String(form.get('csrf') ?? ''));\n",
    to: '',
  },
  {
    id: 'M8', label: '预检路由删掉 payload 上限', file: ROUTE, pattern: 'SJ-A-03',
    from: "    if (new TextEncoder().encode(raw).length > IMPORT_MAX_BYTES) fail(413, '导入文件过大');\n",
    to: '',
  },
  {
    id: 'M9', label: 'regenerate-recovery 去掉证明预算', file: HTTP, pattern: 'SJ-A-02',
    from: "        const result = withProofBudget(session.user.username, identity(context), { clearsOnSuccess: true }, () =>\n          regenerateRecoveryCodes(session.user, text(form, 'password'), text(form, 'code')));",
    to: "        const result = regenerateRecoveryCodes(session.user, text(form, 'password'), text(form, 'code'));",
  },
  {
    id: 'M10', label: '证明预算去掉入口预检', file: ACC, pattern: 'SJ-A-02',
    from: '  enforceLimits(rules);\n  try {',
    to: '  try {',
  },
  {
    id: 'M11', label: 'errorShape 回显非 HttpError 的 message', file: HTTP, pattern: 'SJ-A-03',
    from: "const message = error instanceof HttpError ? error.message : '服务暂时不可用，请稍后重试';",
    to: "const message = error instanceof HttpError ? error.message : (error instanceof Error ? error.message : '服务暂时不可用，请稍后重试');",
  },
  {
    id: 'M12', label: '畸形证明退回"先结算后准入"', file: AUTH, pattern: 'SJ-A-04',
    from: "  const accountRule = input?.kind === 'recovery' ? recoveryAccountRule : totpAccountRule;\n  enforceLimits([accountRule]);\n  if (!input) settleChallengeFailure(challenge!.token_hash, client, totpAccountRule);\n",
    to: "  if (!input) settleChallengeFailure(challenge!.token_hash, client, totpAccountRule);\n  const accountRule = input!.kind === 'recovery' ? recoveryAccountRule : totpAccountRule;\n  enforceLimits([accountRule]);\n",
  },
];

const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice(7).split(',').map((id) => id.trim());
const selected = only ? MUTATIONS.filter((mutation) => only.includes(mutation.id)) : MUTATIONS;
let failures = 0;

for (const mutation of selected) {
  const path = resolve(ROOT, mutation.file);
  const original = await readFile(path, 'utf8');
  if (!original.includes(mutation.from)) {
    console.log(`${mutation.id}\tSKIP\t锚点未找到（${mutation.file}）`);
    failures += 1;
    continue;
  }
  try {
    await writeFile(path, original.replace(mutation.from, mutation.to), 'utf8');
    const { stdout, stderr } = await run(process.execPath, [
      '--test', `--test-name-pattern=${mutation.pattern}`, 'tests/auth-hardening.test.mjs',
    ], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }).catch((error) => error);
    const output = `${stdout ?? ''}${stderr ?? ''}`;
    const red = [...new Set(output.split('\n').filter((line) => line.startsWith('✖ SJ')).map((line) => line.trim()))];
    const passed = /^ℹ pass (\d+)$/m.exec(output)?.[1] ?? '?';
    const failed = /^ℹ fail (\d+)$/m.exec(output)?.[1] ?? '?';
    console.log(`${mutation.id}\t${red.length > 0 ? 'CAUGHT' : 'MISSED'}\t${mutation.label} → pass ${passed} / fail ${failed}`);
    for (const line of red) console.log(`\t${line}`);
    if (red.length === 0) failures += 1;
  } finally {
    await writeFile(path, original, 'utf8');
  }
}

console.log(`\n${failures === 0 ? 'ALL MUTATIONS CAUGHT' : `${failures} MUTATION(S) NOT CAUGHT`}`);
if (failures !== 0) process.exitCode = 1;
