import { randomToken, HttpError, fail, rateLimit, requireOrigin, clientIdentity } from './security.ts';
import { login, logout, requireCsrf, sessionCookie } from './auth.ts';
import { changeGuidePublication, changePublication, createReport, createUser, deleteCategory, findManagedResource, isMetricTargetAllowed, pingDatabase, purgeTrashGuide, purgeTrashResource, recordEvent, restoreGuideRevision, restoreResourceRevision, restoreTrashGuide, restoreTrashResource, saveCategory, saveGuide, saveLinkCheck, saveResource, updateReport, updateUser } from './store.ts';
import { checkResourceLink } from './linkcheck.ts';
import { saveSettings } from './settings.ts';
import { bulkReviewResources, schemaVersion } from './store.ts';
import { applyImport } from '../lib/importer.ts';
import { renderInlineMarkdown, renderMarkdown } from '../lib/markdown.ts';

type Context = { request: Request; clientAddress?: string };
const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ ...privateHeaders, Location: location });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}
function text(form: FormData, field: string): string {
  const values = form.getAll(field);
  if (values.length > 1 || (values.length && typeof values[0] !== 'string')) fail(400, `字段 ${field} 无效`);
  return String(values[0] ?? '');
}
function idNumber(form: FormData): number {
  const value = text(form, 'id');
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400, '无效记录编号');
  return Number(value);
}
function numberField(form: FormData, field: string): number {
  const value = text(form, field);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400, '无效记录编号');
  return Number(value);
}
function versionNumber(form: FormData): number | null {
  const value = text(form, 'version');
  if (!value) return null;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400, '无效版本号');
  return Number(value);
}
async function readForm(request: Request): Promise<FormData> {
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('application/x-www-form-urlencoded') && !type.startsWith('multipart/form-data')) fail(415, '请通过表单提交');
  const limit = 96 * 1024;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) fail(413, '提交内容过大');
  const reader = request.body?.getReader();
  if (!reader) fail(400, '提交内容为空');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) { await reader.cancel(); fail(413, '提交内容过大'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return await new Response(bytes, { headers: { 'Content-Type': type } }).formData(); }
  catch { return fail(400, '无法解析表单内容'); }
}
function escape(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function errorResponse(request: Request, error: unknown, draft?: string): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : '服务暂时不可用，请稍后重试';
  if (!(error instanceof HttpError)) console.error('API operation failed:', error instanceof Error ? error.name : 'UnknownError');
  const headers = new Headers(privateHeaders);
  if (status === 429) {
    const retryAfterMs = error instanceof HttpError ? error.retryAfterMs : undefined;
    headers.set('Retry-After', String(Math.max(1, Math.ceil((retryAfterMs ?? 60_000) / 1000))));
  }
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({ error: message, ...(draft ? { draft } : {}) }), { status, headers });
  }
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>提交未完成</title><main style="max-width:48rem;margin:4rem auto;padding:1rem;font:18px/1.6 system-ui"><h1>提交未完成</h1><p>${escape(message)}</p>${draft ? `<p>未保存的草稿保留如下。请复制备份后返回编辑页面；版本冲突时请与最新版本合并，不要直接覆盖。</p><textarea readonly rows="18" style="width:100%" aria-label="未保存草稿">${escape(draft)}</textarea>` : ''}<p>可使用浏览器返回按钮回到原表单。</p><a href="/admin/">返回后台</a> · <a href="/feedback/">反馈页面</a></main></html>`, { status, headers });
}
/**
 * Client identity for throttling. The deployment contract lives in
 * security.ts#clientIdentity: only a single peer address written by our own
 * proxy is accepted, everything else collapses to a dedicated bucket.
 */
function identity(context: Context): string {
  return clientIdentity(context.request, context.clientAddress);
}

export async function managePost(context: Context): Promise<Response> {
  const request = context.request; let draft: string | undefined;
  try {
    requireOrigin(request);
    const form = await readForm(request);
    const action = text(form, 'action');
    // Preserve the submitted draft even if the session expired while editing.
    // It is never evaluated and is always HTML-escaped on the error page.
    if (action === 'save-resource') draft = text(form, 'resource');
    const session = requireCsrf(request, text(form, 'csrf'));
    switch (action) {
      case 'save-resource': {
        let input: unknown;
        try { input = JSON.parse(draft || ''); } catch { fail(400, '资源 JSON 格式不正确'); }
        const saved = saveResource(session.user, input, versionNumber(form));
        return redirect(`/admin/resources/${encodeURIComponent(saved.id)}/`);
      }
      case 'publish': case 'unpublish': case 'delete-resource': {
        const id = text(form, 'id');
        changePublication(session.user, id, versionNumber(form), action);
        return redirect(action === 'delete-resource' ? '/admin/resources/' : `/admin/resources/${encodeURIComponent(id)}/`);
      }
      case 'save-category': saveCategory(session.user, text(form, 'id'), text(form, 'name')); return redirect('/admin/categories/');
      case 'delete-category': deleteCategory(session.user, text(form, 'id')); return redirect('/admin/categories/');
      case 'create-user': createUser(session.user, text(form, 'username'), text(form, 'password'), text(form, 'role')); return redirect('/admin/users/');
      case 'update-user': {
        const rawActive = text(form, 'active');
        if (!['', '0', '1', 'false', 'true', 'on', 'off'].includes(rawActive)) fail(400, '无效账户状态');
        updateUser(session.user, idNumber(form), text(form, 'role'), ['1', 'true', 'on'].includes(rawActive), text(form, 'password'));
        return redirect('/admin/users/');
      }
      case 'update-report': {
        const rawRevision = text(form, 'revisionId');
        const revisionId = rawRevision ? numberField(form, 'revisionId') : null;
        updateReport(session.user, idNumber(form), text(form, 'status'), text(form, 'note'), revisionId);
        return redirect('/admin/reports/');
      }
      case 'check-link': {
        const id = text(form, 'id');
        // Outbound checks are expensive and reachable by editors: bound them per
        // operator so a loop cannot be turned into an egress amplifier.
        rateLimit('linkcheck-user', session.user.username, 30, 10 * 60 * 1000);
        const resource = findManagedResource(id);
        if (!resource || resource.deletedAt) fail(404, '资源不存在');
        const result = await checkResourceLink(resource.draft.url);
        saveLinkCheck(id, result);
        return redirect(`/admin/resources/${encodeURIComponent(id)}/?checked=${result.status}`);
      }
      case 'save-settings': {
        const scenarios: Record<string, { task: string; detail: string; glyph: string }> = {};
        for (const [key, value] of form.entries()) {
          const match = key.match(/^scenario\.([a-z0-9-]+)\.(task|detail|glyph)$/);
          if (!match || typeof value !== 'string') continue;
          const [, id = '', field = 'task'] = match;
          scenarios[id] ??= { task: '', detail: '', glyph: '' };
          scenarios[id][field as 'task' | 'detail' | 'glyph'] = value;
        }
        saveSettings(session.user, { featuredResourceId: text(form, 'featuredResourceId'), scenarios });
        return redirect('/admin/settings/');
      }
      case 'bulk-review': {
        const ids = form.getAll('ids').filter((value): value is string => typeof value === 'string');
        const status = text(form, 'status');
        if (status !== 'verified' && status !== 'review') fail(400, '无效复核状态');
        bulkReviewResources(session.user, ids, status, status === 'verified' ? (text(form, 'date') || null) : null);
        return redirect('/admin/reviews/');
      }
      case 'import-apply': {
        const raw = text(form, 'payload');
        if (raw.length > 3 * 1024 * 1024) fail(413, '导入文件过大');
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch { fail(400, 'JSON 解析失败'); }
        const result = applyImport(session.user, payload);
        return redirect(`/admin/import/?resources=${result.resources}&guides=${result.guides}&categories=${result.categoriesCreated}&errors=${result.errors.length}`);
      }
      case 'restore-trash-resource': restoreTrashResource(session.user, text(form, 'id')); return redirect('/admin/trash/');
      case 'purge-resource': purgeTrashResource(session.user, text(form, 'id')); return redirect('/admin/trash/');
      case 'restore-trash-guide': restoreTrashGuide(session.user, text(form, 'slug')); return redirect('/admin/trash/');
      case 'purge-guide': purgeTrashGuide(session.user, text(form, 'slug')); return redirect('/admin/trash/');
      case 'save-guide': {
        const guide = {
          slug: text(form, 'slug'),
          title: text(form, 'title'),
          summary: text(form, 'summary'),
          body: text(form, 'body'),
          resources: [...new Set(form.getAll('resources').filter((value): value is string => typeof value === 'string'))],
        };
        saveGuide(session.user, guide, versionNumber(form));
        return redirect(`/admin/guides/${encodeURIComponent(guide.slug)}/`);
      }
      case 'restore-resource': {
        const id = text(form, 'id');
        restoreResourceRevision(session.user, id, numberField(form, 'revision'), versionNumber(form));
        return redirect(`/admin/resources/${encodeURIComponent(id)}/`);
      }
      case 'restore-guide': {
        const slug = text(form, 'slug');
        restoreGuideRevision(session.user, slug, numberField(form, 'revision'), versionNumber(form));
        return redirect(`/admin/guides/${encodeURIComponent(slug)}/`);
      }
      case 'publish-guide': case 'unpublish-guide': case 'delete-guide': {
        const slug = text(form, 'slug');
        changeGuidePublication(session.user, slug, versionNumber(form), action);
        return redirect(action === 'delete-guide' ? '/admin/guides/' : `/admin/guides/${encodeURIComponent(slug)}/`);
      }
      default: fail(400, '未知管理操作');
    }
  } catch (error) { return errorResponse(request, error, draft); }
}
function secureCookie(request: Request): boolean {
  // Secure only when the site is actually served over HTTPS. A self-hosted
  // trial on http://localhost must still be able to keep its session.
  if ((process.env.SITE_URL ?? '').startsWith('https://')) return true;
  try { return new URL(request.url).protocol === 'https:'; } catch { return false; }
}
export async function loginPost(context: Context): Promise<Response> {
  try {
    requireOrigin(context.request);
    const form = await readForm(context.request);
    const token = login(text(form, 'username'), text(form, 'password'), identity(context));
    return redirect('/admin/', sessionCookie(token, false, secureCookie(context.request)));
  } catch (error) { return errorResponse(context.request, error); }
}
export async function logoutPost(context: Context): Promise<Response> {
  try {
    requireOrigin(context.request);
    const form = await readForm(context.request);
    requireCsrf(context.request, text(form, 'csrf'));
    logout(context.request);
    return redirect('/admin/login/', sessionCookie('', true, secureCookie(context.request)));
  } catch (error) { return errorResponse(context.request, error); }
}
export async function reportsPost(context: Context): Promise<Response> {
  try {
    requireOrigin(context.request);
    // Per-client budget keeps one visitor from blocking everyone; the site-wide
    // circuit breaker only trips under a distributed flood.
    rateLimit('reports-client', identity(context), 5, 60 * 60 * 1000);
    rateLimit('reports-site', 'site', 500, 60 * 60 * 1000);
    const form = await readForm(context.request);
    // Return the same opaque receipt for honeypots without storing the submission.
    if (!text(form, 'website').trim()) createReport({ resourceId: text(form, 'resourceId'), kind: text(form, 'kind'), title: text(form, 'title'), body: text(form, 'body') });
    return redirect(`/feedback/?sent=${randomToken()}`);
  } catch (error) { return errorResponse(context.request, error); }
}
export async function previewPost(context: Context): Promise<Response> {
  try {
    requireOrigin(context.request);
    const form = await readForm(context.request);
    requireCsrf(context.request, text(form, 'csrf'));
    const html = text(form, 'mode') === 'inline' ? renderInlineMarkdown(text(form, 'text')) : renderMarkdown(text(form, 'text'));
    return new Response(JSON.stringify({ html }), { headers: { ...privateHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (error) { return errorResponse(context.request, error); }
}
export function healthGet(): Response {
  const healthy = pingDatabase();
  return new Response(JSON.stringify({
    status: healthy ? 'ok' : 'error',
    db: healthy ? 'ok' : 'error',
    schema: healthy ? schemaVersion() : null,
    uptime: Math.round(process.uptime()),
  }), {
    status: healthy ? 200 : 503,
    headers: { ...privateHeaders, 'Content-Type': 'application/json' },
  });
}
const METRIC_NAMES = ['resource_view', 'guide_view', 'outbound_click', 'search_miss'] as const;
export async function eventPost(context: Context): Promise<Response> {
  try {
    const request = context.request;
    const origin = request.headers.get('origin');
    const siteOrigin = process.env.SITE_URL ? new URL(process.env.SITE_URL).origin : new URL(request.url).origin;
    const sameOrigin = origin ? origin === siteOrigin : request.headers.get('sec-fetch-site') === 'same-origin';
    if (!sameOrigin) fail(403, '请求来源验证失败');
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) fail(415, '请使用 JSON 提交');
    const length = Number(request.headers.get('content-length'));
    if (Number.isFinite(length) && length > 2048) fail(413, '提交内容过大');
    const raw = await request.text();
    if (raw.length > 2048) fail(413, '提交内容过大');
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { fail(400, '请求格式不正确'); }
    if (typeof payload !== 'object' || payload === null) fail(400, '请求格式不正确');
    const { name, target } = payload as { name?: unknown; target?: unknown };
    if (typeof name !== 'string' || !METRIC_NAMES.includes(name as typeof METRIC_NAMES[number])) fail(400, '未知事件');
    if (typeof target !== 'string' || target.length > 80) fail(400, '事件目标无效');
    rateLimit('event-client', identity(context), 600, 60 * 60 * 1000);
    rateLimit('event-site', 'site', 20000, 60 * 60 * 1000);
    const metric = name as typeof METRIC_NAMES[number];
    // Targets must reference something that exists and is published. Unknown
    // targets are acknowledged without being stored: no probe oracle, and no
    // junk in the admin Top 10.
    if (!isMetricTargetAllowed(metric, target)) return new Response(null, { status: 204, headers: privateHeaders });
    recordEvent(metric, target);
    return new Response(JSON.stringify({ ok: true }), { headers: { ...privateHeaders, 'Content-Type': 'application/json' } });
  } catch (error) { return errorResponse(context.request, error); }
}
