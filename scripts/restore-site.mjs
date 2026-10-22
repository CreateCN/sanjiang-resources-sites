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
  renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareRestoredDatabase, assertRestoreCounts } from '../src/server/restore-prepare.ts';

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
function referencedMediaIds(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const ids = new Set();
    const scan = (text) => {
      if (typeof text !== 'string') return;
      for (const match of text.matchAll(/\/media\/([a-f0-9]{64})\.webp/g)) ids.add(match[1]);
    };
    for (const row of db.prepare('SELECT draft,published FROM resources').all()) { scan(row.draft); scan(row.published); }
    for (const row of db.prepare('SELECT draft,published FROM guides').all()) { scan(row.draft); scan(row.published); }
    for (const row of db.prepare('SELECT data FROM revisions').all()) scan(row.data);
    return ids;
  } finally { db.close(); }
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
log.phases.push({ phase: 'verify-backup', status: 'ok', files: manifest.media.files.length });

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
log.phases.push({ phase: 'prepare', status: 'ok', purge: prepared.purge, schema: prepared.schema });

// 4. 切换（记录每一步，失败按日志回滚）。
mkdirSync(preserved, { recursive: true, mode: 0o700 });
let dbPreserved = false;
let objectsMoved = false;
let objectsInstalled = false;
let dbInstalled = false;
function rollback() {
  const steps = [];
  try {
    if (dbInstalled && dbPreserved) {
      copyFileSync(join(preserved, 'site.sqlite'), databasePath);
      chmodSync(databasePath, 0o600);
      steps.push('db-restored');
    }
    if (objectsInstalled && existsSync(join(mediaDir, 'objects'))) rmSync(join(mediaDir, 'objects'), { recursive: true, force: true });
    if (objectsMoved && existsSync(objectsBackup)) renameSync(objectsBackup, join(mediaDir, 'objects'));
    steps.push('objects-restored');
  } catch (error) {
    steps.push(`rollback-error:${error instanceof Error ? error.message : 'unknown'}`);
  }
  return steps;
}
try {
  if (existsSync(databasePath)) {
    copyFileSync(databasePath, join(preserved, 'site.sqlite'));
    chmodSync(join(preserved, 'site.sqlite'), 0o600);
    dbPreserved = true;
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) if (existsSync(sidecar)) copyFileSync(sidecar, join(preserved, sidecar.split('/').pop()));
  }
  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  if (existsSync(join(mediaDir, 'objects'))) { renameSync(join(mediaDir, 'objects'), objectsBackup); objectsMoved = true; }
  renameSync(stagedObjects, join(mediaDir, 'objects'));
  objectsInstalled = true;
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  renameSync(stagedDb, databasePath);
  chmodSync(databasePath, 0o600);
  dbInstalled = true;
  log.phases.push({ phase: 'swap', status: 'ok' });
} catch (error) {
  log.rollback = rollback();
  fail(error instanceof Error ? error.message : '切换失败');
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
  log.preserved = { database: join(preserved, 'site.sqlite'), objects: objectsBackup };
  log.phases.push({ phase: 'verify', status: 'ok' });
  writeJson(logPath, log);
  console.log(JSON.stringify(log, null, 2));
} catch (error) {
  log.rollback = rollback();
  fail(error instanceof Error ? error.message : '切换后复核失败', { rolledBack: true });
}
