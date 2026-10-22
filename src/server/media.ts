import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statfsSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { database, transaction } from './db.ts';
import { audit, fail } from './security.ts';
import type { User } from './store.ts';
import { scanMediaReferences } from './media-references.ts';

/**
 * 媒体存储、上传流水线、配额与生命周期。
 *
 * 硬约束（SECURITY-SPEC §3.4 / §5.1 / §6）：
 * - 文件组（master + variants + manifest）一次原子安装，永不覆盖；
 * - 跨进程写操作靠 DB 中的 operation 占位 + 容量预留，不靠进程内变量或超时；
 * - 请求失败只能清理自己的 staging；安装后失败保留现场交给离线对账；
 * - 配额 = 已结算 total_bytes + 未结算 reserved_bytes，物理删除完成后才释放。
 */

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MULTIPART_MAX_BYTES = IMAGE_MAX_BYTES + 64 * 1024;
export const IMAGE_MAX_PIXELS = 40_000_000;
export const IMAGE_MIN_EDGE = 200;
export const IMAGE_MAX_EDGE = 5000;
export const VARIANT_WIDTHS = [320, 640, 960, 1280, 1920] as const;
export const DEFAULT_MEDIA_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MEDIA_QUOTA_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MEDIA_MIN_FREE_BYTES = 128 * 1024 * 1024;
/** 每次上传的保守预留：覆盖暂存 + 最终对象（同分区 rename 不复制）。 */
export const RESERVATION_BYTES = DEFAULT_MEDIA_BUNDLE_MAX_BYTES;
export const OPERATION_RETRY_SECONDS = 15;
export const ENCODING_VERSION = 'webp-q82-effort4-v1';

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function mediaQuotaBytes(): number {
  return positiveInt(process.env.MEDIA_QUOTA_BYTES, DEFAULT_MEDIA_QUOTA_BYTES);
}
/** 输出体积上限：环境变量只能收紧，不能放宽硬上限。 */
export function bundleMaxBytes(): number {
  return Math.min(DEFAULT_MEDIA_BUNDLE_MAX_BYTES, positiveInt(process.env.MEDIA_BUNDLE_MAX_BYTES, DEFAULT_MEDIA_BUNDLE_MAX_BYTES));
}
export function mediaMinFreeBytes(): number {
  return positiveInt(process.env.MEDIA_MIN_FREE_BYTES, DEFAULT_MEDIA_MIN_FREE_BYTES);
}
export function mediaRoot(): string {
  return resolve(process.env.MEDIA_DIR || './data/media');
}
export function objectsDir(): string { return join(mediaRoot(), 'objects'); }
export function stagingRoot(): string { return join(mediaRoot(), 'staging'); }
export function quarantineRoot(): string { return join(mediaRoot(), 'quarantine'); }

