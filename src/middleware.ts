import { defineMiddleware } from 'astro:middleware';
import { logRequest, newRequestId } from './server/log';
export const onRequest = defineMiddleware(async (context, next) => {
  const id = newRequestId();
  const startedAt = process.hrtime.bigint();
  let response: Response;
  try {
    response = await next();
  } catch (error) {
    logRequest({ id, request: context.request, status: 500, startedAt });
    throw error;
  }
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Request-Id', id);
  logRequest({ id, request: context.request, status: response.status, startedAt });
  return response;
});
