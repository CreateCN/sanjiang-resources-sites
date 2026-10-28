# 三江资源：本地生产部署 + 攻击者视角黑盒安全审查

审查日期：2026-10-21（北京时间 18:52–19:30）。基准提交 `135033be93159fcefa23a9a7b7ebb5453613c8ef`。

> **状态（2026-10-21 20:00）**：本报告与 BF-REPORT 的主要问题已修复并验证，改动与数据见 [ROOT-CAUSE-AND-FIX.md](ROOT-CAUSE-AND-FIX.md) §13 与 `evidence-bf/23-fix-verification.json`。

> 后续的暴力式攻击测试见同目录 [BF-REPORT.md](BF-REPORT.md)（其中更正了本文 ATK-02 关于 `X-Forwarded-For` 的推断）；源码级根因与修复方案见 [ROOT-CAUSE-AND-FIX.md](ROOT-CAUSE-AND-FIX.md)（该文按源码更正了反馈与指标的锁定窗口为 1 小时）。

## 结论

在按 README「部署要点」推荐方式（Docker 生产镜像 + Nginx HTTPS 反向代理，剥离 `X-Forwarded-For`）搭建的环境里，发现一个体系性问题：

**应用把"来源 IP"当成限流身份，而在反向代理后所有访客的来源 IP 都是代理自身。** 结果是原本设想为"按访客"的配额，在正式部署里退化为**全站单一桶**：

- 匿名者发 **约 30 次登录请求**（用户名可任意编造，无需知道任何账号），全站所有账号（管理员+编辑者）的新登录被拒 15 分钟，`Retry-After: 900`，可无限重复（ATK-01，中）。
- 匿名者发 **5 次反馈请求**（非法请求也算），全站反馈入口被拒 **最长 1 小时**（源码 `http.ts:216` 的窗口是 60 分钟，`Retry-After` 却写死 900 秒，见 ATK-02，中）。
- 另有一条同源但方向相反的失效：透传 `X-Forwarded-For` 的代理会落入应用的另一只「共享保守桶」，与推荐配置的桶互不相通，于是同一份配额被拆成两个 5 次/30 次的桶（ATK-02 末尾，已更正早前推断）。

另有三项低风险与信息类问题：单账号 10 次尝试即硬锁 15 分钟且**成功登录也计数**（ATK-03）、同一账号可并存多个会话且无集中撤销入口（ATK-04）、缺少 CSP/HSTS 与若干信息暴露（ATK-05）。

在本次覆盖范围内**未复现**认证绕过、权限提升、可执行 XSS、SSRF（无法验证，见 ATK-06）、路径穿越、敏感文件下载、请求走私或缓存投毒。结论只适用于实际测试的输入与部署形态。

未阅读 `src/`、构建产物、现有测试与 `scripts/security-audit.mjs`；只阅读 README、`docs/product/FEATURES.md`、`package.json`、`Dockerfile`、`docker-compose.yml`、`.env.example` 作为部署与功能边界。未修改任何原有源码、配置或文档（`git status` 仍为审查前状态：`README.md` 已有修改、`docs/product/FEATURES.md`、`scripts/security-audit.mjs`、`reports/` 未跟踪）。页面 HTML、HTTP 响应、浏览器 DOM 与运行日志属于黑盒观察对象。

## 部署与环境

- 按现有 `Dockerfile` 从当前 HEAD 重新构建生产镜像 `sanjiang-attacker:20261021`（`sha256:2935185e…3ac32`），运行 `dist/server/entry.mjs`（Node 24.22.0，Astro 5.18.2，`@astrojs/node` 9.5.5）。未使用开发服务器。
- 链路：测试客户端 → `https://localhost:8443` → Nginx 1.27.5 → 应用 `4321`。`SITE_URL=https://localhost:8443`，数据库为独立命名卷，权限与生产一致（容器内 `node` 用户）。
- Nginx 采用 README 推荐的写法：`proxy_set_header X-Forwarded-For "";`、`X-Real-IP ""`、`X-Forwarded-Proto https`、`Host $http_host`、`client_max_body_size 1m`。配置见 [nginx-instance1.conf](nginx-instance1.conf)。
- 为区分变量，另建四个临时实例（均已删除）：8463/8473（推荐配置与"完全不发 XFF"对照）、8483（直连应用、无反代）、8503/8504（推荐配置与 XFF 透传对照）。配置见 `nginx-instance3-ratelimit.conf`、`nginx-instance4-no-xff.conf`、`nginx-instance7-xff-test.conf`。
- TLS 使用两天有效的本地自签证书，仅在探测客户端跳过校验；浏览器用 headless Chrome 校验公开页 DOM。
- 账号通过文档化 CLI 创建（`node scripts/create-admin.mjs`），编辑者通过后台「人员与权限」创建。测试口令只写入 `/tmp/sj-attacker/runtime.env`（0600），不入库、不入报告。
- 只操作本地测试数据库；不攻击第三方站点、真实云元数据或真实内网主机。

