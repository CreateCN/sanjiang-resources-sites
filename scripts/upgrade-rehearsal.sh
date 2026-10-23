#!/usr/bin/env bash
# 旧版本 -> 候选版本 -> 恢复升级前批次 -> 旧版本的完整演练。
# 不修改工作树、不推送、不发布；使用临时 worktree、卷目录与容器。
set -euo pipefail
cd "$(dirname "$0")/.."

OLD_SHA="${OLD_SHA:-866a75f82a2145cd49d8c1691cf52843561a527d}"
CAND_SHA="$(git rev-parse HEAD)"
CAND_DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
VERSION="$(node -p "require('./package.json').version")"
WORK="$(mktemp -d)"
OLD_SRC="$WORK/old-src"
OLD_IMAGE="sanjiang-rehearsal-old:${OLD_SHA:0:12}"
CAND_IMAGE="sanjiang-rehearsal-candidate:${CAND_SHA:0:12}"
PASSWORD='rehearsal-password-2026!'
USERNAME='legacyadmin'
PORT_OLD=4551
PORT_CAND=4552
PORT_AFTER=4553
BASE_OLD="http://127.0.0.1:$PORT_OLD"
BASE_CAND="http://127.0.0.1:$PORT_CAND"
BASE_AFTER="http://127.0.0.1:$PORT_AFTER"
CONTAINERS=()

cleanup() {
  for name in "${CONTAINERS[@]:-}"; do
    if [ -n "$name" ]; then docker rm -f "$name" >/dev/null 2>&1 || true; fi
  done
  if [ -d "$OLD_SRC" ]; then git worktree remove --force "$OLD_SRC" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "REHEARSAL FAILED: $*" >&2; exit 1; }
wait_up() {
  local base="$1"
  for _ in $(seq 1 120); do
    if curl -fsS "$base/api/health/" 2>/dev/null | grep -q '"db":"ok"'; then return 0; fi
    sleep 0.25
  done
  fail "服务未就绪：$base"
}
login() {
  local base="$1" user="$2" pass="$3" jar="$4"
  local html csrf code
  html="$(curl -fsS -c "$jar" "$base/admin/login/")"
  csrf="$(printf '%s' "$html" | grep -o 'name="csrf" value="[^"]*"' | sed 's/.*value="//;s/"$//' | head -1 || true)"
  local args=(-s -o /dev/null -w '%{http_code}' -b "$jar" -c "$jar" -X POST -H "Origin: $base")
  if [ -n "$csrf" ]; then args+=(--data-urlencode "csrf=$csrf"); fi
  args+=(--data-urlencode "username=$user" --data-urlencode "password=$pass")
  code="$(curl "${args[@]}" "$base/api/login/")"
  if [ "$code" != "303" ] && [ "$code" != "302" ]; then fail "登录返回 $code：$base"; fi
  code="$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$base/admin/")"
  [ "$code" = "200" ] || fail "登录后后台返回 $code：$base"
}

mkdir -p "$WORK/a/data/media/objects" "$WORK/a/backups" "$WORK/offline/data/media/objects"
chmod -R 0777 "$WORK"
USER_ARGS=(--user "$(id -u):$(id -g)")

echo "== build old $OLD_SHA and candidate $CAND_SHA (dirty files: $CAND_DIRTY) =="
git worktree add --detach "$OLD_SRC" "$OLD_SHA" >/dev/null
docker build --build-arg COMMIT_SHA="$OLD_SHA" -t "$OLD_IMAGE" "$OLD_SRC" >/dev/null
docker build --build-arg VERSION="$VERSION" --build-arg COMMIT_SHA="$CAND_SHA" -t "$CAND_IMAGE" . >/dev/null

echo "== old instance: auto seed, admin, backup =="
OLD_NAME="sj-rehearsal-old-$$"
CONTAINERS+=("$OLD_NAME")
docker run -d --name "$OLD_NAME" "${USER_ARGS[@]}" -p "127.0.0.1:$PORT_OLD:4321" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" \
  -e SITE_URL="$BASE_OLD" "$OLD_IMAGE" >/dev/null
