# 图片构建与定时维护

## 图片

`npm run dev`、`npm run check`、`npm run build` 和 `npm test` 会先运行 `npm run images:build`。
脚本读取 `public/images/` 下 PNG、JPEG、WebP，在 `public/images/optimized/` 生成最大
320/640/960/1280 像素宽的 WebP（不放大原图），并更新 `src/data/image-variants.json`。
生成图片不提交 Git；Docker 构建会重新生成。文件名含内容与转换配置哈希。

构建是**原地更新**：不删除 `optimized/` 目录，同名同大小的文件复用，新文件先写临时文件再改名，
只清理本次没有生成的残留变体。原因是这些 `pre*` 钩子会在开发服务器开着的时候被触发
（例如另开终端跑 `npm test`），而 `rm -rf` 后重建目录会让开发服务器的静态文件索引失效，
所有 `/images/optimized/*` 立刻 404；浏览器对匹配到 `<source type="image/webp">` 的图片
不会回退到 `<img>`，页面直接显示裂图。`tests/images.test.mjs` 用 inode 断言守住这条约束。

首页、详情和后台整页预览共享 `ResourceImage`，通过 `<picture>`、`srcset`、`sizes`
选择合适的图片；`img` 保留原图、真实宽高、延迟加载和异步解码。没有变体的本地路径仍回退原图。
原始图片、署名、许可和下架入口保留。增加或替换截图后需要重新构建，不能只更新数据库路径。
移除图片时也应移除原图并重新构建干净镜像，避免旧变体继续提供访问。

## 运行时媒体（上传图片）

除构建期截图外，管理员/编辑者可以在资源编辑页上传图片。它们不写入 `public/`，而是落在
`MEDIA_DIR`（默认 `./data/media`，容器内 `/app/data/media`）的不可变文件组：

```text
media/objects/<sha256>/{master.webp,320.webp,...,manifest.json}
media/staging/<operation-id>/bundle/     # 上传中的暂存，失败只清理自己的目录
media/quarantine/                        # 离线对账移出的未提交对象
```

- `/media/<sha256>.webp` 由中间件直接服务：**每次请求**都查库确认 `state=ready` 且未下架，
  所有响应（含 404/HEAD）都是 `Cache-Control: no-store`。不要在 Nginx 用 `alias` 直出，
  也不要让 CDN 缓存该路径。
- 上传是全局独占操作：同一时刻只允许一个媒体写操作（上传/下架/恢复/彻底删除）。
  占位忙时返回 503，等对账或前一个操作结束再试。
- 配额 `MEDIA_QUOTA_BYTES` 统计主图 + 变体 + 清单 + 下架文件 + 未结算预留；物理删除完成
  后才释放。落盘前还要求磁盘至少保留 `MEDIA_MIN_FREE_BYTES`。

### 离线对账

```bash
npm run media:reconcile                 # 只报告
npm run media:reconcile -- --yes --clear-guard
```

先停止 app、maintenance 与所有手动媒体任务。工具会核对操作记录与文件哈希：已提交资产只校验，
未提交对象移入 `quarantine/`，孤儿对象同样隔离；存在哈希/缺失问题时保持上传暂停并输出可操作
错误。**不会**按超时或 PID 自动抢占占位——`--clear-guard` 代表你已确认没有写入者。

### 站点级备份与恢复

```bash
npm run site:backup
npm run site:restore -- --backup ./backups/site-<stamp>-<rand> --yes
```

批次目录包含 `site.sqlite`、`media/objects/**`、`manifest.json` 与最后的 `COMPLETE` 标记；
备份前要求媒体占位为空且所有对象哈希正确，否则拒绝标记成功。备份**失败时不会留下半成品批次**
（本次创建的目录会被删除，成功批次不受影响），因此 `backups/` 下不存在 `COMPLETE` 的目录
可以直接视为异常。从未上传过媒体的新实例（`media/objects` 尚未创建）也能正常备份。

**恢复必须在离线状态下执行。** `site:restore` 会在任何写操作之前扫描同一 PID 命名空间内
持有目标数据库（含 `-wal`/`-shm`）的进程，命中即拒绝、非零退出、不修改目标文件：

