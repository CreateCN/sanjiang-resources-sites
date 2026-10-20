import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scheduleFromEnv, scheduledSlot, nextScheduledSlot, type MaintenanceJob } from '../lib/maintenance-schedule.ts';

type JobRow = Record<string, unknown>;
export type JobStatus = 'never' | 'running' | 'retry' | 'overdue' | 'ok' | 'attention';
const LABELS: Record<string, string> = { backup: '数据库备份', links: '链接检查', cleanup: '统计清理' };

export function describeJob(job: MaintenanceJob, row: JobRow | undefined, now: number) {
  const completedSlot = Number(row?.completed_slot ?? 0);
  const due = completedSlot < scheduledSlot(job, now);
  let status: JobStatus = 'never';
  if (Number(row?.lease_until ?? 0) > now) status = 'running';
  else if (Number(row?.retry_at ?? 0) > now) status = 'retry';
  else if (due && (row || now - scheduledSlot(job, now) > 15 * 60000)) status = 'overdue';
  else if (row?.last_exit === 2 && job.name === 'links') status = 'attention';
  else if (completedSlot > 0) status = 'ok';
  return {
    name: job.name, label: LABELS[job.name] ?? job.name, status,
    lastSuccess: row?.last_success ? Number(row.last_success) : null,
    lastStarted: row?.last_started ? Number(row.last_started) : null,
    lastFinished: row?.last_finished ? Number(row.last_finished) : null,
    lastExit: row?.last_exit === null || row?.last_exit === undefined ? null : Number(row.last_exit),
    nextRun: status === 'retry' ? Number(row?.retry_at) : nextScheduledSlot(job, now),
  };
}

/** Read-only: visiting the admin page must never create or migrate maintenance state. */
export function maintenanceStatus(now = Date.now(), env: Record<string, string | undefined> = process.env) {
  const jobs = scheduleFromEnv(env);
  const path = env.MAINTENANCE_STATE_PATH || `${resolve(env.DATABASE_PATH || './data/site.sqlite')}.maintenance.sqlite`;
  const empty = { worker: 'never' as const, heartbeat: null, jobs: jobs.map((job) => describeJob(job, undefined, now)) };
  if (!existsSync(path)) return empty;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const heartbeat = tables.has('worker_status') ? Number(db.prepare('SELECT heartbeat FROM worker_status WHERE id=1').get()?.heartbeat ?? 0) : 0;
    const rows = tables.has('jobs') ? db.prepare('SELECT * FROM jobs').all() : [];
    return {
      worker: heartbeat ? (now - heartbeat <= 120000 ? 'ok' : 'stopped') : 'never',
      heartbeat: heartbeat || null,
      jobs: jobs.map((job) => describeJob(job, rows.find((row) => row.name === job.name), now)),
    };
  } catch {
    return { ...empty, worker: 'unavailable' };
  } finally { db?.close(); }
}
