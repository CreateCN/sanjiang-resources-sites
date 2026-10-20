import type { APIRoute } from 'astro';
import { managePost } from '../../server/http.ts';
export const prerender = false;
export const POST: APIRoute = (context) => managePost(context);
