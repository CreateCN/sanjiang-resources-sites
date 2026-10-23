import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fixtureResources, seedFixture } from './fixtures/content.ts';

test('维护进程实际执行备份与检查，记录结果并正常关闭', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sj-maintenance-e2e-'));
  const path = join(dir, 'site.sqlite');
  const backupDir = join(dir, 'backups');
  let worker;
  try {
    const env = { ...process.env, DATABASE_PATH: path, BACKUP_DIR: backupDir, MAINTENANCE_STATE_PATH: join(dir, 'state.sqlite') };
    const seeded = spawnSync(process.execPath, ['scripts/create-admin.mjs'], {
      env: { ...env, ADMIN_USERNAME: 'maintenanceadmin', ADMIN_PASSWORD: 'maintenance-test-password' }, encoding: 'utf8',
    });
    assert.ifError(seeded.error);
    assert.equal(seeded.status, 0, seeded.stderr);
    const source = new DatabaseSync(path);
    source.exec('PRAGMA busy_timeout=5000');
    seedFixture(source);
    // No external network in this integration test; content rows remain in the backup.
    source.exec('UPDATE resources SET published=NULL,published_category=NULL');
    source.exec("INSERT INTO events (day,name,target,count) VALUES ('2000-01-01','resource_view','expired',1)");
    source.close();
    worker = spawn(process.execPath, ['scripts/maintenance.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(worker, 'close');
    let output = '';
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`维护进程超时：${output}\n${errors}`)), 10000);
      worker.on('error', (error) => { clearTimeout(timer); reject(error); });
      worker.on('close', () => { clearTimeout(timer); reject(new Error(`维护进程提前退出：${errors}`)); });
      worker.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('"event":"maintenance-finish","job":"cleanup"')) { clearTimeout(timer); resolve(); }
      });
    });
    worker.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 0, errors);
    assert.match(output, /"job":"backup","code":0,"status":"ok"/);
    assert.match(output, /"job":"links","code":0,"status":"ok"/);
    assert.match(output, /"job":"cleanup","code":0,"status":"ok"/);
    const cleaned = new DatabaseSync(path);
    try { assert.equal(cleaned.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0); }
    finally { cleaned.close(); }
    const files = readdirSync(backupDir);
    assert.equal(files.length, 1);
    const backup = new DatabaseSync(join(backupDir, files[0]));
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM resources').get().n, fixtureResources.length);
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    } finally { backup.close(); }
    const state = new DatabaseSync(env.MAINTENANCE_STATE_PATH);
    try {
      const jobs = state.prepare('SELECT * FROM jobs').all();
      assert.equal(jobs.length, 3);
      for (const job of jobs) {
        assert.equal(job.last_exit, 0);
        assert.ok(job.last_success > 0);
        assert.equal(job.lease_until, 0);
      }
    } finally { state.close(); }
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const closed = once(worker, 'close');
      worker.kill('SIGKILL');
      await closed;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
