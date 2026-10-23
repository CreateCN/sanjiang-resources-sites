import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 所有数据库访问在导入实现之前重定向到临时目录。
const directory = mkdtempSync(join(tmpdir(), 'sanjiang-site-config-'));
let sequence = 0;
process.env.DATABASE_PATH = join(directory, 'bootstrap.sqlite');
process.env.SITE_INIT_MODE = 'empty';
delete process.env.SITE_URL;

const lib = await import('../src/lib/site-config.ts');
const deployment = await import('../src/server/deployment-config.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');
const { createInitialAdmin, createUser } = await import('../src/server/store.ts');
const site = await import('../src/server/site-config.ts');
const { HttpError, requireOrigin } = await import('../src/server/security.ts');
const { migrations } = await import('../src/server/migrations.ts');
const { withRequestCache, clearRequestCache } = await import('../src/server/request-cache.ts');
const auth = await import('../src/server/auth.ts');

const PASSWORD = 'site-config-password-2026!';
const ISO = '2026-01-02T03:04:05.000Z';

function freshDatabase() {
  closeDatabase();
  process.env.DATABASE_PATH = join(directory, `case-${++sequence}.sqlite`);
  delete process.env.SITE_URL;
}

function errorOf(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail('预期抛出错误，但没有');
}

function expectStatus(fn, status, pattern) {
  const error = errorOf(fn);
  assert.ok(error instanceof HttpError, `预期 HttpError，实际为 ${error}`);
  assert.equal(error.status, status, error.message);
  if (pattern) assert.match(error.message, pattern);
  return error;
}

function validInput(overrides = {}) {
  return {
    name: '示例资源站',
    subtitle: '学习资源入口',
    description: '整理学习资源，并说明使用条件。',
    footerText: '由示例维护者整理。',
    organizationName: '',
    nonOfficialStatement: '本站不代表任何机构授权或认可。',
    logoMediaId: null,
    faviconMediaId: null,
    shareImageMediaId: null,
    accentColor: '#245c42',
    showProjectAttribution: true,
    ...overrides,
  };
}

function insertMedia(id, options = {}) {
  const { width = 800, height = 800, rights = 'confirmed', credit = '测试素材', deletedAt = null, state = 'ready' } = options;
  database().prepare(`INSERT INTO media
    (id,version,state,bytes,total_bytes,width,height,variants,encoding_version,source_name,uploaded_by,rights,credit,created_at,deleted_at)
    VALUES (?,1,?,100,100,?,?, '[]','test-v1','source.png','tester',?,?,?,?)`)
    .run(id, state, width, height, rights, credit, ISO, deletedAt);
}

function businessSnapshot(db) {
  return JSON.stringify({
    categories: db.prepare('SELECT * FROM categories ORDER BY id').all(),
    resources: db.prepare('SELECT id,uid,draft,published,draft_category,published_category,version,updated_at FROM resources ORDER BY id').all(),
    users: db.prepare('SELECT id,username,password_hash,role,active,version,auth_version FROM users ORDER BY id').all(),
    revisions: db.prepare('SELECT * FROM revisions ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM audit ORDER BY id').all(),
    guides: db.prepare('SELECT * FROM guides ORDER BY slug').all(),
    site: db.prepare("SELECT value FROM settings WHERE key='site'").get(),
  });
}

beforeEach(() => { freshDatabase(); });

after(() => {
  closeDatabase();
  const target = realpathSync(directory);
  assert.ok(target.startsWith(realpathSync(tmpdir()) + sep + 'sanjiang-site-config-'));
  assert.equal(target, resolve(directory));
  rmSync(target, { recursive: true, force: true });
});

