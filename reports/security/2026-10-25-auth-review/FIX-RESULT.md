# 认证审查修复结果（SJ-A-01 … SJ-A-05）

- 仓库：`/media/sunhao/F/Project/sanjiang-resources-site`
- 基线：`master` / `93fc92199775928ad22423c2fd17b9839f8b5a91`（开工复核 HEAD、分支、工作区，与上一轮一致）
- 结束状态：**未提交、未推送、未部署**；`git diff --check` 无输出
- 输入：本目录 `README.md`（原始审查报告）、`FIX-PROMPT.md`（修复提示词）、第三轮复核意见
- 原始材料原样保留：`README.md`、`probe-output.log` 未修改。修复后的观察值另存 `probe-output-after-fix.log`。

> **本轮不构成全面安全认证。** 只处理 `FIX-PROMPT.md` 指定的 SJ-A-01…05 及其复核反馈；SJ-A-06…08、设备列表、"退出其他会话"、死代码清理**未纳入**。

**修订记录**

- **第二轮复核**：1 项实现缺陷（P2，站点熔断被已耗尽的客户端继续推进）、1 组测试缺口（P2，断言测到了别的端点）、1 项规范偏差（P3，错误转换重复实现）——已修并补断言，见 §0b。
- **第三轮复核**：2 项 P3 收尾（畸形证明"先结算后准入"的顺序契约、反向独立性测试只累计 1 次）+ 双方同意的部署文档与 `deploy:check` 提示——见 §0c。
- **第四轮复核**：2 项 P2，都在**新增的部署文档**里（认证专用 location 被 `^~ /api/` 屏蔽、核心验收请求缺 `Origin` 会假通过）——见 §0d。应用层代码本轮无新问题。
- §6 的证据与 §9 的变更清单已按复核后的状态更新。

---

## 0b. 复核反馈处理（第三轮）

### 0b.1 [P2] 已耗尽客户端预算的垃圾请求仍能推进全站熔断 —— 已修

**确认**：复核成立。`verifyLoginChallenge` / `confirmEnrollment` 里 `challengeRow()` 归属判定与 `settleChallengeFailure()` 都排在 `enforceLimits()` **之前**，而 `consumeLimit()` 只累加、不拒绝。于是同一可信来源的前 30 次垃圾 token 把 `totp-client` 与 `login-site` 一起推到 30，**之后每次仍继续结算**，两个桶一路涨到 500，站点熔断被打满。

**修复前实测**（同一可信来源 500 次垃圾 token）：

```
statuses: {"401":30,"429":470}
totp-client(203.0.113.5) = 500
login-site(site)         = 500
另一来源正确口令 = 429  Retry-After= 300
```

**修复**（`src/server/auth.ts`）：两个函数的顺序改为

```
客户端/站点准入(只读) → 归属判定(用途/绑定/状态) → 账号层准入 → 验证 → 失败结算一次
```

即把 `enforceLimits(clientLimitRules(client, TOTP_CLIENT_BUDGET, LOGIN_SITE_BUDGET))` 提到函数入口；账号层仍在验证前单独准入。

**修复后实测**（同样脚本、同样 500 次）：

```
statuses: {"401":30,"429":470}
totp-client(203.0.113.5) = 30
login-site(site)         = 30
另一来源正确口令 = 303
```

**回归**：`SJ-A-04：可信客户端的 30 次上限必须真正保护站点熔断（复核 P2）`（35 次垃圾 token：前 30 次 401、其后 429，两个桶都停在 30，另一来源正确口令 303）。**变异 M6**（删掉入口准入）会让它单独失败。

### 0b.2 [P3] 导入预检仍独立实现错误转换 —— 已修

**修复**：把 `http.ts` 里 `errorResponse()` 的状态转换、`Retry-After` 计算、非 `HttpError` 的固定文案与"只记 `error.name`"抽成唯一实现 **`errorShape(error): { status, message, headers }`**，`errorResponse()` 与 `/api/import/preview/` 都消费它。路由不再有 `instanceof HttpError` 分支、不再自己算 `Retry-After`、不再自己 `console.error`；401/403 也改成 `fail(...)`，与其它错误走同一条路径（顺带得到一个副作用：500 的文案与 `/api/manage/` 完全一致，测试已同步）。

### 0b.3 [P2] 测试断言测到了别的端点 —— 已修

