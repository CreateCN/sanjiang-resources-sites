# 2026-10-25 本地安全审查问题修复记录

对象：`37ed44c74a723290f03b53bb2025617a9d00042c`（`master`）+ 本轮未提交的修复改动。
输入：[/tmp/sanjiang-local-security-report.md](/tmp/sanjiang-local-security-report.md)（本地审查报告，未入库；本文只记录修复，不改写原文）。

结论先行：

- **已修复并复测**：SJ-01、SJ-02、SJ-03、SJ-04、SJ-05、SJ-06、SJ-07、SJ-12。
- **按设计保留（附分析）**：SJ-08、SJ-09、SJ-10、SJ-11。
- 每项都有"修复前 / 修复后"的对照证据，见 §3；`dist` 产物与脚本两侧都实测过，不只是改代码。

---

## 1. 逐项状态

| 编号 | 级别 | 状态 | 一句话根因 | 关键改动 |
|---|---|---|---|---|
| SJ-02 | High | 已修复 | `unverified` 被当成普通字符串身份，共享一个客户端小额度；`login-site` 只写在文档里 | 身份改为 `ClientIdentity` 两型；`clientLimitRules()` 只给可信身份建访客桶；新增 `login-site` 500/5min |
| SJ-01 | High | 已修复（复核后改方案） | 只要头是"单个合法 IP"就采信 | 用**代理共享凭据**（`TRUST_PROXY_SECRET` / `X-Sanjiang-Proxy-Secret`）判定；未配置即 fail closed。原"按对端网段信任"方案在复核中被证伪并删除，见 §2.2 |
| SJ-03 | Medium | 已修复 | `restore-site` 没有离线检测，`restore-db` 有，两条命令结论不一致 | 抽出 `scripts/lib/offline-guard.mjs`，两个脚本共用；破坏性操作前拒绝并零修改 |
| SJ-04 | Low | 已修复 | 备份对 `media/objects` 的存在性做了硬假设，失败还留下半成品批次 | 备份前创建 objects 目录；失败清理本次批次；批次目录改为非递归创建 |
| SJ-05 | Low | 已修复 | 日志/staging 写在目标旁目录，但目录从未创建，首个 `fail()` 就 ENOENT | 参数校验后立即 `mkdir -p`，失败给出明确错误 |
| SJ-06 | Low | 已修复 | 公共健康接口返回 `schema`/`uptime` | 公共接口只留 `status`/`db`；新增管理员专用 `/api/health/detail/` |
| SJ-07 | Low | 已修复 | 动作分派后再做参数校验，越权请求拿到 400/409 | `MANAGE_ACTION_ROLES` + `requireManagePermission()`，授权先于动作级校验 |
| SJ-12 | Info | 已修复 | 每次限流消费都全表 DELETE 过期行 | 迁移 `013-rate-limits-reset-at` 加 `reset_at` 索引（不改语义） |

---

## 2. 关键实现说明

### 2.1 身份分层（SJ-01 / SJ-02）

```ts
// src/server/security.ts
export type ClientIdentity =
  | { kind: 'client'; address: string }          // 可信来源
  | { kind: 'unverified'; reason: UnverifiedReason };  // 无法归属
```

判定依据是**代理共享凭据**（不是连接对端 IP，原因见 §2.2）：

| `TRUST_PROXY` | 代理凭据头 | 转发头 | 结果 |
|---|---|---|---|
| `0` | 不参与判断 | 不存在 | `client` = 连接对端（直连部署）|
| `0` | 不参与判断 | 存在 | `unverified/forwarded-header-ignored` |
| `1` | 未配置 `TRUST_PROXY_SECRET` | 任意 | `unverified/proxy-secret-not-configured`（fail closed）|
| `1` | 缺失或不匹配 | 任意 | `unverified/proxy-secret-mismatch` |
| `1` | 正确 | 单值合法 IP | `client` = 该 IP |
| `1` | 正确 | 缺失 / 多值 / 非法 / 带端口 | `unverified/forwarded-*` |

预算翻译只有一个实现：

