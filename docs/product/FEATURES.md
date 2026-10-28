# 功能清单

本文按“已实现 / 未实现”列出三江资源站的功能与边界。README 只保留安装、部署与运维入口；具体行为、限制与实现位置在这里维护。

状态说明：**✅ 已实现** · **◻ 未实现**（含计划、暂缓与明确不做）。

## 公共站

| 状态 | 功能 | 说明 | 位置 |
|---|---|---|---|
| ✅ | 资源目录 | 分类书架、搜索、类型筛选、平台筛选，关键词/分类/类型/平台可组合，状态写入网址 | `src/pages/index.astro` |
| ✅ | 资源详情 | 用途、费用与许可、资格、门槛、限制、平台、三步入门、官方链接、来源核对状态 | `src/components/ResourceDetail.astro` |
| ✅ | 使用门槛 | 无需申请 / 需学生认证 / 需校园网 / 需申请审核 / 有条件使用 / 门槛待确认；未填写时显示“待确认” | `src/lib/access.ts` |
| ✅ | 数据时效 | 详情页显示“资料核对于 X 天前”；超期提示“可能已变化，使用前请复核”，不判定失效 | `src/lib/freshness.ts` |
| ✅ | 列表时效与门槛 | 目录与场景页的状态列复用同一套 180/90 天规则：已核对但超期显示“核对已过期·建议使用前复核”，待核对不误报；场景页同时显示使用门槛 | `src/pages/index.astro`、`src/pages/scenarios/[id].astro` |
| ✅ | 停用解释页 | 停用资源移出目录/搜索/sitemap 并 `noindex`，详情页仍可访问，说明停用日期、原因与替代资源；旧链接与指南引用不会 404 | `src/server/store.ts`、`src/components/ResourceDetail.astro` |
| ✅ | 处理记录公告 | 已解决反馈可由维护者另写公告（标题/说明），首页“反馈已处理”与 `/updates/` 展示；不公开反馈正文与内部备注；关联资源撤回/删除后保留公告正文但不再输出 404 链接，停用解释页仍可链接 | `src/pages/updates.astro` |
| ✅ | 使用指南 | `/guides/` 与 `/guides/<slug>/`，Markdown 正文，可关联资源；资源详情反向展示相关指南 | `src/pages/guides/` |
| ✅ | 场景落地页 | `/scenarios/<分类>/`：场景说明、该分类资源、相关指南、切换场景 | `src/pages/scenarios/[id].astro` |
| ✅ | 匿名反馈 | 无需登录；蜜罐、限流、同源校验；成功后才显示回执；支持“链接失效 / 版权与下架”等类型 | `src/pages/feedback.astro` |
| ✅ | 图片版权提示 | 未确认授权的图片标注“网络图片，来源与授权未确认”，提供版权下架入口 | `src/components/ResourceDetail.astro` |
| ✅ | SEO 与分享 | canonical、Open Graph、Twitter Card、默认分享图、`WebSite`/`BreadcrumbList`/`ItemList` 结构化数据 | `src/layouts/Layout.astro` |
| ✅ | sitemap / robots | 只列已发布资源与指南；后台与 API 禁止抓取 | `src/pages/sitemap.xml.ts`、`robots.txt.ts` |
| ✅ | 响应式与无障碍 | 320–1440 无横向溢出、跳转链接、可见焦点、键盘筛选、减少动态效果 | `tests/browser.mjs` |
| ✅ | 无 JS 可用 | 目录、详情、指南、反馈表单在禁用 JavaScript 时仍可阅读与提交 | `tests/browser.mjs` |
| ✅ | 匿名聚合指标 | 详情/指南浏览、官方外跳、零结果搜索按天计数，不存 IP/UA；后台管理员看 Top 10 | `src/pages/admin/metrics.astro` |
| ◻ | 全文搜索 | 当前为客户端子串过滤；资源量变大后计划引入构建时索引或 FTS | — |
| ◻ | RSS / 邮件订阅 | 更新频率与合规成本未验证，暂缓 | — |
| ◻ | 多语言 | 受众为中文，不排期 | — |
| ◻ | 学生账户 / 收藏 / 学习进度 | 认证、隐私与找回成本高，未验证需求 | — |
| ◻ | 评论 / 评分 / 社区问答 | 需要审核与治理能力，暂缓 | — |
| ◻ | 移动端性能优化 | 已生成 320/640/960/1280 WebP 并用 `<picture>` 输出（`ResourceImage.astro`、`scripts/optimize-images.mjs`）；公开页仍 `no-store`，未做 CDN 缓存 | — |

