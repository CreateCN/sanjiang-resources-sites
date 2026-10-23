#!/usr/bin/env bash
# R06 素材矩阵：默认镜像缺席旧截图；兼容镜像含旧截图；旧库详情由 picture/srcset 降级为占位。
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse HEAD)"
TAG_BASE="sanjiang-assets-smoke"
DEFAULT_IMAGE="$TAG_BASE:default"
COMPAT_IMAGE="$TAG_BASE:compat"
WORK="$(mktemp -d)"
CONTAINERS=()
fail() { echo "ASSET SMOKE FAILED: $*" >&2; exit 1; }
cleanup() {
  for name in "${CONTAINERS[@]:-}"; do if [ -n "$name" ]; then docker rm -f "$name" >/dev/null 2>&1 || true; fi; done
  rm -rf "$WORK"
}
trap cleanup EXIT
USER_ARGS=(--user "$(id -u):$(id -g)")
wait_up() {
  for _ in $(seq 1 120); do
    if curl -fsS "$1/api/health/" 2>/dev/null | grep -q '"db":"ok"'; then return 0; fi
    sleep 0.25
  done
  fail "服务未就绪：$1"
}

echo "== build default and compatibility images =="
docker build --build-arg VERSION="$VERSION" --build-arg COMMIT_SHA="$COMMIT" --build-arg INCLUDE_LEGACY_ASSETS=0 -t "$DEFAULT_IMAGE" . >/dev/null
docker build --build-arg VERSION="$VERSION" --build-arg COMMIT_SHA="$COMMIT" --build-arg INCLUDE_LEGACY_ASSETS=1 -t "$COMPAT_IMAGE" . >/dev/null
EXPECT_LEGACY_ASSETS=0 bash scripts/verify-image.sh "$DEFAULT_IMAGE" "$VERSION" "$COMMIT" >/dev/null
EXPECT_LEGACY_ASSETS=1 bash scripts/verify-image.sh "$COMPAT_IMAGE" "$VERSION" "$COMMIT" >/dev/null

echo "== seed a legacy-image resource =="
mkdir -p "$WORK/data/media/objects"
chmod -R 0777 "$WORK"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/data:/app/data" -e SITE_INIT_MODE=empty "$COMPAT_IMAGE" node scripts/init-site.mjs --mode empty --name "素材旧站" >/dev/null
docker run --rm "${USER_ARGS[@]}" -v "$WORK/data:/app/data" -e SITE_INIT_MODE=empty -e ADMIN_USERNAME=legacyadmin -e ADMIN_PASSWORD='legacy-password-2026!' "$COMPAT_IMAGE" node scripts/create-admin.mjs >/dev/null
docker run --rm "${USER_ARGS[@]}" -v "$WORK/data:/app/data" -e SITE_INIT_MODE=empty "$COMPAT_IMAGE" node --input-type=module -e "
import { listUsers, saveResource, changePublication } from './src/server/store.ts';
import { closeDatabase } from './src/server/db.ts';
const admin = listUsers().find((user) => user.role === 'admin');
const saved = saveResource(admin, {
  id: 'legacy-shot', access: 'open', title: '旧站截图资源', summary: '旧库仍引用授权未确认截图。',
  category: 'general', kind: '开源工具', cost: '免费', platforms: ['网页'], tags: ['旧站'],
  url: 'https://example.com/', sourceUrl: 'https://example.com/', license: '示例', eligibility: '无', caveat: '无',
  steps: ['打开'], status: 'verified', checkedAt: '2026-10-20',
  image: '/images/zotero-interface.png', imageAlt: '旧站 Zotero 截图', imageRights: 'unconfirmed', imageCredit: '网络图片，授权未确认',
}, null);
changePublication(admin, 'legacy-shot', saved.version, 'publish');
closeDatabase();
"

echo "== compatibility image: old URL and picture/srcset work =="
COMPAT_NAME="sj-assets-compat-$$"
CONTAINERS+=("$COMPAT_NAME")
docker run -d --name "$COMPAT_NAME" "${USER_ARGS[@]}" -p "127.0.0.1:4561:4321" -v "$WORK/data:/app/data" \
  -e SITE_URL="http://127.0.0.1:4561" -e SITE_INIT_MODE=empty "$COMPAT_IMAGE" >/dev/null
wait_up "http://127.0.0.1:4561"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4561/images/zotero-interface.png)" = "200" ]
curl -fsS http://127.0.0.1:4561/resources/legacy-shot/ > "$WORK/compat.html"
grep -q '/images/zotero-interface.png' "$WORK/compat.html"
grep -q 'srcset=' "$WORK/compat.html"
docker stop -t 5 "$COMPAT_NAME" >/dev/null

echo "== default image: old URL 404, detail uses placeholder =="
DEFAULT_NAME="sj-assets-default-$$"
CONTAINERS+=("$DEFAULT_NAME")
docker run -d --name "$DEFAULT_NAME" "${USER_ARGS[@]}" -p "127.0.0.1:4562:4321" -v "$WORK/data:/app/data" \
  -e SITE_URL="http://127.0.0.1:4562" -e SITE_INIT_MODE=empty "$DEFAULT_IMAGE" >/dev/null
wait_up "http://127.0.0.1:4562"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4562/images/zotero-interface.png)" = "404" ]
curl -fsS http://127.0.0.1:4562/resources/legacy-shot/ > "$WORK/default.html"
grep -q '图片已下架或不可用' "$WORK/default.html"
! grep -q '/images/zotero-interface.png' "$WORK/default.html"
! grep -q 'srcset=' "$WORK/default.html"

echo "ASSET SMOKE PASS"
