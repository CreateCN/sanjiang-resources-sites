import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ResourceSchema, type Resource } from './resource-schema.ts';
import { GuideSchema, type Guide } from './guide-schema.ts';
import { createCategoryFromImport, findManagedGuide, findManagedResource, importGuide, importResource, listCategories, type EntityIdentity } from '../server/store.ts';
import { exportSettings, getSettings, saveSettings, settingsFingerprint } from '../server/settings.ts';
import { database } from '../server/db.ts';
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
});
export type ImportPayload = z.infer<typeof ImportPayloadSchema>;

/**
 * 预检计划：把"用户确认时看到的状态"冻结下来。
 * - version 防"预检后别人保存了新内容"；
 * - uid 防"删除后同名重建"（重建的条目版本同样从 v1 开始，只看版本会误判为同一个对象）；
 * - settings 冻结当前首页设置摘要，避免恢复设置时覆盖预检后别人的编排。
 */
export interface ImportPlan {
  /** 预检内容摘要；提交内容与预检不一致时整批拒绝。 */
  digest: string;
  /** 资源 ID → 预检时的身份；null 表示预检时该 ID 不存在。 */
  resources: Record<string, EntityIdentity | null>;
  /** 指南 slug → 预检时的身份；null 表示预检时不存在。 */
  guides: Record<string, EntityIdentity | null>;
  /** 预检时首页设置的摘要；文件不含设置时为 null。 */
  settings: string | null;
}
const PlanEntity = z.object({ version: z.number().int().min(1), uid: z.string().min(1).max(64) });
const ImportPlanSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  resources: z.record(PlanEntity.nullable()).default({}),
  guides: z.record(PlanEntity.nullable()).default({}),
  settings: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
});

