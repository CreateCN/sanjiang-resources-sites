#!/usr/bin/env bash
# 容器级冒烟：干净卷安装 Empty/Demo、两实例隔离、停写备份与站点恢复。
# 需要 Docker；CI 的 container job 直接运行本脚本。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
TAG=${IMAGE_TAG:-sanjiang-smoke:$$}
WORK=$(mktemp -d)
PORT_A=${PORT_A:-4531}
PORT_B=${PORT_B:-4532}
PORT_C=${PORT_C:-4533}
PORT_D=${PORT_D:-4534}
BASE_A="http://127.0.0.1:${PORT_A}"
BASE_B="http://127.0.0.1:${PORT_B}"
BASE_C="http://127.0.0.1:${PORT_C}"
BASE_D="http://127.0.0.1:${PORT_D}"
PASSWORD_A='container-a-password-2026!'
PASSWORD_B='container-b-password-2026!'
NAME_A=${NAME_A:-容器甲实例}
NAME_B=${NAME_B:-容器乙实例}
USER_ARGS=(--user "$(id -u):$(id -g)")
A="sj-smoke-a-$$"
B="sj-smoke-b-$$"
C="sj-smoke-c-$$"
D="sj-smoke-d-$$"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- backup.json ----"; cat "$WORK/backup.json" 2>/dev/null | tail -30 || true
    echo "---- restore.json ----"; cat "$WORK/restore.json" 2>/dev/null | tail -40 || true
    for container in "$A" "$B" "$C" "$D"; do docker logs "$container" 2>&1 | tail -40 || true; done
  fi
  docker rm -f "$A" "$B" "$C" "$D" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

wait_up() {
  local base=$1
  for _ in $(seq 1 100); do
    if curl -fsS "$base/api/health/" >/dev/null 2>&1; then return 0; fi
    sleep 0.3
  done
  echo "服务未启动：$base" >&2
  return 1
}
expect_contains() {
  local url=$1 text=$2
  local body
  body=$(curl -fsS "$url")
  if ! printf '%s' "$body" | grep -q "$text"; then
    echo "页面 $url 缺少预期内容：$text" >&2
    return 1
  fi
}

echo "== build =="
VERSION="$(node -p "require('./package.json').version")"
docker build --build-arg VERSION="$VERSION" --build-arg COMMIT_SHA="${COMMIT_SHA:-}" -t "$TAG" .
docker image inspect --format '{{json .Config.Labels}}' "$TAG" | grep -q '"org.opencontainers.image.version":"'"$VERSION"'"'
docker image inspect --format '{{json .Config.Labels}}' "$TAG" | grep -q '"org.opencontainers.image.licenses":"MIT"'
docker run --rm "${USER_ARGS[@]}" "$TAG" sh -c 'test -f LICENSE && test -f NOTICE && test -f THIRD-PARTY-NOTICES.md && test -f node_modules/sharp/LICENSE && test -f licenses/LGPL-3.0.txt && test ! -d node_modules/@playwright'
# 默认发行不得包含授权未确认的旧截图及其派生图。
docker run --rm "${USER_ARGS[@]}" "$TAG" sh -c 'test ! -e dist/client/images/zotero-interface.png && test ! -e dist/client/images/obs-interface.png && test ! -e dist/client/images/vlc-interface.jpg && ! ls dist/client/images/optimized/zotero-* >/dev/null 2>&1 && ! ls dist/client/images/optimized/obs-* >/dev/null 2>&1 && ! ls dist/client/images/optimized/vlc-* >/dev/null 2>&1'

mkdir -p "$WORK/a/data/media/objects" "$WORK/b/data/media/objects" "$WORK/c/data" "$WORK/backups"
chmod -R 0777 "$WORK"

echo "== init empty + demo, create same username =="
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" "$TAG" node scripts/init-site.mjs --mode empty --name "$NAME_A"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/b/data:/app/data" "$TAG" node scripts/init-site.mjs --mode demo --name "$NAME_B"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -e ADMIN_USERNAME=shared-admin -e ADMIN_PASSWORD="$PASSWORD_A" -e SITE_INIT_MODE=empty "$TAG" node scripts/create-admin.mjs
docker run --rm "${USER_ARGS[@]}" -v "$WORK/b/data:/app/data" -e ADMIN_USERNAME=shared-admin -e ADMIN_PASSWORD="$PASSWORD_B" -e SITE_INIT_MODE=demo "$TAG" node scripts/create-admin.mjs

echo "== start two instances =="
docker run -d --name "$A" "${USER_ARGS[@]}" -p "127.0.0.1:${PORT_A}:4321" -v "$WORK/a/data:/app/data" \
  -e SITE_URL="$BASE_A" -e SITE_INIT_MODE=empty -e NODE_ENV=production "$TAG" >/dev/null
docker run -d --name "$B" "${USER_ARGS[@]}" -p "127.0.0.1:${PORT_B}:4321" -v "$WORK/b/data:/app/data" \
  -e SITE_URL="$BASE_B" -e SITE_INIT_MODE=demo -e NODE_ENV=production "$TAG" >/dev/null
