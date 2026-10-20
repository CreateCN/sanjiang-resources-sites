import type { APIRoute } from 'astro';
import { reportsPost } from '../../server/http.ts';
export const prerender = false;
export const POST: APIRoute = (context) => reportsPost(context);
