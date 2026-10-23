#!/usr/bin/env node
/**
 * 实例初始化 CLI。
 *
 *   node scripts/init-site.mjs --mode empty|demo [--name "实例名称"] [--adopt]
 *
 * 只用于创建新实例或显式接管异常库；不会清库、不会转换已有实例的模式。
 * 输出只包含状态、模式、名称与行数，不打印密码、密钥或完整环境变量。
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../src/server/migrations.ts';
import {
  describeCounts, InitializationError, initializeDatabase, inspectInitialization, normalizeInstanceName, parseInitMode,
} from '../src/server/initialization.ts';

const USAGE = '用法：npm run site:init -- --mode empty|demo [--name "实例名称"] [--adopt]';
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
function fail(message) {
  console.error(JSON.stringify({ status: 'error', message }));
  process.exitCode = 1;
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const known = new Set(['--mode', '--name', '--adopt', '--help', '-h']);
let argumentError;
for (const [index, arg] of args.entries()) {
  if (arg.startsWith('--') && !known.has(arg)) { argumentError = `未知参数：${arg}`; break; }
  if ((arg === '--mode' || arg === '--name') && (!args[index + 1] || args[index + 1].startsWith('--'))) {
    argumentError = `${arg} 需要一个值`;
    break;
  }
}
const adopt = args.includes('--adopt');
let mode;
let name;
if (!argumentError) {
  try {
    mode = parseInitMode(option('--mode') ?? 'empty');
    name = normalizeInstanceName(option('--name') ?? process.env.SITE_INIT_NAME);
  } catch (error) {
    argumentError = error instanceof Error ? error.message : '初始化参数不正确';
  }
}
if (!argumentError && adopt && mode !== 'empty') argumentError = '显式接管异常库只能配合 --mode empty：接管不会写入任何示例内容';

if (argumentError) {
  fail(argumentError);
} else {
  const databasePath = resolve(process.env.DATABASE_PATH || './data/site.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  try {
    chmodSync(databasePath, 0o600);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    applyMigrations(db);
    const before = inspectInitialization(db);
    if (before.state === 'initialized') {
      if (before.mode && before.mode !== mode) {
        fail(`实例已按 ${before.mode} 模式初始化，不自动转换；需要清库请自行备份后重建`);
      } else {
        console.log(JSON.stringify({ status: 'already-initialized', mode: before.mode ?? mode, name, written: false }));
      }
    } else if (before.state === 'legacy') {
      console.log(JSON.stringify({ status: 'existing-legacy', mode: before.mode, written: false, message: '已有旧实例（seeded），只迁移，不写入' }));
    } else if (before.state === 'anomalous' && !adopt) {
      fail(`检测到业务数据但缺少初始化标记（${describeCounts(before.counts)}）。确认数据归属后可加 --adopt 显式接管；接管只补配置与标记，不写示例内容`);
    } else {
      const result = initializeDatabase(db, { mode, name, adopt });
      console.log(JSON.stringify({
        status: result.written ? 'initialized' : 'already-initialized',
        state: result.state,
        mode: result.mode ?? mode,
        name: result.name,
        written: result.written,
        counts: result.counts,
        database: databasePath,
      }));
    }
  } catch (error) {
    if (error instanceof InitializationError) fail(error.message);
    else fail(error instanceof Error ? error.message : '初始化失败');
  } finally {
    db.close();
  }
}
