export interface FieldChange {
  label: string;
  before: string;
  after: string;
}

const RESOURCE_LABELS: Record<string, string> = {
  id: '稳定 ID',
  title: '资源名称',
  summary: '用途简介',
  category: '学习场景',
  kind: '资源类型',
  cost: '费用摘要',
  platforms: '支持平台',
  tags: '标签',
  url: '官方链接',
  sourceUrl: '资料来源',
  license: '许可与收费边界',
  eligibility: '资格与身份要求',
  caveat: '限制与注意事项',
  steps: '入门步骤',
  status: '核验状态',
  checkedAt: '核对日期',
  image: '本地图片',
  imageAlt: '图片说明',
  details: '详细说明',
};

const GUIDE_LABELS: Record<string, string> = {
  slug: '链接标识',
  title: '标题',
  summary: '摘要',
  body: '正文',
  resources: '关联资源',
};

const LIMIT = 160;

function toText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）';
  if (Array.isArray(value)) return value.length === 0 ? '（空）' : value.map(String).join(value.length > 3 ? '\n' : '、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function clip(text: string): string {
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}…` : text;
}

/** Compare a stored revision against the current draft; text fields are shown before/after. */
export function diffFields(kind: 'resource' | 'guide', current: unknown, older: unknown): FieldChange[] {
  const labels = kind === 'resource' ? RESOURCE_LABELS : GUIDE_LABELS;
  const left = (current ?? {}) as Record<string, unknown>;
  const right = (older ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const changes: FieldChange[] = [];
  for (const key of keys) {
    const a = left[key];
    const b = right[key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    changes.push({ label: labels[key] ?? key, before: clip(toText(b)), after: clip(toText(a)) });
  }
  return changes;
}

export const ACTION_LABELS: Record<string, string> = {
  save: '保存草稿',
  publish: '发布',
  unpublish: '撤回',
  restore: '恢复历史版本',
};

export function formatRevisionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
