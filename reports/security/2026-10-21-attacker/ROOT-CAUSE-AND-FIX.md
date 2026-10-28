# 源码级根因分析与修复方案（未改动任何源码）

对象：`135033be93159fcefa23a9a7b7ebb5453613c8ef`（工作区另有未提交的 `README.md` 修改与未跟踪文件，与本次分析无关）。
方法：把前两轮黑盒观测逐条回落到代码路径，并用运行中的实例做交叉验证（例如直接用 `rate_limits` 表反推限流身份）。**本轮只读代码、只写报告，没有修改 `src/`、配置或数据库结构。**

> 相关报告：[REPORT.md](REPORT.md)（黑盒审查）、[BF-REPORT.md](BF-REPORT.md)（暴力测试）。本文所有代码引用基于当前工作区文件，行号以 `135033be` 为准。

## 结论摘要

| 编号 | 现象（黑盒已复现） | 代码位置 | 根因一句话 | 优先级 |
|---|---|---|---|---|
| RC-1 | 代理后全站共享一只登录/反馈/指标桶 | `src/server/http.ts:76-82`、`src/server/security.ts:30-42` | 拿不到真实客户端地址，只能退化成常量身份 | P0 |
| RC-2 | 429 恒为 900 秒，反馈/指标实际锁 1 小时 | `src/server/http.ts:67`、`http.ts:216`、`http.ts:263` | `Retry-After` 写死；两处窗口用 1 小时 | P0 |
| RC-3 | 成功登录也吃额度、单账号 10 次硬锁 | `src/server/auth.ts:36-39` | 限流在校验口令**之前**按"尝试"计数 | P0 |
| RC-4 | 不存在用户名同样 429，无枚举差异 | `src/server/auth.ts:37-39` | 用户名先规范化再计数，与用户是否存在解耦 | 已达标（保留） |
| RC-5 | 匿名可写入 600 条/小时并"打空"指标 | `src/server/http.ts:244-266`、`src/server/store.ts:325-333` | 事件目标不校验、无去重配额、桶按小时 | P1 |
| RC-6 | 同账号多会话、无集中撤销 | `src/server/auth.ts:44-61` | 会话表无管理面，注销只删当前 | P2 |
| RC-7 | 链接检查在本环境全被拒 | `src/server/linkcheck.ts:22-33` | 按解析结果判私网（198.18/15 命中），是**正确**行为；但存在 TOCTOU/端口/体积缺口 | P1 |
| RC-8 | 无 CSP/HSTS；健康接口泄露 schema/uptime | `src/middleware.ts:17-20`、`src/server/http.ts:232-243` | 头部加固与健康接口粒度 | P2 |

## 1. 交叉验证：为什么能确定身份就是"代理 IP"

`rate_limits` 表把 key 存成 `scope:sha256(identity)[:16]`（`security.ts:32`）。直接读运行实例的表：

```
login-ip:baab4746ca334ea17   count=23
login-ip:e9ed54193f535286f   count=30   ← 已打满
reports-ip:…                 count=5    reset 剩余 2682s
event-ip:…                   count=600  ← 已打满
login-user:…                 count=10   ← 被锁账号
```

再算哈希：

```
sha256('172.22.0.3')                 -> baab4746ca334ea1   # 172.22.0.3 = bf-nginx 容器 IP
sha256('untrusted-forwarded-peer')   -> e9ed54193f535286   # 常量兜底
```

也就是说：**"来源"这一个桶的身份就是反向代理容器自己的 IP**；另一只桶是代码里写死的 `'untrusted-forwarded-peer'`。全站只有这两个 key，物理上不存在"每个访客一只桶"的可能。这与前两轮的黑盒观测完全吻合。

## 2. RC-1：`address()` 拿不到客户端地址

```ts
// src/server/http.ts:76-82
function address(context: Context): string {
  // Astro's Node adapter itself trusts XFF when computing clientAddress...
  if (context.request.headers.has('x-forwarded-for')) return 'untrusted-forwarded-peer';
  try { return context.clientAddress || 'unknown-peer'; } catch { return 'unknown-peer'; }
}
```