## 内容与编辑

| 状态 | 功能 | 说明 | 位置 |
|---|---|---|---|
| ✅ | Markdown 字段 | 简介/许可/资格/限制/步骤按内联 Markdown；新增 `details` 长文字段按完整 Markdown | `src/lib/markdown.ts` |
| ✅ | Markdown 安全 | 禁用原始 HTML；拒绝 `javascript:`/`data:` 链接；外链加 `target`/`rel`；图片只允许规范化后仍位于 `/images/` 或已登记 `/media/<sha256>.webp` 的站内路径，远程、协议相对、`data:` 与路径绕过不生成图片元素；正文、内联字段与后台预览共用同一规则 | `src/lib/markdown.ts` |
| ✅ | 指南编辑 | 标题、摘要、正文、关联资源；草稿/发布/撤回 | `src/pages/admin/guides/` |
| ✅ | 草稿与发布快照 | 公开站只读已发布快照；编辑者保存只改草稿，管理员发布后生效 | `src/server/store.ts` |
| ✅ | 版本历史 | 保存/发布/撤回/恢复均留快照，保留最近 50 条；逐字段对比；恢复只改草稿；缺分类可选替代分类，缺资源关联需显式勾选移除才恢复；版本号永不复用（删除重建也不会回到 v1） | `src/components/RevisionHistory.astro` |
| ✅ | 草稿整页预览 | 登录后按真实前台样式预览，`noindex`、不写快照、不计浏览 | `src/pages/admin/preview/` |
| ✅ | 未保存输入备份 | 每次加载生成独立归属键（`window.open` 带 opener 也不会共用），兼容旧格式键并自动迁移；保存只清理自己的（或内容完全相同的）备份；多份分歧备份可逐份查看/恢复，最新备份与服务器相同不遮挡更早内容 | `src/scripts/draft-recovery.ts` |
| ✅ | 回收站 | 软删除；前台/sitemap 立即消失；恢复为草稿；彻底删除清历史；资源仍被指南草稿或公开快照引用时拒绝彻底删除并列出指南，已有悬空关联必须在编辑页显式勾选移除 | `src/pages/admin/trash.astro`、`src/server/store.ts` |
| ✅ | 实例初始化 | 新库默认 Empty（一个综合分类、0 资源）；显式 Demo 只含 2 条通用示例并显示演示横幅；`site:init` 支持 `--mode/--name/--adopt`；有业务数据但缺标记的库拒绝自动写入。旧库只迁移，不灌种子 | `src/server/initialization.ts`、`scripts/init-site.mjs` |
| ✅ | 实例品牌 / 主题 | 后台修改名称、简介、页脚、声明、Logo/favicon/分享图、强调色与归属开关；媒体校验与回退、对比度校验、派生 hover/浅色；TOTP issuer 按实例冻结 | `src/server/site-config.ts`、`src/pages/admin/settings.astro` |
| ✅ | 适用范围 scope | `unknown/global/institutions`；与 access 独立；旧快照兼容投影；草稿/公开隔离；编辑器、历史差异/恢复、目录、场景、详情、导入导出全链路；原 12 条待人工审核 | `src/lib/resource-scope.ts`、`src/server/store.ts` |
| ✅ | 备份恢复可靠性 | 三个 DB 入口共用未知迁移拒绝；manifest 记录软件/Commit/迁移；暂存迁移+净化后核对业务数量与摘要；品牌/设置完整性；切换失败自动回滚；硬中断有阶段日志与离线恢复步骤 | `scripts/restore-site.mjs`、`src/server/restore-verify.ts` |
| ✅ | 导入导出 | 导出版本 3：草稿/发布快照/分类/设置 + 媒体元数据（不含二进制）+ 安全品牌投影；可导入无版本/v1/v2 旧文件，未来版本写入前拒绝。导入**必须**先预检：计划冻结条目身份（版本 + uid）、归一化内容摘要、缺失媒体、首页设置指纹与品牌指纹/图片状态，期间改动整批取消；首页设置与品牌分别勾选、默认不选；缺图默认逐条拒绝；失败条目与原因保留在结果页（最近 20 次）；只写草稿 | `src/lib/importer.ts` |
| ✅ | 首页编排 | 精选资源与场景文案存 `settings` 表，管理员可改，保存即时生效；精选候选与服务端校验都只接受仍在公开目录（已发布、未删除、未停用）的资源，配置不可用时不再静默换成其他资源 | `src/pages/admin/settings.astro` |
| ✅ | 分类管理 | 稳定 ID；`all` 是保留标识（前台虚拟书架），导入同样拒绝；被草稿或发布快照引用时禁止删除 | `src/pages/admin/categories.astro` |
| ✅ | 图片授权状态 | 资源记录 `imageRights` 与 `imageCredit`，未确认时前台提示 | `src/lib/resource-schema.ts` |
| ◻ | 内容冲刺 | 新站默认 Empty；Demo 仅 2 条示例、0 篇指南。部署者需替换为实际核对内容，另行规划任务指南与资源扩充（非代码功能） | — |
| ✅ | 图片上传 / 媒体库（P0） | 编辑页上传本地 PNG/JPEG/WebP（≤5 MiB），服务端按 magic bytes + 解码校验、按 EXIF 方向旋转后重编码 WebP、剥离 EXIF/GPS/XMP/ICC，生成 320/640/960/1280/1920 变体与哈希清单；内容寻址不可变文件组、失败只清理自己的暂存、跨进程操作占位与容量预留；`/media/` 每次请求实时查库、全部 `no-store`；管理员可下架/恢复/彻底删除（彻底删除需无任何引用并留墓碑）；编辑页"移除"只解除草稿关联 | `src/server/media.ts`、`src/server/media-http.ts`、`src/server/media-references.ts`、`src/pages/admin/media.astro` |
| ✅ | 静态赞助（P2） | 后台赞助 CRUD/启停/删除与总开关；固定“广告 · 赞助”标签；只展示本地图片或纯文本，不加载第三方脚本/像素/广告 Cookie；外链 `rel="sponsored noopener noreferrer"`，不进入资源外跳统计；目录推广独立于资源列表与 ItemList；关闭/空/过期/缺图不渲染容器；外链显示 hostname | `src/pages/admin/sponsors/`、`src/components/SponsorSlot.astro`、`src/server/sponsors.ts` |
| ◻ | 媒体库列表增强 / 在线裁剪 | P1：媒体选择器、自动 GC 任务、跨环境登记；在线裁剪、滤镜与公开上传未实现 | — |
| ◻ | 定时发布 | 只有手动发布；无计划发布时间 | — |

