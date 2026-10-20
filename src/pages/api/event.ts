import type { APIRoute } from 'astro';
import { eventPost } from '../../server/http.ts';
export const prerender = false;
export const POST: APIRoute = (context) => eventPost(context);
