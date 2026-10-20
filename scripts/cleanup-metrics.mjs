#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { pruneEvents } from '../src/server/store.ts';
import { closeDatabase } from '../src/server/db.ts';

try {
  if (!existsSync(process.env.DATABASE_PATH || './data/site.sqlite')) throw new Error('站点数据库尚未创建');
  console.log(JSON.stringify({ event: 'metrics-cleanup', deleted: pruneEvents(), retentionDays: 90 }));
} catch (error) {
  console.error(error instanceof Error ? error.message : '统计清理失败');
  process.exitCode = 1;
} finally { closeDatabase(); }