三处调用：`login`（`http.ts:200`）、`reports`（`http.ts:216`）、`event`（`http.ts:263`）。

补充事实：`context.clientAddress` 由 Astro 的 Node 适配器计算，源码在
`node_modules/astro/dist/core/app/node.js:121-125`：

```js
const forwardedClientIp = getFirstForwardedValue(req.headers["x-forwarded-for"]);
const clientIp = forwardedClientIp || req.socket?.remoteAddress;
if (clientIp) Reflect.set(request, clientAddressSymbol, clientIp);
```

即"**只要有一个 XFF，就取它的第一个值**；否则用 socket 对端地址"。所以：

- 应用永远拿不到"真实的 socket 对端"，除非没有 XFF；
- 一旦有 XFF，值就是客户端可写的第一个值——这正是代码里宁可丢弃它的原因；
- 但丢弃之后没有替代来源，只能退化成常量/代理 IP。

**关键事实**：Nginx 的 `proxy_set_header X-Forwarded-For "";` 并不会发送一个空值头——按照 Nginx 文档，**值为空字符串的头不会被转发**。于是：

| 部署形态 | 应用看到的 XFF | `address()` 返回 | 结果 |
|---|---|---|---|
| README 推荐配置（空值 → 头被丢弃） | 不存在 | `context.clientAddress` = Nginx 容器 IP | 全站一只桶（key `baab…`） |
| 代理透传 XFF | 存在 | 常量 `'untrusted-forwarded-peer'` | 另一只全站桶（key `e9ed…`） |
| 反代完全不设 XFF 头 | 不存在 | Nginx 容器 IP | 同第一行 |
| 直连应用（无反代） | 不存在 | 真实客户端 IP | 按访客分桶（唯一正确形态） |

这解释了前三轮所有"看起来矛盾"的现象：推荐配置与透传配置是**两只互不相通的共享桶**；伪造 XFF 的值不会改变身份（值只被用来判断"头存在与否"），所以轮换伪造值无效；而两只桶各自 30 次/5 次就打满。

代码注释里说"never use an attacker-controlled forwarded address"——这个意图是对的，但实现把"拿不到身份"退化成了"所有人共用一个身份"，于是把限流从"按访客"变成"按站点"。

## 3. RC-2：窗口与 `Retry-After` 不一致

```ts
// http.ts:216
rateLimit('reports-ip', address(context), 5, 60 * 60 * 1000);   // 5 次 / 1 小时
// http.ts:263
rateLimit('event-ip', address(context), 600, 60 * 60 * 1000);   // 600 次 / 1 小时
// auth.ts:38-39
rateLimit('login-ip', address, 30, 15 * 60 * 1000);             // 30 次 / 15 分钟
rateLimit('login-user', name, 10, 15 * 60 * 1000);              // 10 次 / 15 分钟
// http.ts:67
if (status === 429) headers.set('Retry-After', '900');          // 恒为 900 秒
```

`rate_limits` 表实测 `reports-ip` 与 `event-ip` 的 `reset_at` 距今约 2682 秒（窗口 3600 秒），`login-ip` 已到期（窗口 900 秒），与代码一致。因此：

- 反馈被锁**最长 1 小时**，但响应告诉客户端 15 分钟后重试 → 客户端按 900 秒重试会持续失败，体验上像"永久锁死"。
- 指标桶同样 1 小时；前两轮报告里写的"15 分钟"是按 `Retry-After` 推的，**已按源码更正为 1 小时**。

`rateLimit` 的窗口是"首个请求 + windowMs"的固定窗口，`reset_at` 只在插入时写一次，因此 `Retry-After` 完全可以由 `reset_at - now` 精确算出。

## 4. RC-3：限流按"尝试"计数，且在校验口令之前

