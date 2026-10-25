#!/usr/bin/env node
/**
 * 站点级一致性备份：数据库快照 + 全部已登记媒体对象 + 文件哈希清单。
 *
 *   DATABASE_PATH=./data/site.sqlite MEDIA_DIR=./data/media BACKUP_DIR=./backups \
 *     node scripts/backup-site.mjs [--keep 7]
 *
 * 前置条件：app、maintenance、定时任务与所有手动媒体任务全部停止；
 * 快照中的媒体占位必须为空（否则说明有未结算写入，不能称为一致性备份）。
 * 与 `backup-db.mjs` 的区别：后者只是数据库诊断快照，**不是**媒体站点的完整备份。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { objectsDir, mediaRoot, listMedia, verifyBundle } from '../src/server/media.ts';
import { resolveBuildRevision } from './build-revision.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
const databasePath = resolve(process.env.DATABASE_PATH || './data/site.sqlite');
const backupDir = resolve(process.env.BACKUP_DIR || './backups');
const keep = Math.max(1, Number.parseInt(option('--keep') ?? process.env.BACKUP_KEEP ?? '7', 10) || 7);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// 同一秒内多次备份不能互相覆盖（VACUUM INTO 要求目标不存在）。
const batch = join(backupDir, `site-${stamp}-${randomBytes(3).toString('hex')}`);

let batchCreated = false;
/** 失败时清掉**本次**创建的半成品批次；绝不动其他批次（目录名带时间戳与随机后缀）。 */
function removeOwnBatch() {
  if (!batchCreated) return false;
  batchCreated = false;
  try { rmSync(batch, { recursive: true, force: true }); return true; } catch { return false; }
}
function fail(message, extra = {}) {
  const removed = removeOwnBatch();
  console.error(JSON.stringify({ event: 'site-backup', status: 'error', message, ...(removed ? { batchRemoved: true } : {}), ...extra }, null, 2));
  process.exit(1);
}
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function walk(root, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

if (!existsSync(databasePath)) fail(`找不到数据库：${databasePath}`);
// 媒体根目录必须存在（否则 MEDIA_DIR 很可能指错了地方）；但 objects/ 可能还没创建：
// 从未上传过媒体的新实例只有空目录，备份应当照常生成完整批次。
if (!existsSync(mediaRoot())) fail(`找不到媒体目录：${mediaRoot()}（请确认 MEDIA_DIR 指向站点数据目录）`);
mkdirSync(objectsDir(), { recursive: true, mode: 0o700 });

// 1. 快照一致性前置：不能有未结算的媒体操作。
const source = new DatabaseSync(databasePath, { readOnly: true });
let counts;
let appliedMigrations;
try {
  source.exec('PRAGMA busy_timeout=5000');
  const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
  if (tables.has('media_store_guard')) {
    const holder = source.prepare('SELECT operation_id FROM media_store_guard WHERE id=1').get();
    if (holder?.operation_id) fail('存在未结算的媒体操作占位，备份不是一致性快照；请先停止写入者并运行 reconcile-media', { operationId: String(holder.operation_id) });
  }
  if (tables.has('media_operations')) {
    const pending = Number(source.prepare('SELECT COUNT(*) AS total FROM media_operations WHERE reserved_bytes > 0').get()?.total ?? 0);
    if (pending > 0) fail(`存在 ${pending} 条未结算的媒体操作；请先对账`);
  }
  const count = (table) => Number(source.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total ?? 0);
  counts = {
    categories: count('categories'), resources: count('resources'), guides: count('guides'),
    media: count('media'), users: count('users'), reports: count('reports'),
    revisions: count('revisions'), settings: count('settings'),
    // 旧库可能尚未跑 012；缺失时省略该计数，旧清单仍可恢复。
    ...(tables.has('sponsors') ? { sponsors: count('sponsors') } : {}),
  };
  appliedMigrations = source.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => String(row.id));
} finally { source.close(); }

// 2. 先校验现有对象：缺文件/哈希不符的站点不能生成"成功"的备份。
const broken = listMedia().map((row) => ({ id: row.id, verdict: verifyBundle(row.id) })).filter((entry) => !entry.verdict.ok);
if (broken.length > 0) fail(`媒体对象校验失败（${broken[0].id}: ${broken[0].verdict.reason}），请先对账或从更早的备份恢复`, { broken: broken.slice(0, 5) });

