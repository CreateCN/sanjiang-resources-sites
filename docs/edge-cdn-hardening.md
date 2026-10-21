# 公网暴露与边缘防护（CDN / CC / DDoS）

本文回答一个问题：**站点放到公网以后，源站怎么不被绕过、被打了怎么不死**。
适用于 Docker 与宿主机两种部署（配置片段以 Nginx 为准，Caddy 差异在 §9 单列）。

> 前置事实（来自本仓库当前实现，务必先读）：
> 1. 应用自己承担了**按访客**的限流（登录/反馈/指标），身份来自 `TRUST_PROXY=1` + 代理覆盖写入的单值 `X-Forwarded-For`（见 [SECURITY-SPEC](SECURITY-SPEC.md) §2.1、§6）。**边缘层如果改坏了客户端地址，应用层限流会立刻退化成"全站一个桶"。**
> 2. 当前中间件对所有响应下发 `Cache-Control: no-store`，所以 CDN 目前**只能回源、不能缓存 HTML**。想用边缘缓存扛量，需要先改代码放行 `/_astro/*`、`/images/*` 的缓存（未在本文实施，见 §8）。
> 3. 源站默认只把 4321 绑在 `127.0.0.1`。任何"为了省事直接暴露 4321/80/443"的操作都会让下面所有防护失效。

---

## 0. 先明确威胁与边界

| 场景 | 攻击者做什么 | 主要防线 |
|---|---|---|
| 绕过 CDN 打源站 | 扫到源站真实 IP，直接打 80/443/4321 | §1 源站白名单 + 默认证书拒绝 |
| 盗链 / 刷流量 | 把图片、静态资源挂到别处 | §4 CDN Referer/URL 鉴权 |
| CC（模拟正常请求） | 高频打首页、搜索、登录、反馈 | §3 Nginx `limit_req/limit_conn` + 应用限流 |
| 大流量 DDoS | SYN/UDP Flood、超大并发 | §6 DCDN 边缘防护 → §7 高防（按需） |
| CDN 侧"沙箱" | 平台为保护全网把你的域名切走 | §5 应急预案（**这时攻击流量费仍计费**） |

一条原则：**CDN 是加速与第一层过滤，不是"抗攻击"的保证**。源站必须假设"CDN 会失效/被切走"，并且自己能活下来。

---

## 1. 第一层：源站隐身（零成本，优先级最高）

### 1.1 顺序很重要：先 `real_ip`，再白名单，最后才是限流

Nginx 处理顺序里，`realip` 模块在 `post-read` 阶段就把 `$remote_addr` 改成真实客户端地址。因此：

- **判断"这个连接是不是 CDN 来的"必须用 `$realip_remote_addr`**（改写前的原始对端，即 CDN 回源节点 IP）；
- **限流/日志必须用 `$remote_addr`**（改写后的真实访客 IP）。

用错变量就会出现两种典型事故：白名单把真实访客全挡了，或者限流把全站压成一个桶。

### 1.2 `http {}` 里的公共配置

```nginx
# 只信任 CDN 回源段（务必从控制台下载最新清单，不要抄网上的旧列表）
set_real_ip_from 163.171.0.0/16;
set_real_ip_from 147.138.0.0/17;
# ... 其余回源段，IPv6 也要加
real_ip_header   X-Forwarded-For;
real_ip_recursive on;

# 白名单基于「改写前的对端地址」= CDN 回源节点
geo $realip_remote_addr $from_cdn {
    default 0;
    163.171.0.0/16 1;
    147.138.0.0/17 1;
    # ... 与上面 set_real_ip_from 保持一致
    127.0.0.1 1;       # 本机健康检查 / 运维
    10.0.0.0/8 1;      # Docker 网桥、内网探活
    ::1 1;
}
```

> 变量从哪来：阿里云 CDN/DCDN 控制台「回源节点 IP / IP 列表」；Cloudflare 用 `cloudflare.com/ips`。**清单会变**，把它做成部署检查项（§10）。

### 1.3 直连请求静默丢弃 + 未知 SNI 拒绝握手

```nginx
# 443 默认 server：只负责拒绝（不配任何真实证书）
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    ssl_reject_handshake on;      # nginx >= 1.19.4；老版本用一张自签占位证书
}

server {
    listen 443 ssl;
    server_name res.example.edu;

    # 必须在 server 顶部、任何 location 之前
    if ($from_cdn = 0) { return 444; }   # 静默断开：扫描器只看到连接被重置

    ssl_certificate     /etc/letsencrypt/live/res.example.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/res.example.edu/privkey.pem;
    # ...
}
```

要点：

