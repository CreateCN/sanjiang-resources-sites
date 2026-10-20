import type { APIRoute } from 'astro';
import { getPublishedResources } from '../lib/catalog';
import { getPublishedGuides } from '../lib/guides';
import { getCategories } from '../lib/catalog';

export const prerender = false;

export const GET: APIRoute = () => {
  const origin = (process.env.SITE_URL ?? 'http://localhost:4321').replace(/\/$/, '');
  const staticPages = ['/', '/guides/', '/about/', '/feedback/'];
  const entries: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const path of staticPages) {
    entries.push(`  <url><loc>${origin}${path}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${path === '/' ? '1.0' : '0.6'}</priority></url>`);
  }
  for (const category of getCategories().filter((entry) => entry.id !== 'all')) {
    entries.push(`  <url><loc>${origin}/scenarios/${category.id}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  }
  for (const resource of getPublishedResources()) {
    const lastmod = resource.checkedAt ?? today;
    entries.push(`  <url><loc>${origin}/resources/${resource.id}/</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`);
  }
  for (const guide of getPublishedGuides()) {
    entries.push(`  <url><loc>${origin}/guides/${guide.slug}/</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
