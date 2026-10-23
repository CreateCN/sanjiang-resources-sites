import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * 从 dist 中移除默认发行不应分发的历史截图及所有未在清单中的 optimized 文件。
 * 只操作 dist/client，不触碰工作区 public 或数据库 image 字段。
 * 兼容构建 INCLUDE_LEGACY_ASSETS=1 时跳过。
 */
const root = process.cwd();
const includeLegacy = /^(1|true)$/i.test(process.env.INCLUDE_LEGACY_ASSETS ?? '');
const policy = JSON.parse(readFileSync(join(root, 'src/data/release-assets.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'src/data/image-variants.json'), 'utf8'));
const imagesDir = join(root, 'dist/client/images');
const optimizedDir = join(imagesDir, 'optimized');

if (includeLegacy) {
  console.log(JSON.stringify({ status: 'kept', includeLegacy: true }));
  process.exit(0);
}

const allowed = new Set(policy.defaultAllowed);
for (const key of Object.keys(manifest)) {
  if (!allowed.has(key)) throw new Error(`默认 manifest 含未允许素材：${key}；请先运行 npm run images:build`);
}
if (!existsSync(imagesDir)) throw new Error('没有 dist/client/images；请先完成 astro build');

for (const path of policy.legacyUnconfirmed) {
  rmSync(join(imagesDir, path.replace(/^\/images\//u, '')), { force: true });
}
const keepVariants = new Set(Object.values(manifest).flatMap((entry) => entry.variants.map((variant) => basename(variant.src))));
let pruned = 0;
if (existsSync(optimizedDir)) {
  for (const name of readdirSync(optimizedDir)) {
    if (keepVariants.has(name)) continue;
    rmSync(join(optimizedDir, name), { force: true });
    pruned += 1;
  }
}
console.log(JSON.stringify({ status: 'pruned', legacy: policy.legacyUnconfirmed, variants: pruned }));
