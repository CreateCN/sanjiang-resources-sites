import type { APIRoute } from 'astro';
import { getSession, requireCsrf } from '../../../server/auth';
import { previewImport } from '../../../lib/importer';
import { fail, HttpError } from '../../../server/security';
import { readForm, MANAGE_MAX_BYTES, IMPORT_MAX_BYTES } from '../../../server/http';
export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  try {
    const session = getSession(request);
    if (!session) return new Response(JSON.stringify({ error: '请先登录后台' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    // 与 /api/manage/ 共用同一套上限：预检能过的体积，提交也必须能过。
    const { form } = await readForm(request, MANAGE_MAX_BYTES);
    requireCsrf(request, String(form.get('csrf') ?? ''));
    if (session.user.role !== 'admin') fail(403, '导入仅限管理员');
    const raw = String(form.get('payload') ?? '');
    if (new TextEncoder().encode(raw).length > IMPORT_MAX_BYTES) fail(413, '导入文件过大');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail(400, 'JSON 解析失败'); }
    return new Response(JSON.stringify(previewImport(parsed)), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : '预检失败' }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};
