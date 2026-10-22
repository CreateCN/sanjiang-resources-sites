import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = 'restore-test-password-123';

function fixture(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const database = join(directory, 'site.sqlite');
  const seeded = spawnSync(process.execPath, ['scripts/create-admin.mjs'], {
    cwd: root,
    env: { ...process.env, DATABASE_PATH: database, ADMIN_USERNAME: 'restoreadmin', ADMIN_PASSWORD: PASSWORD },
    encoding: 'utf8',
  });
  assert.equal(seeded.status, 0, seeded.stderr);
  return { directory, database, backupDir: join(directory, 'backups') };
}
function insertReport(database, title) {
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
    db.prepare("INSERT INTO reports (kind,title,body,created_at) VALUES ('其他',?,?,?)")
      .run(title, `${title} 的反馈正文，长度足够。`, new Date().toISOString());
  } finally { db.close(); }
}
function backup(database, backupDir) {
  const run = spawnSync(process.execPath, ['scripts/backup-db.mjs'], {
    cwd: root, env: { ...process.env, DATABASE_PATH: database, BACKUP_DIR: backupDir }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout).backup;
}
function runRestore(database, backupFile) {
  return spawnSync(process.execPath, ['scripts/restore-db.mjs', '--backup', backupFile, '--database', database, '--yes'], {
    cwd: root, env: { ...process.env, DATABASE_PATH: database }, encoding: 'utf8', timeout: 20000,
  });
}
function reports(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare('SELECT title FROM reports ORDER BY id').all().map((row) => String(row.title));
  } finally { db.close(); }
}
function digest(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}
function files(database) {
  return [database, `${database}-wal`, `${database}-shm`].map(digest);
}

test('restore replaces a database that still has a stale WAL and does not replay post-backup writes', () => {
  const { directory, database, backupDir } = fixture('sj-restore-wal-');
  try {
    insertReport(database, 'baseline-report');
    const backupFile = backup(database, backupDir);
    // A crashed writer leaves commits in -wal without checkpointing the main file.
    const write = `import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.env.DATABASE_PATH);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
      db.prepare("INSERT INTO reports (kind,title,body,created_at) VALUES ('其他',?,?,?)")
        .run('after-backup-report', '备份之后的新反馈，长度足够。', new Date().toISOString());
      console.log('written');
      process.kill(process.pid, 'SIGKILL');`;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', write], {
      cwd: root, env: { ...process.env, DATABASE_PATH: database }, encoding: 'utf8',
    });
    assert.equal(crashed.signal, 'SIGKILL');
    assert.ok(existsSync(`${database}-wal`) && statSync(`${database}-wal`).size > 0, '夹具必须留下非空 WAL');
    assert.deepEqual(reports(database), ['baseline-report', 'after-backup-report'], '恢复前的新写入应已提交到 WAL');

    const restored = runRestore(database, backupFile);
    assert.equal(restored.status, 0, restored.stderr);
    const result = JSON.parse(restored.stdout);
    assert.equal(result.status, 'restored');
    assert.equal(result.integrity, 'ok');
    assert.deepEqual(reports(database), ['baseline-report'], '旧 WAL 不能把备份后的写入带回来');
    const verify = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(String(verify.prepare('PRAGMA integrity_check').get().integrity_check), 'ok'); }
    finally { verify.close(); }
    assert.ok(result.preserved, '替换前必须保全旧库');
    const preserved = readdirSync(result.preserved);
    assert.ok(preserved.includes('site.sqlite'), '保全目录应包含旧主库');
    assert.ok(preserved.includes('site.sqlite-wal'), '保全目录应包含旧 WAL');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid backups leave the target database and sidecars byte-for-byte unchanged', () => {
  const { directory, database } = fixture('sj-restore-invalid-');
  try {
    insertReport(database, 'keep-me');
    const before = files(database);
    const invalid = join(directory, 'invalid.sqlite');
    writeFileSync(invalid, 'this is not a sqlite database');
    const failed = runRestore(database, invalid);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /无法读取|完整性|必要表/);
    assert.deepEqual(files(database), before, '无效备份不能改动目标主库或 sidecar');
    assert.deepEqual(reports(database), ['keep-me']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restore refuses while another process holds the database open', async () => {
  const { directory, database, backupDir } = fixture('sj-restore-active-');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.env.DATABASE_PATH);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
    db.prepare('SELECT 1').get();
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { cwd: root, env: { ...process.env, DATABASE_PATH: database }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('子进程未就绪')), 10000);
      child.stdout.once('data', (chunk) => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('子进程提前退出')); });
    });
    const backupFile = backup(database, backupDir);
    const before = files(database);
    const refused = runRestore(database, backupFile);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /检测到可能正在使用数据库的进程/);
    assert.deepEqual(files(database), before, '有活动使用者时不能改动目标库');
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
