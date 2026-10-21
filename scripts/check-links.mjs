#!/usr/bin/env node
/**
 * 手动/定时链接检查（只记录，不自动下架）。
 *
 *   DATABASE_PATH=./data/site.sqlite node scripts/check-links.mjs [--limit 50] [--delay 500]
 *
 * 适合放到 cron 或 DSH 自动化里每天跑一次。只检查已发布资源，403/429 记为“需人工确认”。
 * 检查对象是公开快照：结果要连同比公开快照一起记录（url + 行版本 + scope='published'），
 * 否则后台会把每次定时检查都判成“过期”，并覆盖掉手动检查的目标信息。
 */
import { findManagedResource, getPublishedResources, listLinkChecks, saveLinkCheck } from '../src/server/store.ts';
import { selectLinkCheckResources } from '../src/lib/linkcheck-queue.ts';
import { closeDatabase } from '../src/server/db.ts';
import { checkResourceLink } from '../src/server/linkcheck.ts';

const limitArg = process.argv.indexOf('--limit');
const delayArg = process.argv.indexOf('--delay');
const limit = limitArg > -1 ? Math.max(1, Number(process.argv[limitArg + 1]) || 50) : 50;
const delayValue = Number(process.argv[delayArg + 1]);
const delay = delayArg > -1 && Number.isFinite(delayValue) ? Math.max(0, delayValue) : 500;
const summary = { checked: 0, ok: 0, warn: 0, broken: 0, error: 0, results: [] };
try {
  const resources = selectLinkCheckResources(getPublishedResources(), listLinkChecks(), limit);
  for (const resource of resources) {
    const result = await checkResourceLink(resource.url);
    const managed = findManagedResource(resource.id);
    saveLinkCheck(resource.id, result, { url: resource.url, version: managed?.version ?? 1, scope: 'published' });
    summary.checked += 1;
    summary[result.status] += 1;
    summary.results.push({ id: resource.id, status: result.status, code: result.statusCode, message: result.message });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.broken > 0 || summary.error > 0) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : '链接检查失败');
  process.exitCode = 1;
} finally { closeDatabase(); }
