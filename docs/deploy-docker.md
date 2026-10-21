# Docker 生产部署

推荐路径。宿主机直装方案见 [非 Docker 部署](deploy-local.md)；公网暴露与 CDN 防护见 [边缘防护](edge-cdn-hardening.md)。

## 1. 拓扑

```
访客 → CDN（可选） → Nginx :443（容器或宿主机） → app :4321（仅 127.0.0.1）
                                              └→ maintenance（无端口，定时备份/巡检/清理）
```

- `app` 与 `maintenance` 使用同一镜像、同一数据卷；`maintenance` 在 `app` 健康后启动。
- 只有 `app` 需要被反向代理访问；`maintenance` 不监听端口。
- 数据库在命名卷 `site-data`，备份写到宿主机目录（`BACKUP_HOST_DIR`），两者物理分离。

## 2. 前置

| 项 | 要求 |
|---|---|
| Docker | ≥ 24，Compose v2（`docker compose`） |
| 磁盘 | 镜像 ~650MB + 数据 + 备份，建议 ≥ 5GB |
| 域名与证书 | 由 Nginx（容器或宿主机）终结 TLS；证书可用 certbot 或云厂商证书 |
| 公网暴露面 | 只开 80/443；4321 不对外 |

## 3. 配置

```bash
cp .env.example .env
```

`.env` 至少改三处：

```dotenv
SITE_URL=https://res.example.edu          # 必须与浏览器地址完全一致
TRUST_PROXY=1                             # 有反向代理时开启（compose 默认已是 1）
BACKUP_HOST_DIR=/srv/backups/sanjiang     # 备份目录，放在仓库之外
```

> `TRUST_PROXY=0` 只在"应用直连、且只服务本机单用户"时使用；否则所有访客会共享一个限流桶（详见 [SECURITY-SPEC](SECURITY-SPEC.md) §2.1）。

## 4. 构建、启动、建管理员

```bash
COMMIT_SHA="$(git rev-parse HEAD)" docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:4321/api/health/      # {"status":"ok","db":"ok",...}
docker compose exec app node scripts/create-admin.mjs
```

- 管理员口令 12–256 字符；口令不要出现在 shell history（交互式输入或临时 `env`）。
- 首次启动会自动建库、跑迁移、导入 12 条种子资源；**不会创建任何默认账户**。

## 5. 端口与网络（最容易出事的一节）

`docker-compose.yml` 默认把应用绑在 `127.0.0.1:4321`，这是对的，不要改成 `0.0.0.0`。

如果 Nginx 也跑在容器里并对外发布 443，要注意 **Docker userland-proxy 会把源地址改写成本机网关**：

```bash
# 在 nginx 容器里看真实 $remoteip_remote_addr；若全是 172.x.0.1，说明源 IP 被改写
docker compose exec nginx sh -c 'tail -n 5 /var/log/nginx/access.log'
```

两个解决方向（二选一）：

1. **关闭 userland proxy**（推荐）：`/etc/docker/daemon.json` 加 `{"userland-proxy": false}`，重启 Docker。之后容器内看到的是真实源 IP。
2. **Nginx 用 host 网络**：`network_mode: host`，只适用于"一台机器只跑这一个站点"。

不改的话，后果是：源站白名单判断失效、`limit_req` 把所有访客算成一个 IP、应用层 `login-client` 桶被全站共用——也就是我们花了一整轮才修掉的那个问题。

## 6. 反向代理（容器形态）

把 [edge-cdn-hardening.md](edge-cdn-hardening.md) §1 的 `set_real_ip_from` / `geo` / `return 444` 放进容器内的 `nginx.conf`，并确保：

```nginx
location / {
    limit_req  zone=page burst=20 nodelay;
    limit_conn conn 20;
    proxy_pass http://app:4321;              # 同 compose 网络内的服务名
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;   # 必须单值覆盖
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP         $remote_addr;
}
```

挂载方式（compose 片段）：

```yaml
  nginx:
    image: nginx:1.27-alpine
    depends_on: [app]
    ports: ["80:80", "443:443"]
    volumes:
      - ./deploy/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./deploy/certs:/etc/nginx/certs:ro
```

> 没有 CDN 时也不要放开 4321；有 CDN 时务必按边缘文档配置白名单，否则源站 IP 一旦泄露，容器化也挡不住直连。

