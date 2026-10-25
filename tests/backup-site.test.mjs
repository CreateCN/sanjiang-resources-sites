import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { seedFixture } from './fixtures/content.ts';
import { withChildDiagnostics } from './fixtures/child-report.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'sj-site-backup-'));
const databasePath = join(root, 'site.sqlite');
const mediaDir = join(root, 'media');
const backupDir = join(root, 'backups');
process.env.DATABASE_PATH = databasePath;
process.env.MEDIA_DIR = mediaDir;
process.env.BACKUP_DIR = backupDir;
delete process.env.MEDIA_QUOTA_BYTES;

const store = await import('../src/server/store.ts');
const media = await import('../src/server/media.ts');
const siteConfig = await import('../src/server/site-config.ts');
const sponsors = await import('../src/server/sponsors.ts');
const { DEFAULT_BRANDING } = await import('../src/lib/site-config.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');

const PASSWORD = 'site-backup-password-2026!';

function run(script, args = [], extraEnv = {}) {
  return withChildDiagnostics(spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: databasePath, MEDIA_DIR: mediaDir, BACKUP_DIR: backupDir, ...extraEnv },
    encoding: 'utf8', timeout: 30000,
  }));
}
function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function objectIds() { try { return readdirSync(join(mediaDir, 'objects')).sort(); } catch { return []; } }
function backupBatches() { try { return readdirSync(backupDir).filter((name) => name.startsWith('site-')).sort(); } catch { return []; } }

let admin;
let view;
let brandingView;
let sponsorId;

function brandingInput(overrides = {}) {
  const { schemaVersion, version, ...rest } = DEFAULT_BRANDING;
  return { ...rest, ...overrides };
}

before(async () => {
  admin = store.createInitialAdmin('operator', PASSWORD);
  const editor = store.createUser(admin, 'editor', PASSWORD, 'editor');
  seedFixture(database());
  const bytes = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#224466' } }).png().toBuffer();
  view = await media.ingestUpload(editor, { bytes, name: 'shot.png', rights: 'confirmed', credit: '测试 / CC0' });
  // 一张只被站点品牌引用的图片：备份/恢复必须与内容引用同等对待。
  const brandingBytes = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#662244' } }).png().toBuffer();
  brandingView = await media.ingestUpload(editor, { bytes: brandingBytes, name: 'branding.png', rights: 'confirmed', credit: '测试 / CC0' });
  siteConfig.saveBranding(admin, brandingInput({ logoMediaId: brandingView.id, shareImageMediaId: brandingView.id }), siteConfig.getBrandingAdminView().version ?? 0);
  const sponsor = sponsors.createSponsor(admin, {
    title: '测试赞助', body: '备份恢复必须保留赞助与图片引用。', sponsorName: '测试赞助方',
    mediaId: brandingView.id, imageAlt: '赞助图片', targetUrl: 'https://sponsor.example.com/learn',
    placement: 'home-sidebar', enabled: true, startsAt: null, endsAt: null,
  });
  sponsorId = sponsor.id;
  sponsors.saveSponsorSettings(admin, { enabled: true }, 0);
  store.saveResource(admin, {
    id: 'site-backup-resource', title: '备份资源', summary: '引用媒体的资源', category: 'writing',
    kind: '开源工具', cost: '免费', platforms: ['网页'], tags: ['测试'],
    url: 'https://example.com/a', sourceUrl: 'https://example.com/b',
    license: 'MIT', eligibility: '无', caveat: '无', steps: ['打开'], status: 'review', checkedAt: null,
    image: view.src, imageAlt: '截图', imageRights: 'confirmed', imageCredit: '测试 / CC0',
    details: `正文 ![截图](${view.src})`,
  }, null);
  const managed = store.findManagedResource('site-backup-resource');
  store.changePublication(admin, 'site-backup-resource', managed.version, 'publish');
  // 一个用于验证"恢复会作废旧会话"的会话。
  database().prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run('f'.repeat(64), admin.id, Date.now() + 3600000, Date.now());
  closeDatabase();
});
after(() => { rmSync(root, { recursive: true, force: true }); });

