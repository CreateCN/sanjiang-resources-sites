import { defineMiddleware } from 'astro:middleware';
import { logRequest, newRequestId } from './server/log';
import { withRequestCache } from './server/request-cache';

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
  return (process.env.SITE_URL ?? '').startsWith('https://');
}

export const onRequest = defineMiddleware(async (context, next) => {
  const id = newRequestId();
  const startedAt = process.hrtime.bigint();
  let response: Response;
  try {
    response = await withRequestCache(() => next());
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