```ts
clientLimitRules(identity, clientBudget, siteBudget)
// client    → [客户端桶, 站点桶]
// unverified → [站点桶]          ← 绝不建访客桶
```

站点桶：登录 `login-site` 500/5min（失败计数，含可信客户端）、反馈 `reports-site` 500/h、
指标 `event-site` 20000/h。TOTP 的 `totp-client`/`challenge-client`/`enroll-client` 只对可信
身份计数，不可信身份交给账号级预算 + `login-site` 收口（避免凭空发明一个新的共享小桶）。

### 2.2 代理验证（SJ-01，2026-10-25 复核后改成共享凭据）

**第一版方案（按对端网段信任）已被证伪并删除。** 原因：`@astrojs/node` standalone 适配器
构造 Request 时执行

```js
const forwardedClientIp = getFirstForwardedValue(req.headers["x-forwarded-for"]);
const clientIp = forwardedClientIp || req.socket?.remoteAddress;
Reflect.set(request, clientAddressSymbol, clientIp);
```

于是 `Astro.clientAddress` 在有 `X-Forwarded-For` 时**就是该头的第一个值**，拿它做
"对端是不是我们的代理"的判断是循环论证。实测（`TRUST_PROXY=1`，直连 127.0.0.1）：
分别伪造 `10.0.0.1`、`10.0.0.2`、`192.168.1.5`、`172.20.0.9`、`127.0.0.9`，每一组都各开出
一份独立的 `reports-client` 桶（5 次放行 + 第 6 次 429），即客户端层限流仍可被绕过。

**现行方案**：`TRUST_PROXY_SECRET`（≥16 字符）+ 代理写入 `X-Sanjiang-Proxy-Secret`。
应用只做自己**能验证**的事：

| 条件 | 结果 |
|---|---|
| `TRUST_PROXY=0` | 转发头一律不参与身份；带头 → `unverified`；不带头 → `client` = 连接对端 |
| `TRUST_PROXY=1` 且未配置凭据 | 全部 `unverified`（fail closed）+ 首次请求告警 + `deploy:check` 报错 |
| `TRUST_PROXY=1`、凭据不匹配/缺失 | `unverified/proxy-secret-mismatch` |
| `TRUST_PROXY=1`、凭据正确、单值合法 IP | `client` = 该 IP |
| `TRUST_PROXY=1`、凭据正确、头缺失/多值/非法/带端口 | `unverified` |

修复后同一探测：7 个伪造值 × 6 次 = 42 请求，`reports-client` 桶 **0 个**，`reports-site` 计数 42；
配置凭据后经代理的访客 A（5 放行 + 1 次 429）与访客 B（独立计数）行为恢复正常。

应用**无法**从进程内判断宿主机端口发布，所以：compose 仍绑 `127.0.0.1`，自检交给
`node scripts/check-deployment.mjs [--strict]`（只查配置），暴露面交给 `ss`/`docker ps` 与文档。

### 2.3 离线前置（SJ-03）

`scripts/lib/offline-guard.mjs#detectDatabaseUsers()` 由 `restore-db` 与 `restore-site` 共用：
扫描 `/proc/*/fd` 是否指向目标库/`-wal`/`-shm`，并检查"以本项目脚本运行且 `DATABASE_PATH`
指向目标"的进程。`restore-site` 在**创建 staging 之前**调用它，命中即 `fail()`（非零退出、
不写目标文件）。`--assume-offline` 只覆盖"没有 `/proc`"，**不覆盖**"检测到使用方"。

### 2.4 备份/恢复的目录生命周期（SJ-04 / SJ-05）

- 备份：`mediaRoot` 必须存在（防止 `MEDIA_DIR` 指错），`objects/` 按需创建；
  批次目录非递归创建（已存在即失败），失败时删除**本次**创建的批次。
- 恢复：`--database` 的父目录在参数校验后立即创建（`mode 0700`），失败给
  "无法创建目标目录 …请检查权限与磁盘"而不是内部 `.tmp` 路径。

### 2.5 授权顺序（SJ-07）