| 原断言 | 问题 | 现在 |
|---|---|---|
| `managePost(save-category, csrf: '')` = 403 | 测的是 `/api/manage/` 的 CSRF，不是预检路由的 | 直接对预检路由发空令牌 / 错令牌 → 403，正确令牌 → 200；**变异 M7**（删掉路由里的 `requireCsrf`）会失败 |
| `managePost(import-apply, 4 MiB)` = 413 | 测的是 `/api/manage/` 的体积上限 | 直接对预检路由发 4 MiB payload（> `IMPORT_MAX_BYTES` 3 MiB、< `MANAGE_MAX_BYTES` ≈5.2 MiB，因此 413 只能来自该路由自己的 payload 检查）；**变异 M8**（删掉该检查）会失败 |

复核点出的三处缺口一并补上：

| 缺口 | 新增用例 | 变异验证 |
|---|---|---|
| `regenerate-recovery` 的失败预算 | `SJ-A-02：regenerate-recovery 的证明失败同样有预算`（5×403 → 429，恢复码数量不变） | M9 |
| 客户端第 31 次边界 | `SJ-A-02：客户端证明预算到 30 后，后续请求不再推进账号桶（第 31 次边界）` | M10 |
| 审计失败后**因子消费**回滚 | 既有用例补直接断言：审计失败后 `totp_last_step` 必须与调用前相同（不只看 `authState`） | M2 覆盖同族 |

### 0b.4 规范补充

- §4.2 新增 **「准入先于结算」**：任何失败结算之前必须先检查该请求本来是否被允许；已耗尽客户端预算的来源禁止继续推进站点桶。并写明挑战验证的固定顺序。
- §11.1 增补 3 类必测用例（认证失败准入顺序 / 证明预算边界 / 预检路由自身的 CSRF 与 payload 上限）。
- §15 新增 1.10 变更记录。

### 0c.1 [P3] 畸形验证码先结算、后准入账号预算 —— 已修

**确认**：`verifyLoginChallenge` 里 `if (!input) settleChallengeFailure(...)` 排在 `enforceLimits([accountRule])` 之前。账号桶已经打满（10）时，一次畸形提交仍会把计数推到 **11**、并额外烧掉一次挑战尝试。`confirmEnrollment` 的同类分支也一样。

**修复**（`src/server/auth.ts`，两处）：先选定账号规则（畸形输入无法判形状，按 `totp-user` 计）并 `enforceLimits` 准入，**再**结算。

```ts
const accountRule = input?.kind === 'recovery' ? recoveryAccountRule : totpAccountRule;
enforceLimits([accountRule]);          // 准入在前
if (!input) settleChallengeFailure(...); // 结算在后
```

**注意**：修复前后**响应码都是 429**（结算自己也会报超限），所以这不是可利用的 oracle，而是状态契约偏差——断言必须盯 **桶计数** 与 **挑战 attempts**，不能只看状态码。回归 `SJ-A-04：畸形证明也必须先准入账号预算，再结算`，变异 **M12** 会让它单独失败（`totp-user` 变 11、attempts +1）。

### 0c.2 [P3] 反向因子独立性测试只累计 1 次 TOTP 失败 —— 已改

原来只失败 1 次就断言恢复码可登录，测不出"**打满**后还能不能登录"。现在用 2 个挑战 × 5 次失败把 `totp-user` 打到 10，再断言：

- 正确的恢复码仍然登录成功（`usedRecovery === true`）；
- `totp-user` 保持 **10**（恢复码成功不清另一因子的桶）；
- `totp-recovery-user` 归 0（清自己的桶）。

### 0c.3 部署文档与 `deploy:check` 提示（本轮新增）

**`docs/edge-cdn-hardening.md` 新增 §3b「认证端点的专用边缘限速」**：

- 为什么必须补：给出本轮实测对照——**可信**来源被客户端层挡在 30；**不可信**来源（无共享凭据）500 次全部 401、`login-site = 500`，随后另一来源正确口令 `429 / Retry-After: 300`。应用层按设计不给不可信身份建共享小桶，所以"单来源速率"只能由边缘补。
- 配置：`/api/login/`、`/api/login/totp/`、`/api/login/enroll/` **共用同一条 `auth` zone**（不共用就能靠轮换端点绕开）；`$binary_remote_addr` 取已还原地址；`X-Forwarded-For` 用 `$remote_addr` **覆盖**而不是 `$proxy_add_x_forwarded_for`；共享凭据头 `X-Sanjiang-Proxy-Secret`。
- 实测验收四条（复制即用）：三端点各 40 次都出现 429、`login-client:` 出现多个键、不带凭据的直连不产生客户端桶、**600 次垃圾 token 后 `login-site` 必须远小于 500**（核心判据）。

**`scripts/check-deployment.mjs` 新增 `edge-rate-limit`，等级 `info`**：明确写"本脚本不检测 Nginx/CDN 的 `limit_req`/`limit_conn`，也不代表它们已经配置，请人工确认并按 §3b 实测验收"。