## 发现

### ATK-01：反向代理部署让登录限流变成全站单桶，30 次匿名请求锁死全站登录

**风险：中（可用性）；已复现。触发条件：能访问 `/api/login/`，无需任何账号。**

在干净实例上从同一来源（经 Nginx）连续提交登录请求，每次使用不同账号的正确口令：

| 实例 | 拓扑 | 结果 |
|---|---|---|
| I3 (8463) | 推荐配置 | 账号维度先命中（同一账号第 11 次 429），来源维度未满时其它账号仍 303；**累计第 31 次请求时来源维度耗尽，此后所有账号一律 429** |
| I4 (8473) | 完全不发 XFF | **第 31 次 429**；随后独立容器来源登录同样 429 |
| I5 (8483) | 直连应用 | **第 31 次 429**；但**独立容器来源仍 303** → 说明限制是"按来源"，不是全局 |
| I1 (8443) | 推荐配置 | 429 出现在 **4 个不同来源**（172.21.0.1/.4/.5/.6），首个 429 于 18:54:36，19:10:01 恢复 |

也就是说：直连部署时"每来源 30 次/15 分钟"是合理防护；**一旦放到反向代理后面，所有访客共享代理这一个来源，同一份配额就变成全站配额**——任何匿名者用 30 次请求（分散到 3 个以上用户名，避免先撞上单账号 10 次上限）即可让管理员和编辑者全部无法登录，持续 15 分钟，且到期后可立刻重复。

关键证据：

- 计数与跨账号结果：[09-ratelimit-summary.json](evidence/09-ratelimit-summary.json)、[rate-limit-measurements.json](evidence/rate-limit-measurements.json)。
- 多来源 429 与恢复时刻：[nginx-instance1-access.log.gz](nginx-instance1-access.log.gz)（`"status":429` 分布在 `172.21.0.1`、`172.21.0.4`、`172.21.0.5`、`172.21.0.6`）。
- 直连对照（按来源而非全局）：[app-runtime-instance5.log.gz](app-runtime-instance5.log.gz)。
- 登录全站锁定时**已有会话仍可正常操作后台**，反馈接口也仍返回 303，说明影响面限于"新登录"。

补充一：**不需要任何真实账号**。窗口内 14 次成功登录 + 17 次不存在用户名的失败登录后即触发 429（[16-nonexistent-username-counting.json](evidence/16-nonexistent-username-counting.json)），攻击者可凭空打满来源桶。

补充二：`X-Forwarded-For` 是否是诱因不成立。I4 的代理**根本不发送**该头，行为与推荐配置一致；I1 的推荐配置实际发送的是**空值**头。两者都出现同一现象，根因是应用侧没有可信的客户端标识来源。

### ATK-02：匿名反馈配额同样退化为全站共享（XFF 透传会再拆出一个独立的共享桶）

**风险：中（可用性 / 限流绕过）；已复现。**

