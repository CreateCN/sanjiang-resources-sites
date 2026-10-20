import { ResourceSchema, type Resource } from '../lib/resource-schema.ts';
import { GuideSchema, type Guide } from '../lib/guide-schema.ts';
import { database, transaction } from './db.ts';
import { audit, fail, hashPassword } from './security.ts';
import { requestMemo } from './request-cache.ts';
export type { Resource } from '../lib/resource-schema.ts';
export type { Guide } from '../lib/guide-schema.ts';
export type Role = 'admin' | 'editor';
export interface User { id: number; username: string; role: Role; active: boolean }
export interface ManagedResource { id: string; draft: Resource; published: Resource | null; version: number; updatedAt: string; deletedAt: string | null }
export type RevisionKind = 'resource' | 'guide';
export type RevisionAction = 'save' | 'publish' | 'unpublish' | 'restore';
export interface Revision { id: number; kind: RevisionKind; entityId: string; version: number; data: unknown; actor: string; action: RevisionAction; createdAt: string }
export interface ManagedGuide { slug: string; draft: Guide; published: Guide | null; version: number; updatedAt: string; deletedAt: string | null }
export interface Report { id: number; resourceId: string | null; revisionId: number | null; kind: string; title: string; body: string; status: 'new' | 'processing' | 'resolved'; note: string; createdAt: string }
export interface AuditEntry { id: number; actor: string; action: string; target: string; createdAt: string }
type Row = Record<string, unknown>;
function user(row: Row): User { return { id: Number(row.id), username: String(row.username), role: row.role as Role, active: Boolean(row.active) }; }
function managed(row: Row): ManagedResource {
  return { id: String(row.id), draft: JSON.parse(String(row.draft)), published: row.published ? JSON.parse(String(row.published)) : null, version: Number(row.version), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null };
}
export function getPublishedResources(): Resource[] {
  return requestMemo('published-resources', () => database().prepare('SELECT published FROM resources WHERE published IS NOT NULL AND deleted_at IS NULL ORDER BY rowid').all().map((row) => JSON.parse(String(row.published))));
}
export function findPublishedResource(id: string): Resource | undefined {
  return requestMemo(`published-resource:${id}`, () => {
    const row = database().prepare('SELECT published FROM resources WHERE id=? AND published IS NOT NULL AND deleted_at IS NULL').get(id);
    return row ? JSON.parse(String(row.published)) : undefined;
  });
}
export function listCategories(): { id: string; name: string }[] {
  return requestMemo('categories', () => database().prepare('SELECT id,name FROM categories ORDER BY rowid').all().map((row) => ({ id: String(row.id), name: String(row.name) })));
}
export function listManagedResources(): ManagedResource[] { return database().prepare('SELECT * FROM resources WHERE deleted_at IS NULL ORDER BY updated_at DESC,id').all().map(managed); }
export function listDeletedResources(): ManagedResource[] { return database().prepare('SELECT * FROM resources WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all().map(managed); }
export function findManagedResource(id: string): ManagedResource | undefined {
  const row = database().prepare('SELECT * FROM resources WHERE id=?').get(id); return row ? managed(row) : undefined;
}
export function listUsers(): User[] { return database().prepare('SELECT id,username,role,active FROM users ORDER BY id').all().map(user); }
export function listReports(): Report[] {
  return database().prepare('SELECT * FROM reports ORDER BY id DESC').all().map((r) => ({ id: Number(r.id), resourceId: r.resource_id === null ? null : String(r.resource_id), revisionId: r.revision_id === null || r.revision_id === undefined ? null : Number(r.revision_id), kind: String(r.kind), title: String(r.title), body: String(r.body), status: r.status as Report['status'], note: String(r.note), createdAt: String(r.created_at) }));
}
export function listAudit(): AuditEntry[] {
  return database().prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 1000').all().map((r) => ({ id: Number(r.id), actor: String(r.actor), action: String(r.action), target: String(r.target), createdAt: String(r.created_at) }));
}
function actorUser(actor: User, adminOnly = false): User {
  const row = database().prepare('SELECT id,username,role,active FROM users WHERE id=?').get(actor.id);
  if (!row || !row.active) fail(401, '登录已失效，请重新登录');
  const current = user(row);
  if (adminOnly && current.role !== 'admin') fail(403, '此操作仅限管理员');
  return current;
}
function requiredVersion(version: number | null): number {
  if (version === null || !Number.isSafeInteger(version) || version < 1) fail(400, '缺少有效版本号，请重新加载条目');
  return version;
}
function checkVersion(id: string, version: number | null): ManagedResource {
  const expected = requiredVersion(version);
  const item = findManagedResource(id);
  if (!item) fail(404, '资源不存在');
  if (item.version !== expected) fail(409, '该资源已被其他维护者修改；请保留当前草稿，重新加载后合并');
  return item;
}
function categoryExists(id: string): void {
  if (!database().prepare('SELECT 1 FROM categories WHERE id=?').get(id)) fail(400, '所选分类不存在');
}
export function saveResource(actor: User, input: unknown, version: number | null): ManagedResource {
  const parsed = ResourceSchema.safeParse(input);
  if (!parsed.success) fail(400, `资源校验失败：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  const resource = parsed.data;
  return transaction((db) => {
    const current = actorUser(actor);
    categoryExists(resource.category);
    const previous = findManagedResource(resource.id);
    if (previous?.deletedAt) fail(409, '该资源在回收站中，请先恢复后再编辑');
    const now = new Date().toISOString();
    if (previous) {
      checkVersion(resource.id, version);
      db.prepare('UPDATE resources SET draft=?,draft_category=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(resource), resource.category, now, resource.id);
    } else {
      if (version !== null) fail(409, '资源已被删除，不能用旧版本重新创建');
      db.prepare('INSERT INTO resources (id,draft,draft_category,version,updated_at) VALUES (?,?,?,1,?)').run(resource.id, JSON.stringify(resource), resource.category, now);
    }
    const saved = findManagedResource(resource.id)!;
    recordRevision(db, 'resource', resource.id, saved.version, resource, current.username, 'save');
    audit(current.username, 'save-resource', resource.id);
    return saved;
  });
}
export function changePublication(actor: User, id: string, version: number | null, action: 'publish' | 'unpublish' | 'delete-resource'): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    const resource = checkVersion(id, version);
    if (action === 'delete-resource') db.prepare('UPDATE resources SET deleted_at=?,published=NULL,published_category=NULL,version=version+1,updated_at=? WHERE id=?').run(new Date().toISOString(), new Date().toISOString(), id);
    else if (action === 'publish') db.prepare('UPDATE resources SET published=draft,published_category=draft_category,version=version+1,updated_at=? WHERE id=?').run(new Date().toISOString(), id);
    else if (action === 'unpublish') db.prepare('UPDATE resources SET published=NULL,published_category=NULL,version=version+1,updated_at=? WHERE id=?').run(new Date().toISOString(), id);
    else fail(400, '未知操作');
    if (action !== 'delete-resource') {
      const snapshot = action === 'publish' ? resource.draft : (resource.published ?? resource.draft);
      recordRevision(db, 'resource', resource.id, resource.version + 1, snapshot, current.username, action);
    }
    audit(current.username, action, resource.id);
  });
}
export function saveCategory(actor: User, id: string, name: string): void {
  if (id === 'all' || !/^[a-z0-9-]{1,80}$/.test(id) || !name.trim() || name.trim().length > 100) fail(400, '分类标识或名称无效（all 为保留标识）');
  transaction((db) => {
    const current = actorUser(actor, true);
    db.prepare('INSERT INTO categories (id,name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id, name.trim());
    audit(current.username, 'save-category', id);
  });
}
export function deleteCategory(actor: User, id: string): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    if (db.prepare('SELECT 1 FROM resources WHERE draft_category=? OR published_category=?').get(id, id)) fail(409, '此分类仍被草稿或已发布资源引用，不能删除');
    if (!db.prepare('DELETE FROM categories WHERE id=?').run(id).changes) fail(404, '分类不存在');
    audit(current.username, 'delete-category', id);
  });
}
function usernameValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,64}$/.test(normalized)) fail(400, '用户名须为 3–64 位字母、数字、点、下划线或连字符');
  return normalized;
}
function roleValue(value: string): Role { if (value !== 'admin' && value !== 'editor') fail(400, '无效角色'); return value; }
function insertUser(username: string, password: string, role: Role): User {
  const db = database();
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail(409, '用户名已存在');
  const result = db.prepare('INSERT INTO users (username,password_hash,role,active) VALUES (?,?,?,1)').run(username, hashPassword(password), role);
  return { id: Number(result.lastInsertRowid), username, role, active: true };
}
/** Explicit operator provisioning only; never called during first database initialization. */
export function createInitialAdmin(username: string, password: string): User {
  const name = usernameValue(username);
  return transaction(() => { const created = insertUser(name, password, 'admin'); audit('cli', 'create-admin', String(created.id)); return created; });
}
export function createUser(actor: User, username: string, password: string, role: string): User {
  const name = usernameValue(username); const nextRole = roleValue(role);
  return transaction(() => { const current = actorUser(actor, true); const created = insertUser(name, password, nextRole); audit(current.username, 'create-user', String(created.id)); return created; });
}
function protectLastAdmin(id: number, role: Role, active: boolean): void {
  const previous = database().prepare('SELECT role,active FROM users WHERE id=?').get(id);
  if (!previous) fail(404, '用户不存在');
  if (previous.role === 'admin' && previous.active && (role !== 'admin' || !active)) {
    const count = database().prepare("SELECT COUNT(*) AS total FROM users WHERE role='admin' AND active=1").get()!;
    if (Number(count.total) <= 1) fail(409, '不能停用、删除或降级最后一位有效管理员');
  }
}
export function updateUser(actor: User, id: number, role: string, active: boolean, password = ''): void {
  const nextRole = roleValue(role);
  const passwordHash = password ? hashPassword(password) : null;
  transaction((db) => {
    const current = actorUser(actor, true);
    protectLastAdmin(id, nextRole, active);
    const previous = db.prepare('SELECT role,active FROM users WHERE id=?').get(id)!;
    db.prepare('UPDATE users SET role=?,active=?,password_hash=COALESCE(?,password_hash) WHERE id=?').run(nextRole, active ? 1 : 0, passwordHash, id);
    if (passwordHash || previous.role !== nextRole || Boolean(previous.active) !== active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    audit(current.username, 'update-user', String(id));
  });
}
export function deleteUser(actor: User, id: number): void {
  transaction((db) => { const current = actorUser(actor, true); protectLastAdmin(id, 'editor', false); db.prepare('DELETE FROM users WHERE id=?').run(id); audit(current.username, 'delete-user', String(id)); });
}
function bounded(value: string, label: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || /\u0000/.test(text)) fail(400, `${label}须为 ${min}–${max} 个字符`);
  return text;
}
export function createReport(input: { resourceId?: string; kind: string; title: string; body: string }): void {
  const kind = bounded(input.kind, '反馈类型', 1, 60), title = bounded(input.title, '标题', 1, 150), body = bounded(input.body, '反馈内容', 10, 4000);
  const resourceId = input.resourceId?.trim() || null;
  transaction((db) => {
    if (resourceId && !db.prepare('SELECT 1 FROM resources WHERE id=? AND published IS NOT NULL').get(resourceId)) fail(400, '请核对反馈资源或选择一般反馈');
    db.prepare('INSERT INTO reports (resource_id,kind,title,body,created_at) VALUES (?,?,?,?,?)').run(resourceId, kind, title, body, new Date().toISOString());
  });
}
export function updateReport(actor: User, id: number, status: string, note: string, revisionId: number | null = null): void {
  if (!['new', 'processing', 'resolved'].includes(status) || note.length > 4000) fail(400, '无效反馈状态或备注过长');
  transaction((db) => {
    const current = actorUser(actor);
    const report = db.prepare('SELECT resource_id FROM reports WHERE id=?').get(id);
    if (!report) fail(404, '反馈不存在');
    if (revisionId !== null) {
      if (!report.resource_id) fail(400, '这条反馈没有关联资源，不能关联修订');
      const revision = db.prepare('SELECT 1 FROM revisions WHERE id=? AND entity_kind=? AND entity_id=?').get(revisionId, 'resource', String(report.resource_id));
      if (!revision) fail(400, '所选修订不属于这条反馈关联的资源');
    }
    db.prepare('UPDATE reports SET status=?,note=?,revision_id=? WHERE id=?').run(status, note.trim(), revisionId, id);
    audit(current.username, 'update-report', String(id));
  });
}

function managedGuide(row: Row): ManagedGuide {
  return { slug: String(row.slug), draft: JSON.parse(String(row.draft)), published: row.published ? JSON.parse(String(row.published)) : null, version: Number(row.version), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null };
}
export function getPublishedGuides(): Guide[] {
  return requestMemo('published-guides', () => database().prepare('SELECT published FROM guides WHERE published IS NOT NULL AND deleted_at IS NULL ORDER BY rowid').all().map((row) => JSON.parse(String(row.published))));
}
export function findPublishedGuide(slug: string): Guide | undefined {
  return requestMemo(`published-guide:${slug}`, () => {
    const row = database().prepare('SELECT published FROM guides WHERE slug=? AND published IS NOT NULL AND deleted_at IS NULL').get(slug);
    return row ? JSON.parse(String(row.published)) : undefined;
  });
}
export function listManagedGuides(): ManagedGuide[] {
  return database().prepare('SELECT * FROM guides WHERE deleted_at IS NULL ORDER BY updated_at DESC,slug').all().map(managedGuide);
}
export function listDeletedGuides(): ManagedGuide[] {
  return database().prepare('SELECT * FROM guides WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all().map(managedGuide);
}
export function findManagedGuide(slug: string): ManagedGuide | undefined {
  const row = database().prepare('SELECT * FROM guides WHERE slug=?').get(slug);
  return row ? managedGuide(row) : undefined;
}
function guideVersion(slug: string, version: number | null): ManagedGuide {
  const expected = requiredVersion(version);
  const item = findManagedGuide(slug);
  if (!item) fail(404, '指南不存在');
  if (item.version !== expected) fail(409, '该指南已被其他维护者修改；请保留当前内容，重新加载后合并');
  return item;
}
export function saveGuide(actor: User, input: unknown, version: number | null): ManagedGuide {
  const parsed = GuideSchema.safeParse(input);
  if (!parsed.success) fail(400, `指南校验失败：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  const guide = parsed.data;
  return transaction((db) => {
    const current = actorUser(actor);
    for (const id of guide.resources) if (!db.prepare('SELECT 1 FROM resources WHERE id=?').get(id)) fail(400, `关联资源不存在：${id}`);
    const previous = findManagedGuide(guide.slug);
    if (previous?.deletedAt) fail(409, '该指南在回收站中，请先恢复后再编辑');
    const now = new Date().toISOString();
    if (previous) {
      guideVersion(guide.slug, version);
      db.prepare('UPDATE guides SET draft=?,version=version+1,updated_at=? WHERE slug=?').run(JSON.stringify(guide), now, guide.slug);
    } else {
      if (version !== null) fail(409, '指南已被删除，不能用旧版本重新创建');
      db.prepare('INSERT INTO guides (slug,draft,version,updated_at) VALUES (?,?,1,?)').run(guide.slug, JSON.stringify(guide), now);
    }
    const saved = findManagedGuide(guide.slug)!;
    recordRevision(db, 'guide', guide.slug, saved.version, guide, current.username, 'save');
    audit(current.username, 'save-guide', guide.slug);
    return saved;
  });
}
export function changeGuidePublication(actor: User, slug: string, version: number | null, action: 'publish-guide' | 'unpublish-guide' | 'delete-guide'): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    const guide = guideVersion(slug, version);
    if (action === 'delete-guide') db.prepare('UPDATE guides SET deleted_at=?,published=NULL,version=version+1,updated_at=? WHERE slug=?').run(new Date().toISOString(), new Date().toISOString(), slug);
    else if (action === 'publish-guide') db.prepare('UPDATE guides SET published=draft,version=version+1,updated_at=? WHERE slug=?').run(new Date().toISOString(), slug);
    else if (action === 'unpublish-guide') db.prepare('UPDATE guides SET published=NULL,version=version+1,updated_at=? WHERE slug=?').run(new Date().toISOString(), slug);
    else fail(400, '未知指南操作');
    if (action !== 'delete-guide') {
      const snapshot = action === 'publish-guide' ? guide.draft : (guide.published ?? guide.draft);
      recordRevision(db, 'guide', guide.slug, guide.version + 1, snapshot, current.username, action === 'publish-guide' ? 'publish' : 'unpublish');
    }
    audit(current.username, action, guide.slug);
  });
}

