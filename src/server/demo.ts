import { database, transaction } from './db.ts';
import { audit, fail } from './security.ts';
import type { User } from './store.ts';
import { requestMemo } from './request-cache.ts';
import { INIT_METADATA } from './initialization.ts';

/** Demo 标记只影响提示，不改变内容与发布状态。 */
export function isDemoContent(): boolean {
  return requestMemo('demo-content', () => {
    const row = database().prepare('SELECT value FROM metadata WHERE key=?').get(INIT_METADATA.demo);
    return row ? String(row.value) === '1' : false;
  });
}

/**
 * 退出演示：管理员显式确认后只改标记并写审计。
 * 不改资源正文、不改发布状态、不删除任何示例内容。
 */
export function exitDemoMode(actor: User): void {
  transaction((db) => {
    const row = db.prepare('SELECT role,active FROM users WHERE id=?').get(actor.id);
    if (!row || !row.active) fail(401, '登录已失效，请重新登录');
    if (row.role !== 'admin') fail(403, '此操作仅限管理员');
    db.prepare('INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(INIT_METADATA.demo, '0');
    audit(actor.username, 'exit-demo', INIT_METADATA.demo);
  });
}
