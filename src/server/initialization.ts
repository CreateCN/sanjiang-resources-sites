import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ResourceSchema } from '../lib/resource-schema.ts';
import { AUTH_ISSUER_METADATA_KEY, BRANDING_SETTINGS_KEY, DEFAULT_BRANDING } from '../lib/site-config.ts';
import { demoCategories, demoFeaturedResourceId, demoResources } from '../data/demo.ts';
import { SYSTEM_CATEGORIES } from '../data/categories.ts';

/**
 * 初始化状态机（任务书 §3.5）。
 *
 * 打开数据库后只会出现四种状态：
 * - initialized：已有完成标记，只迁移；
 * - legacy：旧实例（seeded=1），保留原数据，不灌种子；
 * - new：完全没有业务数据的新库，按 empty/demo 原子初始化；
 * - anomalous：有业务数据但缺标记，拒绝自动写入，必须显式接管。
 *
 * 这个模块只接收显式连接，不导入 db.ts，避免与惰性打开形成循环。
 */

export type InitMode = 'empty' | 'demo';
export type InitState = 'initialized' | 'legacy' | 'new' | 'anomalous';

export const INIT_VERSION = '1';
export const INIT_METADATA = {
  initialized: 'initialized',
  mode: 'init_mode',
  version: 'init_version',
  demo: 'demo_content',
  seeded: 'seeded',
} as const;

export class InitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitializationError';
  }
}

/** 未配置默认 empty；非法值直接失败，不能静默当成空站。 */
export function parseInitMode(raw: string | null | undefined): InitMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'empty';
  if (value === 'empty' || value === 'demo') return value;
  throw new InitializationError('SITE_INIT_MODE 只接受 empty 或 demo');
}

/** 实例名称同时用于品牌与冻结的 TOTP issuer。 */
export function normalizeInstanceName(raw: string | null | undefined): string {
  const name = (raw ?? '').trim() || DEFAULT_BRANDING.name;
  if (name.length > 60) throw new InitializationError('实例名称不能超过 60 个字符');
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new InitializationError('实例名称不能包含控制字符');
  return name;
}

const BUSINESS_TABLES = ['categories', 'resources', 'guides', 'users', 'reports', 'revisions', 'audit', 'settings', 'media', 'events'] as const;

export interface InitInspection {
  state: InitState;
  mode: InitMode | null;
  counts: Record<string, number>;
}

function metadataValue(db: DatabaseSync, key: string): string {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
  return row ? String(row.value) : '';
}

function countBusiness(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_TABLES) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total ?? 0);
  }
  return counts;
}

export function inspectInitialization(db: DatabaseSync): InitInspection {
  const counts = countBusiness(db);
  const modeText = metadataValue(db, INIT_METADATA.mode);
  const mode = modeText === 'empty' || modeText === 'demo' ? modeText : null;
  if (metadataValue(db, INIT_METADATA.initialized) === '1') return { state: 'initialized', mode, counts };
  // 旧程序只写 seeded；升级后保持原状，不能再灌一次种子。
  if (metadataValue(db, INIT_METADATA.seeded) === '1') return { state: 'legacy', mode, counts };
  const any = Object.values(counts).some((count) => count > 0);
  return { state: any ? 'anomalous' : 'new', mode, counts };
}

export function describeCounts(counts: Record<string, number>): string {
  return Object.entries(counts).filter(([, count]) => count > 0).map(([table, count]) => `${table}=${count}`).join('，') || '无业务行';
}

function setMetadata(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

function insertCategories(db: DatabaseSync, mode: InitMode): void {
  const source = mode === 'demo' ? demoCategories : SYSTEM_CATEGORIES;
  const insert = db.prepare('INSERT INTO categories (id,name) VALUES (?,?)');
  for (const category of source) if (category.id !== 'all') insert.run(category.id, category.name);
}

function insertDemoResources(db: DatabaseSync): string[] {
  const insert = db.prepare('INSERT INTO resources (id,uid,draft,published,draft_category,published_category,version,updated_at) VALUES (?,?,?,?,?,?,1,?)');
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (const seed of demoResources) {
    const resource = ResourceSchema.parse(seed);
    const json = JSON.stringify(resource);
    insert.run(resource.id, randomBytes(8).toString('hex'), json, json, resource.category, resource.category, now);
    ids.push(resource.id);
  }
  return ids;
}

function writeBranding(db: DatabaseSync, name: string): void {
  if (db.prepare('SELECT 1 FROM settings WHERE key=?').get(BRANDING_SETTINGS_KEY)) return;
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)')
    .run(BRANDING_SETTINGS_KEY, JSON.stringify({ ...DEFAULT_BRANDING, name, version: 1 }));
}

function writeHomeSettings(db: DatabaseSync, featuredResourceId: string): void {
  if (db.prepare("SELECT 1 FROM settings WHERE key='site'").get()) return;
  db.prepare("INSERT INTO settings (key,value) VALUES ('site',?)").run(JSON.stringify({ featuredResourceId, scenarios: {} }));
}

function markInitialized(db: DatabaseSync, mode: InitMode, name: string): void {
  setMetadata(db, INIT_METADATA.initialized, '1');
  setMetadata(db, INIT_METADATA.mode, mode);
  setMetadata(db, INIT_METADATA.version, INIT_VERSION);
  // 保留旧程序认识的 seeded 标记，防止回退到旧版本时再次灌种子。
  setMetadata(db, INIT_METADATA.seeded, '1');
  setMetadata(db, INIT_METADATA.demo, mode === 'demo' ? '1' : '0');
  if (!db.prepare('SELECT 1 FROM metadata WHERE key=?').get(AUTH_ISSUER_METADATA_KEY)) {
    setMetadata(db, AUTH_ISSUER_METADATA_KEY, name);
  }
}

export interface InitializeOptions {
  mode: InitMode;
  name?: string;
  /** 仅 CLI 显式接管异常库：只补配置与标记，不写示例内容。 */
  adopt?: boolean;
}

export interface InitResult extends InitInspection {
  written: boolean;
  name: string;
}

/** 原子初始化。状态不是 new（或在显式 adopt 下的 anomalous）时不做任何写入。 */
export function initializeDatabase(db: DatabaseSync, options: InitializeOptions): InitResult {
  const name = normalizeInstanceName(options.name);
  db.exec('BEGIN IMMEDIATE');
  try {
    const inspected = inspectInitialization(db);
    if (inspected.state === 'new') {
      insertCategories(db, options.mode);
      if (options.mode === 'demo') insertDemoResources(db);
      writeHomeSettings(db, options.mode === 'demo' ? demoFeaturedResourceId : '');
      writeBranding(db, name);
      markInitialized(db, options.mode, name);
      const result = { ...inspectInitialization(db), written: true, name };
      db.exec('COMMIT');
      return result;
    }
    if (inspected.state === 'anomalous' && options.adopt) {
      // 接管只补缺失配置；分类为空才补 general，绝不清库、不写 Demo。
      // 已有任意分类时保留原集合与名称，不额外插入 general。
      const categoryRow = db.prepare('SELECT COUNT(*) AS total FROM categories').get() as { total: number } | undefined;
      const categoryCount = Number(categoryRow?.total ?? 0);
      if (categoryCount === 0) insertCategories(db, 'empty');
      writeHomeSettings(db, '');
      writeBranding(db, name);
      markInitialized(db, 'empty', name);
      const result = { ...inspectInitialization(db), written: true, name };
      db.exec('COMMIT');
      return result;
    }
    db.exec('COMMIT');
    return { ...inspected, written: false, name };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
