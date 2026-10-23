import { createHash } from 'node:crypto';
import { database, transaction } from './db.ts';
import { audit, fail } from './security.ts';
import { isMediaServable } from './media-references.ts';
import type { User } from './store.ts';
import { requestMemo } from './request-cache.ts';
import { resolveSiteOrigin } from './deployment-config.ts';
import {
  AUTH_ISSUER_METADATA_KEY,
  BRANDING_SCHEMA_VERSION,
  BRANDING_SETTINGS_KEY,
  BrandingInputSchema,
  FAVICON_MIN_EDGE,
  LEGACY_AUTH_ISSUER,
  cloneBranding,
  parseStoredBranding,
  projectPublicSiteConfig,
} from '../lib/site-config.ts';
import type {
  BrandingInput,
  BrandingRead,
  BrandingSettings,
  PublicSiteConfig,
} from '../lib/site-config.ts';

/**
 * 实例品牌的读写服务。
 *
 * 硬约束（任务书 §3.2 / P0-01）：
 * - 读取：缺行用默认值，损坏行保留原文并在后台报告异常，公开页中性回退。
 * - 写入：事务内重新读取操作者角色与当前值，按原始 value 做条件更新（CAS），
 *   版本不符返回 409；不能只在事务外比较后无条件覆盖。
 * - 媒体引用必须 ready、未下架、rights=confirmed 且有 credit。
 * - 公开投影只含白名单字段。
 */

export interface BrandingStorageSnapshot {
  /** 缺行为 0；合法行是 version；损坏行为 null。 */
  expectedVersion: number | null;
  /** 对原始 settings.value 的摘要；缺行与损坏行不会与任何合法行相同。 */
  rawFingerprint: string;
}

/** 品牌原值摘要：用于导入冻结，不把默认投影或解析结果当成存储事实。 */
export function brandingStorageFingerprint(raw: string | null): string {
  return createHash('sha256').update(raw === null ? 'missing\0' : `present\0${raw}`).digest('hex');
}

/** 直接读存储行，不经过请求缓存；预检与应用事务前都用它核对。 */
export function getBrandingStorageSnapshot(): BrandingStorageSnapshot {
  const row = database().prepare('SELECT value FROM settings WHERE key=?').get(BRANDING_SETTINGS_KEY);
  const raw = row ? String(row.value) : null;
  const read = parseStoredBranding(raw);
  return {
    expectedVersion: !read.stored ? 0 : read.corrupt ? null : read.value.version,
    rawFingerprint: brandingStorageFingerprint(raw),
  };
}

export interface BrandingSaveGuard {
  /** 由预检冻结；给出时必须与事务内原始值摘要一致。 */
  rawFingerprint?: string;
}

export interface BrandingAdminView {
  value: BrandingSettings;
  stored: boolean;
  corrupt: boolean;
  /** 损坏或尚未保存时为 null：后台必须显式以 null 修复/新建。 */
  version: number | null;
}

function readBranding(): BrandingRead {
  const row = database().prepare('SELECT value FROM settings WHERE key=?').get(BRANDING_SETTINGS_KEY);
  return parseStoredBranding(row ? String(row.value) : null);
}

function memoBranding(): BrandingRead {
  return requestMemo('site-branding', readBranding);
}

/** 页面/SEO 的权威 origin；与 Origin 校验、Cookie Secure 共用同一实现。 */
export function getSiteOrigin(requestUrl?: URL): string {
  return resolveSiteOrigin(requestUrl);
}

export function getBranding(): BrandingSettings {
  return cloneBranding(memoBranding().value);
}

export function getPublicSiteConfig(): PublicSiteConfig {
  return projectPublicSiteConfig(memoBranding().value);
}

export interface BrandAssets {
  logoUrl: string | null;
  faviconUrl: string;
  faviconType: 'image/webp' | 'image/svg+xml';
  shareImageUrl: string;
}

/**
 * 页面实际可用的品牌素材：配置了且仍可用才使用本站媒体，否则回退中性默认素材。
 * 媒体可能在上传后被下架；这里每次都检查可用性，不能缓存成静态字符串。
 */
export function getBrandAssets(): BrandAssets {
  return requestMemo('site-brand-assets', () => {
    const branding = getBranding();
    const mediaUrl = (id: string | null) => (id && isMediaServable(id) ? `/media/${id}.webp` : null);
    const favicon = mediaUrl(branding.faviconMediaId);
    return {
      logoUrl: mediaUrl(branding.logoMediaId),
      faviconUrl: favicon ?? '/favicon.svg',
      faviconType: favicon ? 'image/webp' : 'image/svg+xml',
      shareImageUrl: mediaUrl(branding.shareImageMediaId) ?? '/og-default.png',
    };
  });
}

export function getBrandingAdminView(): BrandingAdminView {
  const read = memoBranding();
  return {
    value: cloneBranding(read.value),
    stored: read.stored,
    corrupt: read.corrupt,
    version: read.stored && !read.corrupt ? read.value.version : null,
  };
}

/** 冻结的 TOTP issuer：新实例由初始化写入，旧实例迁移补齐，品牌改名不改变它。 */
export function getFrozenAuthIssuer(): string {
  return requestMemo('auth-issuer', () => {
    const row = database().prepare('SELECT value FROM metadata WHERE key=?').get(AUTH_ISSUER_METADATA_KEY);
    const value = row ? String(row.value).trim() : '';
    return value || LEGACY_AUTH_ISSUER;
  });
}

