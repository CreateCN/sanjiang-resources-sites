import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ResourceSchema, type Resource } from './resource-schema.ts';
import { projectScope } from './resource-scope.ts';
import { GuideSchema, type Guide } from './guide-schema.ts';
import { createCategoryFromImport, findManagedGuide, findManagedResource, importGuide, importResource, listCategories, type EntityIdentity } from '../server/store.ts';
import { exportSettings, getSettings, saveSettings, settingsFingerprint } from '../server/settings.ts';
import {
  BrandingInputSchema, BrandingSchema, brandingFingerprint, type BrandingInput, type BrandingSettings,
} from './site-config.ts';
import { brandingMediaStatus, getBranding, getBrandingStorageSnapshot, saveBranding, type BrandingMediaStatus } from '../server/site-config.ts';
import { database } from '../server/db.ts';
import { mediaIdsInPayload, unavailableMediaIds } from '../server/media-references.ts';
import { fail } from '../server/security.ts';
import { isReservedCategory, isReservedIdentifier, RESERVED_CATEGORY_MESSAGE, RESERVED_IDENTIFIER_MESSAGE } from './identifiers.ts';
import type { User } from '../server/store.ts';

export const ImportPayloadSchema = z.object({
  schemaVersion: z.number().optional(),
  exportedAt: z.string().optional(),
  categories: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/).max(80), name: z.string().trim().min(1).max(80) })).max(200).optional(),
  resources: z.array(z.unknown()).max(500).optional(),
  guides: z.array(z.unknown()).max(200).optional(),
  // 导出包含首页编排；导入范围必须显式声明，否则设置会被 Zod 静默丢弃。
  settings: z.record(z.unknown()).optional(),
  // 导出携带媒体元数据（不含二进制）。导入只做参考，实际可用性以目标库为准。
  media: z.array(z.unknown()).max(5000).optional(),
  // v3 可选品牌投影；只有管理员显式勾选才恢复。
  branding: z.unknown().optional(),
});
export type ImportPayload = z.infer<typeof ImportPayloadSchema>;

/** 当前导出格式。未来版本必须在写入前拒绝，不能降级猜测。 */
export const EXPORT_SCHEMA_VERSION = 3;

export type ImportVersion = 0 | 1 | 2 | 3;
/** 0 表示没有 schemaVersion 的旧文件。 */
export function readImportVersion(input: unknown): ImportVersion {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 0;
  const raw = (input as Record<string, unknown>).schemaVersion;
  // 只有"字段缺失"才是旧格式；显式 null/字符串/小数都是非法类型，不能猜。
  if (raw === undefined) return 0;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) fail(400, '导入文件的 schemaVersion 必须是整数');
  if (raw > EXPORT_SCHEMA_VERSION) fail(400, `导入文件版本 ${raw} 高于当前程序支持的 ${EXPORT_SCHEMA_VERSION}；请升级程序后再导入`);
  if (raw !== 1 && raw !== 2 && raw !== 3) fail(400, `不支持的导入版本：${raw}`);
  return raw;
}

export interface NormalizedImport {
  version: ImportVersion;
  legacy: boolean;
  payload: ImportPayload;
  branding: BrandingSettings | null;
  brandingError: string | null;
}

function brandingInputOf(value: BrandingSettings): BrandingInput {
  const { schemaVersion, version, ...input } = value;
  return input;
}

function normalizeBranding(raw: unknown, version: ImportVersion): { value: BrandingSettings | null; error: string | null } {
  if (raw === undefined || raw === null) return { value: null, error: null };
  // 品牌是 v3 才有的字段；旧文件里即使手写了也不应用。
  if (version !== 3) return { value: null, error: null };
  const full = BrandingSchema.safeParse(raw);
  if (full.success) return { value: full.data, error: null };
  const inputOnly = BrandingInputSchema.safeParse(raw);
  if (inputOnly.success) return { value: { schemaVersion: 1, version: 1, ...inputOnly.data }, error: null };
  return { value: null, error: `品牌配置校验失败：${issues(full.error)}` };
}