## 后台治理

| 状态 | 功能 | 说明 | 位置 |
|---|---|---|---|
| ✅ | 分级权限 | 管理员：发布/撤回/删除/分类/人员/设置/导入；编辑者：草稿、反馈、复核、链接检查 | `src/server/store.ts` |
| ✅ | 公告板 | 站内待办：待发布草稿、新反馈、处理中、到期复核；不发邮件、不接 webhook | `src/pages/admin/notices.astro` |
| ✅ | 待发布队列 | 概览与公告板聚合“从未发布 / 有未发布修改”的草稿（资源与指南），显示等待天数，发布后自动消失；只做站内提示，不发外部通知 | `src/lib/notices.ts`、`src/pages/admin/index.astro` |
| ✅ | 反馈处理与并发 | 处理反馈时可选该资源的一次快照，服务端校验归属；处理状态/备注带版本号，旧表单提交返回冲突提示，不覆盖他人备注 | `src/pages/admin/reports.astro` |
| ✅ | 反馈公告发布 | 标记“已解决”后可勾选发布前台公告（标题 ≤120、说明 ≤600），可随时撤下；公告文案必须另写，绝不复用反馈正文 | `src/server/store.ts`、`src/pages/admin/reports.astro` |
| ✅ | 停用与替代 | 管理员可停用已发布资源并指定替代资源与说明；停用是独立的公开可见性状态，不写入草稿快照，因此不会顺手发布未复核的草稿改动；资源列表/概览/复核队列明确标记停用，后台同时区分目录条目与公开快照；无公开快照时不显示可立即恢复的按钮并提供先发布的路径；恢复后立即回到目录 | `src/pages/admin/resources/[id].astro` |
| ✅ | 人员表单并发 | `users.version` 乐观锁；旧人员页面提交停用/角色变更返回 409，不能重新启用已停用账户；最后一位有效管理员保护、实时权限校验与会话撤销保持不变 | `src/pages/admin/users.astro`、`src/server/migrations.ts` |
| ✅ | 复核队列与批量复核 | 按类型到期（180/90 天）；勾选多条批量标记已核对/待核对；复核绑定页面显示的那一版，期间被改过的条目跳过并提示重新核对 | `src/pages/admin/reviews.astro` |
| ✅ | 操作审计 | 内容、分类、人员、反馈、设置、导入等变更与审计同事务（导入按条写审计，审计失败该条一起回滚） | `src/pages/admin/audit.astro` |
| ✅ | 数据概览 | 近 30 天浏览/外跳/指南/零结果 Top 10 | `src/pages/admin/metrics.astro` |
| ✅ | 链接检查 | 手动按钮（草稿）+ `npm run links:check`（公开快照）；记录目标 URL、版本与检查对象，列表与详情共用同一份过期判断；只记录，不下架；403/429 需人工确认 | `src/server/linkcheck.ts` |
| ◻ | 外部通知 | 邮件、企业微信/飞书 webhook 未实现；当前仅在后台公告板提示 | — |
| ◻ | 多角色审批流 | 仅管理员/编辑者两角色；无逐级审核 | — |
| ◻ | 邮件找回密码 | 忘记密码只能在服务器上再建管理员 | — |
| ✅ | 双因素认证（TOTP，P0） | 服务端二维码（`qrcode`）+ 6 位验证确认后启用；挑战一次性（5 分钟、绑定用途/客户端/`auth_version`、5 次失败作废）；AES-256-GCM 加密密钥；10 个一次性恢复码；`off/admin/admin,editor` 强制策略需配套离线撤销命令；管理员重置、`totp:reset` CLI、旧库恢复净化；启用/停用/重生成/重置四个动作要求**新鲜证明**，并按操作者计 `proof-user` / `proof-client` 失败预算 | `src/server/totp.ts`、`src/server/auth.ts`、`src/server/account.ts`、`src/pages/admin/security.astro` |
| ◻ | 公开投稿后台 | 推荐类内容走匿名反馈，人工整理；无投稿工作流 | — |

