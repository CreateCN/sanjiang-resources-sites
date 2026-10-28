# 发行与部署

本页说明如何构建、标记、验证和部署发行镜像。开发用的 `docker-compose.yml` 会从源码构建；发行部署使用 `compose.release.yml`，只拉取固定 digest。

## 1. 发行物

| 产物 | 说明 |
|---|---|
| 镜像 | 含 `dist/`、运行时依赖、`src/`、`scripts/`、`LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`、`licenses/` |
| OCI 元数据 | source、version、revision、licenses、base.name |
| `compose.release.yml` | 无 build；app 与 maintenance 引用同一个 `SITE_IMAGE` |
| 源码归档 | `package.json` 版本可识别；无 `.git` 时提交留空 |
| 文档 | 本页、SECURITY、CONTRIBUTING、部署/升级/赞助说明 |

## 2. 构建

先确认工作树、版本与提交：

~~~bash
node -p "require('./package.json').version"
git status --short
git rev-parse HEAD
~~~

使用完整 40 位 SHA 构建：

~~~bash
IMAGE=ghcr.io/OWNER/sanjiang-resources \
VERSION="$(node -p "require('./package.json').version")" \
COMMIT_SHA="$(git rev-parse HEAD)" \
npm run image:build
~~~

等价于：

~~~bash
docker build \
  --build-arg VERSION="$VERSION" \
  --build-arg COMMIT_SHA="$COMMIT_SHA" \
  --build-arg SOURCE_URL="https://github.com/CreateCN/sanjiang-resources-sites" \
  -t "$IMAGE:$VERSION" .
~~~

- 默认构建只打包 `src/data/release-assets.json` 中许可明确的素材；三张授权未确认的历史截图及其派生图
  不会进入 `dist/client/images`。旧实例若仍引用它们，需确认权利后使用
  `INCLUDE_LEGACY_ASSETS=1` 显式构建兼容素材，或通过后台替换。默认构建对旧引用使用占位，不输出 404
  的 `img`/`srcset`。
- `COMMIT_SHA` 必须是完整 SHA；脚本会拒绝短 SHA。
- 兼容素材构建示例：`INCLUDE_LEGACY_ASSETS=1 IMAGE=... bash scripts/build-image.sh`。它保留旧 URL 与
  `picture`/`srcset` 行为，但不会自动下载或修改旧数据库；权利核查由部署者负责。
- 无 Git 的源码归档可以留空提交，但必须保留 `package.json` 版本；镜像的 `org.opencontainers.image.version` 仍然可读。
- 不要在发行镜像里放 `.env`、数据库、媒体或备份。

## 3. 验证镜像

可重复的验收脚本（CI 使用同一个）：

~~~bash
bash scripts/verify-image.sh "$IMAGE:$VERSION" "$VERSION" "$COMMIT_SHA"
~~~

脚本检查 OCI labels、许可文件、非 root 运行、管理员 CLI、Empty 初始化、整站备份/恢复与 HTTP 健康检查。以下命令用于人工复核：
docker image inspect "$IMAGE:$VERSION" --format '{{json .Config.Labels}}'
docker run --rm "$IMAGE:$VERSION" sh -c 'test -f LICENSE && test -f NOTICE && test -f THIRD-PARTY-NOTICES.md && ls scripts src >/dev/null'
docker run --rm -e DATABASE_PATH=/tmp/site.sqlite -e SITE_INIT_MODE=empty "$IMAGE:$VERSION" \
  node scripts/init-site.mjs --mode empty --name "发行检查"
docker run --rm -e DATABASE_PATH=/tmp/site.sqlite -e BACKUP_DIR=/tmp/backups "$IMAGE:$VERSION" \
  node scripts/backup-site.mjs
~~~

检查：

- labels 含 `org.opencontainers.image.source/version/revision/licenses`；
- 许可文件存在；
- `node scripts/...` 能运行（管理员、初始化、备份/恢复、链接检查、媒体对账）；
- 运行时没有开发依赖（`npm ls --omit=dev` 的依赖集合），但运维脚本依赖仍在；
- 容器以 `node` 用户运行，`/app/data` 可写。

## 4. 受控标签与发行工作流

工作流文件：`.github/workflows/release.yml`。

- 只由 `vX.Y.Z` / `vX.Y.Z-rc.N` 标签推送或手动 `workflow_dispatch` 触发；PR 不触发，也没有发布权限。
- `verify` job 校验标签格式、`package.json` 版本、标签提交与 checkout 提交一致，要求同一提交已有成功的 `ci.yml` 运行，并再运行 `check/test/build`。
- `image` job 只构建 `linux/amd64`，运行 `scripts/verify-image.sh`（OCI labels、许可、初始化、管理员、备份、恢复、健康检查）；只有该 job 有 `packages: write`。
- `release` job 只有 `contents: write`，读取镜像 job 的 digest 后创建 Release；不覆盖已存在的 Release。
- 镜像 digest 写入 `release-image.json`、Release notes 与附件；Tag、完整 SHA、版本、digest 可追溯。
- 元数据由 `scripts/release-metadata.mjs` 生成（tag/image/notes/field），workflow 不内联 `node -e`，避免 shell 剥离引号。
- 不构建多架构，不在 notes/标签中声明未验证的 arm64；需要多架构时另行验证并扩展工作流。
- Token 通过 stdin 传给 `docker login`，不写入文件、不打印到日志。

