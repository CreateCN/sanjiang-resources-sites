#!/usr/bin/env node
/**
 * 一致性备份：VACUUM INTO 生成独立快照，校验完整性，保留最近 N 份。
 *
 *   DATABASE_PATH=./data/site.sqlite BACKUP_DIR=./backups BACKUP_KEEP=7 node scripts/backup-db.mjs
 *
 * 备份包含密码哈希、反馈正文与版本历史，务必存放在仓库之外或加密卷，权限保持 0600。
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const databasePath = resolve(process.env.DATABASE_PATH || './data/site.sqlite');
const backupDir = resolve(process.env.BACKUP_DIR || './backups');
const keep = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP || '7', 10) || 7);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const suffix = Math.random().toString(36).slice(2, 8);
const target = join(backupDir, `site-${stamp}-${suffix}.sqlite`);

if (!existsSync(databasePath)) {
  console.error(`找不到数据库：${databasePath}`);
  process.exit(1);
}
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

const source = new DatabaseSync(databasePath);
try {
  source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  source.close();
}
chmodSync(target, 0o600);

const copy = new DatabaseSync(target);
let counts;
let integrity;
try {
  integrity = String(copy.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown');
  const count = (table) => Number(copy.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total ?? 0);
  counts = {
    resources: count('resources'),
    guides: count('guides'),
    users: count('users'),
    reports: count('reports'),
    revisions: count('revisions'),
  };
} finally {
  copy.close();
}
if (integrity !== 'ok') {
  rmSync(target, { force: true });
  console.error(`备份校验失败：${integrity}`);
  process.exit(1);
}

const backups = readdirSync(backupDir)
  .filter((file) => /^site-.*\.sqlite$/.test(file))
  .map((file) => ({ file, time: statSync(join(backupDir, file)).mtimeMs }))
  .sort((a, b) => b.time - a.time);
for (const stale of backups.slice(keep)) rmSync(join(backupDir, stale.file), { force: true });

console.log(JSON.stringify({ backup: target, bytes: statSync(target).size, integrity, counts, kept: Math.min(backups.length, keep) }, null, 2));