- 用 `info` 而不是 `warn`：`--strict` 会把 `warn` 升级为 `error`，一条**不可自动判定**的项会让严格模式永远失败，把真正的降级信号淹掉。
- 配套用例（`tests/deployment.test.mjs`）：`level` 必须是 `info`、文案不得出现"已检测/已生效/检测到 Nginx"、`--strict` 下 `status` 仍为 `ok`。

### 0d.1 [P2] 认证专用 location 被 `^~ /api/` 屏蔽 —— 已修

**确认**：第一版 §3b.2 写的是

```nginx
location ~ ^/api/login/(totp|enroll)?/?$ { ... }     # 错
```

而 §3 里已经有 `location ^~ /api/`。Nginx 的匹配顺序是"先取最长前缀；**该前缀带 `^~` 就跳过全部正则 location**"。`/api/login/totp/` 同时匹配两者，但 `^~ /api/` 命中后正则**根本不会被求值**——于是认证 zone、专用日志、共享凭据头一个都不生效，请求落到 §3 的通用 `api` zone，且**不带** `X-Sanjiang-Proxy-Secret`（应用把所有请求当 `unverified`，访客额度整体失效）。

调换书写顺序也没用：`^~` 的优先级来自匹配规则，不来自配置文件里的位置。

**修复**（`docs/edge-cdn-hardening.md §3b.2`）：

```nginx
location ^~ /api/login/ { ... }                       # 前缀比 /api/ 更长，且保留 ^~
```

并补了：三个端点的命中表、为什么不用 `location ~`（被 `^~` 屏蔽）、为什么不用裸前缀（以后新增正则可能被抢走）。

**未实测**：本机没有 nginx（`which nginx` → 未找到），结论依据 nginx 官方 location 匹配规则，**不是**在真实 nginx 上验证的。已记入 §8 未执行项。

### 0d.2 [P2] 核心验收请求缺 `Origin`，会假通过 —— 已修

**确认**：`/api/login/*` 的第一道守卫是 `requireOrigin()`，它在任何限流结算之前。缺 `Origin` 或 `Origin` 与 `SITE_URL` 不一致 → **403 且 `rate_limits` 一条不写**，于是"600 次之后 `login-site` 远小于 500"在边缘规则完全没生效时也成立——这条检查测的是"请求根本没到"。

**独立复现**（`scripts/verify-origin-gate.mjs`，真实 HTTP 处理函数）：

| 请求的 Origin | 状态码 | `login-site` 增量 | `rate_limits` 行增量 |
|---|---|---|---|
| 不带 | 403 | 0 | 0 |
| `https://evil.invalid` | 403 | 0 | 0 |
| `http://localhost:9999` | 403 | 0 | 0 |
| 与 SITE_URL 一致 | 401 | +1 | +2（`login-site` 与 `totp-client`） |

```sh
$ node reports/security/2026-10-25-auth-review/scripts/verify-origin-gate.mjs
OK：无/错 Origin 在限流前就 403 且不写任何计数；正确 Origin 才计数   # exit 0
```

**修复**（`docs/edge-cdn-hardening.md §3b.3` 整体重写）：

- 每条 curl 都带 `Origin: $ORIGIN`（并说明必须与 `SITE_URL` 的 origin 完全一致）；
- 新增**第 0 条**先决检查：`nginx -T | grep -nE 'location (\^~ )?/api/'`，确认认证规则挂在更长前缀上，否则后面全部无意义；
- 新增**第 2 条核心判据**：`grep -c 'limit_req=REJECTED' auth_edge.log` 必须增长——这是唯一能区分"边缘真的拦了"与"应用层顺手挡住了"的证据；
- 原第 4 条降级为**辅助判据**，并给出三种取值的读法：`0` = 请求没到处理器（假通过）、`500` = 边缘缺失、`0 < n < 500` = 正常但仍需第 2 条；
- 明确写出反直觉的一点：**身份可信时应用层本来就把单来源挡在 30**（`totp-client` 上限），所以数据库计数偏低不能证明边缘生效；
- 共享凭据那一条也补了正向对照（带凭据才建客户端桶），避免"两边都是 0"的假通过；
- 顶部加了一个"两个已知假通过陷阱"的提示框。

---

## 0. 对原始审查报告的纠错（单列）

原报告的四处判断不成立或需要降级，`README.md` 保持原样，纠错以此处为准。