test('站点备份包含 DB + 全部对象 + 哈希清单，批次以 COMPLETE 收尾', () => {
  const result = run('scripts/backup-site.mjs');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'complete');
  const batch = report.batch;
  assert.ok(existsSync(join(batch, 'COMPLETE')));
  const manifest = JSON.parse(readFileSync(join(batch, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'sanjiang-site-backup/1');
  assert.equal(manifest.database.sha256, sha(join(batch, 'site.sqlite')));
  assert.ok(manifest.media.files.some((file) => file.path.endsWith('master.webp')));
  assert.equal(manifest.database.counts.media, 2);
  assert.equal(manifest.database.counts.sponsors, 1);
  assert.equal(manifest.software.version, '0.2.0');
  assert.match(String(manifest.software.commit), /^[a-f0-9]{40}$|^$/, '有 Git 时写完整提交，源码归档可为空');
  assert.equal(manifest.software.license, 'MIT');
  assert.ok(manifest.schema.migrations.includes('011-instance-configuration'));
  assert.equal(manifest.schema.current, manifest.schema.migrations.at(-1));
  assert.match(JSON.stringify(manifest), /^\{/);
  assert.doesNotMatch(JSON.stringify(manifest.software), /TOTP_ENC_KEY|password|secret/i, '清单不写密钥');
  assert.ok(manifest.database.counts.resources >= 1);
});

test('恢复站点：DB 与媒体同批切换，认证证明被净化，引用仍可解析', () => {
  const backupRun = run('scripts/backup-site.mjs');
  assert.equal(backupRun.status, 0, backupRun.stderr);
  const batch = JSON.parse(backupRun.stdout).batch;
  const before = JSON.parse(readFileSync(join(batch, 'manifest.json'), 'utf8'));

  // 备份后制造差异：删除一个对象文件、新增一条反馈、增加一个会话。
  closeDatabase();
  rmSync(join(mediaDir, 'objects', view.id), { recursive: true, force: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare("INSERT INTO reports (kind,title,body,created_at) VALUES ('其他','备份后新增','备份之后写入的反馈正文',?)").run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run('e'.repeat(64), admin.id, Date.now() + 3600000, Date.now());
  db.close();

  const restore = run('scripts/restore-site.mjs', ['--backup', batch, '--database', databasePath, '--media', mediaDir, '--yes']);
  assert.equal(restore.status, 0, restore.stderr);
  const log = JSON.parse(restore.stdout);
  assert.equal(log.status, 'restored');
  assert.ok(objectIds().includes(view.id), '对象必须被恢复');
  assert.equal(media.verifyBundle(view.id).ok, true, '恢复后的文件组必须通过哈希校验');

  const check = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const report = check.prepare("SELECT COUNT(*) AS total FROM reports WHERE title='备份后新增'").get();
    assert.equal(Number(report.total), 0, '备份之后的写入不得出现');
    assert.equal(Number(check.prepare('SELECT COUNT(*) AS total FROM sessions').get().total), 0, '恢复必须清空会话');
    assert.equal(Number(check.prepare('SELECT COUNT(*) AS total FROM login_challenges').get().total), 0);
    assert.equal(Number(check.prepare('SELECT COUNT(*) AS total FROM recovery_codes').get().total), 0);
    const resource = JSON.parse(String(check.prepare("SELECT draft FROM resources WHERE id='site-backup-resource'").get().draft));
    assert.equal(resource.image, view.src);
    const branding = JSON.parse(String(check.prepare("SELECT value FROM settings WHERE key='branding'").get().value));
    assert.equal(branding.logoMediaId, brandingView.id, '品牌媒体引用必须随站点备份恢复');
    assert.equal(branding.shareImageMediaId, brandingView.id);
    assert.equal(media.verifyBundle(brandingView.id).ok, true, '品牌图片文件必须完整恢复');
    const user = check.prepare('SELECT auth_version,totp_last_step FROM users WHERE id=?').get(admin.id);
    assert.ok(Number(user.auth_version) >= 2, 'auth_version 必须递增');
    // 未启用双因素的账户没有步数可抬升；已启用账户的下限在 restore.test.mjs 中覆盖。
    assert.equal(user.totp_last_step, null);
    assert.equal(Number(check.prepare('SELECT COUNT(*) AS total FROM media').get().total), before.database.counts.media);
    const restoredSponsor = check.prepare('SELECT id,media_id,title FROM sponsors WHERE id=?').get(sponsorId);
    assert.equal(restoredSponsor?.title, '测试赞助');
    assert.equal(restoredSponsor?.media_id, brandingView.id);
    const sponsorSettings = JSON.parse(String(check.prepare("SELECT value FROM settings WHERE key='sponsors'").get().value));
    assert.equal(sponsorSettings.enabled, true);
  } finally { check.close(); }
});

test('备份后篡改文件：恢复拒绝且目标保持不变', () => {
  const backupRun = run('scripts/backup-site.mjs');
  assert.equal(backupRun.status, 0, backupRun.stderr);
  const batch = JSON.parse(backupRun.stdout).batch;
  closeDatabase();
  const dbBefore = sha(databasePath);
  const objectsBefore = objectIds();
  const target = join(batch, 'media', 'objects', view.id, '320.webp');
  writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from('tampered')]));

  const restore = run('scripts/restore-site.mjs', ['--backup', batch, '--database', databasePath, '--media', mediaDir, '--yes']);
  assert.notEqual(restore.status, 0, '哈希不符必须拒绝恢复');
  assert.match(`${restore.stderr}${restore.stdout}`, /校验失败|哈希/);
  assert.equal(sha(databasePath), dbBefore, '目标数据库不得被修改');
  assert.deepEqual(objectIds(), objectsBefore, '目标媒体目录不得被修改');
});