```ts
// src/server/auth.ts:36-42
export function login(username: string, password: string, address: string): string {
  const name = username.trim().toLowerCase();
  rateLimit('login-ip', address, 30, 15 * 60 * 1000);
  rateLimit('login-user', name, 10, 15 * 60 * 1000);
  const row = database().prepare('SELECT id,password_hash,active FROM users WHERE username=?').get(name);
  const valid = verifyPassword(password, row ? String(row.password_hash) : undefined);
  if (!valid || !row || !row.active) fail(401, ...);
```

后果：

1. **成功登录也扣额度**：合法用户 15 分钟内登录 11 次就会被自己的账号拒绝 15 分钟（前一轮 ATK-03 复现）。
2. **管理员可以被匿名者定向锁号**：不必知道口令，对用户名发 10 次请求即可锁别人 15 分钟；在代理部署下 30 次请求可锁全站。
3. 计数发生在用户查询之前，所以**不存在的用户名也会建桶**（`login-user` 表里 27 个 key 里绝大多数 count=1）。这带来两个效果：
   - 好的一面：429 不再泄露账号是否存在（BF-03 的结论正是由此而来），`verifyPassword` 对缺失用户走 `dummyHash`（`security.ts:19-27`），时间也一致。
   - 坏的一面：任意字符串都能在限流表里占一行，30 次/15 分钟的身份额度可以拿去"预填"任意用户名的桶（写放大，低危）。

## 5. RC-5：匿名指标接口

```ts
// http.ts:244-266（节选）
if (!sameOrigin) fail(403, '请求来源验证失败');
if (typeof target !== 'string' || target.length > 80) fail(400, '事件目标无效');
rateLimit('event-ip', address(context), 600, 60 * 60 * 1000);
recordEvent(name, target);
```

```ts
// store.ts:325-333
const clean = target.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
database().prepare(`INSERT INTO events (day,name,target,count) VALUES (?,?,?,1)
  ON CONFLICT(day,name,target) DO UPDATE SET count=count+1`).run(day, name, clean);
```

根因：

- `target` 只做长度/控制字符清洗，**不校验是不是真实资源/指南 id**（`guide_view`、`resource_view` 可以填任意字符串，前一轮已验证 `guide_view: "../../etc/passwd"` 返回 200）。于是后台 Top 10 可以被 600 个任意字符串占据。
- upsert 按 `(day,name,target)` 去重，所以"写入放大"上限是 600 行/小时/桶，但**桶被打满后整小时的真实统计全部丢弃**（`rateLimit` 直接 429，前端 `sendBeacon` 静默失败）。
- 同一份代码在两种代理形态下产生两只桶，因此最多可打掉 1200 行/小时并让统计停摆。

## 6. RC-6：会话与 CSRF

```ts
// auth.ts:44-53：登录时清理过期会话，并只保留最近 10 个会话
db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 9)')...
// auth.ts:56-59：注销只删当前 token
// auth.ts:16：CSRF = sha256('csrf:' + sessionToken) —— 会话内恒定，无法轮换
```

观测到的"两个会话同时在线"是设计内行为（上限 10 个）。风险在于：没有会话列表、没有"退出所有设备"，令牌泄露后只有改密/停用才能收口；CSRF 由会话令牌派生，没有独立随机值与轮换能力（虽然当前没有可利用点）。

## 7. RC-7：链接检查的 SSRF 防护

```ts
// linkcheck.ts:22-33
if (!host || BLOCKED_HOSTS.has(host) || ...) throw new Error('不允许检查内网或本机地址');
const records = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
if (records.some((record) => isPrivateAddress(record.address))) throw new Error('不允许检查内网或本机地址');
// linkcheck.ts:63-71：每一跳重定向都重新 assertPublicUrl；redirect: 'manual'
// linkcheck.ts:50-56：10 秒超时
```

设计的对：按**解析结果**判断私网（而不是只匹配主机名）、逐跳校验重定向、手动处理 3xx、禁用凭据 URL、`localhost/.internal` 拒绝、超时。

