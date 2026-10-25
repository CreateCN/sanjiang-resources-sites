# 2026-10-25 安全修复最终复核与发布验收

- 仓库：`/media/sunhao/F/Project/sanjiang-resources-site`
- HEAD：`37ed44c74a723290f03b53bb2025617a9d00042c`（`master`，2026-10-23 22:39 +0800）
- 工作区：**有未提交修改**（26 改 + 6 新增，见 §1.2），本轮全程保留、未 commit、未 push、未部署
- 输入：`/tmp/sanjiang-local-security-report.md`（本地审查报告）、`reports/security/2026-10-25-fix/README.md`（修复记录）
- 复核方式：源码审查 + 修复差异分析 + 定向运行时复现 + 发布链路检查；**不重复上一轮的无差别攻击测试**

> 后续：[REMEDIATION-PLAN.md](REMEDIATION-PLAN.md)（修复方案）与 [REMEDIATION-RECORD.md](REMEDIATION-RECORD.md)（P1/P2 修复与复验记录）。本文结论保持原样，验收状态以 REMEDIATION-RECORD 与本文 §11 的条件合起来判读。

**最终结论：有条件通过。** 见 §10。核心修复均已独立复核；但本轮发现并修复了上一轮修复中的一个**阻断级缺陷**（N-01），并引入了一项**破坏性配置变更**（代理共享凭据），必须在发布前完成部署侧配置与一次真实反代联调。

---

## 1. 审查范围与状态

### 1.1 开工前检查（原样记录）

```
git status --short             → 见 §1.2（26 改 6 新增，均为上一轮修复）
git rev-parse HEAD             → 37ed44c74a723290f03b53bb2025617a9d00042c
git diff --stat                → 26 files changed, 977 insertions(+), 255 deletions(-)
git diff --check               → 无输出（clean）
```

确认：原始审查报告 `/tmp/...` 未被覆盖（在仓库外，且本轮未写入）；`reports/security/2026-10-21-*` 未被修改；
没有新提交（`git log -1` 仍是基准提交）。

### 1.2 工作区清单

| 类型 | 文件 |
|---|---|
| 源码 | `src/server/security.ts`、`auth.ts`、`http.ts`、`migrations.ts`、`src/lib/private-address.ts`、`src/pages/api/health/detail.ts`（新增） |
| 脚本 | `scripts/restore-site.mjs`、`restore-db.mjs`、`backup-site.mjs`、`security-audit.mjs`、`scripts/lib/offline-guard.mjs`（新增）、`scripts/check-deployment.mjs`（新增）、`scripts/check-dist-freshness.mjs`（新增） |
| 测试 | `tests/server.test.mjs`、`migrations.test.mjs`、`backup-site.test.mjs`、`restore-failure.test.mjs`、`totp-server.test.mjs`、`tests/deployment.test.mjs`（新增） |
| 文档 | `README.md`、`.env.example`、`docker-compose.yml`、`docs/SECURITY-SPEC.md`、`configuration.md`、`deploy-docker.md`、`deploy-local.md`、`edge-cdn-hardening.md`、`operations.md`、`upgrade.md`、`package.json`、`reports/security/README.md`、`reports/security/2026-10-25-fix/README.md`（新增） |

---

## 2. 新发现的问题

### N-01（High，**阻断发布**，已在本轮修复）｜上一轮的"按对端网段信任"无法成立，直连仍可绕过客户端限流

**问题**：上一轮 `SJ-01` 的修复用 `TRUSTED_PROXIES`（回环 + RFC1918）判断"连接对端是不是我们自己的代理"，
并以此决定是否采信 `X-Forwarded-For`。该判据在 `@astrojs/node` standalone 模式下**不成立**。

**证据 1（源码）**：`node_modules/astro/dist/core/app/node.js:121`

```js
const forwardedClientIp = getFirstForwardedValue(req.headers["x-forwarded-for"]);
const clientIp = forwardedClientIp || req.socket?.remoteAddress;
Reflect.set(request, clientAddressSymbol, clientIp);
```

`Astro.clientAddress` 在请求带 XFF 时**就是该头的第一个值**。于是"对端地址"与"客户端自己写的头"是同一个值，
拿它做信任判断是循环论证。

**证据 2（运行时，`TRUST_PROXY=1`、无共享凭据、直连 127.0.0.1）**：

