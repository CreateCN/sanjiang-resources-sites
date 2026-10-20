import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import manifest from '../src/data/image-variants.json' with { type: 'json' };

test('所有本地截图均有真实的等比例 WebP，不放大原图且总体明显减小', async () => {
  const { resources } = await import('../src/data/resources.ts');
  let originalBytes = 0;
  let optimizedBytes = 0;
  for (const resource of resources.filter((r) => r.image)) {
    const image = manifest[resource.image];
    assert.ok(image, resource.image);
    const original = await sharp(await readFile(new URL(`../public${resource.image}`, import.meta.url))).metadata();
    assert.equal(image.width, original.width);
    assert.equal(image.height, original.height);
    for (const variant of image.variants) {
      const url = new URL(`../public${variant.src}`, import.meta.url);
      const metadata = await sharp(await readFile(url)).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, variant.width);
      assert.ok(metadata.width <= original.width);
      assert.ok(Math.abs(metadata.height - original.height * metadata.width / original.width) <= 1);
    }
    originalBytes += (await stat(new URL(`../public${resource.image}`, import.meta.url))).size;
    optimizedBytes += (await stat(new URL(`../public${image.variants.at(-1).src}`, import.meta.url))).size;
  }
  assert.ok(optimizedBytes < originalBytes * 0.5, `${optimizedBytes} / ${originalBytes}`);
});
