import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'sanjiang-sponsors-'));
let sequence = 0;
process.env.DATABASE_PATH = join(directory, 'boot.sqlite');
process.env.SITE_INIT_MODE = 'empty';

const { database, closeDatabase } = await import('../src/server/db.ts');
const { createInitialAdmin, createUser } = await import('../src/server/store.ts');
const sponsors = await import('../src/server/sponsors.ts');
const { HttpError } = await import('../src/server/security.ts');

const PASSWORD = 'sponsor-test-password-2026!';
const ISO = '2026-01-01T00:00:00.000Z';
let admin;
let editor;

function freshDatabase() {
  closeDatabase();
  process.env.DATABASE_PATH = join(directory, `case-${++sequence}.sqlite`);
  process.env.SITE_INIT_MODE = 'empty';
}
function expectStatus(fn, status, pattern) {
  try { fn(); } catch (error) {
    assert.ok(error instanceof HttpError, `预期 HttpError，实际 ${error}`);
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail('预期抛出错误');
}
function insertMedia(id, options = {}) {
  const { state = 'ready', deletedAt = null, rights = 'confirmed', credit = '测试 / CC0' } = options;
  database().prepare(`INSERT INTO media
    (id,version,state,bytes,total_bytes,width,height,variants,encoding_version,source_name,uploaded_by,rights,credit,created_at,deleted_at)
    VALUES (?,1,?,100,100,800,800,'[]','test','sponsor.png','tester',?,?,?,?)`)
    .run(id, state, rights, credit, ISO, deletedAt);
}
function input(overrides = {}) {
  return {
    title: '示例赞助',
    body: '支持本站的服务器与维护成本。',
    sponsorName: '示例赞助方',
    mediaId: null,
    imageAlt: '',
    targetUrl: 'https://sponsor.example.com/learn',
    placement: 'home-sidebar',
    enabled: false,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  freshDatabase();
  admin = createInitialAdmin('operator', PASSWORD);
  editor = createUser(admin, 'editor', PASSWORD, 'editor');
});
after(() => {
  closeDatabase();
  const target = realpathSync(directory);
  assert.ok(target.startsWith(realpathSync(tmpdir()) + sep + 'sanjiang-sponsors-'));
  assert.equal(target, resolve(directory));
  rmSync(target, { recursive: true, force: true });
});

test('创建默认停用，记录创建人与版本并写审计', () => {
  const sponsor = sponsors.createSponsor(admin, input());
  assert.equal(sponsor.enabled, false);
  assert.equal(sponsor.version, 1);
  assert.equal(sponsor.createdBy, 'operator');
  assert.equal(sponsor.updatedBy, 'operator');
  assert.match(sponsor.id, /^[a-f0-9]{24}$/);
  assert.equal(sponsor.targetHostname, 'sponsor.example.com');
  assert.ok(database().prepare("SELECT 1 FROM audit WHERE action='create-sponsor' AND target=?").get(sponsor.id));
  assert.equal(sponsors.listSponsors().length, 1);
});

test('URL 只接受公开 HTTPS：协议、凭据、本机/私网与无点主机全部拒绝', () => {
  const bad = [
    'http://sponsor.example.com/', '//sponsor.example.com/', 'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'ftp://sponsor.example.com/',
    'https://user:pass@sponsor.example.com/', 'https://localhost/', 'https://foo.localhost/',
    'https://127.0.0.1/', 'https://10.1.2.3/', 'https://169.254.169.254/',
    'https://[::1]/', 'https://[fc00::1]/', 'https://metadata.google.internal/',
    'https://intranet/', 'https://sponsor.example.com/\u0000',
  ];
  for (const targetUrl of bad) {
    expectStatus(() => sponsors.createSponsor(admin, input({ targetUrl })), 400, /HTTPS|目标地址|主机名|控制字符|URL|账号或密码/);
  }
  const valid = sponsors.createSponsor(admin, input({ targetUrl: 'https://sponsor.example.com:8443/path?a=1' }));
  assert.equal(valid.targetHostname, 'sponsor.example.com');
  expectStatus(() => sponsors.createSponsor(admin, input({ title: '带\u0007控制符' })), 400, /控制字符/);
});

test('权限实时校验：匿名 401、编辑者/伪造角色 403、停用管理员 401', () => {
  expectStatus(() => sponsors.createSponsor({ id: 99999, username: 'x', role: 'admin', active: true, version: 1 }, input()), 401, /登录已失效/);
  expectStatus(() => sponsors.createSponsor(editor, input()), 403, /仅限管理员/);
  expectStatus(() => sponsors.createSponsor({ ...editor, role: 'admin' }, input()), 403, /仅限管理员/);
  const created = sponsors.createSponsor(admin, input());
  database().prepare('UPDATE users SET active=0 WHERE id=?').run(admin.id);
  expectStatus(() => sponsors.updateSponsor(admin, created.id, input({ title: '停用账户' }), 1), 401, /登录已失效/);
  database().prepare('UPDATE users SET active=1 WHERE id=?').run(admin.id);
});

test('更新/删除使用 version CAS，保留 created 字段', () => {
  const created = sponsors.createSponsor(admin, input());
  expectStatus(() => sponsors.updateSponsor(admin, created.id, input({ title: '旧页面' }), 99), 409, /其他维护者/);
  const updated = sponsors.updateSponsor(admin, created.id, input({ title: '新标题', body: '更新后的正文' }), 1);
  assert.equal(updated.version, 2);
  assert.equal(updated.title, '新标题');
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.createdBy, 'operator');
  expectStatus(() => sponsors.deleteSponsor(admin, created.id, 1), 409, /其他维护者/);
  sponsors.deleteSponsor(admin, created.id, 2);
  assert.equal(sponsors.findSponsor(created.id), undefined);
});