| 伪造的 `X-Forwarded-For` | 6 次提交结果 | 生成的访客桶 |
|---|---|---|
| `10.0.0.1` | 303×5, 429 | `reports-client` ×1 |
| `10.0.0.2` | 303×5, 429 | `reports-client` ×1 |
| `192.168.1.5` | 303×5, 429 | `reports-client` ×1 |
| `172.20.0.9` | 303×5, 429 | `reports-client` ×1 |
| `127.0.0.9` | 303×5, 429 | `reports-client` ×1 |
| `198.51.100.7` / `8.8.8.8`（公网值） | 303×6 | 全部落共享桶 |

一次直连即可凭"私网地址"伪造出 5 份独立访客额度 → SJ-01 的客户端限流绕过仍然成立。

**修复（本轮实施）**：删除 `TRUSTED_PROXIES` 与 `src/lib/trusted-proxy.ts`（不再保留无法强制执行的配置项），
改为**代理共享凭据**：

- 环境变量 `TRUST_PROXY_SECRET`（≥16 字符），代理写 `X-Sanjiang-Proxy-Secret`；
- `clientIdentity()` 只做自己能验证的事：`TRUST_PROXY=0` → 转发头一律不参与身份；`TRUST_PROXY=1` 且未配置凭据 → **fail closed**（全部 `unverified`，仅站点级限流）；凭据不匹配 → `unverified`；凭据正确 + 单值合法 IP → `client`；
- 恒定时间比较（`timingSafeEqual`，先比长度）；
- `deploy:check` 在凭据缺失/过短时报 **error**，`--strict` 把"可运行但降级"的提示也升级为错误；
- 首次请求时打印一次不含 PII 的告警。

**复测**：同一探测（7 个伪造值 × 6 次 = 42 请求）修复后 → `reports-client` 桶 **0 个**，`reports-site` 计数 42。
真实代理链路（本地 http 反向代理：覆盖写 XFF + 注入凭据）→ 访客 A 5 次放行 + 第 6 次 429，访客 B 独立计数，
客户端自带的伪造 XFF 被代理覆盖后不产生任何额外桶（`probe-with-proxy.mjs`）。

**回归测试**：`tests/server.test.mjs#client identity trusts a forwarded address only behind a verified proxy`
覆盖 9 种组合（含"伪造私网地址 + 无凭据"）；`#直接访问不能靠伪造转发头获得可信身份` 断言轮换值不改变身份；
`tests/deployment.test.mjs` 覆盖自检脚本的 error/warn/strict 行为。

**影响面（重要）**：这是**破坏性配置变更**——升级后必须同时设置 `TRUST_PROXY_SECRET` 与反代的
`X-Sanjiang-Proxy-Secret`。未设置时站点仍可访问，但按访客计的额度失效（退化为站点级）。
已写入 `docs/upgrade.md` §0、`README`、`.env.example`、`docker-compose.yml`、`docs/deploy-docker.md`。

### N-02（Medium，已修复）｜"用 dist 的测试"会静默跑旧代码

`test:instances`、`test:admin` 直接启动 `dist/server/entry.mjs`（`test:browser` 依赖外部已启动的实例）。
若 `dist/` 落后于 `src/`，这些测试对着**旧代码**通过或失败。本轮实际踩到：加入迁移 `013` 后未重建就运行
`test:instances`，实例启动即被 `UnknownMigrationError` 拖到 15.8s 超时。

**修复**：`scripts/check-dist-freshness.mjs`（只做 stat，不构建/不联网/不写文件），并作为
`pretest:instances` / `pretest:admin` / `pretest:browser` 钩子；新增 `npm run dist:check`。
实测：`package.json` 比 `dist` 新时退出码 1 并指出具体文件；构建后 0。

### N-03（Low，环境限制，未改脚本）｜容器冒烟首次因 Docker Hub 认证超时失败

`bash scripts/container-smoke.sh` 第一次运行在 `docker build` 阶段失败：
`failed to fetch anonymous token: … net/http: TLS handshake timeout`（EXIT=1，未产生容器）。
同命令立即重试 → `container smoke: PASS`。判为外部 registry 网络抖动，不是代码或脚本缺陷；
**不修改脚本、不把首次失败改记为通过**（两次结果都记录在 §8）。

