import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = () => {
  const origin = (process.env.SITE_URL ?? 'http://localhost:4321').replace(/\/$/, '');
  const body = ['User-agent: *', 'Allow: /', 'Disallow: /admin/', 'Disallow: /api/', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
