#!/usr/bin/env node
/**
 * 构建产物新鲜度检查：`test:instances` / `test:admin` 跑的是 `dist/`，不是源码。
 *
 * 为什么需要它：如果 `dist/` 落后于 `src/`（改了源码没重新构建），这些测试会对着
 * **旧代码**通过或失败——2026-10-25 复核时就出现过"新增迁移 013 后实例测试超时"，
 * 根因是 dist 里还没有 013。这个脚本只做 stat，不构建、不联网、不写文件。
 *
 *   node scripts/check-dist-freshness.mjs
 *
 * 退出码 0 = dist 不旧于源码；1 = 需要先 `npm run build`。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = join(root, 'dist', 'server', 'entry.mjs');

if (!existsSync(ENTRY)) {
  console.error('dist/server/entry.mjs 不存在：请先运行 npm run build（使用 dist 的测试需要它）');
  process.exit(1);
}

const newest = (directory, extensions) => {
  let latest = { path: null, mtime: 0 };
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      const { mtimeMs } = statSync(path);
      if (mtimeMs > latest.mtime) latest = { path, mtime: mtimeMs };
    }
  };
  walk(directory);
  return latest;
};

const sources = [
  newest(join(root, 'src'), ['.ts', '.astro', '.mjs', '.js', '.css']),
  { path: join(root, 'astro.config.mjs'), mtime: statSync(join(root, 'astro.config.mjs')).mtimeMs },
  { path: join(root, 'package.json'), mtime: statSync(join(root, 'package.json')).mtimeMs },
].filter((entry) => entry.path);

const entryTime = statSync(ENTRY).mtimeMs;
const stale = sources.filter((entry) => entry.mtime > entryTime).sort((a, b) => b.mtime - a.mtime);
if (stale.length > 0) {
  const relative = (path) => path.slice(root.length);
  console.error(JSON.stringify({
    event: 'dist-freshness', status: 'stale',
    message: 'dist/ 落后于源码，使用 dist 的测试会跑到旧代码；请先运行 npm run build',
    newestSource: relative(stale[0].path),
    newestSourceAt: new Date(stale[0].mtime).toISOString(),
    distAt: new Date(entryTime).toISOString(),
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ event: 'dist-freshness', status: 'ok', distAt: new Date(entryTime).toISOString() }));
