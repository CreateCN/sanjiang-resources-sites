import { listManagedResources, listReports } from '../server/store.ts';
import { freshness } from './freshness.ts';

export interface Notice {
  id: string;
  level: 'info' | 'warning';
  title: string;
  body: string;
  href: string;
  createdAt: string;
}

export interface NoticeBoard {
  newReports: number;
  overdueResources: number;
  processingReports: number;
  count: number;
  items: Notice[];
}

/** In-app notice board: no email or webhook leaves the server. */
export function noticeBoard(now = new Date()): NoticeBoard {
  const reports = listReports();
  const resources = listManagedResources();
  const newReports = reports.filter((report) => report.status === 'new');
  const processing = reports.filter((report) => report.status === 'processing');
  const overdue = resources.filter((entry) => freshness(entry.draft, now).overdue);
  const items: Notice[] = [
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
  return { newReports: newReports.length, overdueResources: overdue.length, processingReports: processing.length, count: newReports.length + overdue.length, items };
}
