import type { APIRoute } from 'astro';
import { totpPost } from '../../../server/http.ts';
export const prerender = false;
export const POST: APIRoute = (context) => totpPost(context);