```bash
docker compose stop app maintenance      # 或 docker stop <app> <maintenance> / systemctl stop …
docker compose run --rm app node scripts/restore-site.mjs \
  --backup /app/backups/site-<stamp>-<rand> --database /app/data/site.sqlite --media /app/data/media --yes
```

`--assume-offline` 的语义与 `restore-db` 一致：**只**覆盖"当前系统没有 `/proc`、无法检测"
的情形，不覆盖"检测到使用方"。容器之间互相看不到对方的进程，Docker 部署必须自己确认
没有其他容器挂载同一数据卷（`docker ps` + `docker inspect` 的 Mounts）。
恢复目标目录不存在时会安全创建（裸机灾难恢复场景）；权限不足或磁盘错误会以明确错误退出。
恢复在暂存位置完成校验、迁移与认证净化（清空会话/挑战/恢复码、递增 `auth_version`、
抬升 TOTP 步数下限），再按日志切换 DB 与 `objects/`；中途失败会回滚并保留原目录。

清单记录软件版本、提交、迁移列表与业务计数；缺少这些可选字段的旧批次仍可读取。
恢复前先拒绝当前程序不认识的迁移；迁移与净化都在暂存副本完成，并核对分类、资源两份快照、
指南、用户、历史、审计、设置、媒体与赞助的数量和内容摘要——除迁移元数据、认证净化和一条
`restore-purge` 审计外，业务摘要必须完全不变。
`npm run db:backup` 只是数据库诊断快照，不能用于含媒体的站点恢复。

**切换阶段与硬中断恢复**：日志 `site-restore-<stamp>.log.json` 会逐阶段写入
`phases`、`preserved.database` 与 `preserved.objects`。`preserved.database` 是
`VACUUM INTO` 生成的独立一致性快照，已经包含原库匹配的已提交 WAL；保全目录中不再
另存可与之混用的 `site.sqlite-wal/-shm`。进程被强制终止时：

1. 先停止 app、maintenance 与所有写者，不要直接再次运行恢复；
2. 读日志确认最后阶段：
   - 只到 `verify-backup`、`stage`、`prepare` 或 `objects-installed`：数据库切换尚未开始，
     原主库内容未被替换（SQLite 可能在生成一致性快照时 checkpoint WAL）。若对象已经切换，
     删除当前 `media/objects`，把日志里的
     `preserved.objects`（`objects.restore-*`）改名回 `media/objects`；
   - 已到 `db-swap-started` 或 `swap`：sidecar 可能已清理，主库可能已替换。不要寻找或复用
     旧 sidecar；删除目标 `site.sqlite-wal/-shm`，把 `preserved.database` 复制回
     `site.sqlite`，再按上一条恢复媒体；
   - 日志没有 `preserved.database`：恢复前不存在原库。删除候选主库与 sidecar，按实际情况
     恢复旧媒体；不要记录为“已还原原库”。
3. 对写回的主库执行 `PRAGMA integrity_check`，并用原业务计数、媒体哈希和
   `preserved.businessDigest` 核对；自动回滚只有在这些检查通过后才记录 `rollback-verified`。
4. 恢复后重新运行 `site:backup` 校验对象哈希，再启动一个实例确认登录与媒体可用。

工具不会自动处理硬中断；上述步骤必须由维护者执行并记录。硬中断后不要手工拼接
`preserved.database` 与任何旧 WAL/SHM。

### 双因素认证密钥

`TOTP_ENC_KEY` 与数据库分开保存：只恢复数据库而丢失密钥，所有账户都无法用 TOTP 登录。
此时用 `npm run totp:reset -- <用户名> --reason "…" --yes` 离线重置后重新绑定。

### 本地/测试实例的维护进程

Web 应用不会自动启动维护进程。本地、systemd 或临时测试实例需要单独运行：

```bash
DATABASE_PATH=./data/site.sqlite \
MEDIA_DIR=./data/media \
BACKUP_DIR=./backups \
npm run maintenance
```

