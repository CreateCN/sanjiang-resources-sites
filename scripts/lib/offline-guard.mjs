/**
 * 离线恢复前置检查：目标数据库是否仍被其他进程使用。
 *
 * 站点级恢复（restore-site）与数据库恢复（restore-db）必须用**同一套**判定，
 * 否则两条命令对"能不能现在恢复"给出不同答案——那正是 2026-10-25 审查里的
 * SJ-03：restore-db 会拒绝，restore-site 却照样替换文件，运行中的进程继续写旧
 * inode，恢复后提交的内容在重启时静默消失。
 *
 * 检测能力与限制（不要夸大）：
 * - 只在**同一个 PID 命名空间**内可靠。容器之间互相看不到对方的进程，
 *   因此 Docker 部署必须先 `docker compose stop app maintenance`，
 *   并确认没有别的容器挂载同一数据卷。工具不会声称能替代人工确认。
 * - 依据两条线索：进程是否打开了目标库/sidecar 的文件描述符；以及以本项目
 *   脚本或生产入口运行、且 `DATABASE_PATH` 指向目标库的进程。
 * - 没有 /proc 时返回 `supported: false`，调用方必须当作"未确认离线"处理。
 */
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export const KNOWN_DB_PROCESSES = new Set([
  'entry.mjs', 'maintenance.mjs', 'backup-db.mjs', 'check-links.mjs',
  'cleanup-metrics.mjs', 'create-admin.mjs', 'restore-db.mjs', 'security-audit.mjs',
  'reset-totp.mjs', 'set-totp-policy.mjs', 'reconcile-media.mjs',
  'backup-site.mjs', 'restore-site.mjs', 'cleanup-media.mjs',
]);

function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}
function processInfo(pid) {
  const base = `/proc/${pid}`;
  let cwd;
  try { cwd = readlinkSync(`${base}/cwd`); } catch { cwd = undefined; }
  let argv = [];
  try { argv = readFileSync(`${base}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { /* ignore */ }
  let env = [];
  try { env = readFileSync(`${base}/environ`, 'utf8').split('\0').filter(Boolean); } catch { /* ignore */ }
  return { cwd, argv, env };
}
function declaredDatabase(info, fallbackCwd) {
  const entry = info.env.find((value) => value.startsWith('DATABASE_PATH='));
  if (entry) return entry.slice('DATABASE_PATH='.length) === ':memory:' ? null : resolve(info.cwd ?? fallbackCwd, entry.slice('DATABASE_PATH='.length));
  if (info.cwd) return resolve(info.cwd, 'data/site.sqlite');
  return null;
}
function isProjectDbProcess(argv) {
  return argv.some((argument) => KNOWN_DB_PROCESSES.has(basename(argument)));
}

/**
 * 扫描同一 PID 命名空间内可能正在使用 `target` 的进程。
 * 只报告 PID、命令名与"是否已打开数据库文件"，不读取也不记录任何内容。
 */
export function detectDatabaseUsers(target) {
  if (!existsSync('/proc/self/fd')) return { supported: false, users: [] };
  const real = canonical(target);
  const watched = new Set([real, `${real}-wal`, `${real}-shm`]);
  const users = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const pid = Number(entry);
    const info = processInfo(pid);
    let descriptors = [];
    try { descriptors = readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    let opened = false;
    for (const descriptor of descriptors) {
      let link;
      try { link = readlinkSync(`/proc/${entry}/fd/${descriptor}`); } catch { continue; }
      const clean = link.replace(/ \(deleted\)$/, '');
      if (watched.has(clean) || watched.has(canonical(clean))) { opened = true; break; }
    }
    const declared = declaredDatabase(info, process.cwd());
    const named = isProjectDbProcess(info.argv);
    if (opened || (named && declared === real)) {
      users.push({ pid, command: info.argv.map((value) => basename(value)).join(' ') || 'unknown', opened });
    }
  }
  return { supported: true, users };
}

/** 面向运维的一句话描述（不含路径以外的隐私数据）。 */
export function describeUsers(users) {
  return users.map((user) => `PID ${user.pid}（${user.command}${user.opened ? '，已打开数据库' : ''}）`).join('；');
}

/** restore-db 与 restore-site 共用的拒绝文案。 */
export const OFFLINE_HINT = '请停止 app、maintenance、定时任务和手动脚本后重试；容器部署还需确认没有其他容器挂载同一数据卷';