### N-04（Informational）｜`consumeLimit` 仍会为不存在的用户名建行

每次失败登录都会为用户名建一行 `rate_limits`（历史遗留，`ROOT-CAUSE` 已登记）。加 `013` 索引后清理代价下降；
未改动语义。不构成可利用缺陷。

---

## 3. `TRUSTED_PROXIES` 信任模型、默认范围与剩余风险（任务 §4）

### 3.1 结论：该机制已移除，改为凭据验证

| 维度 | 第一版（已删除） | 现行 |
|---|---|---|
| 判据 | 连接对端是否在回环+RFC1918 | 代理是否持有 `TRUST_PROXY_SECRET` |
| 能否被直连伪造 | **能**（适配器把 XFF 首值当对端） | 不能（拿不到凭据） |
| 默认值是否 fail-safe | 否（默认信任整个私网） | 是（未配置凭据 → 全部 `unverified`） |
| 配置错误的表现 | 静默（看起来"按访客"，实则按伪造字符串） | 显式：启动告警 + `deploy:check` error + 测试断言 |

### 3.2 六个部署场景的评估（任务 §4.2 要求）

| # | 场景 | 凭据模型下的行为 |
|---|---|---|
| 1 | 应用与反代在同一 Docker 网络 | 正常：代理持有凭据并覆盖写 XFF → 按访客分桶（实测见 §2 N-01 复测） |
| 2 | 应用与其他**不可信容器**共享私网 | 不可信容器没有凭据 → 一律 `unverified`（只吃站点预算）；不能靠伪造私网 XFF 获得访客额度 |
| 3 | 其他私网客户端能直连应用端口 | 同上：没有凭据 → `unverified`。**但端口暴露仍是风险**（可耗尽站点预算、可探测），必须按部署检查收敛 |
| 4 | 多层反代 | 只要最内层写入"真实客户端地址 + 凭据"即可；中间层必须用 `real_ip` 还原 `$remote_addr`（见 `docs/edge-cdn-hardening.md`） |
| 5 | CDN / 外部代理 | 源站只接受 CDN 回源段 + 由 Nginx 写凭据与单值 XFF；应用不解析 CDN 头 |
| 6 | 代理容器地址变化 / 网络重建 | 无影响：判据不是 IP，凭据与地址无关 |

**"私有地址"与"可信代理"的区别**正是第一版的错误来源：私网里既有我们的代理，也可能有别人的容器/主机。
凭据模型把判据从"网络位置"换成"持有的秘密"，这是本项目技术栈下唯一可验证的判据。

### 3.3 剩余风险（保留记录，不在本轮扩大修复范围）

1. **凭据泄露即可伪造身份**：凭据进过 nginx 配置与 `.env`，需按密钥管理（不进备份、不进日志、
   `log_format` 不含该头）。泄露后轮换 = 两端同改重启。
2. **站点级桶仍是共享预算**：500 请求/窗口可让该入口在该窗口内不可用（规范 §6.1 的既定取舍）。
3. **端口暴露无法由应用自证**：`check-deployment.mjs` 明确只查配置；暴露面靠 compose 绑定、`ss`/`docker ps`。
4. **`clientAddress` 不可用于任何安全判断**：已在规范 §2.1 写成硬约束，防止后人再引入同类判据。

已补充的测试（任务 §4.3 要求逐条对应）：非可信对端伪造单值 XFF ✓、轮换多个伪造值 ✓、可信代理传递合法地址 ✓、
多值与缺失 XFF ✓、"私网地址中的伪造值"（原 RFC1918 场景）✓、IPv4-mapped（`::ffff:198.51.100.7`）✓、
带端口地址 ✓、`TRUST_PROXY` 开关差异 ✓、凭证缺失/过短/不匹配 ✓。

---

## 4. SJ-02 限流身份与站点级熔断（复核）