- **没有 CDN 时不要写 `if ($from_cdn = 0)`**：`geo` 未定义该变量时值为空，会把所有请求都 444。要么整段注释掉，要么先确认 `geo` 已定义。
- `return 444` 比 403 更少信息，但**不返回任何响应**，排障时容易误判成"网络不通"——上线后先用 §10 的验证命令确认"白名单内的能进、白名单外的被断"。
- 只挡 443 不够：80 端口的 `default_server` 也要 `return 444`（或 301 到 https 后再挡）。
- **证书泄露不是主要风险，源站 IP 暴露才是**。但配 `ssl_reject_handshake` 能顺手让"直连 IP 扫证书"这条路失效，成本几乎为零。

### 1.4 端口层面再收一层（可选但推荐）

- 云安全组/防火墙：只允许 CDN 回源段访问 80/443；4321 只允许 `127.0.0.1`。
- 源站不要监听公网 IPv6 的 4321（`docker-compose.yml` 已绑 `127.0.0.1`，别改）。
- 若使用云厂商的"源站保护"功能（如果有），与 §1.3 二选一即可，不要叠加造成自己排障困难。

---

## 2. 自查：你真的把源站藏起来了吗

在**站外**机器上执行（把 IP 换成源站真实 IP）：

```bash
# 1) 直连 IP + 正确 SNI：应超时/被重置，而不是返回页面
curl -k -sS --resolve res.example.edu:443:203.0.113.10 https://res.example.edu/ -o /dev/null -w '%{http_code}\n'
# 2) 直连 IP + 错误 SNI：应握手失败
curl -k -sS https://203.0.113.10/ -o /dev/null -w '%{http_code}\n'
# 3) 直连 80：应被丢弃
curl -sS http://203.0.113.10/ -o /dev/null -w '%{http_code}\n'
# 4) 应用端口：应完全不可达
curl -sS --max-time 3 http://203.0.113.10:4321/api/health/ -o /dev/null -w '%{http_code}\n'
```

预期：1~3 全部连接失败或超时，4 直接 refused。**只要有一条返回 200，源站就是裸奔的**，先修这个再谈其他。

> 本文的 `geo` + `return 444` + `ssl_reject_handshake` 组合已在 **nginx 1.27.5** 上实测（2026-10-21）：
> 白名单来源放行（无上游时返回 502）、非白名单来源连接被直接关闭（curl exit 56）、
> **伪造 `X-Forwarded-For: 127.0.0.1` 也无法绕过**（白名单看的是 `$realip_remote_addr`，不被 XFF 影响）、
> 未知 SNI 握手失败（curl exit 35）。

---

## 3. 第三层：Nginx 应用层限流（抗 CC 的主力，零成本）

在 `http {}` 定义区域，在 `location` 应用。**所有限流的 key 都用 `$remote_addr`（已被 realip 改写为真实访客）**：

```nginx
limit_req_zone  $binary_remote_addr zone=page:10m rate=10r/s;
limit_req_zone  $binary_remote_addr zone=api:10m  rate=2r/s;
limit_conn_zone $binary_remote_addr zone=conn:10m;
limit_req_status  429;   # 与应用层保持一致的语义，便于前端/监控统一处理
limit_conn_status 429;
log_format edge '$remote_addr "$request" $status req=$request_time '
                'limit_req=$limit_req_status limit_conn=$limit_conn_status';

server {
    # ...
    location / {
        limit_req  zone=page burst=20 nodelay;
        limit_conn conn 20;
        proxy_pass http://127.0.0.1:4321;
    }

    location ^~ /api/ {
        limit_req  zone=api burst=10 nodelay;
        limit_conn conn 10;
        proxy_pass http://127.0.0.1:4321;
    }

    location ~* \.(?:css|js|woff2?|png|jpe?g|webp|svg|ico)$ {
        limit_req  zone=page burst=60 nodelay;   # 静态资源放宽
        proxy_pass http://127.0.0.1:4321;
    }
}
```

为什么这样设：

- 页面 10 r/s、API 2 r/s 是"单个真人绝不会超过"的量级；`burst` 用来吸收首屏并发，`nodelay` 让超限立刻 429 而不是排队（排队会占住 worker，反而放大攻击效果）。
- 静态资源放宽 60，避免正常浏览被误伤。
- **两层限流不冲突**：Nginx 负责"量"（每秒请求数、并发连接），应用负责"业务语义"（登录失败次数、反馈配额、指标写入，见 SECURITY-SPEC §6）。应用返回 429 时带真实 `Retry-After`；Nginx 层 429 是粗粒度兜底。

运维注意：

- 监控 `$limit_req_status`（`PASSED`/`REJECTED`/`DELAYED`），否则你永远不知道是自己配错还是真被打。
- 校园网出口常见 NAT：同一出口 IP 会有很多学生。**按校园网整段限流会误伤**，必要时应把学校出口段加入单独更宽的 zone，或对 `Referer`/已登录会话放行（`map` 实现，见 §9）。
- 有 CDN 时，Nginx 看到的源 IP 来自 CDN 回源节点。**如果不配 §1.2 的 `real_ip`，这里所有 `$binary_remote_addr` 会变成几十个 CDN 节点 IP，等于给几个 IP 设了全站总配额**——一次正常活动就能把全站打成 429。这是本方案里最容易踩的坑。

