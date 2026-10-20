#!/usr/bin/env node
/** Node 24+: DATABASE_PATH=./data/site.sqlite ADMIN_USERNAME=... ADMIN_PASSWORD=... node scripts/create-admin.mjs */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createInitialAdmin } from '../src/server/store.ts';
import { closeDatabase } from '../src/server/db.ts';

async function secret(question) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('非交互环境请通过 ADMIN_USERNAME 和 ADMIN_PASSWORD 提供凭据');
  stdout.write(question);
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    function done(error) {
      stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(value);
    }
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\u0003') { done(new Error('已取消')); return; }
        if (char === '\r' || char === '\n') { done(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
    stdin.on('data', onData);
  });
}
try {
  let username = process.env.ADMIN_USERNAME;
  let password = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('请设置 ADMIN_USERNAME 和 ADMIN_PASSWORD；不会创建默认账户');
    if (!username) {
      const readline = createInterface({ input: stdin, output: stdout });
      try { username = await readline.question('管理员用户名（3–64 位字母/数字/_.-）：'); }
      finally { readline.close(); }
    }
    if (!password) {
      password = await secret('管理员密码（至少 12 字符，输入不回显）：');
      if (password !== await secret('再次输入密码：')) throw new Error('两次密码不一致');
    }
  }
  const created = createInitialAdmin(username, password);
  password = '';
  stdout.write(`已创建管理员 ${created.username}（ID ${created.id}）。\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : '创建管理员失败');
  process.exitCode = 1;
} finally { closeDatabase(); }
