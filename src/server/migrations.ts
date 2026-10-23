import type { DatabaseSync } from 'node:sqlite';
import { AUTH_ISSUER_METADATA_KEY, BRANDING_SETTINGS_KEY, LEGACY_AUTH_ISSUER, LEGACY_BRANDING } from '../lib/site-config.ts';

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
  {
    // 停用/替代是"公开可见性"状态，不是内容字段：它必须立即生效，且不能顺手发布草稿里
    // 还没复核的修改。因此单独建列、走独立管理动作，而不是塞进 ResourceSchema。
    // 公告同样单独建列：反馈正文是匿名的，公开文案必须由维护者另写，不能直接透传。
    id: '007-resource-lifecycle-and-report-announcements',
    up: (db) => {
      for (const [column, type] of [
        ['discontinued_at', 'TEXT'],
        ['discontinued_reason', "TEXT NOT NULL DEFAULT ''"],
        ['replaced_by', 'TEXT'],
      ] as const) {
        if (!hasColumn(db, 'resources', column)) db.exec(`ALTER TABLE resources ADD COLUMN ${column} ${type}`);
      }
      for (const column of ['announce_title', 'announce_body', 'announced_at'] as const) {
        if (!hasColumn(db, 'reports', column)) db.exec(`ALTER TABLE reports ADD COLUMN ${column} TEXT`);
      }
      db.exec('CREATE INDEX IF NOT EXISTS resources_replaced_by ON resources(replaced_by)');
      db.exec('CREATE INDEX IF NOT EXISTS reports_announced ON reports(announced_at DESC)');
    },
  },
  {
    // 人员表单是"整行覆盖"：两个管理员同时打开页面时，后提交的旧状态会悄悄撤销
    // 停用/降级。版本号让每次提交只作用于页面上看到的那一版；改密与角色变更仍在
    // 同一事务内撤销该账户的现有会话。
    id: '008-user-version',
    up: (db) => {
      if (!hasColumn(db, 'users', 'version')) db.exec('ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    },
  },
  {
    // 图片上传/媒体库。文件本体在 MEDIA_DIR，这里只登记不可变文件组的账目与状态。
    // 下架（deleted_at）与 purging 是两件事：下架保留文件供历史修订引用，purging 表示
    // 已开始物理删除并拒绝一切新引用。tombstones 让"删除过的摘要"不会被普通上传复活。
    id: '009-media-library',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','purging')),
        bytes INTEGER NOT NULL CHECK(bytes > 0),
        total_bytes INTEGER NOT NULL CHECK(total_bytes > 0),
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        variants TEXT NOT NULL,
        encoding_version TEXT NOT NULL,
        source_name TEXT NOT NULL DEFAULT '',
        uploaded_by TEXT NOT NULL,
        rights TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(rights IN ('confirmed','unconfirmed')),
        credit TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT,
        deleted_reason TEXT NOT NULL DEFAULT ''
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS media_created ON media(created_at DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS media_state ON media(state, deleted_at)');

      db.exec(`CREATE TABLE IF NOT EXISTS media_tombstones (
        id TEXT PRIMARY KEY,
        last_version INTEGER NOT NULL,
        purged_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL
      )`);

      db.exec(`CREATE TABLE IF NOT EXISTS media_operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('upload','purge','reconcile')),
        media_id TEXT,
        phase TEXT NOT NULL,
        reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),
        owner TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failure TEXT NOT NULL DEFAULT ''
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS media_operations_created ON media_operations(created_at DESC)');

      db.exec(`CREATE TABLE IF NOT EXISTS media_store_guard (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        operation_id TEXT,
        updated_at INTEGER NOT NULL
      )`);
      db.exec("INSERT OR IGNORE INTO media_store_guard (id, operation_id, updated_at) VALUES (1, NULL, 0)");
    },
  },
  {
    // 双因素认证。auth_version 是"凭据代次"：挑战与最终事务都绑定它，
    // 改密/改角色/启停因子等动作递增它，使旧挑战与旧会话同时失效。
    // 用户状态只有两种正常形态：secret+confirmed 都为空（未启用）或都有值（已启用）；
    // 只有一半属于异常，登录必须 fail-closed，不能降级为口令登录。
    id: '010-totp-2fa',
    up: (db) => {
      if (!hasColumn(db, 'users', 'auth_version')) db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1');
      if (!hasColumn(db, 'users', 'totp_secret')) db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
      if (!hasColumn(db, 'users', 'totp_confirmed_at')) db.exec('ALTER TABLE users ADD COLUMN totp_confirmed_at TEXT');
      if (!hasColumn(db, 'users', 'totp_last_step')) db.exec('ALTER TABLE users ADD COLUMN totp_last_step INTEGER');
      db.exec("UPDATE users SET auth_version = 1 WHERE auth_version IS NULL OR auth_version < 1");
      db.exec(`CREATE TABLE IF NOT EXISTS login_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        auth_version INTEGER NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('login','enroll')),
        client_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
        pending_secret TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        CHECK(expires_at > created_at),
        CHECK((purpose = 'enroll' AND pending_secret IS NOT NULL)
           OR (purpose = 'login' AND pending_secret IS NULL))
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS login_challenges_user ON login_challenges(user_id)');
      db.exec('CREATE INDEX IF NOT EXISTS login_challenges_expiry ON login_challenges(expires_at)');
      db.exec(`CREATE TABLE IF NOT EXISTS recovery_codes (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        PRIMARY KEY(user_id, code_hash)
      )`);
    },
  },
  {
    // 实例品牌与冻结 issuer。只补缺失键：旧站升级继续显示原品牌，
    // 已在 settings 中存在的值（包括损坏值）一律不覆盖，交给后台显式修复。
    // 新库此时还没有 seeded/业务数据，迁移保持沉默，由初始化流程写入品牌。
    id: '011-instance-configuration',
    up: (db) => {
      const legacy = Boolean(db.prepare("SELECT 1 FROM metadata WHERE key='seeded'").get())
        || Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get())
        || Boolean(db.prepare('SELECT 1 FROM resources LIMIT 1').get());
      if (!legacy) return;
      if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get(BRANDING_SETTINGS_KEY)) {
        db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(BRANDING_SETTINGS_KEY, JSON.stringify(LEGACY_BRANDING));
      }
      if (!db.prepare('SELECT 1 FROM metadata WHERE key=?').get(AUTH_ISSUER_METADATA_KEY)) {
        db.prepare('INSERT INTO metadata (key,value) VALUES (?,?)').run(AUTH_ISSUER_METADATA_KEY, LEGACY_AUTH_ISSUER);
      }
    },
  },
  {
    // 静态赞助位。广告默认关闭；media_id 使用 RESTRICT，避免赞助图片被物理删除后
    // 留下指向空文件的链接。时间区间在服务层规范化为 UTC，数据库只做基本顺序约束。
    id: '012-sponsors',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS sponsors (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        sponsor_name TEXT NOT NULL,
        media_id TEXT REFERENCES media(id) ON DELETE RESTRICT,
        image_alt TEXT NOT NULL DEFAULT '',
        target_url TEXT NOT NULL CHECK(length(target_url) <= 2048),
        placement TEXT NOT NULL CHECK(placement IN ('home-sidebar','catalog-promotion')),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        starts_at TEXT,
        ends_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        CHECK(starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
        CHECK((media_id IS NULL AND image_alt = '') OR (media_id IS NOT NULL AND length(trim(image_alt)) BETWEEN 1 AND 300))
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS sponsors_placement ON sponsors(placement, enabled, starts_at, ends_at)');
    },
  },
];

