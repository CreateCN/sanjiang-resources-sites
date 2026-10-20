export interface MaintenanceJob { name: string; script: string; hour: number; weekday?: number }
const DAY = 86400000;
export const JOB_TIMEOUT_MS = 15 * 60 * 1000;

export function scheduleFromEnv(env: Record<string, string | undefined> = process.env): MaintenanceJob[] {
  function integer(key: string, fallback: number, max: number): number {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) > max) throw new Error(`${key} 必须为 0–${max} 的整数`);
    return Number(raw);
  }
  return [
    { name: 'backup', script: 'backup-db.mjs', hour: integer('BACKUP_UTC_HOUR', 19, 23) },
    { name: 'links', script: 'check-links.mjs', hour: integer('LINK_CHECK_UTC_HOUR', 20, 23), weekday: integer('LINK_CHECK_UTC_DAY', 0, 6) },
    { name: 'cleanup', script: 'cleanup-metrics.mjs', hour: integer('METRICS_CLEANUP_UTC_HOUR', 18, 23) },
  ];
}

export function scheduledSlot(job: MaintenanceJob, now: number): number {
  const date = new Date(now);
  let slot = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), job.hour);
  if (job.weekday !== undefined) slot -= ((date.getUTCDay() - job.weekday + 7) % 7) * DAY;
  if (slot > now) slot -= job.weekday === undefined ? DAY : 7 * DAY;
  return slot;
}

export function nextScheduledSlot(job: MaintenanceJob, now: number): number {
  return scheduledSlot(job, now) + (job.weekday === undefined ? DAY : 7 * DAY);
}