本环境"公网地址也被拒"的原因也在这里：容器 DNS 把 `example.com` 解析成 `198.18.0.21`，命中 `PRIVATE_V4` 的 `/^198\.1[89]\./`（`linkcheck.ts:6`），于是报"不允许检查内网或本机地址"。这不是绕过，而是**防护生效**；前一轮把它标成"未验证"是正确处置。

仍存在的缺口：

1. **TOCTOU / DNS rebinding**：`assertPublicUrl` 解析一次，`fetch` 再解析一次，两次结果可以不同。攻击者控制的域名可以在校验时返回公网、连接时返回内网。
2. **端口未限制**：`https://target:8443/`、`:6379`、`:11211` 都会尝试，扩大了内网探测面（当前被 IP 判定挡住，但配合 1 仍可利用）。
3. **响应体无上限**：HEAD 失败回退 GET 时会读响应，没有大小上限（`request()` 只设置超时）。
4. **没有速率限制**：编辑者可以循环点"检查链接"，每次最长 10 秒，形成出站放大。

## 8. 其余已核对项

- 头部：`middleware.ts:17-20` 只设 `nosniff`/`X-Frame-Options: DENY`/`Referrer-Policy`/`no-store`/`X-Request-Id`；**没有 CSP/HSTS/Permissions-Policy**。CSP 只出现在 `errorResponse`（`http.ts:73`）。
- `/api/health/`（`http.ts:232-243`）公开返回 `status/db/schema/uptime`。
- 日志（`log.ts`）只记 method/path/status/耗时，不记 IP/UA/查询串——与 README 一致，但也意味着**限流事件当前不可观测**。
- 表单上限 96 KiB（`http.ts:41`）与 Nginx 的 1 MiB 不一致；超 96 KiB 由应用返回 413。
- 权限：写操作逐条 `actorUser(actor, true)` 做管理员校验（`store.ts:47-53`），编辑者只在草稿/反馈/复核/检查链接上放行；`updateReport` 会校验修订是否属于该反馈关联的资源（`store.ts:184-188`）——**前一轮我用错 action 名（`resolve-report`）导致"未知操作 400"，此项实际是受保护的，需要更正记录**。
- Markdown：`markdown-it({ html: false })` + 默认协议过滤 + 外链 `rel`（`lib/markdown.ts`），解释了所有 XSS 载荷为何只显示为文本。

## 9. 修复方案

以下为**方案**，未落盘。按优先级排列，每项都给出"改哪里 + 怎么改 + 怎么验收"。

### P0-1 建立可信客户端身份（修 RC-1）

先明确部署契约：`docker-compose.yml` 只把应用绑定在 `127.0.0.1:4321`，Nginx 是唯一入口。因此**应用可以只信任"由本机代理写入的单一 XFF 值"**，不需要处理公网多跳链。

**Nginx 侧（关键：覆盖写入单值，而不是追加）**

```nginx
proxy_set_header X-Forwarded-For $remote_addr;   # 覆盖客户端提交值，保证只有一个 IP
proxy_set_header X-Real-IP       $remote_addr;
proxy_set_header X-Forwarded-Proto https;
```

`$proxy_add_x_forwarded_for` 会保留客户端自己塞的值，正是它让"第一个值"可伪造；换成 `$remote_addr` 后，头里永远只有代理看到的对端地址。

**应用侧（`src/server/http.ts:76-82` 重写）**

```ts
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

function clientIdentity(request: Request): string {
  const raw = request.headers.get('x-forwarded-for') ?? '';
  const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
  // 契约：我们的代理只会写一个值。多于一个 → 说明前面还有未知的转发方，
  // 不能把它当身份，退化为站点级保护（见 P0-1b），绝不取"第一个值"。
  if (values.length !== 1) return 'unverified-peer';
  const candidate = values[0]!;
  if (!(IPV4.test(candidate) || (candidate.includes(':') && IPV6.test(candidate)))) return 'unverified-peer';
  return candidate;
}
```

要点：

