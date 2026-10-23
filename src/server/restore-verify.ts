import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BrandingSchema } from '../lib/site-config.ts';
import { SponsorSettingsSchema } from '../lib/sponsor-schema.ts';

/**
 * 恢复核对：业务数据摘要 + 设置完整性。
 *
 * 摘要用于证明"迁移 + 认证净化"没有改动业务内容。允许发生的变化只有：
 * schema_migrations、会话/挑战/恢复码清理、auth_version/totp_last_step 调整、
 * 以及一条 restore-purge 审计；这些字段/行不在摘要口径内。
 */
interface TableSpec {
  table: string;
  order: string;
  columns?: string;
  where?: string;
}

const SPECS: TableSpec[] = [
  { table: 'categories', order: 'id' },
  { table: 'resources', order: 'id' },
  { table: 'guides', order: 'slug' },
  // 认证净化只改这两列，故摘要排除它们；凭据本身仍参与比较。
  { table: 'users', order: 'id', columns: 'id,username,password_hash,role,active,version,totp_secret,totp_confirmed_at' },
  { table: 'reports', order: 'id' },
  { table: 'revisions', order: 'id' },
  { table: 'settings', order: 'key' },
  { table: 'media', order: 'id' },
  { table: 'media_tombstones', order: 'id' },
  { table: 'sponsors', order: 'id' },
  { table: 'audit', order: 'id', where: "WHERE action <> 'restore-purge'" },
];

export interface TableSummary { count: number; digest: string }
export interface BusinessSummary { digest: string; tables: Record<string, TableSummary> }

function existingTables(db: DatabaseSync): Set<string> {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
}

export function businessSummary(db: DatabaseSync): BusinessSummary {
  const present = existingTables(db);
  const tables: Record<string, TableSummary> = {};
  for (const spec of SPECS) {
    if (!present.has(spec.table)) continue;
    const sql = `SELECT ${spec.columns ?? '*'} FROM ${spec.table} ${spec.where ?? ''} ORDER BY ${spec.order}`;
    const rows = db.prepare(sql).all();
    tables[spec.table] = {
      count: rows.length,
      digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return { digest: createHash('sha256').update(JSON.stringify(tables)).digest('hex'), tables };
}

export function compareBusinessSummary(before: BusinessSummary, after: BusinessSummary): string[] {
  const differences: string[] = [];
  const names = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
  for (const name of [...names].sort()) {
    const a = before.tables[name];
    const b = after.tables[name];
    if (!a || !b) { differences.push(`${name} 表在恢复前后缺失或新增`); continue; }
    if (a.count !== b.count) differences.push(`${name} 计数 ${a.count} → ${b.count}`);
    else if (a.digest !== b.digest) differences.push(`${name} 内容摘要变化`);
  }
  return differences;
}

const BRANDING_MEDIA_FIELDS = ['logoMediaId', 'faviconMediaId', 'shareImageMediaId'] as const;

/**
 * 设置完整性：品牌必须能被当前 Schema 解析，引用的媒体登记必须存在；
 * settings 里的已知 JSON 键必须可解析。找不到媒体文件由站点恢复的 bundle 校验负责。
 */
export function assertSettingsIntegrity(db: DatabaseSync): void {
  const read = (key: string): unknown => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!row) return undefined;
    try { return JSON.parse(String(row.value)); } catch {
      throw new Error(`设置 ${key} 不是合法 JSON，备份可能已损坏；未切换目标`);
    }
  };
  const site = read('site');
  if (site !== undefined && (site === null || typeof site !== 'object' || Array.isArray(site))) {
    throw new Error('首页设置 site 结构不正确，备份可能已损坏；未切换目标');
  }
  const sponsorSettings = read('sponsors');
  if (sponsorSettings !== undefined) {
    const parsedSponsor = SponsorSettingsSchema.safeParse(sponsorSettings);
    if (!parsedSponsor.success) {
      throw new Error('赞助总开关设置无法解析，备份可能已损坏；未切换目标');
    }
  }
  const branding = read('branding');
  if (branding === undefined) return;
  const parsed = BrandingSchema.safeParse(branding);
  if (!parsed.success) {
    throw new Error(`品牌设置无法解析（${parsed.error.issues.map((issue) => issue.path.join('.')).join('、')}），备份可能已损坏；未切换目标`);
  }
  const tables = existingTables(db);
  if (!tables.has('media')) return;
  const ids = BRANDING_MEDIA_FIELDS
    .map((field) => (parsed.data[field] ?? null))
    .filter((id): id is string => typeof id === 'string');
  for (const id of new Set(ids)) {
    if (!db.prepare('SELECT 1 FROM media WHERE id=?').get(id)) {
      throw new Error(`品牌设置引用的媒体不存在：/media/${id}.webp；备份可能已损坏，未切换目标`);
    }
  }
}
