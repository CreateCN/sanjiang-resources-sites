import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const root = mkdtempSync(join(tmpdir(), 'sj-media-'));
let sequence = 0;
process.env.DATABASE_PATH = join(root, 'boot.sqlite');
process.env.MEDIA_DIR = join(root, 'media');
delete process.env.MEDIA_QUOTA_BYTES;
delete process.env.MEDIA_BUNDLE_MAX_BYTES;
delete process.env.MEDIA_MIN_FREE_BYTES;

const store = await import('../src/server/store.ts');
const media = await import('../src/server/media.ts');
const refs = await import('../src/server/media-references.ts');
const { database, closeDatabase } = await import('../src/server/db.ts');

const PASSWORD = 'media-test-password-2026!';
let admin;
let editor;

beforeEach(async () => {
  closeDatabase();
  process.env.DATABASE_PATH = join(root, `${++sequence}.sqlite`);
  process.env.MEDIA_DIR = join(root, `media-${sequence}`);
  delete process.env.MEDIA_QUOTA_BYTES;
  delete process.env.MEDIA_BUNDLE_MAX_BYTES;
  delete process.env.MEDIA_MIN_FREE_BYTES;
  admin = store.createInitialAdmin('operator', PASSWORD);
  editor = store.createUser(admin, 'editor', PASSWORD, 'editor');
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(process.env.MEDIA_DIR, { recursive: true, mode: 0o700 }));
});
after(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

const png = (width = 400, height = 300, background = '#336699') =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

function throwsStatus(fn, status, pattern) {
  try { fn(); } catch (error) {
    if (pattern) assert.match(String(error.message), pattern);
    assert.equal(error.status, status, `期望 ${status}，实际 ${error?.status}: ${error?.message}`);
    return error;
  }
  assert.fail(`期望抛出 ${status}，但没有抛错`);
}
async function rejectsStatus(promise, status, pattern) {
  try { await promise; } catch (error) {
    if (pattern) assert.match(String(error.message), pattern);
    assert.equal(error.status, status, `期望 ${status}，实际 ${error?.status}: ${error?.message}`);
    return error;
  }
  assert.fail(`期望拒绝 ${status}，但成功了`);
}

const upload = (bytes, overrides = {}) => media.ingestUpload(editor, { bytes, name: 'shot.png', rights: 'confirmed', credit: '测试 / CC0', ...overrides });

function objectFiles(id) {
  return readdirSync(join(media.objectsDir(), id)).sort();
}

function resourceWith(image, extra = {}) {
  return {
    id: 'media-resource', title: '图片资源', summary: '用于测试图片引用', category: 'writing',
    kind: '开源工具', cost: '免费', platforms: ['网页'], tags: ['测试'],
    url: 'https://example.com/tool', sourceUrl: 'https://example.com/source',
    license: 'MIT', eligibility: '无', caveat: '无', steps: ['打开网站'],
    status: 'review', checkedAt: null, image, imageAlt: '测试图片', imageRights: 'confirmed', imageCredit: '测试 / CC0',
    ...extra,
  };
}

/* --------------------------------------------------------------- encoding */

test('PNG/JPEG/WebP 都会被重新编码为 WebP 主图与变体，并剥离元数据', async () => {
  const source = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#445577' } })
    .jpeg().withMetadata({ exif: { IFD0: { ImageDescription: 'secret gps 39.9,116.4' } } }).toBuffer();
  assert.ok(source.length > 0);
  const view = await upload(source, { name: '../../evil name.jpg' });
  assert.match(view.src, /^\/media\/[a-f0-9]{64}\.webp$/);
  assert.equal(view.width, 1200);
  assert.equal(view.height, 800);
  const files = objectFiles(view.id);
  assert.deepEqual(files, ['320.webp', '640.webp', '960.webp', 'manifest.json', 'master.webp'].sort(), '1200px 主图不生成 1280 变体（禁止放大）');
  const metadata = await sharp(join(media.objectsDir(), view.id, 'master.webp')).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.exif, undefined, '必须移除 EXIF/GPS');
  assert.equal(metadata.icc, undefined, '必须移除 ICC');
  const variant = await sharp(join(media.objectsDir(), view.id, '640.webp')).metadata();
  assert.equal(variant.width, 640);
  assert.equal(variant.height, 427);
  const row = media.findMedia(view.id);
  assert.equal(row?.rights, 'confirmed');
  assert.equal(row?.credit, '测试 / CC0');
  assert.equal(row?.source_name.includes('/'), false, '原始文件名不参与路径');
  assert.equal(media.verifyBundle(view.id).ok, true);
});