`MANAGE_ACTION_ROLES` 是唯一的动作→角色表（`admin` / `session`）。`managePost` 在
`readForm` + `requireCsrf` 之后、`switch` 之前调用 `requireManagePermission()`：

- 未知动作 → 400（管理员也一样，防止"新增动作忘了登记"悄悄变成无人可用的功能）；
- 需要的角色不满足 → 403，**不会**因为参数非法先返回 400/409/404。

下游各服务层保留自己的 `actorUser()`/角色复查（纵深防御），行为不变。

---

## 3. 修复前 / 修复后对照

产物级对照（HEAD 的 `dist` 与修复后的 `dist`，同一套请求）：

```
BEFORE  multiHopFlood  = { failures: 30, legitLoginAfterFlood: 429, retryAfter: "900" }
AFTER   multiHopFlood  = { failures: 30, legitLoginAfterFlood: 303, retryAfter: null }

BEFORE  rotatedSpoof   = { statuses: 6×303, clientBuckets: 6, siteBucket: 6 }
AFTER   rotatedSpoof   = { statuses: 6×303, clientBuckets: 0, siteBucket: 6 }
```

脚本级对照（`git show HEAD:scripts/*` 与修复后脚本，同一套临时站点）：

```
SJ-04 BEFORE  exit 1  "ENOENT ... scandir media/objects"，backups/ 留下半成品批次
SJ-04 AFTER   exit 0  批次含 COMPLETE，media.files = 0

SJ-05 BEFORE  exit 1  "ENOENT ... site-restore-*.log.json.tmp"，目标未创建
SJ-05 AFTER   exit 0  目标目录被创建，恢复日志落在目标目录

SJ-03 BEFORE  exit 0  "restored"，且持有库的进程仍在运行时目标库被替换（dbChanged: true）
SJ-03 AFTER   exit 1  拒绝恢复 + 指出 PID，目标库字节不变（dbChanged: false）
```

---

## 4. 保留项与推迟原因

| 编号 | 结论 | 理由 |
|---|---|---|
| SJ-08 TOTP 3 个未消费挑战 | 保留 | 该上限是 `SECURITY-SPEC §4.5` 的明确要求（"不得自动作废其他浏览器的有效挑战"）。它带来的 5 分钟阻断需要**已知口令**才能触发，属认证安全与可用性的既定取舍。若要缓解，正确方向是"同账号同客户端的失败挑战可被自己替换"，需要单独设计并在规范里同步，不在本轮直接改。 |
| SJ-09 CSP 转强制 | 保留 Report-Only | 页面仍有内联脚本（外跳埋点、后台预览、草稿恢复）并使用 `innerHTML` 写入服务端渲染结果；直接转强制会破坏现有功能。迁移路径（外链脚本 + nonce/hash）需要单独一轮，并要浏览器实测，本轮不做。 |
| SJ-10 `/media/<id>.webp?query` → 404 | 保留 | 这是"每次请求实时查库 + 全部 no-store"的保守取舍：带任意查询串一律不走媒体分支，避免缓存键/代理别名成为下架绕过的入口。是否支持 `?v=` 属产品决策（需要同时评估 CDN 缓存键），不为了兼容参数削弱下架保证。 |
| SJ-11 `__Host-` 前缀 / CSRF 轮换 | 推迟 | 改名要同步所有 Set-Cookie 与清除路径（含挑战 Cookie 与后台表单里的 CSRF 值），并要验证"旧 Cookie 不残留第二份"；CSRF 轮换要新增每会话独立随机值与轮换时机。两者都是独立增强项，风险与收益需单独评估。 |
| 历史遗留（会话列表、指标采样、多跳代理链） | 推迟 | 与 `ROOT-CAUSE-AND-FIX.md §13.3` 一致；多跳链路解析在"单代理覆盖写单值"契约下不是必需项，接入多级 CDN 时再按 `docs/edge-cdn-hardening.md` 处理。 |

---

