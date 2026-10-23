#!/usr/bin/env node
/**
 * 为浏览器/冒烟测试准备显式夹具站点。
 * 以 Empty 初始化新库，再写入 tests/fixtures/content.ts 的固定资源与分类；
 * 不会使用 Demo 内容，也不会读取或修改正在使用的数据库（必须显式给 DATABASE_PATH）。
 */
if (!process.env.DATABASE_PATH) {
  console.error('必须设置 DATABASE_PATH，避免误写工作区数据库');
  process.exit(2);
}
process.env.SITE_INIT_MODE = 'empty';
delete process.env.SITE_INIT_NAME;
const { database, closeDatabase } = await import('../../src/server/db.ts');
const { fixtureResources, seedFixture } = await import('./content.ts');
try {
  seedFixture(database());
  // 浏览器测试需要一个稳定、无第三方的赞助实例；媒体引用留空，避免依赖上传。
  const db = database();
  const now = new Date().toISOString();
  const insertSponsor = db.prepare(`INSERT OR IGNORE INTO sponsors
    (id,version,title,body,sponsor_name,media_id,image_alt,target_url,placement,enabled,starts_at,ends_at,created_at,updated_at,created_by,updated_by)
    VALUES (?,1,?,?,?,NULL,'',?,?,1,NULL,NULL,?,?, 'fixture','fixture')`);
  insertSponsor.run('fixture-sidebar', '测试侧栏赞助', '用于浏览器测试的纯文本赞助位。', '测试赞助方', 'https://sponsor.example.com/sidebar', 'home-sidebar', now, now);
  insertSponsor.run('fixture-catalog', '测试目录赞助', '目录推广区测试。', '测试赞助方', 'https://sponsor.example.com/catalog', 'catalog-promotion', now, now);
  db.prepare("INSERT INTO settings (key,value) VALUES ('sponsors',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ schemaVersion: 1, version: 1, enabled: true }));
  const total = Number(db.prepare('SELECT COUNT(*) AS total FROM resources').get().total);
  console.log(JSON.stringify({ status: 'seeded', resources: total, expected: fixtureResources.length }));
  if (total !== fixtureResources.length) process.exitCode = 1;
} finally {
  closeDatabase();
}