wait_up "$BASE_OLD"
curl -fsS "$BASE_OLD/" | grep -q 'Zotero' || fail "旧版本首页缺少种子资源"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" \
  -e ADMIN_USERNAME="$USERNAME" -e ADMIN_PASSWORD="$PASSWORD" "$OLD_IMAGE" node scripts/create-admin.mjs >/dev/null
login "$BASE_OLD" "$USERNAME" "$PASSWORD" "$WORK/old-cookies.txt"
docker stop -t 5 "$OLD_NAME" >/dev/null
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" "$OLD_IMAGE" node scripts/backup-site.mjs > "$WORK/old-backup.json"
grep -q '"status": "complete"' "$WORK/old-backup.json"
BATCH="$(sed -n 's/.*"batch": "\([^"]*\)".*/\1/p' "$WORK/old-backup.json" | head -1)"
BATCH_NAME="${BATCH##*/}"
[ -n "$BATCH_NAME" ] || fail "旧版本备份未返回批次"
[ -f "$WORK/a/backups/$BATCH_NAME/COMPLETE" ] || fail "备份缺少 COMPLETE"
OLD_RESOURCES="$(node -e "const r=require('$WORK/old-backup.json'); console.log(r.database.counts.resources)")"
[ "$OLD_RESOURCES" -gt 0 ] || fail "旧版本备份没有资源"
OLD_SCHEMA="$(docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" "$OLD_IMAGE" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/site.sqlite', { readOnly: true });
console.log(db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get()?.id ?? '');
db.close();
")"

echo "== candidate instance: migrate old data, login, add candidate-only sponsor =="
CAND_NAME="sj-rehearsal-cand-$$"
CONTAINERS+=("$CAND_NAME")
docker run -d --name "$CAND_NAME" "${USER_ARGS[@]}" -p "127.0.0.1:$PORT_CAND:4321" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" \
  -e SITE_URL="$BASE_CAND" -e SITE_INIT_MODE=empty -e SITE_INIT_NAME=演练实例 "$CAND_IMAGE" >/dev/null
wait_up "$BASE_CAND"
curl -fsS "$BASE_CAND/" | grep -q 'Zotero' || fail "升级后资源丢失"
login "$BASE_CAND" "$USERNAME" "$PASSWORD" "$WORK/cand-cookies.txt"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" "$CAND_IMAGE" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/site.sqlite', { readOnly: true });
if (!db.prepare(\"SELECT 1 FROM schema_migrations WHERE id='012-sponsors'\").get()) process.exit(1);
db.close();
"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -e SITE_INIT_MODE=empty "$CAND_IMAGE" node --input-type=module -e "
import { closeDatabase, database } from './src/server/db.ts';
import { listUsers } from './src/server/store.ts';
import { createSponsor } from './src/server/sponsors.ts';
const admin = listUsers().find((user) => user.role === 'admin');
if (!admin) process.exit(1);
createSponsor(admin, {
  title: '升级后新增赞助', body: '回滚时应丢失。', sponsorName: '演练赞助方',
  mediaId: null, imageAlt: '', targetUrl: 'https://sponsor.example.com/',
  placement: 'home-sidebar', enabled: true, startsAt: null, endsAt: null,
});
if (!database().prepare(\"SELECT 1 FROM sponsors WHERE title='升级后新增赞助'\").get()) process.exit(1);
closeDatabase();
"
CAND_SCHEMA="$(docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" "$CAND_IMAGE" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/site.sqlite', { readOnly: true });
console.log(db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get()?.id ?? '');
db.close();
")"
CAND_SPONSORS="$(docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" "$CAND_IMAGE" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/site.sqlite', { readOnly: true });
console.log(db.prepare('SELECT COUNT(*) AS total FROM sponsors').get().total);
db.close();
")"
[ "$CAND_SPONSORS" = "1" ] || fail "候选版本未写入赞助"
docker stop -t 5 "$CAND_NAME" >/dev/null

echo "== offline candidate: no network, local health and home =="
cp -a "$WORK/a/data/." "$WORK/offline/data/"
OFFLINE_NAME="sj-rehearsal-offline-$$"
CONTAINERS+=("$OFFLINE_NAME")
docker run -d --name "$OFFLINE_NAME" --network none "${USER_ARGS[@]}" -v "$WORK/offline/data:/app/data" \
  -e SITE_URL="http://127.0.0.1:4321" -e SITE_INIT_MODE=empty "$CAND_IMAGE" >/dev/null
for _ in $(seq 1 120); do
  if docker exec "$OFFLINE_NAME" node -e "fetch('http://127.0.0.1:4321/api/health/').then(r=>r.text()).then(t=>{if(!t.includes('\"db\":\"ok\"'))process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 0.25
done
docker exec "$OFFLINE_NAME" node -e "fetch('http://127.0.0.1:4321/').then(r=>r.text()).then(t=>{if(!t.includes('Zotero'))process.exit(1)}).catch(()=>process.exit(1))"
docker rm -f "$OFFLINE_NAME" >/dev/null
CONTAINERS=("${CONTAINERS[@]/$OFFLINE_NAME}")

echo "== rollback: old restore tool restores pre-upgrade batch, then old app =="
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" "$OLD_IMAGE" \
  node scripts/restore-site.mjs --backup "/app/backups/$BATCH_NAME" --database /app/data/site.sqlite --media /app/data/media --yes > "$WORK/restore.json"
grep -q '"status": "restored"' "$WORK/restore.json"
AFTER_NAME="sj-rehearsal-after-$$"
CONTAINERS+=("$AFTER_NAME")
docker run -d --name "$AFTER_NAME" "${USER_ARGS[@]}" -p "127.0.0.1:$PORT_AFTER:4321" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" \
  -e SITE_URL="$BASE_AFTER" "$OLD_IMAGE" >/dev/null
wait_up "$BASE_AFTER"
curl -fsS "$BASE_AFTER/" | grep -q 'Zotero' || fail "恢复后旧版本资源丢失"
# 旧恢复会撤销会话：升级后的 Cookie 不能再访问后台。
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cand-cookies.txt" "$BASE_AFTER/admin/")"
[ "$CODE" = "302" ] || [ "$CODE" = "303" ] || fail "回滚后旧会话仍可用：$CODE"
login "$BASE_AFTER" "$USERNAME" "$PASSWORD" "$WORK/after-cookies.txt"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" "$OLD_IMAGE" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/site.sqlite', { readOnly: true });
const last = db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get();
if (last?.id !== '010-totp-2fa') process.exit(1);
if (db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name='sponsors'\").get()) process.exit(1);
db.close();
"
RESTORED_SCHEMA="$(docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" "$OLD_IMAGE" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/site.sqlite', { readOnly: true });
console.log(db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get()?.id ?? '');
db.close();
")"
[ "$RESTORED_SCHEMA" = "$OLD_SCHEMA" ] || fail "回滚后 schema 未回到旧版本"

echo "REHEARSAL PASS"
printf '{"status":"pass","oldSha":"%s","candidateSha":"%s","candidateDirtyFiles":%s,"oldSchema":"%s","candidateSchema":"%s","restoredSchema":"%s","oldResources":%s,"candidateSponsors":%s,"backup":"%s","restored":true,"offline":true}\n' \
  "$OLD_SHA" "$CAND_SHA" "$CAND_DIRTY" "$OLD_SCHEMA" "$CAND_SCHEMA" "$RESTORED_SCHEMA" "$OLD_RESOURCES" "$CAND_SPONSORS" "$BATCH_NAME"