test('按 EXIF 方向旋转后再生成尺寸', async () => {
  const rotated = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#889900' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const view = await upload(rotated, { name: 'rotated.jpg' });
  assert.equal(view.width, 300);
  assert.equal(view.height, 400);
});

test('拒绝空文件、超限、伪装格式、截断、过小、过大与极端比例', async () => {
  await rejectsStatus(upload(Buffer.alloc(0)), 400, /为空/);
  const oversized = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]);
  await rejectsStatus(upload(oversized), 413, /5 MiB/);
  await rejectsStatus(upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 415, /PNG/);
  const valid = await png(400, 300);
  await rejectsStatus(upload(valid.subarray(0, 40)), 415, /无法解码/);
  await rejectsStatus(upload(await png(120, 120)), 400, /边长/);
  await rejectsStatus(upload(await png(5200, 400)), 400, /边长/);
  await rejectsStatus(upload(await png(2000, 300)), 400, /宽高比/);
  await rejectsStatus(upload(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)])), 415, /PNG/);
  // 占位必须是"拒绝"，不能留下对象或配额。
  assert.equal(media.listMedia().length, 0);
  assert.equal(media.guardHolder(), null);
  assert.equal(media.usage().reservedBytes, 0, '失败必须释放预留');
  assert.ok(media.pendingOperations().every((operation) => operation.reserved_bytes === 0 && operation.phase === 'failed'), '失败记录保留用于对账，但不得占配额');
});