1. **不要用 `context.clientAddress` 做安全决策**——它取的是"第一个 XFF"，可被客户端写入（见上文适配器源码）。可以继续用它做日志/调试，限流身份必须走上面的校验函数。
2. `values.length !== 1` 时返回常量 `unverified-peer`，这只会在"前面还有一层未知代理"时出现；此时应走 **P0-1b 的站点级熔断**，而不是把所有人关进 30 次/15 分钟的小桶。
3. 若未来接入 CDN：在 Nginx 用 `set_real_ip_from <CDN 网段>` + `real_ip_header CF-Connecting-IP`，把 `$remote_addr` 变成真实客户端地址，应用侧代码不用改。
4. 若确实需要"多跳链路解析"，再引入 `TRUSTED_PROXIES` CIDR 并从右往左取第一个非可信地址；在单机单代理拓扑里属于过度设计。

**P0-1b 站点级熔断（替代"所有人共用一个 30 次桶"）**

```ts
// 只在身份不可信或需要全站保护时使用，容量必须显著高于正常流量
rateLimit('login-site', 'site', 500, 5 * 60 * 1000);
```

**文档同步（必须一起改，否则下一个部署的人会踩同一个坑）**

- `README.md`「部署要点」现在写的是"反向代理**不要**透传 `X-Forwarded-For`"，对应 Nginx 示例里的 `proxy_set_header X-Forwarded-For "";`。这正是把所有访客压成一只桶的原因。应改为"代理**覆盖**写入单个真实地址"（`X-Forwarded-For $remote_addr`），并说明"应用只接受单值、信任本机代理"。
- `docs/product/FEATURES.md`「安全与隐私」里的限流描述需要补上三个实际数值（登录 10/账号/15 分钟、反馈 5/小时、指标 600/小时）和"窗口与 `Retry-After` 一致"的要求。
- 部署检查项：确认 4321 端口没有对公网暴露（`docker-compose.yml` 已绑定 `127.0.0.1`，保持）。

验收：

- 两个独立来源各 30 次登录尝试，互不消耗；
- 伪造 `X-Forwarded-For`（单值/多值）都不产生新桶，也不会把别人锁死；
- `rate_limits` 里出现的是多个不同的客户端 IP 键，而不是一个代理 IP 键。

### P0-2 限流语义分层（修 RC-3）

把 `security.ts:30-42` 的 `rateLimit` 拆成两件事：

```ts
export interface LimitResult { allowed: boolean; retryAfterMs: number; remaining: number }
export function consume(scope: string, identity: string, max: number, windowMs: number): LimitResult
export function peek(scope: string, identity: string): LimitResult
export function reset(scope: string, identity: string): void
```

登录流程改为"先查不扣、失败才扣、成功清零"：

```ts
const userKey = `login-user:${hashToken(name)}`;
const ipKey = `login-client:${hashToken(identity)}`;
const ipState = peek(ipKey); if (!ipState.allowed) fail(429, ..., ipState.retryAfterMs);
const userState = peek(userKey); if (!userState.allowed) fail(429, ..., userState.retryAfterMs);
// 校验口令
if (!valid) { consume(userKey, 10, 15m); consume(ipKey, 30, 15m); fail(401, ...) }
reset(userKey);   // 成功后清空该账号的失败计数（IP 桶保持较慢衰减）
```

另外建议把"硬窗 + 固定 15 分钟"换成**指数退避**：第 5 次失败 30 秒、第 8 次 5 分钟、第 12 次 1 小时（上限），并在响应里给准确 `Retry-After`。

验收：连续 10 次成功登录不被锁；连续错误口令按退避曲线增长；其他账号不受影响；管理员不会被匿名者定向锁死（或至少退避上限可运维解除）。

### P0-3 `Retry-After` 与窗口对齐（修 RC-2）

- `HttpError` 增加 `retryAfterMs`；`errorResponse`（`http.ts:62-75`）用 `Math.ceil(retryAfterMs/1000)`，删掉 `http.ts:67` 的硬编码。
- 统一并写进文档：登录 15 分钟窗、反馈 10 分钟窗（或明确 1 小时）、指标 1 小时窗。三者的窗口长度应是有意选择，而不是三处魔法数字。
- 429 响应建议返回 `application/json`（`{ error, retryAfter }`）+ 简短 HTML 兜底，便于前端与监控消费。