test('时间规范化为 UTC，必须带时区且 start < end', () => {
  const sponsor = sponsors.createSponsor(admin, input({
    enabled: true,
    startsAt: '2026-10-01T10:00:00+08:00',
    endsAt: '2026-10-01T12:00:00+08:00',
  }));
  assert.equal(sponsor.startsAt, '2026-10-01T02:00:00.000Z');
  assert.equal(sponsor.endsAt, '2026-10-01T04:00:00.000Z');
  expectStatus(() => sponsors.createSponsor(admin, input({ placement: 'catalog-promotion', startsAt: '2026-10-01T10:00', endsAt: null })), 400, /时区/);
  expectStatus(() => sponsors.createSponsor(admin, input({ placement: 'catalog-promotion', startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T10:00:00Z' })), 400, /晚于/);
});

test('同位置时间重叠拒绝；边界相接、不同位置与停用项允许', () => {
  const first = sponsors.createSponsor(admin, input({
    enabled: true, startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T12:00:00Z',
  }));
  expectStatus(() => sponsors.createSponsor(admin, input({
    enabled: true, startsAt: '2026-10-01T11:00:00Z', endsAt: '2026-10-01T13:00:00Z',
  })), 409, /重叠/);
  const touching = sponsors.createSponsor(admin, input({
    enabled: true, startsAt: '2026-10-01T12:00:00Z', endsAt: '2026-10-01T14:00:00Z',
  }));
  const otherPlacement = sponsors.createSponsor(admin, input({
    enabled: true, placement: 'catalog-promotion', startsAt: '2026-10-01T11:00:00Z', endsAt: '2026-10-01T13:00:00Z',
  }));
  const disabledOverlap = sponsors.createSponsor(admin, input({
    enabled: false, startsAt: '2026-10-01T11:00:00Z', endsAt: '2026-10-01T13:00:00Z',
  }));
  assert.ok(first && touching && otherPlacement && disabledOverlap);
  expectStatus(() => sponsors.createSponsor(admin, input({
    enabled: true, startsAt: null, endsAt: null,
  })), 409, /重叠/);
  // 更新自己同一时间窗允许；启用原本停用的重叠项仍然拒绝。
  const renamed = sponsors.updateSponsor(admin, first.id, input({
    title: '改标题', enabled: true, startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T12:00:00Z',
  }), first.version);
  assert.equal(renamed.title, '改标题');
  expectStatus(() => sponsors.updateSponsor(admin, disabledOverlap.id, input({
    enabled: true, startsAt: '2026-10-01T11:00:00Z', endsAt: '2026-10-01T13:00:00Z',
  }), disabledOverlap.version), 409, /重叠/);
});

test('媒体必须 ready、未下架、授权确认且有署名；有图必须有 alt', async () => {
  const confirmed = 'a'.repeat(64);
  insertMedia(confirmed);
  expectStatus(() => sponsors.createSponsor(admin, input({ mediaId: confirmed })), 400, /替代文本/);
  const unconfirmed = 'b'.repeat(64);
  insertMedia(unconfirmed, { rights: 'unconfirmed' });
  expectStatus(() => sponsors.createSponsor(admin, input({ mediaId: unconfirmed, imageAlt: '图' })), 400, /授权/);
  const noCredit = 'c'.repeat(64);
  insertMedia(noCredit, { credit: '  ' });
  expectStatus(() => sponsors.createSponsor(admin, input({ mediaId: noCredit, imageAlt: '图' })), 400, /署名/);
  const removed = 'd'.repeat(64);
  insertMedia(removed, { deletedAt: ISO });
  expectStatus(() => sponsors.createSponsor(admin, input({ mediaId: removed, imageAlt: '图' })), 400, /下架/);
  expectStatus(() => sponsors.createSponsor(admin, input({ mediaId: 'e'.repeat(64), imageAlt: '图' })), 400, /不存在/);
  const sponsor = sponsors.createSponsor(admin, input({ mediaId: confirmed, imageAlt: '赞助方界面' }));
  assert.equal(sponsor.mediaId, confirmed);
  assert.equal(sponsor.imageAlt, '赞助方界面');
  const refs = await import('../src/server/media-references.ts');
  assert.ok(refs.scanMediaReferences(confirmed).some((reference) => reference.kind === 'sponsor'), '赞助图片必须进入引用图');
  assert.ok(refs.collectReferencedMediaIds(database()).has(confirmed), '离线扫描同样覆盖赞助');

  const available = sponsors.sponsorPreview(sponsor);
  assert.equal(available.imageState, 'available');
  assert.equal(available.imageSrc, `/media/${confirmed}.webp`);

  database().prepare('UPDATE media SET deleted_at=? WHERE id=?').run(ISO, confirmed);
  const unavailable = sponsors.sponsorPreview(sponsor);
  assert.equal(unavailable.imageState, 'unavailable');
  assert.equal(unavailable.imageSrc, null, '下架后预览不能输出必定 404 的图片 URL');
  assert.equal(unavailable.mediaId, confirmed, '预览保留原 mediaId');
  assert.equal(unavailable.imageAlt, '赞助方界面', '预览保留 alt');
  assert.match(String(unavailable.imageProblem), /下架|删除/);

  database().prepare("UPDATE media SET deleted_at=NULL,state='purging' WHERE id=?").run(confirmed);
  assert.equal(sponsors.sponsorPreview(sponsor).imageState, 'unavailable');

  database().prepare("UPDATE media SET state='ready',rights='unconfirmed' WHERE id=?").run(confirmed);
  assert.match(String(sponsors.sponsorPreview(sponsor).imageProblem), /授权/);

  database().prepare("UPDATE media SET rights='confirmed' WHERE id=?").run(confirmed);
  const restored = sponsors.sponsorPreview(sponsor);
  assert.equal(restored.imageState, 'available');
  assert.equal(restored.imageSrc, `/media/${confirmed}.webp`);

  const textSponsor = sponsors.createSponsor(admin, input({ mediaId: null, imageAlt: '' }));
  assert.equal(sponsors.sponsorPreview(textSponsor).imageState, 'none');
  assert.equal(sponsors.sponsorPreview(textSponsor).imageSrc, null);
});

test('总开关 CAS：缺行关闭、显式开启、旧版本 409；关闭不删除赞助数据', () => {
  const created = sponsors.createSponsor(admin, input({ enabled: true }));
  const view = sponsors.getSponsorSettingsView();
  assert.equal(view.enabled, false);
  assert.equal(view.version, null);
  assert.equal(sponsors.getActiveSponsors().length, 0);
  expectStatus(() => sponsors.saveSponsorSettings(editor, { enabled: true }, 0), 403, /仅限管理员/);
  const saved = sponsors.saveSponsorSettings(admin, { enabled: true }, 0);
  assert.equal(saved.version, 1);
  assert.equal(sponsors.isSponsorEnabled(), true);
  expectStatus(() => sponsors.saveSponsorSettings(admin, { enabled: false }, 0), 409, /其他维护者/);
  const off = sponsors.saveSponsorSettings(admin, { enabled: false }, 1);
  assert.equal(off.version, 2);
  assert.equal(sponsors.isSponsorEnabled(), false);
  assert.equal(sponsors.getActiveSponsors().length, 0);
  assert.ok(sponsors.findSponsor(created.id), '关闭总开关不能删除赞助数据');
  assert.ok(database().prepare("SELECT 1 FROM audit WHERE action='save-sponsor-settings'").get());
});

test('公开查询：总开关、启用、时间边界与媒体可用性共同决定展示', () => {
  const mediaId = 'f'.repeat(64);
  insertMedia(mediaId);
  const sponsor = sponsors.createSponsor(admin, input({
    enabled: true, mediaId, imageAlt: '赞助图', startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T12:00:00Z',
  }));
  assert.equal(sponsors.getActiveSponsors(new Date('2026-10-01T11:00:00Z')).length, 0, '总开关默认关闭');
  sponsors.saveSponsorSettings(admin, { enabled: true }, 0);
  assert.equal(sponsors.getActiveSponsors(new Date('2026-10-01T09:59:59Z')).length, 0, '未开始不展示');
  const active = sponsors.getActiveSponsors(new Date('2026-10-01T10:00:00Z'));
  assert.equal(active.length, 1);
  assert.equal(active[0].label, '广告 · 赞助');
  assert.equal(active[0].imageSrc, `/media/${mediaId}.webp`);
  assert.equal(active[0].targetHostname, 'sponsor.example.com');
  assert.equal(sponsors.getActiveSponsors(new Date('2026-10-01T12:00:00Z')).length, 0, '结束时刻为排除边界');
  // 图片在展示前下架 → 整条不展示。
  database().prepare('UPDATE media SET deleted_at=? WHERE id=?').run(ISO, mediaId);
  assert.equal(sponsors.getActiveSponsors(new Date('2026-10-01T11:00:00Z')).length, 0);
  // 停用单项也不展示。
  database().prepare('UPDATE media SET deleted_at=NULL WHERE id=?').run(mediaId);
  sponsors.updateSponsor(admin, sponsor.id, input({
    enabled: false, mediaId, imageAlt: '赞助图', startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T12:00:00Z',
  }), sponsor.version);
  assert.equal(sponsors.getActiveSponsors(new Date('2026-10-01T11:00:00Z')).length, 0);
});

function rawError(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail('预期抛出错误');
}

test('审计失败时创建/更新整体回滚', () => {
  database().exec("CREATE TRIGGER fail_sponsor_audit BEFORE INSERT ON audit WHEN NEW.action IN ('create-sponsor','update-sponsor') BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.match(String(rawError(() => sponsors.createSponsor(admin, input())).message), /boom/);
  assert.equal(sponsors.listSponsors().length, 0);
  database().exec('DROP TRIGGER fail_sponsor_audit');
  const created = sponsors.createSponsor(admin, input());
  database().exec("CREATE TRIGGER fail_sponsor_update BEFORE INSERT ON audit WHEN NEW.action='update-sponsor' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.match(String(rawError(() => sponsors.updateSponsor(admin, created.id, input({ title: '不应保存' }), created.version)).message), /boom/);
  assert.equal(sponsors.findSponsor(created.id).title, '示例赞助');
});
