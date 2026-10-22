import type { APIRoute } from 'astro';
import { enrollPost } from '../../../server/http.ts';
export const prerender = false;
export const POST: APIRoute = (context) => enrollPost(context);
