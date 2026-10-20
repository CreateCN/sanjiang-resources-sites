import type { APIRoute } from 'astro';
import { getSession } from '../../server/auth';
import { exportPayload } from '../../lib/importer';
export const prerender = false;
export const GET: APIRoute = ({ request }) => {
  const session = getSession(request);
  if (!session) return new Response('请先登录后台', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (session.user.role !== 'admin') return new Response('仅限管理员导出', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const body = JSON.stringify(exportPayload(), null, 2);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="sanjiang-content-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    },
  });
};