| 不变量 | 结论 | 证据 |
|---|---|---|
| `client` / `unverified` 类型与控制流分离 | 成立 | `ClientIdentity`（可辨识联合）；`clientLimitRules()` 是唯一翻译入口 |
| 不可信身份不建访客桶 | 成立 | 实测：42 次伪造请求 → `reports-client` 0 行；单测断言 `SELECT … LIKE 'reports-client:%'` 为空 |
| 可信访客额度相互独立 | 成立 | 代理链路实测：访客 A 5+429、访客 B 独立 2 次 |
| 不可信请求仍受站点级保护 | 成立 | 预填站点桶后，轮换伪造头仍 429（`Retry-After` 与站点窗口一致） |
| 登录站点桶阈值/窗口符合规范 | 成立 | `LOGIN_SITE_MAX_FAILURES=500`、`LOGIN_SITE_WINDOW_MS=5min`；SPEC §4.2 已改为"必须" |
| 站点级限流不误伤未达阈值的正常登录 | 成立 | 30 次多值头失败后，正确口令仍 303；只有预填到 500 才拒绝 |
| `Retry-After` 与窗口一致 | 成立 | 反馈 409 场景返回 3600 且库内 `reset_at` 剩 3599；登录 899/900；站点 5 分钟场景 ≤300 |
| 成功/失败/账号/站点之间无重复计数或绕过 | 成立 | 成功登录不消费；失败结算 `consumeLimits(rules)`（客户端或站点 + 账号）；客户端桶先于站点桶，被拒请求不计站点 |

**入口一致性**（任务特别要求）：匿名反馈与事件统计都走 `rateLimitClient(identity, client, site)`；
登录走 `clientLimitRules(…, LOGIN_SITE_BUDGET)`；TOTP 的 `totp-client`/`challenge-client`/`enroll-client`
只对可信身份计数（`site=null`），不可信时交给账号级预算 + `login-site`。`check-link`(30/10min) 与
`upload-media`(20/h) 是按**操作者用户名**计数的已认证动作，与身份类型无关，属有意差异。
（全量 call site 清单：`auth.ts:260,278,279,286,287,288,306,307,308,317,410,519`、`http.ts:240,369,505,576`。）

---

## 5. SJ-03 数据库离线保护的能力边界（复核）

- **共享实现**：`scripts/lib/offline-guard.mjs#detectDatabaseUsers()`，`restore-db.mjs` 与 `restore-site.mjs` 都调用；两条命令对同一现场给出一致结论（测试同时断言了两者）。
- **检查时机**：`restore-site` 在参数解析后、**创建 staging/读取批次/任何写操作之前**执行；命中即 `fail()`（非零退出）。
- **零修改**：测试断言拒绝时目标 DB 的 sha256 不变、`objects/` 目录列表不变。
- **`--assume-offline` 语义**：只覆盖"系统没有 `/proc`、无法检测"的情形，**不覆盖"检测到使用方"**（与 `restore-db` 一致），不是默认绕过。
- **WAL/SHM**：目标库、`-wal`、`-shm` 都纳入 fd 扫描；恢复流程本身在替换前删除旧 sidecar，失败按日志回滚（既有测试覆盖）。
- **能力边界（明确写入报告，不夸大）**：只在**同一 PID 命名空间**内有效。容器之间互相看不到对方进程，因此 Docker 部署必须由运维先 `docker compose stop app maintenance`，并确认没有其他容器挂载同一数据卷。`docs/operations.md` 已写成命令示例 + 前置检查；`restore-db`/`restore-site` 的输出里也带了同样的提示。
- **误导性成功**：`restore-site` 只有走完 `verify` 阶段才写 `status: restored`；失败路径写 `status: error` 并回滚（既有 + 新增测试覆盖）。

---

## 6. 迁移 013 的兼容性与完整性（复核）

迁移：`013-rate-limits-reset-at` → `CREATE INDEX IF NOT EXISTS rate_limits_reset_at ON rate_limits(reset_at)`。

