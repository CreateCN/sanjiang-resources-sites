import { randomBytes } from 'node:crypto';
import { database, transaction } from './db.ts';
import { audit, fail } from './security.ts';
import type { User } from './store.ts';
import { requestMemo } from './request-cache.ts';
import {
  DEFAULT_SPONSOR_SETTINGS, SPONSOR_LABEL, SPONSOR_PLACEMENTS, SPONSOR_SETTINGS_KEY,
  SponsorInputSchema, SponsorSettingsInputSchema, SponsorSettingsSchema, sponsorHostname,
} from '../lib/sponsor-schema.ts';
import type { SponsorPlacement, SponsorSettings } from '../lib/sponsor-schema.ts';

/**
 * 静态赞助：管理员 CRUD、总开关与公开查询。
 *
 * 约束：
 * - 每次变更都在事务内重新读取角色，降级后的旧页面不能靠伪造 actor 写入；
 * - 更新使用 version CAS；创建默认停用；
 * - 同一位置同一时间最多一个启用项，区间按 [start, end) 计算，null 表示无界；
 * - target_url 只做静态跳转，不抓取、不加载第三方脚本；
 * - 审计与业务写入同一事务，审计失败必须回滚。
 */

export interface Sponsor {
  id: string;
  version: number;
  title: string;
  body: string;
  sponsorName: string;
  mediaId: string | null;
  imageAlt: string;
  targetUrl: string;
  targetHostname: string;
  placement: SponsorPlacement;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface PublicSponsor {
  id: string;
  title: string;
  body: string;
  sponsorName: string;
  mediaId: string | null;
  imageSrc: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  /** public 只可能是 none/available；后台预览会明确标记 unavailable。 */
  imageState: 'none' | 'available' | 'unavailable';
  imageProblem: string | null;
  imageAlt: string;
  targetUrl: string;
  targetHostname: string;
  placement: SponsorPlacement;
  startsAt: string | null;
  endsAt: string | null;
  label: string;
}

interface SponsorRow {
  id: string; version: number; title: string; body: string; sponsor_name: string;
  media_id: string | null; image_alt: string; target_url: string; placement: SponsorPlacement;
  enabled: number; starts_at: string | null; ends_at: string | null;
  created_at: string; updated_at: string; created_by: string; updated_by: string;
}

function mapSponsor(row: SponsorRow): Sponsor {
  return {
    id: row.id,
    version: Number(row.version),
    title: row.title,
    body: row.body,
    sponsorName: row.sponsor_name,
    mediaId: row.media_id,
    imageAlt: row.image_alt,
    targetUrl: row.target_url,
    targetHostname: sponsorHostname(row.target_url),
    placement: row.placement,
    enabled: Boolean(row.enabled),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

/* -------------------------------------------------------------- settings */

export interface SponsorSettingsView {
  enabled: boolean;
  version: number | null;
  stored: boolean;
  corrupt: boolean;
}

interface SponsorSettingsRead {
  value: SponsorSettings;
  version: number | null;
  stored: boolean;
  corrupt: boolean;
}

function readSponsorSettings(): SponsorSettingsRead {
  const row = database().prepare('SELECT value FROM settings WHERE key=?').get(SPONSOR_SETTINGS_KEY);
  if (!row) return { value: { ...DEFAULT_SPONSOR_SETTINGS }, version: null, stored: false, corrupt: false };
  try {
    const parsed = SponsorSettingsSchema.safeParse(JSON.parse(String(row.value)));
    if (parsed.success) return { value: parsed.data, version: parsed.data.version, stored: true, corrupt: false };
  } catch { /* corrupt: fall through */ }
  return { value: { ...DEFAULT_SPONSOR_SETTINGS, enabled: false }, version: null, stored: true, corrupt: true };
}

function memoSponsorSettings(): SponsorSettingsRead {
  return requestMemo('sponsor-settings', readSponsorSettings);
}

export function getSponsorSettingsView(): SponsorSettingsView {
  const read = memoSponsorSettings();
  return { enabled: read.corrupt ? false : read.value.enabled, version: read.version, stored: read.stored, corrupt: read.corrupt };
}

/** 公开读取：缺行、损坏或关闭都视为关闭。 */
export function isSponsorEnabled(): boolean {
  return getSponsorSettingsView().enabled;
}

export function saveSponsorSettings(actor: User, input: unknown, expectedVersion: number | null): SponsorSettings {
  const parsed = SponsorSettingsInputSchema.safeParse(input);
  if (!parsed.success) fail(400, `赞助开关校验失败：${parsed.error.issues.map((issue) => issue.path.join('.')).join('、')}`);
  return transaction((db) => {
    const row = db.prepare('SELECT role,active FROM users WHERE id=?').get(actor.id);
    if (!row || !row.active) fail(401, '登录已失效，请重新登录');
    if (row.role !== 'admin') fail(403, '此操作仅限管理员');

    const current = db.prepare('SELECT value FROM settings WHERE key=?').get(SPONSOR_SETTINGS_KEY);
    const currentRaw = current ? String(current.value) : null;
    let currentVersion: number | null = 0;
    if (currentRaw !== null) {
      try {
        const parsedCurrent = SponsorSettingsSchema.safeParse(JSON.parse(currentRaw));
        currentVersion = parsedCurrent.success ? parsedCurrent.data.version : null;
      } catch { currentVersion = null; }
    }
    if ((expectedVersion ?? null) !== currentVersion) fail(409, '赞助开关已被其他维护者修改，请刷新页面后重试');
    const next: SponsorSettings = { schemaVersion: 1, version: (currentVersion ?? 0) + 1, enabled: parsed.data.enabled };
    const value = JSON.stringify(next);
    if (currentRaw === null) {
      const result = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').run(SPONSOR_SETTINGS_KEY, value);
      if (Number(result.changes) === 0) fail(409, '赞助开关已被其他维护者修改，请刷新页面后重试');
    } else {
      const result = db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').run(value, SPONSOR_SETTINGS_KEY, currentRaw);
      if (Number(result.changes) === 0) fail(409, '赞助开关已被其他维护者修改，请刷新页面后重试');
    }
    audit(actor.username, 'save-sponsor-settings', SPONSOR_SETTINGS_KEY);
    return next;
  });
}

/* --------------------------------------------------------------- sponsors */

export function listSponsors(): Sponsor[] {
  return database().prepare('SELECT * FROM sponsors ORDER BY updated_at DESC,id').all().map((row) => mapSponsor(row as unknown as SponsorRow));
}

export function findSponsor(id: string): Sponsor | undefined {
  const row = database().prepare('SELECT * FROM sponsors WHERE id=?').get(id);
  return row ? mapSponsor(row as unknown as SponsorRow) : undefined;
}

function requireSponsorMedia(db: ReturnType<typeof database>, mediaId: string | null, imageAlt: string): void {
  if (!mediaId) return;
  if (!imageAlt) fail(400, '使用赞助图片时必须填写替代文本');
  const row = db.prepare('SELECT state,deleted_at,rights,credit FROM media WHERE id=?').get(mediaId) as
    | { state: string; deleted_at: string | null; rights: string; credit: string } | undefined;
  if (!row) fail(400, '赞助图片不存在，请先在媒体库上传');
  if (row.state !== 'ready' || row.deleted_at) fail(400, '赞助图片已下架或正在删除，请选择其他图片');
  if (row.rights !== 'confirmed') fail(400, '赞助图片尚未确认授权，请先在媒体库补充授权信息');
  if (!row.credit.trim()) fail(400, '赞助图片缺少署名与许可说明');
}

interface SponsorMediaState {
  available: boolean;
  width: number | null;
  height: number | null;
  problem: string | null;
}

/** 与公开查询共用同一媒体可用性规则；预览不得绕过下架/授权/署名状态。 */
function sponsorMediaState(db: ReturnType<typeof database>, mediaId: string | null): SponsorMediaState {
  if (!mediaId) return { available: false, width: null, height: null, problem: null };
  const row = db.prepare('SELECT state,deleted_at,rights,credit,width,height FROM media WHERE id=?').get(mediaId) as
    | { state: string; deleted_at: string | null; rights: string; credit: string; width: number; height: number }
    | undefined;
  if (!row) return { available: false, width: null, height: null, problem: '图片不存在或已被删除' };
  if (row.state !== 'ready' || row.deleted_at) return { available: false, width: Number(row.width), height: Number(row.height), problem: '图片已下架或正在删除' };
  if (row.rights !== 'confirmed') return { available: false, width: Number(row.width), height: Number(row.height), problem: '图片尚未确认授权' };
  if (!row.credit.trim()) return { available: false, width: Number(row.width), height: Number(row.height), problem: '图片缺少署名与许可说明' };
  return { available: true, width: Number(row.width), height: Number(row.height), problem: null };
}

function windowOverlaps(left: { startsAt: string | null; endsAt: string | null }, right: { starts_at: string | null; ends_at: string | null }): boolean {
  const aStart = left.startsAt === null ? Number.NEGATIVE_INFINITY : Date.parse(left.startsAt);
  const aEnd = left.endsAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.endsAt);
  const bStart = right.starts_at === null ? Number.NEGATIVE_INFINITY : Date.parse(right.starts_at);
  const bEnd = right.ends_at === null ? Number.POSITIVE_INFINITY : Date.parse(right.ends_at);
  // 历史/手工数据的非法时间按冲突处理，宁可拒绝展示两个。
  if ([aStart, aEnd, bStart, bEnd].some((value) => Number.isNaN(value))) return true;
  return aStart < bEnd && bStart < aEnd;
}

function assertNoOverlap(
  db: ReturnType<typeof database>,
  placement: SponsorPlacement,
  startsAt: string | null,
  endsAt: string | null,
  excludeId: string | null,
): void {
  const rows = db.prepare('SELECT id,title,starts_at,ends_at FROM sponsors WHERE placement=? AND enabled=1').all(placement)
    .filter((row) => String(row.id) !== excludeId);
  for (const row of rows) {
    if (!windowOverlaps({ startsAt, endsAt }, { starts_at: row.starts_at === null ? null : String(row.starts_at), ends_at: row.ends_at === null ? null : String(row.ends_at) })) continue;
    const window = `${row.starts_at ? String(row.starts_at).slice(0, 16) : '不限开始'} → ${row.ends_at ? String(row.ends_at).slice(0, 16) : '不限结束'}`;
    fail(409, `该位置已有时间重叠的启用赞助「${String(row.title)}」（${window}）；同一位置同一时间最多一个生效项`);
  }
}

interface NormalizedSponsor {
  title: string; body: string; sponsorName: string; mediaId: string | null; imageAlt: string;
  targetUrl: string; placement: SponsorPlacement; enabled: boolean; startsAt: string | null; endsAt: string | null;
}

function normalizeSponsor(input: unknown): NormalizedSponsor {
  const parsed = SponsorInputSchema.safeParse(input);
  if (!parsed.success) {
    fail(400, `赞助校验失败：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  }
  return {
    ...parsed.data,
    mediaId: parsed.data.mediaId,
    imageAlt: parsed.data.mediaId ? parsed.data.imageAlt : '',
    startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt).toISOString() : null,
    endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt).toISOString() : null,
  };
}

export function createSponsor(actor: User, input: unknown): Sponsor {
  const sponsor = normalizeSponsor(input);
  return transaction((db) => {
    const current = db.prepare('SELECT role,active FROM users WHERE id=?').get(actor.id);
    if (!current || !current.active) fail(401, '登录已失效，请重新登录');
    if (current.role !== 'admin') fail(403, '此操作仅限管理员');
    requireSponsorMedia(db, sponsor.mediaId, sponsor.imageAlt);
    if (sponsor.enabled) assertNoOverlap(db, sponsor.placement, sponsor.startsAt, sponsor.endsAt, null);
    const id = randomBytes(12).toString('hex');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sponsors
      (id,version,title,body,sponsor_name,media_id,image_alt,target_url,placement,enabled,starts_at,ends_at,created_at,updated_at,created_by,updated_by)
      VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, sponsor.title, sponsor.body, sponsor.sponsorName, sponsor.mediaId, sponsor.imageAlt, sponsor.targetUrl,
        sponsor.placement, sponsor.enabled ? 1 : 0, sponsor.startsAt, sponsor.endsAt, now, now, actor.username, actor.username);
    audit(actor.username, 'create-sponsor', id);
    return findSponsor(id)!;
  });
}

export function updateSponsor(actor: User, id: string, input: unknown, expectedVersion: number | null): Sponsor {
  const sponsor = normalizeSponsor(input);
  return transaction((db) => {
    const current = db.prepare('SELECT role,active FROM users WHERE id=?').get(actor.id);
    if (!current || !current.active) fail(401, '登录已失效，请重新登录');
    if (current.role !== 'admin') fail(403, '此操作仅限管理员');
    const row = db.prepare('SELECT * FROM sponsors WHERE id=?').get(id) as unknown as SponsorRow | undefined;
    if (!row) fail(404, '赞助不存在');
    if (expectedVersion === null || Number(row.version) !== expectedVersion) fail(409, '该赞助已被其他维护者修改；请重新加载后再保存');
    requireSponsorMedia(db, sponsor.mediaId, sponsor.imageAlt);
    if (sponsor.enabled) assertNoOverlap(db, sponsor.placement, sponsor.startsAt, sponsor.endsAt, id);
    const now = new Date().toISOString();
    db.prepare(`UPDATE sponsors SET version=version+1,title=?,body=?,sponsor_name=?,media_id=?,image_alt=?,target_url=?,
      placement=?,enabled=?,starts_at=?,ends_at=?,updated_at=?,updated_by=? WHERE id=?`)
      .run(sponsor.title, sponsor.body, sponsor.sponsorName, sponsor.mediaId, sponsor.imageAlt, sponsor.targetUrl,
        sponsor.placement, sponsor.enabled ? 1 : 0, sponsor.startsAt, sponsor.endsAt, now, actor.username, id);
    audit(actor.username, 'update-sponsor', id);
    return findSponsor(id)!;
  });
}

export function deleteSponsor(actor: User, id: string, expectedVersion: number | null): void {
  transaction((db) => {
    const current = db.prepare('SELECT role,active FROM users WHERE id=?').get(actor.id);
    if (!current || !current.active) fail(401, '登录已失效，请重新登录');
    if (current.role !== 'admin') fail(403, '此操作仅限管理员');
    const row = db.prepare('SELECT version FROM sponsors WHERE id=?').get(id);
    if (!row) fail(404, '赞助不存在');
    if (expectedVersion === null || Number(row.version) !== expectedVersion) fail(409, '该赞助已被其他维护者修改；请重新加载后再删除');
    db.prepare('DELETE FROM sponsors WHERE id=?').run(id);
    audit(actor.username, 'delete-sponsor', id);
  });
}

/** 公开查询：总开关、单项启用、时间窗与媒体可用性全部满足才展示。 */
export function getActiveSponsors(now = new Date(), db: ReturnType<typeof database> = database()): PublicSponsor[] {
  if (!isSponsorEnabled()) return [];
  const nowIso = now.toISOString();
  const rows = db.prepare(`SELECT * FROM sponsors
    WHERE enabled=1
      AND (starts_at IS NULL OR starts_at <= ?)
      AND (ends_at IS NULL OR ends_at > ?)
    ORDER BY placement, created_at, id`).all(nowIso, nowIso) as unknown as SponsorRow[];
  const active: PublicSponsor[] = [];
  const nowMs = now.getTime();
  for (const row of rows) {
    // 手工/历史数据里的畸形时间不能被 SQL 的字符串比较误放行。
    const starts = row.starts_at === null ? Number.NEGATIVE_INFINITY : Date.parse(row.starts_at);
    const ends = row.ends_at === null ? Number.POSITIVE_INFINITY : Date.parse(row.ends_at);
    if (Number.isNaN(starts) || Number.isNaN(ends) || starts > nowMs || ends <= nowMs) continue;
    const media = sponsorMediaState(db, row.media_id);
    if (row.media_id && !media.available) continue;
    active.push({
      id: row.id,
      title: row.title,
      body: row.body,
      sponsorName: row.sponsor_name,
      mediaId: row.media_id,
      imageSrc: row.media_id ? `/media/${row.media_id}.webp` : null,
      imageWidth: media.width,
      imageHeight: media.height,
      imageState: row.media_id ? 'available' : 'none',
      imageProblem: null,
      imageAlt: row.image_alt,
      targetUrl: row.target_url,
      targetHostname: sponsorHostname(row.target_url),
      placement: row.placement,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      label: SPONSOR_LABEL,
    });
  }
  return active;
}

/** 后台预览：不绕过媒体下架/授权状态；不可用时只保留 mediaId、alt 与明确原因。 */
export function sponsorPreview(sponsor: Sponsor): PublicSponsor {
  const media = sponsorMediaState(database(), sponsor.mediaId);
  return {
    id: sponsor.id,
    title: sponsor.title,
    body: sponsor.body,
    sponsorName: sponsor.sponsorName,
    mediaId: sponsor.mediaId,
    imageSrc: media.available ? `/media/${sponsor.mediaId}.webp` : null,
    imageWidth: media.width,
    imageHeight: media.height,
    imageState: sponsor.mediaId ? (media.available ? 'available' : 'unavailable') : 'none',
    imageProblem: media.problem,
    imageAlt: sponsor.imageAlt,
    targetUrl: sponsor.targetUrl,
    targetHostname: sponsor.targetHostname,
    placement: sponsor.placement,
    startsAt: sponsor.startsAt,
    endsAt: sponsor.endsAt,
    label: SPONSOR_LABEL,
  };
}

export { SPONSOR_PLACEMENTS };
