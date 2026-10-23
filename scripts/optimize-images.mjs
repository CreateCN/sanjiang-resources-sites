#!/usr/bin/env node
/**
 * 生成 srcset 用的 WebP 变体。
 *
 * 关键约束：**不要删除 outputDir**。旧实现每次先 `rm -rf` 再 `mkdir`，而
 * `npm run dev` / `test` / `check` 的 pre* 钩子都会跑这个脚本；只要开发服务器
 * 还开着，目录被删掉再重建就会让它的静态文件索引失效，所有 `/images/optimized/*`
 * 变成 404——浏览器对匹配到 `<source type="image/webp">` 的图片不会回退到 `<img>`，
 * 页面上直接显示裂图。改为原地写入 + 只清理不再被引用的旧文件。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, parse } from 'node:path';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputDir = join(root, 'public/images');
const outputDir = join(inputDir, 'optimized');
const releasePolicy = JSON.parse(await readFile(join(root, 'src/data/release-assets.json'), 'utf8'));
const includeLegacy = /^(1|true)$/i.test(process.env.INCLUDE_LEGACY_ASSETS ?? '');
const legacyFiles = new Set(releasePolicy.legacyUnconfirmed.map((path) => parse(path).base));
await mkdir(outputDir, { recursive: true });
// 文件名是内容哈希：内容没变时文件名不变，可以直接复用磁盘上的文件。
const existing = new Map();
for (const entry of await readdir(outputDir, { withFileTypes: true })) {
  if (entry.isFile()) existing.set(entry.name, (await stat(join(outputDir, entry.name))).size);
}
const manifest = {};
const keep = new Set();
let originalBytes = 0;
let largestVariantBytes = 0;
let written = 0;
let reused = 0;
for (const file of (await readdir(inputDir)).sort()) {
  if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
  // 默认发行排除授权未确认的历史截图及其全部派生图；兼容构建显式选择才生成。
  if (!includeLegacy && legacyFiles.has(file)) continue;
  const input = await readFile(join(inputDir, file));
  const metadata = await sharp(input).rotate().metadata();
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!width || !height) throw new Error(`无法读取图片尺寸：${file}`);
  // Include transform settings in the hash so changing quality invalidates URLs.
  const hash = createHash('sha256').update(input).update('webp-q80-v1').digest('hex').slice(0, 12);
  const widths = [...new Set([320, 640, 960, 1280].map((size) => Math.min(size, width)))].sort((a, b) => a - b);
  const variants = [];
  for (const size of widths) {
    const filename = `${parse(file).name}-${hash}-${size}.webp`;
    const target = join(outputDir, filename);
    const output = await sharp(input).rotate().resize({ width: size, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    keep.add(filename);
    if (existing.get(filename) === output.length) {
      reused++;
    } else {
      // 先写临时文件再改名：正在对外的页面不会读到写了一半的图片。
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, output);
      await rename(temp, target);
      written++;
    }
    variants.push({ src: `/images/optimized/${filename}`, width: size });
    if (size === widths.at(-1)) largestVariantBytes += output.length;
  }
  manifest[`/images/${file}`] = { width, height, variants };
  originalBytes += input.length;
}
// 只删除本次没有生成的残留文件（例如原图改名、尺寸规则变化后的旧哈希）。
let pruned = 0;
for (const name of existing.keys()) {
  if (keep.has(name)) continue;
  await rm(join(outputDir, name), { force: true });
  pruned++;
}
await writeFile(join(root, 'src/data/image-variants.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ images: Object.keys(manifest).length, originalBytes, largestVariantBytes, written, reused, pruned, includeLegacy }));