- 推荐配置（I7 8503，干净库）：连续 5 次提交全部 303，**第 6 次 429，`Retry-After: 900`**。校验失败的请求也计入（I1：3 次 400 + 2 次 303 后第 6 次 429）。注意：源码 `http.ts:216` 的窗口是 3600 秒，响应头里写的 900 秒并不准确（详见 ROOT-CAUSE-AND-FIX.md 的 RC-2）。
- 独立来源不获新额度：I4 在配额耗尽后，另一个容器来源提交同样 429（[12-feedback-quota.json](evidence/12-feedback-quota.json)）。
- 后果：任意匿名者用 5 个请求即可让全站反馈（含「版权与下架」入口）停摆 **最长 1 小时**（源码窗口 3600 秒，实测 `rate_limits.reset_at` 剩余 2682 秒时 count 已达 5）。对只有个位数日均反馈的站点，这是很低成本的中断。
- 更正（2026-10-21 19:2x，暴力测试轮补测）：本报告早期版本写过「伪造 XFF 可无限刷新配额」，这一点**不成立**。决定性实验见 [19-keying.json](evidence-bf/19-keying.json)：同一伪造值连续提交 5 次后第 6 次即 429；随后轮换 4 个不同伪造值**全部 429**。真实机制是"两种代理形态对应两只桶"——剥离 XFF（空头）一只、携带 XFF 一只，各自 5 次/窗口且都为全体访客共享；客户端写入的 XFF 数值不参与分桶。

即：同一份代码在两种常见代理配置下分别表现为"全局拒绝服务"和"限流被绕过"，中间没有安全的默认值。

证据：[12-feedback-quota.json](evidence/12-feedback-quota.json)、[04-feedback-summary.json](evidence/04-feedback-summary.json)、[nginx-instance7-access.log](nginx-instance7-access.log)、[rate-limit-measurements.json](evidence/rate-limit-measurements.json)。

### ATK-03：单账号 10 次尝试硬锁 15 分钟，成功登录也计数

**风险：低（可用性 / 策略）；已复现。**

同一账号（正确口令）连续登录：第 1–10 次 303，**第 11 次 429**，`Retry-After: 900`；同期其它账号正常。成功登录与失败登录同样占额度，因此正常运维（多设备、反复切换、自动化冒烟）也可能把自己锁死 15 分钟。这与此前报告记录的"定向锁账号"是同一机制，本次补充了"成功也计数"和"单账号 10 次"两个量化事实。

证据：[09-ratelimit-summary.json](evidence/09-ratelimit-summary.json)、[nginx-instance3-access.log](nginx-instance3-access.log)。

### ATK-04：同一账号可并存多个会话，缺少集中撤销

**风险：低；已观察。**

两次独立登录同一管理员账号后，两个会话**同时有效**（都能打开后台仪表盘）。按 README，只有"密码/状态/角色变更"才撤销该账号现有登录；没有会话列表、没有"退出所有设备"。一旦令牌泄露，在改密之前一直可用（`Max-Age` 8 小时，`HttpOnly`、`SameSite=Strict`、`Secure` 已具备）。Cookie 未使用 `__Host-` 前缀。

证据：[14-deep2.json](evidence/14-deep2.json) 的 `concurrent_sessions`；证据文件 `*-session-concurrency-first.json` / `*-session-concurrency-second.json`。

### ATK-05：加固缺口与少量信息暴露

**风险：信息 / 加固建议；非漏洞利用链。**

1. 全站无 `Content-Security-Policy`（含后台页）；无 `Strict-Transport-Security`、无 `Permissions-Policy`。已见 `X-Frame-Options: DENY`、`nosniff`、`strict-origin-when-cross-origin`、`no-store`。
2. Nginx 版本外泄（`Server: nginx/1.27.5`），`TRACE` 返回 Nginx 默认 405 页并带版本号。
3. `/api/health/` 公开返回 `{"status","db","schema":"002-soft-delete-and-report-revision","uptime"}`——迁移版本与运行时长属于运维内部信息。
4. 未知方法/未知路径的区分不稳定：`/api/manage/` 的 `PUT`/`DELETE`/`PATCH` 返回 404（而非 405），`OPTIONS /` 返回 200。
5. 限流命中返回整页 HTML（约 233–444 字节），而不是轻量 JSON；同时 `Retry-After` 恒为 900，没有渐进退避。

### ATK-06：链接检查（SSRF 面）在本环境无法验证

**结论：未验证，不下判断。**

所有 `check-link` 结果都是"检查失败：不允许检查内网或本机地址"，包括 `https://example.com/`、`https://www.gimp.org/`、`https://1.1.1.1/`、`https://8.8.8.8/`。原因在本机网络：容器内 `getent hosts example.com` 返回 `198.18.0.21`（宿主侧 fake-IP DNS），字面量 `1.1.1.1` 也被拦截，检查器把这批地址判为内网/本机。因此本次**无法**判断它是按主机名还是按解析结果校验、是否跟随重定向、是否受 DNS rebinding 或编码变体影响。可在正常 DNS 环境中按"公网成功 + 回环拒绝 + 重定向到内网拒绝"三条验收重测。

