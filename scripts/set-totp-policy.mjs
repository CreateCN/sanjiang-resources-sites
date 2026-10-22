#!/usr/bin/env node
/**
 * 离线切换双因素强制策略，并撤销受影响账户的旧认证证明。
 *
 *   node scripts/set-totp-policy.mjs --from off --to admin --yes
 *   # 然后在部署环境设置 TOTP_REQUIRED_FOR=admin 并重启
 *
 * 为什么需要这一步：旧会话、旧挑战与旧恢复码不会因为改了环境变量而失效。
 * 只改配置不执行本命令，等于让"策略变更前的证明"继续满足"策略变更后的要求"。
 * 同值重复执行是安全的（幂等撤销，不恢复任何旧证明）。
 *
 * 前置条件：app、maintenance 与其它写入者全部停止。
 */
import { applyTotpPolicy } from '../src/server/account.ts';
import { closeDatabase } from '../src/server/db.ts';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
const usage = `用法：node scripts/set-totp-policy.mjs --from <off|admin|admin,editor> --to <off|admin|admin,editor> --yes
作用：递增受影响账户的 auth_version，撤销其全部会话与登录挑战，并写审计（actor=cli）。
之后同步修改部署环境变量 TOTP_REQUIRED_FOR 并重启。`;
try {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
  const from = option('--from');
  const to = option('--to');
  if (!from || !to) { console.error(usage); process.exit(2); }
  if (!args.includes('--yes')) {
    console.error(JSON.stringify({ event: 'set-totp-policy', status: 'dry-run', from, to, note: '未做任何修改；确认已离线后加 --yes 执行' }, null, 2));
    process.exit(2);
  }
  const result = applyTotpPolicy(from, to);
  console.log(JSON.stringify({ event: 'set-totp-policy', status: 'applied', ...result, next: '设置 TOTP_REQUIRED_FOR 并重启应用' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'set-totp-policy', status: 'error', message: error instanceof Error ? error.message : '策略变更失败' }, null, 2));
  process.exitCode = 1;
} finally { closeDatabase(); }
