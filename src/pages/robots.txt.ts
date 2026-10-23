import type { APIRoute } from 'astro';
import { getSiteOrigin } from '../server/site-config';

export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  const origin = getSiteOrigin(new URL(request.url));
  const body = ['User-agent: *', 'Allow: /', 'Disallow: /admin/', 'Disallow: /api/', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
