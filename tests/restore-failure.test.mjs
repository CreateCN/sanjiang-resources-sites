import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { seedFixture } from './fixtures/content.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'sj-restore-failure-'));
process.env.DATABASE_PATH = join(root, 'boot.sqlite');
process.env.MEDIA_DIR = join(root, 'boot-media');
process.env.BACKUP_DIR = join(root, 'boot-backups');
process.env.SITE_INIT_MODE = 'empty';

const store = await import('../src/server/store.ts');
const media = await import('../src/server/media.ts');
const siteConfig = await import('../src/server/site-config.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');
const { applyMigrations, migrations } = await import('../src/server/migrations.ts');
const { prepareRestoredDatabase } = await import('../src/server/restore-prepare.ts');
const { businessSummary, compareBusinessSummary } = await import('../src/server/restore-verify.ts');

const PASSWORD = 'restore-failure-password-2026!';
function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function run(script, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000,
  });
}
function objectIds(mediaDir) {
  try { return readdirSync(join(mediaDir, 'objects')).sort(); } catch { return []; }
}
function logFile(dir) {
  const name = readdirSync(dir).find((entry) => entry.startsWith('site-restore-') && entry.endsWith('.log.json'));
  return name ? join(dir, name) : undefined;
}
function databaseFacts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check);
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total ?? 0);
    return {
      integrity,
      resources: count('resources'),
      reports: db.prepare('SELECT id,title,body,status FROM reports ORDER BY id').all().map((row) => ({ ...row })),
      authVersions: db.prepare('SELECT id,auth_version FROM users ORDER BY id').all().map((row) => ({ ...row })),
      business: businessSummary(db),
    };
  } finally { db.close(); }
}
function inspectDatabaseCopy(path) {
  const directory = mkdtempSync(join(root, 'inspect-'));
  const copy = join(directory, 'site.sqlite');
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (!existsSync(`${path}${suffix}`)) continue;
      copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
    }
    return databaseFacts(copy);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
async function makeSite(prefix) {
  const dir = mkdtempSync(join(root, prefix));
  const dbPath = join(dir, 'site.sqlite');
  const mediaDir = join(dir, 'media');
  const backupDir = join(dir, 'backups');
  const env = { DATABASE_PATH: dbPath, MEDIA_DIR: mediaDir, BACKUP_DIR: backupDir, SITE_INIT_MODE: 'empty' };
  const seeded = run('scripts/create-admin.mjs', [], { ...env, ADMIN_USERNAME: 'restoreadmin', ADMIN_PASSWORD: PASSWORD });
  assert.equal(seeded.status, 0, seeded.stderr);
  closeDatabase();
  process.env.DATABASE_PATH = dbPath;
  process.env.MEDIA_DIR = mediaDir;
  process.env.SITE_INIT_MODE = 'empty';
  const admin = store.listUsers()[0];
  seedFixture(database());
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#335577' } }).png().toBuffer();
  const view = await media.ingestUpload(admin, { bytes: png, name: 'shot.png', rights: 'confirmed', credit: '测试 / CC0' });
  const current = siteConfig.getBranding();
  const { schemaVersion, version, ...input } = current;
  siteConfig.saveBranding(admin, { ...input, logoMediaId: view.id, name: '恢复测试站' }, siteConfig.getBrandingAdminView().version);
  closeDatabase();
  const backup = run('scripts/backup-site.mjs', [], env);
  assert.equal(backup.status, 0, backup.stderr);
  const batch = JSON.parse(backup.stdout).batch;
  return { dir, dbPath, mediaDir, backupDir, batch, view, env };
}
function restoreArgs(site) {
  return ['--backup', site.batch, '--database', site.dbPath, '--media', site.mediaDir, '--yes'];
}
function restore(site, extraEnv = {}) {
  return run('scripts/restore-site.mjs', restoreArgs(site), { NODE_ENV: 'test', ...extraEnv });
}