/** 版本分发 + 顶层结构校验的唯一入口；预检与应用都必须经过它。 */
export function normalizeImportPayload(input: unknown): NormalizedImport {
  const version = readImportVersion(input);
  const parsed = ImportPayloadSchema.safeParse(input);
  if (!parsed.success) fail(400, `导入文件格式不正确：${parsed.error.issues.map((issue) => issue.path.join('.')).join('、')}`);
  const branding = normalizeBranding(parsed.data.branding, version);
  return { version, legacy: version === 0, payload: parsed.data, branding: branding.value, brandingError: branding.error };
}

/**
 * 预检计划：把"用户确认时看到的状态"冻结下来。
 * - version 防"预检后别人保存了新内容"；
 * - uid 防"删除后同名重建"（重建的条目版本同样从 v1 开始，只看版本会误判为同一个对象）；
 * - settings 冻结当前首页设置摘要，避免恢复设置时覆盖预检后别人的编排。
 */
export interface ImportPlan {
  /** 预检内容摘要；提交内容与预检不一致时整批拒绝。 */
  digest: string;
  /** 资源 ID → 预检时的身份与缺失媒体；null 表示预检时该 ID 不存在。 */
  resources: Record<string, (EntityIdentity & { missing: string[] }) | null>;
  /** 指南 slug → 预检时的身份与缺失媒体；null 表示预检时不存在。 */
  guides: Record<string, (EntityIdentity & { missing: string[] }) | null>;
  /** 预检时首页设置的摘要；文件不含设置时为 null。 */
  settings: string | null;
  /** 预检时品牌存储快照与图片可用性；文件不含品牌或品牌无效时为 null。 */
  branding: {
    expectedVersion: number | null;
    rawFingerprint: string;
    fingerprint: string;
    media: { id: string; field: 'logo' | 'favicon' | 'share'; available: boolean }[];
  } | null;
}
const PlanEntity = z.object({
  version: z.number().int().min(1),
  uid: z.string().min(1).max(64),
  // 预检时缺失/下架的媒体 ID：提交时必须一致，否则说明媒体状态在预检后变了。
  missing: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
});
const PlanBrandingMedia = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  field: z.enum(['logo', 'favicon', 'share']),
  available: z.boolean(),
});
const PlanBranding = z.object({
  // 新计划必须带存储快照；旧页面生成的计划缺少字段会直接要求重新预检。
  expectedVersion: z.number().int().min(0).nullable(),
  rawFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  media: z.array(PlanBrandingMedia),
});
const ImportPlanSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  resources: z.record(PlanEntity.nullable()).default({}),
  guides: z.record(PlanEntity.nullable()).default({}),
  settings: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  branding: PlanBranding.nullable().default(null),
});

export interface ImportCounts { create: string[]; update: string[]; same: string[]; invalid: { id: string; error: string }[] }
export interface ImportPreview {
  version: { value: ImportVersion; legacy: boolean };
  branding: {
    present: boolean;
    valid: boolean;
    error: string | null;
    name: string | null;
    version: number | null;
    changed: boolean;
    media: BrandingMediaStatus[];
  } | null;
  categories: { create: string[]; invalid: { id: string; error: string }[] };
  resources: ImportCounts;
  guides: ImportCounts;
  /** 文件中的首页设置摘要；null 表示文件不含设置。 */
  settings: { featuredResourceId: string; scenarios: number; changed: boolean; missingCategories: string[] } | null;
  /** 引用到但目标库缺失/已下架的媒体；默认整条拒绝，勾选 dropMissingMedia 才移除。 */
  media: { missing: string[]; entries: { kind: 'resource' | 'guide'; id: string; missing: string[] }[] };
  plan: ImportPlan;
}

/**
 * 同时接受两种条目格式：
 * - 导出格式：{ id, draft, published, version, updatedAt, deletedAt }
 * - 直接字段格式：{ id, title, ... }（手写或第三方整理）
 * 导出格式取 draft（草稿最新），没有 draft 时退回 published。
 */
function unwrapEntry(raw: unknown): { value: unknown; deleted: boolean } {
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const deleted = typeof record.deletedAt === 'string' && record.deletedAt !== '';
    if (record.draft && typeof record.draft === 'object') return { value: record.draft, deleted };
    if (record.published && typeof record.published === 'object') return { value: record.published, deleted };
  }
  return { value: raw, deleted: false };
}

function labelOf(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string') return record.id;
    if (typeof record.slug === 'string') return record.slug;
  }
  return fallback;
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；');
}