维护进程每 30 秒写入 `${DATABASE_PATH}.maintenance.sqlite` 的心跳（可用
`MAINTENANCE_STATE_PATH` 覆盖），并执行到期任务。只启动 app 时，
`/admin/maintenance/` 会显示“尚未发现维护进程”和“暂无记录”，这是状态查询页的正常结果，
页面本身不会创建状态文件或启动任务。Docker Compose 会启动独立的 `maintenance` 容器，
不需要再手工运行此命令。

## Docker Compose 定时任务

```bash
COMMIT_SHA="$(git rev-parse HEAD)" docker compose up -d --build
docker compose logs --tail=100 maintenance
```

Compose 默认启动 `app` 与 `maintenance` 两个容器，使用同一镜像、数据库卷和备份目录。
维护容器在应用健康后启动，没有对外端口。默认时间不依赖宿主机时区：

| 变量 | 默认 UTC | 对应北京时间 |
|---|---|---|
| `BACKUP_UTC_HOUR` | `19`，每天 | 每天 03:00 |
| `LINK_CHECK_UTC_HOUR` | `20` | 04:00 |
| `LINK_CHECK_UTC_DAY` | `0`，UTC 周日 | 每周一 |
| `METRICS_CLEANUP_UTC_HOUR` | `18`，每天 | 每天 02:00 |

修改 `.env` 后执行 `docker compose up -d`。任务每 30 秒检查一次到期状态。
统计清理每天删除超过 90 天的聚合指标；浏览请求只更新计数，不执行历史删除。
维护进程每 30 秒独立写入一次心跳，长任务执行期间也会更新。
管理员可访问 `/admin/maintenance/` 查看心跳、每项任务的开始/结束/成功时间、退出码、
下次计划/重试时间，以及当前已发布资源的异常链接。心跳超过两分钟标记中断；
到期任务未完成会提示超期。页面只读，不创建状态文件、不运行任务。编辑者不能访问。
首次启动或停机后重启，会立即补跑最近一期尚未完成的任务；不会重放所有历史任务。
因此首次部署可能立即执行备份和链接检查，不必等到下一个计划时间。

维护状态存储在 `DATABASE_PATH` 后加 `.maintenance.sqlite` 的独立 SQLite 文件中，跟随数据卷持久化，
本地可用 `MAINTENANCE_STATE_PATH` 覆盖。它不属于站点内容数据库，也不包含在内容备份内；
状态丢失只会导致最近一期任务补跑。原子租约防止多维护进程重复运行；单任务限时 15 分钟，
失联进程的租约在 16 分钟后可接管。失败任务 15 分钟后重试，其他任务继续执行。
不要在不同机器上共享 SQLite 数据卷。

链接检查每次最多 50 条，优先未检查、再检查最久未检查的已发布资源；不改变发布状态。
资源超过 50 条时按周轮转，每条资源的检查间隔可能超过一周。
退出码 `2` 表示检查已完成但发现失效或错误链接，记录为 `attention`，留待后台人工确认；
退出码 `1` 表示任务执行失败，会重试。备份的任何非零退出码均重试。
日志输出 `maintenance-start`、`maintenance-finish`，后者包含退出码、状态和耗时。

默认依旧只保留最近 `BACKUP_KEEP=7` 份备份，备份位置由 `BACKUP_HOST_DIR` 决定。
宿主机挂载目录必须允许容器内 `node` 用户（UID 1000）写入；启动前检查目录权限。
备份在独立子进程中运行，不会直接阻塞 Web 进程的事件循环，但仍消耗磁盘与数据库资源。
备份文件权限为 `0600`，包含密码哈希和反馈；生产环境应另行安排异机副本与恢复演练。
**定时任务的备份只是数据库诊断快照**，不含媒体二进制，不能保证 DB 与媒体同批一致。完整灾备必须
停写后运行 `site:backup`，步骤见 [升级与回滚](upgrade.md) 与 [Docker 部署](../deploy/deploy-docker.md) §7。

停止定时任务：`docker compose stop maintenance`。手动备份和检查入口仍可使用：

```bash
docker compose exec -T app node scripts/backup-db.mjs
docker compose exec -T app node scripts/check-links.mjs --limit 50 --delay 500
```