## 运维与质量

| 状态 | 功能 | 说明 | 位置 |
|---|---|---|---|
| ✅ | 数据库迁移 | `schema_migrations` + 顺序迁移；旧库自动补齐列 | `src/server/migrations.ts` |
| ✅ | 数据库备份 | `VACUUM INTO` + 完整性校验 + 权限 0600 + 保留份数；只是诊断快照，不是媒体站点备份 | `scripts/backup-db.mjs` |
| ✅ | 站点备份 / 恢复（P0） | `site:backup`：先要求无未结算媒体操作与完整对象，再生成 DB 快照 + 全部对象 + 哈希清单，最后写 `COMPLETE`；`site:restore`：暂存校验、迁移 + 认证净化、按日志切换并可回滚。回退使用 `VACUUM INTO` 独立一致性快照（包含原库匹配的已提交 WAL），核对原业务、媒体与完整性后才记录 `rollback-verified`；缺文件/哈希不符/未知迁移拒绝 | `scripts/backup-site.mjs`、`scripts/restore-site.mjs`、`src/server/restore-prepare.ts` |
| ✅ | 媒体离线对账 | 默认 dry-run；未提交对象隔离、占位需显式 `--clear-guard`、哈希不符保持上传暂停 | `scripts/reconcile-media.mjs` |
| ✅ | 恢复流程 | 离线恢复工具：校验备份完整性/必要表/schema → 保全当前主库与 sidecar → 删除旧 WAL/SHM → 原子替换 → 复查完整性与计数；失败回滚并保留诊断；文档明确 app、maintenance、定时任务和手动脚本全部离线 | `scripts/restore-db.mjs`、`README.md` |
| ✅ | 健康检查 | `/api/health/` 查 `SELECT 1`，只返回 `status` / `db`；迁移版本与运行时长在 `/api/health/detail/`，仅管理员会话可读 | `src/server/http.ts` |
| ✅ | 结构化日志 | 每请求一行 JSON（request id、方法、路径、状态、耗时），不记查询串/IP/UA | `src/server/log.ts` |
| ✅ | CI | Node 24：check → test → build → 生产服务器冒烟 | `.github/workflows/ci.yml` |
| ✅ | 测试覆盖 | `npm test`（内容/后端/Markdown/链接检查/备份/恢复/WAL 回滚/迁移/认证加固；用例数随文件增长，以运行输出为准）、后台端到端 36 项、公开浏览器 10 项；CI 另跑实例隔离、容器冒烟与默认/兼容素材验收，浏览器测试依赖 Chromium | `tests/` |
| ✅ | 定时维护与状态页 | Compose 的 `maintenance` 容器（或宿主机 systemd timer/cron）按 UTC 配置执行数据库诊断备份、链接检查和指标清理；每 30 秒写心跳，`/admin/maintenance/` 只读展示进程状态、任务阶段、退出码、下次计划与异常链接，页面本身不启动任务；单任务超时 15 分钟，失败 15 分钟后重试，租约防止重复执行 | `scripts/maintenance.mjs`、`src/server/maintenance-status.ts`、`src/pages/admin/maintenance.astro` |
| ◻ | 监控与告警 | 无 uptime 监控、错误聚合或告警通道 | — |
| ◻ | 日志轮转与集中收集 | 日志写 stdout，轮转交给 Docker/宿主 | — |
| ◻ | 缓存 / CDN | 公开页仍 `Cache-Control: no-store`；未做 ETag、短缓存或内容失效 | — |
| ◻ | 严格 CSP | 当前无第三方脚本，未配置完整内容安全策略 | — |
| ◻ | 多机 / 高可用 | 单机 SQLite + app/maintenance 两个进程（可同机容器）；无读写分离或多节点方案 | — |

