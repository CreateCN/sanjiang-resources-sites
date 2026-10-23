import { defineMiddleware } from 'astro:middleware';
import { logRequest, newRequestId } from './server/log';
import { withRequestCache } from './server/request-cache';
import { isMediaPath, serveMediaRequest } from './server/media-http';
import { isSecureSite } from './server/deployment-config';

/**
 * Baseline response headers. The site is server-rendered with inline styles and
 * a couple of inline scripts, so the policy starts as Report-Only: it collects
 * violations without breaking pages, and can be promoted to enforcing once the
 * reports are clean.
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function httpsSite(): boolean {
  // HSTS 与 Cookie Secure 使用同一个权威 origin 判断。
  return isSecureSite();
}

export const onRequest = defineMiddleware(async (context, next) => {
  const id = newRequestId();
  const startedAt = process.hrtime.bigint();
  let response: Response;
  try {
    // `/media/*` 在路由解析前直接处理：trailingSlash=always 会把带扩展名的路径
    // 当成缺尾斜杠的页面路由，导致图片 URL 落到 404 页。
    response = await withRequestCache(() => (isMediaPath(context.url.pathname) ? serveMediaRequest(context.request) : next()));
  } catch (error) {
    logRequest({ id, request: context.request, status: 500, startedAt });
    throw error;
  }
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Request-Id', id);
  response.headers.set('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  if (httpsSite()) response.headers.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  logRequest({ id, request: context.request, status: response.status, startedAt });
  return response;
});