test('输出体积上限可以被收紧（只允许收紧）', async () => {
  process.env.MEDIA_BUNDLE_MAX_BYTES = '2048';
  const noisy = await sharp({ create: { width: 900, height: 700, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();
  await rejectsStatus(upload(noisy), 507, /输出体积/);
  assert.equal(media.listMedia().length, 0);
  assert.equal(media.guardHolder(), null);
});

/* ---------------------------------------------------------------- storage */

test('重复上传复用同一文件组，不覆盖、不新增对象', async () => {
  const bytes = await png(500, 400);
  const first = await upload(bytes);
  const second = await upload(bytes);
  assert.equal(first.id, second.id);
  assert.equal(readdirSync(media.objectsDir()).length, 1);
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM media').get().total), 1);
  assert.equal(Number(database().prepare("SELECT COUNT(*) AS total FROM audit WHERE action='upload-media'").get().total), 2);
  assert.equal(media.guardHolder(), null, '重复上传也必须释放占位');
});

test('占位被占用时返回 503 且不写文件', async () => {
  database().prepare("UPDATE media_store_guard SET operation_id='someone-else' WHERE id=1").run();
  const error = await rejectsStatus(upload(await png()), 503, /媒体操作/);
  assert.ok(Number(error.retryAfterMs) > 0, '503 必须带真实 Retry-After');
  assert.equal(readdirSync(media.objectsDir()).length, 0);
  database().prepare('UPDATE media_store_guard SET operation_id=NULL WHERE id=1').run();
});

test('配额不足在落盘前拒绝，且预留参与计费', async () => {
  process.env.MEDIA_QUOTA_BYTES = String(media.RESERVATION_BYTES - 1);
  await rejectsStatus(upload(await png()), 507, /容量/);
  assert.equal(readdirSync(media.objectsDir()).length, 0);
  assert.equal(media.usage().reservedBytes, 0);

  process.env.MEDIA_QUOTA_BYTES = String(media.RESERVATION_BYTES + 1024 * 1024);
  const view = await upload(await png());
  const usage = media.usage();
  assert.equal(usage.reservedBytes, 0);
  assert.equal(usage.totalBytes, media.findMedia(view.id)?.total_bytes);
});

test('提交阶段审计失败：对象保留、媒体不可见、占位与预留保留', async () => {
  database().exec("CREATE TRIGGER fail_upload_audit BEFORE INSERT ON audit WHEN NEW.action='upload-media' BEGIN SELECT RAISE(ABORT,'audit down'); END;");
  const bytes = await png(600, 400);
  await rejectsStatus(upload(bytes), undefined, /audit down/);
  const objects = readdirSync(media.objectsDir());
  assert.equal(objects.length, 1, '已安装对象必须保留现场');
  assert.equal(Number(database().prepare('SELECT COUNT(*) AS total FROM media').get().total), 0, '审计失败时媒体不可见');
  const ops = media.pendingOperations();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].phase, 'installed-failed');
  assert.ok(ops[0].reserved_bytes > 0, '安装后失败不得释放预留');
  assert.equal(media.guardHolder(), ops[0].id);
  database().exec('DROP TRIGGER fail_upload_audit');
});

/* -------------------------------------------------------------- lifecycle */

test('下架后不再对外服务；恢复需要版本与理由；编辑者不能下架', async () => {
  const view = await upload(await png(640, 480));
  const row = media.findMedia(view.id);
  assert.ok(media.findServableMedia(view.id));
  assert.ok(media.resolveMediaFile(`${view.id}.webp`));

  throwsStatus(() => media.deleteMedia(editor, view.id, row.version, '编辑者尝试'), 403);
  throwsStatus(() => media.deleteMedia(admin, view.id, row.version + 9, '版本不符'), 409);
  media.deleteMedia(admin, view.id, row.version, '截图过期');
  assert.equal(media.findServableMedia(view.id), undefined);
  assert.equal(media.resolveMediaFile(`${view.id}.webp`), undefined, '下架后 URL 解析必须失败');
  assert.ok(existsSync(join(media.objectsDir(), view.id)), '下架保留文件供历史引用');

  const deleted = media.findMedia(view.id);
  throwsStatus(() => media.restoreMedia(editor, view.id, deleted.version, '编辑者尝试'), 403);
  media.restoreMedia(admin, view.id, deleted.version, '重新启用');
  assert.ok(media.findServableMedia(view.id));
});

test('引用保护：结构化字段、Markdown、指南、历史修订与回收站都阻止 purge', async () => {
  const view = await upload(await png(800, 600));
  const src = view.src;
  store.saveResource(admin, resourceWith(src, { details: `正文图片：![截图](${src})` }), null);
  store.saveGuide(admin, { slug: 'media-guide', title: '指南', summary: '', body: `引用式：![截图][shot]\n\n[shot]: ${src}`, resources: ['media-resource'] }, null);
  // 回收站中的条目同样受保护
  const live = store.findManagedResource('media-resource');
  store.changePublication(admin, 'media-resource', live.version, 'publish');
  store.changePublication(admin, 'media-resource', store.findManagedResource('media-resource').version, 'delete-resource');

  const references = refs.scanMediaReferences(view.id);
  assert.ok(references.some((reference) => reference.kind === 'resource' && reference.label.includes('回收站')), '回收站条目同样计入引用');
  assert.ok(references.some((reference) => reference.kind === 'guide'));
  assert.ok(references.some((reference) => reference.kind === 'revision'), '历史修订也必须阻止清理');

  media.deleteMedia(admin, view.id, media.findMedia(view.id).version, '准备删除');
  const error = throwsStatus(() => media.purgeMedia(admin, view.id, media.findMedia(view.id).version), 409, /仍被引用/);
  assert.match(error.message, /资源|指南|修订/);
  assert.ok(existsSync(join(media.objectsDir(), view.id)));
});

test('无引用时可彻底删除并留下墓碑；同图不能再次上传', async () => {
  const bytes = await png(320, 320);
  const view = await upload(bytes);
  media.deleteMedia(admin, view.id, media.findMedia(view.id).version, '不再使用');
  media.purgeMedia(admin, view.id, media.findMedia(view.id).version);
  assert.equal(media.findMedia(view.id), undefined);
  assert.equal(existsSync(join(media.objectsDir(), view.id)), false, '文件必须被物理删除');
  const tombstone = database().prepare('SELECT * FROM media_tombstones WHERE id=?').get(view.id);
  assert.ok(tombstone, '必须留下墓碑');
  await rejectsStatus(upload(bytes), 409, /彻底删除/);
  assert.equal(media.guardHolder(), null);
});

test('已下架的图片不能通过重新上传复活（admin 也一样）', async () => {
  const bytes = await png(500, 500);
  const view = await upload(bytes);
  media.deleteMedia(admin, view.id, media.findMedia(view.id).version, '下架');
  await rejectsStatus(upload(bytes), 409, /下架/);
  assert.equal(media.findServableMedia(view.id), undefined);
});

test('保存时新增不可用引用被拒；仅编辑其它字段可保留原有下架引用', () => {
  // 保存一条引用 /media/<不存在 id> 的资源必须失败
  const ghost = `/media/${'a'.repeat(64)}.webp`;
  throwsStatus(() => store.saveResource(admin, resourceWith(ghost), null), 400, /图片已下架或不存在/);
});

test('purging 状态拒绝新增引用', async () => {
  const view = await upload(await png());
  database().prepare("UPDATE media SET state='purging' WHERE id=?").run(view.id);
  throwsStatus(() => store.saveResource(admin, resourceWith(view.src), null), 400, /图片已下架或不存在/);
  database().prepare("UPDATE media SET state='ready' WHERE id=?").run(view.id);
});

/* --------------------------------------------------------------- references */

test('引用提取覆盖结构化字段、内联与引用式 Markdown', () => {
  const id = 'b'.repeat(64);
  const path = `/media/${id}.webp`;
  const resource = resourceWith(path, { steps: [`步骤图 ![s](${path})`], details: `[ref]: ${path}\n\n![x][ref]` });
  assert.deepEqual(refs.mediaIdsInPayload('resource', resource), [id]);
  const guide = { slug: 'g', title: 't', summary: '', body: `![a](${path})`, resources: [] };
  assert.deepEqual(refs.mediaIdsInPayload('guide', guide), [id]);
  const text = '只有链接 ' + path + ' 不算图片引用';
  assert.deepEqual(refs.mediaIdsInPayload('guide', { slug: 'g', title: 't', summary: '', body: text, resources: [] }), []);
});

test('stripUnavailableMedia 保留 alt 文本并移除引用', () => {
  const id = 'c'.repeat(64);
  const payload = resourceWith(`/media/${id}.webp`, { details: `前 ![说明](/media/${id}.webp) 后` });
  const { payload: stripped, removed } = refs.stripUnavailableMedia('resource', payload);
  assert.deepEqual(removed, [id]);
  assert.equal(stripped.image, undefined);
  assert.match(String(stripped.details), /前 说明 后/);
  assert.doesNotMatch(String(stripped.details), /media/);
});

/* ------------------------------------------------------------------ serving */

test('服务层只接受主图与已声明的变体，拒绝穿越与大小写变体', async () => {
  const view = await upload(await png(1200, 900));
  assert.ok(media.resolveMediaFile(`${view.id}.webp`));
  assert.ok(media.resolveMediaFile(`${view.id}-640.webp`));
  assert.equal(media.resolveMediaFile(`${view.id}-500.webp`), undefined, '未声明的宽度不能访问');
  assert.equal(media.resolveMediaFile(`${view.id.toUpperCase()}.webp`), undefined);
  assert.equal(media.resolveMediaFile(`../${view.id}.webp`), undefined);
  assert.equal(media.resolveMediaFile(`${view.id}.jpg`), undefined);
  assert.equal(media.resolveMediaFile('not-a-hash.webp'), undefined);
});

test('verifyBundle 能发现缺失与篡改', async () => {
  const view = await upload(await png(640, 480));
  assert.equal(media.verifyBundle(view.id).ok, true);
  const target = join(media.objectsDir(), view.id, '320.webp');
  const original = readFileSync(target);
  writeFileSync(target, Buffer.concat([original, Buffer.from('tamper')]));
  const verdict = media.verifyBundle(view.id);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /体积|哈希/);
  writeFileSync(target, original);
});