test('旧库升级只补 branding 与冻结 issuer，内容、账户、历史与首页设置摘要不变', () => {
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  let before;
  try {
    legacy.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of migrations.slice(0, migrations.findIndex((entry) => entry.id === '011-instance-configuration'))) {
      legacy.exec('BEGIN IMMEDIATE');
      migration.up(legacy);
      legacy.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, ISO);
      legacy.exec('COMMIT');
    }
    legacy.prepare("INSERT INTO categories (id,name) VALUES ('general','综合资源')").run();
    legacy.prepare(`INSERT INTO resources (id,uid,draft,published,draft_category,published_category,version,updated_at)
      VALUES ('legacy-resource','0011223344556677',?,?,'general','general',3,?)`).run(
      JSON.stringify({ title: '还没发布的草稿标题' }),
      JSON.stringify({ title: '已经公开的快照标题' }),
      ISO,
    );
    legacy.prepare("INSERT INTO users (username,password_hash,role,active) VALUES ('legacy-admin',?,'admin',1)")
      .run('scrypt$00000000000000000000000000000000$' + '0'.repeat(128));
    legacy.prepare("INSERT INTO revisions (entity_kind,entity_id,version,data,actor,action,created_at) VALUES ('resource','legacy-resource',2,?,'legacy-admin','save',?)")
      .run(JSON.stringify({ title: '历史版本' }), ISO);
    legacy.prepare("INSERT INTO audit (actor,action,target,created_at) VALUES ('legacy-admin','save-settings','site',?)").run(ISO);
    legacy.prepare("INSERT INTO settings (key,value) VALUES ('site',?)")
      .run(JSON.stringify({ featuredResourceId: '', scenarios: { general: { task: '找资料', detail: '公开资源', glyph: '资' } } }));
    legacy.prepare("INSERT INTO metadata (key,value) VALUES ('seeded','1')").run();
    before = businessSnapshot(legacy);
  } finally { legacy.close(); }

  process.env.DATABASE_PATH = path;
  database();
  const db = database();
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='011-instance-configuration'").get(), '旧库必须补装 011');

  const branding = site.getBranding();
  assert.equal(branding.name, '三江资源', '升级不能突然改名');
  assert.equal(branding.subtitle, '同学们的开放工具书架');
  assert.equal(branding.version, 1);
  assert.equal(branding.accentColor, '#245c42');
  assert.equal(site.getFrozenAuthIssuer(), '三江资源', '旧实例的验证器展示保持原值');
  assert.equal(businessSnapshot(db), before, '迁移只能补键，不能改动业务数据或首页设置');

  closeDatabase();
  process.env.DATABASE_PATH = path;
  database();
  assert.equal(site.getBranding().version, 1, '再次打开不重复写入');
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM settings WHERE key='branding'").get().count, 1);
});

test('新库初始化写入默认品牌；公开投影只含白名单字段', () => {
  createInitialAdmin('operator', PASSWORD);
  const adminView = site.getBrandingAdminView();
  assert.equal(adminView.stored, true);
  assert.equal(adminView.corrupt, false);
  assert.equal(adminView.version, 1, '初始化在同一事务写入版本 1');
  assert.deepEqual(site.getBranding(), { ...lib.DEFAULT_BRANDING, name: '三匠资源站' });

  process.env.SECRET_DEPLOYMENT_VALUE = 'must-not-leak';
  try {
    const publicConfig = site.getPublicSiteConfig();
    assert.deepEqual(Object.keys(publicConfig).sort(), [
      'accentColor', 'accentHoverColor', 'accentPaperColor', 'accentSoftColor', 'accentSoftestColor',
      'description', 'faviconMediaId', 'footerText', 'logoMediaId', 'name', 'nonOfficialStatement',
      'organizationName', 'shareImageMediaId', 'showProjectAttribution', 'subtitle',
    ]);
    assert.ok(!('version' in publicConfig));
    assert.ok(!('schemaVersion' in publicConfig));
    assert.ok(!JSON.stringify(publicConfig).includes('must-not-leak'));
    assert.equal(publicConfig.accentHoverColor, lib.deriveAccentHover(publicConfig.accentColor));
  } finally { delete process.env.SECRET_DEPLOYMENT_VALUE; }
});

