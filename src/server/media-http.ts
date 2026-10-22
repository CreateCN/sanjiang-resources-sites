import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { mediaRoot, resolveMediaFile } from './media.ts';

/**
 * `/media/<file>` 的请求处理。
 *
 * 放在中间件而不是 Astro 文件路由里：项目使用 `trailingSlash: 'always'`，
 * `/media/<sha>.webp` 会被当成"没有尾斜杠的页面"而落到 404 页面，带尾斜杠又不符合
 * 资源语义。中间件在任何路由解析之前短路，URL 就能保持规范形式。
 *
 * 每次请求都实时查库（存在、state=ready、未下架）；所有响应（含 404/HEAD）
 * 都是 no-store —— 下架提交后的新请求必须立即被拒绝。
 */
function baseHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex',
    ...extra,
  });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }) });
}

export function isMediaPath(pathname: string): boolean {
  return pathname.startsWith('/media/');
}

export function serveMediaRequest(request: Request): Response {
  const url = new URL(request.url);
  if (url.search) return notFound();
  const name = url.pathname.slice('/media/'.length);
  if (!name || name.includes('/') || name.includes('\\')) return notFound();
  const resolved = resolveMediaFile(name);
  if (!resolved) return notFound();
  const objects = resolve(join(mediaRoot(), 'objects'));
  const file = resolve(join(objects, resolved.id, resolved.file));
  if (!file.startsWith(objects + sep)) return notFound();
  let info;
  try { info = lstatSync(file); } catch { return notFound(); }
  if (!info.isFile() || info.isSymbolicLink()) return notFound();
  const headers = baseHeaders({
    'Content-Type': 'image/webp',
    'Content-Length': String(info.size),
    'Content-Disposition': 'inline',
  });
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: baseHeaders({ Allow: 'GET, HEAD' }) });
  try {
    return new Response(readFileSync(file), { status: 200, headers });
  } catch { return notFound(); }
}
