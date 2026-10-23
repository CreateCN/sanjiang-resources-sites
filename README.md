# 三匠资源站 / Sanjiang Resources

[![CI](https://github.com/CreateCN/sanjiang-resources-sites/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/CreateCN/sanjiang-resources-sites/actions/workflows/ci.yml)

可独立部署的开源学习资源目录程序。每个实例独立保存站点品牌、内容、账户、媒体与备份；实例名称、简介、页脚、声明与主题色由部署者在后台配置，可以与上游项目完全不同。公开站无需登录；后台支持管理员/编辑者分级协作、草稿与发布分离、版本历史、站内反馈与审计。

> 上游程序不代表任何学校、机构或资源提供方的采购、合作或授权，也不托管第三方软件与课程文件。资源条件以提供方最新说明为准；实例内容与声明由部署者负责。

## 项目发展历程

项目最初是面向三江学院学生的学习资源导航页，目标是把分散的软件、课程与校园可用资源整理成可检索的目录。随着内容维护、多人协作和部署场景增加，逐步演化为可独立部署的资源目录程序：

- **资源目录阶段**：建立分类、详情、核对时效、匿名反馈、图片与基础 SEO；公开站保持无需登录。
- **维护与安全阶段**：补齐草稿/发布分离、版本历史、图片优化、链接检查、访客分层限流、CSRF/同源校验、审计与离线恢复，并形成安全规范、部署与运维文档。
- **产品化阶段**：引入实例初始化（Empty/Demo）、品牌与主题、媒体库、TOTP 双因素、静态赞助、站点级备份恢复、维护进程与后台状态页，以及固定 digest 发行镜像和容器验收。
- **可靠性收口阶段**：第二轮复审修复恢复失败回滚遗漏 WAL 的数据安全问题，改为独立一致性快照保全，并在回滚后核对业务、媒体与完整性；同时补充硬中断手册和确定性回归测试。

项目现在更接近“可独立部署的资源目录基础设施”，而不是某个学校的固定页面。学校名称、内容、声明与素材权利由各实例部署者维护；上游不代替任何学校、机构或资源提供方作出授权或背书。

## 文档

| 文档 | 内容 |
|---|---|
| [功能清单](docs/FEATURES.md) | 已实现 / 未实现功能、明确不做与重新评估条件 |
| [配置与边界](docs/configuration.md) | 三层配置、环境变量、SITE_URL 与密钥边界 |
| [初始化](docs/initialization.md) | Empty/Demo、CLI、异常库接管、导入/恢复的区别 |
| [品牌与主题](docs/branding.md) | 品牌字段、媒体、强调色、issuer 与归属开关 |
| [静态赞助位](docs/sponsorship.md) | 数据、展示条件、URL/媒体校验、安全边界与运维 |
| [资源范围与政策](docs/resource-policy.md) | scope/access、审核、素材与非官方边界 |
| [升级与回滚](docs/upgrade.md) | 停写备份、升级顺序、回滚与硬中断恢复 |
| [升级回滚演练](docs/upgrade-rehearsal.md) | 旧版本 → 候选 → 数据恢复 → 旧版本的实际记录与复现脚本 |
| [图片与版权记录](public/images/CREDITS.md) | 每张截图的来源、许可与下架处理 |
| [运维手册](docs/operations.md) | 图片构建、维护进程、站点备份恢复与时间配置 |
| [发行与部署](docs/release.md) | 发行镜像构建、OCI 元数据、固定 digest、支持范围与检查清单 |
| [Docker 生产部署](docs/deploy-docker.md) | Compose 拓扑、端口与源 IP、反向代理容器、备份升级与排查 |
| [非 Docker 部署](docs/deploy-local.md) | systemd + Nginx 的宿主机安装、定时任务与备份恢复 |
| [边缘防护（CDN/CC/DDoS）](docs/edge-cdn-hardening.md) | 源站隐身、真实 IP、边缘限流、DCDN/WAF 升级与应急预案 |
| [安全设计与实现规范](docs/SECURITY-SPEC.md) | 身份/限流/输入输出/SSRF/响应头/验收清单等强制约束 |
| [安全评估档案](reports/security/README.md) | 历次安全评估报告、根因分析与证据索引 |
| [Agent 约定](docs/agents/domain.md) | 仓库的 issue tracker、标签与领域文档约定 |

## 快速开始

运行环境：Node.js 24.x、npm。运维脚本直接执行 TypeScript 源文件，需要 Node 24 的原生类型剥离。

```bash
npm ci
npm run dev          # http://localhost:4321
```

首次启动会创建 `./data/site.sqlite`，初始化一个**空站**（只有“综合资源”分类与默认品牌），**不会创建任何默认账户，也不会导入示例内容**。

需要示例内容时，在首次启动前显式初始化（已有实例不会被覆盖，也不会自动转换模式）：

```bash
npm run site:init -- --mode demo --name "你的实例名称"
# 或仅对本次启动生效
SITE_INIT_MODE=demo npm run dev
```

创建首个管理员（密码至少 12 字符）：

```bash
npm run db:admin
# 或非交互
ADMIN_USERNAME=你的用户名 ADMIN_PASSWORD='至少12位密码' node scripts/create-admin.mjs
```

登录 `/admin/login/` 后，可在“人员与权限”创建编辑者账户。

本地和宿主机部署中，**维护进程不会由 Web 应用自动启动**。需要独立运行 `npm run maintenance`（或配置 systemd timer/cron），否则后台“维护状态”会显示“尚未发现维护进程”，且不会自动执行备份、链接检查和指标清理。Docker Compose 已包含独立的 `maintenance` 容器。

### Docker（推荐）

```bash
cp .env.example .env                     # 至少把 SITE_URL 改成真实地址
docker compose up -d --build             # 首次启动默认 Empty
docker compose exec app node scripts/create-admin.mjs
```

需要 Demo 示例时，在第一次 `up` 之前用一次性容器初始化（详见 [初始化](docs/initialization.md)）：

```bash
docker compose build
docker compose run --rm --no-deps app node scripts/init-site.mjs --mode demo --name "示例站"
docker compose up -d
```

默认镜像只包含许可明确的截图；旧站仍需原 `/images` 时，确认权利后显式使用
`INCLUDE_LEGACY_ASSETS=1` 构建兼容素材（见 [发行与部署](docs/release.md)）。

完整步骤（端口/网络坑、反向代理容器、备份恢复、升级回滚、故障排查）见 [Docker 生产部署](docs/deploy-docker.md)。

### Docker 发行镜像（固定 digest）

生产环境优先使用发行 Compose：主机只拉取固定 digest，不构建源码，app 与 maintenance 使用同一镜像。

```bash
SITE_IMAGE="ghcr.io/OWNER/sanjiang-resources@sha256:..." \
SITE_URL="https://example.org" \
BACKUP_HOST_DIR="/srv/sanjiang/backups" \
docker compose -f compose.release.yml up -d
```

构建、标签、推送、验签与支持范围见 [发行与部署](docs/release.md) 与 [SECURITY.md](SECURITY.md)。

### 非 Docker（宿主机）

没有 Docker 时用 systemd + Nginx 直接跑生产构建，步骤与安全配置见 [非 Docker 部署](docs/deploy-local.md)。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `SITE_URL` | `http://localhost:4321` | 站点绝对地址；决定 canonical、分享链接、Origin 校验与 Cookie `Secure`（含 TOTP 挑战 Cookie） |
| `SITE_INIT_MODE` | `empty` | 仅作用于新库：`empty` 空站 / `demo` 示例站；已有实例只迁移，不转换模式 |
| `SITE_INIT_NAME` | `三匠资源站` | 新实例的初始名称，同时冻结为 TOTP issuer；之后可在后台改品牌，issuer 不变 |
| `TRUST_PROXY` | `0`（compose 中为 `1`） | 是否信任代理写入的单值 `X-Forwarded-For`；关闭时按站点共享限流 |
| `DATABASE_PATH` | `./data/site.sqlite` | SQLite 文件；容器内为 `/app/data/site.sqlite` |
| `BACKUP_DIR` | `./backups` | 备份目录；容器内挂载到宿主机 |
| `BACKUP_KEEP` | `7` | 保留备份份数 |
| `BACKUP_HOST_DIR` | `./backups` | Compose 中宿主机备份目录 |
| `HOST` / `PORT` | `0.0.0.0` / `4321` | 监听地址与端口 |
| `MEDIA_DIR` | `./data/media` | 上传图片与不可变文件组；容器内 `/app/data/media`（与 DB 同卷） |
| `MEDIA_QUOTA_BYTES` | `536870912`（512 MiB） | 媒体总预算（含下架与未结算预留） |
| `MEDIA_MIN_FREE_BYTES` | `134217728`（128 MiB） | 落盘必须保留的磁盘余量 |
| `TOTP_ENC_KEY` | 无 | 32 字节 base64url，加密 TOTP 密钥；缺失时双因素启用/验证 fail-closed |
| `TOTP_REQUIRED_FOR` | `off` | `off`/`admin`/`admin,editor`；切换前必须先跑 `npm run totp:policy` |

环境变量示例见 [.env.example](.env.example)。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 本地开发 |
| `npm run site:init -- --mode empty\|demo [--name 名称]` | 初始化新实例；异常库需额外 `--adopt` |
| `npm run build` | 类型检查并构建 `dist/` |
| `npm start` | 生产模式启动 `dist/server/entry.mjs` |
| `npm run check` | Astro / TypeScript 检查 |
| `npm test` | 内容、后端、初始化、Markdown、链接检查、备份、恢复与迁移等单元/集成测试 |
| `npm run test:instances` | 两实例隔离（Empty + Demo，同用户名、Cookie 不互通） |
| `bash scripts/container-smoke.sh` | 容器级安装/导入/备份/恢复/回滚/旧库升级（需要 Docker） |
| `npm run maintenance` | 启动维护进程：心跳、定时备份、链接检查与指标清理 |
| `npm run test:admin` | 后台端到端 36 项（自动临时数据库与端口） |
| `npm run test:browser` | 前台只读交互 10 项（需先启动带夹具的测试服务，且本机有 Chrome） |
| `npm run db:admin` | 创建管理员 |
| `npm run db:backup` | 数据库诊断快照（不含媒体，不能替代站点备份） |
| `npm run db:restore` | 离线恢复（先停止所有数据库使用者，见“备份与恢复”） |
| `npm run links:check` | 批量检查已发布资源链接（手动/定时均可） |
| `npm run totp:reset -- <用户名> --reason "…" --yes` | 离线重置某账户双因素（唯一管理员丢设备时的兜底） |
| `npm run totp:policy -- --from off --to admin --yes` | 离线撤销受影响账户的旧认证证明，再改环境变量重启 |
| `npm run media:reconcile` | 媒体离线对账（默认 dry-run；`--yes` 执行，`--clear-guard` 确认写入者已停止） |
| `npm run site:backup` | 站点级备份：DB + 全部媒体对象 + 哈希清单（离线一致性） |
| `npm run site:restore -- --backup <批次目录> --yes` | 站点级恢复：暂存校验 → 迁移与认证净化 → 可回滚切换 |

浏览器测试默认使用 `/usr/bin/google-chrome`，可通过 `CHROME_PATH`、`TEST_BASE_URL` 覆盖。CI 在 Node 24 上执行 check → test → build、实例隔离、后台端到端、生产服务器冒烟与公开浏览器测试，并额外执行容器冒烟及默认/兼容素材验收。

## 部署要点

- 端口默认只绑定 `127.0.0.1:4321`，对外必须放在 HTTPS 反向代理（Nginx/Caddy）后面。
- 上公网前先做**源站隐身**：Nginx 只允许 CDN 回源段与运维 IP，直连 `return 444`；否则源站 IP 一旦泄露，CDN 层防护可被完全绕过。见 [边缘防护](docs/edge-cdn-hardening.md)。
- 有 CDN 时必须 `set_real_ip_from` + `real_ip_header` 还原访客 IP，否则 `limit_req` 与应用按访客限流都会退化成"全站一个桶"。
- 边缘层再加 `limit_req`/`limit_conn` 抗 CC（应用层限流负责业务语义，两层不冲突）。
- 数据（SQLite + `media/`）在命名卷 `site-data`，备份写到宿主机目录；`docker compose down -v` 会删除全部数据。
- `/media/` **必须**转发到应用（每次请求实时查库、`no-store`）。**禁止**在 Nginx 用 `alias`/`root` 直出媒体目录，也禁止 CDN 缓存该路径——否则下架后旧 URL 仍可取到图片。
- 上传体积：应用上限 5 MiB + 64 KiB，代理 `client_max_body_size` 取 `6m` 或更大。
- `SITE_URL` 必须与浏览器地址一致（协议 + 域名 + 端口）；HTTPS 地址会自动给会话 Cookie 加 `Secure`。
- 反向代理必须**覆盖写入**客户端地址，而不是透传客户端的值：

  ```nginx
  proxy_set_header X-Forwarded-For $remote_addr;   # 覆盖，保证只有一个值
  proxy_set_header X-Real-IP       $remote_addr;
  proxy_set_header X-Forwarded-Proto https;
  ```

  同时设置 `TRUST_PROXY=1`（compose 默认开启）。应用只接受"单个合法 IP"作为限流身份；缺失、畸形或含多个地址的转发头一律退化为站点级熔断桶，不会被当作访客身份。若不设置 `TRUST_PROXY`，应用会忽略转发头，此时所有访客共享同一个来源桶（只适合内网试运行）。详见 [安全设计与实现规范](docs/SECURITY-SPEC.md)。
- 忘记管理员密码没有邮件找回：在服务器上再创建一位管理员，或谨慎地直接操作数据库。

## 备份与恢复

**含媒体上传的站点必须使用站点级备份**：`db:backup` 只包含 SQLite，是诊断快照；
用它恢复会让数据库指向不存在的图片（`restore-db` 在发现媒体登记时会直接拒绝，
并提示改用 `restore-site`）。

```bash
npm run site:backup                                  # DB + media/objects + manifest + COMPLETE
npm run site:restore -- --backup ./backups/site-… --yes
```

站点备份/恢复都要求离线：先停止 app、maintenance 与所有手动媒体任务。备份前会检查
媒体占位为空、对象哈希完整；恢复会在暂存位置完成校验、迁移与认证净化（清空会话/挑战/
恢复码、递增 `auth_version`、抬升 TOTP 步数下限），切换失败按日志回滚。

```bash
npm run db:backup                                    # 本地（仅数据库诊断快照）
docker compose exec app node scripts/backup-db.mjs   # 容器
```

备份使用 `VACUUM INTO`，随后执行 `PRAGMA integrity_check` 并输出资源/指南/账户/反馈/版本计数，文件权限 `0600`。

恢复必须离线进行：先停止应用、`maintenance`/定时任务和所有手动数据库脚本，并确认没有进程持有 `DATABASE_PATH` 或它的 `-wal`/`-shm`。不要直接用 `cp` 覆盖主库——遗留 WAL 会把备份后的写入带回，或造成索引损坏。

```bash
npm run db:restore -- --backup ./backups/site-YYYY-MM-DD.sqlite --yes
# Docker：docker compose stop app maintenance
#        docker compose run --rm --no-deps app node scripts/restore-db.mjs \
#          --backup /app/backups/site-YYYY-MM-DD.sqlite --yes
```

工具会先校验备份完整性、必要表和 schema 兼容性；把当前主库及 sidecar 保全到 `site.sqlite.restore-*`；删除旧 `-wal`/`-shm` 后原子替换，并在恢复后复查完整性与表计数。失败时退出非零并保留诊断目录，替换后的复查失败会尝试回滚。工具只能检查同一 PID 命名空间内的进程；Docker 跨容器和共享卷的前置条件必须人工确认。恢复后再做 `/api/health/`、首页与后台登录冒烟检查。建议每季度演练一次。

备份含密码哈希、反馈正文与版本历史，**不要提交到仓库**；`backups/` 已忽略。

## 权限与安全

| 能力 | 管理员 | 内容编辑者 |
|---|---|---|
| 草稿编辑、整页预览、链接检查、反馈与复核 | ✓ | ✓ |
| 发布 / 撤回 / 收进回收站 | ✓ | — |
| 分类、人员、首页编排、导入导出、回收站恢复 | ✓ | — |
| 数据概览、操作记录 | ✓ | — |

- 密码 scrypt 哈希；会话令牌仅存哈希、8 小时有效，`HttpOnly` + `SameSite=Strict`。
- 写操作逐次校验角色、CSRF、同源 Origin；登录与反馈限流；审计与变更同事务。
- 健康检查 `/api/health/` 会查询数据库，返回 `{status, db, schema, uptime}`。
- 请求日志为 JSON 行，不记录查询串、IP、UA。

更细的边界、未实现项与已知限制见 [功能清单](docs/FEATURES.md)。

## 上线前核对

- 创建管理员与至少一位编辑者；配置真实 HTTPS 域名与 `SITE_URL`。
- 完成一次备份恢复演练，确认备份卷在仓库之外。
- 检查图片版权状态：未确认授权的截图已标注并提供下架入口，收到通知后移除或替换。
- 用真实设备检查登录、草稿、发布、撤回、反馈与手机端关键任务。
- 浏览器测试与真实设备可用性检查不能互相替代。

## 项目结构

```text
src/
├── components/        资源详情、指南正文、版本历史
├── layouts/           公开站与后台布局
├── lib/               数据读取、Markdown、时效、导入、字段校验
├── pages/             公开页、后台页、API、sitemap/robots
├── server/            SQLite、认证、权限、设置、链接检查、日志、迁移
└── styles/            公开站与后台样式
scripts/               建管理员、备份/恢复、批量链接检查、维护
tests/                 Node、后台端到端、浏览器测试
docs/                  产品、部署、安全、设计与 Agent 文档
```

## 内容维护

示例数据在 `src/data/demo.ts`，**只在显式初始化 Demo 时导入**；新站默认 Empty，此后内容以数据库为准，通过后台维护。业务测试夹具在 `tests/fixtures/content.ts`，产品代码不引用它；直接修改这些文件不会更新已有站点。

未发布的内容不会进入前台、sitemap 或统计；删除是软删除，可恢复为草稿后重新发布。

## 已知限制

- 单机 SQLite + app/maintenance 两个进程（可同机容器），无多机、高可用或读写分离。
- 无邮件服务：无密码找回、无邮件/webhook 通知；后台以公告板提示待办。
- 链接检查是提示而非判决，不会自动下架。
- 图片上传、全文搜索、多语言、学生账户、评论、AI 问答、定时发布均未实现，详见 [功能清单](docs/FEATURES.md)。

## 支持范围

- 支持 Node.js **24.x**；Docker 镜像在 Linux amd64 上验证。
- 单机 SQLite + 本地媒体；不承诺多机、高可用或外部数据库。
- 未验证：Windows 容器、arm64 镜像、第三方 CDN/WAF 的具体组合。
- 安全渠道与支持版本见 [SECURITY.md](SECURITY.md)。

## 开源协议

代码（`src/`、`scripts/`、`tests/`、构建配置）以 [MIT 协议](LICENSE) 发布，版权归 CreateCN。项目地址：<https://github.com/CreateCN/sanjiang-resources-sites>。许可范围之外的附注见 [NOTICE](NOTICE)，运行时依赖与完整许可文件位置见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；`LICENSE` 保持 MIT 原文不做增补，以便 GitHub 正确识别协议。

MIT 只覆盖代码。资源条目中的第三方项目名称、商标、官方文案与界面截图，权利归各提供方；站内收录的软件、课程与服务也不因本项目开源而改变其授权条件。图片的来源、许可与下架记录见 [public/images/CREDITS.md](public/images/CREDITS.md)。

自建部署请保留版权声明与许可文本，并在后台替换站点名称、免责说明与资源来源，避免让人误以为由本项目或任何学校、机构背书。