| # | 原文表述 | 结论 |
|---|---|---|
| 1 | SJ-A-01「每 14 分钟 10 个请求即可**无限维持**锁定」 | **不成立**。`enforceLimits()` 只做 `checkLimit()` 只读探测：被 429 拦下的请求**既不增加计数也不续期**。窗口从第一次失败起算 15 分钟，到期后必须重新打满 10 次失败才能再次锁定。可确认的仍只是"每个 15 分钟窗口用 10 个请求就能低成本再次锁定"，不是"无缝永久锁死"。 |
| 2 | SJ-A-02「按 15 次/秒估，1 小时累计命中率约 15%」 | **降级为假设性估算**，不是吞吐压测、也不是接管证据。它依赖"每步 3/10⁶ 命中率 + 无限次尝试 + 单一部署吞吐"三个假设。另外**策略要求该角色启用双因素时，`disableTotp()` 会先被策略拒绝（403）**，攻击者走不到验证码猜测。 |
| 3 | 以 `scripts/security-audit.mjs` 的 `targeted-account-lockout` 作为"账号锁定的 HTTP 证据" | **不成立**。该脚本发 **9** 次错误口令，注释错误假定先前的成功登录占了 1 个额度；成功登录从不消耗额度，所以 9 次之后账号桶只有 9，原断言（正确口令 → 429）在当前实现上并不成立。已改为发满 10 次，并按新契约断言"失败仍 429、正确口令 303"。 |
| 4 | SJ-A-05「键固定为 `unknown`，**不牵连任何真实账号**」 | **错**。`unknown` 是合法用户名（`^[a-z0-9_.-]{3,64}$`），`limitKey('totp-user','unknown')` 与真实账号 `unknown` 的桶**完全相同**。已复现：建 `unknown`、发行 enroll 挑战、提交 10 次不存在的 login 挑战 token，随后该账号的**正确**注册验证码得到 429。变异 M3 同样复现。 |

---

## 1. SJ-A-02：新鲜证明失败预算（优先项）

**实现**（`src/server/account.ts`、`src/server/http.ts`）：

| 项 | 实现 |
|---|---|
| 具名预算 | `PROOF_WINDOW_MS = 15min`、`PROOF_USER_MAX_FAILURES = 5`、`PROOF_CLIENT_MAX_FAILURES = 30`；scope 为 `proof-user` / `proof-client` |
| 聚合键 | `proof-user` 按**操作者用户名**（不同动作、会话、目标共用）；`reset-totp` 记操作者，不记目标 |
| 客户端身份 | 走既有可信解析链 `clientIdentity()`；`unverified` 不建 `proof-client` 桶 |
| 检查时机 | `withProofBudget()` 先用 `enforceLimits(rules)` 在 scrypt **之前**只读准入（第 6 次在这里 429，带真实 `Retry-After`）；客户端累计到 30 后第 31 次同样在这里被拒，不再推进账号桶 |
| 事务顺序 | 业务在自己的 `transaction()` 里跑；证明失败以 `ProofFailure` 抛出 → 业务整体回滚；**回到事务外**再由 `settleProofFailure()` 用 `consumeLimit()` 逐规则独立结算。**没有**在业务事务内调用 `consumeLimits()`，不存在嵌套 `BEGIN IMMEDIATE`，也不会让计数随业务回滚消失 |
| 计什么 | `ProofFailure`：错误口令、错误/重放验证码、错误/已用恢复码、畸形证明 —— 每次失败**最多结算一次** |
| 不计什么 | 策略拒绝（403）、越权、密钥缺失/无法解密（503）、目标版本冲突（409）、数据库/审计异常（500） |
| 成功清理 | 成功只 `resetLimit('proof-user')`；`begin-totp-enroll`（只校验口令）**不清**账号桶；`proof-client` 永不清零 |
| 覆盖 | `begin-totp-enroll` / `disable-totp` / `regenerate-recovery` / `reset-totp` 四个动作 |

---

## 2. SJ-A-01：正确口令不被账号桶封锁

**实现**（`src/server/auth.ts#login`）：

```
enforceLimits(clientRules)                 // 客户端层 + 站点层，仍在 KDF 之前
verifyPassword(...)                        // 账号桶不参与准入
失败 → consumeLimits([...clientRules, userRule])
      → consumeLimit(userRule).allowed ? 401 : 429(Retry-After)
```

- 账号桶只拒绝该账号的**失败尝试**（第 11 次起 429），正确口令继续进入下一阶段
- 正确口令**不直接签发会话**：TOTP 账户进挑战、强制注册账户进注册
- 口令正确但未完成 MFA 时**不清**账号失败历史；完整登录成功后按原契约清理
- 错口令 / 未知用户 / 停用账户仍走同一段逻辑、同一响应
- `consumeLimit()` 的返回值用于判断"这一次是否超限"，而非 `checkLimit()`：后者是准入语义（`count == maximum` 即视为耗尽），刚记下第 10 次失败后会误判为超限——`tests/server.test.mjs` 的两条既有用例先暴露了这个边界