证据：[15-linkcheck.json](evidence/15-linkcheck.json)（四条 URL 的检查结果文本与容器内 DNS 观测）、[07-ssrf-summary.json](evidence/07-ssrf-summary.json)、[nginx-instance6-linkcheck.conf](nginx-instance6-linkcheck.conf)。

## 已验证的防护

| 类别 | 实际测试 | 观察结果 |
|---|---|---|
| 匿名访问控制 | 后台 12 个页面、`/api/export/`、`/admin/preview/*` | 302 到 `/admin/login/` 或 401/403，无数据返回 |
| 编辑者越权 | 人员/设置/分类/导入/审计/指标/回收站页面；创建用户、改角色、发布、删除、导入、导出、恢复、批量复核；`/api/export/` | 页面 302 回 `/admin/`；写操作 403；导出 403（`text/plain`） |
| CSRF 与 Origin | 无 Origin、`null`、后缀域、userinfo、前缀域、http、端口互换、大写、尾点；缺失/空/伪造/他人 CSRF | 全部 403；CSRF 与会话绑定，他人令牌无效；令牌在窗口内可重复使用（非单次） |
| 会话 | 登录前 Cookie、登录后令牌、退出后重放、GET 退出 | 登录前不发放会话；令牌 43 字符随机；退出后读 302、写 401；GET 不触发退出 |
| 存储型注入 | 资源/指南/分类/设置字段与 Markdown：`<script>`、`onerror`、`onload`、`svg`、`iframe`、引号逃逸、表格与代码块 | 公开页、后台列表、后台预览、指标页、反馈页、审计页全部转义；headless Chrome DOM 中 `img[onerror]` 数量为 0 |
| Markdown 链接 | `javascript:`（大小写/实体/反斜杠）、`data:`、`vbscript:`、参照式链接、带引号 title | 危险协议不生成链接而按文本输出；title 引号转义为 `&quot;` |
| 元信息与结构化数据 | `<title>`、OG/Twitter、canonical、JSON-LD、sitemap | 文本上下文转义；JSON-LD 把 `<` 编码为 `\u003c`；属性引号转义为 `&#34;` |
| 反射注入 | `?q`、`?category`、`?type`、`?platform`、`/feedback/?resource=`、后台 `?q`/`?checked` | 无原始载荷回显；参数被规范化或忽略 |
| 路径与静态文件 | `../`、`%2e%2e`、`..%2f`、`//`、反斜杠、`.env`、SQLite、`dist`/`src`/`scripts`、`package.json`、`.git` | 404/400/规范化跳转；未取到文件内容；编码斜杠被 400 拒绝 |
| Host 与代理头 | `Host: evil.example`、带逗号的 Host、空 XFF | canonical/OG 使用 `SITE_URL` 不跟随 Host；畸形 Host 400 |
| 方法与非预期负载 | `OPTIONS/PUT/DELETE/PATCH/TRACE/HEAD`、JSON 打到表单接口、参数污染、1 MiB+ 请求体 | TRACE 405；JSON 415；重复 action 400；超大请求体 413 |
| 请求走私探针 | `CL+TE`、重复 `Content-Length` | Nginx 均 400 拒绝（未继续深挖） |
| 导入导出 | 编辑者导出、管理员导出内容 | 编辑者 403；导出仅含 `schemaVersion/exportedAt/categories/resources/guides/settings`，**不含账户、口令哈希或反馈** |
| 账号与 ID 校验 | 不存在 ID 发布/删除、负数与 SQL 片段 version、不存在用户更新、非法角色、弱口令、重复用户名、非法用户名 | 400/401/403；未出现 500 或栈信息；用户名 `[-A-Za-z0-9_.]{3,64}`、口令 12–256 |
| 度量接口 | 匿名 `POST /api/event/` 的 `search_miss`/`outbound_click`/`guide_view` 注入、缺 Origin、异站 Origin、错误 JSON | 无 Origin/异站 403；注入内容在后台表格中转义显示 |

## 复现步骤（仅对本地测试部署）

ATK-01（全站登录锁定）：

