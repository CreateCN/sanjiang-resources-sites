import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from '../src/server/migrations.ts';

test('existing 007 databases upgrade in place and keep users and reports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sj-migration-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of migrations.slice(0, migrations.findIndex((entry) => entry.id === '008-user-version'))) {
      legacy.exec('BEGIN IMMEDIATE');
      migration.up(legacy);
      legacy.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, new Date().toISOString());
      legacy.exec('COMMIT');
    }
    legacy.prepare("INSERT INTO metadata (key,value) VALUES ('seeded','1')").run();
    legacy.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('legacy-admin','scrypt$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000','admin',1)").run();
    legacy.prepare("INSERT INTO reports (kind,title,body,created_at) VALUES ('其他','升级前的反馈','升级前的反馈正文，至少十个字符。',?)").run(new Date().toISOString());
  } finally { legacy.close(); }

  process.env.DATABASE_PATH = path;
  const { database, closeDatabase } = await import('../src/server/db.ts');
  const store = await import('../src/server/store.ts');
  try {
    database();
    assert.equal(store.schemaVersion(), '008-user-version');
    const admin = store.listUsers().find((entry) => entry.username === 'legacy-admin');
    assert.ok(admin, '升级不能丢失账户');
    assert.equal(admin.role, 'admin');
    assert.equal(admin.active, true);
    assert.equal(admin.version, 1, '旧账户从版本 1 开始，下一次提交必须带这个版本');
    assert.equal(store.listUsers().length, 1);
    assert.equal(store.listReports()[0]?.title, '升级前的反馈');
  } finally {
    closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  }
});