**规范**：§4.2、§6.1 写明取舍——账号桶不再限制 KDF 次数，资源保护由客户端层与站点层承担。

---

## 3. SJ-A-03：导入预检先授权、统一错误、设限

**实现**（`src/pages/api/import/preview.ts`）：

```
getSession → fail(401)
role !== admin → fail(403)        ← 两者都不碰 request.body、不调 previewImport
requireOrigin                     → 403/503
rateLimit('import-user', 操作者, 10/h)   ← 读大体积体之前消费
readForm(MANAGE_MAX_BYTES) → requireCsrf → payload 体积(3 MiB) → JSON
catch → errorShape(error)         ← 与 /api/manage/ 共用同一实现
```

- 既有守卫一个不少：Origin、CSRF、流式体积上限、payload 大小、JSON 校验
- 所有响应统一 JSON + `Cache-Control: no-store`；429 带按窗口计算的 `Retry-After`
- 畸形请求同样计数（`import-user` 在授权后、读体前消费）
- 错误转换共用 `http.ts#errorShape()`（见 §0b.2）
- 为了让该路由**能被真实路由级测试装载**，import 说明符补成显式 `.ts`（与既有 API 存根一致）。这是"旧路由实际上无法被路由级测试覆盖"的直接原因

---

## 4. SJ-A-04 / SJ-A-05：统一挑战失败结算、消除占位键

**实现**（`src/server/auth.ts`）：

| 分支 | 结算 |
|---|---|
| 任意请求（含垃圾 token） | **先**做 `totp-client` + `login-site` 只读准入；已耗尽者直接 429，不结算 |
| 垃圾/未知 token | 结算 `totp-client`（仅可信身份）+ `login-site`；**不写任何账号桶**，**不推进**任何挑战的 `attempts` |
| 已知 token 但消费/过期/尝试耗尽/用途不符/客户端绑定不符 | 同上（不可归属） |
| token 可用但账号状态已变（停用/改密/因子被重置） | 同上（与"猜错"无关） |
| 可用 token + 畸形证明 | `totp-user` + 客户端 + 站点，推进 `attempts` |
| 可用 token + 错误因子 | 按输入形状选 `totp-user` 或 `totp-recovery-user` + 客户端 + 站点，推进 `attempts` |

- 删除 `identity: 'unknown'` 占位键：`unknown` 是合法用户名，拿它当键等于直接扣同名真实账号的额度
- **成功路径纠错**：恢复码登录成功原本会 `resetLimit('totp-user')`，即用 A 因子的成功抹掉 B 因子的累计——已删除，只清 `totp-recovery-user`（和登录契约里的 `login-user`）
- 两因子分桶仍按输入形状选择具名常量，不按下标取

---

## 5. 规范变化（`docs/SECURITY-SPEC.md`，v1.8 → v1.10）

| 位置 | 变化 |
|---|---|
| §4.2 预算表 | `login-user` 语义改为"打满只拒绝失败尝试"；`login-site` 明确含 TOTP/恢复码/注册确认失败；新增 `proof-user` 5/15min、`proof-client` 30/15min、`import-user` 10/h |
| §4.2 新增 | 账号桶不拦截正确口令 + **取舍如实说明**；新鲜证明预算规则（计什么/不计什么/检查时机/事务顺序/清理规则）；**准入先于结算**（复核 P2） |
| §4.5 | 敏感操作必须受 `proof-user`/`proof-client` 约束，成功只清账号桶 |
| §5 | 授权必须早于读取请求体（导入预检专项） |
| §6.1 | 账号层/客户端层/站点层耗尽行为的差异写清（账号层放行正确口令） |
| §6.2.7 | 未知 token 只计可信客户端 + 站点；禁止 `unknown` 占位身份；不可归属的请求不推进别人的 `attempts` |
| §9.3 | API 错误体统一（公共 `errorShape()`） |
| §11.1 | 增补 7 类必测用例 |
| §14 | 落地映射补 3 行 |
| §15 | 新增 1.9、1.10 变更记录 |

`scripts/security-audit.mjs`：修正 9→10 的计数假设与锁定预期（改名为 `account-failure-budget`，断言"失败仍 429、正确口令 303"）；`unbounded-editor-import-body-before-csrf` 改为 `editor-import-preview-denied`（编辑者现在在读体之前就 403）。

---

## 6. 测试证据（真实退出码与摘要）

### 6.1 新增回归：`tests/auth-hardening.test.mjs`（27 例）