export function ensureMediaLayout(): void {
  for (const directory of [mediaRoot(), objectsDir(), stagingRoot(), quarantineRoot()]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

/* --------------------------------------------------------------- operations */

export type OperationKind = 'upload' | 'purge' | 'reconcile';
export interface OperationRow {
  id: string; kind: OperationKind; media_id: string | null; phase: string;
  reserved_bytes: number; owner: string; created_at: number; updated_at: number; failure: string;
}

export function operationRow(id: string): OperationRow | undefined {
  return database().prepare('SELECT * FROM media_operations WHERE id=?').get(id) as unknown as OperationRow | undefined;
}

export function pendingOperations(): OperationRow[] {
  return database().prepare('SELECT * FROM media_operations ORDER BY created_at').all() as unknown as OperationRow[];
}

export function guardHolder(): string | null {
  const row = database().prepare('SELECT operation_id FROM media_store_guard WHERE id=1').get();
  return row?.operation_id ? String(row.operation_id) : null;
}

export function usage(): { totalBytes: number; reservedBytes: number; quotaBytes: number; objects: number } {
  const db = database();
  const total = Number(db.prepare('SELECT COALESCE(SUM(total_bytes),0) AS n FROM media').get()?.n ?? 0);
  const reserved = Number(db.prepare('SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM media_operations').get()?.n ?? 0);
  const objects = Number(db.prepare('SELECT COUNT(*) AS n FROM media').get()?.n ?? 0);
  return { totalBytes: total, reservedBytes: reserved, quotaBytes: mediaQuotaBytes(), objects };
}

function freeDiskBytes(): number | null {
  try {
    ensureMediaLayout();
    const stats = statfsSync(mediaRoot());
    return Number(stats.bavail) * Number(stats.bsize);
  } catch { return null; }
}

/**
 * 取得全局操作占位并预留容量。占位忙 → 503（不排队、不抢占）。
 * 配额与磁盘余量都在同一事务内判断，避免并发通过。
 */
function beginOperation(kind: OperationKind, options: { mediaId?: string | null; reserve?: number } = {}): OperationRow {
  const reserve = options.reserve ?? 0;
  const id = randomUUID();
  const owner = `${process.pid}-${randomUUID()}`;
  return transaction((db) => {
    const now = Date.now();
    const acquired = db.prepare('UPDATE media_store_guard SET operation_id=?, updated_at=? WHERE id=1 AND operation_id IS NULL').run(id, now).changes;
    if (acquired !== 1) fail(503, '另一个媒体操作正在进行，请稍后重试', OPERATION_RETRY_SECONDS * 1000);
    const total = Number(db.prepare('SELECT COALESCE(SUM(total_bytes),0) AS n FROM media').get()?.n ?? 0);
    const reserved = Number(db.prepare('SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM media_operations').get()?.n ?? 0);
    if (total + reserved + reserve > mediaQuotaBytes()) fail(507, '媒体容量已满，请先清理不再使用的图片');
    if (reserve > 0) {
      const free = freeDiskBytes();
      if (free === null) fail(507, '无法确认磁盘余量，已拒绝写入媒体文件');
      if (free - reserve < mediaMinFreeBytes()) fail(507, '磁盘可用空间不足，已拒绝写入媒体文件');
    }
    db.prepare(`INSERT INTO media_operations (id,kind,media_id,phase,reserved_bytes,owner,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, kind, options.mediaId ?? null, 'reserved', reserve, owner, now, now);
    return operationRow(id)!;
  });
}

/** 结算成功：账户已转为 media 行或本身无预留；删除操作记录并释放占位。 */
function settleOperation(db: ReturnType<typeof database>, operationId: string): void {
  db.prepare('DELETE FROM media_operations WHERE id=?').run(operationId);
  db.prepare('UPDATE media_store_guard SET operation_id=NULL, updated_at=? WHERE id=1 AND operation_id=?').run(Date.now(), operationId);
}

/** 结算失败：保留失败记录、清零未结算预留并释放占位（仅限未安装任何最终对象时）。 */
function settleFailure(operationId: string, reason: string): void {
  transaction((db) => {
    db.prepare('UPDATE media_operations SET phase=?, failure=?, reserved_bytes=0, updated_at=? WHERE id=?')
      .run('failed', reason.slice(0, 300), Date.now(), operationId);
    db.prepare('UPDATE media_store_guard SET operation_id=NULL, updated_at=? WHERE id=1 AND operation_id=?').run(Date.now(), operationId);
  });
}

function releaseAfterInstallFailure(operationId: string, reason: string): void {
  // 安装后失败：保留占位与预留，等待离线对账；这里只记录原因。
  database().prepare('UPDATE media_operations SET phase=?, failure=?, updated_at=? WHERE id=?')
    .run('installed-failed', reason.slice(0, 300), Date.now(), operationId);
}

/* -------------------------------------------------------------------- rows */

export interface MediaVariant { file: string; width: number; height: number; bytes: number; sha256: string }
export interface MediaManifest {
  encodingVersion: string; id: string; sourceName: string; width: number; height: number;
  master: MediaVariant; variants: MediaVariant[];
}
export interface MediaRow {
  id: string; version: number; state: 'ready' | 'purging'; bytes: number; total_bytes: number;
  width: number; height: number; variants: string; encoding_version: string; source_name: string;
  uploaded_by: string; rights: 'confirmed' | 'unconfirmed'; credit: string; created_at: string;
  deleted_at: string | null; deleted_by: string | null; deleted_reason: string;
}
export interface MediaView {
  id: string; src: string; width: number; height: number; bytes: number; totalBytes: number;
  variants: { src: string; width: number; height: number }[];
}

export function findMedia(id: string): MediaRow | undefined {
  return database().prepare('SELECT * FROM media WHERE id=?').get(id) as unknown as MediaRow | undefined;
}
export function findServableMedia(id: string): MediaRow | undefined {
  return database().prepare("SELECT * FROM media WHERE id=? AND state='ready' AND deleted_at IS NULL").get(id) as unknown as MediaRow | undefined;
}
export function listMedia(): MediaRow[] {
  return database().prepare('SELECT * FROM media ORDER BY created_at DESC').all() as unknown as MediaRow[];
}

function manifestOf(row: MediaRow): MediaManifest {
  const parsed = JSON.parse(row.variants) as MediaManifest;
  return parsed;
}

export function mediaView(row: MediaRow): MediaView {
  const manifest = manifestOf(row);
  return {
    id: row.id,
    src: `/media/${row.id}.webp`,
    width: manifest.width,
    height: manifest.height,
    bytes: row.bytes,
    totalBytes: row.total_bytes,
    variants: manifest.variants.map((variant) => ({ src: `/media/${row.id}-${variant.width}.webp`, width: variant.width, height: variant.height })),
  };
}

/** 渲染层查询：`/media/<id>.webp` → 清单；不可用返回 undefined。 */
export function mediaImageInfo(src: string): { id: string; width: number; height: number; variants: { src: string; width: number; height: number }[] } | undefined {
  const match = /^\/media\/([a-f0-9]{64})\.webp$/.exec(src);
  if (!match) return undefined;
  const row = findServableMedia(match[1]!);
  if (!row) return undefined;
  const manifest = manifestOf(row);
  return {
    id: row.id,
    width: manifest.width,
    height: manifest.height,
    variants: manifest.variants.map((variant) => ({ src: `/media/${row.id}-${variant.width}.webp`, width: variant.width, height: variant.height })),
  };
}

/** 供 `/media/` 路由使用：请求的公共文件名 → 内部文件名。 */
export function resolveMediaFile(name: string): { id: string; file: string; width: number | null } | undefined {
  const master = /^([a-f0-9]{64})\.webp$/.exec(name);
  const variant = /^([a-f0-9]{64})-(320|640|960|1280|1920)\.webp$/.exec(name);
  const match = master ?? variant;
  if (!match) return undefined;
  const id = match[1]!;
  const width = variant ? Number(variant[2]) : null;
  const row = findServableMedia(id);
  if (!row) return undefined;
  const manifest = manifestOf(row);
  if (width !== null && !manifest.variants.some((entry) => entry.width === width)) return undefined;
  return { id, file: width === null ? 'master.webp' : `${width}.webp`, width };
}

/* ---------------------------------------------------------------- encoding */

function magicOf(bytes: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function sanitiseSourceName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return base.slice(0, 120) || 'upload';
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function fsyncDir(path: string): void {
  try { fsyncFile(path); } catch { /* 某些文件系统不支持目录 fsync；不阻断安装 */ }
}

interface BuiltBundle { manifest: MediaManifest; totalBytes: number; directory: string }

/**
 * 校验 + 转码 + 生成变体 + 写清单。只写调用方给的 staging 目录。
 * 顺序固定：magic bytes → 解码 → 元数据校验 → 主图 → 变体 → 清单。
 */
async function buildBundle(bytes: Buffer, directory: string, sourceName: string): Promise<BuiltBundle> {
  if (bytes.length === 0) fail(400, '上传的文件为空');
  if (bytes.length > IMAGE_MAX_BYTES) fail(413, '图片超过 5 MiB 上限');
  const magic = magicOf(bytes);
  if (!magic) fail(415, '只接受 PNG、JPEG 或 WebP 图片');

  const pipeline = sharp(bytes, { limitInputPixels: IMAGE_MAX_PIXELS, failOn: 'error', animated: false });
  const metadata = await pipeline.metadata().catch(() => { fail(415, '图片无法解码，请换一个文件'); });
  const format = metadata.format;
  if (!format || !['png', 'jpeg', 'webp'].includes(format)) fail(415, '只接受 PNG、JPEG 或 WebP 图片');
  if ((metadata.pages ?? 1) > 1) fail(415, '不接受动图或多页图片');
  const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
  const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
  if (width < IMAGE_MIN_EDGE || height < IMAGE_MIN_EDGE) fail(400, `图片边长至少 ${IMAGE_MIN_EDGE}px`);
  if (width > IMAGE_MAX_EDGE || height > IMAGE_MAX_EDGE) fail(400, `图片边长不能超过 ${IMAGE_MAX_EDGE}px`);
  const ratio = width / height;
  if (ratio > 4 || ratio < 0.25) fail(400, '图片宽高比必须在 1:4 到 4:1 之间');

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let master: Buffer;
  let masterInfo: { width?: number; height?: number };
  try {
    const result = await sharp(bytes, { limitInputPixels: IMAGE_MAX_PIXELS })
      .rotate()
      .toFormat('webp', { quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    master = result.data;
    masterInfo = result.info;
  } catch { return fail(415, '图片转码失败，请换一个文件'); }

  const masterWidth = masterInfo.width ?? width;
  const masterHeight = masterInfo.height ?? height;
  const id = sha256(master);
  let total = 0;
  const write = (name: string, data: Buffer): MediaVariant => {
    total += data.byteLength;
    if (total > bundleMaxBytes()) fail(507, '图片输出体积超过上限，请降低分辨率后再上传');
    const path = join(directory, name);
    writeFileSync(path, data, { mode: 0o640 });
    chmodSync(path, 0o640);
    fsyncFile(path);
    return { file: name, width: 0, height: 0, bytes: data.byteLength, sha256: sha256(data) };
  };

  const masterEntry = write('master.webp', master);
  masterEntry.width = masterWidth;
  masterEntry.height = masterHeight;

  const variants: MediaVariant[] = [];
  for (const target of VARIANT_WIDTHS) {
    if (target >= masterWidth) continue;
    let buffer: Buffer;
    try {
      buffer = await sharp(master).resize({ width: target, withoutEnlargement: true })
        .toFormat('webp', { quality: 80, effort: 4 }).toBuffer();
    } catch { return fail(415, '图片变体生成失败，请换一个文件'); }
    const entry = write(`${target}.webp`, buffer);
    const info = await sharp(buffer).metadata();
    entry.width = info.width ?? target;
    entry.height = info.height ?? Math.round(masterHeight * target / masterWidth);
    variants.push(entry);
  }

  const manifest: MediaManifest = {
    encodingVersion: ENCODING_VERSION,
    id,
    sourceName: sanitiseSourceName(sourceName),
    width: masterWidth,
    height: masterHeight,
    master: masterEntry,
    variants,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const manifestEntry = write('manifest.json', manifestBytes);
  manifestEntry.width = 0;
  manifestEntry.height = 0;
  fsyncDir(directory);
  return { manifest, totalBytes: total, directory };
}

/** 校验已安装的对象与清单完全一致（重复上传、恢复、巡检共用）。 */
export function verifyBundle(id: string): { ok: boolean; reason?: string } {
  const directory = join(objectsDir(), id);
  if (!existsSync(directory)) return { ok: false, reason: '对象目录不存在' };
  let manifest: MediaManifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as MediaManifest;
  } catch { return { ok: false, reason: '清单缺失或损坏' }; }
  if (manifest.id !== id) return { ok: false, reason: '清单与目录 ID 不一致' };
  for (const entry of [manifest.master, ...manifest.variants]) {
    const path = join(directory, entry.file);
    if (!existsSync(path)) return { ok: false, reason: `缺少文件 ${entry.file}` };
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reason: `${entry.file} 不是普通文件` };
    const data = readFileSync(path);
    if (data.byteLength !== entry.bytes) return { ok: false, reason: `${entry.file} 体积不符` };
    if (sha256(data) !== entry.sha256) return { ok: false, reason: `${entry.file} 哈希不符` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ upload */

export interface UploadInput {
  bytes: Buffer;
  name: string;
  rights: 'confirmed' | 'unconfirmed';
  credit: string;
}

function assertActor(db: ReturnType<typeof database>, actor: User): { id: number; username: string; role: string; active: number } {
  const row = db.prepare('SELECT id,username,role,active FROM users WHERE id=?').get(actor.id);
  if (!row || !Number(row.active)) fail(401, '登录已失效，请重新登录');
  return row as unknown as { id: number; username: string; role: string; active: number };
}

function rowFromManifest(manifest: MediaManifest, totalBytes: number, actor: User, input: UploadInput): void {
  const db = database();
  db.prepare(`INSERT INTO media (id,version,state,bytes,total_bytes,width,height,variants,encoding_version,
    source_name,uploaded_by,rights,credit,created_at) VALUES (?,1,'ready',?,?,?,?,?,?,?,?,?,?,?)`)
    .run(manifest.id, manifest.master.bytes, totalBytes, manifest.width, manifest.height,
      JSON.stringify(manifest), manifest.encodingVersion, sanitiseSourceName(input.name),
      actor.username, input.rights, input.credit, new Date().toISOString());
}

export async function ingestUpload(actor: User, input: UploadInput): Promise<MediaView> {
  if (input.rights === 'confirmed' && input.credit.trim().length === 0) fail(400, '确认授权时必须填写署名与许可');
  if (input.credit.length > 300) fail(400, '署名与许可不能超过 300 个字符');
  ensureMediaLayout();
  const operation = beginOperation('upload', { reserve: RESERVATION_BYTES });
  const staging = join(stagingRoot(), operation.id, 'bundle');
  let installed = false;
  try {
    const built = await buildBundle(input.bytes, staging, input.name);
    const id = built.manifest.id;

    // 1) 下架或墓碑：普通上传不得复活。
    const tombstone = database().prepare('SELECT 1 FROM media_tombstones WHERE id=?').get(id);
    if (tombstone) fail(409, '该图片已被管理员彻底删除，不能重新上传；请换一张图片');
    const existing = findMedia(id);
    if (existing && (existing.deleted_at || existing.state === 'purging')) {
      fail(409, '该图片已被管理员下架，不能通过上传恢复；请联系管理员在媒体库中恢复');
    }

    // 2) 重复上传：校验原文件组后复用，不改索引、署名与下架状态。
    if (existing) {
      const verdict = verifyBundle(id);
      if (!verdict.ok) fail(503, `已有对象校验失败（${verdict.reason}），需要运行离线对账`);
      rmSync(join(stagingRoot(), operation.id), { recursive: true, force: true });
      transaction((db) => {
        const current = assertActor(db, actor);
        db.prepare('UPDATE media_operations SET reserved_bytes=0, phase=?, updated_at=? WHERE id=?').run('duplicate', Date.now(), operation.id);
        audit(current.username, 'upload-media', `${id} duplicate`);
        settleOperation(db, operation.id);
      });
      installed = true; // 已结算；catch 不应再释放（此时占位已清空）
      return mediaView(existing);
    }

    // 3) 未登记的最终目录：绝不覆盖，交给对账。
    if (existsSync(join(objectsDir(), id))) {
      fail(503, '检测到未登记的同名对象目录，需要运行离线对账后才能继续上传');
    }

    // 4) 先持久化操作与媒体 ID，再原子安装完整文件组。
    transaction((db) => {
      db.prepare('UPDATE media_operations SET media_id=?, phase=?, updated_at=? WHERE id=? AND owner=?')
        .run(id, 'staged', Date.now(), operation.id, operation.owner);
    });
    const finalDirectory = join(objectsDir(), id);
    try {
      renameSync(staging, finalDirectory);
    } catch {
      fail(503, '安装媒体文件组失败，需要运行离线对账');
    }
    fsyncDir(objectsDir());
    installed = true;

    // 5) 业务登记 + 审计 + 结算，同一个事务。
    const view = transaction((db) => {
      const current = assertActor(db, actor);
      const op = db.prepare('SELECT id,owner,phase,media_id FROM media_operations WHERE id=?').get(operation.id);
      if (!op || String(op.owner) !== operation.owner || String(op.phase) !== 'staged' || String(op.media_id) !== id) {
        fail(503, '媒体操作状态已变化，需要运行离线对账');
      }
      rowFromManifest(built.manifest, built.totalBytes, { ...actor, username: current.username }, input);
      audit(current.username, 'upload-media', id);
      settleOperation(db, operation.id);
      return mediaView(findMedia(id)!);
    });
    return view;
  } catch (error) {
    // 只有"尚未安装最终对象"的失败才释放预留；安装后失败保留现场给对账。
    if (!installed) {
      try { rmSync(join(stagingRoot(), operation.id), { recursive: true, force: true }); } catch { /* best effort */ }
      settleFailure(operation.id, error instanceof Error ? error.message : '上传失败');
    } else {
      const row = operationRow(operation.id);
      if (row) {
        if (row.phase === 'staged' || row.phase === 'installed-failed') releaseAfterInstallFailure(operation.id, error instanceof Error ? error.message : '提交失败');
      }
    }
    throw error;
  }
}

/* -------------------------------------------------------------- lifecycle */

export function deleteMedia(actor: User, id: string, version: number | null, reason: string): void {
  const text = reason.trim();
  if (text.length < 2 || text.length > 200) fail(400, '请填写 2–200 个字符的下架原因');
  const operation = beginOperation('purge', { mediaId: id });
  try {
    transaction((db) => {
      const current = assertActor(db, actor);
      if (current.role !== 'admin') fail(403, '只有管理员可以下架媒体');
      const row = db.prepare('SELECT * FROM media WHERE id=?').get(id) as unknown as MediaRow | undefined;
      if (!row) fail(404, '媒体不存在');
      if (version === null || row.version !== version) fail(409, '该媒体已被其他维护者修改；请重新加载媒体库');
      if (row.deleted_at) fail(409, '该媒体已经下架');
      db.prepare('UPDATE media SET deleted_at=?, deleted_by=?, deleted_reason=?, version=version+1 WHERE id=?')
        .run(new Date().toISOString(), current.username, text, id);
      audit(current.username, 'delete-media', `${id} (${text})`);
      settleOperation(db, operation.id);
    });
  } catch (error) {
    settleFailure(operation.id, error instanceof Error ? error.message : '下架失败');
    throw error;
  }
}

export function restoreMedia(actor: User, id: string, version: number | null, reason: string): void {
  const text = reason.trim();
  if (text.length < 2 || text.length > 200) fail(400, '请填写 2–200 个字符的恢复理由');
  const operation = beginOperation('purge', { mediaId: id });
  try {
    const verdict = verifyBundle(id);
    if (!verdict.ok) fail(409, `文件组校验失败（${verdict.reason}），不能恢复；请先运行离线对账`);
    transaction((db) => {
      const current = assertActor(db, actor);
      if (current.role !== 'admin') fail(403, '只有管理员可以恢复媒体');
      const row = db.prepare('SELECT * FROM media WHERE id=?').get(id) as unknown as MediaRow | undefined;
      if (!row) fail(404, '媒体不存在');
      if (version === null || row.version !== version) fail(409, '该媒体已被其他维护者修改；请重新加载媒体库');
      if (!row.deleted_at) fail(409, '该媒体没有被下架');
      if (row.state !== 'ready') fail(409, '该媒体正在删除流程中，不能恢复');
      db.prepare('UPDATE media SET deleted_at=NULL, deleted_by=NULL, deleted_reason=?, version=version+1 WHERE id=?').run('', id);
      audit(current.username, 'restore-media', `${id} (${text})`);
      settleOperation(db, operation.id);
    });
  } catch (error) {
    settleFailure(operation.id, error instanceof Error ? error.message : '恢复失败');
    throw error;
  }
}

/**
 * 彻底删除：仅已下架且全量引用为零时允许。
 * 文件删除不是可回滚操作，因此顺序是"标记 purging → 删文件 → 事务内写墓碑并删行"。
 */
export function purgeMedia(actor: User, id: string, version: number | null): void {
  const operation = beginOperation('purge', { mediaId: id });
  let filesRemoved = false;
  let markedPurging = false;
  try {
    transaction((db) => {
      const current = assertActor(db, actor);
      if (current.role !== 'admin') fail(403, '只有管理员可以彻底删除媒体');
      const row = db.prepare('SELECT * FROM media WHERE id=?').get(id) as unknown as MediaRow | undefined;
      if (!row) fail(404, '媒体不存在');
      if (version === null || row.version !== version) fail(409, '该媒体已被其他维护者修改；请重新加载媒体库');
      if (!row.deleted_at) fail(409, '必须先下架，才能彻底删除');
      if (row.state !== 'ready') fail(409, '该媒体已在删除流程中');
      const references = scanMediaReferences(id);
      if (references.length > 0) {
        const list = references.slice(0, 6).map((reference) => `${reference.label}（${reference.locations.join('、')}）`).join('；');
        fail(409, `不能彻底删除：仍被引用：${list}${references.length > 6 ? ` 等 ${references.length} 处` : ''}。请先移除引用或保留该图片`);
      }
      db.prepare("UPDATE media SET state='purging', version=version+1 WHERE id=?").run(id);
      audit(current.username, 'purge-media-start', id);
      db.prepare('UPDATE media_operations SET phase=?, updated_at=? WHERE id=?').run('purging', Date.now(), operation.id);
      markedPurging = true;
    });

    rmSync(join(objectsDir(), id), { recursive: true, force: true });
    filesRemoved = true;

    transaction((db) => {
      const current = assertActor(db, actor);
      const row = db.prepare('SELECT * FROM media WHERE id=?').get(id) as unknown as MediaRow | undefined;
      if (!row) fail(404, '媒体不存在');
      db.prepare('INSERT INTO media_tombstones (id,last_version,purged_at,reason,actor) VALUES (?,?,?,?,?)')
        .run(id, row.version, new Date().toISOString(), row.deleted_reason || '', current.username);
      db.prepare('DELETE FROM media WHERE id=?').run(id);
      audit(current.username, 'purge-media', id);
      settleOperation(db, operation.id);
    });
  } catch (error) {
    if (markedPurging || filesRemoved) {
      // 已进入 purging：保留占位与预留，由离线对账完成或回滚；配额不提前释放。
      releaseAfterInstallFailure(operation.id, error instanceof Error ? error.message : '删除收尾失败');
    } else {
      settleFailure(operation.id, error instanceof Error ? error.message : '删除失败');
    }
    throw error;
  }
}

/* ------------------------------------------------------------- maintenance */

/** 恢复后置：把 DB 中所有媒体的文件组做一次完整性巡检。 */
export function verifyAllBundles(): { id: string; reason: string }[] {
  const failures: { id: string; reason: string }[] = [];
  for (const row of listMedia()) {
    const verdict = verifyBundle(row.id);
    if (!verdict.ok) failures.push({ id: row.id, reason: verdict.reason ?? '未知原因' });
  }
  return failures;
}

export function objectDirectories(): string[] {
  try {
    return readdirSync(objectsDir(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch { return []; }
}

export function stagingDirectories(): string[] {
  try {
    return readdirSync(stagingRoot(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch { return []; }
}

export function objectPathFor(id: string): string {
  const path = resolve(join(objectsDir(), id));
  if (!path.startsWith(resolve(objectsDir()) + sep) || !/^[a-f0-9]{64}$/.test(id)) fail(400, '无效的媒体标识');
  return path;
}
