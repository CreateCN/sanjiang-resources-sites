import { createHash } from 'node:crypto';
import { z } from 'zod';
import { database, transaction } from './db.ts';
import type { User } from './store.ts';
import { fail, audit } from './security.ts';

export interface ScenarioCopy { task: string; detail: string; glyph: string }
export interface SiteSettings { featuredResourceId: string; scenarios: Record<string, ScenarioCopy> }

const DEFAULT_SCENARIOS: Record<string, ScenarioCopy> = {
  writing: { task: '写好一篇报告', detail: '文献、阅读与排版', glyph: '文' },
  development: { task: '开始写代码', detail: '编程、版本与开发', glyph: '码' },
  design: { task: '把想法做出来', detail: '图像、视频与模型', glyph: '创' },
  learning: { task: '选一门公开课', detail: '课程、讲义与练习', glyph: '学' },
  efficiency: { task: '让作业更顺手', detail: '效率、录屏与协作', glyph: '用' },
};

const SettingsSchema = z.object({
  featuredResourceId: z.string().regex(/^[a-z0-9-]*$/).max(100),
  scenarios: z.record(z.object({ task: z.string().trim().min(1).max(30), detail: z.string().trim().max(60), glyph: z.string().trim().min(1).max(2) })).default({}),
}).strict();

export function defaultSettings(): SiteSettings {
  return { featuredResourceId: 'zotero', scenarios: { ...DEFAULT_SCENARIOS } };
}
export function getSettings(): SiteSettings {
  const row = database().prepare("SELECT value FROM settings WHERE key='site'").get();
  if (!row) return defaultSettings();
  try {
    const parsed = SettingsSchema.safeParse(JSON.parse(String(row.value)));
    if (!parsed.success) return defaultSettings();
    return { featuredResourceId: parsed.data.featuredResourceId, scenarios: { ...DEFAULT_SCENARIOS, ...parsed.data.scenarios } };
  } catch { return defaultSettings(); }
}
/**
 * 导出/迁移用设置：默认场景文案只保留仍然存在的分类。
 * getSettings() 会无条件合并 DEFAULT_SCENARIOS，直接导出会把已删除分类的文案带回来，
 * 导回时 saveSettings 会因"分类不存在"整体失败。
 */
export function exportSettings(): SiteSettings {
  const settings = getSettings();
  const existing = new Set(database().prepare('SELECT id FROM categories').all().map((row) => String(row.id)));
  const scenarios: Record<string, ScenarioCopy> = {};
  for (const [id, copy] of Object.entries(settings.scenarios)) if (existing.has(id)) scenarios[id] = copy;
  return { featuredResourceId: settings.featuredResourceId, scenarios };
}
/** 当前设置的摘要，供导入预检冻结；应用时用它判断设置是否在预检后被改过。 */
export function settingsFingerprint(): string {
  return createHash('sha256').update(JSON.stringify(getSettings())).digest('hex');
}
/**
 * 首页编排的并发版本：直接摘要 settings.site 的原始值。
 * 用原始值而不是归一化结果，避免默认场景合并掩盖"别人刚保存过"的事实；
 * 页面保存时把渲染时的摘要带回，在事务内比较（CAS）。
 */
export function settingsRevision(): string {
  const row = database().prepare("SELECT value FROM settings WHERE key='site'").get();
  return createHash('sha256').update(row ? String(row.value) : '').digest('hex');
}
/**
 * expectedRevision 省略时不做 CAS（导入应用等内部调用）；
 * 管理表单必须传，旧页面提交会用 409 而不是覆盖新值。
 */
export function saveSettings(actor: User, input: unknown, expectedRevision?: string): SiteSettings {
  const parsed = SettingsSchema.safeParse(input);
  if (!parsed.success) fail(400, `设置校验失败：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  return transaction((db) => {
    const row = db.prepare('SELECT role,active FROM users WHERE id=?').get(actor.id);
    if (!row || !row.active) fail(401, '登录已失效，请重新登录');
    if (row.role !== 'admin') fail(403, '此操作仅限管理员');
    if (expectedRevision !== undefined) {
      const current = db.prepare("SELECT value FROM settings WHERE key='site'").get();
      const currentRevision = createHash('sha256').update(current ? String(current.value) : '').digest('hex');
      if (currentRevision !== expectedRevision) fail(409, '首页编排已被其他维护者修改，请刷新页面后重试');
    }
    if (parsed.data.featuredResourceId && !db.prepare('SELECT 1 FROM resources WHERE id=? AND published IS NOT NULL AND deleted_at IS NULL AND discontinued_at IS NULL').get(parsed.data.featuredResourceId)) {
      fail(400, '首页精选资源不存在，或未发布、在回收站中、已停用；只有仍在公开目录中的资源可以设为精选');
    }
    const categories = new Set(db.prepare('SELECT id FROM categories').all().map((item) => String(item.id)));
    for (const id of Object.keys(parsed.data.scenarios)) if (!categories.has(id)) fail(400, `分类不存在：${id}`);
    const value = JSON.stringify(parsed.data);
    db.prepare("INSERT INTO settings (key,value) VALUES ('site',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
    audit(actor.username, 'save-settings', 'site');
    return getSettings();
  });
}
