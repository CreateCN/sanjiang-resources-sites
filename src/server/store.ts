import { randomBytes } from 'node:crypto';
import { ResourceSchema, type Resource } from '../lib/resource-schema.ts';
import { GuideSchema, type Guide } from '../lib/guide-schema.ts';
import { database, transaction } from './db.ts';
import { audit, fail, hashPassword } from './security.ts';
import { requestMemo } from './request-cache.ts';
import { isReservedIdentifier, MAX_IDENTIFIER_LENGTH, RESERVED_IDENTIFIER_MESSAGE } from '../lib/identifiers.ts';
import { assertMediaDependencies } from './media-references.ts';
export type { Resource } from '../lib/resource-schema.ts';
export type { Guide } from '../lib/guide-schema.ts';
export type Role = 'admin' | 'editor';
export interface User { id: number; username: string; role: Role; active: boolean; version: number }
/** uid 是实体的不可复用身份：即使同 ID 被删除后重建，uid 也不会相同。 */
/** 停用状态独立于草稿/发布快照：它决定"公开展示与否"，且必须立即生效。 */
export interface ResourceLifecycle { discontinuedAt: string | null; reason: string; replacedBy: string | null }
export interface ManagedResource { id: string; uid: string; draft: Resource; published: Resource | null; version: number; updatedAt: string; deletedAt: string | null; lifecycle: ResourceLifecycle }
export type RevisionKind = 'resource' | 'guide';
export type RevisionAction = 'save' | 'publish' | 'unpublish' | 'restore';
export interface Revision { id: number; kind: RevisionKind; entityId: string; version: number; data: unknown; actor: string; action: RevisionAction; createdAt: string }
export interface ManagedGuide { slug: string; uid: string; draft: Guide; published: Guide | null; version: number; updatedAt: string; deletedAt: string | null }
export interface Report { id: number; resourceId: string | null; revisionId: number | null; kind: string; title: string; body: string; status: 'new' | 'processing' | 'resolved'; note: string; version: number; createdAt: string; announceTitle: string | null; announceBody: string | null; announcedAt: string | null }
export interface AuditEntry { id: number; actor: string; action: string; target: string; createdAt: string }
type Row = Record<string, unknown>;
function user(row: Row): User { return { id: Number(row.id), username: String(row.username), role: row.role as Role, active: Boolean(row.active), version: Number(row.version ?? 1) }; }
function newUid(): string { return randomBytes(8).toString('hex'); }
/**
 * 新条目的起始版本号：同名条目被彻底删除过就接着墓碑继续编号。
 * 版本号永不复用，是"旧页面不能操作新对象"的最后一道保证（uid 只用于给出更明确的冲突文案）。
 */
