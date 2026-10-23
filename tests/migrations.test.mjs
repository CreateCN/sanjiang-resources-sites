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
    assert.equal(store.schemaVersion(), migrations.at(-1).id, '升级到当前最新迁移');
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

test('迁移可幂等重跑，且允许“先装 010、后补 009”的升级顺序', async () => {
  const { applyMigrations } = await import('../src/server/migrations.ts');
  const directory = mkdtempSync(join(tmpdir(), 'sj-migration-order-'));
  const path = join(directory, 'out-of-order.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    // 模拟一次只发布了 010 的旧版本：001–008 与 010 已应用，009 尚未存在。
    const subset = migrations.filter((migration) => migration.id !== '009-media-library');
    for (const migration of subset) {
      db.exec('BEGIN IMMEDIATE');
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, new Date().toISOString());
      db.exec('COMMIT');
    }
    const applied = applyMigrations(db);
    assert.deepEqual(applied, ['009-media-library'], '只补装缺失的 009，不重复执行 010');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const table of ['media', 'media_tombstones', 'media_operations', 'media_store_guard', 'login_challenges', 'recovery_codes']) {
      assert.ok(tables.has(table), `缺少表 ${table}`);
    }
    const users = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
    for (const column of ['auth_version', 'totp_secret', 'totp_confirmed_at', 'totp_last_step']) assert.ok(users.has(column), `users 缺少 ${column}`);
    assert.deepEqual(applyMigrations(db), [], '再次运行不再应用任何迁移');
    const ids = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => String(row.id));
    assert.deepEqual(ids, migrations.map((migration) => migration.id), '迁移记录不重复、不丢号');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('011 只补缺失实例配置：新库不写品牌，旧库不覆盖已有品牌与 issuer', async () => {
  const { applyMigrations } = await import('../src/server/migrations.ts');
  const legacyMigrations = migrations.slice(0, migrations.findIndex((entry) => entry.id === '011-instance-configuration'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of legacyMigrations) {
      db.exec('BEGIN IMMEDIATE');
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, new Date().toISOString());
      db.exec('COMMIT');
    }
    assert.deepEqual(applyMigrations(db), ['011-instance-configuration', '012-sponsors']);
    assert.equal(db.prepare("SELECT 1 FROM settings WHERE key='branding'").get(), undefined, '新库的品牌由初始化流程写入，迁移不能抢先灌默认值');
    assert.equal(db.prepare("SELECT 1 FROM metadata WHERE key='auth_issuer'").get(), undefined);

    // 有业务数据后才出现的旧库：重新执行 011 时必须补缺失键，且不碰已有值。
    db.prepare("INSERT INTO metadata (key,value) VALUES ('seeded','1')").run();
    db.prepare("INSERT INTO settings (key,value) VALUES ('branding',?)").run(JSON.stringify({ schemaVersion: 1, version: 7, name: '部署者自定义' }));
    db.prepare("INSERT INTO metadata (key,value) VALUES ('auth_issuer','部署者验证器')").run();
    db.prepare("DELETE FROM schema_migrations WHERE id='011-instance-configuration'").run();
    assert.deepEqual(applyMigrations(db), ['011-instance-configuration']);
    assert.equal(JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key='branding'").get().value)).name, '部署者自定义');
    assert.equal(String(db.prepare("SELECT value FROM metadata WHERE key='auth_issuer'").get().value), '部署者验证器');

    // 真正缺键的旧库：补入改造前的显示品牌与 issuer。
    db.prepare("DELETE FROM settings WHERE key='branding'").run();
    db.prepare("DELETE FROM metadata WHERE key='auth_issuer'").run();
    db.prepare("DELETE FROM schema_migrations WHERE id='011-instance-configuration'").run();
    assert.deepEqual(applyMigrations(db), ['011-instance-configuration']);
    assert.equal(JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key='branding'").get().value)).name, '三江资源');
    assert.equal(String(db.prepare("SELECT value FROM metadata WHERE key='auth_issuer'").get().value), '三江资源');
  } finally { db.close(); }
});