全部经真实入口驱动（`http.managePost` / `http.loginPost` / `http.totpPost` / `http.enrollPost` / **导入预检路由自身的 `POST`**），不复制路由实现。

```sh
$ node --test tests/auth-hardening.test.mjs
ℹ tests 27 | ℹ pass 27 | ℹ fail 0        # exit 0
```

### 6.2 既有鉴权套件 + 新增

```sh
$ node --test tests/server.test.mjs tests/totp.test.mjs tests/totp-server.test.mjs tests/deployment.test.mjs tests/auth-hardening.test.mjs
ℹ tests 165 | ℹ pass 165 | ℹ fail 0      # exit 0
```

（既有 137 + 新增 27 + 部署自检新增 1 条。既有用例除部署自检外全部未修改。）

### 6.3 类型检查 / 构建 / 产物 / 实例 / 浏览器

```sh
$ npm run check
Result (171 files): - 0 errors - 0 warnings - 0 hints          # exit 0

$ npm run build
[build] Complete!                                              # exit 0

$ node scripts/check-dist-freshness.mjs
{"event":"dist-freshness","status":"ok","distAt":"2026-10-25T15:41:33.802Z"}   # exit 0

$ node --test tests/instances.mjs
ℹ tests 4 | ℹ pass 4 | ℹ fail 0            # exit 0

$ node --test tests/admin-e2e.mjs
ℹ tests 36 | ℹ pass 36 | ℹ fail 0          # exit 0

$ git diff --check
（无输出）                                  # exit 0
```

构建先于 `instances` / `admin-e2e`，且 `dist:check` 在构建后为 `ok`——两者跑的是本轮源码的产物。

### 6.4 断言敏感度：12 个定点变异

整文件回退到旧实现会在**模块加载阶段**就失败（旧路由用无扩展名 import，`importPreviewPost` 无法装载），因此不能用来证明单条断言的敏感度。改用 12 个定点变异，每个只把一处修复改回旧行为（或删掉一处守卫）。矩阵已做成可复跑脚本：

```sh
$ node reports/security/2026-10-25-auth-review/scripts/mutation-check.mjs
M1   CAUGHT ... M12  CAUGHT
ALL MUTATIONS CAUGHT                     # exit 0
```

脚本在每个变异结束后立即从内存中的原文恢复文件，不提交、不构建、不联网；`--only=M6,M7` 可只跑指定项。

| 变异 | 撤销的修复 | 结果 |
|---|---|---|
| M1 | `login()` 把账号桶重新放进 `enforceLimits` | SJ-A-01 2 例失败（pass 1 / fail 2） |
| M2 | `disable-totp` 去掉 `withProofBudget` | SJ-A-02 5 例失败（pass 6 / fail 5） |
| M3 | 垃圾 token 恢复 `identity: 'unknown'` 账号桶 | SJ-A-05 1 例失败（含"真实名为 `unknown` 的账号被 429"） |
| M4 | 结算去掉 `LOGIN_SITE_BUDGET` | SJ-A-04 4 例失败（pass 1 / fail 4） |
| M5 | 导入预检授权退回读体之后 | SJ-A-03 3 例失败（pass 3 / fail 3） |
| **M6** | 挑战验证**去掉入口准入**（本次复核 P2） | SJ-A-04 1 例失败（pass 4 / fail 1） |
| **M7** | 预检路由**删掉 CSRF 校验**（复核点名的测试缺口） | SJ-A-03 1 例失败（pass 5 / fail 1） |
| **M8** | 预检路由**删掉 payload 上限**（复核点名的测试缺口） | SJ-A-03 1 例失败（pass 5 / fail 1） |
| **M9** | `regenerate-recovery` 去掉证明预算 | SJ-A-02 1 例失败（pass 10 / fail 1） |
| **M10** | `withProofBudget` 去掉入口预检 | SJ-A-02 5 例失败（pass 6 / fail 5，含第 31 次边界） |
| **M11** | `errorShape` 回显非 `HttpError` 的 message | SJ-A-03 1 例失败（pass 5 / fail 1） |
| **M12** | 畸形证明退回"先结算后准入"（第三轮 P3） | SJ-A-04 1 例失败（pass 5 / fail 1） |

每次变异后立即恢复原文；`git diff --stat` 与 §9 一致。

### 6.5 原始探针的修复后观察值（**不是验收依据**）

`probe-output-after-fix.log`。脚本里 `NOT-REPRODUCED` / `UNEXPECTED` 是我上一轮写的观察分类，**不代表修复后失败或通过**：