test('品牌写入：权限、长度、对比度与媒体状态全部在事务内校验', () => {
  const admin = createInitialAdmin('operator', PASSWORD);
  const editor = createUser(admin, 'editor', PASSWORD, 'editor');
  expectStatus(() => site.saveBranding({ id: 99999, username: 'anonymous', role: 'admin', active: true, version: 1 }, validInput(), 0), 401, /登录已失效/);
  expectStatus(() => site.saveBranding(editor, validInput(), 0), 403, /仅限管理员/);
  expectStatus(() => site.saveBranding({ ...editor, role: 'admin' }, validInput(), 0), 403, /仅限管理员/);
  database().prepare('UPDATE users SET active=0 WHERE id=?').run(admin.id);
  expectStatus(() => site.saveBranding(admin, validInput(), 0), 401, /登录已失效/);
  database().prepare('UPDATE users SET active=1 WHERE id=?').run(admin.id);

  expectStatus(() => site.saveBranding(admin, validInput({ name: '' }), 0), 400, /name/);
  expectStatus(() => site.saveBranding(admin, validInput({ name: 'x'.repeat(61) }), 0), 400, /name/);
  expectStatus(() => site.saveBranding(admin, validInput({ subtitle: 'y'.repeat(101) }), 0), 400, /subtitle/);
  expectStatus(() => site.saveBranding(admin, validInput({ accentColor: '#ffffff' }), 0), 400, /对比度/);
  expectStatus(() => site.saveBranding(admin, validInput({ accentColor: 'red' }), 0), 400, /#RRGGBB/);
  expectStatus(() => site.saveBranding(admin, validInput({ name: '带\u0007控制符' }), 0), 400, /控制字符/);
  expectStatus(() => site.saveBranding(admin, { ...validInput(), version: 9 }, 0), 400, /校验失败/);
  expectStatus(() => site.saveBranding(admin, validInput({ logoMediaId: 'a'.repeat(64) }), 0), 400, /不存在/);

  const confirmed = 'b'.repeat(64);
  insertMedia(confirmed);
  const unconfirmed = 'c'.repeat(64);
  insertMedia(unconfirmed, { rights: 'unconfirmed' });
  const noCredit = 'd'.repeat(64);
  insertMedia(noCredit, { credit: '   ' });
  const removed = 'e'.repeat(64);
  insertMedia(removed, { deletedAt: ISO });
  const tinyFavicon = 'f'.repeat(64);
  insertMedia(tinyFavicon, { width: 199, height: 199 });
  expectStatus(() => site.saveBranding(admin, validInput({ logoMediaId: unconfirmed }), 0), 400, /尚未确认授权/);
  expectStatus(() => site.saveBranding(admin, validInput({ logoMediaId: noCredit }), 0), 400, /缺少署名/);
  expectStatus(() => site.saveBranding(admin, validInput({ logoMediaId: removed }), 0), 400, /下架/);
  expectStatus(() => site.saveBranding(admin, validInput({ faviconMediaId: tinyFavicon }), 0), 400, /至少需要 200×200/);

  const saved = site.saveBranding(admin, validInput({ logoMediaId: confirmed, accentColor: '#1A4D36' }), site.getBrandingAdminView().version ?? 0);
  assert.equal(saved.version, 2, '初始化写入版本 1，第一次编辑递增到 2');
  assert.equal(saved.accentColor, '#1a4d36', '颜色统一小写保存');
  assert.equal(site.getBranding().name, '示例资源站');
  assert.ok(database().prepare("SELECT 1 FROM audit WHERE action='save-branding' AND actor='operator'").get(), '保存必须写审计');
});

test('并发保存按原始值做 CAS：旧版本 409，损坏行保留原文直到显式修复', () => {
  const admin = createInitialAdmin('operator', PASSWORD);
  const first = site.saveBranding(admin, validInput({ name: '第一版' }), site.getBrandingAdminView().version ?? 0);
  assert.equal(first.version, 2);
  expectStatus(() => site.saveBranding(admin, validInput({ name: '旧页面覆盖' }), 0), 409, /其他维护者/);
  assert.equal(site.getBranding().name, '第一版', '旧版本提交不能覆盖新值');

  const second = site.saveBranding(admin, validInput({ name: '第二版' }), first.version);
  assert.equal(second.version, 3);
  expectStatus(() => site.saveBranding(admin, validInput({ name: '再次并发' }), first.version), 409);

  database().prepare("UPDATE settings SET value='{ not json' WHERE key='branding'").run();
  clearRequestCache();
  const view = site.getBrandingAdminView();
  assert.equal(view.corrupt, true);
  assert.equal(view.version, null);
  assert.equal(site.getBranding().name, lib.DEFAULT_BRANDING.name, '损坏时公开页回退中性默认值');
  assert.equal(database().prepare("SELECT value FROM settings WHERE key='branding'").get().value, '{ not json', '读取不能覆盖损坏原文');
  expectStatus(() => site.saveBranding(admin, validInput({ name: '修复尝试' }), second.version), 409, /无法解析/);
  const repaired = site.saveBranding(admin, validInput({ name: '修复完成' }), null);
  assert.equal(repaired.version, 1);
  assert.equal(site.getBrandingAdminView().corrupt, false);
});

test('品牌存储快照区分缺行/损坏/正常；原始值变化即使版本相同也拒绝', () => {
  const admin = createInitialAdmin('operator', PASSWORD);
  database().prepare("DELETE FROM settings WHERE key='branding'").run();
  const missing = site.getBrandingStorageSnapshot();
  assert.equal(missing.expectedVersion, 0);
  const saved = site.saveBranding(admin, validInput(), 0, { rawFingerprint: missing.rawFingerprint });
  assert.equal(saved.version, 1);

  const normal = site.getBrandingStorageSnapshot();
  assert.equal(normal.expectedVersion, 1);
  const raw = String(database().prepare("SELECT value FROM settings WHERE key='branding'").get().value);
  database().prepare("UPDATE settings SET value=? WHERE key='branding'").run(JSON.stringify({ ...JSON.parse(raw), name: '同版本被改' }));
  expectStatus(
    () => site.saveBranding(admin, validInput({ name: '导入品牌' }), normal.expectedVersion, { rawFingerprint: normal.rawFingerprint }),
    409,
    /导入期间/,
  );
  assert.equal(site.getBranding().name, '同版本被改');

  database().prepare("UPDATE settings SET value='{' WHERE key='branding'").run();
  const corrupt = site.getBrandingStorageSnapshot();
  assert.equal(corrupt.expectedVersion, null);
  const repaired = site.saveBranding(admin, validInput({ name: '显式修复' }), null, { rawFingerprint: corrupt.rawFingerprint });
  assert.equal(repaired.version, 1);
  const afterRepair = site.getBrandingStorageSnapshot();
  database().prepare("UPDATE settings SET value=? WHERE key='branding'").run(JSON.stringify({ ...repaired, name: '修复后又改' }));
  expectStatus(
    () => site.saveBranding(admin, validInput({ name: '再次导入' }), afterRepair.expectedVersion, { rawFingerprint: afterRepair.rawFingerprint }),
    409,
    /导入期间/,
  );
  assert.equal(site.getBranding().name, '修复后又改');
});

test('同一请求内品牌只读一次；保存后请求缓存失效', () => {
  const admin = createInitialAdmin('operator', PASSWORD);
  const saved = site.saveBranding(admin, validInput({ name: '缓存第一版' }), site.getBrandingAdminView().version ?? 0);
  const second = { ...saved, version: saved.version + 1, name: '缓存第二版' };
  withRequestCache(() => {
    assert.equal(site.getBranding().name, '缓存第一版');
    database().prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(second), 'branding');
    assert.equal(site.getBranding().name, '缓存第一版', '请求内复用第一次读取');
    clearRequestCache();
    assert.equal(site.getBranding().name, '缓存第二版');
  });
  assert.equal(site.getBranding().name, '缓存第二版');
});

