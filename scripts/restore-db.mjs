#!/usr/bin/env node
/**
 * 离线恢复站点数据库。
 *
 *   DATABASE_PATH=./data/site.sqlite node scripts/restore-db.mjs \
 *     --backup ./backups/site-YYYY-MM-DD.sqlite --yes
 *
 * 前置条件：应用、maintenance、定时任务和所有手动数据库脚本都必须停止。
 * 工具会在同一 PID 命名空间内扫描打开目标库/ sidecar 的进程，并检查以本项目
 * 脚本/生产入口运行且 DATABASE_PATH 指向目标的进程。Docker 中运行在独立容器时
 * 看不到其他容器的进程；部署文档要求先停止 app 与 maintenance，并确认没有其他
 * 容器挂载同一数据卷。工具不会声称能替代人工确认。
 *
 * 安全顺序：校验备份（完整性、必要表、schema 兼容性）→ 生成待写入副本并复检
 * → 保全当前主库与 -wal/-shm → 删除旧 sidecar → 原子替换 → 恢复后完整性/计数复检。
 * 任何替换后的检查失败都会尝试回滚到保全的副本，并保留失败库与诊断目录。
 */
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync, chownSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { migrations } from '../src/server/migrations.ts';
import { prepareRestoredDatabase, assertRestoreCounts } from '../src/server/restore-prepare.ts';

