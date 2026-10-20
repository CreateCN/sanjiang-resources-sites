import { z } from 'zod';
import { ResourceSchema } from './resource-schema.ts';
import { GuideSchema, type Guide } from './guide-schema.ts';
import { findManagedGuide, findManagedResource, listCategories, restoreTrashGuide, restoreTrashResource, saveGuide, saveResource } from '../server/store.ts';
import { database } from '../server/db.ts';
import { audit, fail } from '../server/security.ts';
import type { User } from '../server/store.ts';

export const ImportPayloadSchema = z.object({
  schemaVersion: z.number().optional(),
  exportedAt: z.string().optional(),
  categories: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/).max(80), name: z.string().trim().min(1).max(80) })).max(200).optional(),
  resources: z.array(z.unknown()).max(500).optional(),
  guides: z.array(z.unknown()).max(200).optional(),
});
export type ImportPayload = z.infer<typeof ImportPayloadSchema>;

export interface ImportPreview {
  categories: { create: string[] };
  resources: { create: string[]; update: string[]; same: string[]; invalid: { id: string; error: string }[] };
  guides: { create: string[]; update: string[]; same: string[]; invalid: { id: string; error: string }[] };
}

function labelOf(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string') return record.id;
    if (typeof record.slug === 'string') return record.slug;
  }
  return fallback;
}

export function previewImport(input: unknown): ImportPreview {
  const parsed = ImportPayloadSchema.safeParse(input);
  if (!parsed.success) fail(400, `导入文件格式不正确：${parsed.error.issues.map((issue) => issue.path.join('.')).join('、')}`);
  const payload = parsed.data;
  const existingCategories = new Set(listCategories().map((category) => category.id));
  const preview: ImportPreview = {
    categories: { create: (payload.categories ?? []).filter((category) => !existingCategories.has(category.id)).map((category) => category.id) },
    resources: { create: [], update: [], same: [], invalid: [] },
    guides: { create: [], update: [], same: [], invalid: [] },
  };
  (payload.resources ?? []).forEach((raw, index) => {
    const parsedResource = ResourceSchema.safeParse(raw);
    if (!parsedResource.success) {
      preview.resources.invalid.push({ id: labelOf(raw, `#${index + 1}`), error: parsedResource.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；') });
      return;
    }
    const resource = parsedResource.data;
    const current = findManagedResource(resource.id);
    if (current?.deletedAt) preview.resources.update.push(resource.id);
    else if (!current) preview.resources.create.push(resource.id);
    else if (JSON.stringify(current.draft) === JSON.stringify(resource)) preview.resources.same.push(resource.id);
    else preview.resources.update.push(resource.id);
  });
  (payload.guides ?? []).forEach((raw, index) => {
    const parsedGuide = GuideSchema.safeParse(raw);
    if (!parsedGuide.success) {
      preview.guides.invalid.push({ id: labelOf(raw, `#${index + 1}`), error: parsedGuide.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；') });
      return;
    }
    const guide = parsedGuide.data;
    const current = findManagedGuide(guide.slug);
    if (current?.deletedAt) preview.guides.update.push(guide.slug);
    else if (!current) preview.guides.create.push(guide.slug);
    else if (JSON.stringify(current.draft) === JSON.stringify(guide)) preview.guides.same.push(guide.slug);
    else preview.guides.update.push(guide.slug);
  });
  return preview;
}

export interface ImportResult { categoriesCreated: number; resources: number; guides: number; errors: { id: string; error: string }[] }

/** Import drafts only. Publishing stays a separate, human action. */
export function applyImport(actor: User, input: unknown): ImportResult {
  if (actor.role !== 'admin') fail(403, '导入仅限管理员');
  const parsed = ImportPayloadSchema.safeParse(input);
  if (!parsed.success) fail(400, '导入文件格式不正确');
  const payload = parsed.data;
  const result: ImportResult = { categoriesCreated: 0, resources: 0, guides: 0, errors: [] };
  for (const category of payload.categories ?? []) {
    if (!database().prepare('SELECT 1 FROM categories WHERE id=?').get(category.id)) {
      database().prepare('INSERT INTO categories (id,name) VALUES (?,?)').run(category.id, category.name.trim());
      result.categoriesCreated += 1;
    }
  }
  for (const raw of payload.resources ?? []) {
    const parsedResource = ResourceSchema.safeParse(raw);
    if (!parsedResource.success) { result.errors.push({ id: labelOf(raw, 'resource'), error: '资源校验失败' }); continue; }
    try {
      let current = findManagedResource(parsedResource.data.id);
      if (current?.deletedAt) { restoreTrashResource(actor, current.id); current = findManagedResource(parsedResource.data.id); }
      saveResource(actor, parsedResource.data, current ? current.version : null);
      result.resources += 1;
    } catch (error) { result.errors.push({ id: parsedResource.data.id, error: error instanceof Error ? error.message : '导入失败' }); }
  }
  for (const raw of payload.guides ?? []) {
    const parsedGuide = GuideSchema.safeParse(raw);
    if (!parsedGuide.success) { result.errors.push({ id: labelOf(raw, 'guide'), error: '指南校验失败' }); continue; }
    try {
      let current = findManagedGuide(parsedGuide.data.slug);
      if (current?.deletedAt) { restoreTrashGuide(actor, current.slug); current = findManagedGuide(parsedGuide.data.slug); }
      saveGuide(actor, parsedGuide.data as Guide, current ? current.version : null);
      result.guides += 1;
    } catch (error) { result.errors.push({ id: parsedGuide.data.slug, error: error instanceof Error ? error.message : '导入失败' }); }
  }
  audit(actor.username, 'import', `${result.resources} resources, ${result.guides} guides`);
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
  const settingsRow = database().prepare("SELECT value FROM settings WHERE key='site'").get();
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), categories: listCategories(), resources, guides, settings: settingsRow ? JSON.parse(String(settingsRow.value)) : null };
}
