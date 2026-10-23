import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyMigrations } from './migrations.ts';
import { clearRequestCache } from './request-cache.ts';
import { InitializationError, describeCounts, initializeDatabase, parseInitMode } from './initialization.ts';

let connection: DatabaseSync | undefined;

/** Lazy opening is important: build/check must never initialize a production database. */
export function database(): DatabaseSync {
  if (connection) return connection;
  const path = process.env.DATABASE_PATH || './data/site.sqlite';
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') chmodSync(path, 0o600);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    applyMigrations(db);
    // 状态机在同一个写事务里完成：新库按 empty/demo 初始化，旧库与已完成实例只迁移。
    // 异常库（有业务数据但缺标记）拒绝自动写入，避免把种子灌进别人的库。
    const mode = parseInitMode(process.env.SITE_INIT_MODE);
    const result = initializeDatabase(db, { mode, name: process.env.SITE_INIT_NAME });
    if (result.state === 'anomalous') {
      throw new InitializationError(`数据库含有业务数据但缺少初始化标记（${describeCounts(result.counts)}）。为避免覆盖，已拒绝自动初始化；请停止应用后运行 npm run site:init -- --mode empty --adopt，或从备份恢复。`);
    }
    connection = db;
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction<T>(operation: (db: DatabaseSync) => T): T {
  const db = database();
  db.exec('BEGIN IMMEDIATE');
  try { const value = operation(db); db.exec('COMMIT'); clearRequestCache(); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Used by isolated tests and clean shutdown tooling. */
export function closeDatabase(): void { connection?.close(); connection = undefined; }
