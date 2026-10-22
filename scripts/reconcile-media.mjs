#!/usr/bin/env node
/**
 * 离线媒体对账：核对 DB 账目、操作记录与实际文件，处理未提交对象与暂存残留。
 *
 *   node scripts/reconcile-media.mjs                       # 只报告（默认 dry-run）
 *   node scripts/reconcile-media.mjs --yes                 # 执行修复
 *   node scripts/reconcile-media.mjs --yes --clear-guard   # 确认写入者已停止时清除占位
 *   node scripts/reconcile-media.mjs --yes --purge-quarantine
 *
 * 前置条件：app、maintenance、定时任务与所有手动媒体脚本全部停止。
 * 规则（SECURITY-SPEC §6）：
 * - **不按超时或 PID 自动抢占**：占位存在时必须人工确认没有写入者，再用 --clear-guard 清除；
 * - 已提交资产只校验、不删除；未提交对象移入隔离区并报告，显式确认后才删除；
 * - 文件缺失或哈希不符时保持上传暂停（不清占位），输出可操作的错误。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mediaRoot, objectsDir, stagingRoot, quarantineRoot, verifyBundle, objectDirectories, stagingDirectories } from '../src/server/media.ts';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const clearGuard = args.includes('--clear-guard');
const purgeQuarantine = args.includes('--purge-quarantine');
const dbPath = resolve(process.env.DATABASE_PATH || './data/site.sqlite');

function fail(message, extra = {}) {
  console.error(JSON.stringify({ event: 'media-reconcile', status: 'error', message, ...extra }, null, 2));
  process.exit(1);
}

function directoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

if (!existsSync(dbPath)) fail(`找不到数据库：${dbPath}`);
if (!existsSync(mediaRoot())) fail(`找不到媒体目录：${mediaRoot()}（MEDIA_DIR）`);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=5000');

try {
  const guard = db.prepare('SELECT operation_id FROM media_store_guard WHERE id=1').get();
  const holder = guard?.operation_id ? String(guard.operation_id) : null;
  if (holder && !clearGuard) {
    fail('检测到未结算的媒体操作占位；请先确认 app/maintenance 与所有媒体写入者已停止，再加 --clear-guard 重试', { operationId: holder });
  }

  const operations = db.prepare('SELECT * FROM media_operations ORDER BY created_at').all();
  const mediaRows = db.prepare('SELECT * FROM media').all();
  const mediaById = new Map(mediaRows.map((row) => [String(row.id), row]));
  const known = new Set(mediaRows.map((row) => String(row.id)));
  const auditReconcile = (db, note) => {
    db.prepare('INSERT INTO audit (actor,action,target,created_at) VALUES (?,?,?,?)').run('cli', 'reconcile-media', note, new Date().toISOString());
  };
  const operationIds = new Set(operations.map((row) => String(row.id)));
  const result = { quarantined: [], removedStaging: [], released: [], orphaned: [], completedPurges: [], problems: [] };

  // 1. 逐条核对未完成操作。
  for (const operation of operations) {
    const id = String(operation.id);
    const mediaId = operation.media_id ? String(operation.media_id) : null;
    const objectPath = mediaId ? join(objectsDir(), mediaId) : null;
    const registered = mediaId ? mediaById.get(mediaId) : undefined;
    if (registered && registered.state === 'purging') {
      // 中断的彻底删除：对象在则隔离，随后补墓碑并删除媒体行，否则会永久卡在 purging。
      if (objectPath && existsSync(objectPath)) {
        const target = join(quarantineRoot(), `${id}-${mediaId.slice(0, 12)}`);
        if (apply) {
          mkdirSync(quarantineRoot(), { recursive: true, mode: 0o700 });
          if (existsSync(target)) rmSync(target, { recursive: true, force: true });
          renameSync(objectPath, target);
        }
        result.quarantined.push({ operation: id, media: mediaId, target });
      }
      if (apply) {
        db.prepare('INSERT OR IGNORE INTO media_tombstones (id,last_version,purged_at,reason,actor) VALUES (?,?,?,?,?)')
          .run(mediaId, Number(registered.version), new Date().toISOString(), String(registered.deleted_reason || ''), 'cli-reconcile');
        db.prepare('DELETE FROM media WHERE id=?').run(mediaId);
        auditReconcile(db, `completed purge ${mediaId}`);
      }
      result.completedPurges.push(mediaId);
    } else if (registered) {
      result.released.push({ operation: id, media: mediaId, reason: 'already registered' });
    } else if (objectPath && existsSync(objectPath)) {
      const target = join(quarantineRoot(), `${id}-${mediaId.slice(0, 12)}`);
      if (apply) {
        mkdirSync(quarantineRoot(), { recursive: true, mode: 0o700 });
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        renameSync(objectPath, target);
      }
      result.quarantined.push({ operation: id, media: mediaId, target });
    } else {
      result.released.push({ operation: id, media: mediaId, reason: 'no object installed' });
    }
    const staging = join(stagingRoot(), id);
    if (existsSync(staging)) {
      if (apply) rmSync(staging, { recursive: true, force: true });
      result.removedStaging.push(id);
    }
    if (apply) db.prepare('DELETE FROM media_operations WHERE id=?').run(id);
  }

  // 2. 已登记资产：只校验，不删除。（重新查询：上面的收尾可能已删除某些行）
  const remaining = db.prepare('SELECT id FROM media').all().map((row) => String(row.id));
  for (const id of remaining) {
    const verdict = verifyBundle(id);
    if (!verdict.ok) result.problems.push({ media: id, reason: verdict.reason });
  }

  // 3. 未登记对象与无主暂存目录：隔离而不是删除。
  for (const directory of objectDirectories()) {
    if (known.has(directory) || operationIds.has(directory)) continue;
    const target = join(quarantineRoot(), `orphan-${directory}`);
    if (apply) {
      mkdirSync(quarantineRoot(), { recursive: true, mode: 0o700 });
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(join(objectsDir(), directory), target);
    }
    result.orphaned.push(directory);
  }
  for (const directory of stagingDirectories()) {
    if (operationIds.has(directory)) continue;
    if (apply) rmSync(join(stagingRoot(), directory), { recursive: true, force: true });
    result.removedStaging.push(directory);
  }

  // 4. 隔离区统计（可选清理）。
  let quarantine = { entries: 0, bytes: 0, purged: false };
  if (existsSync(quarantineRoot())) {
    for (const entry of readdirSync(quarantineRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      quarantine.entries += 1;
      quarantine.bytes += directoryBytes(join(quarantineRoot(), entry.name));
      if (purgeQuarantine && apply) rmSync(join(quarantineRoot(), entry.name), { recursive: true, force: true });
    }
    quarantine.purged = Boolean(purgeQuarantine && apply);
  }

  const total = Number(db.prepare('SELECT COALESCE(SUM(total_bytes),0) AS n FROM media').get()?.n ?? 0);
  const reserved = Number(db.prepare('SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM media_operations').get()?.n ?? 0);

  const report = {
    event: 'media-reconcile',
    status: result.problems.length > 0 ? 'blocked' : (apply ? 'applied' : 'dry-run'),
    applied: apply,
    guard: holder,
    clearedGuard: Boolean(holder && clearGuard && apply),
    operations: operations.length,
    media: Number(db.prepare('SELECT COUNT(*) AS n FROM media').get()?.n ?? 0),
    totals: { totalBytes: total, reservedBytes: reserved, diskObjects: directoryBytes(objectsDir()) },
    quarantine,
    ...result,
  };

  if (result.problems.length > 0) {
    console.error(JSON.stringify({ ...report, hint: '存在哈希/文件问题，上传保持暂停；修复文件或从备份恢复后再运行本工具' }, null, 2));
    process.exitCode = 1;
  } else {
    if (apply && holder) db.prepare('UPDATE media_store_guard SET operation_id=NULL, updated_at=? WHERE id=1').run(Date.now());
    console.log(JSON.stringify(report, null, 2));
    if (!apply) {
      console.error('未做任何修改。确认全部媒体写入者已停止后，加 --yes 执行。');
      process.exitCode = 2;
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : '对账失败');
} finally {
  db.close();
}
