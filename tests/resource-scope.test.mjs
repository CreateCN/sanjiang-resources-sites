import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ResourceScopeSchema, canonicalScope, projectScope, scopeHint, scopeLabel, scopeShortLabel, UNKNOWN_SCOPE,
} from '../src/lib/resource-scope.ts';
import { ResourceSchema } from '../src/lib/resource-schema.ts';
import { diffFields } from '../src/lib/revision-fields.ts';
import { fixtureResources } from './fixtures/content.ts';

test('scope union：三种形态，缺失投影 unknown，非法值拒绝', () => {
  assert.deepEqual(ResourceScopeSchema.parse({ type: 'unknown' }), { type: 'unknown' });
  assert.deepEqual(ResourceScopeSchema.parse({ type: 'global' }), { type: 'global' });
  assert.deepEqual(ResourceScopeSchema.parse({ type: 'institutions', institutions: [' 甲大学 ', '乙学院'] }), { type: 'institutions', institutions: ['甲大学', '乙学院'] });
  assert.throws(() => ResourceScopeSchema.parse({ type: 'institutions', institutions: [] }), /至少/);
  assert.throws(() => ResourceScopeSchema.parse({ type: 'institutions', institutions: Array.from({ length: 21 }, (_, i) => `机构${i}`) }), /20/);
  assert.throws(() => ResourceScopeSchema.parse({ type: 'institutions', institutions: ['x'.repeat(101)] }), /100/);
  assert.throws(() => ResourceScopeSchema.parse({ type: 'global', institutions: [] }), /unrecognized|Unrecognized/i);
  assert.throws(() => ResourceScopeSchema.parse({ type: 'campus' }), /invalid|Invalid/i);
  assert.deepEqual(projectScope(undefined), UNKNOWN_SCOPE);
  assert.deepEqual(projectScope(null), UNKNOWN_SCOPE);
  assert.deepEqual(projectScope({ type: 'broken' }), UNKNOWN_SCOPE, '读取旧数据时损坏值中性回退');
});

test('institutions 去重且保持顺序；单机构与多机构短标签可读', () => {
  assert.deepEqual(canonicalScope({ type: 'institutions', institutions: ['甲', '乙', '甲'] }), { type: 'institutions', institutions: ['甲', '乙'] });
  assert.deepEqual(canonicalScope({ type: 'global' }), { type: 'global' });
  assert.equal(scopeLabel({ type: 'unknown' }), '适用范围待确认，请查阅资格说明');
  assert.equal(scopeLabel({ type: 'global' }), '通用范围，不面向特定机构');
  assert.equal(scopeLabel({ type: 'institutions', institutions: ['甲大学', '乙学院'] }), '仅限：甲大学、乙学院');
  assert.equal(scopeShortLabel({ type: 'unknown' }), '范围待确认');
  assert.equal(scopeShortLabel({ type: 'global' }), '通用范围');
  assert.equal(scopeShortLabel({ type: 'institutions', institutions: ['甲大学'] }), '限 甲大学');
  assert.equal(scopeShortLabel({ type: 'institutions', institutions: ['甲大学', '乙学院'] }), '限 2 个机构');
  assert.match(scopeHint({ type: 'global' }), /永久免费|地区/);
  assert.match(scopeHint({ type: 'institutions', institutions: ['甲'] }), /提供方核验/);
});

test('历史差异把 scope 显示为可读范围，而不是原始 JSON', () => {
  const changes = diffFields('resource', { scope: { type: 'institutions', institutions: ['甲大学'] } }, { scope: { type: 'unknown' } });
  const scopeChange = changes.find((change) => change.label === '适用范围');
  assert.ok(scopeChange);
  assert.match(scopeChange.before, /待确认/);
  assert.match(scopeChange.after, /仅限：甲大学/);
});

test('ResourceSchema：缺 scope 补 unknown；存在则校验并去重；与 access 独立', () => {
  const legacy = fixtureResources[0];
  const parsed = ResourceSchema.parse(legacy);
  assert.deepEqual(parsed.scope, { type: 'unknown' });
  assert.equal(parsed.access, legacy.access, '补 scope 不能改变 access');
  const deduped = ResourceSchema.parse({ ...legacy, scope: { type: 'institutions', institutions: [' 甲 ', '甲', '乙'] } });
  assert.deepEqual(deduped.scope, { type: 'institutions', institutions: ['甲', '乙'] });
  const student = ResourceSchema.parse({ ...legacy, access: 'student-verification', scope: { type: 'global' } });
  assert.equal(student.access, 'student-verification');
  assert.deepEqual(student.scope, { type: 'global' }, 'access 与 scope 各自独立');
  assert.throws(() => ResourceSchema.parse({ ...legacy, scope: { type: 'institutions', institutions: [] } }), /至少/);
});