test('未知迁移在应用、DB 恢复与站点恢复入口都被拒绝，且不写库', () => {
  const dir = mkdtempSync(join(root, 'future-'));
  const path = join(dir, 'future.sqlite');
  const db = new DatabaseSync(path);
  try {
    applyMigrations(db);
    db.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run('999-from-the-future', new Date().toISOString());
  } finally { db.close(); }

  const raw = new DatabaseSync(path);
  try {
    const before = Number(raw.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get().total);
    assert.throws(() => applyMigrations(raw), /不认识的迁移.*999-from-the-future/);
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get().total), before, '拒绝时不追加任何迁移');
  } finally { raw.close(); }

  closeDatabase();
  process.env.DATABASE_PATH = path;
  process.env.SITE_INIT_MODE = 'empty';
  assert.throws(() => database(), /不认识的迁移/);
  assert.throws(() => prepareRestoredDatabase(path, { allowMedia: true }), /不认识的迁移/);
});

test('业务摘要只允许认证净化与 restore-purge 审计变化', () => {
  const dir = mkdtempSync(join(root, 'summary-'));
  const path = join(dir, 'summary.sqlite');
  const db = new DatabaseSync(path);
  try {
    applyMigrations(db);
    db.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('u',?,'admin',1)")
      .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
    db.prepare("INSERT INTO settings (key,value) VALUES ('site','{}')").run();
    const before = businessSummary(db);
    db.prepare('UPDATE users SET auth_version=auth_version+1, totp_last_step=99').run();
    db.prepare("INSERT INTO audit (actor,action,target,created_at) VALUES ('cli','restore-purge','x',?)").run(new Date().toISOString());
    assert.deepEqual(compareBusinessSummary(before, businessSummary(db)), [], '认证字段与 restore-purge 审计不计入差异');
    db.prepare("INSERT INTO audit (actor,action,target,created_at) VALUES ('admin','save-resource','x',?)").run(new Date().toISOString());
    assert.ok(compareBusinessSummary(before, businessSummary(db)).some((line) => line.includes('audit')));
  } finally { db.close(); }
});

test('设置完整性：品牌 JSON 损坏或引用不存在的媒体时，迁移后、净化前拒绝恢复', () => {
  const dir = mkdtempSync(join(root, 'settings-'));
  const corruptPath = join(dir, 'corrupt.sqlite');
  const corrupt = new DatabaseSync(corruptPath);
  try {
    applyMigrations(corrupt);
    corrupt.prepare("INSERT INTO settings (key,value) VALUES ('branding','{ not json')").run();
  } finally { corrupt.close(); }
  assert.throws(() => prepareRestoredDatabase(corruptPath, { allowMedia: true }), /品牌设置|JSON/);

  const missingPath = join(dir, 'missing.sqlite');
  const missing = new DatabaseSync(missingPath);
  try {
    applyMigrations(missing);
    missing.prepare("INSERT INTO settings (key,value) VALUES ('branding',?)")
      .run(JSON.stringify({ schemaVersion: 1, version: 1, name: '测试', subtitle: '', description: '', footerText: '', organizationName: '', nonOfficialStatement: '', logoMediaId: 'a'.repeat(64), faviconMediaId: null, shareImageMediaId: null, accentColor: '#245c42', showProjectAttribution: true }));
  } finally { missing.close(); }
  assert.throws(() => prepareRestoredDatabase(missingPath, { allowMedia: true }), /媒体不存在/);
});

test('切换后校验前失败：自动回滚数据库与媒体，目标内容不变', async () => {
  const site = await makeSite('fail-after-swap-');
  const dbBefore = databaseFacts(site.dbPath);
  const objectsBefore = objectIds(site.mediaDir);
  const result = restore(site, { SITE_RESTORE_TEST_HOOK: 'fail-after-swap' });
  assert.notEqual(result.status, 0, '注入失败必须返回非零');
  assert.match(result.stderr, /注入测试失败/);
  const dbAfter = databaseFacts(site.dbPath);
  assert.equal(dbAfter.integrity, 'ok');
  assert.deepEqual(dbAfter.business, dbBefore.business, '数据库必须回滚为原业务内容');
  assert.deepEqual(dbAfter.authVersions, dbBefore.authVersions, '认证状态也必须回到恢复前');
  assert.deepEqual(objectIds(site.mediaDir), objectsBefore, '媒体目录必须还原');
  const log = JSON.parse(readFileSync(logFile(site.dir), 'utf8'));
  assert.ok(log.phases.some((phase) => phase.phase === 'swap'));
  assert.ok(Array.isArray(log.rollback) && log.rollback.includes('db-restored'), '日志必须记录回滚步骤');
  assert.ok(log.rollback.includes('rollback-verified'), '回退必须核对原业务记录、媒体与完整性');
  const preserved = readdirSync(site.dir).find((entry) => entry.startsWith('.site-restore-preserved-'));
  assert.ok(preserved && existsSync(join(site.dir, preserved, 'site.sqlite')), '故障现场必须保留一致性原库副本');
  process.env.DATABASE_PATH = site.dbPath;
  process.env.MEDIA_DIR = site.mediaDir;
  closeDatabase();
  assert.ok(store.getPublishedResources().length > 0, '回滚后的库仍可正常读取');
  closeDatabase();
});