wait_up "$BASE_A"
wait_up "$BASE_B"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_A/images/zotero-interface.png")" = "404" ] || fail "默认镜像仍可访问未确认旧截图"

expect_contains "$BASE_A/" "共 0 项"
expect_contains "$BASE_A/" "$NAME_A"
expect_contains "$BASE_B/" "共 2 项"
expect_contains "$BASE_B/" "演示内容，请替换并重新核验"
expect_contains "$BASE_B/" "$NAME_B"

echo "== accounts and cookies are isolated =="
login() {
  local base=$1 password=$2 jar=$3
  curl -s -o /dev/null -w '%{http_code}' -c "$jar" -H "Origin: $base" -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "username=shared-admin" --data-urlencode "password=$password" "$base/api/login/"
}
code_a=$(login "$BASE_A" "$PASSWORD_A" "$WORK/a.cookies")
code_b=$(login "$BASE_B" "$PASSWORD_B" "$WORK/b.cookies")
[ "$code_a" = "303" ] && [ "$code_b" = "303" ] || { echo "登录失败：$code_a / $code_b" >&2; exit 1; }
admin_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/a.cookies" "$BASE_A/admin/")
[ "$admin_code" = "200" ] || { echo "A 会话不可用：$admin_code" >&2; exit 1; }
cross_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/a.cookies" "$BASE_B/admin/")
case "$cross_code" in 302|303) ;; *) echo "跨实例 Cookie 未被拒绝：$cross_code" >&2; exit 1;; esac
wrong_code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $BASE_B" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=shared-admin" --data-urlencode "password=$PASSWORD_A" "$BASE_B/api/login/")
[ "$wrong_code" = "401" ] || { echo "A 的口令在 B 上未被拒绝：$wrong_code" >&2; exit 1; }

echo "== rebrand A via one-off tool container =="
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -e SITE_INIT_MODE=empty "$TAG" \
  node --input-type=module -e "
import { closeDatabase } from './src/server/db.ts';
import { listUsers } from './src/server/store.ts';
import { getBranding, getBrandingAdminView, saveBranding } from './src/server/site-config.ts';
const admin = listUsers().find((user) => user.role === 'admin');
const { schemaVersion, version, ...input } = getBranding();
saveBranding(admin, { ...input, name: '容器甲改名' }, getBrandingAdminView().version);
closeDatabase();
"
expect_contains "$BASE_A/" "容器甲改名"

echo "== content import via one-off tool container =="
cat > "$WORK/import.json" <<'JSON'
{
  "schemaVersion": 3,
  "resources": [
    {
      "id": "container-import",
      "title": "容器导入草稿",
      "summary": "通过一次性工具容器导入的草稿。",
      "category": "general",
      "kind": "开源工具",
      "cost": "免费",
      "platforms": ["网页"],
      "tags": ["导入"],
      "url": "https://example.com/container-import",
      "sourceUrl": "https://example.com/container-import/about",
      "license": "示例许可",
      "eligibility": "无",
      "caveat": "仅用于容器冒烟测试",
      "steps": ["第一步"],
      "status": "review",
      "checkedAt": null,
      "scope": { "type": "unknown" }
    }
  ]
}
JSON
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/import.json:/tmp/import.json:ro" -e SITE_INIT_MODE=empty "$TAG" \
  node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { previewImport, applyImport } from './src/lib/importer.ts';
import { closeDatabase } from './src/server/db.ts';
import { listUsers } from './src/server/store.ts';
import { createSponsor } from './src/server/sponsors.ts';
const payload = JSON.parse(readFileSync('/tmp/import.json', 'utf8'));
const preview = previewImport(payload);
if (preview.resources.invalid.length) { console.error(preview.resources.invalid); process.exit(1); }
const admin = listUsers().find((user) => user.role === 'admin');
const result = applyImport(admin, payload, preview.plan);
if (result.resources !== 1) { console.error(result); process.exit(1); }
const sponsor = createSponsor(admin, {
  title: '容器赞助', body: '备份恢复必须保留赞助行。', sponsorName: '容器赞助方',
  mediaId: null, imageAlt: '', targetUrl: 'https://sponsor.example.com/',
  placement: 'home-sidebar', enabled: true, startsAt: null, endsAt: null,
});
if (!sponsor.id) process.exit(1);
closeDatabase();
"