| 检查项 | 结论 | 验证方式 |
|---|---|---|
| 新库：索引存在且定义正确 | 通过 | 查询 `sqlite_master` 断言 `CREATE INDEX … ON rate_limits(reset_at)` |
| 旧库（012）升级：只补 013、数据不变 | 通过 | 手工跑到 012 + 写入 `rate_limits` 行 → `applyMigrations` 返回 `['013-…']`，行内容不变 |
| 升级库与新库结构一致 | 通过 | 两侧 `sqlite_master` 中 `tbl_name='rate_limits'` 的索引定义逐项 `deepEqual` |
| 重复执行安全 | 通过 | 二次 `applyMigrations` 返回 `[]`（记录已存在即跳过，事务内复核） |
| 清理语义未改变 | 通过 | `EXPLAIN QUERY PLAN DELETE FROM rate_limits WHERE reset_at <= ?` 命中 `rate_limits_reset_at`；列结构仍是 `key,count,reset_at` |
| 失败不留半完成 schema | 通过（机制） | 每个迁移在独立 `BEGIN IMMEDIATE` 中执行，异常 `ROLLBACK`（`applyMigrations` 既有实现，`migrations.test.mjs` 覆盖未知迁移拒绝） |
| 旧库兼容性门禁 | 通过 | `assertKnownMigrations` 在应用启动、`restore-db`、`restore-site` 共用；013 已进入 `migrations` 列表 |

---

## 7. 发布构建与测试顺序（复核）

| 检查项 | 结论 |
|---|---|
| `package.json` 各测试脚本的真实目标 | `test`/`test:server` 直接加载 `src/*.ts`；`test:instances`/`test:admin` 启动 `dist/server/entry.mjs`；`test:browser` 需要外部已启动实例（`TEST_BASE_URL`） |
| 构建是否包含新迁移 | 是：`npm run build` 重新打包 server bundle，`dist` 内含 `013`（`test:instances` 通过即为端到端证明） |
| dist 与源码不同步的风险 | 已加 `scripts/check-dist-freshness.mjs` + `pretest:instances/admin/browser` 钩子（N-02） |
| Docker 构建是否用当前源码 | 是：`docker build` 从仓库上下文 `COPY src scripts` 后 `npm run build`；本轮 smoke 重新构建并通过 |
| `deploy:check` 的能力边界 | 只检查 `SITE_URL`/`TRUST_PROXY`/`TRUST_PROXY_SECRET`；源码注释与文档都写明**不**判断端口发布/容器网络；测试断言脚本内不得残留 `TRUSTED_PROXIES` |
| 是否存在"旧 dist + 部分测试通过"的路径 | 存在过，现已由 freshness 钩子阻断（未构建时 `test:instances` 会在 pretest 阶段失败并提示构建） |
| 是否新增统一验收脚本 | **未新增**。理由：任务要求"不要重复维护互相冲突的测试清单"，现有命令已足够，新增入口只会制造第二份清单；改为把构建顺序做成测试前置钩子（最小侵入）。 |

---

## 8. 各测试命令的实际结果（本轮重新执行）

执行顺序：`check → build → test → test:server → test:instances → test:admin → test:browser → container-smoke → diff --check`。

| 命令 | 退出码 | 通过 / 失败 / 跳过 | 日志 |
|---|---|---|---|
| `npm run check` | 0 | 164 文件，0 error / 0 warning / 0 hint | `/tmp/sj-fix/f-check.log` |
| `npm run build` | 0 | Astro check + build + 资源裁剪成功 | `/tmp/sj-fix/f-build.log` |
| `node scripts/check-dist-freshness.mjs` | 0 | dist 不旧于源码（构建前测过 1，见 N-02） | — |
| `npm test` | 0 | 284 tests / 283 pass / 0 fail / **1 skipped** | `/tmp/sj-fix/f-test.log` |
| `npm run test:server` | 0 | 92 / 92 | `/tmp/sj-fix/f-server.log` |
| `npm run test:instances` | 0 | 4 / 4 | `/tmp/sj-fix/f-instances.log` |
| `npm run test:admin` | 0 | 36 / 36 | `/tmp/sj-fix/f-admin.log` |
| `npm run test:browser` | 0 | 10 / 10（先 seed + 起 4321 实例） | `/tmp/sj-fix/f-browser.log` |
| `bash scripts/container-smoke.sh` | 0（第 2 次） | `container smoke: PASS`；**第 1 次 EXIT=1**（Docker Hub TLS 超时，见 N-03） | `/tmp/sj-fix/r-smoke.log`、`/tmp/sj-fix/f-smoke.log` |
| `git diff --check` | 0 | 无输出 | — |

补充的定向验证（不属于上述命令，但作为证据）：