export interface ImportCounts { create: string[]; update: string[]; same: string[]; invalid: { id: string; error: string }[] }
export interface ImportPreview {
  categories: { create: string[]; invalid: { id: string; error: string }[] };
  resources: ImportCounts;
  guides: ImportCounts;
  /** 文件中的首页设置摘要；null 表示文件不含设置。 */
  settings: { featuredResourceId: string; scenarios: number; changed: boolean; missingCategories: string[] } | null;
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

/** 摘要只用于发现"预检后内容被改过"，不对原始文本格式敏感（空格/换行不影响结果）。 */
export function payloadDigest(payload: ImportPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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
  const parsed = ImportPayloadSchema.safeParse(input);
  if (!parsed.success) fail(400, `导入文件格式不正确：${parsed.error.issues.map((issue) => issue.path.join('.')).join('、')}`);
  const payload = parsed.data;
  const existingCategories = new Set(listCategories().map((category) => category.id));
  const declaredCategories = new Set((payload.categories ?? []).map((category) => category.id));
  const knownCategories = new Set([...existingCategories, ...declaredCategories]);

  const resourceEntries = (payload.resources ?? []).map((raw, index) => {
    const parsedResource = ResourceSchema.safeParse(unwrapEntry(raw).value);
    return { raw, index, parsedResource };
  });
  const declaredResourceIds = new Set(resourceEntries.filter((entry) => entry.parsedResource.success).map((entry) => (entry.parsedResource as { data: Resource }).data.id));

  const preview: ImportPreview = {
    categories: {
      create: (payload.categories ?? []).filter((category) => !existingCategories.has(category.id) && !isReservedCategory(category.id)).map((category) => category.id),
      invalid: (payload.categories ?? []).filter((category) => isReservedCategory(category.id)).map((category) => ({ id: category.id, error: RESERVED_CATEGORY_MESSAGE })),
    },
    resources: { create: [], update: [], same: [], invalid: [] },
    guides: { create: [], update: [], same: [], invalid: [] },
    settings: settingsSummary(payload.settings, knownCategories),
    plan: { digest: payloadDigest(payload), resources: {}, guides: {}, settings: payload.settings ? settingsFingerprint() : null },
  };

  for (const { raw, index, parsedResource } of resourceEntries) {
    if (!parsedResource.success) { preview.resources.invalid.push({ id: labelOf(raw, `#${index + 1}`), error: issues(parsedResource.error) }); continue; }
    const resource = parsedResource.data;
    if (isReservedIdentifier(resource.id)) { preview.resources.invalid.push({ id: resource.id, error: RESERVED_IDENTIFIER_MESSAGE }); continue; }
    // 分类/关联错误前移到预检：提交后只剩真正无法预判的失败（例如保存瞬间的并发改动）。
    if (!knownCategories.has(resource.category)) {
      preview.resources.invalid.push({ id: resource.id, error: `分类 ${resource.category} 不存在，且未在文件的 categories 中声明` });
      continue;
    }
    const current = findManagedResource(resource.id);
    preview.plan.resources[resource.id] = identityOf(current);
    if (current?.deletedAt) preview.resources.update.push(resource.id);
    else if (!current) preview.resources.create.push(resource.id);
    else if (JSON.stringify(current.draft) === JSON.stringify(resource)) preview.resources.same.push(resource.id);
    else preview.resources.update.push(resource.id);
  }

  for (const [index, raw] of (payload.guides ?? []).entries()) {
    const parsedGuide = GuideSchema.safeParse(unwrapEntry(raw).value);
    if (!parsedGuide.success) { preview.guides.invalid.push({ id: labelOf(raw, `#${index + 1}`), error: issues(parsedGuide.error) }); continue; }
    const guide = parsedGuide.data;
    if (isReservedIdentifier(guide.slug)) { preview.guides.invalid.push({ id: guide.slug, error: RESERVED_IDENTIFIER_MESSAGE }); continue; }
    const missing = guide.resources.filter((id) => !declaredResourceIds.has(id) && !findManagedResource(id));
    if (missing.length > 0) { preview.guides.invalid.push({ id: guide.slug, error: `关联资源不存在：${missing.join('、')}` }); continue; }
    const current = findManagedGuide(guide.slug);
    preview.plan.guides[guide.slug] = identityOf(current);
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
}
export interface ImportResult {
  categoriesCreated: number; resources: number; guides: number; restored: number;
  settings: boolean; errors: { id: string; error: string }[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '导入失败';
}

interface ResourceItem { id: string; value: Resource; expected: EntityIdentity | null }
interface GuideItem { id: string; value: Guide; expected: EntityIdentity | null }

function sameIdentity(current: EntityIdentity | null, expected: EntityIdentity | null): boolean {
  if (current === null || expected === null) return current === expected;
  return current.version === expected.version && current.uid === expected.uid;
}

/** Import drafts only. Publishing stays a separate, human action. */
export function applyImport(actor: User, input: unknown, plan?: unknown, options: ImportOptions = {}): ImportResult {
  if (actor.role !== 'admin') fail(403, '导入仅限管理员');
  const parsed = ImportPayloadSchema.safeParse(input);
  if (!parsed.success) fail(400, '导入文件格式不正确');
  const payload = parsed.data;
  const frozen = ImportPlanSchema.safeParse(plan);
  if (!frozen.success) fail(400, '缺少预检计划：请先点“预检”，确认结果后再导入');
  if (frozen.data.digest !== payloadDigest(payload)) fail(409, '提交内容与预检时不一致（预检后又修改了内容）；请重新预检');
  const result: ImportResult = { categoriesCreated: 0, resources: 0, guides: 0, restored: 0, settings: false, errors: [] };

  // 1. 先把条目解析完并核对预检计划，任何一条不在计划里都说明计划与内容不匹配。
  const resourceItems: ResourceItem[] = [];
  const guideItems: GuideItem[] = [];
  for (const raw of payload.resources ?? []) {
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
    resourceItems.push({ id: resource.id, value: resource, expected });
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
    guideItems.push({ id: guide.slug, value: guide, expected });
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
    try {
      importResource(actor, item.value, item.expected);
      result.resources += 1;
      if (wasDeleted) result.restored += 1;
    } catch (error) { result.errors.push({ id: item.id, error: messageOf(error) }); }
  }
  for (const item of guideItems) {
    const wasDeleted = Boolean(findManagedGuide(item.id)?.deletedAt);
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

  return result;
}

export function exportPayload(): unknown {
  const resources = database().prepare('SELECT * FROM resources ORDER BY id').all().map((row) => ({
    id: String(row.id), draft: JSON.parse(String(row.draft)), published: row.published ? JSON.parse(String(row.published)) : null,
    version: Number(row.version), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  }));
  const guides = database().prepare('SELECT * FROM guides ORDER BY slug').all().map((row) => ({
    slug: String(row.slug), draft: JSON.parse(String(row.draft)), published: row.published ? JSON.parse(String(row.published)) : null,
    version: Number(row.version), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  }));
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), categories: listCategories(), resources, guides, settings: exportSettings() };
}
