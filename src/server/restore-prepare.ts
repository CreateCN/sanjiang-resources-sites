import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrations.ts';
import { currentStep, WINDOW } from './totp.ts';
import { assertSettingsIntegrity, businessSummary, compareBusinessSummary } from './restore-verify.ts';

/**
 * 恢复前的准备步骤（离线脚本共用）：
 * 1. 在**暂存副本**上补齐迁移，避免恢复出旧 schema；
 * 2. 认证净化：会话 / 挑战 / 恢复码全部作废，auth_version 递增，last_step 抬升；
 * 3. 输出可被调用方核对的计数。
 *
 * 为什么必须共享：DB-only 恢复（restore-db）与站点级恢复（restore-site）如果各写一套，
 * 迟早会出现"一个入口净化了、另一个没有"，旧会话就能从备份里复活。
 */
export interface RestorePurge {
  sessions: number; challenges: number; recoveryCodes: number; migrations: string[];
  lastStepFloor: number;
}

export interface PreparedRestore {
  purge: RestorePurge;
  counts: Record<string, number>;
  schema: string;
  /** 迁移后与净化后的业务摘要；两者必须一致。 */
  business: { digest: string; unchanged: true };
}

const TRACKED_TABLES = [
  'categories', 'resources', 'guides', 'users', 'reports', 'revisions', 'settings', 'media', 'media_tombstones',
  'sponsors', 'sessions', 'login_challenges', 'recovery_codes',
] as const;

function countAll(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of TRACKED_TABLES) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total ?? 0);
  }
  return counts;
}

export function prepareRestoredDatabase(path: string, options: { allowMedia?: boolean } = {}): PreparedRestore {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const migrations = applyMigrations(db);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
    if (!options.allowMedia && tables.has('media')) {
      const media = Number(db.prepare('SELECT COUNT(*) AS total FROM media').get()?.total ?? 0);
      if (media > 0) {
        throw new Error(`该备份包含 ${media} 条媒体登记，必须使用 scripts/restore-site.mjs 做 DB+媒体同批恢复；DB-only 恢复会制造混合批次`);
      }
    }
    // 占位不为空说明备份不是一致性快照（写入者未停止）。
    if (tables.has('media_store_guard')) {
      const holder = db.prepare('SELECT operation_id FROM media_store_guard WHERE id=1').get();
      if (holder?.operation_id) throw new Error('备份中存在未结算的媒体操作占位，不是一致性快照；请先对账并重新备份');
    }

    // 设置/品牌必须在净化前能被当前 Schema 解析；媒体引用是否存在由站点恢复的引用扫描负责。
    assertSettingsIntegrity(db);
    const beforeBusiness = businessSummary(db);

    const lastStepFloor = currentStep() + WINDOW;
    db.exec('BEGIN IMMEDIATE');
    let purge: RestorePurge;
    try {
      const sessions = Number(db.prepare('DELETE FROM sessions').run().changes ?? 0);
      const challenges = Number(db.prepare('DELETE FROM login_challenges').run().changes ?? 0);
      const recoveryCodes = Number(db.prepare('DELETE FROM recovery_codes').run().changes ?? 0);
      db.prepare('UPDATE users SET auth_version = auth_version + 1').run();
      db.prepare(`UPDATE users SET totp_last_step = ?
        WHERE totp_confirmed_at IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < ?)`).run(lastStepFloor, lastStepFloor);
      db.prepare('INSERT INTO audit (actor,action,target,created_at) VALUES (?,?,?,?)')
        .run('cli', 'restore-purge', `sessions=${sessions} challenges=${challenges} recovery=${recoveryCodes}`, new Date().toISOString());
      db.exec('COMMIT');
      purge = { sessions, challenges, recoveryCodes, migrations, lastStepFloor };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => String(row.integrity_check));
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`净化后的数据库完整性检查失败：${integrity.join('；') || '无结果'}`);
    // 认证净化只允许改认证字段与一条 restore-purge 审计；任何业务摘要变化都说明恢复过程不可信。
    const afterBusiness = businessSummary(db);
    const differences = compareBusinessSummary(beforeBusiness, afterBusiness);
    if (differences.length > 0) {
      throw new Error(`认证净化改动了业务数据，已取消恢复：${differences.join('；')}`);
    }
    const counts = countAll(db);
    if (counts.sessions !== 0 || counts.login_challenges !== 0 || counts.recovery_codes !== 0) {
      throw new Error('认证净化未生效（仍存在会话/挑战/恢复码），已取消恢复');
    }
    const schema = String(db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get()?.id ?? '');
    return { purge, counts, schema, business: { digest: beforeBusiness.digest, unchanged: true } };
  } finally {
    db.close();
  }
}

/** 恢复后的计数核对：业务数据必须与备份一致，认证证明必须为空。 */
export function assertRestoreCounts(actual: Record<string, number>, prepared: PreparedRestore, label: string): void {
  for (const table of ['resources', 'guides', 'users', 'reports', 'revisions']) {
    if (Number(actual[table] ?? -1) !== Number(prepared.counts[table])) {
      throw new Error(`${label}的 ${table} 计数与备份不一致（期望 ${prepared.counts[table]}，实际 ${actual[table]}）`);
    }
  }
  for (const table of ['sessions', 'login_challenges', 'recovery_codes']) {
    if (Number(actual[table] ?? 0) !== 0) throw new Error(`${label}仍存在 ${table}，认证净化未生效`);
  }
}