| 探针 | 结论 | 文件 |
|---|---|---|
| 直连伪造 7 种 XFF（修复后） | 42 请求 → `reports-client` 0 桶、`reports-site` 42 | `peer-after.json` |
| 真实反向代理链路 | 访客 A 5+429、访客 B 独立；伪造 XFF 被覆盖后无额外桶 | `probe-with-proxy.mjs` 输出 |
| 旧 dist（HEAD）对照 | 30 次多值失败 → 正确口令 429/900；修复后 303 | `evidence.json`（上一轮） |

> 测试数从上一轮记录的 285 变为 284：`tests/trusted-proxy.test.mjs`（6 项）随对端网段方案一并删除，
> 新增 `tests/deployment.test.mjs`（4 项）+ `server.test.mjs` 新增/改写若干项 + `migrations.test.mjs` +1。
> 删除的是**已被证伪的机制**的测试，不是为了让失败消失；对应安全属性的断言已迁移到新模型（见 §2 N-01）。

---

## 9. SJ-04/05/06/07/12 逐项复核

| 项 | 复核结论 | 证据 |
|---|---|---|
| SJ-04 新实例首次备份 | 通过：`media/objects` 不存在时自动创建，批次含 `COMPLETE`，`media.files=0` | `tests/backup-site.test.mjs#从未上传过媒体…` |
| SJ-04 失败不留半成品 | 通过：失败后 `backups/` 目录清单与失败前一致 | 同上 `#媒体对象缺失时…不留下半成品批次` |
| SJ-05 目标目录不存在 | 通过：`--database <new>/db/site.sqlite` 场景恢复成功、日志落在目标目录 | `tests/restore-failure.test.mjs#目标目录不存在时…` |
| SJ-05 错误信息 | 通过：目录创建失败给出"无法创建目标目录 …请检查权限与磁盘状态" | 源码 `restore-site.mjs` 首个 try/catch |
| SJ-06 `/api/health/` 字段 | 通过：实测 `{"status":"ok","db":"ok"}`，键集合断言为 `['db','status']` | `server.test.mjs` + 浏览器阶段实测 |
| SJ-06 详细诊断鉴权 | 通过：匿名 401、编辑者 403、管理员 200 且含 `schema`/`uptime` | `#详细健康诊断只对管理员开放…` |
| SJ-06 下游依赖 | 通过：compose healthcheck 用 `r.ok`，冒烟脚本 grep `"db":"ok"`，文档示例已更新 | `docker-compose.yml`、`scripts/*.sh` |
| SJ-07 映射覆盖 | 通过：37 个动作 × 编辑者/管理员；另断言管理员响应中**不出现**"未知管理操作"，双向防止映射与 switch 漂移 | `#每个管理动作先判权限再做参数校验` |
| SJ-07 顺序 | 通过：`requireCsrf` → `requireManagePermission` → switch 内参数校验 | 源码顺序 + 编辑者"非法参数也 403"断言 |
| SJ-07 遗漏风险 | 通过（fail closed）：映射缺失 → 所有人 400，不会默认放行 | 同上断言 |
| SJ-12 索引 | 通过：新库/旧库结构一致、`EXPLAIN` 命中索引、数据不变、重复执行安全 | §6 |

---

## 10. 未解决项与保留的 Informational 项目

`reports/security/2026-10-25-fix/README.md` §4 的四项保留结论经本轮复核**仍然成立**，且未被强行修改：

| 编号 | 结论 | 本轮复核 |
|---|---|---|
| SJ-08 TOTP 3 个未消费挑战 | 保留 | `MAX_ACTIVE_CHALLENGES=3` 与规范 §4.5 一致；触发 5 分钟阻断需要已知口令。改动它属于认证策略变更，需独立设计 |
| SJ-09 CSP 仍 Report-Only | 保留 | 页面仍有内联脚本与 `innerHTML` 写入服务端 HTML；转强制需外链+nonce 的一轮改造与浏览器实测 |
| SJ-10 `/media/<id>.webp?query` → 404 | 保留 | 与"每次请求实时查库 + 全部 no-store"配套；是否支持 `?v=` 属产品决策，不能为兼容参数削弱下架保证 |
| SJ-11 `__Host-` 前缀 / CSRF 轮换 | 推迟 | 改名要同步所有 Set-Cookie 与清除路径；CSRF 轮换要新增每会话随机值与轮换时机。独立增强项 |

其他保留项（历史登记，未变）：会话列表/退出全部设备、指标采样降级、多跳代理链解析（现由凭据模型覆盖，不再需要 CIDR）。