test('失败回滚保留原库已提交但未 checkpoint 的 WAL', async () => {
  const site = await makeSite('fail-after-swap-wal-');
  const objectsBefore = objectIds(site.mediaDir);
  const writer = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.env.DATABASE_PATH);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL;');
    db.prepare('INSERT INTO reports (resource_id,kind,title,body,status,created_at) VALUES (?,?,?,?,?,?)')
      .run('zotero','bug','WAL 中的新反馈','失败回滚不能丢失这条已提交记录','new',new Date().toISOString());
    process.kill(process.pid, 'SIGKILL');
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {
    cwd: repo, env: { ...process.env, DATABASE_PATH: site.dbPath }, encoding: 'utf8',
  });
  assert.equal(crashed.error, undefined);
  assert.equal(crashed.signal, 'SIGKILL', '夹具进程必须被硬杀，留下真实 WAL');
  assert.equal(crashed.status, null);
  assert.equal(crashed.stderr, '');
  const wal = `${site.dbPath}-wal`;
  assert.ok(existsSync(wal) && statSync(wal).size > 0, '夹具必须留下非空 WAL');
  const before = inspectDatabaseCopy(site.dbPath);
  assert.deepEqual(before.reports.map((row) => row.title), ['WAL 中的新反馈'], '新反馈已提交到 WAL');

  const result = restore(site, { SITE_RESTORE_TEST_HOOK: 'fail-after-swap' });
  assert.notEqual(result.status, 0, '注入失败必须返回非零');
  const after = databaseFacts(site.dbPath);
  assert.equal(after.integrity, 'ok');
  assert.deepEqual(after.reports, before.reports, '自动回滚必须保留 WAL 中已提交的反馈');
  assert.deepEqual(after.business, before.business, '自动回滚必须恢复原业务内容');
  assert.deepEqual(after.authVersions, before.authVersions, '自动回滚必须恢复原认证状态');
  assert.deepEqual(objectIds(site.mediaDir), objectsBefore, '媒体目录必须还原');
  const log = JSON.parse(readFileSync(logFile(site.dir), 'utf8'));
  assert.equal(log.preserved.format, 'sqlite-vacuum-into/1');
  assert.ok(existsSync(log.preserved.database));
  assert.deepEqual(databaseFacts(log.preserved.database).reports, before.reports, '保全快照本身必须包含已提交 WAL');
  assert.ok(log.rollback.includes('db-restored'));
  assert.ok(log.rollback.includes('rollback-verified'));
});

test('sidecar 清理后、数据库替换前失败：回到一致的原库', async () => {
  const site = await makeSite('fail-after-sidecar-cleanup-');
  const before = databaseFacts(site.dbPath);
  const result = restore(site, { SITE_RESTORE_TEST_HOOK: 'fail-after-sidecar-cleanup' });
  assert.notEqual(result.status, 0);
  const after = databaseFacts(site.dbPath);
  assert.equal(after.integrity, 'ok');
  assert.deepEqual(after.business, before.business);
  assert.deepEqual(after.authVersions, before.authVersions);
  const log = JSON.parse(readFileSync(logFile(site.dir), 'utf8'));
  assert.ok(log.rollback.includes('db-restored'));
  assert.ok(log.rollback.includes('rollback-verified'));
});

