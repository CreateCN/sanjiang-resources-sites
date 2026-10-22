# 三江资源

[![CI](https://github.com/CreateCN/sanjiang-resources-sites/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/CreateCN/sanjiang-resources-sites/actions/workflows/ci.yml)

面向三江学院学生的非官方开源工具与免费学习资源目录。公开站无需登录；后台支持管理员/编辑者分级协作、草稿与发布分离、版本历史、站内反馈与审计。

> 本项目不代表三江学院采购、合作或授权，也不托管第三方软件与课程文件。资源条件以提供方最新说明为准。

## 文档

| 文档 | 内容 |
|---|---|
| [功能清单](docs/FEATURES.md) | 已实现 / 未实现功能、明确不做与重新评估条件 |
| [图片与版权记录](public/images/CREDITS.md) | 每张截图的来源、许可与下架处理 |
| [运维手册](docs/operations.md) | 图片构建、Docker Compose 定时任务与时间配置 |
| [Docker 生产部署](docs/deploy-docker.md) | Compose 拓扑、端口与源 IP、反向代理容器、备份升级与排查 |
| [非 Docker 部署](docs/deploy-local.md) | systemd + Nginx 的宿主机安装、定时任务与备份恢复 |
| [边缘防护（CDN/CC/DDoS）](docs/edge-cdn-hardening.md) | 源站隐身、真实 IP、边缘限流、DCDN/WAF 升级与应急预案 |
| [安全设计与实现规范](docs/SECURITY-SPEC.md) | 身份/限流/输入输出/SSRF/响应头/验收清单等强制约束 |
| [安全评估档案](reports/security/README.md) | 历次安全评估报告、根因分析与证据索引 |
| [Agent 约定](docs/agents/domain.md) | 仓库的 issue tracker、标签与领域文档约定 |

## 快速开始

运行环境：Node.js 22.12+（推荐 24）、npm。

```bash
npm ci
npm run dev          # http://localhost:4321
```

首次访问会创建 `./data/site.sqlite` 并导入 12 条种子资源，**不会创建任何默认账户**。创建首个管理员（密码至少 12 字符）：

```bash
npm run db:admin
# 或非交互
ADMIN_USERNAME=你的用户名 ADMIN_PASSWORD='至少12位密码' node scripts/create-admin.mjs
```

登录 `/admin/login/` 后，可在“人员与权限”创建编辑者账户。

### Docker（推荐）

```bash
cp .env.example .env                     # 至少把 SITE_URL 改成真实地址
docker compose up -d --build
docker compose exec app node scripts/create-admin.mjs
```

完整步骤（端口/网络坑、反向代理容器、备份恢复、升级回滚、故障排查）见 [Docker 生产部署](docs/deploy-docker.md)。

### 非 Docker（宿主机）

没有 Docker 时用 systemd + Nginx 直接跑生产构建，步骤与安全配置见 [非 Docker 部署](docs/deploy-local.md)。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `SITE_URL` | `http://localhost:4321` | 站点绝对地址；决定 canonical、分享链接、Origin 校验与 Cookie `Secure` |
| `TRUST_PROXY` | `0`（compose 中为 `1`） | 是否信任代理写入的单值 `X-Forwarded-For`；关闭时按站点共享限流 |
| `DATABASE_PATH` | `./data/site.sqlite` | SQLite 文件；容器内为 `/app/data/site.sqlite` |
| `BACKUP_DIR` | `./backups` | 备份目录；容器内挂载到宿主机 |
| `BACKUP_KEEP` | `7` | 保留备份份数 |
| `BACKUP_HOST_DIR` | `./backups` | Compose 中宿主机备份目录 |
| `HOST` / `PORT` | `0.0.0.0` / `4321` | 监听地址与端口 |

环境变量示例见 [.env.example](.env.example)。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 本地开发 |
| `npm run build` | 类型检查并构建 `dist/` |
| `npm start` | 生产模式启动 `dist/server/entry.mjs` |
| `npm run check` | Astro / TypeScript 检查 |
| `npm test` | 内容、后端、Markdown、链接检查、备份、恢复与迁移等 120 项 |
| `npm run test:admin` | 后台端到端 28 项（自动临时数据库与端口） |
| `npm run test:browser` | 前台只读交互 9 项（需先启动 dev，且本机有 Chrome） |
| `npm run db:admin` | 创建管理员 |
| `npm run db:backup` | 一致性备份 |
| `npm run db:restore` | 离线恢复（先停止所有数据库使用者，见“备份与恢复”） |
| `npm run links:check` | 批量检查已发布资源链接（手动/定时均可） |

浏览器测试默认使用 `/usr/bin/google-chrome`，可通过 `CHROME_PATH`、`TEST_BASE_URL` 覆盖。CI 在 Node 24 上执行 check → test → build 与生产服务器冒烟，不运行浏览器测试。

## 部署要点

- 端口默认只绑定 `127.0.0.1:4321`，对外必须放在 HTTPS 反向代理（Nginx/Caddy）后面。
- 上公网前先做**源站隐身**：Nginx 只允许 CDN 回源段与运维 IP，直连 `return 444`；否则源站 IP 一旦泄露，CDN 层防护可被完全绕过。见 [边缘防护](docs/edge-cdn-hardening.md)。
- 有 CDN 时必须 `set_real_ip_from` + `real_ip_header` 还原访客 IP，否则 `limit_req` 与应用按访客限流都会退化成"全站一个桶"。
- 边缘层再加 `limit_req`/`limit_conn` 抗 CC（应用层限流负责业务语义，两层不冲突）。
- 数据在命名卷 `site-data`，备份写到宿主机目录；`docker compose down -v` 会删除全部数据。
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

```bash
npm run db:backup                                    # 本地
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
docs/                  功能清单与 Agent 约定
```

## 内容维护

种子数据在 `src/data/resources.ts`，**只在数据库首次初始化时导入**；此后内容以数据库为准，通过后台维护。直接修改种子文件不会更新已有站点。

未发布的内容不会进入前台、sitemap 或统计；删除是软删除，可恢复为草稿后重新发布。

## 已知限制

- 单机 SQLite + 单容器，无多机或高可用。
- 无邮件服务：无密码找回、无邮件/webhook 通知；后台以公告板提示待办。
- 链接检查是提示而非判决，不会自动下架。
- 图片上传、全文搜索、多语言、学生账户、评论、AI 问答、定时发布均未实现，详见 [功能清单](docs/FEATURES.md)。

## 开源协议

代码（`src/`、`scripts/`、`tests/`、构建配置）以 [MIT 协议](LICENSE) 发布，版权归三江资源项目贡献者。项目地址：<https://github.com/CreateCN/sanjiang-resources-sites>。

MIT 只覆盖代码。资源条目中的第三方项目名称、商标、官方文案与界面截图，权利归各提供方；站内收录的软件、课程与服务也不因本项目开源而改变其授权条件。图片的来源、许可与下架记录见 [public/images/CREDITS.md](public/images/CREDITS.md)。

自建部署请保留版权声明与许可文本，并替换站点名称、免责说明与资源来源，避免让人误以为由本项目或三江学院背书。
