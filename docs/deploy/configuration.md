# 配置与部署边界

本页说明配置的分层、优先级与安全边界。安装步骤见 [Docker 部署](deploy-docker.md) 或 [宿主机部署](deploy-local.md)；
新库初始化见 [初始化](initialization.md)。

## 1. 三层配置

| 层 | 内容 | 修改方式 |
|---|---|---|
| 软件常量 | 上游名称、仓库、MIT 许可、迁移编号 | 源码发布；实例不修改 |
| 部署环境 | `SITE_URL`、数据库/媒体/备份路径、代理信任、TOTP 策略、配额、任务时间、初始化模式 | 环境变量或 `.env`，改后重启 |
| 实例数据 | 站点品牌、首页编排、分类、资源、账户、媒体、赞助 | 后台界面；SQLite 持久化 |

品牌与首页编排不通过环境变量覆盖；`SITE_URL` 也不会从数据库读取。页面只读取白名单投影，
不会把环境变量、密钥或数据库行直接输出到 HTML。

## 2. 站点地址

`SITE_URL` 是 canonical、OG、Origin 校验、Cookie `Secure`、HSTS 与 sitemap 的唯一来源。

- 必须是绝对 `http(s)` origin，例如 `https://res.example.edu`；
- 拒绝用户名/密码、query、fragment 与子路径；第一版只支持根路径部署；
- 生产环境必须显式配置；开发环境才允许回退到请求地址；
- 修改后必须重启应用，后台设置页只读展示当前值。

## 3. 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SITE_URL` | 开发回退 | 见上 |
| `SITE_INIT_MODE` | `empty` | 只对新库生效：`empty` / `demo` |
| `SITE_INIT_NAME` | `三匠资源站` | 新库初始名称，同时冻结为 TOTP issuer |
| `DATABASE_PATH` | `./data/site.sqlite` | SQLite 文件 |
| `MEDIA_DIR` | `./data/media` | 上传媒体目录，须与数据库同卷 |
| `BACKUP_DIR` | `./backups` | 站点备份目录；不要与数据卷放在同一块盘 |
| `BACKUP_KEEP` | `7` | 保留完整批次数量 |
| `TRUST_PROXY` | `0`（compose 为 `1`） | 仅在应用只经自有代理访问时开启 |
| `TRUST_PROXY_SECRET` | 无（`TRUST_PROXY=1` 时为必需） | 代理共享凭据（≥16 字符）；代理写入 `X-Sanjiang-Proxy-Secret`，应用据此采信它写的单值 `X-Forwarded-For`。缺失时 fail closed |
| `TOTP_ENC_KEY` | 无 | 32 字节 base64url；丢失后只能离线重置双因素 |
| `TOTP_REQUIRED_FOR` | `off` | `off` / `admin` / `admin,editor` |
| `MEDIA_QUOTA_BYTES` | 512 MiB | 媒体总预算 |
| `MEDIA_MIN_FREE_BYTES` | 128 MiB | 落盘保留余量 |

完整示例见 [.env.example](../../.env.example)。

## 4. 密钥与文件权限

- `TOTP_ENC_KEY` 只放在环境文件或编排密钥中，不写入数据库、备份、页面或日志；
- 数据库、媒体、备份目录权限 `0600/0700` 为默认目标；备份应复制到异机；
- 内容 JSON 导出不是密钥备份，也不是媒体二进制备份；
- 站点备份不包含 `TOTP_ENC_KEY`，恢复后仍需同一密钥才能验证已启用的双因素。

## 5. 运行时

- Node.js **24.x**；管理 CLI 直接执行 TypeScript 源文件，依赖原生类型剥离；
- 单实例 SQLite；app 与 maintenance 共享同一数据卷，但不要同时运行多个写者；
- 修改 `SITE_URL`、初始化模式、TOTP 策略等环境变量后重启对应进程；
- 定时任务时区在环境变量中按 UTC 标注，后台展示按 `Asia/Shanghai`。

## 6. 校验

```bash
curl -fsS "$SITE_URL/api/health/" | grep '"db":"ok"'
node -e "console.log(new URL(process.env.SITE_URL).origin)"
```

部署前建议按 [升级与回滚](../ops/upgrade.md) 做一次离线备份与恢复演练。
