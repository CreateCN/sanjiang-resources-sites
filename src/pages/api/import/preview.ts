import type { APIRoute } from 'astro';
import { getSession, requireCsrf } from '../../../server/auth.ts';
import { previewImport } from '../../../lib/importer.ts';
import { fail, rateLimit, requireOrigin } from '../../../server/security.ts';
import { errorShape, readForm, IMPORT_MAX_BYTES, IMPORT_PREVIEW_USER_MAX, IMPORT_PREVIEW_WINDOW_MS, MANAGE_MAX_BYTES } from '../../../server/http.ts';

export const prerender = false;

const jsonHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Type': 'application/json; charset=utf-8',
};

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: jsonHeaders });
}

/**
 * 导入预检：昂贵操作（5 MiB 请求体 + zod 校验 + 冻结计划），因此：
 *
 * 1. **先授权再读体**（SECURITY-SPEC §5、本地审查 SJ-A-03）：匿名 401、编辑者 403，
 *    两条路径都不碰 `request.body`，也不调用导入解析。
 * 2. 授权通过后立刻按操作者计一次 `import-user` 请求预算（10/小时），在读取大体积
 *    请求体**之前**消费——畸形请求同样计数，避免用畸形体绕过预算。
 * 3. 既有守卫一个不少：Origin、CSRF、流式体积上限、payload 大小、JSON 校验。
 * 4. 错误转换**不在这里另写一份**：状态码、`Retry-After`、非 `HttpError` 的固定文案
 *    与脱敏日志全部走 `http.ts#errorShape()`，与 `/api/manage/` 共用同一实现（§9.3、§10.1）。
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const session = getSession(request);
    if (!session) fail(401, '请先登录后台');
    if (session.user.role !== 'admin') fail(403, '导入仅限管理员');

    requireOrigin(request);
    rateLimit('import-user', session.user.username, IMPORT_PREVIEW_USER_MAX, IMPORT_PREVIEW_WINDOW_MS);

    // 与 /api/manage/ 共用同一套上限：预检能过的体积，提交也必须能过。
    const { form } = await readForm(request, MANAGE_MAX_BYTES);
    requireCsrf(request, String(form.get('csrf') ?? ''));
    const raw = String(form.get('payload') ?? '');
    if (new TextEncoder().encode(raw).length > IMPORT_MAX_BYTES) fail(413, '导入文件过大');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail(400, 'JSON 解析失败'); }
    return json(previewImport(parsed));
  } catch (error) {
    const { status, message, headers } = errorShape(error);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
};