/**
 * 预检摘要只覆盖"真正会被写入"的归一化内容：
 * 忽略 exportedAt、媒体元数据与发布快照；旧文件缺 scope 时按 unknown 归一，
 * 因此等价文件不会因为字段缺省而产生不同 digest。
 */
function canonicalEntry(kind: 'resource' | 'guide', raw: unknown): unknown {
  const { value, deleted } = unwrapEntry(raw);
  if (kind === 'resource') {
    const parsed = ResourceSchema.safeParse(value);
    return parsed.success ? { draft: parsed.data, deleted } : { invalid: value, deleted };
  }
  const parsed = GuideSchema.safeParse(value);
  return parsed.success ? { draft: parsed.data, deleted } : { invalid: value, deleted };
}

export function importDigest(normalized: NormalizedImport): string {
  const payload = normalized.payload;
  const canonical = {
    version: normalized.version,
    categories: payload.categories ?? [],
    resources: (payload.resources ?? []).map((raw) => canonicalEntry('resource', raw)),
    guides: (payload.guides ?? []).map((raw) => canonicalEntry('guide', raw)),
    settings: payload.settings ?? null,
    branding: normalized.branding ? brandingInputOf(normalized.branding) : null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function identityOf(entity: { version: number; uid: string } | undefined): EntityIdentity | null {
  return entity ? { version: entity.version, uid: entity.uid } : null;
}

function settingsScenarioKeys(value: Record<string, unknown> | undefined): string[] {
  if (!value || !value.scenarios || typeof value.scenarios !== 'object' || Array.isArray(value.scenarios)) return [];
  return Object.keys(value.scenarios as Record<string, unknown>);
}

function settingsSummary(value: Record<string, unknown> | undefined, knownCategories: Set<string>): ImportPreview['settings'] {
  if (!value) return null;
  const current = getSettings();
  const featured = typeof value.featuredResourceId === 'string' ? value.featuredResourceId : current.featuredResourceId;
  const keys = settingsScenarioKeys(value);
  const scenarios = value.scenarios as Record<string, unknown> | undefined;
  const merged = { featuredResourceId: featured, scenarios: { ...current.scenarios, ...(scenarios ?? {}) } };
  return {
    featuredResourceId: featured,
    scenarios: keys.length,
    changed: JSON.stringify(merged) !== JSON.stringify(current),
    // 引用已删除分类的场景文案导不回来，预检就要说清楚。
    missingCategories: keys.filter((key) => !knownCategories.has(key)),
  };
}

export function previewImport(input: unknown): ImportPreview {
  const normalized = normalizeImportPayload(input);
  const payload = normalized.payload;
  const brandingPresent = normalized.version === 3 && payload.branding !== undefined && payload.branding !== null;
  const brandingValue = normalized.branding;
  const brandingMedia = brandingValue ? brandingMediaStatus(brandingInputOf(brandingValue)) : [];
  const contentKey = (value: BrandingSettings) => brandingFingerprint({ ...value, version: 1 });
  const branding = brandingPresent ? {
    present: true,
    valid: !normalized.brandingError && brandingValue !== null,
    error: normalized.brandingError,
    name: brandingValue?.name ?? null,
    version: brandingValue?.version ?? null,
    changed: brandingValue ? contentKey(brandingValue) !== contentKey(getBranding()) : false,
    media: brandingMedia,
  } : null;
  const existingCategories = new Set(listCategories().map((category) => category.id));
  const declaredCategories = new Set((payload.categories ?? []).map((category) => category.id));
  const knownCategories = new Set([...existingCategories, ...declaredCategories]);

  const resourceEntries = (payload.resources ?? []).map((raw, index) => {
    const parsedResource = ResourceSchema.safeParse(unwrapEntry(raw).value);
    return { raw, index, parsedResource };
  });
  const declaredResourceIds = new Set(resourceEntries.filter((entry) => entry.parsedResource.success).map((entry) => (entry.parsedResource as { data: Resource }).data.id));

  const preview: ImportPreview = {
    version: { value: normalized.version, legacy: normalized.legacy },
    branding,
    categories: {
      create: (payload.categories ?? []).filter((category) => !existingCategories.has(category.id) && !isReservedCategory(category.id)).map((category) => category.id),
      invalid: (payload.categories ?? []).filter((category) => isReservedCategory(category.id)).map((category) => ({ id: category.id, error: RESERVED_CATEGORY_MESSAGE })),
    },
    resources: { create: [], update: [], same: [], invalid: [] },
    guides: { create: [], update: [], same: [], invalid: [] },
    settings: settingsSummary(payload.settings, knownCategories),
    media: { missing: [], entries: [] },
    plan: {
      digest: importDigest(normalized),
      resources: {},
      guides: {},
      settings: payload.settings ? settingsFingerprint() : null,
      branding: brandingValue && !normalized.brandingError
        ? {
          ...getBrandingStorageSnapshot(),
          fingerprint: brandingFingerprint(getBranding()),
          media: brandingMedia.map(({ id, field, available }) => ({ id, field, available })),
        }
        : null,
    },
  };

  for (const { raw, index, parsedResource } of resourceEntries) {
    if (normalized.version === 3) {
      const value = unwrapEntry(raw).value;
      if (!value || typeof value !== 'object' || !('scope' in (value as Record<string, unknown>))) {
        preview.resources.invalid.push({ id: labelOf(raw, `#${index + 1}`), error: 'v3 文件必须为每条资源填写 scope（unknown/global/institutions）' });
        continue;
      }
    }
    if (!parsedResource.success) { preview.resources.invalid.push({ id: labelOf(raw, `#${index + 1}`), error: issues(parsedResource.error) }); continue; }
    const resource = parsedResource.data;
    if (isReservedIdentifier(resource.id)) { preview.resources.invalid.push({ id: resource.id, error: RESERVED_IDENTIFIER_MESSAGE }); continue; }
    // 分类/关联错误前移到预检：提交后只剩真正无法预判的失败（例如保存瞬间的并发改动）。
    if (!knownCategories.has(resource.category)) {
      preview.resources.invalid.push({ id: resource.id, error: `分类 ${resource.category} 不存在，且未在文件的 categories 中声明` });
      continue;
    }
    const current = findManagedResource(resource.id);
    const missing = unavailableMediaIds(mediaIdsInPayload('resource', resource));
    const identity = identityOf(current);
    preview.plan.resources[resource.id] = identity ? { ...identity, missing } : null;
    if (missing.length > 0) {
      preview.media.missing.push(...missing);
      preview.media.entries.push({ kind: 'resource', id: resource.id, missing });
    }
    if (current?.deletedAt) preview.resources.update.push(resource.id);
    else if (!current) preview.resources.create.push(resource.id);
    else {
      // 用 Schema 归一化后比较：旧草稿缺少 scope 时投影为 unknown，字段顺序也不同。
      const stored = ResourceSchema.safeParse(current.draft);
      const same = stored.success && JSON.stringify(stored.data) === JSON.stringify(resource);
      if (same) preview.resources.same.push(resource.id);
      else preview.resources.update.push(resource.id);
    }
  }

  for (const [index, raw] of (payload.guides ?? []).entries()) {
    const parsedGuide = GuideSchema.safeParse(unwrapEntry(raw).value);
    if (!parsedGuide.success) { preview.guides.invalid.push({ id: labelOf(raw, `#${index + 1}`), error: issues(parsedGuide.error) }); continue; }
    const guide = parsedGuide.data;
    if (isReservedIdentifier(guide.slug)) { preview.guides.invalid.push({ id: guide.slug, error: RESERVED_IDENTIFIER_MESSAGE }); continue; }
    const missing = guide.resources.filter((id) => !declaredResourceIds.has(id) && !findManagedResource(id));
    if (missing.length > 0) { preview.guides.invalid.push({ id: guide.slug, error: `关联资源不存在：${missing.join('、')}` }); continue; }
    const current = findManagedGuide(guide.slug);
    const missingMedia = unavailableMediaIds(mediaIdsInPayload('guide', guide));
    const guideIdentity = identityOf(current);
    preview.plan.guides[guide.slug] = guideIdentity ? { ...guideIdentity, missing: missingMedia } : null;
    if (missingMedia.length > 0) {
      preview.media.missing.push(...missingMedia);
      preview.media.entries.push({ kind: 'guide', id: guide.slug, missing: missingMedia });
    }
    if (current?.deletedAt) preview.guides.update.push(guide.slug);
    else if (!current) preview.guides.create.push(guide.slug);
    else if (JSON.stringify(current.draft) === JSON.stringify(guide)) preview.guides.same.push(guide.slug);
    else preview.guides.update.push(guide.slug);
  }
  return preview;
}

export interface ImportOptions {
  /** 是否按文件中的 settings 恢复首页精选与场景文案（默认不恢复，避免悄悄改前台首页）。 */
  restoreSettings?: boolean;
  /** 是否按文件中的 branding 恢复实例品牌（默认不恢复，且必须先通过预检冻结）。 */
  restoreBranding?: boolean;
}
export interface ImportResult {
  categoriesCreated: number; resources: number; guides: number; restored: number;
  settings: boolean; branding: boolean; errors: { id: string; error: string }[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '导入失败';
}

interface ResourceItem { id: string; value: Resource; expected: EntityIdentity | null; missing: string[] }
interface GuideItem { id: string; value: Guide; expected: EntityIdentity | null; missing: string[] }

function sameIdentity(current: EntityIdentity | null, expected: EntityIdentity | null): boolean {
  if (current === null || expected === null) return current === expected;
  return current.version === expected.version && current.uid === expected.uid;
}

/** Import drafts only. Publishing stays a separate, human action. */
export function applyImport(actor: User, input: unknown, plan?: unknown, options: ImportOptions = {}): ImportResult {
  if (actor.role !== 'admin') fail(403, '导入仅限管理员');
  const normalized = normalizeImportPayload(input);
  const payload = normalized.payload;
  const frozen = ImportPlanSchema.safeParse(plan);
  if (!frozen.success) fail(400, '缺少或已过期的预检计划（可能由旧页面生成）：请重新预检后再导入');
  if (frozen.data.digest !== importDigest(normalized)) fail(409, '提交内容与预检时不一致（预检后又修改了内容）；请重新预检');
  const result: ImportResult = { categoriesCreated: 0, resources: 0, guides: 0, restored: 0, settings: false, branding: false, errors: [] };
  const brandingRequested = Boolean(options.restoreBranding);
  const restoreBranding = brandingRequested && normalized.branding !== null;

  // 1. 先把条目解析完并核对预检计划，任何一条不在计划里都说明计划与内容不匹配。
  const resourceItems: ResourceItem[] = [];
  const guideItems: GuideItem[] = [];
  for (const raw of payload.resources ?? []) {
    if (normalized.version === 3) {
      const value = unwrapEntry(raw).value;
      if (!value || typeof value !== 'object' || !('scope' in (value as Record<string, unknown>))) {
        result.errors.push({ id: labelOf(raw, 'resource'), error: 'v3 文件必须为每条资源填写 scope（unknown/global/institutions）' });
        continue;
      }
    }
    const parsedResource = ResourceSchema.safeParse(unwrapEntry(raw).value);
    if (!parsedResource.success) { result.errors.push({ id: labelOf(raw, 'resource'), error: '资源校验失败' }); continue; }
    const resource = parsedResource.data;
    if (isReservedIdentifier(resource.id)) { result.errors.push({ id: resource.id, error: RESERVED_IDENTIFIER_MESSAGE }); continue; }
    const expected = frozen.data.resources[resource.id];
    // 预检已判定为语义无效的条目不在计划里：按条目报错，不能让整批卡在"重新预检"循环里。
    if (expected === undefined) {
      result.errors.push({ id: resource.id, error: '预检已判定该条目无效（分类不存在或身份冲突），未导入；修正后重新预检' });
      continue;
    }
    const missing = unavailableMediaIds(mediaIdsInPayload('resource', resource));
    const frozenMissing = (expected?.missing ?? []).slice().sort();
    if (JSON.stringify(missing.slice().sort()) !== JSON.stringify(frozenMissing)) {
      result.errors.push({ id: resource.id, error: '媒体可用性在预检后发生变化（图片被下架或恢复）；请重新预检后再导入' });
      continue;
    }
    resourceItems.push({ id: resource.id, value: resource, expected, missing });
  }
  for (const raw of payload.guides ?? []) {
    const parsedGuide = GuideSchema.safeParse(unwrapEntry(raw).value);
    if (!parsedGuide.success) { result.errors.push({ id: labelOf(raw, 'guide'), error: '指南校验失败' }); continue; }
    const guide = parsedGuide.data;
    if (isReservedIdentifier(guide.slug)) { result.errors.push({ id: guide.slug, error: RESERVED_IDENTIFIER_MESSAGE }); continue; }
    const expected = frozen.data.guides[guide.slug];
    if (expected === undefined) {
      result.errors.push({ id: guide.slug, error: '预检已判定该条目无效（关联资源不存在或身份冲突），未导入；修正后重新预检' });
      continue;
    }
    const missing = unavailableMediaIds(mediaIdsInPayload('guide', guide));
    const frozenMissing = (expected?.missing ?? []).slice().sort();
    if (JSON.stringify(missing.slice().sort()) !== JSON.stringify(frozenMissing)) {
      result.errors.push({ id: guide.slug, error: '媒体可用性在预检后发生变化（图片被下架或恢复）；请重新预检后再导入' });
      continue;
    }
    guideItems.push({ id: guide.slug, value: guide, expected, missing });
  }

  // 2. 只读核对：预检后只要有一条被改过（含删除后同名重建）或设置被改过，整批取消。
  const conflicts: string[] = [];
  const describe = (current: EntityIdentity | null, expected: EntityIdentity | null): string => {
    if (current && expected && current.uid !== expected.uid) return '已被删除并重建';
    return `预检 v${expected?.version ?? '不存在'}，当前 ${current ? `v${current.version}` : '不存在'}`;
  };
  for (const item of resourceItems) {
    const current = identityOf(findManagedResource(item.id));
    if (!sameIdentity(current, item.expected)) conflicts.push(`资源 ${item.id}（${describe(current, item.expected)}）`);
  }
  for (const item of guideItems) {
    const current = identityOf(findManagedGuide(item.id));
    if (!sameIdentity(current, item.expected)) conflicts.push(`指南 ${item.id}（${describe(current, item.expected)}）`);
  }
  if (payload.settings && options.restoreSettings) {
    if (frozen.data.settings === null) fail(409, '预检计划没有冻结首页设置；请重新预检后再恢复设置');
    if (frozen.data.settings !== settingsFingerprint()) fail(409, '首页设置在预检后被修改，导入已取消；请重新预检后再恢复设置');
  }
  if (restoreBranding && normalized.branding) {
    if (!frozen.data.branding) fail(409, '预检计划没有冻结品牌设置；请重新预检后再恢复品牌');
    const storage = getBrandingStorageSnapshot();
    if (
      frozen.data.branding.expectedVersion !== storage.expectedVersion
      || frozen.data.branding.rawFingerprint !== storage.rawFingerprint
    ) {
      fail(409, '品牌设置在预检后被修改，导入已取消；请重新预检后再恢复品牌');
    }
    const currentMedia = brandingMediaStatus(brandingInputOf(normalized.branding))
      .map(({ id, field, available }) => ({ id, field, available }));
    if (JSON.stringify(currentMedia) !== JSON.stringify(frozen.data.branding.media)) {
      fail(409, '品牌图片在预检后发生变化（上传、下架或授权状态改变）；请重新预检');
    }
  }
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 6).join('；');
    fail(409, `以下条目在预检后已被修改，导入已取消：${shown}${conflicts.length > 6 ? ` 等 ${conflicts.length} 条` : ''}。请重新预检后再导入。`);
  }

  // 3. 分类：与分类管理共用保留字规则；声明过的分类先建，供后面的资源引用。
  for (const category of payload.categories ?? []) {
    if (isReservedCategory(category.id)) { result.errors.push({ id: category.id, error: RESERVED_CATEGORY_MESSAGE }); continue; }
    try {
      if (createCategoryFromImport(actor, category.id, category.name)) result.categoriesCreated += 1;
    } catch (error) { result.errors.push({ id: category.id, error: messageOf(error) }); }
  }

  // 4. 逐条应用：每条都有自己的事务（含审计），"恢复 + 保存 + 版本记录 + 审计"要么全成，要么全不留痕。
  for (const item of resourceItems) {
    const wasDeleted = Boolean(findManagedResource(item.id)?.deletedAt);
    if (item.missing.length > 0) {
      // P0 只做"缺图即拒绝"：静默清空图片会悄悄改变内容；显式移除属于 P1。
      result.errors.push({ id: item.id, error: `图片缺失或已下架（${item.missing.map((id) => `/media/${id}.webp`).join('、')}），未导入；请先恢复或替换图片后重新预检` });
      continue;
    }
    try {
      importResource(actor, item.value, item.expected);
      result.resources += 1;
      if (wasDeleted) result.restored += 1;
    } catch (error) { result.errors.push({ id: item.id, error: messageOf(error) }); }
  }
  for (const item of guideItems) {
    const wasDeleted = Boolean(findManagedGuide(item.id)?.deletedAt);
    if (item.missing.length > 0) {
      result.errors.push({ id: item.id, error: `图片缺失或已下架（${item.missing.map((id) => `/media/${id}.webp`).join('、')}），未导入；请先恢复或替换图片后重新预检` });
      continue;
    }
    try {
      importGuide(actor, item.value, item.expected);
      result.guides += 1;
      if (wasDeleted) result.restored += 1;
    } catch (error) { result.errors.push({ id: item.id, error: messageOf(error) }); }
  }

  // 5. 设置：文件带设置且管理员明确勾选才写；引用已删除分类的文案必须显式报出来。
  if (payload.settings && options.restoreSettings) {
    try {
      const existing = new Set(listCategories().map((category) => category.id));
      const value = { ...payload.settings };
      const scenarios = value.scenarios;
      const dropped: string[] = [];
      if (scenarios && typeof scenarios === 'object' && !Array.isArray(scenarios)) {
        const kept: Record<string, unknown> = {};
        for (const [id, copy] of Object.entries(scenarios as Record<string, unknown>)) {
          if (existing.has(id)) kept[id] = copy;
          else dropped.push(id);
        }
        value.scenarios = kept;
      }
      saveSettings(actor, value);
      result.settings = true;
      for (const id of dropped) result.errors.push({ id: '首页设置', error: `分类 ${id} 不存在，该场景文案未恢复` });
    } catch (error) { result.errors.push({ id: '首页设置', error: messageOf(error) }); }
  }

  // 6. 品牌：文件带 branding 且管理员明确勾选才写；预检已核对指纹与媒体状态。
  if (brandingRequested && normalized.brandingError) {
    result.errors.push({ id: '品牌设置', error: normalized.brandingError });
  }
  if (restoreBranding && normalized.branding) {
    try {
      // 使用预检冻结的版本与原值摘要；不能在这里重新读取“最新版本”再接受。
      saveBranding(
        actor,
        brandingInputOf(normalized.branding),
        frozen.data.branding!.expectedVersion,
        { rawFingerprint: frozen.data.branding!.rawFingerprint },
      );
      result.branding = true;
    } catch (error) { result.errors.push({ id: '品牌设置', error: messageOf(error) }); }
  }

  return result;
}

/** 导出也做同样的兼容投影：旧快照缺 scope 时明确写成 unknown，而不是省略。 */
function exportedResource(json: string): unknown {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return { ...raw, scope: projectScope(raw.scope) };
}

export function exportPayload(): unknown {
  const resources = database().prepare('SELECT * FROM resources ORDER BY id').all().map((row) => ({
    id: String(row.id), draft: exportedResource(String(row.draft)), published: row.published ? exportedResource(String(row.published)) : null,
    version: Number(row.version), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  }));
  const guides = database().prepare('SELECT * FROM guides ORDER BY slug').all().map((row) => ({
    slug: String(row.slug), draft: JSON.parse(String(row.draft)), published: row.published ? JSON.parse(String(row.published)) : null,
    version: Number(row.version), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  }));
  // 媒体只导出元数据与完整性清单：二进制不在这里，导出不是完整备份（见 scripts/backup-site.mjs）。
  const media = database().prepare('SELECT * FROM media ORDER BY created_at').all().map((row) => ({
    id: String(row.id),
    width: Number(row.width),
    height: Number(row.height),
    bytes: Number(row.bytes),
    totalBytes: Number(row.total_bytes),
    encodingVersion: String(row.encoding_version),
    variants: JSON.parse(String(row.variants)),
    rights: String(row.rights),
    credit: String(row.credit),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  }));
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    categories: listCategories(),
    resources,
    guides,
    media,
    settings: exportSettings(),
    // 只导出实例品牌字段；环境变量、账户、会话、密钥与备份路径不会进入内容 JSON。
    branding: getBranding(),
  };
}