// 备份根目录可能还不存在（首次部署）；批次目录本身用非递归创建，
// 这样同名目录已存在时会失败而不是被复用。
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
try {
  mkdirSync(batch, { recursive: false, mode: 0o700 });
} catch (error) {
  fail(`无法创建备份批次目录：${batch}（${error instanceof Error ? error.message : '未知错误'}）`);
}
batchCreated = true;
chmodSync(batch, 0o700);

try {
  // 3. 数据库快照（VACUUM INTO 生成独立文件，不依赖 -wal）。
  const snapshot = join(batch, 'site.sqlite');
  const writer = new DatabaseSync(databasePath);
  try { writer.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`); } finally { writer.close(); }
  chmodSync(snapshot, 0o600);
  const dbHash = sha256File(snapshot);

  // 4. 复制媒体对象并计算清单。
  const sourceObjects = objectsDir();
  const targetObjects = join(batch, 'media', 'objects');
  mkdirSync(targetObjects, { recursive: true, mode: 0o700 });
  const files = [];
  let mediaBytes = 0;
  for (const relative of walk(sourceObjects)) {
    const from = join(sourceObjects, relative);
    const to = join(targetObjects, relative);
    mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
    chmodSync(to, 0o640);
    const bytes = statSync(to).size;
    mediaBytes += bytes;
    files.push({ path: `media/objects/${relative}`, bytes, sha256: sha256File(to) });
  }

  // 5. 复制后复算：任何不一致都不能标记批次完成。
  for (const file of files) {
    const copied = join(batch, file.path);
    if (statSync(copied).size !== file.bytes || sha256File(copied) !== file.sha256) fail(`复制后校验失败：${file.path}`);
  }
  for (const row of listMedia()) {
    const directory = join(targetObjects, row.id);
    if (!existsSync(directory)) fail(`备份缺少媒体对象：${row.id}`);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    for (const entry of [manifest.master, ...manifest.variants]) {
      const relative = `media/objects/${row.id}/${entry.file}`;
      const recorded = files.find((file) => file.path === relative);
      if (!recorded) fail(`备份缺少清单文件：${relative}`);
      if (recorded.sha256 !== entry.sha256) fail(`备份中 ${relative} 的哈希与清单不一致`);
    }
  }

  // 6. 清单 + 完成标记（最后写入，任何中断都不会留下"看似成功"的批次）。
  const manifest = {
    format: 'sanjiang-site-backup/1',
    createdAt: new Date().toISOString(),
    encodingVersion: 'webp-q82-effort4-v1',
    database: { file: 'site.sqlite', bytes: statSync(snapshot).size, sha256: dbHash, counts },
    media: { objects: counts.media, bytes: mediaBytes, files },
    software: {
      name: pkg.name,
      version: process.env.APP_VERSION?.trim() || pkg.version,
      license: pkg.license,
      commit: resolveBuildRevision(),
    },
    schema: { current: appliedMigrations.at(-1) ?? null, migrations: appliedMigrations },
    note: '恢复请使用 scripts/restore-site.mjs；本备份不含 TOTP_ENC_KEY 等密钥。',
  };
  writeFileSyncSafe(join(batch, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSyncSafe(join(batch, 'COMPLETE'), `${dbHash}\n`);

  // 7. 轮换：只保留完整批次。
  const batches = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^site-/.test(entry.name) && existsSync(join(backupDir, entry.name, 'COMPLETE')))
    .map((entry) => ({ name: entry.name, time: statSync(join(backupDir, entry.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const stale of batches.slice(keep)) rmSync(join(backupDir, stale.name), { recursive: true, force: true });

  console.log(JSON.stringify({
    event: 'site-backup', status: 'complete', batch, database: { sha256: dbHash, counts },
    media: { objects: counts.media, files: files.length, bytes: mediaBytes },
    kept: Math.min(batches.length, keep),
  }, null, 2));
} catch (error) {
  // 失败的批次既不标 COMPLETE，也不留在备份目录里：半成品被 restore 拒绝是对的，
  // 但让它长期堆在 backups/ 会让"数一下有几个目录"变成错误的健康判断。
  fail(error instanceof Error ? error.message : '备份失败');
}

function writeFileSyncSafe(path, content) {
  const temporary = `${path}.tmp`;
  const descriptor = openSync(temporary, 'w', 0o600);
  try { writeSync(descriptor, content); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
}