interface MediaRow {
  id: string;
  state: string;
  deleted_at: string | null;
  rights: string;
  credit: string;
  width: number;
  height: number;
}

function brandingMediaProblem(
  db: ReturnType<typeof database>,
  id: string,
  label: string,
  minEdge = 0,
): string | null {
  const row = db.prepare('SELECT id,state,deleted_at,rights,credit,width,height FROM media WHERE id=?').get(id) as unknown as MediaRow | undefined;
  if (!row) return `${label}图片不存在，请先在媒体库上传`;
  if (row.state !== 'ready' || row.deleted_at) return `${label}图片已下架或正在删除，请选择其他图片`;
  if (row.rights !== 'confirmed') return `${label}图片尚未确认授权，请先在媒体库补充授权信息`;
  if (!row.credit.trim()) return `${label}图片缺少署名与许可说明`;
  if (minEdge > 0 && (Number(row.width) < minEdge || Number(row.height) < minEdge)) {
    return `${label}图片至少需要 ${minEdge}×${minEdge} 像素`;
  }
  return null;
}

function requireBrandingMedia(
  db: ReturnType<typeof database>,
  id: string,
  label: string,
  minEdge = 0,
): void {
  const problem = brandingMediaProblem(db, id, label, minEdge);
  if (problem) fail(400, problem);
}

export interface BrandingMediaStatus {
  id: string;
  field: 'logo' | 'favicon' | 'share';
  available: boolean;
  problem: string | null;
}

/**
 * 品牌三个图片槽位的实时可用性。
 * 导入预检冻结它、应用前再比较一次；保存品牌仍走同一套校验。
 */
export function brandingMediaStatus(input: BrandingInput): BrandingMediaStatus[] {
  const db = database();
  const entries: { field: BrandingMediaStatus['field']; id: string | null; label: string; minEdge: number }[] = [
    { field: 'logo', id: input.logoMediaId, label: 'Logo', minEdge: 0 },
    { field: 'favicon', id: input.faviconMediaId, label: 'favicon', minEdge: FAVICON_MIN_EDGE },
    { field: 'share', id: input.shareImageMediaId, label: '分享图', minEdge: 0 },
  ];
  const statuses: BrandingMediaStatus[] = [];
  for (const entry of entries) {
    if (!entry.id) continue;
    const problem = brandingMediaProblem(db, entry.id, entry.label, entry.minEdge);
    statuses.push({ id: entry.id, field: entry.field, available: problem === null, problem });
  }
  return statuses;
}

/**
 * 保存品牌配置。
 * expectedVersion：0 表示"尚无配置行"；null 表示"当前行已损坏，显式修复"。
 */
export function saveBranding(actor: User, input: unknown, expectedVersion: number | null, guard: BrandingSaveGuard = {}): BrandingSettings {
  const parsed = BrandingInputSchema.safeParse(input);
  if (!parsed.success) {
    fail(400, `品牌设置校验失败：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  }
  return transaction((db) => {
    // 实时角色：降级后的旧页面不能靠伪造 actor 写入。
    const row = db.prepare('SELECT role,active FROM users WHERE id=?').get(actor.id);
    if (!row || !row.active) fail(401, '登录已失效，请重新登录');
    if (row.role !== 'admin') fail(403, '此操作仅限管理员');

    if (parsed.data.faviconMediaId) requireBrandingMedia(db, parsed.data.faviconMediaId, 'favicon ', FAVICON_MIN_EDGE);
    if (parsed.data.logoMediaId) requireBrandingMedia(db, parsed.data.logoMediaId, 'Logo ');
    if (parsed.data.shareImageMediaId) requireBrandingMedia(db, parsed.data.shareImageMediaId, '分享图 ');

    const current = db.prepare('SELECT value FROM settings WHERE key=?').get(BRANDING_SETTINGS_KEY);
    const currentRaw = current ? String(current.value) : null;
    const read = parseStoredBranding(currentRaw);
    const currentVersion = !read.stored ? 0 : read.corrupt ? null : read.value.version;
    if (guard.rawFingerprint !== undefined && guard.rawFingerprint !== brandingStorageFingerprint(currentRaw)) {
      fail(409, '品牌设置在导入期间已被其他维护者修改，本次品牌导入未写入；请重新预检后再导入');
    }
    if ((expectedVersion ?? null) !== currentVersion) {
      fail(409, read.corrupt
        ? '品牌配置当前无法解析；请确认后按修复方式重新保存'
        : '品牌设置已被其他维护者修改，请刷新页面后重试');
    }

    const next: BrandingSettings = {
      schemaVersion: BRANDING_SCHEMA_VERSION,
      version: (currentVersion ?? 0) + 1,
      ...parsed.data,
    };
    const value = JSON.stringify(next);
    if (currentRaw === null) {
      const result = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').run(BRANDING_SETTINGS_KEY, value);
      if (Number(result.changes) === 0) fail(409, '品牌设置已被其他维护者修改，请刷新页面后重试');
    } else {
      const result = db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').run(value, BRANDING_SETTINGS_KEY, currentRaw);
      if (Number(result.changes) === 0) fail(409, '品牌设置已被其他维护者修改，请刷新页面后重试');
    }
    audit(actor.username, 'save-branding', BRANDING_SETTINGS_KEY);
    return next;
  });
}
