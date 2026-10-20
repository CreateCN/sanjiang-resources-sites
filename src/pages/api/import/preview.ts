import type { APIRoute } from 'astro';
import { getSession, requireCsrf } from '../../../server/auth';
import { previewImport } from '../../../lib/importer';
import { fail, HttpError } from '../../../server/security';
export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  try {
    const session = getSession(request);
    if (!session) return new Response(JSON.stringify({ error: '请先登录后台' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const form = await request.formData();
    requireCsrf(request, String(form.get('csrf') ?? ''));
    if (session.user.role !== 'admin') fail(403, '导入仅限管理员');
    const raw = String(form.get('payload') ?? '');
    if (raw.length > 3 * 1024 * 1024) fail(413, '导入文件过大');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail(400, 'JSON 解析失败'); }
    return new Response(JSON.stringify(previewImport(parsed)), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : '预检失败' }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};