test('媒体对象缺失时备份拒绝标记成功，且不留下半成品批次', () => {
  closeDatabase();
  const missing = join(mediaDir, 'objects', view.id);
  const stash = join(root, 'stash-object');
  rmSync(stash, { recursive: true, force: true });
  renameSync(missing, stash);
  const batchesBefore = backupBatches();
  try {
    const result = run('scripts/backup-site.mjs');
    assert.notEqual(result.status, 0, '缺文件的站点不能生成成功备份');
    assert.match(`${result.stderr}${result.stdout}`, /校验失败|缺少/);
    assert.deepEqual(backupBatches(), batchesBefore, '失败的备份必须清掉本次创建的目录，不能留在 backups/ 里');
  } finally { renameSync(stash, missing); }
});

test('从未上传过媒体、objects 目录尚不存在的新实例也能生成完整批次', () => {
  closeDatabase();
  // 模拟"刚初始化、还没有任何上传"的站点：媒体根目录存在，但 objects/ 从未创建。
  const freshRoot = join(root, 'fresh-site');
  const freshMedia = join(freshRoot, 'media');
  const freshBackups = join(freshRoot, 'backups');
  const freshDb = join(freshRoot, 'site.sqlite');
  mkdirSync(freshMedia, { recursive: true });
  const env = { DATABASE_PATH: freshDb, MEDIA_DIR: freshMedia, BACKUP_DIR: freshBackups, SITE_INIT_MODE: 'empty' };
  const created = spawnSync(process.execPath, ['scripts/create-admin.mjs'], {
    cwd: projectRoot, env: { ...process.env, ...env, ADMIN_USERNAME: 'freshadmin', ADMIN_PASSWORD: PASSWORD }, encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(existsSync(join(freshMedia, 'objects')), false, '前提：objects 目录不存在');
  const backup = spawnSync(process.execPath, ['scripts/backup-site.mjs'], { cwd: projectRoot, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 });
  assert.equal(backup.status, 0, backup.stderr);
  const report = JSON.parse(backup.stdout);
  assert.equal(report.status, 'complete');
  assert.equal(report.media.files, 0);
  const batch = report.batch;
  assert.ok(existsSync(join(batch, 'COMPLETE')), '空站点也必须以 COMPLETE 收尾');
  const manifest = JSON.parse(readFileSync(join(batch, 'manifest.json'), 'utf8'));
  assert.equal(manifest.media.files.length, 0);
  assert.equal(manifest.database.counts.media, 0);
  // 批次必须能被恢复；目标目录尚不存在时也要能建出来（SJ-05）。
  const target = join(freshRoot, 'restored-target');
  const restore = spawnSync(process.execPath, ['scripts/restore-site.mjs', '--backup', batch, '--database', join(target, 'db', 'site.sqlite'), '--media', join(target, 'media'), '--yes'], {
    cwd: projectRoot, env: process.env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(JSON.parse(restore.stdout).status, 'restored');
  assert.ok(existsSync(join(target, 'db', 'site.sqlite')), '不存在的目标目录必须被安全创建');
});

test('未结算操作存在时备份拒绝：不是一致性快照', () => {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare("UPDATE media_store_guard SET operation_id='holder' WHERE id=1").run();
  db.close();
  try {
    const result = run('scripts/backup-site.mjs');
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /未结算|一致性/);
  } finally {
    const clear = new DatabaseSync(databasePath);
    clear.prepare('UPDATE media_store_guard SET operation_id=NULL WHERE id=1').run();
    clear.close();
  }
});

test('离线对账：清除占位、隔离未提交对象、恢复上传', async () => {
  closeDatabase();
  // 构造"安装后提交失败"的现场：对象在、登记不在、占位与预留都在。
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000');
  const orphanId = 'd'.repeat(64);
  const orphanDir = join(mediaDir, 'objects', orphanId);
  mkdirSync(orphanDir, { recursive: true, mode: 0o700 });
  cpSync(join(mediaDir, 'objects', view.id), orphanDir, { recursive: true });
  const opId = '11111111-1111-4111-8111-111111111111';
  db.prepare(`INSERT INTO media_operations (id,kind,media_id,phase,reserved_bytes,owner,created_at,updated_at)
    VALUES (?,'upload',?,'installed-failed',?, 'test', ?, ?)`)
    .run(opId, orphanId, media.RESERVATION_BYTES, Date.now(), Date.now());
  db.prepare('UPDATE media_store_guard SET operation_id=? WHERE id=1').run(opId);
  db.close();

  // 没有 --clear-guard 时拒绝执行。
  const refused = run('scripts/reconcile-media.mjs', ['--yes']);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stderr}${refused.stdout}`, /占位/);

  const applied = run('scripts/reconcile-media.mjs', ['--yes', '--clear-guard']);
  assert.equal(applied.status, 0, applied.stderr);
  const report = JSON.parse(applied.stdout);
  assert.equal(report.status, 'applied');
  assert.equal(report.guard, opId);
  assert.equal(report.clearedGuard, true);
  assert.equal(report.totals.reservedBytes, 0, '未结算预留必须清零');
  assert.ok(report.quarantined.some((entry) => entry.media === orphanId), '未提交对象进入隔离区');
  assert.equal(existsSync(orphanDir), false);
  assert.ok(existsSync(join(mediaDir, 'quarantine')), '隔离区保留证据');

  // 对账后可以继续上传。
  const bytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#993366' } }).png().toBuffer();
  const next = await media.ingestUpload(admin, { bytes, name: 'after.png', rights: 'unconfirmed', credit: '' });
  assert.ok(media.findServableMedia(next.id));
  assert.equal(media.guardHolder(), null);
});


test('离线对账能收尾中断的彻底删除（purging → 墓碑 + 隔离对象）', async () => {
  const bytes = await sharp({ create: { width: 420, height: 320, channels: 3, background: '#664422' } }).png().toBuffer();
  const extra = await media.ingestUpload(admin, { bytes, name: 'purge.png', rights: 'unconfirmed', credit: '' });
  media.deleteMedia(admin, extra.id, media.findMedia(extra.id).version, '准备彻底删除');
  closeDatabase();

  // 模拟"已标记 purging、文件还没删完进程就挂了"。
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare("UPDATE media SET state='purging', version=version+1 WHERE id=?").run(extra.id);
  const opId = '22222222-2222-4222-8222-222222222222';
  db.prepare(`INSERT INTO media_operations (id,kind,media_id,phase,reserved_bytes,owner,created_at,updated_at)
    VALUES (?,'purge',?,'purging',0,'test',?,?)`).run(opId, extra.id, Date.now(), Date.now());
  db.prepare('UPDATE media_store_guard SET operation_id=? WHERE id=1').run(opId);
  db.close();

  const applied = run('scripts/reconcile-media.mjs', ['--yes', '--clear-guard']);
  assert.equal(applied.status, 0, applied.stderr);
  const report = JSON.parse(applied.stdout);
  assert.ok(report.completedPurges.includes(extra.id), '对账必须完成中断的删除');

  const check = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(check.prepare('SELECT 1 FROM media WHERE id=?').get(extra.id), undefined, '媒体行必须删除');
    assert.ok(check.prepare('SELECT 1 FROM media_tombstones WHERE id=?').get(extra.id), '必须补墓碑');
  } finally { check.close(); }
  assert.equal(existsSync(join(mediaDir, 'objects', extra.id)), false, '对象必须移出 objects');
  assert.equal(media.guardHolder(), null);
});