export class UnknownMigrationError extends Error {
  constructor(ids: string[]) {
    super(`数据库包含当前程序不认识的迁移：${ids.join('、')}。请升级程序或使用对应版本恢复；本次未做任何修改`);
    this.name = 'UnknownMigrationError';
  }
}

/**
 * 兼容检查必须发生在改写、迁移未知库之前。
 * 只要 schema_migrations 里有当前代码不知道的 id，就拒绝继续；三个数据库入口
 * （应用启动、restore-db、restore-site）都经过 applyMigrations，因此共用这一判断。
 */
export function assertKnownMigrations(db: DatabaseSync): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!table) return;
  const known = new Set(migrations.map((migration) => migration.id));
  const unknown = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all()
    .map((row) => String(row.id)).filter((id) => !known.has(id));
  if (unknown.length > 0) throw new UnknownMigrationError(unknown);
}

/**
 * 在给定连接上按序应用未执行的迁移，返回本次应用的 id 列表。
 * 单一实现，供 `src/server/db.ts` 与离线恢复脚本共用：恢复脚本必须在暂存副本上
 * 跑完迁移与认证净化，验证通过后才允许替换目标库。
 */
export function applyMigrations(db: DatabaseSync): string[] {
  assertKnownMigrations(db);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done: string[] = [];
  for (const migration of migrations) {
    // 每个迁移在自己的写事务里重新确认一次：两个进程同时启动时，
    // 后拿到锁的进程必须看到前一个进程刚提交的记录，而不是启动时的快照。
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(migration.id)) {
        db.exec('COMMIT');
        continue;
      }
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, new Date().toISOString());
      db.exec('COMMIT');
      done.push(migration.id);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return done;
}
