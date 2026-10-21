import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: string;
  up: (db: DatabaseSync) => void;
}

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY, draft TEXT NOT NULL, published TEXT,
    draft_category TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    published_category TEXT REFERENCES categories(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','editor')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY, resource_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','processing','resolved')),
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guides (
    slug TEXT PRIMARY KEY, draft TEXT NOT NULL, published TEXT,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY, entity_kind TEXT NOT NULL CHECK(entity_kind IN ('resource','guide')),
    entity_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('save','publish','unpublish','restore')), created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS revisions_entity ON revisions(entity_kind, entity_id, id DESC);
  CREATE TABLE IF NOT EXISTS events (
    day TEXT NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(day, name, target)
  );
  CREATE INDEX IF NOT EXISTS events_name_day ON events(name, day);
  CREATE TABLE IF NOT EXISTS link_checks (
    resource_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('ok','warn','broken','error')),
    status_code INTEGER, final_url TEXT, message TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

export const migrations: Migration[] = [
  { id: '001-base-schema', up: (db) => { db.exec(BASE_SCHEMA); } },
  {
    id: '002-soft-delete-and-report-revision',
    up: (db) => {
      for (const [table, column, type] of [
        ['resources', 'deleted_at', 'TEXT'],
        ['guides', 'deleted_at', 'TEXT'],
        ['reports', 'revision_id', 'INTEGER'],
      ] as const) {
        if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    },
  },
  {
    id: '003-link-check-target',
    up: (db) => {
      for (const [column, type] of [['url', 'TEXT'], ['version', 'INTEGER']] as const) {
        if (!hasColumn(db, 'link_checks', column)) db.exec(`ALTER TABLE link_checks ADD COLUMN ${column} ${type}`);
      }
    },
  },
  {
    // 手动检查针对草稿，定时脚本针对公开快照；两种目标的过期条件不同，必须分开记录。
    id: '004-link-check-scope',
    up: (db) => {
      if (!hasColumn(db, 'link_checks', 'scope')) db.exec("ALTER TABLE link_checks ADD COLUMN scope TEXT NOT NULL DEFAULT 'draft'");
    },
  },
  {
    // uid：实体的不可复用身份（删除后同名重建也不会相同），供导入预检绑定。
    // reports.version：反馈处理需要并发保护。
    // import_runs：导入结果明细在重定向后仍需可查。
    id: '005-entity-uid-report-version-import-runs',
    up: (db) => {
      for (const table of ['resources', 'guides'] as const) {
        if (!hasColumn(db, table, 'uid')) db.exec(`ALTER TABLE ${table} ADD COLUMN uid TEXT`);
        db.exec(`UPDATE ${table} SET uid = lower(hex(randomblob(8))) WHERE uid IS NULL OR uid = ''`);
      }
      if (!hasColumn(db, 'reports', 'version')) db.exec('ALTER TABLE reports ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
      db.exec(`CREATE TABLE IF NOT EXISTS import_runs (
        id INTEGER PRIMARY KEY, actor TEXT NOT NULL, created_at TEXT NOT NULL, summary TEXT NOT NULL
      )`);
    },
  },
  {
    // 版本号只增不减：purge 时留下墓碑，同名重建的条目从"最后版本 + 1"继续编号，
    // 这样任何只带 version 的旧表单都不可能匹配到新对象上。
    id: '006-entity-version-tombstones',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS entity_versions (
        entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY (entity_kind, entity_id)
      )`);
    },
  },
];