| 用例 | 修复后观察 | 读法 |
|---|---|---|
| P-A | 双方带正确口令均 `ok`；`login-user` 计数 0、`login-client(attacker)` 10 | 正确口令不再被账号桶封锁；成功登录按契约清零账号桶 |
| P-B | `login-site` 桶 = 有 | TOTP 失败已进入站点熔断 |
| P-C1 | 状态集合 `[403, 429]` | 前 5 次 403、第 6 次起 429：预算生效 |
| P-C2 | 第一段 `[403, 429]`，第二段 `[429]` | 第二段仍 429 是因为第一段已打满账号桶（跨动作累计生效） |

验收依据是 §6.1–6.4 的断言，不是这些观察值。

---

## 7. 剩余风险

1. **账号桶不再限制 KDF 次数**（SJ-A-01 的直接代价，已写入 §4.2/§6.1）。资源保护只剩客户端层与站点层；需要靠 `limit_req` / `limit_conn` 在边缘兜量（§9.1b 已有要求）。
2. **垃圾挑战 token 会吃 `login-site`，且不可信来源没有客户端上限**（SJ-A-05 的要求：不再有全站共享的小额桶）。实测两条：
   - **可信来源**：被 30 次客户端上限挡住，最多贡献 30 次站点计数（M6 的修复）。
   - **不可信来源**（`TRUST_PROXY=1` 但凭据缺失/不匹配 → `unverified`）：`clientLimitRules` 只返回站点规则，**每次请求都记 1 次站点计数，没有单来源上限**。实测 500 次垃圾 token → 500 次 401、`login-site = 500`，随后另一来源的正确口令得到 **429 / Retry-After: 300**。
   - 这与"匿名者用 500 次错误口令（用户名轮换）打满同一熔断"是同一类既有取舍，但垃圾 token 更便宜（不触发 scrypt）。**建议**：边缘按 IP `limit_req`，或给 `/api/login/totp/` 单独一条廉价请求熔断；二者属部署层，本轮未做。**不得**把它描述成"站点熔断仍能挡住分布式垃圾流量"——它挡的是总量，不是单来源速率。
3. **`proof-user` 跨动作共用一个 5 次预算**：连打 5 次错口令会让该账号 15 分钟内不能做任何敏感操作。这是"不同动作不能拆散操作者预算"的直接后果，已写入规范；没有做"成功即提前解锁"的旁路。
4. **`begin-totp-enroll` 成功后不清 `proof-user`**：若在别处累计过因子失败，成功开始绑定后仍可能在第 6 次被拦。预期行为（该流程没验证因子）。
5. **多进程 peek/consume 窗口**（原报告 SJ-A-07）未变：单进程内同步执行、无竞态；多写者共享 SQLite 时理论上可多放行 ≈写者数 次。
6. **SJ-A-06…08、设备列表、"退出其他会话"、`deleteUser()` 死代码**：按要求未处理。
7. **`scripts/security-audit.mjs` 已修改但未执行**：需要固定端口 4321 的运行实例，并会写 `data/security-audit/`。其断言的语义与 §6.1 的 SJ-A-01 用例等价（已跑过），但脚本**自身接线**未验证。

---

## 8. 未执行项（不得记作通过）

| 项 | 原因 |
|---|---|
| `npm test`（全量） | 会执行 `tests/linkcheck.test.mjs` 的真实 DNS / `93.184.216.34` 出站请求；`FIX-PROMPT.md` 明确不要跑 |
| `bash scripts/container-smoke.sh` | 需要 `docker build`，会访问镜像仓库 |
| `scripts/security-audit.mjs` | 需要运行实例 + 写 `data/security-audit/`；已改未跑（见 §7.7） |
| `npm run test:browser` | 需要外部已启动实例（`tests/browser.mjs` 指向固定 BASE） |
| `npm run acceptance:proxy` | 需要运行中的反向代理与 `TRUST_PROXY_SECRET` 部署 |
| 真实反向代理联调 | 需要容器/代理环境；`TRUST_PROXY=1` + 正确凭据 + 单值 XFF 的端到端行为仍未在 HTTP 层复测 |
| `docs/edge-cdn-hardening.md §3b.3` 的实测 | 需要一台真实 Nginx + `SITE_URL` 的部署；本轮只写了步骤与判据，**没有执行**，因此不能声称边缘限速已验证 |
| §3b.2 的 location 匹配顺序 | 本机没有 `nginx`，无法实测 `^~ /api/` 是否真的屏蔽了正则块；结论依据官方匹配规则。**部署时必须先跑 §3b.3 第 0 条**（`nginx -T` 看实际加载的 location）再跑第 1–5 条 |

---

