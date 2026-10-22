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

停止定时任务：`docker compose stop maintenance`。手动备份和检查入口仍可使用：

```bash
docker compose exec -T app node scripts/backup-db.mjs
docker compose exec -T app node scripts/check-links.mjs --limit 50 --delay 500
```

手动脚本不参与调度租约；若需手动维护，应先停止维护容器以避免重叠。
非 Docker 环境可以在进程管理器中运行 `npm run maintenance`，并配置相同环境变量。
仓库提供运行配置，本地开发不会自动启动定时进程。

## 数据库恢复

恢复是离线操作，不能用 `cp` 覆盖主库。先停止 `app`、`maintenance`（或本地 timer/cron）以及所有手动数据库脚本；Docker 还要确认没有其他容器挂载 `site-data` 卷。然后运行：

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
