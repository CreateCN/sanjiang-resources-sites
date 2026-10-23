import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repo = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'sanjiang-init-'));
let sequence = 0;
process.env.DATABASE_PATH = join(directory, 'boot.sqlite');
delete process.env.SITE_INIT_MODE;
delete process.env.SITE_INIT_NAME;

const init = await import('../src/server/initialization.ts');
const { applyMigrations, migrations } = await import('../src/server/migrations.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');
const store = await import('../src/server/store.ts');
const demo = await import('../src/server/demo.ts');
const { BRANDING_SETTINGS_KEY, AUTH_ISSUER_METADATA_KEY } = await import('../src/lib/site-config.ts');

const PASSWORD = 'init-test-password-2026!';
function freshPath() {
  closeDatabase();
  delete process.env.SITE_INIT_MODE;
  delete process.env.SITE_INIT_NAME;
  const path = join(directory, `case-${++sequence}.sqlite`);
  process.env.DATABASE_PATH = path;
  return path;
}
function rawOpen(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return db;
}
function meta(db, key) {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
  return row ? String(row.value) : undefined;
}
function readMeta(path, key) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? String(row.value) : undefined;
  } finally { db.close(); }
}
function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      categories: db.prepare('SELECT id,name FROM categories ORDER BY id').all().map((row) => ({ id: String(row.id), name: String(row.name) })),
      resources: Number(db.prepare('SELECT COUNT(*) AS total FROM resources').get().total),
      guides: Number(db.prepare('SELECT COUNT(*) AS total FROM guides').get().total),
      users: Number(db.prepare('SELECT COUNT(*) AS total FROM users').get().total),
      settings: db.prepare('SELECT key,value FROM settings ORDER BY key').all().map((row) => ({ key: String(row.key), value: String(row.value) })),
      metadata: db.prepare('SELECT key,value FROM metadata ORDER BY key').all().map((row) => ({ key: String(row.key), value: String(row.value) })),
      audit: Number(db.prepare('SELECT COUNT(*) AS total FROM audit').get().total),
    };
  } finally { db.close(); }
}
function runCli(path, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, ['scripts/init-site.mjs', ...args], {
    cwd: repo,
    env: {
      ...process.env, DATABASE_PATH: path, SITE_INIT_MODE: '', SITE_INIT_NAME: '',
      TOTP_ENC_KEY: 'should-never-appear-in-output', ADMIN_PASSWORD: 'should-never-appear-either', ...extraEnv,
    },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}
function runCliAsync(path, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['scripts/init-site.mjs', ...args], {
      cwd: repo, env: { ...process.env, DATABASE_PATH: path, SITE_INIT_MODE: '', SITE_INIT_NAME: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

beforeEach(() => { freshPath(); });

after(() => {
  closeDatabase();
  const target = realpathSync(directory);
  assert.ok(target.startsWith(realpathSync(tmpdir()) + sep + 'sanjiang-init-'));
  assert.equal(target, resolve(directory));
  rmSync(target, { recursive: true, force: true });
});

test('参数解析：默认 empty，非法模式与名称直接失败', () => {
  assert.equal(init.parseInitMode(undefined), 'empty');
  assert.equal(init.parseInitMode(''), 'empty');
  assert.equal(init.parseInitMode(' DEMO '), 'demo');
  assert.equal(init.parseInitMode('empty'), 'empty');
  assert.equal(init.parseInitMode('demo '), 'demo');
  assert.throws(() => init.parseInitMode('legacy'), /只接受/);
  assert.throws(() => init.parseInitMode('demo2'), /只接受/);
  assert.equal(init.normalizeInstanceName(''), '三匠资源站');
  assert.equal(init.normalizeInstanceName('  星河资源站  '), '星河资源站');
  assert.throws(() => init.normalizeInstanceName('x'.repeat(61)), /60/);
  assert.throws(() => init.normalizeInstanceName('坏\u0007名字'), /控制字符/);
});

test('空文件与全新路径都会初始化 Empty：零资源、一个综合分类、默认品牌与冻结 issuer', () => {
  const path = freshPath();
  writeFileSync(path, '');
  database();
  const state = inspect(path);
  assert.deepEqual(state.categories, [{ id: 'general', name: '综合资源' }]);
  assert.equal(state.resources, 0);
  assert.equal(state.guides, 0);
  assert.equal(state.users, 0);
  const db = database();
  assert.equal(meta(db, init.INIT_METADATA.initialized), '1');
  assert.equal(meta(db, init.INIT_METADATA.mode), 'empty');
  assert.equal(meta(db, init.INIT_METADATA.version), '1');
  assert.equal(meta(db, init.INIT_METADATA.seeded), '1');
  assert.equal(meta(db, init.INIT_METADATA.demo), '0');
  assert.equal(meta(db, AUTH_ISSUER_METADATA_KEY), '三匠资源站');
  const branding = JSON.parse(state.settings.find((row) => row.key === BRANDING_SETTINGS_KEY).value);
  assert.equal(branding.name, '三匠资源站');
  assert.equal(branding.version, 1);
  assert.deepEqual(JSON.parse(state.settings.find((row) => row.key === 'site').value), { featuredResourceId: '', scenarios: {} });
  assert.equal(demo.isDemoContent(), false);
});

test('已完成迁移但尚无初始化数据的新库可安全重试；SITE_INIT_NAME 同时冻结品牌与 issuer', () => {
  const path = join(directory, 'migrated-empty.sqlite');
  const prepared = rawOpen(path);
  applyMigrations(prepared);
  assert.equal(Number(prepared.prepare('SELECT COUNT(*) AS total FROM settings').get().total), 0);
  prepared.close();

  process.env.DATABASE_PATH = path;
  process.env.SITE_INIT_MODE = 'empty';
  process.env.SITE_INIT_NAME = '星河资源站';
  database();
  const state = inspect(path);
  assert.deepEqual(state.categories, [{ id: 'general', name: '综合资源' }]);
  assert.equal(readMeta(path, AUTH_ISSUER_METADATA_KEY), '星河资源站');
  assert.equal(JSON.parse(state.settings.find((row) => row.key === BRANDING_SETTINGS_KEY).value).name, '星河资源站');

  closeDatabase();
  process.env.DATABASE_PATH = path;
  delete process.env.SITE_INIT_NAME;
  database();
  assert.deepEqual(inspect(path), state, '再次打开不会重新初始化或改名');
});

test('Demo 显式初始化：示例资源、演示标记、无默认账户；退出标记不改内容', () => {
  const path = freshPath();
  process.env.SITE_INIT_MODE = 'demo';
  database();
  const state = inspect(path);
  assert.ok(state.resources > 0, 'Demo 应有示例资源');
  assert.equal(state.users, 0, '不能创建默认账户');
  const db = database();
  assert.equal(meta(db, init.INIT_METADATA.mode), 'demo');
  assert.equal(meta(db, init.INIT_METADATA.demo), '1');
  assert.equal(demo.isDemoContent(), true);
  const demoCount = state.resources;
  const before = JSON.stringify(db.prepare('SELECT id,draft,published,version FROM resources ORDER BY id').all());

  const admin = store.createInitialAdmin('operator', PASSWORD);
  const editor = store.createUser(admin, 'editor', PASSWORD, 'editor');
  assert.throws(() => demo.exitDemoMode(editor), /仅限管理员/);
  demo.exitDemoMode(admin);
  assert.equal(meta(db, init.INIT_METADATA.demo), '0');
  assert.equal(demo.isDemoContent(), false);
  assert.equal(JSON.stringify(db.prepare('SELECT id,draft,published,version FROM resources ORDER BY id').all()), before, '退出演示不改内容');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS total FROM resources').get().total), demoCount);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action='exit-demo'").get());
});

test('重跑同模式无写入；已有实例不接受模式转换', () => {
  const path = freshPath();
  process.env.SITE_INIT_MODE = 'empty';
  database();
  const first = inspect(path);
  closeDatabase();
  process.env.DATABASE_PATH = path;
  database();
  assert.deepEqual(inspect(path), first, '同一模式重开不产生新行');

  const db = database();
  const outcome = init.initializeDatabase(db, { mode: 'demo' });
  assert.equal(outcome.state, 'initialized');
  assert.equal(outcome.written, false);
  assert.equal(outcome.mode, 'empty');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS total FROM resources').get().total), 0);

  closeDatabase();
  process.env.SITE_INIT_MODE = 'demo';
  process.env.DATABASE_PATH = path;
  database();
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM resources').get().total), 0, '启动参数不能转换已有实例');
});

test('旧 seeded 实例只迁移不灌种子；旧 seeded 空站也不会被补数据', () => {
  const path = freshPath();
  const legacy = rawOpen(path);
  try {
    legacy.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of migrations.slice(0, migrations.findIndex((entry) => entry.id === '011-instance-configuration'))) {
      legacy.exec('BEGIN IMMEDIATE');
      migration.up(legacy);
      legacy.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, new Date().toISOString());
      legacy.exec('COMMIT');
    }
    legacy.prepare("INSERT INTO metadata (key,value) VALUES ('seeded','1')").run();
    legacy.prepare("INSERT INTO categories (id,name) VALUES ('writing','写作阅读')").run();
    legacy.prepare(`INSERT INTO resources (id,uid,draft,published,draft_category,published_category,version,updated_at)
      VALUES ('legacy-resource','0011223344556677','{}','{}','writing','writing',1,?)`).run(new Date().toISOString());
    legacy.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('legacy-admin',?,'admin',1)")
      .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
  } finally { legacy.close(); }

  process.env.DATABASE_PATH = path;
  process.env.SITE_INIT_MODE = 'empty';
  database();
  const state = inspect(path);
  assert.deepEqual(state.categories, [{ id: 'writing', name: '写作阅读' }], '不得补 general');
  assert.equal(state.resources, 1);
  assert.equal(state.users, 1);
  const db = database();
  assert.equal(meta(db, init.INIT_METADATA.initialized), undefined);
  assert.equal(meta(db, init.INIT_METADATA.mode), undefined);
  assert.equal(meta(db, AUTH_ISSUER_METADATA_KEY), '三江资源', '旧实例迁移补齐 issuer');
  const branding = JSON.parse(String(db.prepare('SELECT value FROM settings WHERE key=?').get(BRANDING_SETTINGS_KEY).value));
  assert.equal(branding.name, '三江资源');

  // 旧 seeded 空站：只有标记、没有业务行，也不能被当成新库初始化。
  const emptyPath = join(directory, 'legacy-empty.sqlite');
  closeDatabase();
  const emptyDb = rawOpen(emptyPath);
  applyMigrations(emptyDb);
  emptyDb.prepare("INSERT INTO metadata (key,value) VALUES ('seeded','1')").run();
  emptyDb.close();
  process.env.DATABASE_PATH = emptyPath;
  process.env.SITE_INIT_MODE = 'empty';
  database();
  const emptyState = inspect(emptyPath);
  assert.deepEqual(emptyState.categories, [], '旧 seeded 空站不补分类');
  assert.equal(meta(database(), init.INIT_METADATA.initialized), undefined);
});

test('有业务数据但缺标记：自动打开拒绝并给出诊断，显式接管只补配置', () => {
  const path = freshPath();
  const db = rawOpen(path);
  applyMigrations(db);
  db.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('orphan-admin',?,'admin',1)")
    .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
  db.close();

  process.env.DATABASE_PATH = path;
  process.env.SITE_INIT_MODE = 'empty';
  assert.throws(() => database(), (error) => {
    assert.equal(error.name, 'InitializationError');
    assert.match(error.message, /业务数据但缺少初始化标记/);
    assert.match(error.message, /--adopt/);
    return true;
  });
  assert.equal(inspect(path).users, 1, '拒绝时不能改动数据');

  const raw = rawOpen(path);
  try {
    const result = init.initializeDatabase(raw, { mode: 'empty', name: '接管实例', adopt: true });
    assert.equal(result.state, 'initialized');
    assert.equal(result.written, true);
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS total FROM users').get().total), 1, '接管保留原账户');
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS total FROM resources').get().total), 0, '接管不写示例内容');
    assert.equal(meta(raw, init.INIT_METADATA.mode), 'empty');
    assert.equal(meta(raw, AUTH_ISSUER_METADATA_KEY), '接管实例');
  } finally { raw.close(); }
});

test('异常库接管：已有 general 不重复插入，保留原名称与既有配置', () => {
  const path = freshPath();
  const db = rawOpen(path);
  applyMigrations(db);
  db.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('orphan-general',?,'admin',1)")
    .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
  db.prepare("INSERT INTO categories (id,name) VALUES ('general','原有综合')").run();
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?)")
    .run(BRANDING_SETTINGS_KEY, JSON.stringify({ schemaVersion: 1, version: 7, name: '原有品牌', subtitle: '原有简介', description: '原有描述', footerText: '', organizationName: '', nonOfficialStatement: '原有声明', logoMediaId: null, faviconMediaId: null, shareImageMediaId: null, accentColor: '#245c42', showProjectAttribution: true }));
  db.prepare("INSERT INTO settings (key,value) VALUES ('site',?)").run(JSON.stringify({ featuredResourceId: 'writing', scenarios: {} }));
  db.prepare("INSERT INTO metadata (key,value) VALUES (?,?)").run(AUTH_ISSUER_METADATA_KEY, '原有验证器');
  db.close();

  process.env.DATABASE_PATH = path;
  assert.throws(() => database(), /业务数据但缺少初始化标记/);
  const raw = rawOpen(path);
  try {
    const result = init.initializeDatabase(raw, { mode: 'empty', name: '接管实例', adopt: true });
    assert.equal(result.written, true);
    assert.deepEqual(raw.prepare('SELECT id,name FROM categories ORDER BY id').all().map((row) => ({ id: String(row.id), name: String(row.name) })), [{ id: 'general', name: '原有综合' }]);
    const branding = JSON.parse(String(raw.prepare("SELECT value FROM settings WHERE key=?").get(BRANDING_SETTINGS_KEY).value));
    assert.equal(branding.name, '原有品牌');
    assert.equal(branding.version, 7);
    assert.equal(JSON.parse(String(raw.prepare("SELECT value FROM settings WHERE key='site'").get().value)).featuredResourceId, 'writing');
    assert.equal(meta(raw, AUTH_ISSUER_METADATA_KEY), '原有验证器');
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS total FROM users').get().total), 1);
    const again = init.initializeDatabase(raw, { mode: 'empty', name: '再次接管', adopt: true });
    assert.equal(again.written, false, '已接管实例重复执行不改数据');
  } finally { raw.close(); }
});

test('异常库接管：已有自定义分类且没有 general 时不补 general', () => {
  const path = freshPath();
  const db = rawOpen(path);
  applyMigrations(db);
  db.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('orphan-custom',?,'admin',1)")
    .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
  db.prepare("INSERT INTO categories (id,name) VALUES ('writing','写作阅读')").run();
  db.close();

  const raw = rawOpen(path);
  try {
    const result = init.initializeDatabase(raw, { mode: 'empty', name: '接管实例', adopt: true });
    assert.equal(result.written, true);
    assert.deepEqual(raw.prepare('SELECT id,name FROM categories ORDER BY id').all().map((row) => ({ id: String(row.id), name: String(row.name) })), [{ id: 'writing', name: '写作阅读' }]);
    assert.equal(raw.prepare("SELECT 1 FROM categories WHERE id='general'").get(), undefined);
  } finally { raw.close(); }
});

test('异常库接管中途失败整体回滚', () => {
  const path = freshPath();
  const db = rawOpen(path);
  applyMigrations(db);
  db.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('orphan-fail',?,'admin',1)")
    .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
  db.prepare("INSERT INTO categories (id,name) VALUES ('writing','写作阅读')").run();
  db.exec("CREATE TRIGGER fail_adopt BEFORE INSERT ON metadata WHEN NEW.key='initialized' BEGIN SELECT RAISE(ABORT,'adopt-boom'); END");
  assert.throws(() => init.initializeDatabase(db, { mode: 'empty', name: '接管失败', adopt: true }), /adopt-boom/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS total FROM categories').get().total), 1);
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key=?").get(BRANDING_SETTINGS_KEY), undefined);
  assert.equal(db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get(), undefined);
  db.close();
});

test('初始化中途失败整体回滚，修复后可安全重试', () => {
  const path = freshPath();
  const db = rawOpen(path);
  applyMigrations(db);
  db.exec("CREATE TRIGGER fail_brand BEFORE INSERT ON settings WHEN NEW.key='branding' BEGIN SELECT RAISE(ABORT,'boom'); END");
  assert.throws(() => init.initializeDatabase(db, { mode: 'demo' }), /boom/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS total FROM categories').get().total), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS total FROM resources').get().total), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS total FROM settings').get().total), 0);
  assert.equal(meta(db, init.INIT_METADATA.initialized), undefined);
  assert.equal(meta(db, init.INIT_METADATA.seeded), undefined);
  db.exec('DROP TRIGGER fail_brand');
  const retry = init.initializeDatabase(db, { mode: 'empty' });
  assert.equal(retry.written, true);
  assert.equal(meta(db, init.INIT_METADATA.initialized), '1');
  db.close();
});

test('两个初始化进程竞争：都正常结束，只有一个写入', async () => {
  const path = join(directory, 'race.sqlite');
  const [first, second] = await Promise.all([
    runCliAsync(path, ['--mode', 'empty', '--name', '并发实例']),
    runCliAsync(path, ['--mode', 'empty', '--name', '并发实例']),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const state = inspect(path);
  assert.deepEqual(state.categories, [{ id: 'general', name: '综合资源' }]);
  assert.equal(state.metadata.filter((row) => row.key === 'initialized').length, 1);
  assert.equal(state.metadata.filter((row) => row.key === 'init_mode').length, 1);
  assert.equal(readMeta(path, init.INIT_METADATA.mode), 'empty');
});

test('CLI：初始化、重跑、拒绝转换、异常库接管与输出脱敏', () => {
  const path = join(directory, 'cli.sqlite');
  const first = runCli(path, ['--mode', 'empty', '--name', '星河资源站']);
  assert.equal(first.code, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.status, 'initialized');
  assert.equal(report.mode, 'empty');
  assert.equal(report.name, '星河资源站');
  assert.equal(report.written, true);
  assert.doesNotMatch(first.stdout + first.stderr, /should-never-appear/);
  const state = inspect(path);
  assert.equal(JSON.parse(state.settings.find((row) => row.key === BRANDING_SETTINGS_KEY).value).name, '星河资源站');
  assert.equal(readMeta(path, AUTH_ISSUER_METADATA_KEY), '星河资源站');

  const rerun = runCli(path, ['--mode', 'empty', '--name', '星河资源站']);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).status, 'already-initialized');
  assert.equal(JSON.parse(rerun.stdout).written, false);

  const convert = runCli(path, ['--mode', 'demo']);
  assert.equal(convert.code, 1);
  assert.match(convert.stderr, /不自动转换/);
  assert.equal(inspect(path).resources, 0);

  const invalid = runCli(path, ['--mode', 'nope']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /只接受/);

  const badName = runCli(path, ['--mode', 'empty', '--name', 'x'.repeat(61)]);
  assert.equal(badName.code, 1);
  assert.match(badName.stderr, /60/);

  // 异常库：默认拒绝，显式 --adopt 才接管；接管不能配合 demo。
  const orphanPath = join(directory, 'cli-orphan.sqlite');
  const orphan = rawOpen(orphanPath);
  applyMigrations(orphan);
  orphan.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('orphan',?,'admin',1)")
    .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
  orphan.close();
  const refused = runCli(orphanPath, ['--mode', 'empty']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /业务数据但缺少初始化标记/);
  assert.equal(inspect(orphanPath).users, 1);
  const wrongAdopt = runCli(orphanPath, ['--mode', 'demo', '--adopt']);
  assert.equal(wrongAdopt.code, 1);
  assert.match(wrongAdopt.stderr, /--mode empty/);
  const adopted = runCli(orphanPath, ['--mode', 'empty', '--adopt', '--name', '接管站']);
  assert.equal(adopted.code, 0, adopted.stderr);
  assert.equal(JSON.parse(adopted.stdout).written, true);
  assert.equal(inspect(orphanPath).users, 1);
  assert.equal(readMeta(orphanPath, AUTH_ISSUER_METADATA_KEY), '接管站');
});

test('CLI --adopt：已有 general 时接管成功，名称与数量不变', () => {
  const path = join(directory, 'cli-general-' + (++sequence) + '.sqlite');
  const db = rawOpen(path);
  applyMigrations(db);
  db.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('orphan-cli',?,'admin',1)")
    .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
  db.prepare("INSERT INTO categories (id,name) VALUES ('general','原有综合分类')").run();
  db.close();

  const result = runCli(path, ['--mode', 'empty', '--adopt', '--name', '接管站']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).written, true);
  assert.deepEqual(inspect(path).categories, [{ id: 'general', name: '原有综合分类' }]);
  assert.equal(inspect(path).users, 1);
});

test('非法 SITE_INIT_MODE 直接失败，不能静默按空站处理', () => {
  freshPath();
  process.env.SITE_INIT_MODE = 'legacy';
  assert.throws(() => database(), /只接受 empty 或 demo/);
});