test('原目标不存在时恢复失败：清除新库与 sidecar，不伪称原库已还原', async () => {
  const site = await makeSite('fail-new-target-');
  rmSync(site.dbPath);
  for (const suffix of ['-wal', '-shm']) rmSync(`${site.dbPath}${suffix}`, { force: true });
  const result = restore(site, { SITE_RESTORE_TEST_HOOK: 'fail-after-swap' });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(site.dbPath), false, '失败的新安装不能留下候选库');
  assert.equal(existsSync(`${site.dbPath}-wal`), false);
  assert.equal(existsSync(`${site.dbPath}-shm`), false);
  const log = JSON.parse(readFileSync(logFile(site.dir), 'utf8'));
  assert.ok(log.rollback.includes('db-removed'));
  assert.equal(log.rollback.includes('db-restored'), false, '没有原库时不能记录 db-restored');
  assert.equal(log.rolledBack, true);
});

test('对象切换后硬中断：日志可诊断，按记录恢复媒体即可回到原状态', async () => {
  const site = await makeSite('hard-kill-');
  const dbBefore = sha(site.dbPath);
  // 备份之后新增一个未登记对象，用来区分"旧目录"和"备份目录"。
  const orphan = join(site.mediaDir, 'objects', 'orphan-marker');
  (await import('node:fs')).mkdirSync(orphan, { recursive: true });
  (await import('node:fs')).writeFileSync(join(orphan, 'marker.txt'), 'original');
  const objectsWithOrphan = objectIds(site.mediaDir);

  const marker = join(site.dir, 'paused.marker');
  const child = spawn(process.execPath, ['scripts/restore-site.mjs', ...restoreArgs(site)], {
    cwd: repo,
    env: { ...process.env, NODE_ENV: 'test', SITE_RESTORE_TEST_HOOK: 'pause-after-objects', SITE_RESTORE_TEST_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    for (let index = 0; index < 100 && !existsSync(marker); index++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(existsSync(marker), '恢复进程必须到达对象切换后的暂停点');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('close', resolve));
    assert.equal(sha(site.dbPath), dbBefore, '数据库尚未切换，必须保持原字节');
    const log = JSON.parse(readFileSync(logFile(site.dir), 'utf8'));
    assert.ok(log.phases.some((phase) => phase.phase === 'objects-installed'), '日志必须记录已完成的阶段');
    assert.ok(log.preserved?.database && log.preserved?.objects, '日志必须给出保全与旧媒体目录路径');
    const backupObjects = readdirSync(site.mediaDir).find((entry) => entry.startsWith('objects.restore-'));
    assert.ok(backupObjects, '旧媒体目录必须已改名保全');
    assert.ok(existsSync(join(site.mediaDir, 'objects', site.view.id, 'master.webp')), '新目录来自备份');
    assert.notDeepEqual(objectIds(site.mediaDir), objectsWithOrphan, '当前目录是备份内容，尚未包含中断前的额外对象');
    // 文档化的恢复步骤：删掉已安装目录，把保全目录改回原名；数据库未动。
    rmSync(join(site.mediaDir, 'objects'), { recursive: true, force: true });
    renameSync(join(site.mediaDir, backupObjects), join(site.mediaDir, 'objects'));
    assert.deepEqual(objectIds(site.mediaDir), objectsWithOrphan, '恢复后媒体目录与原状态一致');
    assert.ok(existsSync(join(orphan, 'marker.txt')));
    process.env.DATABASE_PATH = site.dbPath;
    process.env.MEDIA_DIR = site.mediaDir;
    closeDatabase();
    assert.equal(media.verifyBundle(site.view.id).ok, true, '恢复后的媒体文件组完整');
    closeDatabase();
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('切换后硬中断：数据库已换成备份，按 preserved 副本恢复原库与媒体', async () => {
  const site = await makeSite('hard-kill-after-swap-');
  const dbBefore = databaseFacts(site.dbPath);
  const orphan = join(site.mediaDir, 'objects', 'orphan-after-swap');
  (await import('node:fs')).mkdirSync(orphan, { recursive: true });
  (await import('node:fs')).writeFileSync(join(orphan, 'marker.txt'), 'original');
  const objectsWithOrphan = objectIds(site.mediaDir);

  const marker = join(site.dir, 'swapped.marker');
  const child = spawn(process.execPath, ['scripts/restore-site.mjs', ...restoreArgs(site)], {
    cwd: repo,
    env: { ...process.env, NODE_ENV: 'test', SITE_RESTORE_TEST_HOOK: 'pause-after-swap', SITE_RESTORE_TEST_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let index = 0; index < 100 && !existsSync(marker); index++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(existsSync(marker));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('close', resolve));
    assert.notDeepEqual(databaseFacts(site.dbPath).authVersions, dbBefore.authVersions, '硬中断后目标已切换为净化后的备份库');
    const log = JSON.parse(readFileSync(logFile(site.dir), 'utf8'));
    assert.ok(log.phases.some((phase) => phase.phase === 'swap'));
    assert.ok(log.preserved?.database, '日志必须给出原库保全路径');
    const preservedDir = readdirSync(site.dir).find((entry) => entry.startsWith('.site-restore-preserved-'));
    const preservedDb = join(site.dir, preservedDir, 'site.sqlite');
    assert.deepEqual(databaseFacts(preservedDb).business, dbBefore.business, '保全副本必须是中断前的独立一致性快照');
    assert.deepEqual(databaseFacts(preservedDb).authVersions, dbBefore.authVersions);
    // 按文档恢复：删 sidecar，写回独立快照，恢复旧媒体目录。
    rmSync(`${site.dbPath}-wal`, { force: true });
    rmSync(`${site.dbPath}-shm`, { force: true });
    copyFileSync(preservedDb, site.dbPath);
    const backupObjects = readdirSync(site.mediaDir).find((entry) => entry.startsWith('objects.restore-'));
    rmSync(join(site.mediaDir, 'objects'), { recursive: true, force: true });
    renameSync(join(site.mediaDir, backupObjects), join(site.mediaDir, 'objects'));
    assert.deepEqual(databaseFacts(site.dbPath).business, dbBefore.business);
    assert.deepEqual(databaseFacts(site.dbPath).authVersions, dbBefore.authVersions);
    assert.deepEqual(objectIds(site.mediaDir), objectsWithOrphan);
    assert.ok(existsSync(join(orphan, 'marker.txt')));
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('旧清单缺少 software/schema 与新计数仍可恢复', async () => {
  const site = await makeSite('old-manifest-');
  const manifestPath = join(site.batch, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.software;
  delete manifest.schema;
  delete manifest.database.counts.categories;
  delete manifest.database.counts.settings;
  delete manifest.database.counts.sponsors;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const result = restore(site);
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.status, 'restored');
  assert.equal(outcome.backup.software, null);
  assert.equal(outcome.backup.schema, null);
});

test('旧备份迁移后获得空赞助表与关闭默认值', () => {
  const dir = mkdtempSync(join(root, 'legacy-sponsors-'));
  const path = join(dir, 'legacy.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of migrations
      .filter((entry) => entry.id !== '011-instance-configuration' && entry.id !== '012-sponsors')) {
      db.exec('BEGIN IMMEDIATE');
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, new Date().toISOString());
      db.exec('COMMIT');
    }
    db.prepare("INSERT INTO metadata (key,value) VALUES ('seeded','1')").run();
  } finally { db.close(); }
  const prepared = prepareRestoredDatabase(path, { allowMedia: true });
  assert.equal(prepared.counts.sponsors, 0);
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(Number(check.prepare('SELECT COUNT(*) AS total FROM sponsors').get().total), 0);
    assert.equal(check.prepare("SELECT 1 FROM settings WHERE key='sponsors'").get(), undefined, '缺省即关闭');
    assert.ok(check.prepare("SELECT 1 FROM schema_migrations WHERE id='012-sponsors'").get());
  } finally { check.close(); }
});

test('正常恢复：业务计数与摘要核对通过，设置与品牌完整', async () => {
  const site = await makeSite('normal-restore-');
  const result = restore(site);
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.status, 'restored');
  assert.equal(outcome.business.unchanged, true);
  assert.match(String(outcome.business.digest), /^[a-f0-9]{64}$/);
  assert.equal(outcome.phases.some((phase) => phase.phase === 'verify'), true);
});