test('media-http：GET/HEAD 每次都查可用性，所有响应 no-store，下架后立即 404', async () => {
  const { serveMediaRequest } = await import('../src/server/media-http.ts');
  const view = await upload(await png(640, 480));
  const get = serveMediaRequest(new Request(`http://localhost/media/${view.id}.webp`));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/webp');
  assert.match(String(get.headers.get('cache-control')), /no-store/);
  assert.equal(Number(get.headers.get('content-length')) > 0, true);

  const head = serveMediaRequest(new Request(`http://localhost/media/${view.id}.webp`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  assert.equal(serveMediaRequest(new Request(`http://localhost/media/${view.id}.webp?v=1`)).status, 404, '查询串不接受');
  assert.equal(serveMediaRequest(new Request(`http://localhost/media/${view.id}.webp/`)).status, 404);
  assert.equal(serveMediaRequest(new Request(`http://localhost/media/${'a'.repeat(64)}.webp`)).status, 404);
  const unknown = serveMediaRequest(new Request(`http://localhost/media/${view.id}-500.webp`));
  assert.equal(unknown.status, 404);
  assert.match(String(unknown.headers.get('cache-control')), /no-store/, '错误响应也不能被缓存');
  assert.equal(serveMediaRequest(new Request(`http://localhost/media/${view.id}.webp`, { method: 'POST' })).status, 405);

  media.deleteMedia(admin, view.id, media.findMedia(view.id).version, '测试下架');
  const gone = serveMediaRequest(new Request(`http://localhost/media/${view.id}.webp`));
  assert.equal(gone.status, 404, '下架后新请求必须被拒绝');
  assert.equal(gone.headers.get('x-content-type-options'), 'nosniff');
});