test('SITE_URL 解析：只接受根路径的绝对 http/https origin，生产必须显式配置', () => {
  const valid = deployment.parseSiteUrl('https://resources.example.edu/');
  assert.deepEqual(valid, { configured: true, valid: true, origin: 'https://resources.example.edu', secure: true, error: null });
  assert.equal(deployment.parseSiteUrl('http://127.0.0.1:4321').origin, 'http://127.0.0.1:4321');
  for (const [raw, pattern] of [
    ['resources.example.edu', /绝对地址/],
    ['ftp://resources.example.edu', /http 或 https/],
    ['https://user:pass@resources.example.edu', /用户名或密码/],
    ['https://resources.example.edu/?a=1', /查询参数/],
    ['https://resources.example.edu/#top', /片段/],
    ['https://resources.example.edu/sub', /子路径/],
  ]) {
    const state = deployment.parseSiteUrl(raw);
    assert.equal(state.valid, false, raw);
    assert.match(state.error, pattern);
  }

  const savedNodeEnv = process.env.NODE_ENV;
  const savedSiteUrl = process.env.SITE_URL;
  try {
    delete process.env.SITE_URL;
    process.env.NODE_ENV = 'production';
    assert.throws(() => deployment.resolveSiteOrigin(), deployment.SiteConfigError);
    assert.equal(deployment.isSecureSite(), false);
    process.env.SITE_URL = 'https://resources.example.edu';
    assert.equal(deployment.resolveSiteOrigin(), 'https://resources.example.edu');
    assert.equal(deployment.isSecureSite(), true);
    process.env.SITE_URL = 'not a url';
    const error = errorOf(() => deployment.resolveSiteOrigin());
    assert.ok(error instanceof deployment.SiteConfigError);
    assert.equal(deployment.isSecureSite(), false);

    process.env.NODE_ENV = 'development';
    delete process.env.SITE_URL;
    assert.equal(deployment.resolveSiteOrigin(new URL('http://localhost:4321/page')), 'http://localhost:4321');
    assert.equal(deployment.resolveSiteOrigin(), 'http://localhost:4321');
    const request = new Request('http://localhost/api/manage', { headers: { Host: 'localhost:4321' } });
    assert.equal(deployment.resolveRequestOrigin(request), 'http://localhost:4321', '开发环境保留 Host 回退');
    const forwarded = new Request('http://localhost/api/manage', { headers: { Host: 'localhost:4321', 'X-Forwarded-Proto': 'https' } });
    assert.equal(deployment.resolveRequestOrigin(forwarded), 'https://localhost:4321');
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedSiteUrl === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = savedSiteUrl;
  }
});