手动脚本不参与调度租约；若需手动维护，应先停止维护容器以避免重叠。
非 Docker 环境可以在进程管理器中运行 `npm run maintenance`，并配置相同环境变量。
仓库提供运行配置，本地开发不会自动启动定时进程。

## 数据库恢复（仅无媒体登记时）

恢复是离线操作，不能用 `cp` 覆盖主库。先停止 `app`、`maintenance`（或本地 timer/cron）以及所有手动数据库脚本；Docker 还要确认没有其他容器挂载 `site-data` 卷。`restore-db` 与 `restore-site` 共用同一套离线检测（`scripts/lib/offline-guard.mjs`），两条命令对"能不能现在恢复"给出一致结论。然后运行：

```bash
# 本地
npm run db:restore -- --backup ./backups/site-YYYY-MM-DD.sqlite --yes
# Docker（app/maintenance 已停止）
docker compose run --rm --no-deps app node scripts/restore-db.mjs --backup /app/backups/site-YYYY-MM-DD.sqlite --yes
```

工具先校验备份完整性、必要表和 schema 兼容性；无效备份不会改动目标。替换前把当前主库及 `-wal`/`-shm` 保全到 `site.sqlite.restore-*`，删除旧 sidecar 后再替换，并对恢复结果复查完整性和表计数。失败退出非零并保留诊断；替换后的复查失败会尝试回滚。工具只能检测同一 PID 命名空间内的进程，跨容器、跨主机或共享卷的使用者必须人工确认已停止。

## 日志轮转

两个容器均使用 Docker `json-file` 日志，每个文件最多 `10m`，保留 `3` 份。
无需应用自己写日志文件；日志通过 `docker compose logs app maintenance` 查看。
这仅限制本地日志占用，不提供外部故障通知或集中收集。

## 验证

```bash
npm run check
npm test
npm run build
npm run test:admin
# 另起使用临时数据库的生产服务器后：
TEST_BASE_URL=http://127.0.0.1:4321 npm run test:browser
docker compose config --quiet
```

维护测试覆盖时间边界、持久化、重复进程互斥、崩溃租约接管、失败重试和链接轮转。
浏览器测试验证手机与桌面真实加载 WebP，并保留原图回退地址。

## 编辑草稿保护

资源与指南编辑页在有未保存修改时提示离开，并把内容字段备份到当前浏览器。
备份按账户 ID、内容类型和条目 ID 隔离，七天后过期，不包含密码、会话或 CSRF 令牌。
重新进入页面时可以恢复、查看或丢弃；恢复只填回表单，不自动提交或发布。
本地版本与服务器版本不一致时禁止一键恢复，只能查看并手动合并。
成功保存后清除对应备份；网络失败、权限错误和版本冲突均保留输入。
浏览器禁用存储或容量不足时仍可编辑和保存，并明确提示本地备份不可用。
本地备份不是加密存储，不应在内容字段中填写密钥或其他敏感凭据。

## 构建提交版本

公开页和后台页脚显示七位 Commit Hash，链接到 GitHub 上对应的完整提交。
`npm run build` 优先读取 `COMMIT_SHA`，其次 `GITHUB_SHA`，最后读取本地 `git rev-parse HEAD`。
构建产物保存该值，运行时切换代码目录或环境变量不会改变已构建页面的版本。
缺失 Git 元数据或传入非法版本时显示“Commit 未知”，不生成错误的提交链接。

Docker 构建上下文不包含 `.git`，因此部署时使用上面的 `COMMIT_SHA=...` 命令传入完整 40 位哈希。
从源码压缩包构建时同样应显式指定。Commit 只能标识提交，发布构建应使用干净的代码检出。

## 自动浏览器回归

CI 在生产构建后安装 Playwright Chromium，执行后台和公开站全部浏览器测试。
测试优先使用 `CHROME_PATH`；未设置时优先本机 Chrome，否则使用 Playwright Chromium。
设置 `TEST_ARTIFACTS_DIR` 后，每个浏览器上下文会保存截图和可用 `playwright show-trace`
查看的追踪文件。CI 只在失败时上传，保留七天；这些记录只使用测试账户和临时数据。
本地排查示例：`TEST_ARTIFACTS_DIR=/tmp/sanjiang-browser npm run test:admin`。