const REQUIRED_TABLES = {
  metadata: ['key', 'value'],
  categories: ['id', 'name'],
  resources: ['id', 'draft', 'published', 'version'],
  users: ['id', 'username', 'password_hash', 'role', 'active'],
  sessions: ['token_hash', 'user_id', 'expires_at'],
  reports: ['id', 'resource_id', 'kind', 'title', 'body', 'status'],
  guides: ['slug', 'draft', 'published', 'version'],
  revisions: ['id', 'entity_kind', 'entity_id', 'version', 'data', 'action'],
  events: ['day', 'name', 'target', 'count'],
  link_checks: ['resource_id', 'status'],
  rate_limits: ['key', 'count', 'reset_at'],
  settings: ['key', 'value'],
  audit: ['actor', 'action', 'target'],
  schema_migrations: ['id', 'applied_at'],
};
const KNOWN_MIGRATIONS = new Set(migrations.map((migration) => migration.id));
const KNOWN_DB_PROCESSES = new Set([
  'entry.mjs', 'maintenance.mjs', 'backup-db.mjs', 'check-links.mjs',
  'cleanup-metrics.mjs', 'create-admin.mjs', 'restore-db.mjs', 'security-audit.mjs',
  'reset-totp.mjs', 'set-totp-policy.mjs', 'reconcile-media.mjs',
  'backup-site.mjs', 'restore-site.mjs', 'cleanup-media.mjs',
]);
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
const assumeOffline = args.includes('--assume-offline');
const confirmed = args.includes('--yes');
const backupPath = resolve(option('--backup') ?? args.find((argument) => !argument.startsWith('--')) ?? '');
const databasePath = resolve(option('--database') ?? process.env.DATABASE_PATH ?? './data/site.sqlite');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function error(message, details = {}) {
  const failure = new Error(message);
  failure.details = details;
  throw failure;
}
function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}
function inspect(path, label) {
  if (!existsSync(path)) error(`${label}不存在：${path}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink()) error(`${label}是符号链接，请直接指定实际文件：${path}`);
  if (!info.isFile() || info.size === 0) error(`${label}不是有效的非空文件：${path}`);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000');
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => String(row.integrity_check));
    if (integrity.length !== 1 || integrity[0] !== 'ok') error(`${label}完整性检查失败：${integrity.join('；') || '无结果'}`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
    for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
      if (!tables.has(table)) error(`${label}缺少必要表：${table}`);
      const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
      const missing = columns.filter((column) => !actual.has(column));
      if (missing.length > 0) error(`${label}的 ${table} 表缺少字段：${missing.join('、')}`);
    }
    const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => String(row.id));
    if (applied.length === 0) error(`${label}没有 schema 迁移记录，无法确认兼容性`);
    const unknown = applied.filter((id) => !KNOWN_MIGRATIONS.has(id));
    if (unknown.length > 0) error(`${label}包含当前代码不认识的 schema 版本：${unknown.join('、')}`);
    // 较旧的已知 schema 允许恢复：应用启动时会按序补齐迁移；更新的版本必须拒绝。
    const schema = applied.at(-1);
    const counts = {};
    for (const table of Object.keys(REQUIRED_TABLES)) counts[table] = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total ?? 0);
    return { integrity: 'ok', schema, counts };
  } catch (failure) {
    if (failure?.details) throw failure;
    error(`${label}无法读取：${failure instanceof Error ? failure.message : '未知错误'}`);
  } finally { db?.close(); }
}
function currentProcessInfo(pid) {
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
function detectUsers(target) {
  if (!existsSync('/proc/self/fd')) return { supported: false, users: [] };
  const real = canonical(target);
  const watched = new Set([real, `${real}-wal`, `${real}-shm`]);
  const users = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const pid = Number(entry);
    const info = currentProcessInfo(pid);
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
function preserve(target) {
  if (!existsSync(target)) return { directory: null, files: [], consistent: false };
  const directory = `${target}.restore-${stamp}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const files = [];
  for (const file of [target, `${target}-wal`, `${target}-shm`]) {
    if (!existsSync(file)) continue;
    const destination = resolve(directory, basename(file));
    copyFileSync(file, destination);
    chmodSync(destination, 0o600);
    files.push(destination);
  }
  let consistent = false;
  const snapshot = resolve(directory, 'consistent.sqlite');
  let db;
  try {
    db = new DatabaseSync(target);
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    consistent = true;
    chmodSync(snapshot, 0o600);
  } catch { /* raw main + sidecar copies remain available */ }
  finally { db?.close(); }
  return { directory, files, consistent };
}
function copyDurable(source, destination) {
  copyFileSync(source, destination);
  const descriptor = openSync(destination, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  chmodSync(destination, 0o600);
}
function ownerFor(target) {
  try { return statSync(target); } catch { return statSync(dirname(target)); }
}
function restoreOwnership(path, owner) {
  try { chownSync(path, owner.uid, owner.gid); } catch { /* same-user runs cannot chown; mode still applies */ }
}
function rollback(target, preserved) {
  try {
    rmSync(target, { force: true });
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    // 目标原本不存在时没有旧库可回滚，删除失败的新库即可；失败副本已另存诊断。
    if (!preserved) return true;
    for (const file of preserved.files) {
      const destination = resolve(dirname(target), basename(file));
      copyFileSync(file, destination);
      chmodSync(destination, 0o600);
    }
    return true;
  } catch { return false; }
}
function main() {
  if (args.includes('--help')) {
    console.log('用法：node scripts/restore-db.mjs --backup <备份.sqlite> [--database <目标.sqlite>] --yes [--assume-offline]');
    return;
  }
  if (!option('--backup') && !args.find((argument) => !argument.startsWith('--'))) error('请用 --backup 指定备份文件');
  if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) error(`目标数据库是符号链接，拒绝替换链接本身；请直接指定实际文件：${databasePath}`);
  if (canonical(backupPath) === canonical(databasePath)) error('备份文件与目标数据库是同一个文件');
  const backupWal = `${backupPath}-wal`;
  if (existsSync(backupWal) && statSync(backupWal).size > 0) {
    error('备份旁边还有非空的 -wal 文件，说明它不是独立快照；请使用 scripts/backup-db.mjs 生成备份');
  }
  const source = inspect(backupPath, '备份文件');
  const offline = detectUsers(databasePath);
  if (!offline.supported && !assumeOffline) {
    error('当前系统没有 /proc，无法检查是否有进程正在使用数据库；确认全部使用方离线后加 --assume-offline 再执行');
  }
  if (offline.users.length > 0) {
    error(`检测到可能正在使用数据库的进程，已拒绝恢复：${offline.users.map((user) => `PID ${user.pid}（${user.command}${user.opened ? '，已打开数据库' : ''}）`).join('；')}。请停止 app、maintenance、定时任务和手动脚本后重试`);
  }
  const result = {
    event: 'database-restore', status: 'dry-run', database: databasePath, backup: backupPath,
    backupSchema: source.schema, backupCounts: source.counts,
    offlineCheck: offline.supported ? 'no matching processes' : 'unsupported (--assume-offline)',
    note: '工具只能检测同一 PID 命名空间内的进程；Docker 请先停止 app 与 maintenance，并确认没有其他容器挂载该数据卷。',
  };
  if (!confirmed) {
    console.log(JSON.stringify(result, null, 2));
    console.error('未做任何修改。确认全部数据库使用方已离线后，加 --yes 执行替换。');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(dirname(databasePath))) mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const temp = resolve(dirname(databasePath), `.${basename(databasePath)}.restore-${stamp}.tmp`);
  const owner = ownerFor(databasePath);
  let preserved = null;
  let installed = false;
  let mutated = false;
  try {
    copyDurable(backupPath, temp);
    restoreOwnership(temp, owner);
    const copy = inspect(temp, '待写入副本');
    if (copy.schema !== source.schema || JSON.stringify(copy.counts) !== JSON.stringify(source.counts)) error('备份复制后内容不一致，已取消恢复');
    const prepared = prepareRestoredDatabase(temp);
    assertRestoreCounts(inspect(temp, '净化后的副本').counts, prepared, '净化后的副本');
    result.authPurge = prepared.purge;
    preserved = preserve(databasePath);
    mutated = true;
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    renameSync(temp, databasePath);
    installed = true;
    chmodSync(databasePath, 0o600);
    restoreOwnership(databasePath, owner);
    const restored = inspect(databasePath, '恢复后的数据库');
    assertRestoreCounts(restored.counts, prepared, '恢复后的数据库');
    result.status = 'restored';
    result.integrity = restored.integrity;
    result.schema = restored.schema;
    result.counts = restored.counts;
    result.note = '恢复不保留任何认证证明：旧会话/挑战/恢复码已清除，auth_version 已递增，totp_last_step 已抬升；请先同步服务器时钟再让用户重新登录';
    result.preserved = preserved.directory;
    result.preservedConsistentSnapshot = preserved.consistent;
    result.preservedFiles = preserved.files.map((file) => basename(file));
    console.log(JSON.stringify(result, null, 2));
  } catch (failure) {
    const diagnostics = { ...result, status: 'error', message: failure instanceof Error ? failure.message : '恢复失败' };
    if (installed) {
      try {
        const failedCopy = resolve(preserved?.directory ?? dirname(databasePath), `failed-restored-${stamp}.sqlite`);
        copyFileSync(databasePath, failedCopy);
        chmodSync(failedCopy, 0o600);
        diagnostics.failedDatabase = failedCopy;
      } catch { /* best effort */ }
    }
    if (mutated) diagnostics.rolledBack = rollback(databasePath, preserved);
    if (preserved) diagnostics.preserved = preserved.directory;
    rmSync(temp, { force: true });
    console.error(JSON.stringify(diagnostics, null, 2));
    process.exitCode = 1;
  }
}
try { main(); } catch (failure) {
  console.error(JSON.stringify({ event: 'database-restore', status: 'error', message: failure instanceof Error ? failure.message : '恢复失败' }, null, 2));
  process.exitCode = 1;
}