function startVersion(db: ReturnType<typeof database>, kind: RevisionKind, id: string): number {
  const row = db.prepare('SELECT version FROM entity_versions WHERE entity_kind=? AND entity_id=?').get(kind, id);
  return row ? Number(row.version) + 1 : 1;
}
function writeVersionTombstone(db: ReturnType<typeof database>, kind: RevisionKind, id: string, version: number): void {
  db.prepare(`INSERT INTO entity_versions (entity_kind,entity_id,version) VALUES (?,?,?)
    ON CONFLICT(entity_kind,entity_id) DO UPDATE SET version=excluded.version`).run(kind, id, version);
}
function managed(row: Row): ManagedResource {
  return { id: String(row.id), uid: row.uid === null || row.uid === undefined ? '' : String(row.uid), draft: JSON.parse(String(row.draft)), published: row.published ? JSON.parse(String(row.published)) : null, version: Number(row.version), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null, lifecycle: lifecycleOf(row) };
}
function lifecycleOf(row: Row): ResourceLifecycle {
  return {
    discontinuedAt: row.discontinued_at ? String(row.discontinued_at) : null,
    reason: row.discontinued_reason ? String(row.discontinued_reason) : '',
    replacedBy: row.replaced_by ? String(row.replaced_by) : null,
  };
}
/** 公开目录只含仍在展示的条目；停用条目仍可通过 findPublishedResource + lifecycle 打开解释页。 */
export function getPublishedResources(): Resource[] {
  return requestMemo('published-resources', () => database().prepare('SELECT published FROM resources WHERE published IS NOT NULL AND deleted_at IS NULL AND discontinued_at IS NULL ORDER BY rowid').all().map((row) => JSON.parse(String(row.published))));
}
/** 含停用条目的公开快照：指南关联、替代资源校验需要看到"已停用但仍有解释页"的条目。 */
export function listPublishedResourcesIncludingDiscontinued(): Resource[] {
  return requestMemo('published-resources-all', () => database().prepare('SELECT published FROM resources WHERE published IS NOT NULL AND deleted_at IS NULL ORDER BY rowid').all().map((row) => JSON.parse(String(row.published))));
}
export function findPublishedResource(id: string): Resource | undefined {
  return requestMemo(`published-resource:${id}`, () => {
    const row = database().prepare('SELECT published FROM resources WHERE id=? AND published IS NOT NULL AND deleted_at IS NULL').get(id);
    return row ? JSON.parse(String(row.published)) : undefined;
  });
}
/** 停用信息：与内容快照无关，永远读当前行。 */
export function findResourceLifecycle(id: string): ResourceLifecycle | undefined {
  const row = database().prepare('SELECT discontinued_at,discontinued_reason,replaced_by FROM resources WHERE id=?').get(id);
  return row ? lifecycleOf(row) : undefined;
}
export function listCategories(): { id: string; name: string }[] {
  return requestMemo('categories', () => database().prepare('SELECT id,name FROM categories ORDER BY rowid').all().map((row) => ({ id: String(row.id), name: String(row.name) })));
}
/** 所有存在的资源 ID（含回收站），供"历史版本关联是否已失效"这类依赖检查使用。 */
export function listAllResourceIds(): string[] {
  return database().prepare('SELECT id FROM resources').all().map((row) => String(row.id));
}
export function listManagedResources(): ManagedResource[] { return database().prepare('SELECT * FROM resources WHERE deleted_at IS NULL ORDER BY updated_at DESC,id').all().map(managed); }
export function listDeletedResources(): ManagedResource[] { return database().prepare('SELECT * FROM resources WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all().map(managed); }
export function findManagedResource(id: string): ManagedResource | undefined {
  const row = database().prepare('SELECT * FROM resources WHERE id=?').get(id); return row ? managed(row) : undefined;
}
export function listUsers(): User[] { return database().prepare('SELECT id,username,role,active,version FROM users ORDER BY id').all().map(user); }
export function listReports(): Report[] {
  return database().prepare('SELECT * FROM reports ORDER BY id DESC').all().map((r) => ({ id: Number(r.id), resourceId: r.resource_id === null ? null : String(r.resource_id), revisionId: r.revision_id === null || r.revision_id === undefined ? null : Number(r.revision_id), kind: String(r.kind), title: String(r.title), body: String(r.body), status: r.status as Report['status'], note: String(r.note), version: Number(r.version ?? 1), createdAt: String(r.created_at), announceTitle: r.announce_title ? String(r.announce_title) : null, announceBody: r.announce_body ? String(r.announce_body) : null, announcedAt: r.announced_at ? String(r.announced_at) : null }));
}
export function listAudit(): AuditEntry[] {
  return database().prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 1000').all().map((r) => ({ id: Number(r.id), actor: String(r.actor), action: String(r.action), target: String(r.target), createdAt: String(r.created_at) }));
}
/** 服务端角色校验的唯一实现；认证状态变更模块也复用它，不另写一份。 */
export function actorUser(actor: User, adminOnly = false): User {
  const row = database().prepare('SELECT id,username,role,active,version FROM users WHERE id=?').get(actor.id);
  if (!row || !row.active) fail(401, '登录已失效，请重新登录');
  const current = user(row);
  if (adminOnly && current.role !== 'admin') fail(403, '此操作仅限管理员');
  return current;
}
/**
 * 认证证明撤销的唯一实现：会话、挑战、恢复码与代次必须一起处理。
 * 任何"只删会话"的局部实现都会让旧挑战在有效期内继续可用。
 */
export function revokeAuthProofs(db: ReturnType<typeof database>, userId: number, options: { recoveryCodes?: boolean } = {}): void {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM login_challenges WHERE user_id=?').run(userId);
  if (options.recoveryCodes) db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(userId);
}

/** auth_version 只增不减：挑战与最终事务都绑定它，旧证明随之失效。 */
export function bumpAuthVersion(db: ReturnType<typeof database>, userId: number): void {
  db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(userId);
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
  // /admin/resources/new/ 是"新建"路由，条目一旦取该 ID 就再也打不开编辑页。
  if (isReservedIdentifier(resource.id)) fail(400, RESERVED_IDENTIFIER_MESSAGE);
  return transaction((db) => {
    const current = actorUser(actor);
    categoryExists(resource.category);
    const previous = findManagedResource(resource.id);
    if (previous?.deletedAt) fail(409, '该资源在回收站中，请先恢复后再编辑');
    // 新增图片引用必须指向可用媒体；仅编辑其它字段时保留原有已下架引用是允许的。
    assertMediaDependencies('resource', resource, previous?.draft ?? null);
    const now = new Date().toISOString();
    if (previous) {
      checkVersion(resource.id, version);
      db.prepare('UPDATE resources SET draft=?,draft_category=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(resource), resource.category, now, resource.id);
    } else {
      if (version !== null) fail(409, '资源已被删除，不能用旧版本重新创建');
      const startAt = startVersion(db, 'resource', resource.id);
      db.prepare('INSERT INTO resources (id,uid,draft,draft_category,version,updated_at) VALUES (?,?,?,?,?,?)').run(resource.id, newUid(), JSON.stringify(resource), resource.category, startAt, now);
    }
    const saved = findManagedResource(resource.id)!;
    recordRevision(db, 'resource', resource.id, saved.version, resource, current.username, 'save');
    audit(current.username, 'save-resource', resource.id);
    return saved;
  });
}
/** 导入预检冻结的实体身份：版本防"被修改"，uid 防"删除后同名重建"。 */
export interface EntityIdentity { version: number; uid: string }
/**
 * 导入单条资源。恢复（若在回收站）与写入草稿必须在同一个事务里完成：
 * 过去两步分开提交，保存失败（例如分类不存在）会留下"已离开回收站"的半截状态。
 * 审计也写在同一事务内：审计失败时条目必须一起回滚，不能出现"内容已提交、审计缺失"。
 */
export function importResource(actor: User, input: unknown, expected: EntityIdentity | null): ManagedResource {
  const parsed = ResourceSchema.safeParse(input);
  if (!parsed.success) fail(400, `资源校验失败：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  const resource = parsed.data;
  if (isReservedIdentifier(resource.id)) fail(400, RESERVED_IDENTIFIER_MESSAGE);
  return transaction((db) => {
    const current = actorUser(actor);
    categoryExists(resource.category);
    const previous = findManagedResource(resource.id);
    assertMediaDependencies('resource', resource, previous?.draft ?? null);
    const now = new Date().toISOString();
    if (!previous) {
      if (expected !== null) fail(409, `资源 ${resource.id} 在预检后已被删除；请重新预检后再导入`);
      const version = startVersion(db, 'resource', resource.id);
      db.prepare('INSERT INTO resources (id,uid,draft,draft_category,version,updated_at) VALUES (?,?,?,?,?,?)').run(resource.id, newUid(), JSON.stringify(resource), resource.category, version, now);
    } else {
      if (expected === null || previous.uid !== expected.uid) fail(409, `资源 ${resource.id} 在预检后已被删除并重建；不能把文件内容写入新条目，请重新预检`);
      if (previous.version !== expected.version) fail(409, `资源 ${resource.id} 已在预检后被修改（预检 v${expected.version}，当前 v${previous.version}）；请重新预检后再导入`);
      if (previous.deletedAt) db.prepare('UPDATE resources SET deleted_at=NULL,version=version+1,updated_at=? WHERE id=?').run(now, resource.id);
      db.prepare('UPDATE resources SET draft=?,draft_category=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(resource), resource.category, now, resource.id);
    }
    const saved = findManagedResource(resource.id)!;
    recordRevision(db, 'resource', resource.id, saved.version, resource, current.username, 'save');
    audit(current.username, 'import-resource', resource.id);
    return saved;
  });
}
export function changePublication(actor: User, id: string, version: number | null, action: 'publish' | 'unpublish' | 'delete-resource'): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    const resource = checkVersion(id, version);
    // 发布是"对外可见"的门槛：此时所有图片必须可用（previous=null 取消旧引用豁免）。
    if (action === 'publish') assertMediaDependencies('resource', resource.draft, null);
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
/**
 * 停用：保留已发布快照与解释页，只从公开目录/搜索/sitemap 移除。
 * 不走草稿-发布两步，因为它不是内容修改：草稿里可能还有没复核的字段，
 * 停用必须立即生效，不能顺手把草稿一起发布出去。
 */
export function discontinueResource(actor: User, id: string, version: number | null, replacedBy: string | null, reason: string): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    const resource = checkVersion(id, version);
    if (!resource.published) fail(409, '该资源尚未发布；未公开的草稿可以直接移入回收站');
    if (resource.lifecycle.discontinuedAt) fail(409, '该资源已经处于停用状态');
    const replacement = replacedBy?.trim() || null;
    if (replacement === id) fail(400, '替代资源不能指向资源本身');
    if (replacement) {
      const row = db.prepare('SELECT published,deleted_at,discontinued_at FROM resources WHERE id=?').get(replacement);
      if (!row || row.published === null || row.deleted_at !== null) fail(400, '替代资源必须是已发布的资源');
      if (row.discontinued_at) fail(400, '替代资源也已停用，请选择仍在展示的资源');
    }
    const clean = reason.trim();
    if (clean.length > 300 || /\u0000/.test(clean)) fail(400, '停用说明最多 300 个字符');
    const now = new Date().toISOString();
    db.prepare('UPDATE resources SET discontinued_at=?,discontinued_reason=?,replaced_by=?,version=version+1,updated_at=? WHERE id=?')
      .run(now, clean, replacement, now, id);
    audit(current.username, 'discontinue-resource', replacement ? `${id} -> ${replacement}` : id);
  });
}
/** 重新展示：清空停用信息，公开快照原样恢复，不需要重新发布。 */
export function reactivateResource(actor: User, id: string, version: number | null): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    const resource = checkVersion(id, version);
    if (!resource.lifecycle.discontinuedAt) fail(409, '该资源未处于停用状态');
    if (!resource.published) fail(409, '该资源没有可恢复的公开版本；请先发布草稿');
    db.prepare("UPDATE resources SET discontinued_at=NULL,discontinued_reason='',replaced_by=NULL,version=version+1,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    audit(current.username, 'reactivate-resource', id);
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
/** 导入创建分类：与分类管理共用同一套授权与同事务审计（只导入分类时也要留痕）。 */
export function createCategoryFromImport(actor: User, id: string, name: string): boolean {
  return transaction((db) => {
    const current = actorUser(actor, true);
    if (db.prepare('SELECT 1 FROM categories WHERE id=?').get(id)) return false;
    db.prepare('INSERT INTO categories (id,name) VALUES (?,?)').run(id, name.trim());
    audit(current.username, 'save-category', id);
    return true;
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
  return { id: Number(result.lastInsertRowid), username, role, active: true, version: 1 };
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
export function updateUser(actor: User, id: number, version: number | null, role: string, active: boolean, password = ''): void {
  const nextRole = roleValue(role);
  const passwordHash = password ? hashPassword(password) : null;
  transaction((db) => {
    const current = actorUser(actor, true);
    const expected = requiredVersion(version);
    const previous = db.prepare('SELECT role,active,version FROM users WHERE id=?').get(id);
    if (!previous) fail(404, '用户不存在');
    if (Number(previous.version) !== expected) fail(409, '该账户已被其他维护者修改；请重新加载人员与权限页面后再提交');
    protectLastAdmin(id, nextRole, active);
    db.prepare('UPDATE users SET role=?,active=?,password_hash=COALESCE(?,password_hash),version=version+1 WHERE id=?')
      .run(nextRole, active ? 1 : 0, passwordHash, id);
    const authChanged = Boolean(passwordHash) || previous.role !== nextRole || Boolean(previous.active) !== active;
    if (authChanged) {
      // 改密、改角色、停用/重新启用都改变凭据代次：旧会话与旧挑战一并失效。
      revokeAuthProofs(db, id);
      bumpAuthVersion(db, id);
    }
    const changes = [`${previous.role}->${nextRole}`, `active ${Number(previous.active)}->${active ? 1 : 0}`, ...(passwordHash ? ['password reset'] : [])];
    audit(current.username, 'update-user', `${id} (${changes.join(', ')})`);
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
/**
 * 反馈处理必须带版本号：多维护者同时处理时，旧表单不能把"已解决 + 备注"改回"处理中"，
 * 也不能静默覆盖别人的内部备注（审计不保存被覆盖的正文，无法靠审计找回）。
 *
 * announcement：undefined = 不动公告；null = 撤下公告；对象 = 发布/更新公告。
 * 公告文案必须由维护者单独填写——反馈正文是匿名的，不能直接透传成公开内容。
 */
export function updateReport(actor: User, id: number, status: string, note: string, revisionId: number | null = null, version: number | null = null, announcement: { title: string; body: string } | null | undefined = undefined): void {
  if (!['new', 'processing', 'resolved'].includes(status) || note.length > 4000) fail(400, '无效反馈状态或备注过长');
  let announceTitle: string | null = null, announceBody: string | null = null;
  if (announcement) {
    if (status !== 'resolved') fail(400, '反馈标记为“已解决”后才能发布公告');
    announceTitle = bounded(announcement.title, '公告标题', 1, 120);
    announceBody = announcement.body.trim();
    if (announceBody.length > 600 || /\u0000/.test(announceBody)) fail(400, '公告说明最多 600 个字符');
  }
  transaction((db) => {
    const current = actorUser(actor);
    const expected = requiredVersion(version);
    const report = db.prepare('SELECT resource_id,version FROM reports WHERE id=?').get(id);
    if (!report) fail(404, '反馈不存在');
    if (Number(report.version) !== expected) fail(409, '这条反馈已被其他维护者处理；请重新加载后再提交，避免覆盖对方的备注');
    if (revisionId !== null) {
      if (!report.resource_id) fail(400, '这条反馈没有关联资源，不能关联修订');
      const revision = db.prepare('SELECT 1 FROM revisions WHERE id=? AND entity_kind=? AND entity_id=?').get(revisionId, 'resource', String(report.resource_id));
      if (!revision) fail(400, '所选修订不属于这条反馈关联的资源');
    }
    db.prepare('UPDATE reports SET status=?,note=?,revision_id=?,version=version+1 WHERE id=?').run(status, note.trim(), revisionId, id);
    if (announcement === undefined) {
      // 调用方不关心公告：只保证“未解决”的反馈不留在前台。
      if (status !== 'resolved') db.prepare('UPDATE reports SET announce_title=NULL,announce_body=NULL,announced_at=NULL WHERE id=?').run(id);
    } else if (announcement === null || status !== 'resolved') {
      db.prepare('UPDATE reports SET announce_title=NULL,announce_body=NULL,announced_at=NULL WHERE id=?').run(id);
    } else {
      // 首次发布保留原始时间；再次编辑只更新文案，不改变公告在列表中的位置。
      db.prepare('UPDATE reports SET announce_title=?,announce_body=?,announced_at=COALESCE(announced_at,?) WHERE id=?')
        .run(announceTitle, announceBody, new Date().toISOString(), id);
    }
    audit(current.username, 'update-report', String(id));
  });
}

export interface Announcement { id: number; title: string; body: string; publishedAt: string; resourceId: string | null; resourceTitle: string | null; resourceRemoved: boolean; kind: string }
/**
 * 前台“处理记录”：只暴露维护者写的公告字段，绝不返回反馈正文与内部备注。
 * 资源链接只在该资源仍有公开快照时输出；撤回/软删除/彻底删除后保留公告正文，
 * 但不把读者送到 404。停用资源仍有解释页，因此继续可链接。
 */
export function listAnnouncements(limit = 20): Announcement[] {
  const rows = database().prepare(`SELECT id,kind,announce_title,announce_body,announced_at,resource_id FROM reports
    WHERE announced_at IS NOT NULL AND announce_title IS NOT NULL ORDER BY announced_at DESC, id DESC LIMIT ?`).all(Math.max(1, Math.min(100, limit)));
  return rows.map((row) => {
    const originalId = row.resource_id === null || row.resource_id === undefined ? null : String(row.resource_id);
    const resource = originalId ? findPublishedResource(originalId) : undefined;
    return {
      id: Number(row.id), kind: String(row.kind), title: String(row.announce_title), body: String(row.announce_body ?? ''),
      publishedAt: String(row.announced_at), resourceId: resource ? originalId : null,
      resourceTitle: resource?.title ?? null, resourceRemoved: Boolean(originalId && !resource),
    };
  });
}

function managedGuide(row: Row): ManagedGuide {
  return { slug: String(row.slug), uid: row.uid === null || row.uid === undefined ? '' : String(row.uid), draft: JSON.parse(String(row.draft)), published: row.published ? JSON.parse(String(row.published)) : null, version: Number(row.version), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null };
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
/**
 * 关联资源的写入规则：不存在的资源直接拒绝；已在回收站的资源只允许保留原有关系。
 * 编辑页会为"回收站中但已关联"的资源渲染勾选框，因此保存时这条关系还在；
 * 反过来，用表单或接口新拉一个回收站资源进指南必须被拒绝。
 */
export function checkGuideResources(db: ReturnType<typeof database>, ids: string[], previous: ManagedGuide | undefined): void {
  const existing = new Set(previous?.draft.resources ?? []);
  for (const id of ids) {
    const row = db.prepare('SELECT deleted_at FROM resources WHERE id=?').get(id);
    if (!row) fail(400, `关联资源不存在：${id}`);
    const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
    if (deleted && !existing.has(id)) fail(400, `关联资源在回收站中：${id}；请先恢复该资源再建立关联`);
  }
}
export function saveGuide(actor: User, input: unknown, version: number | null, dropMissing = false): ManagedGuide {
  const parsed = GuideSchema.safeParse(input);
  if (!parsed.success) fail(400, `指南校验失败：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  const guide = parsed.data;
  if (isReservedIdentifier(guide.slug)) fail(400, RESERVED_IDENTIFIER_MESSAGE);
  return transaction((db) => {
    const current = actorUser(actor);
    const previous = findManagedGuide(guide.slug);
    if (previous?.deletedAt) fail(409, '该指南在回收站中，请先恢复后再编辑');
    assertMediaDependencies('guide', guide, previous?.draft ?? null);
    // 彻底删除过的资源不会出现在编辑页复选框里；如果普通保存直接把它当成“取消勾选”，
    // 关联就会在维护者不知情时消失。必须由调用方显式同意移除。
    const missing = previous
      ? previous.draft.resources.filter((id) => !db.prepare('SELECT 1 FROM resources WHERE id=?').get(id))
      : [];
    if (missing.length > 0 && !dropMissing) {
      fail(409, `当前草稿关联的资源已被彻底删除：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ` 等 ${missing.length} 个` : ''}；请勾选“保存时移除失效关联”后再保存`);
    }
    if (missing.length > 0) guide.resources = guide.resources.filter((id) => !missing.includes(id));
    checkGuideResources(db, guide.resources, previous);
    const now = new Date().toISOString();
    if (previous) {
      guideVersion(guide.slug, version);
      db.prepare('UPDATE guides SET draft=?,version=version+1,updated_at=? WHERE slug=?').run(JSON.stringify(guide), now, guide.slug);
    } else {
      if (version !== null) fail(409, '指南已被删除，不能用旧版本重新创建');
      const startAt = startVersion(db, 'guide', guide.slug);
      db.prepare('INSERT INTO guides (slug,uid,draft,version,updated_at) VALUES (?,?,?,?,?)').run(guide.slug, newUid(), JSON.stringify(guide), startAt, now);
    }
    const saved = findManagedGuide(guide.slug)!;
    recordRevision(db, 'guide', guide.slug, saved.version, guide, current.username, 'save');
    audit(current.username, 'save-guide', missing.length > 0 ? `${guide.slug} (移除失效关联 ${missing.join(',')})` : guide.slug);
    return saved;
  });
}
/** 导入单篇指南：恢复、写入、版本记录与审计同事务；关联资源也在这里统一校验。 */
export function importGuide(actor: User, input: unknown, expected: EntityIdentity | null): ManagedGuide {
  const parsed = GuideSchema.safeParse(input);
  if (!parsed.success) fail(400, `指南校验失败：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  const guide = parsed.data;
  if (isReservedIdentifier(guide.slug)) fail(400, RESERVED_IDENTIFIER_MESSAGE);
  return transaction((db) => {
    const current = actorUser(actor);
    const previous = findManagedGuide(guide.slug);
    assertMediaDependencies('guide', guide, previous?.draft ?? null);
    checkGuideResources(db, guide.resources, previous);
    const now = new Date().toISOString();
    if (!previous) {
      if (expected !== null) fail(409, `指南 ${guide.slug} 在预检后已被删除；请重新预检后再导入`);
      const version = startVersion(db, 'guide', guide.slug);
      db.prepare('INSERT INTO guides (slug,uid,draft,version,updated_at) VALUES (?,?,?,?,?)').run(guide.slug, newUid(), JSON.stringify(guide), version, now);
    } else {
      if (expected === null || previous.uid !== expected.uid) fail(409, `指南 ${guide.slug} 在预检后已被删除并重建；不能把文件内容写入新条目，请重新预检`);
      if (previous.version !== expected.version) fail(409, `指南 ${guide.slug} 已在预检后被修改（预检 v${expected.version}，当前 v${previous.version}）；请重新预检后再导入`);
      if (previous.deletedAt) db.prepare('UPDATE guides SET deleted_at=NULL,version=version+1,updated_at=? WHERE slug=?').run(now, guide.slug);
      db.prepare('UPDATE guides SET draft=?,version=version+1,updated_at=? WHERE slug=?').run(JSON.stringify(guide), now, guide.slug);
    }
    const saved = findManagedGuide(guide.slug)!;
    recordRevision(db, 'guide', guide.slug, saved.version, guide, current.username, 'save');
    audit(current.username, 'import-guide', guide.slug);
    return saved;
  });
}
export function changeGuidePublication(actor: User, slug: string, version: number | null, action: 'publish-guide' | 'unpublish-guide' | 'delete-guide'): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    const guide = guideVersion(slug, version);
    if (action === 'publish-guide') assertMediaDependencies('guide', guide.draft, null);
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
/** Safe lookup used by the reports page so a linked revision outside the recent window is not lost. */
export function findRevisionById(kind: RevisionKind, entityId: string, revisionId: number): Revision | undefined {
  const row = database().prepare('SELECT * FROM revisions WHERE id=? AND entity_kind=? AND entity_id=?').get(revisionId, kind, entityId);
  if (!row) return undefined;
  return {
    id: Number(row.id), kind: row.entity_kind as RevisionKind, entityId: String(row.entity_id),
    version: Number(row.version), data: JSON.parse(String(row.data)), actor: String(row.actor),
    action: row.action as RevisionAction, createdAt: String(row.created_at),
  };
}

/**
 * Restore an old snapshot as the new draft. Publishing stays a separate admin action.
 * `category` lets the caller substitute a category when the historical one has been deleted:
 * 直接写回已删除的分类会触发外键约束，过去表现为通用 500。
 */
export function restoreResourceRevision(actor: User, id: string, revisionId: number, version: number | null, category: string | null = null): ManagedResource {
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
    const fallback = category?.trim() || null;
    if (fallback !== null && !db.prepare('SELECT 1 FROM categories WHERE id=?').get(fallback)) fail(400, '所选分类不存在');
    const target = fallback ?? resource.category;
    if (!db.prepare('SELECT 1 FROM categories WHERE id=?').get(target)) {
      fail(409, `该历史版本使用的分类 ${resource.category} 已删除；请为该版本选择一个现有分类后再恢复，或先恢复该分类`);
    }
    resource.category = target;
    assertMediaDependencies('resource', resource, item.draft);
    db.prepare('UPDATE resources SET draft=?,draft_category=?,version=version+1,updated_at=? WHERE id=?')
      .run(JSON.stringify(resource), resource.category, new Date().toISOString(), id);
    const saved = findManagedResource(id)!;
    recordRevision(db, 'resource', id, saved.version, resource, current.username, 'restore');
    audit(current.username, 'restore-resource', fallback ? `${id} (分类改为 ${fallback})` : id);
    return saved;
  });
}
/** 历史版本里引用了、但资源表里已经不存在的 ID。 */
export function missingGuideResources(ids: string[]): string[] {
  return ids.filter((id) => !database().prepare('SELECT 1 FROM resources WHERE id=?').get(id));
}
/**
 * 恢复指南历史版本。关联资源的处理与普通保存保持一致：
 * 已不存在的资源默认拒绝恢复（返回可操作的 409），只有调用方显式同意移除时才过滤掉。
 */
export function restoreGuideRevision(actor: User, slug: string, revisionId: number, version: number | null, dropMissing = false): ManagedGuide {
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
    const missing = guide.resources.filter((id) => !db.prepare('SELECT 1 FROM resources WHERE id=?').get(id));
    if (missing.length > 0 && !dropMissing) {
      fail(409, `该历史版本关联的资源已不存在：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ` 等 ${missing.length} 个` : ''}；请勾选“恢复时移除失效关联”，或先恢复这些资源`);
    }
    if (missing.length > 0) guide.resources = guide.resources.filter((id) => !missing.includes(id));
    checkGuideResources(db, guide.resources, item);
    assertMediaDependencies('guide', guide, item.draft);
    db.prepare('UPDATE guides SET draft=?,version=version+1,updated_at=? WHERE slug=?')
      .run(JSON.stringify(guide), new Date().toISOString(), slug);
    const saved = findManagedGuide(slug)!;
    recordRevision(db, 'guide', slug, saved.version, guide, current.username, 'restore');
    audit(current.username, 'restore-guide', missing.length > 0 ? `${slug} (移除失效关联 ${missing.join(',')})` : slug);
    return saved;
  });
}

export type MetricName = 'resource_view' | 'guide_view' | 'outbound_click' | 'search_miss';
const METRIC_NAMES: readonly MetricName[] = ['resource_view', 'guide_view', 'outbound_click', 'search_miss'];
const EVENT_RETENTION_DAYS = 90;
/** Upper bound on distinct targets per event per day; new targets beyond it are dropped. */
const EVENT_TARGET_LIMIT = 200;
function utcDay(date: Date): string { return date.toISOString().slice(0, 10); }

/** Only published entities may receive view/click metrics; anything else is ignored. */
export function isMetricTargetAllowed(name: MetricName, target: string): boolean {
  if (name === 'search_miss') return target.trim().length >= 2;
  if (name === 'guide_view') return Boolean(database().prepare('SELECT 1 FROM guides WHERE slug=? AND published IS NOT NULL AND deleted_at IS NULL').get(target));
  return Boolean(database().prepare('SELECT 1 FROM resources WHERE id=? AND published IS NOT NULL AND deleted_at IS NULL').get(target));
}

/**
 * 只有自由文本（零结果搜索）才归一化并截断：它是用户输入的句子，长度不可控。
 * 实体 ID / slug 必须原样保留，否则前 60 字符相同的两个 ID 会被合并计数。
 */
function eventTarget(name: MetricName, target: string): string {
  const cleaned = target.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name === 'search_miss') return cleaned.slice(0, 60);
  return cleaned.length > MAX_IDENTIFIER_LENGTH ? '' : cleaned;
}
/** Privacy-safe counter: only a day, an allow-listed event name and a normalised target. */
export function recordEvent(name: MetricName, target: string): boolean {
  if (!METRIC_NAMES.includes(name)) return false;
  const clean = eventTarget(name, target);
  if (!clean) return false;
  const now = new Date();
  const day = utcDay(now);
  return transaction((db) => {
    const existing = db.prepare('SELECT count FROM events WHERE day=? AND name=? AND target=?').get(day, name, clean);
    if (existing) {
      db.prepare('UPDATE events SET count=count+1 WHERE day=? AND name=? AND target=?').run(day, name, clean);
      return true;
    }
    const distinct = db.prepare('SELECT COUNT(*) AS total FROM events WHERE day=? AND name=?').get(day, name);
    // Bound pollution: once the per-day target budget is spent, only existing
    // targets keep counting, so a flood cannot fill the Top 10 with junk.
    if (Number(distinct?.total ?? 0) >= EVENT_TARGET_LIMIT) return false;
    db.prepare('INSERT INTO events (day,name,target,count) VALUES (?,?,?,1)').run(day, name, clean);
    return true;
  });
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
export interface GuideReference {
  slug: string;
  title: string;
  deleted: boolean;
  /** 引用出现在当前草稿、公开快照，或两者都有。 */
  locations: ('draft' | 'published')[];
}
/** 指南 JSON 里的资源引用；purge 前用它阻止产生不可恢复的悬空关联。 */
export function guideReferencesToResource(id: string): GuideReference[] {
  const rows = database().prepare('SELECT slug,draft,published,deleted_at FROM guides ORDER BY slug').all();
  const references: GuideReference[] = [];
  for (const row of rows) {
    const locations: ('draft' | 'published')[] = [];
    for (const field of ['draft', 'published'] as const) {
      if (!row[field]) continue;
      try {
        const data = JSON.parse(String(row[field]));
        if (Array.isArray(data.resources) && data.resources.includes(id)) locations.push(field);
      } catch { /* a legacy malformed snapshot cannot reference anything reliably */ }
    }
    if (locations.length === 0) continue;
    let title = String(row.slug);
    try { title = String(JSON.parse(String(row.draft)).title ?? title); } catch { /* keep slug */ }
    references.push({ slug: String(row.slug), title, deleted: Boolean(row.deleted_at), locations });
  }
  return references;
}
export function purgeTrashResource(actor: User, id: string): void {
  transaction((db) => {
    const current = actorUser(actor, true);
    const item = deletedResource(id);
    const references = guideReferencesToResource(id);
    if (references.length > 0) {
      const list = references.map((reference) => {
        const where = reference.locations.map((location) => location === 'draft' ? '草稿' : '公开版本').join('、');
        return `${reference.title}（/${reference.slug}，${where}${reference.deleted ? '，指南在回收站' : ''}）`;
      }).join('；');
      fail(409, `不能彻底删除：该资源仍被这些指南引用：${list}。彻底删除不会自动改写指南内容；请先在指南中移除关联（必要时重新发布），再重试`);
    }
    db.prepare('DELETE FROM revisions WHERE entity_kind=? AND entity_id=?').run('resource', id);
    db.prepare('DELETE FROM link_checks WHERE resource_id=?').run(id);
    writeVersionTombstone(db, 'resource', id, item.version);
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
    writeVersionTombstone(db, 'guide', slug, deletedGuide(slug).version);
    db.prepare('DELETE FROM guides WHERE slug=?').run(slug);
    audit(current.username, 'purge-guide', slug);
  });
}
/** 手动检查针对草稿，定时脚本针对公开快照；两种目标的当前值不同，过期条件也不同。 */
export type LinkCheckScope = 'draft' | 'published';
export interface LinkCheck {
  resourceId: string; status: 'ok' | 'warn' | 'broken' | 'error'; statusCode: number | null;
  finalUrl: string | null; message: string; checkedAt: string;
  /** 被检查的 URL、检查时的行版本与检查对象；旧记录可能为 null。 */
  url: string | null; version: number | null; scope: LinkCheckScope;
}
export function saveLinkCheck(
  resourceId: string,
  result: { status: LinkCheck['status']; statusCode: number | null; finalUrl: string | null; message: string },
  target: { url: string; version: number; scope: LinkCheckScope },
): LinkCheck {
  const checkedAt = new Date().toISOString();
  database().prepare(`INSERT INTO link_checks (resource_id,status,status_code,final_url,message,checked_at,url,version,scope) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(resource_id) DO UPDATE SET status=excluded.status,status_code=excluded.status_code,final_url=excluded.final_url,message=excluded.message,checked_at=excluded.checked_at,url=excluded.url,version=excluded.version,scope=excluded.scope`)
    .run(resourceId, result.status, result.statusCode, result.finalUrl, result.message, checkedAt, target.url, target.version, target.scope);
  return { resourceId, ...result, checkedAt, url: target.url, version: target.version, scope: target.scope };
}
export function listLinkChecks(): LinkCheck[] {
  return database().prepare('SELECT * FROM link_checks ORDER BY checked_at DESC').all().map((row) => ({
    resourceId: String(row.resource_id), status: row.status as LinkCheck['status'], statusCode: row.status_code === null ? null : Number(row.status_code),
    finalUrl: row.final_url === null ? null : String(row.final_url), message: String(row.message), checkedAt: String(row.checked_at),
    url: row.url === null || row.url === undefined ? null : String(row.url),
    version: row.version === null || row.version === undefined ? null : Number(row.version),
    scope: row.scope === 'published' ? 'published' : 'draft',
  }));
}
/**
 * 检查结果只在其检查对象仍是当前内容时有效。
 * - 草稿检查：链接或草稿版本变了就过期。
 * - 公开快照检查：只认公开快照本身；公开版本撤回、或重新发布的链接不同都算过期，
 *   保存草稿（版本号变化但快照没变）不算过期——那正是"草稿改了但还没发布"的正常状态。
 */
export function linkCheckStaleReason(check: LinkCheck, resource: { draft: { url: string }; published: { url: string } | null; version: number }): string | null {
  if (check.url === null) return '旧记录没有保存检查目标，请重新检查';
  if (check.scope === 'published') {
    if (!resource.published) return '公开版本已撤回，这条结果不再代表前台内容';
    if (check.url !== resource.published.url) return '公开版本的链接已更换，请重新检查';
    return null;
  }
  if (check.url !== resource.draft.url) return '草稿链接已修改，请重新检查';
  if (check.version !== resource.version) return '检查后草稿又保存过，请重新检查';
  return null;
}

export interface ImportRun { id: number; actor: string; createdAt: string; summary: unknown }
const IMPORT_RUN_KEEP = 20;
/** 导入失败明细需要在重定向后仍然可读，因此落库而不是只放在 URL 参数里。 */
export function saveImportRun(actor: User, summary: unknown): number {
  return transaction((db) => {
    const created = db.prepare('INSERT INTO import_runs (actor,created_at,summary) VALUES (?,?,?)').run(actor.username, new Date().toISOString(), JSON.stringify(summary));
    db.prepare('DELETE FROM import_runs WHERE id NOT IN (SELECT id FROM import_runs ORDER BY id DESC LIMIT ?)').run(IMPORT_RUN_KEEP);
    return Number(created.lastInsertRowid);
  });
}
export function findImportRun(id: number): ImportRun | undefined {
  if (!Number.isSafeInteger(id) || id < 1) return undefined;
  const row = database().prepare('SELECT * FROM import_runs WHERE id=?').get(id);
  if (!row) return undefined;
  let summary: unknown = null;
  try { summary = JSON.parse(String(row.summary)); } catch { summary = null; }
  return { id: Number(row.id), actor: String(row.actor), createdAt: String(row.created_at), summary };
}

export function schemaVersion(): string | null {
  const row = database().prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get();
  return row ? String(row.id) : null;
}
/**
 * 批量复核必须绑定页面上看到的那一版：管理员打开队列后若条目被人改过，
 * 对旧内容的"已核对"不能顺延到新 URL 上，只能跳过并提示重新打开。
 */
export function bulkReviewResources(actor: User, items: { id: string; version: number }[], status: 'verified' | 'review', date: string | null): { updated: number; skipped: string[]; changed: string[] } {
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) fail(400, '请选择 1–200 条资源');
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !Number.isSafeInteger(item.version) || item.version < 1) fail(400, '复核请求缺少页面版本号，请重新加载队列');
  }
  const checkedAt = status === 'verified' ? (date ?? new Date().toISOString().slice(0, 10)) : null;
  if (status === 'verified' && (!checkedAt || !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) || Number.isNaN(Date.parse(checkedAt)))) fail(400, '核对日期无效');
  return transaction((db) => {
    const current = actorUser(actor);
    const skipped: string[] = [];
    const changed: string[] = [];
    let updated = 0;
    for (const { id, version } of items) {
      const item = findManagedResource(id);
      if (!item || item.deletedAt) { skipped.push(id); continue; }
      if (item.version !== version) { changed.push(id); continue; }
      const draft = { ...item.draft, status, checkedAt };
      db.prepare('UPDATE resources SET draft=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(draft), new Date().toISOString(), id);
      const saved = findManagedResource(id)!;
      recordRevision(db, 'resource', id, saved.version, draft, current.username, 'save');
      updated += 1;
    }
    audit(current.username, 'bulk-review', `${updated} resources${changed.length ? `, ${changed.length} skipped (changed)` : ''}`);
    return { updated, skipped, changed };
  });
}