---

## 4. 第二层：CDN 控制台的免费访问控制

| 能力 | 建议 | 说明 |
|---|---|---|
| Referer 白名单 | 开 | 只允许 `res.example.edu` 及其子域访问静态资源；空的 Referer 建议**拒绝**（除非有客户端直连需求） |
| URL 鉴权（签名） | 资源敏感/流量贵时开 | 需要应用生成带签名 URL，属于代码改动；纯公开目录站可先不开 |
| IP / UA 黑名单 | 有明确特征时开 | 别用"猜"的特征建规则，容易误伤校园网 |
| 带宽封顶 / 流量告警 | 必开 | 防止被刷到欠费；与 §5 的费用风险直接相关 |
| HTTPS 回源 + 回源 HOST | 必开 | 回源走 443 并带上正确 `Host`，否则 §1.3 的 `server_name` 匹配不上 |

---

## 5. 应急预案：CDN 被切"沙箱"时怎么办

**要接受的事实**：CDN 平台为了全网稳定，可能把你的域名切入沙箱（表现为大面积 403/无法访问），**期间攻击流量产生的费用仍由你承担**。所以预案不是"让 CDN 别切"，而是"切了以后你怎么活"。

预案（按顺序）：

1. **先看账与量**：确认是攻击流量还是配置错误；打开费用告警与 CDN 的实时监控。
2. **不要在攻击中放开源站白名单**。把白名单整体打开 = 把源站直接交给攻击者，通常 5 分钟内就会被打挂。
3. **预置一个不公开的运维入口**：例如 `ops.example.edu`，只允许运维固定 IP + 监控探针，用同一套 Nginx（不同 `server` 块、独立白名单），平时不用、出事时用来登录后台改内容/导数据。
4. **静态兜底页（可选）**：CDN 或对象存储放一个"维护中"静态页，切换 DNS 到它，保证访客看到的是说明而不是超时。
5. **记录与复盘**：保存 CDN 侧日志、账单、时间线；按 [安全档案](../reports/security/README.md) 的流程归档。

这条预案的价值在于：**你不需要在被打的时候做架构决策**——决策已经提前做完并演练过。

---

## 6. 第四层：DCDN（需要边缘 DDoS 防护时再升级）

- 普通 CDN：加速 + 缓存 + 基础访问控制，**不含** DDoS 清洗承诺。
- DCDN（全站加速）：可在控制台开启**边缘 DDoS 防护**，不必单独买高防实例；单价略高，但比"高防实例 + CDN"组合便宜得多。
- 判断标准：出现**持续、成规模**的 L3/L4 攻击或清洗需求时再升级；只在被 CC 时，§3 的 Nginx 限流 + 应用限流通常够用。
- 升级时注意：**回源 IP 段会变**，必须同步更新 §1.2 的 `set_real_ip_from` 与 `geo`，否则源站白名单会把新回源节点挡在外面（表现为"升级后 100% 502/超时"）。

---

## 7. 第五层：WAF 与高防（按需，不作为起步配置）

| 产品 | 解决什么 | 本项目何时考虑 |
|---|---|---|
| WAF | SQLi/XSS/上传/精细 CC（人机验证） | 出现真实应用层攻击、或后台被撞库时；当前代码层已有参数化/转义/CSP，**优先级低于源站隐身与限流** |
| DDoS 高防 | 超大流量 L3/L4 清洗 | 面临明确勒索/持续攻击且 DCDN 扛不住时；对校园非营利项目成本很高 |

关于"在 Node 里加 `parry`、`secure-shield` 之类中间件"：**本项目不建议引入**。原因是

1. 这类包维护状态与审计透明度参差，引入即扩大供应链面（我们刚把运行时依赖收敛到极少数）；
2. 项目已有的防线是"结构性的"——zod schema 校验、参数化 SQL、模板转义 + CSP、Markdown 白名单、按访客限流，这些比"启发式特征匹配"更可靠；
3. 真需要应用层规则，优先写**本项目自己的小中间件**（几十行、可测试、可审计），而不是引一个黑盒依赖。

---

## 8. 与本项目现状的两处冲突（必须先知道）

