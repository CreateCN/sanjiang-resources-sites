import type { APIRoute } from 'astro';
import { healthGet } from '../../server/http.ts';
export const prerender = false;
export const GET: APIRoute = () => healthGet();