首次实际发布前，先在 Actions 里手动运行：

- `tag`：候选标签；
- `push_image`：false；
- `create_release`：false。

这是 dry-run：只构建并验收镜像，不推送、不创建 Release。确认日志、artifact 与 `verify-image.sh` 输出后再由维护者授权推送标签。实际发布由用户/维护者执行，不由 PR 或 agent 自动触发。

## 5. 推送与固定 digest

~~~bash
docker push "$IMAGE:$VERSION"
docker buildx imagetools inspect "$IMAGE:$VERSION"
~~~

把输出的 `sha256:...` 与仓库名拼成：

~~~text
ghcr.io/OWNER/sanjiang-resources@sha256:...
~~~

发行部署只使用 digest，不使用浮动 tag。升级时同时更新 digest；`compose.release.yml` 中 app 与 maintenance 只引用一个变量，因此不会出现两个版本。

`.env.release.example` 是必须入库的发行附件：`.gitignore` 对 `.env.*` 的例外只覆盖
`.env.example` 与 `.env.release.example`，真实 `.env` 仍被忽略。工作流在构建镜像/创建 Release 前
执行 `scripts/check-release-assets.mjs`，缺附件、示例含秘密项、错误 digest 占位或重复键都会在推送前失败。

## 6. 发行部署

复制示例并填入真实 digest、域名与备份目录：

~~~bash
cp .env.release.example .env
docker compose -f compose.release.yml up -d
~~~

也可以直接传环境变量：

~~~bash
SITE_IMAGE="ghcr.io/OWNER/sanjiang-resources@sha256:..." \
SITE_URL="https://example.org" \
BACKUP_HOST_DIR="/srv/sanjiang/backups" \
docker compose -f compose.release.yml up -d
~~~

- 无 `build:`，不读取源码；主机只需要 Docker 与 Compose。
- 首次启动默认 Empty；需要 Demo 时在第一次启动前用一次性容器执行 `init-site.mjs --mode demo`。
- `APP_PORT` 只改宿主端口，容器仍监听 4321。
- 反向代理、源 IP、TLS、备份与升级见 [Docker 部署](deploy-docker.md) 与 [升级与回滚](../ops/upgrade.md)。
- 管理员初始化：`docker compose -f compose.release.yml run --rm --no-deps app node scripts/create-admin.mjs`。

## 7. 支持范围

已验证：

- Linux amd64 上的 Docker；
- Node.js 24.x（源码部署）；
- 单机 SQLite + 本地媒体卷；
- Chromium 浏览器端到端与容器冒烟。

未验证，不承诺同等支持：

- Windows 容器、arm64 镜像、多机/外部数据库；
- 第三方 CDN/WAF 的具体组合（只提供配置原则）；
- 第三方广告 SDK、计费、自助投放。

发行前用目标平台实际跑一遍初始化、登录、备份、恢复；未验证的平台不要写进支持列表。

## 8. 许可

- `LICENSE` 保持 MIT 原文，不增补；
- `NOTICE` 说明代码与内容/商标的范围；
- `THIRD-PARTY-NOTICES.md` 列出运行时直接依赖与完整许可文件位置；
- 镜像内保留 `node_modules/*/LICENSE`（含 sharp 与 libvips）；
- 页面可隐藏归属，但分发镜像与源码归档不能删除许可文本。

## 9. 安全与渠道

- 漏洞报告遵循 [SECURITY.md](../../SECURITY.md)；
- 当前私密渠道标注为待配置，发布前必须由维护者启用 GitHub Private Vulnerability Reporting 或填写真实安全邮箱；
- 不要在发行说明中虚构安全联系方式或响应时限。

## 10. 发行检查清单

- [ ] `npm run check`、`npm test`、`npm run build` 通过
- [ ] admin/browser/instances/container smoke 通过
- [ ] 完整 SHA 构建，labels 可读
- [ ] 许可与 NOTICE 存在，第三方清单与依赖一致
- [ ] `compose.release.yml` 无 build，app/maintenance 同一 digest
- [ ] Release workflow dry-run 通过，Tag/完整 SHA/version/digest 写入 artifact
- [ ] `.env.release.example` 已纳入版本控制，附件检查通过
- [ ] 实际推送标签已获用户/维护者授权
- [ ] `npm run test:assets` 通过：默认镜像缺席旧截图，兼容镜像旧库 picture/srcset 可用
- [ ] 干净卷 Empty/Demo 初始化成功
- [ ] `npm run rehearsal:upgrade` 通过，记录旧/候选/恢复的 schema 与数据核对
- [ ] 管理员 CLI、备份、恢复、失败回滚可用
- [ ] 升级/回滚与支持范围文档更新
- [ ] SECURITY 渠道已确认，不再是“待配置”