验收：429 的 `Retry-After` 与 `rate_limits.reset_at` 一致；到期后第一次请求即成功，不需要"试探"。

### P1-4 事件接口加固（修 RC-5）

1. `target` 必须是存在的实体：`resource_view`/`outbound_click` 校验 `resources.id` 且 `published IS NOT NULL`；`guide_view` 校验 `guides.slug` 且已发布；不合法直接 204 丢弃（不要 400，避免成为枚举接口）。
2. 去重与采样：同一 `(day,name,target)` 在窗口内只允许增长到固定次数（例如 50），超过后只累加计数不再创建新行；`events` 表加唯一索引已具备（`migrations.ts:44-48`），可在 upsert 时用 `CASE WHEN count < 50 THEN count+1 ELSE count END`。
3. 站点级总量保护：`event-site` 桶（例如 5000/小时）被打满后，改为**采样写入**（1/100）而不是全部丢弃，保证后台指标仍有趋势。
4. 可观测：把 429 计数写进审计或独立计数表，后台显示"统计已降级"，避免"静默丢数据"。

验收：600 次/小时打满后，真实浏览仍能被采样记录；Top 10 不再出现任意字符串；打满只影响精度不影响可用性。

### P1-5 会话治理（修 RC-6）

- `sessions` 表补 `created_at`（已有）、`last_seen_at`、`ip_hash`、`ua_hash`（隐私：只存哈希）；后台加"登录设备"列表与"退出其他设备/全部设备"。
- `logout` 保持删当前；新增 `POST /api/manage/ action=revoke-sessions`（管理员与本人可用）。
- CSRF 改为每会话独立随机值（`sessions.csrf`），支持轮换；`csrfFor(token)` 的派生方式可保留作兼容，但轮换能力要补上。

### P1-6 链接检查加固（修 RC-7）

1. **DNS pinning**：解析出公网 IP 后，用该 IP 建连（`undici` 自定义 `Agent({ connect: { lookup: (_, __, cb) => cb(null, pinnedIp, family) } })`），并保留原主机名做 `Host`/SNI；或改用 `fetch` + `dispatcher`。这样能同时解决 rebinding 与"校验/连接不一致"。
2. **端口白名单**：只允许 80/443（`url.port === '' || 80 || 443`）。
3. **响应体上限**：GET 回退时用 `response.body` 流式读取并在 32 KiB 处中断。
4. **速率限制**：`check-link` 加 `rateLimit('linkcheck-user', username, 20, 10*60*1000)`，避免编辑者循环触发出站。
5. 保留现有优点（逐跳校验、manual redirect、10 秒超时、拒绝凭据 URL）。

验收：在正常 DNS 环境跑三条用例（公网成功 / 回环拒绝 / 重定向到内网拒绝），再加一条"解析后切换 IP"的 rebinding 用例。

### P2-7 头部与健康接口（修 RC-8）

- `middleware.ts` 增加 `Content-Security-Policy`（先 `Report-Only`，收集报告后再强制）、`Permissions-Policy`、HTTPS 下 `Strict-Transport-Security`。
- `/api/health/` 只返回 `{status, db}`；`schema`/`uptime` 移到需要鉴权的 `/api/health/detail`（或仅内网可访问）。
- Nginx `server_tokens off`；`TRACE` 建议直接 `return 405`。

### P2-8 一致性与可观测性

- 表单上限（96 KiB）与 Nginx（1 MiB）统一为一处配置并在错误信息里说明。
- `rate_limits` 给 `reset_at` 加索引（当前每次请求全表 `DELETE ... WHERE reset_at < ?`，数据量大后是热点）。
- 日志在**不记录 PII** 的前提下增加"限流触发"事件（scope + 结果，不含身份明文），否则运维无法区分"被攻击"和"代码 bug"。

## 10. 兼容性、迁移与风险

