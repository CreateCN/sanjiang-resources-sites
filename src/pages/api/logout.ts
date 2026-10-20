import type { APIRoute } from 'astro';
import { logoutPost } from '../../server/http.ts';
export const prerender = false;
export const POST: APIRoute = (context) => logoutPost(context);
