#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, parse } from 'node:path';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputDir = join(root, 'public/images');
const outputDir = join(inputDir, 'optimized');
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const manifest = {};
let originalBytes = 0;
let largestVariantBytes = 0;
for (const file of (await readdir(inputDir)).sort()) {
  if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
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
    const output = await sharp(input).rotate().resize({ width: size, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    await writeFile(join(outputDir, filename), output);
    variants.push({ src: `/images/optimized/${filename}`, width: size });
    if (size === widths.at(-1)) largestVariantBytes += output.length;
  }
  manifest[`/images/${file}`] = { width, height, variants };
  originalBytes += input.length;
}
await writeFile(join(root, 'src/data/image-variants.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ images: Object.keys(manifest).length, originalBytes, largestVariantBytes }));
