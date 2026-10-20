import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimJob, finishJob, JOB_TIMEOUT_MS, openState, scheduledSlot, scheduleFromEnv, tick } from '../scripts/maintenance.mjs';
import { selectLinkCheckResources } from '../src/lib/linkcheck-queue.ts';

function stateTest(run) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sj-maintenance-'));
    const path = join(dir, 'state.sqlite');
    const db = openState(path);
    try { await run(db, path); }
    finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}
const jobs = scheduleFromEnv({}).slice(0, 2);
const now = Date.parse('2026-10-20T21:00:00Z');

test('默认北京时间每天03点备份、周一04点检查；UTC边界和周边界正确', () => {
  assert.equal(new Date(scheduledSlot(jobs[0], now)).toISOString(), '2026-10-20T19:00:00.000Z');
  assert.equal(new Date(scheduledSlot(jobs[0], Date.parse('2026-10-20T18:59:59Z'))).toISOString(), '2026-10-19T19:00:00.000Z');
  assert.equal(new Date(scheduledSlot(jobs[1], now)).toISOString(), '2026-10-18T20:00:00.000Z');
  assert.equal(new Date(scheduledSlot(jobs[1], Date.parse('2026-10-18T19:59:59Z'))).toISOString(), '2026-10-11T20:00:00.000Z');
  assert.equal(scheduledSlot(jobs[0], Date.parse('2026-10-20T19:00:00Z')), Date.parse('2026-10-20T19:00:00Z'));
});

test('错误时间配置会明确失败', () => {
  for (const raw of ['24', '-1', '1.5', 'abc', '']) assert.throws(() => scheduleFromEnv({ BACKUP_UTC_HOUR: raw }));
  assert.throws(() => scheduleFromEnv({ LINK_CHECK_UTC_DAY: '7' }));
  assert.equal(scheduleFromEnv({ BACKUP_UTC_HOUR: '0' })[0].hour, 0);
});

test('跨连接租约阻止重复执行，失联进程租约到期后可接管', stateTest((db, path) => {
  const other = openState(path);
  try {
    const slot = scheduledSlot(jobs[0], now);
    assert.ok(claimJob(db, 'backup', slot, now));
    assert.equal(claimJob(other, 'backup', slot, now), undefined);
    assert.ok(claimJob(other, 'backup', slot, now + JOB_TIMEOUT_MS + 60001));
  } finally { other.close(); }
}));

test('成功状态持久化，重启不重跑，下一时间段可执行', stateTest(async (db, path) => {
  let runs = 0;
  const execute = async () => { runs++; return 0; };
  await tick(db, jobs, { now: () => now, execute });
  const restarted = openState(path);
  try {
    await tick(restarted, jobs, { now: () => now, execute });
    assert.equal(runs, 2);
    await tick(restarted, jobs, { now: () => now + 86400000, execute });
    assert.equal(runs, 3, '次日只执行每日备份');
    assert.equal(db.prepare("SELECT last_exit FROM jobs WHERE name='backup'").get().last_exit, 0);
  } finally { restarted.close(); }
}));

test('失败15分钟后重试，失败备份不阻止链接检查', stateTest(async (db) => {
  const calls = [];
  const execute = async (job) => { calls.push(job.name); return job.name === 'backup' ? 1 : 0; };
  await tick(db, jobs, { now: () => now, execute });
  assert.deepEqual(calls, ['backup', 'links']);
  await tick(db, jobs, { now: () => now + 1, execute });
  assert.equal(calls.length, 2);
  await tick(db, jobs, { now: () => now + 15 * 60000, execute });
  assert.deepEqual(calls, ['backup', 'links', 'backup']);
}));

test('链接异常退出2记为已完成，不循环重试；备份退出2仍重试', stateTest(async (db) => {
  let runs = 0;
  await tick(db, jobs, { now: () => now, execute: async () => { runs++; return 2; } });
  await tick(db, jobs, { now: () => now + 15 * 60000, execute: async () => { runs++; return 0; } });
  assert.equal(runs, 3);
  assert.equal(db.prepare("SELECT last_exit FROM jobs WHERE name='links'").get().last_exit, 2);
}));

test('过期任务不能覆盖接管者的状态', stateTest((db) => {
  const slot = scheduledSlot(jobs[0], now);
  const oldOwner = claimJob(db, 'backup', slot, now);
  const owner = claimJob(db, 'backup', slot, now + JOB_TIMEOUT_MS + 60001);
  finishJob(db, jobs[0], slot, oldOwner, 0, now + JOB_TIMEOUT_MS + 60002);
  assert.equal(db.prepare("SELECT owner FROM jobs WHERE name='backup'").get().owner, owner);
}));

test('检查队列优先从未检查和最久未检查资源，跨批次不会饿死尾部资源', () => {
  const resources = Array.from({ length: 60 }, (_, i) => ({ id: String(i) }));
  const checks = resources.slice(0, 50).map((r) => ({ resourceId: r.id, checkedAt: '2026-10-20' }));
  checks[0].checkedAt = '2026-01-01';
  const selected = selectLinkCheckResources(resources, checks, 11);
  assert.deepEqual(selected.map((r) => r.id), [...resources.slice(50).map((r) => r.id), '0']);
  assert.equal(resources[0].id, '0', '不改变原始目录顺序');
});