## 7. 备份与恢复

```bash
# 手动备份（容器内执行，写入 BACKUP_HOST_DIR）
docker compose exec app node scripts/backup-db.mjs

# 查看
ls -l "${BACKUP_HOST_DIR:-./backups}"

# 恢复：停 app → 校验 → 替换卷内数据库 → 启动 → 冒烟
docker compose stop app
docker volume ls | grep site-data                   # 确认实际卷名，通常是 <项目目录名>_site-data
docker run --rm -v <project>_site-data:/data -v "$PWD/backups":/b alpine \
  sh -c 'cp /b/site-YYYY-MM-DD.sqlite /data/site.sqlite && chown 1000:1000 /data/site.sqlite'
docker compose start app
curl -fsS http://127.0.0.1:4321/api/health/
```

- 备份含口令哈希与反馈正文：目录 `0700`，不要进仓库，最好加密后异地保存。
- `docker compose down -v` 会删数据卷，只在确定弃用时使用。

## 8. 升级与回滚

```bash
git pull --ff-only
COMMIT_SHA="$(git rev-parse HEAD)" docker compose up -d --build
docker compose logs -n 50 app
```

- 数据库迁移在启动时按序自动执行，无需手工操作。
- 回滚：切回上一个提交后重新 `up -d --build`；**数据库只前进不回退**，回滚前先备份。
- 构建会跑 `astro check`，类型错误会直接失败——这是好事，别用 `--no-cache` 绕过检查。

## 9. 日志与监控

- 日志驱动已配 `json-file`，`max-size=10m`、`max-file=3`；应用输出为结构化 JSON 行（不含 IP/UA/查询串）。
- 健康检查：Compose 内置 `healthcheck` 调 `/api/health/`；建议再加**外部** uptime 探针（CDN 可达性与源站可达性分开监控）。
- 关键观察项：`limit_req` 拒绝数、应用 429 比例、`rate_limits` 中 `login-client` 键的多样性、备份是否按时生成。

## 10. 常见故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 全站 502 | app 未起/健康检查失败 | `docker compose logs app`；看 `/api/health/` 是否 503 |
| 全站 429（含正常访客） | 代理没覆盖写单值 XFF，或 `TRUST_PROXY=0`，或 Docker 改写了源 IP | 查 `rate_limits` 键分布；按 §5/§6 修 |
| 登录后立刻掉线 | `SITE_URL` 与浏览器地址不一致（Cookie 的 `Secure`/Origin 校验） | 统一 `SITE_URL`（协议+域名+端口） |
| 上传/导入 413 | 提交体超过 96 KiB（应用）或 Nginx `client_max_body_size` | 调整业务输入大小或 Nginx 限制，二者取小 |
| 静态资源 404 | 构建未生成图片变体 | `npm run build`（`prebuild` 会生成），确认 `public/images/optimized/` |
| 备份目录为空 | `BACKUP_HOST_DIR` 权限/路径 | 宿主目录 `0700` 且属主可写 |

## 11. 与宿主机部署的差异

| 项 | Docker | 宿主机 |
|---|---|---|
| 进程管理 | `restart: unless-stopped` | systemd |
| 日志 | `docker compose logs`（json-file 轮转） | journald |
| 定时任务 | `maintenance` 容器 | systemd timer / cron |
| 源 IP | 注意 userland-proxy 改写 | 天然是真实源 IP |
| 依赖 | 镜像内固定 Node | 宿主 Node 24 |

## 12. 上线核对

```bash
docker compose ps                                   # app healthy、maintenance running
ss -lntp | grep 4321                                # 只应出现 127.0.0.1
curl -fsS http://127.0.0.1:4321/api/health/         # status/db ok
curl -fsSI https://res.example.edu/ | head -20      # CSP-Report-Only / HSTS / X-Frame-Options
docker compose exec app sh -c 'ls -l /app/data'      # site.sqlite 0600
ls -l "${BACKUP_HOST_DIR:-./backups}"                # 应看到 site-YYYY-MM-DD.sqlite
sqlite3 "${BACKUP_HOST_DIR:-./backups}"/site-*.sqlite 'PRAGMA integrity_check;'   # 最近一份应为 ok
```

有 CDN 时，再执行 [边缘防护](edge-cdn-hardening.md) §2 的四条"源站是否隐身"验证与 §10 的清单。
