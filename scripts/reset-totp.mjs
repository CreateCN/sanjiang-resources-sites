#!/usr/bin/env node
/**
 * 离线重置某账户的双因素认证。
 *
 *   DATABASE_PATH=./data/site.sqlite node scripts/reset-totp.mjs <用户名> \
 *     --reason "手机丢失，已当面核验身份" --yes
 *
 * 用途：唯一管理员丢失设备与恢复码，或加密密钥与备份不匹配。
 * - 不依赖 TOTP_ENC_KEY，不改口令、不改强制策略；
 * - 清空因子与恢复码、递增 auth_version/version、撤销全部会话与挑战、写审计（actor=cli）。
 * - 必须先停止 app、maintenance、定时任务与其它手动脚本；本工具不会替你判断容器是否在跑。
 */
import { cliResetTotp } from '../src/server/account.ts';
import { closeDatabase } from '../src/server/db.ts';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
const usage = `用法：node scripts/reset-totp.mjs <用户名> --reason "<原因>" --yes
前置条件：app、maintenance、定时任务与其它数据库脚本全部停止。
影响：清空该账户的双因素因子与恢复码，递增 auth_version/version，撤销全部会话与登录挑战。`;
try {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
  const reason = option('--reason');
  const username = args.find((argument) => !argument.startsWith('--') && argument !== reason);
  if (!username) { console.error(usage); process.exit(2); }
  if (!args.includes('--yes')) {
    // dry-run 不得写入任何东西：这里只报告计划。
    console.error(JSON.stringify({ event: 'reset-totp', status: 'dry-run', username, note: '未做任何修改；确认已离线后加 --yes 执行' }, null, 2));
    process.exit(2);
  }
  if (!reason) { console.error('必须用 --reason 说明重置原因（至少 4 个字符）'); process.exit(2); }
  const result = cliResetTotp(username, reason);
  console.log(JSON.stringify({ event: 'reset-totp', status: 'reset', ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'reset-totp', status: 'error', message: error instanceof Error ? error.message : '重置失败' }, null, 2));
  process.exitCode = 1;
} finally { closeDatabase(); }
