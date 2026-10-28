# 非 Docker 本地部署（systemd + Nginx）

适用于没有 Docker、或希望直接在宿主机上跑生产构建的场景（单机 VPS、内网服务器、长期运行的开发机）。
容器部署仍是推荐方式（见 [README](../../README.md#docker推荐)）；本文是等价的宿主机方案，行为与安全边界保持一致。

> 关键差异只有两处：**进程由 systemd 托管**、**日志进 journald**。其余配置（`SITE_URL`、`TRUST_PROXY`、限流、备份、健康检查）与容器部署完全相同。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | **24.x**（`engines` 要求 ≥24；管理 CLI 直接执行 TypeScript，依赖原生类型剥离） |
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
# 代理共享凭据：与应用侧的 TRUST_PROXY_SECRET 完全一致；本文件因此含密钥，权限保持 640
TRUST_PROXY_SECRET=<替换为 32 位以上随机值>
SITE_INIT_MODE=empty
SITE_INIT_NAME=你的实例名称
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
| `TRUST_PROXY_SECRET` | **开启 `TRUST_PROXY` 时必需**，≥16 字符（建议用 `openssl rand -base64 32` 生成）。反代必须写同名头 `X-Sanjiang-Proxy-Secret`。缺失时应用 fail closed：所有请求按不可信身份处理，只吃站点级限流 |
| `SITE_INIT_MODE` / `SITE_INIT_NAME` | 只对新库生效：`empty`（默认）或 `demo`；名称同时冻结为 TOTP issuer |
| `DATABASE_PATH` / `BACKUP_DIR` / `BACKUP_KEEP` | 与容器版语义相同 |

## 5. 初始化与创建第一个管理员

默认 Empty；需要 Demo 时，在第一次启动服务前以运行用户执行（详细规则见 [初始化](initialization.md)）：

```bash
cd /srv/sanjiang
sudo -u sanjiang env DATABASE_PATH=/srv/sanjiang/data/site.sqlite \
  node scripts/init-site.mjs --mode demo --name "示例站"
```

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
curl -fsS http://127.0.0.1:4321/api/health/    # {"status":"ok","db":"ok"}（详细诊断在 /api/health/detail/，需管理员）
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
    # 图片上传 5 MiB + 64 KiB、导入 JSON 3 MiB；其余表单由应用侧限制为 96 KiB
    client_max_body_size 6m;

    # 应用只接受「单值」客户端地址 + 代理共享凭据：必须覆盖写，不能用 $proxy_add_x_forwarded_for。
    # ⚠ nginx 的 proxy_set_header 是"整组继承"：只要某个 location 自己写了任意一条
    #   proxy_set_header，server 级的这一组就全部失效。新增 location 时要么不写，
    #   要么把下面 5 条完整重复一遍（或在每个 location 里 include 同一个片段）。
    proxy_set_header Host                     $host;
    proxy_set_header X-Real-IP                $remote_addr;
    proxy_set_header X-Forwarded-For          $remote_addr;
    proxy_set_header X-Forwarded-Proto        $scheme;
    # 值与 /etc/sanjiang/sanjiang.env 的 TRUST_PROXY_SECRET 完全一致；建议放在单独文件里：
    #   /etc/nginx/snippets/sanjiang-proxy-secret.conf  （chmod 600，内容仅下面一行）
    include /etc/nginx/snippets/sanjiang-proxy-secret.conf;

    # 有 CDN 时放在 server 顶部、所有 location 之前：if ($from_cdn = 0) { return 444; }

    location / {
        limit_req  zone=page burst=20 nodelay;
        limit_conn conn 20;
        proxy_pass http://127.0.0.1:4321;
        proxy_http_version 1.1;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # /media/ 必须转发到应用：每次请求实时查库、所有响应 no-store。禁止 alias/root 直出。
    location ^~ /media/ {
        proxy_pass http://127.0.0.1:4321;
        proxy_http_version 1.1;
        proxy_cache off;
        add_header Cache-Control "no-store" always;
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
# 把凭据单独落盘给 nginx 用（内容只有一行 proxy_set_header）。
# 注意：凭据**不能**作为命令参数传给 sudo —— 那会进入 sudo 审计日志（sudoers 的 log_input/
# 命令记录）与进程列表（ps -ef）里。这里改为经 stdin 传入，sudo 只执行固定命令，
# 由 root 侧设置 umask 077 后以 0600 创建文件。
sudo mkdir -p /etc/nginx/snippets

# 推荐直接用十六进制随机值（只含 0-9a-f，放进双引号不会与 nginx 配置语法冲突）：
#   PROXY_SECRET=$(openssl rand -hex 32)
# 手工输入也行，但不要包含 `"`、反斜杠或空白。
read -rsp 'TRUST_PROXY_SECRET（≥16 位，建议 32 位随机）: ' PROXY_SECRET; echo
printf 'proxy_set_header X-Sanjiang-Proxy-Secret "%s";\n' "$PROXY_SECRET" \
  | sudo sh -c 'umask 077 && cat > /etc/nginx/snippets/sanjiang-proxy-secret.conf'
unset PROXY_SECRET

# 核对：文件只能是 root 可读，内容只有这一行
sudo ls -l /etc/nginx/snippets/sanjiang-proxy-secret.conf      # 期望 -rw------- root root
sudo grep -c 'X-Sanjiang-Proxy-Secret' /etc/nginx/snippets/sanjiang-proxy-secret.conf   # 期望 1

sudo ln -s /etc/nginx/sites-available/sanjiang /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> 只用 `sudo` 执行固定命令、数据走 stdin，是为了让凭据不出现在 `sudo` 的审计记录、shell
> history（`read -s` 已避免）与 `ps` 里。如果你的 sudoers 开启了 `log_input`，stdin 内容同样
> 会被记录——那就改为 `sudo -e /etc/nginx/snippets/sanjiang-proxy-secret.conf`（root 编辑器里
> 直接粘贴一行）或由配置管理工具以 0600 落盘。

TLS 稳定运行一段时间后再加 HSTS（应用在 `SITE_URL=https://` 时已下发 `Strict-Transport-Security`，Nginx 不必重复）：

```nginx
add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
```

Caddy 等价配置（Caddy 默认会**追加** XFF，必须显式覆盖；**凭据头同样必须给**，否则应用按
不可信身份处理，只剩站点级限流）：

```caddyfile
res.example.edu {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4321 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Real-IP {remote_host}
        # 与 /etc/sanjiang/sanjiang.env 的 TRUST_PROXY_SECRET 完全一致；不要写进版本库
        header_up X-Sanjiang-Proxy-Secret "<替换为同一凭据>"
    }
}
```

Caddy 若从环境变量取值（`{env.TRUST_PROXY_SECRET}`），必须确保该变量在 **caddy 进程**的环境里
（systemd 的 `Environment=`/`EnvironmentFile=`），而不是只存在于应用的沙箱里。

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

# 恢复：先停止应用、定时任务和所有手动脚本，再运行离线恢复工具
sudo systemctl stop sanjiang
# 若配置了 backup / links / cleanup 的 timer，也要停止；名字以实际 unit 为准：
sudo systemctl stop sanjiang-backup.timer sanjiang-links.timer sanjiang-cleanup.timer 2>/dev/null || true
# 用同一用户运行，工具才能检查该用户启动的进程；可选再用 lsof 人工确认没有残留句柄。
sudo -u sanjiang lsof /srv/sanjiang/data/site.sqlite* 2>/dev/null || true

sudo -u sanjiang bash -lc 'set -a; . /etc/sanjiang/sanjiang.env; set +a; cd /srv/sanjiang && \
  node scripts/restore-db.mjs --backup /var/backups/sanjiang/site-YYYY-MM-DD.sqlite --yes'

sudo systemctl start sanjiang
sudo systemctl start sanjiang-backup.timer sanjiang-links.timer sanjiang-cleanup.timer 2>/dev/null || true
curl -fsS http://127.0.0.1:4321/api/health/
```

工具会先校验备份的完整性、必要表和 schema 兼容性，把当前主库与 `-wal`/`-shm` 保全到 `site.sqlite.restore-*`，再删除旧 sidecar、替换主库并复查完整性与表计数；替换后复查失败会尝试回滚。不要直接 `cp` 覆盖主库。工具只能检测同一 PID 命名空间内的进程，其他机器或共享卷上的使用者必须人工确认已停止。

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
# 3) 部署自检（与运行中的服务使用同一份环境文件）
sudo -u sanjiang bash -lc 'set -a; . /etc/sanjiang/sanjiang.env; set +a; cd /srv/sanjiang && \
  node scripts/check-deployment.mjs --strict'      # 必须 status: ok；strict 下连"降级"也算失败
# 4) 反向代理确实覆盖写 XFF 并带上凭据（应用侧只认"单值地址 + 正确凭据"）
curl -sI https://res.example.edu/ >/dev/null && sudo journalctl -u nginx -n 5 --no-pager
# 4b) 用构建产物 + 反代替身做一次联调回归（只连 127.0.0.1，不开公网）
#     覆盖：同客户端第 6 次 429、换客户端仍有独立额度、rate_limits 出现多个
#     reports-client 键、直连伪造转发头拿不到访客桶、凭据不进日志与数据库。
#     机器解析请直接跑 node scripts/proxy-acceptance.mjs（npm 会在 JSON 前多打两行 notice）。
cd /srv/sanjiang && npm run acceptance:proxy     # 必须 status: ok（11 项全部通过）
# 5) 登录与后台
#    浏览器打开 https://res.example.edu/admin/ ，用第 5 步建的管理员登录
# 6) 限流按访客生效（不需要压测，看表即可）
sudo -u sanjiang sqlite3 /srv/sanjiang/data/site.sqlite \
  "SELECT key,count FROM rate_limits WHERE key LIKE 'login-client:%';"
#    出现多个不同哈希 = 正常；
#    只有 login-site / 空的 login-client = 代理没带 X-Sanjiang-Proxy-Secret 或没覆盖写单值 XFF
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

## 13. 安全注意事项（与 [SECURITY-SPEC](../security/SECURITY-SPEC.md) 对应）

1. **不要**把 4321 直接暴露到公网；如果必须直连（例如只在本机使用），设 `TRUST_PROXY=0`，并接受"所有请求共享一个限流桶"的语义。
2. 应用只采信"持有 `TRUST_PROXY_SECRET` 的代理"写入的**单值** `X-Forwarded-For`（头名 `X-Sanjiang-Proxy-Secret`）。Caddy/Nginx 默认**追加** XFF，必须按本文覆盖写；凭据缺失或写错同样会退化为站点级限流。
3. `TRUST_PROXY_SECRET` 是密钥：只放在 `/etc/sanjiang/sanjiang.env`（640）与 nginx 的 include 片段（600），不进仓库、不进备份、不进访问日志（`log_format` 不要带该头）。
4. 备份含口令哈希与反馈正文：放仓库之外、`0700`、最好加密（`age`/`gpg`）后再异地复制。
5. 定期：`npm audit`、`apt upgrade`、证书到期检查（certbot 自动续期需验证 `systemctl list-timers | grep certbot`）。
6. 事故处置：先改密/停用账号撤销会话，再保全 `data/site.sqlite` 与 journal 日志，最后按 [安全档案](../../reports/security/README.md) 的流程记录。
