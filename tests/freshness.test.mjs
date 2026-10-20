import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, freshnessNote, REVIEW_DAYS } from '../src/lib/freshness.ts';

const day = (iso) => new Date(`${iso}T12:00:00Z`);

test('已核对条目按资源类型计算到期时间', () => {
  const tool = { status: 'verified', checkedAt: '2026-01-01', kind: '开源工具' };
  assert.equal(freshness(tool, day('2026-06-01')).overdue, false);
  assert.equal(freshness(tool, day('2026-08-01')).overdue, true);
  assert.equal(REVIEW_DAYS['学生权益'], 90);
  const benefit = { status: 'verified', checkedAt: '2026-01-01', kind: '学生权益' };
  assert.equal(freshness(benefit, day('2026-03-15')).overdue, false);
  assert.equal(freshness(benefit, day('2026-04-15')).overdue, true);
});

test('待核对条目立即进入队列', () => {
  const pending = { status: 'review', checkedAt: null, kind: '开源工具' };
  const state = freshness(pending, day('2026-10-20'));
  assert.equal(state.overdue, true);
  assert.equal(state.dueAt, null);
  assert.match(freshnessNote(pending, day('2026-10-20')), /尚未完成/);
});

test('前台文案区分已核对与超期', () => {
  assert.match(freshnessNote({ status: 'verified', checkedAt: '2026-10-01', kind: '开源工具' }, day('2026-10-20')), /资料核对于 19 天前/);
  assert.match(freshnessNote({ status: 'verified', checkedAt: '2025-01-01', kind: '开源工具' }, day('2026-10-20')), /可能已变化，使用前请复核/);
});