echo "== stop-write backup of A, restore into C =="
docker stop -t 5 "$A" >/dev/null
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/backups:/app/backups" "$TAG" node scripts/backup-site.mjs > "$WORK/backup.json"
batch=$(sed -n 's/.*"batch": "\([^"]*\)".*/\1/p' "$WORK/backup.json" | head -1)
[ -n "$batch" ] || { cat "$WORK/backup.json" >&2; echo "未解析到备份批次" >&2; exit 1; }
batch_name=${batch##*/}
docker run --rm "${USER_ARGS[@]}" -v "$WORK/c/data:/app/data" -v "$WORK/backups:/app/backups" "$TAG" \
  node scripts/restore-site.mjs --backup "/app/backups/$batch_name" --database /app/data/site.sqlite --media /app/data/media --yes > "$WORK/restore.json"
grep -q '"status": "restored"' "$WORK/restore.json"

docker run -d --name "$C" "${USER_ARGS[@]}" -p "127.0.0.1:${PORT_C}:4321" -v "$WORK/c/data:/app/data" \
  -e SITE_URL="$BASE_C" -e SITE_INIT_MODE=empty -e NODE_ENV=production "$TAG" >/dev/null
wait_up "$BASE_C"
expect_contains "$BASE_C/" "容器甲改名"
expect_contains "$BASE_C/" "共 0 项"
# 草稿通过整站备份恢复到了 C，且仍不公开。
docker run --rm "${USER_ARGS[@]}" -v "$WORK/c/data:/app/data" "$TAG" \
  node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/site.sqlite', { readOnly: true });
if (!db.prepare(\"SELECT 1 FROM resources WHERE id='container-import' AND published IS NULL\").get()) process.exit(1);
if (!db.prepare(\"SELECT 1 FROM sponsors WHERE title='容器赞助'\").get()) process.exit(1);
db.close();
"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_C/resources/container-import/")" = "404" ]

echo "== rollback A from backup after a bad change =="
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -e SITE_INIT_MODE=empty "$TAG" \
  node --input-type=module -e "
import { closeDatabase } from './src/server/db.ts';
import { listUsers } from './src/server/store.ts';
import { getBranding, getBrandingAdminView, saveBranding } from './src/server/site-config.ts';
const admin = listUsers().find((user) => user.role === 'admin');
const { schemaVersion, version, ...input } = getBranding();
saveBranding(admin, { ...input, name: '回滚前坏改动' }, getBrandingAdminView().version);
closeDatabase();
"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/backups:/app/backups" "$TAG" \
  node scripts/restore-site.mjs --backup "/app/backups/$batch_name" --database /app/data/site.sqlite --media /app/data/media --yes > "$WORK/restore-a.json"
grep -q '"status": "restored"' "$WORK/restore-a.json"
docker start "$A" >/dev/null
wait_up "$BASE_A"
expect_contains "$BASE_A/" "容器甲改名"

echo "== legacy 010 database upgrades on startup =="
mkdir -p "$WORK/d/data/media/objects"
chmod -R 0777 "$WORK/d"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/d/data:/app/data" "$TAG" \
  node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './src/server/migrations.ts';
const db = new DatabaseSync('/app/data/site.sqlite');
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
for (const migration of migrations.filter((entry) => entry.id !== '011-instance-configuration' && entry.id !== '012-sponsors')) {
  db.exec('BEGIN IMMEDIATE');
  migration.up(db);
  db.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run(migration.id, new Date().toISOString());
  db.exec('COMMIT');
}
db.prepare(\"INSERT INTO metadata (key,value) VALUES ('seeded','1')\").run();
db.prepare(\"INSERT INTO categories (id,name) VALUES ('general','综合资源')\").run();
const resource = { id: 'legacy-one', title: '旧库资源', summary: '旧库迁移测试。', category: 'general', kind: '开源工具', cost: '免费', platforms: ['网页'], tags: ['旧库'], url: 'https://example.com/', sourceUrl: 'https://example.com/about', license: '示例', eligibility: '无', caveat: '无', steps: ['第一步'], status: 'review', checkedAt: null };
const json = JSON.stringify(resource);
db.prepare('INSERT INTO resources (id,uid,draft,published,draft_category,published_category,version,updated_at) VALUES (?,?,?,?,?,?,1,?)').run('legacy-one', '0011223344556677', json, json, 'general', 'general', new Date().toISOString());
db.close();
"
docker run -d --name "$D" "${USER_ARGS[@]}" -p "127.0.0.1:${PORT_D}:4321" -v "$WORK/d/data:/app/data" \
  -e SITE_URL="$BASE_D" -e SITE_INIT_MODE=empty -e NODE_ENV=production "$TAG" >/dev/null
wait_up "$BASE_D"
expect_contains "$BASE_D/" "三江资源"
expect_contains "$BASE_D/" "旧库资源"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/d/data:/app/data" "$TAG" \
  node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/site.sqlite', { readOnly: true });
if (!db.prepare(\"SELECT 1 FROM schema_migrations WHERE id='011-instance-configuration'\").get()) process.exit(1);
if (!db.prepare(\"SELECT 1 FROM schema_migrations WHERE id='012-sponsors'\").get()) process.exit(1);
db.close();
"

echo "== instance B unaffected after rollback/upgrade =="
expect_contains "$BASE_B/" "共 2 项"
expect_contains "$BASE_B/" "$NAME_B"

echo "container smoke: PASS"
