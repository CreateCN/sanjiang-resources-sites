import { listManagedGuides, listManagedResources, listReports } from '../server/store.ts';
import { freshness } from './freshness.ts';

export interface Notice {
  id: string;
  level: 'info' | 'warning';
  title: string;
  body: string;
  href: string;
  createdAt: string;
}

/** 等待管理员发布的条目：从未发布，或已发布但草稿有新改动。 */
export interface PendingDraft {
  kind: 'resource' | 'guide';
  id: string;
  title: string;
  updatedAt: string;
  isNew: boolean;
}

export interface NoticeBoard {
  newReports: number;
  overdueResources: number;
  processingReports: number;
  pendingDrafts: number;
  count: number;
  items: Notice[];
}

export function pendingDrafts(): PendingDraft[] {
  const resources = listManagedResources()
    .filter((entry) => !entry.published || JSON.stringify(entry.published) !== JSON.stringify(entry.draft))
    .map((entry) => ({ kind: 'resource' as const, id: entry.id, title: entry.draft.title, updatedAt: entry.updatedAt, isNew: !entry.published }));
  const guides = listManagedGuides()
    .filter((entry) => !entry.published || JSON.stringify(entry.published) !== JSON.stringify(entry.draft))
    .map((entry) => ({ kind: 'guide' as const, id: entry.slug, title: entry.draft.title, updatedAt: entry.updatedAt, isNew: !entry.published }));
  return [...resources, ...guides].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** In-app notice board: no email or webhook leaves the server. */
export function noticeBoard(now = new Date()): NoticeBoard {
  const reports = listReports();
  const resources = listManagedResources();
  const newReports = reports.filter((report) => report.status === 'new');
  const processing = reports.filter((report) => report.status === 'processing');
  const overdue = resources.filter((entry) => freshness(entry.draft, now).overdue);
  const pending = pendingDrafts();
  const items: Notice[] = [
    ...(pending.length > 0 ? [{
      id: 'pending-drafts',
      level: 'info' as const,
      title: `${pending.length} 条草稿等待发布`,
      body: pending.slice(0, 5).map((entry) => entry.title).join('、') + (pending.length > 5 ? ' 等' : ''),
      href: '/admin/#pending-drafts',
      createdAt: pending[0]?.updatedAt ?? now.toISOString(),
    }] : []),
    ...newReports.slice(0, 8).map((report) => ({
      id: `report-${report.id}`,
      level: 'warning' as const,
      title: `新反馈：${report.title}`,
      body: `${report.kind}${report.resourceId ? ` · ${report.resourceId}` : ''}，待处理`,
      href: '/admin/reports/',
      createdAt: report.createdAt,
    })),
    ...(overdue.length > 0 ? [{
      id: 'overdue-resources',
      level: 'warning' as const,
      title: `${overdue.length} 条资源需要复核`,
      body: overdue.slice(0, 5).map((entry) => entry.draft.title).join('、') + (overdue.length > 5 ? ' 等' : ''),
      href: '/admin/reviews/',
      createdAt: now.toISOString(),
    }] : []),
  ];
  return {
    newReports: newReports.length,
    overdueResources: overdue.length,
    processingReports: processing.length,
    pendingDrafts: pending.length,
    count: newReports.length + overdue.length + pending.length,
    items,
  };
}