## 安全与隐私

已实现：

- scrypt 密码哈希；会话令牌只存哈希、8 小时有效；`HttpOnly` + `SameSite=Strict`，HTTPS 下加 `Secure`。
- 写操作逐次校验角色、CSRF 与会话令牌、同源 Origin。
- 限流按访客分层（需 `TRUST_PROXY=1` **且** `TRUST_PROXY_SECRET` 与反代的 `X-Sanjiang-Proxy-Secret` 一致，并由代理覆盖写入单值 `X-Forwarded-For`）：登录失败 10 次/账号/15 分钟、30 次/客户端/15 分钟；反馈 5 次/客户端/小时；指标 600 次/客户端/小时。成功登录不消耗额度，`Retry-After` 按真实剩余时间返回。账号桶只在**失败之后**结算，因此第三方刷满它不会挡住正确口令；口令校验的实际次数由客户端层与站点层限制。
- 再认证与导入另有独立预算：敏感操作的新鲜证明 `proof-user` 5 次/15 分钟（按操作者）、`proof-client` 30 次/15 分钟（仅失败），导入预检 `import-user` 10 次/小时（按请求计）。预算在昂贵校验之前检查，失败在业务事务之外结算。
- 无法验证来源的请求（凭据缺失/不匹配、转发头缺失/多值/非法、`TRUST_PROXY=0` 时带头）按**不可信身份**处理：只吃站点级预算（登录 500 次/5 分钟、反馈 500 次/小时、指标 20000 次/小时），不会创建按访客的桶，也不会因此把其他访客挡在外面。
- 指标只接受已发布资源/指南作为目标，每事件每日最多 200 个不同目标；未知目标静默丢弃。
- 链接检查：协议 http/https、端口 80/443、解析结果判私网、连接固定到已校验 IP、逐跳重校验、10 秒超时、每操作者 30 次/10 分钟。
- 响应头：CSP（Report-Only）、HSTS（HTTPS）、Permissions-Policy、COOP、`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`。详见 [安全设计与实现规范](../security/SECURITY-SPEC.md)。
- 无 JavaScript 时后台表单仍可用；失败保留未存草稿。
- 学生反馈匿名、仅维护者可见；聚合指标不含 IP/UA/账户；搜索词截断并 90 天清理。
- 页面统一 `nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`、`no-store`；后台 `noindex`。

未实现或已知限制：

- 未配置完整 CSP（当前为 Report-Only）；2FA 已实现，但强制策略默认关闭。
- 审计日志可被拥有数据库文件的人直接修改，单机 SQLite 不提供防篡改。
- 备份未加密；文件含密码哈希与反馈正文，必须放在仓库外。
- 链接检查不解包重定向内容，仅校验 URL 与状态码；403/429 不代表资源不可用。
- 图片版权采用“标注 + 通知下架”，不等于取得授权。

## 明确不做

以下功能在当前阶段不做，重新评估需要触发条件：

- AI 问答 / 智能推荐：无评测集与人工兜底，风险大于收益。
- 学生账户、收藏、学习进度：未验证复访需求，认证与隐私成本高。
- 评论、评分、公开投稿：需要持续审核与治理能力。
- 自动下架链接：检查结果可能误报，必须由人确认。手动停用（保留解释页 + 替代资源）已实现，见“后台治理”。
- 多机部署：当前维护者与流量不需要。
- 图片转存 / 代理下载：版权与流量责任不划算。

重新评估的常见触发条件：资源 >50 条再考虑全文搜索；指南 >5 篇再做目录与代码高亮；推荐类反馈持续 >10 条/周再考虑投稿工作流；出现多编辑者审批需求再引入多角色。