**本轮未覆盖 / 不能证明的事**（避免把"测试通过"当成"没有漏洞"）：

1. 没有用真实 Nginx + TLS 做一次端到端联调（用的是本地 http 反向代理模拟同一条契约）；
2. 没有做 `npm audit` / 依赖漏洞扫描；
3. 没有在浏览器里验证"凭据缺失时的站内体验"（只有 HTTP 层断言）；
4. 没有跨主机/跨容器验证离线保护（受 PID namespace 限制，属已知边界）；
5. 没有长时间（>1 小时）窗口行为与站点桶耗尽的可用性评估（沿用上一轮结论）。

---

## 11. 本地发布验收结论

### **有条件通过**

**判定依据**：核心修复（SJ-01/SJ-02/SJ-03/SJ-04/SJ-05/SJ-06/SJ-07/SJ-12）在源码中真实存在、
有可复现的正反证据、有对应回归测试；发布门禁（check/build/4 类测试/容器冒烟/差异检查）在**当前源码与最新构建产物**上全部通过，
未发现未修复的高风险缺陷。但存在必须在发布前完成的外部条件。

### 发布前必须满足的条件

1. **配置代理共享凭据**（N-01 的破坏性变更）：`.env` 设 `TRUST_PROXY_SECRET`（≥16，建议 32 位随机），
   反代加 `proxy_set_header X-Sanjiang-Proxy-Secret "<同值>";` 并保持 `X-Forwarded-For $remote_addr` 覆盖写；
   重启后 `node scripts/check-deployment.mjs` 必须 `status: ok`。
2. **在目标环境用真实反代联调一次**：5 次反馈 → 第 6 次 429；换一个真实客户端 IP → 仍有独立额度；
   `rate_limits` 中出现多个 `reports-client` 键而不是一个 token。这是唯一一项无法在本地完全替代的验证。
3. **确认 4321 暴露面**：`ss -lntp | grep 4321` 只出现 `127.0.0.1`；`docker ps` 的端口映射不得是 `0.0.0.0:4321`。
4. **确认凭据不进日志**：反代 `log_format` 不包含 `X-Sanjiang-Proxy-Secret`；凭据单独保存、不进备份包。

### 未达"通过"的原因（不美化）

- 第 1、2 条属于**部署动作**，本轮不能替运维完成；未完成时按访客限流实际是关闭的（fail closed 到站点级）。
- 上一轮曾把"对端网段"当成已验证的修复（N-01），说明**没有部署侧联调时，单元测试与产物级对照仍可能给出错误的安全结论**。
  这一条本身也是"有条件"的理由。

### 需人工决策的事项

1. 是否接受"未配置凭据即退化为站点级限流"的默认（当前选择：接受，理由见 SPEC §2.1）。若希望开箱即按访客限流，
   需要引入凭据的自动生成与分发机制（会带来新的密钥管理面）。
2. 站点级共享预算的容量是否按真实峰值调整（当前 500/h 反馈、500/5min 登录、20000/h 指标）。
3. SJ-08～SJ-11 是否排期（各自需要独立设计与回归）。

---

## 12. 补记（第三轮，2026-10-25 晚）

本文 §11 的**结论与四条发布条件均未改变**，只补两点事实，避免后续读者把第 2 条当成"只能靠手工"：

1. 第 2 条的**应用侧判据**已固化为可重复门禁 `npm run acceptance:proxy`
   （`scripts/proxy-acceptance.mjs`）：起真实构建产物 + 本地反代替身，跑"同客户端第 6 次 429 /
   换客户端独立额度 / `rate_limits` 出现多个 `reports-client` 键 / 直连伪造转发头拿不到访客桶 /
   凭据不进日志与数据库 / 只监听回环"共 11 项判据，两处变异测试证明它会真的失败。
   细节见 [REMEDIATION-RECORD.md](REMEDIATION-RECORD.md) §9。
2. 第 2 条剩下的、本地确实测不到的部分收窄为：**真实反代软件**的配置正确性（同名头、覆盖写 XFF、
   `proxy_set_header` 的整组继承陷阱）、CDN 回源改写，以及第 3、4 条的宿主机端口发布与 `log_format`。
   它们仍是"有条件通过"的理由，未因上述门禁而消失。
