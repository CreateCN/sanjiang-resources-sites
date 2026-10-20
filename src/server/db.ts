import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { categories, resources } from '../data/resources.ts';
import { ResourceSchema } from '../lib/resource-schema.ts';
import { migrations } from './migrations.ts';
import { clearRequestCache } from './request-cache.ts';

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
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => String(row.id)));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare("SELECT 1 FROM metadata WHERE key = 'seeded'").get()) {
        const categoryInsert = db.prepare('INSERT INTO categories (id,name) VALUES (?,?)');
        for (const category of categories) if (category.id !== 'all') categoryInsert.run(category.id, category.name);
        const insert = db.prepare('INSERT INTO resources (id,draft,published,draft_category,published_category,version,updated_at) VALUES (?,?,?,?,?,1,?)');
        const now = new Date().toISOString();
        for (const seed of resources) {
          const resource = ResourceSchema.parse(seed);
          const json = JSON.stringify(resource);
          insert.run(resource.id, json, json, resource.category, resource.category, now);
        }
        db.prepare("INSERT INTO metadata (key,value) VALUES ('seeded','1')").run();
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
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
