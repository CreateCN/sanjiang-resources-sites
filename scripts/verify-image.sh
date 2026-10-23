#!/usr/bin/env bash
# 发行镜像验收：OCI 元数据、许可、运行用户、管理员 CLI、初始化、整站备份与恢复。
# 用法：bash scripts/verify-image.sh IMAGE VERSION [COMMIT_SHA]
set -euo pipefail
IMAGE="${1:?用法：verify-image.sh IMAGE VERSION [COMMIT_SHA]}"
VERSION="${2:?缺少版本号}"
COMMIT="${3:-}"
EXPECTED_PLATFORM="${EXPECTED_PLATFORM:-linux/amd64}"
EXPECT_LEGACY_ASSETS="${EXPECT_LEGACY_ASSETS:-0}"
if [ "$EXPECT_LEGACY_ASSETS" != "0" ] && [ "$EXPECT_LEGACY_ASSETS" != "1" ]; then
  echo "EXPECT_LEGACY_ASSETS 只能是 0 或 1" >&2
  exit 2
fi

platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE")"
if [ "$platform" != "$EXPECTED_PLATFORM" ]; then
  echo "镜像平台是 $platform，期望 $EXPECTED_PLATFORM；不要声明未验证的多架构" >&2
  exit 2
fi

LABELS="$(docker image inspect --format '{{json .Config.Labels}}' "$IMAGE")"
node -e '
const labels = JSON.parse(process.argv[1]);
const [version, commit] = process.argv.slice(2);
const want = {
  "org.opencontainers.image.version": version,
  "org.opencontainers.image.licenses": "MIT",
};
for (const [key, value] of Object.entries(want)) {
  if (labels[key] !== value) throw new Error(`label ${key} 期望 ${value}，实际 ${labels[key]}`);
}
for (const key of ["org.opencontainers.image.source", "org.opencontainers.image.title", "org.opencontainers.image.base.name"]) {
  if (!labels[key]) throw new Error(`缺少 label ${key}`);
}
if (commit && labels["org.opencontainers.image.revision"] !== commit) {
  throw new Error(`revision label ${labels["org.opencontainers.image.revision"]} 与提交 ${commit} 不一致`);
}
' "$LABELS" "$VERSION" "$COMMIT"

LEGACY_LABEL="$(docker image inspect --format '{{index .Config.Labels "com.createcn.sanjiang.legacy-assets"}}' "$IMAGE")"
if [ "$LEGACY_LABEL" != "$EXPECT_LEGACY_ASSETS" ]; then
  echo "legacy-assets label=$LEGACY_LABEL，期望 $EXPECT_LEGACY_ASSETS" >&2
  exit 2
fi

APP_VERSION="$(docker run --rm "$IMAGE" node -p 'process.env.APP_VERSION')"
if [ "$APP_VERSION" != "$VERSION" ]; then
  echo "APP_VERSION=$APP_VERSION 与版本 $VERSION 不一致" >&2
  exit 2
fi

docker run --rm "$IMAGE" sh -c 'test -f LICENSE && test -f NOTICE && test -f THIRD-PARTY-NOTICES.md && test -f licenses/LGPL-3.0.txt && test -f node_modules/sharp/LICENSE && test ! -d node_modules/@playwright'

if [ "$EXPECT_LEGACY_ASSETS" = "0" ]; then
  docker run --rm "$IMAGE" sh -c 'test ! -e dist/client/images/zotero-interface.png && test ! -e dist/client/images/obs-interface.png && test ! -e dist/client/images/vlc-interface.jpg && ! ls dist/client/images/optimized/zotero-* >/dev/null 2>&1 && ! ls dist/client/images/optimized/obs-* >/dev/null 2>&1 && ! ls dist/client/images/optimized/vlc-* >/dev/null 2>&1'
else
  docker run --rm "$IMAGE" sh -c 'test -f dist/client/images/zotero-interface.png && test -f dist/client/images/obs-interface.png && test -f dist/client/images/vlc-interface.jpg && ls dist/client/images/optimized/zotero-* >/dev/null'
fi

WORK="$(mktemp -d)"
NAME=""
cleanup() {
  if [ -n "$NAME" ]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/a/data/media/objects" "$WORK/a/backups" "$WORK/b/data/media/objects"
chmod -R 0777 "$WORK"
USER_ARGS=(--user "$(id -u):$(id -g)")

INIT="$(docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" -e SITE_INIT_MODE=empty "$IMAGE" node scripts/init-site.mjs --mode empty --name "发行验收")"
printf '%s' "$INIT" | grep -q '"status":"initialized"'
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" -e SITE_INIT_MODE=empty -e ADMIN_USERNAME=release-admin -e ADMIN_PASSWORD='release-check-password-2026!' "$IMAGE" node scripts/create-admin.mjs >/dev/null
docker run --rm "${USER_ARGS[@]}" -v "$WORK/a/data:/app/data" -v "$WORK/a/backups:/app/backups" "$IMAGE" node scripts/backup-site.mjs > "$WORK/backup.json"
grep -q '"status": "complete"' "$WORK/backup.json"
BATCH="$(sed -n 's/.*"batch": "\([^"]*\)".*/\1/p' "$WORK/backup.json" | head -1)"
BATCH_NAME="${BATCH##*/}"
docker run --rm "${USER_ARGS[@]}" -v "$WORK/b/data:/app/data" -v "$WORK/a/backups:/app/backups" "$IMAGE" \
  node scripts/restore-site.mjs --backup "/app/backups/$BATCH_NAME" --database /app/data/site.sqlite --media /app/data/media --yes > "$WORK/restore.json"
grep -q '"status": "restored"' "$WORK/restore.json"

# 运行形态：临时端口启动、健康检查、停止。完整双实例流程由 container-smoke 覆盖。
mkdir -p "$WORK/c/data/media/objects"
chmod -R 0777 "$WORK/c"
NAME="sj-verify-$$"
docker run -d --name "$NAME" "${USER_ARGS[@]}" -v "$WORK/c/data:/app/data" -p "127.0.0.1::4321" \
  -e SITE_URL="http://127.0.0.1:4321" -e SITE_INIT_MODE=empty "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 4321/tcp | sed 's/.*://')"
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health/" 2>/dev/null | grep -q '"db":"ok"'; then break; fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/api/health/" | grep -q '"db":"ok"'
ASSET_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/images/zotero-interface.png")"
if [ "$EXPECT_LEGACY_ASSETS" = "0" ]; then
  [ "$ASSET_CODE" = "404" ] || { echo "默认镜像仍可访问未确认旧截图：$ASSET_CODE" >&2; exit 2; }
else
  [ "$ASSET_CODE" = "200" ] || { echo "兼容镜像缺少旧截图：$ASSET_CODE" >&2; exit 2; }
fi
docker rm -f "$NAME" >/dev/null
NAME=""

echo "image verified: $IMAGE (version=$VERSION platform=$platform)"
