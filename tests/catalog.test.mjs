import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { demoCategories, demoResources } from '../src/data/demo.ts';
import { SYSTEM_CATEGORIES } from '../src/data/categories.ts';
import { ResourceSchema } from '../src/lib/resource-schema.ts';

test('Demo 资源通过完整 Schema，ID 唯一且分类存在', () => {
  const seen = new Set();
  const categoryIds = new Set(demoCategories.filter((category) => category.id !== 'all').map((category) => category.id));
  for (const candidate of demoResources) {
    const resource = ResourceSchema.parse(candidate);
    assert.ok(!seen.has(resource.id), `重复 ID：${resource.id}`);
    seen.add(resource.id);
    assert.ok(categoryIds.has(resource.category), `${resource.id}: 分类不存在`);
    assert.ok(resource.steps.length >= 1 && resource.steps.length <= 10, '步骤数量由 Schema 约束，不要求固定三条');
    for (const field of ['title', 'summary', 'cost', 'license', 'eligibility', 'caveat']) {
      assert.ok(resource[field].trim(), `${resource.id}: ${field}`);
    }
    for (const url of [resource.url, resource.sourceUrl]) assert.equal(new URL(url).protocol, 'https:');
  }
  assert.deepEqual([...categoryIds], ['general'], 'Demo 只使用综合资源分类');
});

test('Demo 不伪造核验日期、不默认携带截图或媒体', () => {
  for (const resource of demoResources) {
    assert.equal(resource.status, 'review', resource.id);
    assert.equal(resource.checkedAt, null, `${resource.id}: 不能在示例中写入当前核验日期`);
    assert.equal(resource.image, undefined, `${resource.id}: 示例不默认装入授权未确认的截图`);
    assert.equal(resource.imageRights, undefined);
  }
  for (const resource of demoResources.filter((entry) => entry.image)) {
    assert.ok(existsSync(new URL(`../public${resource.image}`, import.meta.url)), resource.image);
    assert.ok(resource.imageAlt);
  }
});

test('系统分类与 Demo 分类分离：新站只有 all + general', () => {
  assert.deepEqual(SYSTEM_CATEGORIES.map((category) => category.id), ['all', 'general']);
  assert.deepEqual(demoCategories.map((category) => category.id), ['all', 'general']);
});

test('Demo 文案保持通用，不带学校或机构专属定位', () => {
  const text = JSON.stringify(demoResources);
  assert.doesNotMatch(text, /三江|三匠|学院|校内/);
  assert.match(text, /演示条目|示例/);
});