## 4b. 测试与命令结果（本轮实际退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run check` | 0 | 164 文件，0 error / 0 warning / 0 hint |
| `npm test` | 0 | 285 tests，284 pass，1 skipped（需 root 绑定 :80 的回环用例）|
| `npm run test:server` | 0 | 92/92 |
| `npm run test:instances` | 0 | 4/4（**必须先 `npm run build`**：实例测试跑 `dist/`）|
| `npm run test:admin` | 0 | 36/36 |
| `npm run test:browser` | 0 | 10/10（需先构建并在 4321 起一个已 seed 的实例）|
| `npm run build` | 0 | Astro check + build + 资源裁剪成功 |
| `bash scripts/container-smoke.sh` | 0 | `container smoke: PASS`（含停写备份、恢复、回滚、旧库升级、实例隔离）|
| `git diff --check` | 0 | 无空白/冲突标记 |

新增/重写的测试。每个场景都先在修复前用 HEAD 产物或 HEAD 脚本实测为失败（§3 的三组对照），再由这些用例固化；没有只靠"改测试预期"通过的项：

| 测试 | 覆盖 |
|---|---|
| `server.test.mjs#client identity separates trusted clients from unverified requests` | 六种身份组合、CIDR 覆盖、畸形配置 fail closed |
| `server.test.mjs#不可信身份不会占用访客额度，也无法用 30 次失败锁死登录` | SJ-02 回归（30 次多值头失败后正确口令仍 303）|
| `server.test.mjs#站点级熔断达到阈值后拒绝不可信流量，且轮换转发头无法绕过` | SJ-01 + 站点熔断 + `Retry-After` |
| `server.test.mjs#可信代理写入的单值地址仍然拥有独立访客额度` | 修正不能过度收紧 |
| `server.test.mjs#登录站点熔断达到阈值后拒绝，并保持账号级额度语义` | `login-site` 500/5min |
| `server.test.mjs#每个管理动作先判权限再做参数校验` | SJ-07（逐动作 × 编辑者/管理员 × 非法参数）|
| `server.test.mjs#详细健康诊断只对管理员开放…` | SJ-06 |
| `backup-site.test.mjs#从未上传过媒体、objects 目录尚不存在的新实例也能生成完整批次` | SJ-04 + SJ-05 |
| `backup-site.test.mjs#媒体对象缺失时…不留下半成品批次` | SJ-04 清理 |
| `restore-failure.test.mjs#数据库仍被其他进程使用时，站点恢复拒绝执行且不改动目标` | SJ-03（并与 `restore-db` 交叉验证结论一致）|
| `restore-failure.test.mjs#目标目录不存在时恢复会安全创建它` | SJ-05 |
| `migrations.test.mjs#013 只给 rate_limits.reset_at 加索引…` | SJ-12 |
| `trusted-proxy.test.mjs`（6 个） | CIDR 解析/匹配、部署自检脚本 |

> `tests/totp-server.test.mjs` 与 `tests/server.test.mjs` 中的 `auth.login(...)` 等调用改为显式传入
> `client({...})`：这是接口从"字符串身份"改为"两型身份"后的必要适配，断言强度未降低。

---

## 5. 剩余风险

1. **站点级桶仍是共享预算**：单主机用 500 个请求（反馈）/500 次失败（登录，5 分钟）仍可让
   该类入口在该窗口内不可用。这是规范 §6.1 的既定设计（站点层抗分布式攻击），
   修的是"一次 30 个请求就锁死"，不是"永远不可能被压满"。
2. **容器内检测不到别的容器的进程**：`offline-guard` 只在同一 PID 命名空间有效。
   Docker 部署必须自己 `docker compose stop app maintenance`；文档与命令示例已写明。
3. **应用无法自证暴露面**：端口是否发布到公网只能靠 compose 绑定与运维检查；
   `check-deployment.mjs` 明确不声称能检测这一点。
4. **不可信身份失去挑战-客户端绑定**：挑战仍存 `client_hash`，但 `unverified` 时该值退化为
   固定串（本来也无从归属）。这是"无法识别的部署"的固有权衡，已记入规范 §2.1。
