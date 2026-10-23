#!/usr/bin/env bash
# 构建带 OCI 元数据的发行镜像；不推送、不登录 registry。
# 用法：IMAGE=ghcr.io/OWNER/sanjiang-resources VERSION=0.2.0 COMMIT_SHA=$(git rev-parse HEAD) bash scripts/build-image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-sanjiang-resources}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
if [ -z "${COMMIT_SHA:-}" ]; then
  COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
fi
COMMIT_SHA="$(printf '%s' "$COMMIT_SHA" | tr '[:upper:]' '[:lower:]')"
if [ -n "$COMMIT_SHA" ] && ! printf '%s' "$COMMIT_SHA" | grep -Eq '^[a-f0-9]{40}$'; then
  echo "COMMIT_SHA 必须是完整 40 位小写 SHA（或留空以源码归档方式构建）" >&2
  exit 2
fi

TAG="$IMAGE:$VERSION"
echo "building $TAG (version=$VERSION commit=${COMMIT_SHA:-empty})"
docker build \
  --build-arg VERSION="$VERSION" \
  --build-arg COMMIT_SHA="$COMMIT_SHA" \
  --build-arg SOURCE_URL="${SOURCE_URL:-https://github.com/CreateCN/sanjiang-resources-sites}" \
  --build-arg INCLUDE_LEGACY_ASSETS="${INCLUDE_LEGACY_ASSETS:-0}" \
  -t "$TAG" .
docker image inspect --format 'labels={{json .Config.Labels}}' "$TAG"