const REVISION_LIMIT = 50;
function recordRevision(db: ReturnType<typeof database>, kind: RevisionKind, entityId: string, version: number, data: unknown, actor: string, action: RevisionAction): void {
  db.prepare('INSERT INTO revisions (entity_kind,entity_id,version,data,actor,action,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(kind, entityId, version, JSON.stringify(data), actor, action, new Date().toISOString());
  db.prepare(`DELETE FROM revisions WHERE entity_kind=? AND entity_id=? AND id NOT IN
    (SELECT id FROM revisions WHERE entity_kind=? AND entity_id=? ORDER BY id DESC LIMIT ?)`)
    .run(kind, entityId, kind, entityId, REVISION_LIMIT);
}
export function listRevisions(kind: RevisionKind, entityId: string, limit = 30): Revision[] {
  return database().prepare('SELECT * FROM revisions WHERE entity_kind=? AND entity_id=? ORDER BY id DESC LIMIT ?')
    .all(kind, entityId, limit)
    .map((row) => ({ id: Number(row.id), kind: row.entity_kind as RevisionKind, entityId: String(row.entity_id), version: Number(row.version), data: JSON.parse(String(row.data)), actor: String(row.actor), action: row.action as RevisionAction, createdAt: String(row.created_at) }));
}
function findRevision(kind: RevisionKind, entityId: string, revisionId: number): Revision {
  const row = database().prepare('SELECT * FROM revisions WHERE id=? AND entity_kind=? AND entity_id=?').get(revisionId, kind, entityId);
  if (!row) fail(404, '版本记录不存在');
  return { id: Number(row.id), kind: row.entity_kind as RevisionKind, entityId: String(row.entity_id), version: Number(row.version), data: JSON.parse(String(row.data)), actor: String(row.actor), action: row.action as RevisionAction, createdAt: String(row.created_at) };
}
/** Restore an old snapshot as the new draft. Publishing stays a separate admin action. */
export function restoreResourceRevision(actor: User, id: string, revisionId: number, version: number | null): ManagedResource {
  return transaction((db) => {
    const current = actorUser(actor);
    const item = findManagedResource(id);
    if (!item) fail(404, '资源不存在');
    const expected = requiredVersion(version);
    if (item.version !== expected) fail(409, '该资源已被其他维护者修改；请重新加载后再恢复版本');
    const revision = findRevision('resource', id, revisionId);
    const parsed = ResourceSchema.safeParse(revision.data);
    if (!parsed.success) fail(400, '该历史版本无法恢复：数据结构不完整');
    const resource = { ...parsed.data, id: item.id };
    db.prepare('UPDATE resources SET draft=?,draft_category=?,version=version+1,updated_at=? WHERE id=?')
      .run(JSON.stringify(resource), resource.category, new Date().toISOString(), id);
    const saved = findManagedResource(id)!;
    recordRevision(db, 'resource', id, saved.version, resource, current.username, 'restore');
    audit(current.username, 'restore-resource', id);
    return saved;
  });
}
export function restoreGuideRevision(actor: User, slug: string, revisionId: number, version: number | null): ManagedGuide {
  const revision = findRevision('guide', slug, revisionId);
  return transaction((db) => {
    const current = actorUser(actor);
    const item = findManagedGuide(slug);
    if (!item) fail(404, '指南不存在');
    const expected = requiredVersion(version);
    if (item.version !== expected) fail(409, '该指南已被其他维护者修改；请重新加载后再恢复版本');
    const parsed = GuideSchema.safeParse(revision.data);
    if (!parsed.success) fail(400, '该历史版本无法恢复：数据结构不完整');
    const guide = { ...parsed.data, slug: item.slug };
    db.prepare('UPDATE guides SET draft=?,version=version+1,updated_at=? WHERE slug=?')
      .run(JSON.stringify(guide), new Date().toISOString(), slug);
    const saved = findManagedGuide(slug)!;
    recordRevision(db, 'guide', slug, saved.version, guide, current.username, 'restore');
    audit(current.username, 'restore-guide', slug);
    return saved;
  });
}

export type MetricName = 'resource_view' | 'guide_view' | 'outbound_click' | 'search_miss';
const METRIC_NAMES: readonly MetricName[] = ['resource_view', 'guide_view', 'outbound_click', 'search_miss'];
const EVENT_RETENTION_DAYS = 90;
function utcDay(date: Date): string { return date.toISOString().slice(0, 10); }
/** Privacy-safe counter: only a day, an allow-listed event name and a normalised target. */
export function recordEvent(name: MetricName, target: string): void {
  if (!METRIC_NAMES.includes(name)) return;
  const clean = target.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return;
  const now = new Date();
  const day = utcDay(now);
  database().prepare(`INSERT INTO events (day,name,target,count) VALUES (?,?,?,1)
    ON CONFLICT(day,name,target) DO UPDATE SET count=count+1`).run(day, name, clean);
}
/** Maintenance work, not part of every page-view write. */
export function pruneEvents(now = new Date()): number {
  const cutoff = utcDay(new Date(now.getTime() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000));
  return Number(database().prepare('DELETE FROM events WHERE day < ?').run(cutoff).changes);
}
export interface MetricRow { name: string; target: string; total: number }
export function metricsSummary(days = 30): { since: string; totals: Record<string, number>; rows: MetricRow[] } {
  const since = utcDay(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
  const rows = database().prepare('SELECT name,target,SUM(count) AS total FROM events WHERE day>=? GROUP BY name,target ORDER BY total DESC, target').all(since)
    .map((row) => ({ name: String(row.name), target: String(row.target), total: Number(row.total) }));
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.name] = (totals[row.name] ?? 0) + row.total;
  return { since, totals, rows };
}
/** Used by /api/health so a broken database does not report healthy. */
export function pingDatabase(): boolean {
  try { database().prepare('SELECT 1 AS ok').get(); return true; } catch { return false; }
}

function deletedResource(id: string): ManagedResource {
  const item = findManagedResource(id);
  if (!item || !item.deletedAt) fail(404, '回收站中没有这条资源');
  return item;
}
export function restoreTrashResource(actor: User, id: string): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    deletedResource(id);
    db.prepare('UPDATE resources SET deleted_at=NULL,version=version+1,updated_at=? WHERE id=?').run(new Date().toISOString(), id);
    audit(current.username, 'restore-trash', id);
  });
}
export function purgeTrashResource(actor: User, id: string): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    deletedResource(id);
    db.prepare('DELETE FROM revisions WHERE entity_kind=? AND entity_id=?').run('resource', id);
    db.prepare('DELETE FROM link_checks WHERE resource_id=?').run(id);
    db.prepare('DELETE FROM resources WHERE id=?').run(id);
    audit(current.username, 'purge-resource', id);
  });
}
function deletedGuide(slug: string): ManagedGuide {
  const item = findManagedGuide(slug);
  if (!item || !item.deletedAt) fail(404, '回收站中没有这篇指南');
  return item;
}
export function restoreTrashGuide(actor: User, slug: string): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    deletedGuide(slug);
    db.prepare('UPDATE guides SET deleted_at=NULL,version=version+1,updated_at=? WHERE slug=?').run(new Date().toISOString(), slug);
    audit(current.username, 'restore-trash', slug);
  });
}
export function purgeTrashGuide(actor: User, slug: string): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    deletedGuide(slug);
    db.prepare('DELETE FROM revisions WHERE entity_kind=? AND entity_id=?').run('guide', slug);
    db.prepare('DELETE FROM guides WHERE slug=?').run(slug);
    audit(current.username, 'purge-guide', slug);
  });
}
export interface LinkCheck { resourceId: string; status: 'ok' | 'warn' | 'broken' | 'error'; statusCode: number | null; finalUrl: string | null; message: string; checkedAt: string }
export function saveLinkCheck(resourceId: string, result: { status: LinkCheck['status']; statusCode: number | null; finalUrl: string | null; message: string }): LinkCheck {
  const checkedAt = new Date().toISOString();
  database().prepare(`INSERT INTO link_checks (resource_id,status,status_code,final_url,message,checked_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(resource_id) DO UPDATE SET status=excluded.status,status_code=excluded.status_code,final_url=excluded.final_url,message=excluded.message,checked_at=excluded.checked_at`)
    .run(resourceId, result.status, result.statusCode, result.finalUrl, result.message, checkedAt);
  return { resourceId, ...result, checkedAt };
}
export function listLinkChecks(): LinkCheck[] {
  return database().prepare('SELECT * FROM link_checks ORDER BY checked_at DESC').all().map((row) => ({
    resourceId: String(row.resource_id), status: row.status as LinkCheck['status'], statusCode: row.status_code === null ? null : Number(row.status_code),
    finalUrl: row.final_url === null ? null : String(row.final_url), message: String(row.message), checkedAt: String(row.checked_at),
  }));
}

export function schemaVersion(): string | null {
  const row = database().prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get();
  return row ? String(row.id) : null;
}
export function bulkReviewResources(actor: User, ids: string[], status: 'verified' | 'review', date: string | null): { updated: number; skipped: string[] } {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) fail(400, '请选择 1–200 条资源');
  const checkedAt = status === 'verified' ? (date ?? new Date().toISOString().slice(0, 10)) : null;
  if (status === 'verified' && (!checkedAt || !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) || Number.isNaN(Date.parse(checkedAt)))) fail(400, '核对日期无效');
  return transaction((db) => {
    const current = actorUser(actor);
    const skipped: string[] = [];
    let updated = 0;
    for (const id of ids) {
      const item = findManagedResource(id);
      if (!item || item.deletedAt) { skipped.push(id); continue; }
      const draft = { ...item.draft, status, checkedAt };
      db.prepare('UPDATE resources SET draft=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(draft), new Date().toISOString(), id);
      const saved = findManagedResource(id)!;
      recordRevision(db, 'resource', id, saved.version, draft, current.username, 'save');
      updated += 1;
    }
    audit(current.username, 'bulk-review', `${updated} resources`);
    return { updated, skipped };
  });
}