- 身份改造会改变所有 `rate_limits` 的 key 语义：建议**上线时清空 `rate_limits`**（纯瞬时数据），无需数据迁移；`scope` 命名建议从 `login-ip` 改为 `login-client`，避免与旧行混淆。
- 若前面还有 CDN（Cloudflare 等），`TRUSTED_PROXIES` 需要包含 CDN 回源段，并且只信 `CF-Connecting-IP`；默认配置应"失败即视为不可信"（宁可退化成站点熔断，也不接受可伪造头）。
- 事件采样会让后台数字出现"约数"，需要在 UI 上标注"已降级/采样"，否则会被误读为数据错误。
- 口令退避会改变运维体验（忘记密码时不能立刻重试），需要同时提供 CLI 解锁手段（`scripts/unlock-login.mjs` 或直接清 `rate_limits` 对应 key）。
- 全部改动都在 `src/server/` 与 Nginx 配置层，不涉及数据库结构破坏性变更（除 `sessions` 加列，走现有 `migrations.ts` 顺序迁移即可）。

## 11. 验收清单（可直接用现有脚本改造）

| 用例 | 期望 | 现有脚本 |
|---|---|---|
| 两个独立来源各 30 次登录 | 互不消耗 | `scripts/09_ratelimit.py` |
| 同一账号连续 10 次成功登录 | 不被锁 | `scripts/18_enum_and_spray.py` |
| 错误口令第 11 次起退避 | `Retry-After` 递增 | 新增 |
| 伪造 `X-Forwarded-For`（单值 / 多值） | 不产生新桶，也不误伤他人 | `scripts/19_keying.py` |
| 代理改为 `X-Forwarded-For $remote_addr` 后 | `rate_limits` 出现多个客户端 IP 键 | `docker exec … node -e` 查表 |
| 40 并发登录/反馈 | 恰好 10/5 通过 | `scripts/20_race.py` |
| 不存在的用户名 11 次 | 与存在账号表现一致（无枚举） | `scripts/24-enum-oracle`（本轮） |
| 600 次事件写入后 | 仍有采样数据、Top10 不含垃圾 | `scripts/21_flood.py` |
| 429 的 `Retry-After` | 等于 `reset_at - now` | 新增 |
| 链接检查三条用例 | 通过/拒绝/重定向拒绝 | `scripts/15_linkcheck.py` |

## 12. 声明与待确认

- 本轮**未修改源码、配置、数据库结构**；未创建 commit；仅新增本报告。
- 未做修改后验证（因为没有改代码）。
- 待维护者确认的设计问题：
  1. 反馈与指标到底应该"按访客"还是"按站点"？若坚持站点级保护，就要接受"一个人能影响所有人"的取舍，并配采样/降级而不是硬 429。
  2. 登录失败是否要按账号硬锁（当前行为）？若要保留，需要给运维留解锁通道，并把成功登录排除在计数外。
  3. 是否允许编辑者触发外站请求（链接检查）？若允许，需要出站速率与域名白名单。
  4. 事件统计是否需要精确值？若只需趋势，采样是更省资源的设计。

---

## 13. 实施记录（2026-10-21 19:40–20:00，已落盘）

本节记录实际改动与验证结果；代码已修改，文章其余部分保留为分析原文（便于对照）。

### 13.1 改动清单