```bash
# 1) 按 Dockerfile 构建并以 README 推荐方式挂在 Nginx 后（SITE_URL 与浏览器地址一致）
# 2) 用 31 次登录请求（分散到 3 个以上账号，正确口令亦可）打满来源配额
#    注意：单一账号会先撞上"每账号 10 次"上限，需换用多个账号才能打满来源桶
for i in $(seq 1 31); do
  curl -sk -o /dev/null -w '%{http_code}\n' -X POST https://localhost:8443/api/login/ \
    -H 'Origin: https://localhost:8443' \
    --data-urlencode "username=acct-$i" --data-urlencode 'password=Whatever-Pass-12'
done
# 3) 换任意账号、换任意客户端主机再试：均为 429，Retry-After: 900
# 4) 对比：把应用端口直连（不加反向代理）重复上述步骤，
#    另一台主机仍可登录 —— 说明限制原本是"按来源"，在代理后退化为全站
```

ATK-02（反馈停摆与配额绕过）：

```bash
# 推荐配置：第 6 次即 429（前 5 次含非法请求同样计数）
for i in $(seq 1 6); do
  curl -sk -o /dev/null -w '%{http_code}\n' -X POST https://localhost:8443/api/reports/ \
    -H 'Origin: https://localhost:8443' \
    --data-urlencode 'resourceId=' --data-urlencode 'kind=其他建议' --data-urlencode 'website=' \
    --data-urlencode "title=t$i" --data-urlencode 'body=测试正文，长度超过十个字符。'
done
# 对照：另一套"携带 XFF"的前端有独立的 5 次桶，但伪造值本身不产生新桶
curl -sk -o /dev/null -w '%{http_code}\n' -X POST https://localhost:8643/api/reports/ \
  -H 'Origin: https://localhost:8643' --data-urlencode 'resourceId=' \
  --data-urlencode 'kind=其他建议' --data-urlencode 'website=' \
  --data-urlencode 'title=x' --data-urlencode 'body=推荐配置下的配额测试正文。'
# 同一伪造值 ×6 → 第 6 次 429；换成 4 个不同伪造值 → 仍全部 429
```

ATK-03（账号自锁）：对同一账号用正确口令连续登录 11 次，第 11 次 429，`Retry-After: 900`；同期其它账号正常。

## 修复建议

1. **先解决限流身份，再谈阈值。** 在应用层引入显式的代理信任配置：允许的代理网段/Unix socket + 只从可信连接取最右侧转发地址，并在应用内做规范化；或者在代理与应用之间用 Unix socket，让"来源"不再被所有人共用。修复验收必须包含三条：两个独立来源互不耗尽对方配额、伪造转发头不获得新额度、登录与反馈在代理后仍是"按访客"而非"按站点"。
2. **配额分层，不要用一个桶承担全部语义。** 建议：账号维度（失败计数 + 指数退避 + 渐进验证码）、客户端维度（较宽）、站点级熔断（很保守，仅用于明显攻击）。登录与反馈分开，互不影响（当前已分开）。
3. **把"成功登录"从失败计数里剔除。** 失败才计数、成功清零或衰减，避免正常运维自锁；锁定时间从固定 900 秒改为渐进（如 30s→2m→10m），并给维护者留可控恢复路径。
4. **429 响应轻量化**：JSON + 明确的 `Retry-After`，避免整页 HTML；对自动化调用方保留可判定字段。
5. **会话治理**：提供会话列表与"退出所有设备"；改密之外支持主动撤销；Cookie 名可改为 `__Host-sanjiang_session`。
6. **头部加固**：先上 `Content-Security-Policy: Report-Only` 收集兼容性，再转强制；真实域名与证书稳定后再加 HSTS；补 `Permissions-Policy`；`server_tokens off` 隐藏 Nginx 版本；`/api/health/` 只保留 `status/db`，`schema` 与 `uptime` 移到内部探针。
7. **链接检查在正常 DNS 环境重测**，验收三条：公网成功、回环/私网拒绝、重定向到内网拒绝，并记录是否按解析结果校验。

## 未覆盖与限制