1. **`no-store` 让 CDN 只能回源**：中间件对所有响应设置 `Cache-Control: no-store`。这意味着 CDN 无法缓存 HTML，静态资源也大概率回源，抗量能力大打折扣。若要利用边缘缓存，需要改代码：对 `/_astro/*`（带内容哈希）与 `/images/optimized/*` 放行 `public, max-age=31536000, immutable`，其余仍 `no-store`。**这是代码改动，本文不实施**，需按 [SECURITY-SPEC](SECURITY-SPEC.md) 走评审。
2. **应用限流依赖 `TRUST_PROXY=1` + 单值 XFF**：Nginx 在 `real_ip` 之后用 `proxy_set_header X-Forwarded-For $remote_addr;` 转发真实访客地址，正好满足应用的契约；**不要**改成 `$proxy_add_x_forwarded_for`，否则应用会收到多值链并退化为"未验证来源"桶（表现为所有人共享一个限流额度）。

---

## 9. 变体：Caddy 与"跳过限流"的白名单

Caddy（自动 HTTPS，但默认**追加** XFF，必须覆盖）：

```caddyfile
res.example.edu {
    @not_cdn not remote_ip 163.171.0.0/16 147.138.0.0/17 127.0.0.1 10.0.0.0/8
    respond @not_cdn "" 444

    reverse_proxy 127.0.0.1:4321 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Real-IP {remote_host}
    }
}
```

注意：Caddy 的 `{remote_host}` 在它自己解析真实 IP 之后才是访客地址；若前面还有 CDN，需要 `trusted_proxies` 配置，否则 `remote_ip` 匹配的是 CDN 节点。

对可信来源（校园网出口、监控探针）跳过限流：Nginx **不支持** `limit_req zone=$变量`，正确做法是让 key 变成空字符串——**key 为空的请求不计入限流**：

```nginx
geo $limit_exempt {
    default 0;
    10.10.0.0/16 1;      # 示例：校园网出口
}
map $limit_exempt $limit_key {
    default $binary_remote_addr;   # 普通访客按 IP 计数
    1       "";                    # 可信来源：空 key，不计数
}
limit_req_zone $limit_key zone=page:10m rate=10r/s;
limit_req_zone $limit_key zone=api:10m  rate=2r/s;
```

注意：

- 空 key 只对 `limit_req`/`limit_conn` 生效，**应用层限流仍然按身份算**，所以放行的只是"边缘这一层"，不会削弱登录/反馈配额。
- 校园网整段放行要谨慎：一旦该段被滥用，你等于给它开了后门。建议只放监控探针与运维固定 IP，校园网出口改用"更宽的独立 zone"（例如 `rate=30r/s burst=60`）。
- 备选做法：给可信来源单独一个 `server` 块（不同端口/域名），完全不挂 `limit_req`，并在防火墙层限制来源。**不要把"内网段"直接写进公网 server 的放行名单。**

---

## 10. 上线检查清单（复制到变更单里逐条打勾）

```bash
# 配置语法与生效
sudo nginx -t && sudo nginx -T | grep -E 'set_real_ip_from|real_ip_header|geo \$realip_remote_addr' 

# 源站确实隐身（在站外机器执行，见 §2 四条命令）

# 限流 key 是否真的是访客 IP（看日志里的 $remote_addr 是否多样）
sudo tail -n 50 /var/log/nginx/edge.log | awk '{print $1}' | sort | uniq -c | sort -rn | head

# 应用侧身份是否仍然"按访客"
sqlite3 /srv/sanjiang/data/site.sqlite \
  "SELECT key,count FROM rate_limits WHERE key LIKE 'login-client:%';"
#   多个不同哈希 = 正常；只有一个 = real_ip 或 TRUST_PROXY 配错

# CDN 回源段是否最新（与控制台比对）
#   记录本次核对日期：____________  下次核对：____________
```

变更记录模板：

| 日期 | 变更 | 影响面 | 回滚方式 |
|---|---|---|---|
| | 开启源站白名单（`return 444`） | 所有直连流量 | 注释 `if ($from_cdn = 0)` 并 reload |
| | 开启 `limit_req/limit_conn` | 高并发访客 | 调整 rate/burst 或注释 zone |
| | 升级 DCDN | 回源段变化 | 同步 `set_real_ip_from`/`geo`，必要时回退 CDN |

---

## 11. 落地顺序（务实版）

1. **今天**：§1 源站白名单 + §2 四条验证。不做这步，后面全部可被绕过。
2. **本周**：§3 Nginx 限流（先观察模式跑 24 小时：`limit_req` 只记日志不拒绝，确认无误伤再开拒绝）+ §4 CDN 免费访问控制 + 费用告警。
3. **观察期**：盯 `$limit_req_status`、`rate_limits` 键分布、CDN 带宽与 4xx/5xx；有异常先查配置再看攻击。
4. **确有攻击**：按 §5 演练预案 → 评估 §6 DCDN →
   §7 才考虑 WAF/高防。
5. **长期**：每季度核对一次回源 IP 段、跑一次 §2 与 §10；把"源站是否裸奔"纳入例行检查。
