#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const DAY = 86400000;
export const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;

export function scheduleFromEnv(env = process.env) {
  function integer(key, fallback, max) {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) > max) throw new Error(`${key} 必须为 0–${max} 的整数`);
    return Number(raw);
  }
  return [
    { name: 'backup', script: 'backup-db.mjs', hour: integer('BACKUP_UTC_HOUR', 19, 23) },
    { name: 'links', script: 'check-links.mjs', hour: integer('LINK_CHECK_UTC_HOUR', 20, 23), weekday: integer('LINK_CHECK_UTC_DAY', 0, 6) },
  ];
}

/** Most recent UTC schedule slot; restarts catch up once rather than replaying every missed day. */
export function scheduledSlot(job, now) {
  const date = new Date(now);
  let slot = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), job.hour);
  if (job.weekday !== undefined) slot -= ((date.getUTCDay() - job.weekday + 7) % 7) * DAY;
  if (slot > now) slot -= job.weekday === undefined ? DAY : 7 * DAY;
  return slot;
}

export function openState(path) {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS jobs (
      name TEXT PRIMARY KEY, completed_slot INTEGER NOT NULL DEFAULT 0,
      last_success INTEGER, last_exit INTEGER, retry_at INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0, owner TEXT
    )`);
  return db;
}

/** Atomic lease also prevents overlap if two maintenance processes are accidentally started. */
export function claimJob(db, name, slot, now) {
  const owner = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO jobs (name) VALUES (?)').run(name);
    const result = db.prepare(`UPDATE jobs SET owner=?,lease_until=?
      WHERE name=? AND completed_slot<? AND retry_at<=? AND lease_until<=?`)
      .run(owner, now + JOB_TIMEOUT_MS + 60000, name, slot, now, now);
    db.exec('COMMIT');
    return result.changes ? owner : undefined;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function finishJob(db, job, slot, owner, code, now) {
  // Exit 2 means the check ran successfully but found links requiring attention.
  const completed = code === 0 || (job.name === 'links' && code === 2);
  db.prepare(`UPDATE jobs SET completed_slot=CASE WHEN ? THEN ? ELSE completed_slot END,
    last_success=CASE WHEN ? THEN ? ELSE last_success END,last_exit=?,retry_at=?,lease_until=0,owner=NULL
    WHERE name=? AND owner=?`)
    .run(Number(completed), slot, Number(completed), now, code, completed ? 0 : now + RETRY_MS, job.name, owner);
  return completed;
}

export function executeJob(job, signal) {
  return new Promise((resolveCode) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(job.script, import.meta.url))], {
      cwd: root, env: process.env, stdio: 'inherit', signal,
      timeout: JOB_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
    child.on('error', () => resolveCode(1));
    child.on('close', (code) => resolveCode(code ?? 1));
  });
}

export async function tick(db, jobs, { now = Date.now, execute = executeJob, signal } = {}) {
  for (const job of jobs) {
    if (signal?.aborted) break;
    const started = now();
    const slot = scheduledSlot(job, started);
    const owner = claimJob(db, job.name, slot, started);
    if (!owner) continue;
    console.log(JSON.stringify({ event: 'maintenance-start', job: job.name, slot: new Date(slot).toISOString() }));
    let code = 1;
    try { code = await execute(job, signal); }
    catch (error) { console.error(JSON.stringify({ event: 'maintenance-error', job: job.name, message: String(error) })); }
    const completed = finishJob(db, job, slot, owner, code, now());
    console.log(JSON.stringify({ event: 'maintenance-finish', job: job.name, code, status: completed ? (code === 2 ? 'attention' : 'ok') : 'retry', durationMs: now() - started }));
  }
}

async function main() {
  const jobs = scheduleFromEnv();
  const path = resolve(process.env.DATABASE_PATH || './data/site.sqlite');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  const state = openState(process.env.MAINTENANCE_STATE_PATH || `${path}.maintenance.sqlite`);
  console.log(JSON.stringify({ event: 'maintenance-ready', jobs, state: process.env.MAINTENANCE_STATE_PATH || `${path}.maintenance.sqlite` }));
  try {
    while (!controller.signal.aborted) {
      // Never initialize/seed a missing production database merely to run a scheduled job.
      if (existsSync(path)) await tick(state, jobs, { signal: controller.signal });
      await sleep(30000, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { state.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
