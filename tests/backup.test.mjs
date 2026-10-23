import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { fixtureResources, seedFixture } from './fixtures/content.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('备份脚本生成可校验的快照并保留指定数量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sj-backup-'));
  const dbPath = join(dir, 'site.sqlite');
  const backupDir = join(dir, 'backups');
  try {
    const seed = spawnSync(process.execPath, ['scripts/create-admin.mjs'], {
      cwd: root, env: { ...process.env, DATABASE_PATH: dbPath, ADMIN_USERNAME: 'backupadmin', ADMIN_PASSWORD: 'backup-password-123' }, encoding: 'utf8',
    });
    assert.equal(seed.status, 0, seed.stderr);
    const source = new DatabaseSync(dbPath);
    try { source.exec('PRAGMA busy_timeout=5000'); seedFixture(source); } finally { source.close(); }
    let last;
    for (let index = 0; index < 3; index++) {
      const run = spawnSync(process.execPath, ['scripts/backup-db.mjs'], {
        cwd: root, env: { ...process.env, DATABASE_PATH: dbPath, BACKUP_DIR: backupDir, BACKUP_KEEP: '2' }, encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      last = JSON.parse(run.stdout);
    }
    assert.equal(last.integrity, 'ok');
    assert.ok(last.bytes > 0);
    assert.equal(last.counts.resources, fixtureResources.length);
    const files = readdirSync(backupDir).filter((file) => file.endsWith('.sqlite'));
    assert.equal(files.length, 2, '只保留最近两份');
    const mode = statSync(join(backupDir, files[0])).mode & 0o777;
    assert.equal(mode, 0o600);
    const copy = new DatabaseSync(join(backupDir, files[0]));
    try {
      assert.equal(Number(copy.prepare('SELECT COUNT(*) AS total FROM resources').get().total), fixtureResources.length);
      assert.equal(String(copy.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
    } finally { copy.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