## 9. 变更文件

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/server/account.ts` | 修改 | `ProofFailure`、`withProofBudget`、`proofRules`、`settleProofFailure`、`requireFreshPassword`；`consumeFreshProof` 的失败改为 `ProofFailure` |
| `src/server/auth.ts` | 修改 | `login()` 账号桶只结算失败；挑战验证**准入先于归属与结算**；`settleChallengeFailure` 支持不可归属失败并纳入 `login-site`；新增 `challengeUsable`；恢复码成功不再清 `totp-user` |
| `src/server/http.ts` | 修改 | 四个敏感动作套 `withProofBudget`；新增 `IMPORT_PREVIEW_USER_MAX` / `IMPORT_PREVIEW_WINDOW_MS`；抽出公共 `errorShape()` 供 HTML 与 JSON 两条路径共用 |
| `src/pages/api/import/preview.ts` | 修改 | 先授权再读体、`import-user` 预算、错误走 `errorShape()`、显式 `.ts` 导入 |
| `docs/SECURITY-SPEC.md` | 修改 | v1.10：§4.2（含"准入先于结算"）/§4.5/§5/§6.1/§6.2.7/§9.3/§11.1/§14/§15 |
| `docs/edge-cdn-hardening.md` | 修改 | 新增 §3b 认证端点专用边缘限速：共用一条 zone、覆盖写转发头、共享凭据、四条实测验收 |
| `scripts/check-deployment.mjs` | 修改 | 新增 `edge-rate-limit`（`info`）：明确不检测边缘限速、需人工确认 |
| `scripts/security-audit.mjs` | 修改 | 修正计数假设与锁定预期；导入预检探测改为编辑者 403（未执行） |
| `tests/auth-hardening.test.mjs` | **新增** | 27 例定向回归 |
| `tests/deployment.test.mjs` | 修改 | 新增 1 条：`edge-rate-limit` 必须是 `info`、文案不得声称已检测、strict 下仍 `ok` |
| `reports/security/2026-10-25-auth-review/FIX-RESULT.md` | **新增** | 本文件 |
| `reports/security/2026-10-25-auth-review/probe-output-after-fix.log` | **新增** | 修复后观察值 |
| `reports/security/2026-10-25-auth-review/scripts/mutation-check.mjs` | **新增** | 12 个定点变异矩阵（可复跑，含 P2/P3 复核项） |
| `reports/security/2026-10-25-auth-review/scripts/verify-origin-gate.mjs` | **新增** | 复现"缺 Origin → 403 且不计数"的假通过条件（第四轮 P2） |

原始 `README.md` 与 `probe-output.log` 未改动。`scripts/probe-auth.mjs` 只做了一处**无行为变化**的清理（删掉三个未使用的绑定/参数），因为 `npm run check` 会把本目录脚本一并纳入诊断。

```text
 git status --short
 M docs/SECURITY-SPEC.md
 M docs/edge-cdn-hardening.md
 M scripts/check-deployment.mjs
 M scripts/security-audit.mjs
 M src/pages/api/import/preview.ts
 M src/server/account.ts
 M src/server/auth.ts
 M src/server/http.ts
 M tests/deployment.test.mjs
?? reports/security/2026-10-25-auth-review/
?? tests/auth-hardening.test.mjs

 git diff --stat
 9 files changed, 474 insertions(+), 77 deletions(-)
```

---

## 10. 一句话交付摘要

SJ-A-01…05 及其四轮复核反馈全部落地：账号桶不再封锁正确口令（改为只拒绝失败尝试）、四条新鲜证明路径有 5/15min 账号预算与 30/15min 可信客户端预算且失败在业务事务外结算、挑战验证**准入先于归属与结算**（含畸形输入；已耗尽的客户端不能再推进站点熔断）、导入预检先授权再读体并加 10/h 预算、认证失败统一计入 `login-site`、垃圾 token 不再占用 `unknown` 占位身份、错误转换收敛到 `http.ts#errorShape()`；另补 `docs/edge-cdn-hardening.md §3b`（认证端点专用边缘限速 + 实测验收）与 `deploy:check` 的 `info` 提示；第四轮复核后把 §3b.2 的 location 改成 `^~ /api/login/`（正则块会被 §3 的 `^~ /api/` 屏蔽），§3b.3 全部请求补 `Origin` 并把核心判据换成边缘日志的 `limit_req=REJECTED`。**165/165** 通过（既有 137 + 新增 27 + 部署自检 1），`npm run check` 0/0/0（171 文件），`npm run build` 后 `dist:check` ok，实例 4/4、浏览器 36/36，**12 个定点变异全部命中**；未提交、未推送、未部署，未做全面安全认证。
