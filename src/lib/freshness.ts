import type { Resource } from './resource-schema';

const DAY = 24 * 60 * 60 * 1000;
export const REVIEW_DAYS: Record<Resource['kind'], number> = {
  开源工具: 180,
  免费课程: 180,
  公共资源: 180,
  学生权益: 90,
};

export interface Freshness {
  /** 已核对的到期日；待核对条目没有核对日期 */
  dueAt: Date | null;
  daysSinceCheck: number | null;
  daysUntilDue: number | null;
  /** 超期，或从未完成核对 */
  overdue: boolean;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function freshness(resource: Pick<Resource, 'status' | 'checkedAt' | 'kind'>, today = new Date()): Freshness {
  const checked = parseDate(resource.checkedAt);
  if (resource.status !== 'verified' || !checked) {
    return { dueAt: null, daysSinceCheck: null, daysUntilDue: null, overdue: true };
  }
  const days = REVIEW_DAYS[resource.kind];
  const dueAt = new Date(checked.getTime() + days * DAY);
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return {
    dueAt,
    daysSinceCheck: Math.floor((startOfToday - checked.getTime()) / DAY),
    daysUntilDue: Math.floor((dueAt.getTime() - startOfToday) / DAY),
    overdue: startOfToday > dueAt.getTime(),
  };
}

export function freshnessNote(resource: Pick<Resource, 'status' | 'checkedAt' | 'kind'>, today = new Date()): string {
  const state = freshness(resource, today);
  if (resource.status !== 'verified' || state.daysSinceCheck === null) {
    return '尚未完成官方公开页面核对，使用前请在官方页面确认';
  }
  if (state.overdue) return state.daysSinceCheck === 0 ? '今天核对过，使用前仍请复核' : `资料核对于 ${state.daysSinceCheck} 天前，可能已变化，使用前请复核`;
  return `资料核对于 ${state.daysSinceCheck} 天前`;
}
