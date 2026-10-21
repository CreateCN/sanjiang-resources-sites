# 非 Docker 本地部署（systemd + Nginx）

适用于没有 Docker、或希望直接在宿主机上跑生产构建的场景（单机 VPS、内网服务器、长期运行的开发机）。
容器部署仍是推荐方式（见 [README](../README.md#docker)）；本文是等价的宿主机方案，行为与安全边界保持一致。

> 关键差异只有两处：**进程由 systemd 托管**、**日志进 journald**。其余配置（`SITE_URL`、`TRUST_PROXY`、限流、备份、健康检查）与容器部署完全相同。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | **24.x 推荐**（`engines` 要求 ≥22.12；管理 CLI 依赖原生 TypeScript 剥离，22.18+ 才稳定） |
| 操作系统 | 任意 Linux（示例用 Debian/Ubuntu 路径），需要 systemd |
| 反向代理 | Nginx（或 Caddy），负责 TLS 与边缘限流 |
| CDN（可选） | 用 CDN 时，源站必须做白名单与真实 IP 还原，见 [边缘防护](edge-cdn-hardening.md) |
| 磁盘 | 数据库 + 图片优化产物 + 备份，建议 ≥2 GB 空闲 |
| 工具 | `sqlite3`（备份校验与排查用，`apt install sqlite3`） |
| 用户 | 专用系统用户 `sanjiang`，**不要用 root 跑应用** |

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin sanjiang
sudo mkdir -p /srv/sanjiang /var/backups/sanjiang
sudo chown -R sanjiang:sanjiang /srv/sanjiang /var/backups/sanjiang
```

## 2. 拉取代码与安装依赖

```bash
sudo -u sanjiang git clone https://github.com/CreateCN/sanjiang-resources-sites.git /srv/sanjiang
cd /srv/sanjiang
sudo -u sanjiang npm ci                 # 必须用 lockfile，不要 npm install
sudo -u sanjiang npm run build          # 会先生成图片变体，再 astro check + build
```

构建产物：`dist/`（服务端入口 `dist/server/entry.mjs`）、`public/images/optimized/`（图片变体，已被 git 忽略）。

## 3. 目录与权限

应用会自己创建并收紧权限（`src/server/db.ts`：目录 `0700`、数据库文件 `0600`），但仍建议显式准备：

```bash
sudo -u sanjiang mkdir -p /srv/sanjiang/data
sudo -u sanjiang chmod 700 /srv/sanjiang/data
```

| 路径 | 用途 | 权限建议 |
|---|---|---|
| `/srv/sanjiang/data/site.sqlite` | SQLite 主库（含 `-wal`/`-shm`） | `0600`，目录 `0700` |
| `/var/backups/sanjiang/` | 备份输出（`VACUUM INTO`） | `0700`，不要放在仓库目录内 |
| `/etc/sanjiang/sanjiang.env` | 环境变量文件 | `0640 root:sanjiang`（含 `SITE_URL`，不含口令） |

## 4. 环境变量

```bash
sudo mkdir -p /etc/sanjiang
sudo tee /etc/sanjiang/sanjiang.env >/dev/null <<'EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=4321
SITE_URL=https://res.example.edu
TRUST_PROXY=1
DATABASE_PATH=/srv/sanjiang/data/site.sqlite
BACKUP_DIR=/var/backups/sanjiang
BACKUP_KEEP=7
EOF
sudo chown root:sanjiang /etc/sanjiang/sanjiang.env
sudo chmod 640 /etc/sanjiang/sanjiang.env
```

| 变量 | 说明 |
|---|---|
| `HOST` | **必须** `127.0.0.1`：只让本机反向代理访问，不要 `0.0.0.0` |
| `SITE_URL` | 与浏览器地址完全一致（协议+域名[+端口]）；决定 canonical、Origin 校验与 Cookie `Secure` |
| `TRUST_PROXY` | 有反向代理时 `1`；**仅在应用直连且只服务本机单用户**时才设 `0`（否则所有访客共享一个限流桶） |
| `DATABASE_PATH` / `BACKUP_DIR` / `BACKUP_KEEP` | 与容器版语义相同 |

## 5. 创建第一个管理员

```bash
cd /srv/sanjiang
sudo -u sanjiang env ADMIN_USERNAME=maintainer ADMIN_PASSWORD='至少12位-强口令' \
  node scripts/create-admin.mjs
```

- 口令 12–256 字符；不要写进 shell history（可先 `read -s` 再传入，或用一次性 `systemd-run --scope -p Environment=`）。
- 之后在后台「人员与权限」里添加编辑者；没有邮件找回，忘记密码只能在服务器上再建一位管理员。

## 6. systemd 服务

```ini
# /etc/systemd/system/sanjiang.service
[Unit]
Description=Sanjiang resources site
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sanjiang
Group=sanjiang
WorkingDirectory=/srv/sanjiang
EnvironmentFile=/etc/sanjiang/sanjiang.env
ExecStart=/usr/bin/node dist/server/entry.mjs
Restart=always
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/sanjiang/data /var/backups/sanjiang
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sanjiang
sudo systemctl status sanjiang --no-pager
curl -fsS http://127.0.0.1:4321/api/health/    # {"status":"ok","db":"ok",...}
```

日志：`journalctl -u sanjiang -f`（应用是结构化 JSON 行，不含 IP/UA/查询串）。

## 7. 反向代理（Nginx + TLS）

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d res.example.edu        # 先拿到证书，再贴下面的配置
```

先在 `http {}` 层做「真实 IP 还原 + 源站白名单 + 限流」，再在 `server {}` 里引用（顺序不能反，原因见 [边缘防护 §1.1](edge-cdn-hardening.md)）：

```nginx
# /etc/nginx/nginx.conf（http 块内）
# 有 CDN 时：只信任回源段，并把改写前的对端地址用于白名单
# set_real_ip_from 163.171.0.0/16;
# set_real_ip_from 147.138.0.0/17;
# real_ip_header   X-Forwarded-For;
# real_ip_recursive on;
# geo $realip_remote_addr $from_cdn { default 0; 163.171.0.0/16 1; 147.138.0.0/17 1; 127.0.0.1 1; 10.0.0.0/8 1; }

limit_req_zone  $binary_remote_addr zone=page:10m rate=10r/s;
limit_req_zone  $binary_remote_addr zone=api:10m  rate=2r/s;
limit_conn_zone $binary_remote_addr zone=conn:10m;
limit_req_status  429;
limit_conn_status 429;
```

```nginx
# /etc/nginx/sites-available/sanjiang
server {
    listen 80;
    server_name res.example.edu;
    # 有 CDN 时同样要挡直连：if ($from_cdn = 0) { return 444; }
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name res.example.edu;

    ssl_certificate     /etc/letsencrypt/live/res.example.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/res.example.edu/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    server_tokens off;
    client_max_body_size 1m;

    # 应用只接受「单值」客户端地址：这里必须覆盖写，不能用 $proxy_add_x_forwarded_for
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 有 CDN 时放在 server 顶部、所有 location 之前：if ($from_cdn = 0) { return 444; }

    location / {
        limit_req  zone=page burst=20 nodelay;
        limit_conn conn 20;
        proxy_pass http://127.0.0.1:4321;
        proxy_http_version 1.1;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    location ^~ /api/ {
        limit_req  zone=api burst=10 nodelay;
        limit_conn conn 10;
        proxy_pass http://127.0.0.1:4321;
        proxy_http_version 1.1;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sanjiang /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

TLS 稳定运行一段时间后再加 HSTS（应用在 `SITE_URL=https://` 时已下发 `Strict-Transport-Security`，Nginx 不必重复）：

```nginx
add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
```

Caddy 等价配置（Caddy 默认会**追加** XFF，必须显式覆盖）：

```caddyfile
res.example.edu {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4321 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Real-IP {remote_host}
    }
}
```

## 8. 定时任务：systemd timer（推荐）或 cron

与应用镜像内置的 `maintenance` 容器等价，三个脚本：

| 脚本 | 建议频率 | 说明 |
|---|---|---|
| `scripts/backup-db.mjs` | 每天 03:00 | `VACUUM INTO` + 完整性校验 + 保留 `BACKUP_KEEP` 份 |
| `scripts/check-links.mjs` | 每周一次 | 批量检查已发布资源链接，只记录不下架 |
| `scripts/cleanup-metrics.mjs` | 每天 02:00 | 清理超过 90 天的匿名统计 |

```ini
# /etc/systemd/system/sanjiang-backup.service
[Unit]
Description=Sanjiang database backup
[Service]
Type=oneshot
User=sanjiang
Group=sanjiang
WorkingDirectory=/srv/sanjiang
EnvironmentFile=/etc/sanjiang/sanjiang.env
ExecStart=/usr/bin/node scripts/backup-db.mjs
```

```ini
# /etc/systemd/system/sanjiang-backup.timer
[Unit]
Description=Daily Sanjiang backup
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sanjiang-backup.timer
```

`check-links` 与 `cleanup-metrics` 照抄上面的 service/timer，改 `ExecStart` 与 `OnCalendar`（例如 `Mon *-*-* 04:00:00`）。

cron 等价写法（若不想用 timer）：

```cron
0 3 * * *   cd /srv/sanjiang && set -a && . /etc/sanjiang/sanjiang.env && set +a && /usr/bin/node scripts/backup-db.mjs
0 2 * * *   cd /srv/sanjiang && set -a && . /etc/sanjiang/sanjiang.env && set +a && /usr/bin/node scripts/cleanup-metrics.mjs
0 4 * * 1   cd /srv/sanjiang && set -a && . /etc/sanjiang/sanjiang.env && set +a && /usr/bin/node scripts/check-links.mjs
```

## 9. 备份、恢复与升级

```bash
# 手动备份（用登录 shell 加载环境变量，避免 xargs 拆行）
sudo -u sanjiang bash -lc 'set -a; . /etc/sanjiang/sanjiang.env; set +a; cd /srv/sanjiang && node scripts/backup-db.mjs'

# 恢复：停服 → 校验 → 替换 → 启动 → 冒烟
sudo systemctl stop sanjiang
ls -l /var/backups/sanjiang/
sudo -u sanjiang sqlite3 /var/backups/sanjiang/site-YYYY-MM-DD.sqlite 'PRAGMA integrity_check;'
sudo -u sanjiang cp /var/backups/sanjiang/site-YYYY-MM-DD.sqlite /srv/sanjiang/data/site.sqlite
sudo systemctl start sanjiang
curl -fsS http://127.0.0.1:4321/api/health/
```

升级（数据库迁移在启动时自动按序执行，无需手工迁移）：

```bash
cd /srv/sanjiang
sudo -u sanjiang git pull --ff-only
sudo -u sanjiang npm ci
sudo -u sanjiang npm run build
sudo systemctl restart sanjiang
journalctl -u sanjiang -n 50 --no-pager
```

回滚：`git checkout <上一个 tag/提交>` → 重新 `npm ci && npm run build` → 重启；**数据库只前进不回退**，回滚前先备份，否则旧版本可能遇到新 schema。

## 10. 上线核对清单

```bash
# 1) 只监听本机
ss -lntp | grep 4321                      # 应为 127.0.0.1:4321
# 2) 健康检查与首页
curl -fsS http://127.0.0.1:4321/api/health/
curl -fsSI https://res.example.edu/ | head -20   # 应有 CSP-Report-Only / HSTS / X-Frame-Options
# 3) 反向代理确实覆盖写 XFF
curl -sI https://res.example.edu/ >/dev/null && sudo journalctl -u nginx -n 5 --no-pager
# 4) 登录与后台
#    浏览器打开 https://res.example.edu/admin/ ，用第 5 步建的管理员登录
# 5) 限流按访客生效（不需要压测，看表即可）
sudo -u sanjiang sqlite3 /srv/sanjiang/data/site.sqlite \
  "SELECT key,count FROM rate_limits WHERE key LIKE 'login-client:%';"
#    出现多个不同哈希 = 正常；只有一个 = TRUST_PROXY 没开或代理没覆盖写 XFF
```

## 11. 与 Docker 部署的差异

| 项 | Docker | 宿主机 |
|---|---|---|
| 进程管理 | `restart: unless-stopped` | systemd + `Restart=always` |
| 日志 | `docker logs`（json-file 轮转） | journald（`journalctl -u sanjiang`） |
| 定时任务 | `maintenance` 容器 | systemd timer / cron |
| 文件权限 | 容器内 `node` 用户 + 命名卷 | `sanjiang` 系统用户 + 显式 `0700/0600` |
| 健康检查 | Compose healthcheck | systemd + 外部 uptime 监控（建议加） |
| 网络暴露 | 端口绑定 `127.0.0.1` | `HOST=127.0.0.1` + 反向代理 |
| 依赖 | 镜像内 `npm ci` | 宿主机 `npm ci`（需 Node 24） |

## 12. 公网暴露与边缘防护

上线到公网后，**先做源站隐身，再谈 CDN 加速**。完整方案（含 `return 444`、默认证书拒绝握手、CDN 回源段核对、CC 限流参数、DCDN/WAF 升级路径、CDN 被切沙箱时的应急预案）见 [边缘防护](edge-cdn-hardening.md)。这里只列不可协商的三条：

1. 源站只允许 CDN 回源段与运维 IP 访问；直连一律 `return 444`。不做这步，后面所有防护都可能被绕过。
2. 有 CDN 时，Nginx 必须先 `set_real_ip_from` + `real_ip_header` 还原访客 IP，否则 `limit_req` 和应用的按访客限流都会退化成"全站一个桶"。
3. `X-Forwarded-For` 必须**覆盖**写入单值（`$remote_addr`），不要用 `$proxy_add_x_forwarded_for`。

## 13. 安全注意事项（与 [SECURITY-SPEC](SECURITY-SPEC.md) 对应）

1. **不要**把 4321 直接暴露到公网；如果必须直连（例如只在本机使用），设 `TRUST_PROXY=0`，并接受"所有请求共享一个限流桶"的语义。
2. 应用信任的是"代理写入的单值 `X-Forwarded-For`"。Caddy/Nginx 默认**追加**，必须按本文覆盖写，否则限流会退化为站点级。
3. 备份含口令哈希与反馈正文：放仓库之外、`0700`、最好加密（`age`/`gpg`）后再异地复制。
4. 定期：`npm audit`、`apt upgrade`、证书到期检查（certbot 自动续期需验证 `systemctl list-timers | grep certbot`）。
5. 事故处置：先改密/停用账号撤销会话，再保全 `data/site.sqlite` 与 journal 日志，最后按 [安全档案](../reports/security/README.md) 的流程记录。
