import type { DatabaseSync } from 'node:sqlite';
import { database } from './db.ts';
import { fail } from './security.ts';
import { extractImageSources } from '../lib/markdown.ts';

/**
 * 媒体引用的**唯一**提取器与依赖校验。
 *
 * 引用来源必须完整：结构化 `image` + 实际会渲染 Markdown 的字段 + 全部历史修订 + 回收站条目。
 * 只扫 `image` 字段会漏掉正文里的图片；只扫正文会漏掉结构化图片；只扫当前行会漏掉"可以回滚
 * 出来的旧修订"——三者中的任何一个都会让 purge 之后出现无法解释的缺图。
 */

export type MediaPayloadKind = 'resource' | 'guide';

const MEDIA_PATH = /^\/media\/([a-f0-9]{64})\.webp$/;

export interface MediaReference {
  id: string;
  kind: 'resource' | 'guide' | 'revision' | 'branding' | 'sponsor';
  label: string;
  locations: string[];
}

/** 站点品牌里三个可引用图片的字段；顺序用于给管理界面稳定的展示文案。 */
export const BRANDING_MEDIA_FIELDS = [
  { field: 'logoMediaId', label: 'Logo' },
  { field: 'faviconMediaId', label: 'favicon' },
  { field: 'shareImageMediaId', label: '分享图' },
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 结构化图片字段 + 实际渲染的 Markdown 字段（与组件里的调用保持一致）。 */
export function mediaIdsInPayload(kind: MediaPayloadKind, payload: unknown): string[] {
  const data = asRecord(payload);
  if (!data) return [];
  const paths: string[] = [];
  const image = textOf(data.image);
  if (image) paths.push(image);

  const markdownFields = kind === 'resource'
    ? ['summary', 'license', 'eligibility', 'caveat', 'details']
    : ['summary', 'body'];
  for (const field of markdownFields) paths.push(...extractImageSources(textOf(data[field])));

  if (kind === 'resource' && Array.isArray(data.steps)) {
    for (const step of data.steps) paths.push(...extractImageSources(textOf(step)));
  }

  const ids: string[] = [];
  for (const path of paths) {
    const match = MEDIA_PATH.exec(path);
    if (match) ids.push(match[1]!);
  }
  return [...new Set(ids)];
}

/**
 * settings.branding 的结构化图片字段。
 * 品牌没有历史修订，只有当前配置；三个字段是独立引用来源，
 * 不能被"资源/指南"扫描顺带覆盖。
 */
export function brandingMediaRefs(value: unknown): { id: string; label: string }[] {
  const data = asRecord(value);
  if (!data) return [];
  const refs: { id: string; label: string }[] = [];
  for (const { field, label } of BRANDING_MEDIA_FIELDS) {
    const raw = textOf(data[field]);
    if (/^[a-f0-9]{64}$/u.test(raw)) refs.push({ id: raw, label });
  }
  return refs;
}

function mediaPath(id: string): string {
  return `/media/${id}.webp`;
}

export function isMediaServable(id: string): boolean {
  const row = database().prepare("SELECT 1 FROM media WHERE id=? AND state='ready' AND deleted_at IS NULL").get(id);
  return Boolean(row);
}

export function unavailableMediaIds(ids: string[]): string[] {
  return [...new Set(ids)].filter((id) => !isMediaServable(id));
}

/**
 * 保存/导入/历史恢复/发布共用的依赖规则：
 * - 新增引用只允许 `ready` 且未下架的媒体；
 * - 仅编辑其它字段时，允许保留**同一个**已下架引用（有人删了图，但当前草稿还引用它）；
 * - 发布时传 previous=null：所有引用必须可用。
 */
export function assertMediaDependencies(kind: MediaPayloadKind, payload: unknown, previous?: unknown | null): void {
  const next = mediaIdsInPayload(kind, payload);
  if (next.length === 0) return;
  const missing = unavailableMediaIds(next);
  if (missing.length === 0) return;
  const previousIds = previous === null || previous === undefined ? [] : mediaIdsInPayload(kind, previous);
  const introduced = missing.filter((id) => !previousIds.includes(id));
  if (introduced.length === 0) return;
  fail(400, `图片已下架或不存在：${introduced.map(mediaPath).join('、')}。请重新上传或移除该图片后再保存`);
}

/**
 * 显式移除不可用图片（导入的 dropMissingMedia 选项）。
 * 保留 alt 文本；返回被移除的媒体 ID，供逐条报告使用。
 */
export function stripUnavailableMedia(kind: MediaPayloadKind, payload: unknown): { payload: unknown; removed: string[] } {
  const data = asRecord(payload);
  if (!data) return { payload, removed: [] };
  const missing = new Set(unavailableMediaIds(mediaIdsInPayload(kind, payload)));
  if (missing.size === 0) return { payload, removed: [] };
  const next: Record<string, unknown> = { ...data };

  if (typeof next.image === 'string' && missing.has(MEDIA_PATH.exec(next.image)?.[1] ?? '')) delete next.image;

  const strip = (text: string): string => stripMediaSyntax(text, missing);
  for (const field of ['summary', 'license', 'eligibility', 'caveat', 'details', 'body']) {
    if (typeof next[field] === 'string') next[field] = strip(next[field] as string);
  }
  if (Array.isArray(next.steps)) next.steps = next.steps.map((step) => typeof step === 'string' ? strip(step) : step);
  return { payload: next, removed: [...missing] };
}

/** 把不可用图片的内联/引用式语法替换为 alt 文本；引用定义整行删除。 */
function stripMediaSyntax(text: string, missing: Set<string>): string {
  let output = text;
  for (const id of missing) {
    const escaped = `/media/${id}\\.webp`;
    output = output.replace(new RegExp(`!\\[([^\\]]*)\\]\\(\\s*${escaped}(?:\\s+"[^"]*")?\\s*\\)`, 'gu'), '$1');
    output = output.replace(new RegExp(`^[ \\t]*\\[[^\\]]+\\]:\\s*${escaped}[ \\t]*$\\n?`, 'gmu'), '');
  }
  return output;
}

function refsForEntity(kind: MediaPayloadKind, label: string, draft: unknown, published: unknown): Map<string, MediaReference> {
  const map = new Map<string, MediaReference>();
  const locations: string[] = [];
  const ids = new Set<string>();
  const draftIds = mediaIdsInPayload(kind, draft);
  const publishedIds = mediaIdsInPayload(kind, published);
  if (draftIds.length > 0) locations.push('草稿');
  if (publishedIds.length > 0) locations.push('公开快照');
  for (const id of [...draftIds, ...publishedIds]) ids.add(id);
  for (const id of ids) map.set(id, { id, kind, label, locations });
  return map;
}

/**
 * 扫描该媒体的全部引用：资源/指南的草稿与公开快照（**含回收站**）+ 所有历史修订。
 * purge 与 GC 都只认这个结果；禁止另写一套"近似"扫描。
 */
export function scanMediaReferences(id: string, db: DatabaseSync = database()): MediaReference[] {
  const references: MediaReference[] = [];

  const resources = db.prepare('SELECT id,draft,published,deleted_at FROM resources').all();
  for (const row of resources) {
    const title = (() => { try { return String(asRecord(JSON.parse(String(row.draft)))?.title ?? row.id); } catch { return String(row.id); } })();
    const label = `${title}（资源 /${row.id}${row.deleted_at ? '，回收站' : ''}）`;
    const refs = refsForEntity('resource', label, safeJson(row.draft), safeJson(row.published));
    const hit = refs.get(id);
    if (hit) references.push(hit);
  }

  const guides = db.prepare('SELECT slug,draft,published,deleted_at FROM guides').all();
  for (const row of guides) {
    const title = (() => { try { return String(asRecord(JSON.parse(String(row.draft)))?.title ?? row.slug); } catch { return String(row.slug); } })();
    const label = `${title}（指南 /${row.slug}${row.deleted_at ? '，回收站' : ''}）`;
    const refs = refsForEntity('guide', label, safeJson(row.draft), safeJson(row.published));
    const hit = refs.get(id);
    if (hit) references.push(hit);
  }

  const revisions = db.prepare('SELECT id,entity_kind,entity_id,data FROM revisions').all();
  for (const row of revisions) {
    const kind = row.entity_kind === 'guide' ? 'guide' : 'resource';
    const data = safeJson(row.data);
    const ids = mediaIdsInPayload(kind, data);
    if (!ids.includes(id)) continue;
    references.push({ id, kind: 'revision', label: `修订 #${row.id}（${kind === 'guide' ? '指南' : '资源'} /${row.entity_id}）`, locations: ['历史修订'] });
  }

  const branding = db.prepare("SELECT value FROM settings WHERE key='branding'").get();
  const brandingLocations = brandingMediaRefs(safeJson(branding?.value)).filter((ref) => ref.id === id).map((ref) => ref.label);
  if (brandingLocations.length > 0) {
    references.push({ id, kind: 'branding', label: '站点品牌配置', locations: brandingLocations });
  }

  // 赞助图片同样受保护：停用/过期也不自动解除引用，必须显式移除后才能彻底删除。
  const sponsorRows = db.prepare('SELECT id,title,placement,enabled FROM sponsors WHERE media_id=?').all(id);
  for (const row of sponsorRows) {
    references.push({
      id,
      kind: 'sponsor',
      label: `赞助「${String(row.title)}」`,
      locations: [row.placement === 'catalog-promotion' ? '目录推广位' : '首页侧栏', row.enabled ? '启用中' : '停用'],
    });
  }

  return references;
}

/**
 * 与 scanMediaReferences 共用同一套提取规则，一次扫描全部引用来源。
 * 必须显式传入数据库连接：离线恢复脚本在暂存副本上调用它，
 * 绝不能因为默认参数而打开默认生产库。
 */
export function collectReferencedMediaIds(db: DatabaseSync): Set<string> {
  const ids = new Set<string>();
  const add = (kind: MediaPayloadKind, payload: unknown) => {
    for (const id of mediaIdsInPayload(kind, payload)) ids.add(id);
  };
  for (const row of db.prepare('SELECT draft,published FROM resources').all()) {
    add('resource', safeJson(row.draft));
    add('resource', safeJson(row.published));
  }
  for (const row of db.prepare('SELECT draft,published FROM guides').all()) {
    add('guide', safeJson(row.draft));
    add('guide', safeJson(row.published));
  }
  for (const row of db.prepare('SELECT entity_kind,data FROM revisions').all()) {
    add(row.entity_kind === 'guide' ? 'guide' : 'resource', safeJson(row.data));
  }
  const branding = db.prepare("SELECT value FROM settings WHERE key='branding'").get();
  for (const ref of brandingMediaRefs(safeJson(branding?.value))) ids.add(ref.id);
  for (const row of db.prepare('SELECT media_id FROM sponsors WHERE media_id IS NOT NULL').all()) {
    ids.add(String(row.media_id));
  }
  return ids;
}

function safeJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}

/** 当前引用数量（不含历史修订），用于列表展示。 */
export function countCurrentReferences(id: string): number {
  return scanMediaReferences(id).filter((reference) => reference.kind !== 'revision').length;
}
