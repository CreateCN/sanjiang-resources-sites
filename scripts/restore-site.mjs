#!/usr/bin/env node
/**
 * 站点级恢复：数据库 + 媒体对象作为同一批次切换。
 *
 *   DATABASE_PATH=./data/site.sqlite MEDIA_DIR=./data/media \
 *     node scripts/restore-site.mjs --backup ./backups/site-YYYY-MM-DDTHH-MM-SS --yes
 *
 * 为什么不能用 restore-db：DB 与目录不是单个原子 rename，只换 DB 会制造
 * "新库指向旧图"或"旧库指向新图"的混合批次。本工具在暂存位置完整校验后才切换，
 * 失败时按日志回滚；切换后再次核对引用，仍未通过则回滚并报错。
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareRestoredDatabase, assertRestoreCounts } from '../src/server/restore-prepare.ts';
import { businessSummary, compareBusinessSummary } from '../src/server/restore-verify.ts';
import { collectReferencedMediaIds } from '../src/server/media-references.ts';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
const confirmed = args.includes('--yes');
const batch = resolve(option('--backup') ?? '');
const databasePath = resolve(option('--database') ?? process.env.DATABASE_PATH ?? './data/site.sqlite');
const mediaDir = resolve(option('--media') ?? process.env.MEDIA_DIR ?? './data/media');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const staging = join(dirname(databasePath), `.site-restore-${stamp}`);
const preserved = join(dirname(databasePath), `.site-restore-preserved-${stamp}`);
const objectsBackup = join(mediaDir, `objects.restore-${stamp}`);
const logPath = join(dirname(databasePath), `site-restore-${stamp}.log.json`);
const log = { event: 'site-restore', stamp, batch, databasePath, mediaDir, phases: [] };
// 测试钩子只在 NODE_ENV=test 时生效，用于注入切换失败与硬中断现场。
const testHook = process.env.NODE_ENV === 'test' ? (process.env.SITE_RESTORE_TEST_HOOK ?? '') : '';
const testMarker = process.env.SITE_RESTORE_TEST_MARKER ?? join(dirname(databasePath), '.restore-test-marker');

function writeJson(path, value) {
  const temporary = `${path}.tmp`;
  const descriptor = openSync(temporary, 'w', 0o600);
  try { writeSync(descriptor, JSON.stringify(value, null, 2)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
}
function fail(message, extra = {}) {
  log.status = 'error';
  log.message = message;
  try { writeJson(logPath, log); } catch { /* best effort */ }
  console.error(JSON.stringify({ ...log, ...extra }, null, 2));
  process.exit(1);
}
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function syncFile(path) {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function preserveDatabase() {
  if (!existsSync(databasePath)) {
    return { exists: false, format: null, database: null, business: null, walPresent: false };
  }
  const snapshot = join(preserved, 'site.sqlite');
  const walPresent = existsSync(`${databasePath}-wal`) && statSync(`${databasePath}-wal`).size > 0;
  let source;
  try {
    // VACUUM INTO 读取主库与匹配的已提交 WAL，生成不依赖 sidecar 的一致性回退副本。
    source = new DatabaseSync(databasePath);
    source.exec('PRAGMA busy_timeout=5000');
    source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  } finally { source?.close(); }
  chmodSync(snapshot, 0o600);
  syncFile(snapshot);
  const check = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const integrity = String(check.prepare('PRAGMA integrity_check').get()?.integrity_check);
    if (integrity !== 'ok') throw new Error('保全数据库副本完整性检查失败');
    return {
      exists: true,
      format: 'sqlite-vacuum-into/1',
      database: snapshot,
      digest: sha256File(snapshot),
      business: businessSummary(check),
      walPresent,
    };
  } finally { check.close(); }
}
function verifyRollbackState(original) {
  if (!original.exists) {
    if (existsSync(databasePath)) throw new Error('没有原库的失败恢复仍留下了候选数据库');
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${databasePath}${suffix}`)) throw new Error(`没有原库的失败恢复仍留下了 ${suffix} sidecar`);
    }
    return;
  }
  if (sha256File(databasePath) !== original.digest) throw new Error('回退后的主库与保全快照字节不一致');
  const check = new DatabaseSync(databasePath, { readOnly: true });
  let mediaIds;
  let references;
  try {
    const integrity = String(check.prepare('PRAGMA integrity_check').get()?.integrity_check);
    if (integrity !== 'ok') throw new Error('回退后的数据库完整性检查失败');
    const differences = compareBusinessSummary(original.business, businessSummary(check));
    if (differences.length > 0) throw new Error(`回退后的业务内容与原库不一致：${differences.join('；')}`);
    mediaIds = check.prepare('SELECT id FROM media').all().map((row) => String(row.id));
    references = collectReferencedMediaIds(check);
  } finally { check.close(); }
  const objects = join(mediaDir, 'objects');
  for (const id of new Set([...mediaIds, ...references])) {
    const problem = verifyBundleAt(objects, id);
    if (problem) throw new Error(`回退后的媒体校验失败：${problem}`);
  }
  for (const id of references) {
    if (!mediaIds.includes(id)) throw new Error(`回退后的数据库存在悬空图片引用：/media/${id}.webp`);
  }
}
function pauseForTest(phase) {
  if (testHook !== phase) return;
  writeFileSync(testMarker, 'ready', { mode: 0o600 });
  // 阻塞等待测试进程 SIGKILL，制造对象/数据库切换之间的硬中断现场。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}
function verifyBundleAt(objectsRoot, id) {
  const directory = join(objectsRoot, id);
  if (!existsSync(directory)) return `缺少对象目录 ${id}`;
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')); } catch { return `${id} 清单缺失`; }
  if (manifest.id !== id) return `${id} 清单与目录不一致`;
  for (const entry of [manifest.master, ...manifest.variants]) {
    const path = join(directory, entry.file);
    if (!existsSync(path)) return `${id} 缺文件 ${entry.file}`;
    if (sha256File(path) !== entry.sha256) return `${id} 文件哈希不符 ${entry.file}`;
  }
  return null;
}
/**
 * 引用集合必须与 purge/在线引用列表共用同一个提取器（media-references.ts）。
 * 这里显式传入只读连接：离线脚本绝不通过默认参数打开生产库。
 */
function referencedMediaIds(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return collectReferencedMediaIds(db); } finally { db.close(); }
}

if (!confirmed) {
  console.error('用法：node scripts/restore-site.mjs --backup <批次目录> [--database <目标库>] [--media <媒体目录>] --yes');
  console.error('请先停止 app、maintenance、定时任务与所有媒体任务。未做任何修改。');
  process.exit(2);
}
if (!batch || !existsSync(join(batch, 'COMPLETE'))) fail(`备份批次不完整或不存在：${batch}（缺少 COMPLETE 标记）`);
let manifest;
try { manifest = JSON.parse(readFileSync(join(batch, 'manifest.json'), 'utf8')); } catch { fail('备份缺少可读的 manifest.json'); }
if (manifest.format !== 'sanjiang-site-backup/1') fail(`不认识的备份格式：${manifest.format}`);

// 1. 校验备份自身：DB 哈希 + 每个文件哈希。
if (sha256File(join(batch, 'site.sqlite')) !== manifest.database.sha256) fail('备份数据库哈希不符，拒绝恢复');
for (const file of manifest.media.files) {
  const path = join(batch, file.path);
  if (!existsSync(path)) fail(`备份缺少文件：${file.path}`);
  if (statSync(path).size !== file.bytes || sha256File(path) !== file.sha256) fail(`备份文件校验失败：${file.path}`);
}
log.backup = { format: manifest.format, software: manifest.software ?? null, schema: manifest.schema ?? null };
log.phases.push({ phase: 'verify-backup', status: 'ok', files: manifest.media.files.length });
writeJson(logPath, log);

// 2. 暂存并再次校验。
mkdirSync(staging, { recursive: true, mode: 0o700 });
const stagedDb = join(staging, 'site.sqlite');
const stagedObjects = join(staging, 'media', 'objects');
copyFileSync(join(batch, 'site.sqlite'), stagedDb);
chmodSync(stagedDb, 0o600);
cpSync(join(batch, 'media', 'objects'), stagedObjects, { recursive: true });
for (const file of manifest.media.files) {
  const relative = file.path.replace(/^media\/objects\//, '');
  const path = join(stagedObjects, relative);
  if (!existsSync(path) || sha256File(path) !== file.sha256) fail(`暂存复制校验失败：${file.path}`);
}
log.phases.push({ phase: 'stage', status: 'ok' });
writeJson(logPath, log);

// 3. 在暂存库上迁移 + 认证净化；媒体行必须都能找到完整对象。
let prepared;
try {
  prepared = prepareRestoredDatabase(stagedDb, { allowMedia: true });
} catch (error) { fail(error instanceof Error ? error.message : '暂存数据库净化失败'); }
const staged = new DatabaseSync(stagedDb, { readOnly: true });
let mediaRows;
try {
  mediaRows = staged.prepare('SELECT id FROM media').all().map((row) => String(row.id));
} finally { staged.close(); }
// 业务计数与清单逐项核对（旧清单缺少的键跳过；内容摘要由 prepareRestoredDatabase 内部比较）。
for (const [table, expected] of Object.entries(manifest.database.counts ?? {})) {
  const actual = prepared.counts[table];
  if (actual === undefined) continue;
  if (Number(actual) !== Number(expected)) fail(`备份清单的 ${table} 计数与暂存库不一致（清单 ${expected}，暂存 ${actual}）`);
}
if (mediaRows.length !== Number(manifest.database.counts.media)) fail(`媒体登记数量与备份清单不一致（${mediaRows.length} vs ${manifest.database.counts.media}）`);
for (const id of mediaRows) {
  const problem = verifyBundleAt(stagedObjects, id);
  if (problem) fail(`暂存媒体校验失败：${problem}`);
}
for (const id of referencedMediaIds(stagedDb)) {
  if (!mediaRows.includes(id)) fail(`备份中存在悬空图片引用：/media/${id}.webp（媒体未登记）`);
}
const stagedIntegrity = new DatabaseSync(stagedDb, { readOnly: true });
try {
  if (String(stagedIntegrity.prepare('PRAGMA integrity_check').get()?.integrity_check) !== 'ok') fail('暂存数据库完整性检查失败');
} finally { stagedIntegrity.close(); }
log.business = prepared.business;
log.phases.push({ phase: 'prepare', status: 'ok', purge: prepared.purge, schema: prepared.schema });
writeJson(logPath, log);

// 4. 切换（记录每一步，失败按日志回滚）。
mkdirSync(preserved, { recursive: true, mode: 0o700 });
let original;
try { original = preserveDatabase(); } catch (error) {
  fail(error instanceof Error ? error.message : '原库一致性保全失败，未切换目标');
}
function preservedLog() {
  return {
    database: original.database,
    objects: objectsBackup,
    format: original.format,
    businessDigest: original.business?.digest ?? null,
    walPresent: original.walPresent,
    note: original.exists
      ? 'database 是 VACUUM INTO 生成的独立一致性快照，已包含原库匹配的已提交 WAL；回退时不要混用旧 sidecar'
      : '恢复前不存在原库，失败时只能移除候选库，不能声称已还原原库',
  };
}
log.preserved = preservedLog();
writeJson(logPath, log);

let objectsMoved = false;
let objectsInstalled = false;
let dbTouched = false;
function rollback() {
  const steps = [];
  try {
    if (objectsInstalled && existsSync(join(mediaDir, 'objects'))) rmSync(join(mediaDir, 'objects'), { recursive: true, force: true });
    if (objectsMoved && existsSync(objectsBackup)) renameSync(objectsBackup, join(mediaDir, 'objects'));
    if (objectsInstalled || objectsMoved) steps.push('objects-restored');
    if (dbTouched) {
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
      if (original.exists) {
        const temporary = `${databasePath}.rollback-${stamp}.tmp`;
        copyFileSync(original.database, temporary);
        chmodSync(temporary, 0o600);
        syncFile(temporary);
        rmSync(databasePath, { force: true });
        renameSync(temporary, databasePath);
        chmodSync(databasePath, 0o600);
        syncFile(databasePath);
        steps.push('db-restored');
      } else {
        rmSync(databasePath, { force: true });
        steps.push('db-removed');
      }
    }
    if (dbTouched || objectsInstalled || objectsMoved) {
      verifyRollbackState(original);
      steps.push('rollback-verified');
    }
  } catch (error) {
    steps.push(`rollback-error:${error instanceof Error ? error.message : 'unknown'}`);
  }
  return { steps, ok: !steps.some((step) => step.startsWith('rollback-error')) };
}
try {
  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  if (existsSync(join(mediaDir, 'objects'))) { renameSync(join(mediaDir, 'objects'), objectsBackup); objectsMoved = true; }
  renameSync(stagedObjects, join(mediaDir, 'objects'));
  objectsInstalled = true;
  log.phases.push({ phase: 'objects-installed', status: 'ok' });
  writeJson(logPath, log);
  pauseForTest('pause-after-objects');
  dbTouched = true;
  log.phases.push({ phase: 'db-swap-started', status: 'ok' });
  writeJson(logPath, log);
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  if (testHook === 'fail-after-sidecar-cleanup') throw new Error('注入测试失败：sidecar 已清理，数据库替换前中止');
  renameSync(stagedDb, databasePath);
  chmodSync(databasePath, 0o600);
  log.phases.push({ phase: 'swap', status: 'ok' });
  writeJson(logPath, log);
  pauseForTest('pause-after-swap');
  if (testHook === 'fail-after-swap') throw new Error('注入测试失败：数据库与对象已切换，校验前中止');
} catch (error) {
  const rolledBack = rollback();
  log.rollback = rolledBack.steps;
  log.rolledBack = rolledBack.ok;
  fail(error instanceof Error ? error.message : '切换失败', { rolledBack: rolledBack.ok });
}

// 5. 切换后复核：DB 计数、媒体完整性、引用完整。
try {
  const check = new DatabaseSync(databasePath, { readOnly: true });
  let counts;
  let integrity;
  try {
    integrity = String(check.prepare('PRAGMA integrity_check').get()?.integrity_check);
    const count = (table) => Number(check.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total ?? 0);
    counts = { resources: count('resources'), guides: count('guides'), users: count('users'), reports: count('reports'), revisions: count('revisions'), sessions: count('sessions'), login_challenges: count('login_challenges'), recovery_codes: count('recovery_codes') };
  } finally { check.close(); }
  if (integrity !== 'ok') throw new Error('切换后数据库完整性检查失败');
  assertRestoreCounts(counts, prepared, '恢复后的数据库');
  for (const id of mediaRows) {
    const problem = verifyBundleAt(join(mediaDir, 'objects'), id);
    if (problem) throw new Error(`切换后媒体校验失败：${problem}`);
  }
  for (const id of referencedMediaIds(databasePath)) {
    if (!mediaRows.includes(id)) throw new Error(`切换后存在悬空图片引用：/media/${id}.webp（媒体未登记）`);
    const problem = verifyBundleAt(join(mediaDir, 'objects'), id);
    if (problem) throw new Error(`切换后媒体校验失败：${problem}`);
  }
  log.status = 'restored';
  log.counts = manifest.database.counts;
  log.media = { objects: mediaRows.length, files: manifest.media.files.length };
  log.preserved = preservedLog();
  log.phases.push({ phase: 'verify', status: 'ok' });
  writeJson(logPath, log);
  console.log(JSON.stringify(log, null, 2));
} catch (error) {
  const rolledBack = rollback();
  log.rollback = rolledBack.steps;
  log.rolledBack = rolledBack.ok;
  fail(error instanceof Error ? error.message : '切换后复核失败', { rolledBack: rolledBack.ok });
}
