import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openState, claimJob, finishJob } from '../scripts/maintenance.mjs';
import { describeJob, maintenanceStatus } from '../src/server/maintenance-status.ts';
import { scheduleFromEnv, scheduledSlot, nextScheduledSlot } from '../src/lib/maintenance-schedule.ts';
const now = Date.parse('2026-10-20T21:00:00Z');
const jobs = scheduleFromEnv({});

test('显示待执行、运行、重试、超期和链接异常，区分成功与未运行', () => {
  const job = jobs[0];
  const slot = scheduledSlot(job, now);
  assert.equal(describeJob(job, undefined, slot).status, 'never');
  assert.equal(describeJob(job, undefined, now).status, 'overdue');
  assert.equal(describeJob(job, { lease_until: now + 1 }, now).status, 'running');
  assert.equal(describeJob(job, { retry_at: now + 1000 }, now).status, 'retry');
  assert.equal(describeJob(job, { completed_slot: slot, last_exit: 0 }, now).status, 'ok');
  assert.equal(describeJob(jobs[1], { completed_slot: scheduledSlot(jobs[1], now), last_exit: 2 }, now).status, 'attention');
  assert.equal(nextScheduledSlot(jobs[2], now), Date.parse('2026-10-21T18:00:00Z'));
});

test('维护状态读取不创建文件，缺失、损坏和旧状态均可显示', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sj-status-'));
  const path = join(dir, 'state.sqlite');
  const env = { MAINTENANCE_STATE_PATH: path };
  try {
    assert.equal(maintenanceStatus(now, env).worker, 'never');
    assert.equal(existsSync(path), false);
    writeFileSync(path, 'corrupt database');
    assert.equal(maintenanceStatus(now, env).worker, 'unavailable');
    rmSync(path);
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE jobs (name TEXT PRIMARY KEY,completed_slot INTEGER,last_success INTEGER,last_exit INTEGER,retry_at INTEGER,lease_until INTEGER,owner TEXT)');
    old.close();
    assert.equal(maintenanceStatus(now, env).worker, 'never');
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='worker_status'").get(), undefined);
    check.close();
    const upgraded = openState(path);
    assert.ok(upgraded.prepare('PRAGMA table_info(jobs)').all().some((row) => row.name === 'last_started'));
    upgraded.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('任务完成时间、每日清理和维护心跳可读，心跳过期会告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sj-status-heartbeat-'));
  const path = join(dir, 'state.sqlite');
  const db = openState(path);
  try {
    const slot = scheduledSlot(jobs[0], now);
    const owner = claimJob(db, 'backup', slot, now);
    finishJob(db, jobs[0], slot, owner, 0, now + 50);
    db.prepare('INSERT INTO worker_status (id,heartbeat) VALUES (1,?)').run(now);
    const status = maintenanceStatus(now + 60, { MAINTENANCE_STATE_PATH: path });
    assert.equal(status.worker, 'ok');
    assert.equal(status.jobs[0].lastStarted, now);
    assert.equal(status.jobs[0].lastFinished, now + 50);
    assert.equal(status.jobs.length, 3);
    assert.equal(maintenanceStatus(now + 120001, { MAINTENANCE_STATE_PATH: path }).worker, 'stopped');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
