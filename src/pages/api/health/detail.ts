import type { APIRoute } from 'astro';
import { healthDetailGet } from '../../../server/http.ts';

export const prerender = false;

/** 详细诊断（schema / uptime）只对管理员开放；公共探针仍用 /api/health/。 */
export const GET: APIRoute = (context) => healthDetailGet({ request: context.request, clientAddress: context.clientAddress });