- 全部结论来自 HTTP 行为与页面输出，没有源码级根因定位（按要求未读源码），也没有读到限流实现细节，因此"30 次/5 次/10 次"是观测阈值，不排除还受时间窗切片、并发或实现细节影响。
- 只完整测量了一个 900 秒窗口（I1：18:54:36 触发、19:10:01 恢复）；未做多小时持续按压、并发压测或容量评估。
- 未做依赖漏洞扫描、容器逃逸、宿主机测试、TLS 配置扫描、备份恢复演练；未测试真实生产域名与真实账户。
- 链接检查因本机 fake-IP DNS（198.18.0.0/15）无法产出成功样本，SSRF 相关内容一律标为未验证。
- 后台流程通过 HTTP 客户端完成；浏览器仅用于公开页 DOM 校验，未在受信任 HTTPS 浏览器里走完整后台操作链。
- 未覆盖：请求走私深度探测、HTTP/2、缓存投毒、WebSocket、上传（无上传功能）、邮件/短信（无此功能）。

## 附件、当前环境与清理

- 关键量化结论：[evidence/rate-limit-measurements.json](evidence/rate-limit-measurements.json)。
- 各阶段汇总：[02-auth-summary.json](evidence/02-auth-summary.json)、[03-write-summary.json](evidence/03-write-summary.json)、[05-content-summary.json](evidence/05-content-summary.json)、[06-reflection-summary.json](evidence/06-reflection-summary.json)、[08-throttle-summary.json](evidence/08-throttle-summary.json)、[09-ratelimit-summary.json](evidence/09-ratelimit-summary.json)、[10-http-summary.json](evidence/10-http-summary.json)、[11-admin-api-summary.json](evidence/11-admin-api-summary.json)、[12-feedback-quota.json](evidence/12-feedback-quota.json)、[13-admin-deep.json](evidence/13-admin-deep.json)、[14-deep2.json](evidence/14-deep2.json)。
- 逐请求证据：`evidence/` 下的 `.json`/`.html`（含响应头、状态、截断正文），以及 headless Chrome 的 [dom-resource.html](evidence/dom-resource.html)、[dom-search.html](evidence/dom-search.html)。
- 反馈阶段汇总 [04-feedback-summary.json](evidence/04-feedback-summary.json) 由逐请求证据重建（原脚本写入汇总前中断），不改变原始证据。
- 代理配置：[nginx-instance1.conf](nginx-instance1.conf)、[nginx-instance2-identity-test.conf](nginx-instance2-identity-test.conf)、[nginx-instance3-ratelimit.conf](nginx-instance3-ratelimit.conf)、[nginx-instance4-no-xff.conf](nginx-instance4-no-xff.conf)、[nginx-instance6-linkcheck.conf](nginx-instance6-linkcheck.conf)、[nginx-instance7-xff-test.conf](nginx-instance7-xff-test.conf)。
- 日志：[nginx-instance1-access.log.gz](nginx-instance1-access.log.gz)、[nginx-instance3-access.log](nginx-instance3-access.log)、[nginx-instance4-access.log](nginx-instance4-access.log)、[nginx-instance7-access.log](nginx-instance7-access.log)、[app-runtime-instance1.log.gz](app-runtime-instance1.log.gz)、[app-runtime-instance5.log.gz](app-runtime-instance5.log.gz)、[build.log](build.log)。
- 部署事实：[deployment.txt](deployment.txt)、[commit.txt](commit.txt)。脚本：`scripts/*.py`（本次新写的黑盒驱动，如需原样运行请替换账号与地址）。
- `SHA256SUMS` 为本目录内文件校验和。

**当前状态**：仅保留主实例 `sanjiang-atk-app`、`sanjiang-atk-nginx`（`127.0.0.1:8443` 推荐配置、`127.0.0.1:8080` 透传对照），数据在命名卷 `sanjiang-atk-data`，内含本次测试资源/指南/反馈（`probe-*`、`ssrf-*`、`lc*`），**不是干净库**。测试账号口令在 `/tmp/sj-attacker/runtime.env`（0600），不在仓库内。其余四个临时实例、容器、网络与数据卷已删除。

停止主实例：`docker stop sanjiang-atk-app sanjiang-atk-nginx`；彻底清理：`docker rm -f sanjiang-atk-app sanjiang-atk-nginx && docker volume rm sanjiang-atk-data && docker network rm sanjiang-atk-net`。需要干净环境时直接 `docker compose up -d --build`，用 CLI 重建管理员。