| 文件 | 改动 | 对应根因 |
|---|---|---|
| `src/server/security.ts` | `HttpError` 增加 `retryAfterMs`；拆出 `checkLimit` / `consumeLimit` / `resetLimit` / `enforceLimits`；新增 `clientIdentity()`（`TRUST_PROXY` 契约 + 单值 IP 校验） | RC-1、RC-2、RC-3 |
| `src/server/auth.ts` | 登录改为"先查额度 → 校验口令 → 失败才计数 → 成功清零"；导出 `LOGIN_*` 常量 | RC-3 |
| `src/server/http.ts` | `address()` → `identity()`；`Retry-After` 由剩余窗口计算；反馈/指标改成"客户端层 + 站点层"双层；指标目标校验（未知目标 204 不落库）；链接检查加每操作者限速 | RC-1、RC-2、RC-5、RC-7 |
| `src/server/store.ts` | 新增 `isMetricTargetAllowed()`；`recordEvent()` 改为每事件每日最多 200 个不同目标，返回是否落库 | RC-5 |
| `src/server/linkcheck.ts` | 新增 `resolvePublicTarget()`（端口白名单 80/443 + 解析结果校验）；连接固定到已校验 IP（undici `Agent.connect.lookup`）；GET 回退不下载响应体；逐跳重校验 | RC-7 |
| `src/middleware.ts` | 增加 CSP（Report-Only）、HSTS（HTTPS 时）、Permissions-Policy、COOP、`X-Permitted-Cross-Domain-Policies` | RC-8 |
| `docker-compose.yml` / `.env.example` / `README.md` | 新增 `TRUST_PROXY`；部署示例从"剥离 XFF"改为"覆盖写入单值 XFF + X-Real-IP"；补 `TRUST_PROXY` 配置说明 | RC-1 |
| `docs/security/SECURITY-SPEC.md` | 新增《网站安全设计与实现规范》 | — |
| `tests/server.test.mjs` | 新增 4 组回归用例（身份、登录计数语义、反馈额度与 Retry-After、指标目标校验与容量） | 全部 |
| `package.json` / `package-lock.json` | 显式依赖 `undici`（固定连接用） | RC-7 |

### 13.2 验证结果（最终镜像 `sanjiang-fixed:20261021`，干净库，`TRUST_PROXY=1`，XFF 单值覆盖）

| 用例 | 结果 |
|---|---|
| 连续 20 次成功登录 | 全部 303（不再自我锁定） |
| 同一账号 10 次错误口令 | 10×401，第 11 次 429，`Retry-After: 900` |
| 同一来源、另一账号登录 | 303（账号桶隔离） |
| 打满客户端桶（30 次失败） | 429，`Retry-After: 899` |
| 伪造 `X-Forwarded-For` | 仍 429（代理覆盖为真实来源，不产生新桶） |
| 独立容器来源登录 | 303（按访客分桶生效） |
| 反馈 5 次后第 6 次 | 429，`Retry-After: 3600`（与实际 1 小时窗口一致） |
| 独立来源反馈 | 303（不再全站共享） |
| 指标未知目标 / 路径穿越目标 | 204 且不落库；已发布目标 200 正常计数 |
| 响应头 | CSP-Report-Only、HSTS、Permissions-Policy、COOP、X-Frame-Options 全部出现 |
| 后台冒烟（独立来源） | 登录 303、仪表盘 200、资源页 200、check-link 303、保存设置 303 |
| 单元/集成测试 | `npm run check` 0 error；`npm test` 73/73 通过（新增 4 组用例） |

证据：[evidence-bf/23-fix-verification.json](evidence-bf/23-fix-verification.json)、[evidence-bf/23-fix-verification.meta.json](evidence-bf/23-fix-verification.meta.json)、`scripts/23_verify_fixes.py`、修复版代理配置 [nginx-fixed-deployment.conf](nginx-fixed-deployment.conf)（8803 覆盖写单值 / 8804 追加对照）。

### 13.3 有意保留 / 未实施

1. `/api/health/` 仍返回 `schema` 与 `uptime`（测试契约依赖），已在规范 §9.3 标为待拆分项；拆分需同步改 healthcheck 与测试。
2. 会话列表与"退出全部设备"未实现（P2，需要 `sessions` 加列迁移与后台页面）。
3. CSRF 仍由会话令牌派生，未改为独立随机值（当前无可用攻击面，规范 §4.3 记为"应"）。
4. 指标"打满后采样"未实现，当前策略是"打满后只保留已有目标、丢弃新目标"（更简单，且不影响页面可用）。
5. 多跳代理链解析（`TRUSTED_PROXIES` CIDR）未实现；当前契约是"单代理覆盖写单值"，接入 CDN 时用 Nginx `real_ip` 解决。