test('Origin 与 Cookie Secure 共用同一 origin 解析，配置非法时 fail-closed', () => {
  const savedSiteUrl = process.env.SITE_URL;
  try {
    process.env.SITE_URL = 'https://resources.example.edu';
    requireOrigin(new Request('https://resources.example.edu/api/manage', { method: 'POST', headers: { Origin: 'https://resources.example.edu' } }));
    expectStatus(() => requireOrigin(new Request('https://resources.example.edu/api/manage', { method: 'POST', headers: { Origin: 'https://evil.example' } })), 403, /来源验证失败/);
    assert.match(auth.challengeCookie('a'.repeat(43)), /; Secure$/);

    process.env.SITE_URL = 'https://resources.example.edu/sub';
    expectStatus(() => requireOrigin(new Request('https://resources.example.edu/api/manage', {
      method: 'POST', headers: { Origin: 'https://resources.example.edu' },
    })), 503, /站点地址配置异常/);
    assert.doesNotMatch(auth.challengeCookie('a'.repeat(43)), /; Secure/);
  } finally {
    if (savedSiteUrl === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = savedSiteUrl;
  }
});

test('主题色派生：hover 更深、表面色更浅，全部是合法 #RRGGBB', () => {
  const tokens = lib.deriveThemeTokens('#245c42');
  for (const value of Object.values(tokens)) assert.match(value, /^#[0-9a-f]{6}$/);
  assert.equal(tokens.accent, '#245c42');
  assert.ok(lib.contrastRatio(tokens.accentHover, '#ffffff') > lib.contrastRatio(tokens.accent, '#ffffff'), 'hover 色变暗只会提高白字对比度');
  assert.ok(lib.relativeLuminance(tokens.soft) > lib.relativeLuminance(tokens.accent));
  assert.ok(lib.relativeLuminance(tokens.softest) > lib.relativeLuminance(tokens.soft));
  assert.ok(lib.relativeLuminance(tokens.paper) > lib.relativeLuminance(tokens.softest));
});

test('品牌素材：未配置或失效时回退中性素材，可用媒体优先', () => {
  const admin = createInitialAdmin('operator', PASSWORD);
  assert.deepEqual(site.getBrandAssets(), {
    logoUrl: null, faviconUrl: '/favicon.svg', faviconType: 'image/svg+xml', shareImageUrl: '/og-default.png',
  });

  const logo = '1'.repeat(64);
  const favicon = '2'.repeat(64);
  const share = '3'.repeat(64);
  for (const id of [logo, favicon, share]) insertMedia(id);
  site.saveBranding(admin, validInput({ logoMediaId: logo, faviconMediaId: favicon, shareImageMediaId: share }), site.getBrandingAdminView().version ?? 0);
  assert.deepEqual(site.getBrandAssets(), {
    logoUrl: `/media/${logo}.webp`,
    faviconUrl: `/media/${favicon}.webp`,
    faviconType: 'image/webp',
    shareImageUrl: `/media/${share}.webp`,
  });

  // 下架后立即回退；配置本身保留，管理员可以在媒体库恢复。
  database().prepare('UPDATE media SET deleted_at=? WHERE id IN (?,?,?)').run(ISO, logo, favicon, share);
  assert.deepEqual(site.getBrandAssets(), {
    logoUrl: null, faviconUrl: '/favicon.svg', faviconType: 'image/svg+xml', shareImageUrl: '/og-default.png',
  });
});

test('favicon 最小边与媒体上传门槛一致', async () => {
  const media = await import('../src/server/media.ts');
  assert.equal(lib.FAVICON_MIN_EDGE, media.IMAGE_MIN_EDGE);
});

test('品牌指纹稳定且随内容变化', () => {
  const first = lib.brandingFingerprint(lib.DEFAULT_BRANDING);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(lib.brandingFingerprint({ ...lib.DEFAULT_BRANDING }), first);
  assert.notEqual(lib.brandingFingerprint({ ...lib.DEFAULT_BRANDING, name: '另一个名字' }), first);
});
