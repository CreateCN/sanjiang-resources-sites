# 2026-10-25 本地鉴权安全审查（认证 / 授权 / 会话 / TOTP）

- 仓库：`/media/sunhao/F/Project/sanjiang-resources-site`
- 分支 / HEAD：`master` / `93fc92199775928ad22423c2fd17b9839f8b5a91`
- 工作区：**开工时干净**（`git status --short` 无输出，`git diff --check` 无输出）；本轮**未修改任何业务源码**，只新增本报告目录
- 构建产物：`dist/` 与 `src/` 一致（`node scripts/check-dist-freshness.mjs` → `{"status":"ok","distAt":"2026-10-25T04:53:58.111Z"}`）
- 输入：审查方案 `sanjiang-auth-security-review-plan.md`（322 行）、`docs/SECURITY-SPEC.md`（v1.8）
- 方式：源码审查 + 规范逐条对照 + 临时数据库定向复现；**未访问公网、未对生产环境发起任何请求、未使用真实账户或真实 TOTP 密钥**

---

## 0. 结论摘要

| 问题 | 等级 | 类型 | 状态 |
|---|---|---|---|
| SJ-A-01 账号层失败预算耗尽后拒绝该账号**全部**登录尝试，可被未认证第三方持续锁定 | Medium（可用性；单管理员站点按 High 对待） | **已证实行为 + 规范偏差**（§6.1 表述相反；未登记为例外） | 待决策 |
| SJ-A-02 敏感操作"新鲜证明"无任何失败预算：可无限次猜测当前口令与 6 位 TOTP | Medium | **已证实（设计缺口）** | 待修复 |
| SJ-A-03 `/api/import/preview/` 500 分支回显原始 `error.message`，且授权晚于读体/CSRF；该路由亦无限流 | Low | 规范偏差（§9.3、§5/§10） | 待修复 |
| SJ-A-04 TOTP / 恢复码失败不参与 `login-site` 站点熔断 | Low | 规范偏差（§4.2"必须参与每一次失败结算"） | 待决策 |
| SJ-A-05 未知挑战 token 计入共享 `totp-user:unknown` 桶 | Low | 规范偏差（§6.2.7），无跨账号影响 | 待决策 |
| SJ-A-06 会话 Cookie 未用 `__Host-` 前缀 | Low | 偏离"建议"项（§2.3） | 可延后 |
| SJ-A-07 `consumeLimits()` 忽略 `allowed`，计数可短暂超限 | Informational | 语义说明缺失 | 可延后 |
| SJ-A-08 `applyImport()` 用会话角色而非 `actorUser()` | Informational | §5 一致性 | 可延后 |

**核心判断：认证（口令 / TOTP / 恢复码 / 会话生命周期）与授权（角色映射 / 守卫顺序 / 对象级）在本轮证据下成立；薄弱面集中在"再认证（fresh proof）"与"限流维度覆盖"，以及一处错误响应策略不一致。** 详见 §8 三个问题。

---

## 1. 开工前检查（原样记录）

```
$ git status --short          → （空）
$ git rev-parse HEAD          → 93fc92199775928ad22423c2fd17b9839f8b5a91
$ git branch --show-current   → master
$ git diff --stat             → （空）
$ git diff --check            → （空，exit 0）
```

测试隔离确认：

- 全部用例通过 `process.env.DATABASE_PATH = join(mkdtempSync(...), '<seq>.sqlite')` 指向临时目录（`tests/server.test.mjs:11-13`、`tests/totp-server.test.mjs:11-12`、`tests/admin-e2e.mjs:19-24`），`after()` 中用 `realpathSync` 断言目标在 `os.tmpdir()` 下再删除。
- 本轮探针脚本同样只写 `os.tmpdir()`，运行结束删除（`scripts/probe-auth.mjs` 末尾用 `rmSync`）。
- 未执行会访问公网的用例：`tests/linkcheck.test.mjs` 内含真实 DNS/`93.184.216.34` 出站检查（第 20-143 行），因此本轮**故意不跑 `npm test` 全量**，只跑鉴权相关文件（见 §9）。
- 未执行 `npm run build`、`bash scripts/container-smoke.sh`、`scripts/security-audit.mjs`（原因见 §10）。

---

## 2. 阶段 A：入口 — 角色 — 守卫 — 副作用矩阵

### 2.1 认证与会话入口

| # | 入口 | 方法 | 认证 | 最低角色 | Origin | CSRF | 限流（仅失败或按请求） | 关键副作用 |
|---|---|---|---|---|---|---|---|---|
| A1 | `/api/login/` → `http.loginPost` | POST | 无 | — | **必须** | — | `login-client` 30/15m、`login-site` 500/5m、`login-user` 10/15m（仅失败）；TOTP 账户再加 `challenge-user` 10/15m、`challenge-client` 30/15m 或 `enroll-client` 5/h | 会话 Cookie 或挑战 Cookie；审计 `login` / `issue-challenge` |
| A2 | `/api/login/totp/` → `http.totpPost` | POST | 挑战 Cookie（绑定客户端） | — | **必须** | — | `totp-user` 10/15m、`totp-client` 30/15m、`totp-recovery-user` 3/h | 条件更新 `totp_last_step` 或原子消费恢复码 → 消费挑战 → 签发会话 → 审计 `login-totp` |
| A3 | `/api/login/enroll/` → `http.enrollPost` | POST | 挑战 Cookie（绑定客户端） | — | **必须** | — | `totp-user` 10/15m、`totp-client` 30/15m | 安装因子（`auth_version+1`）、删除全部会话/挑战/恢复码、生成 10 个恢复码、签发会话、审计 |
| A4 | `GET /admin/login/enroll/` | GET | 挑战 Cookie + 客户端 | — | — | — | — | 解密该挑战的 `pending_secret`、返回 otpauth URI 与二维码（`no-store`） |
| A5 | `GET /admin/login/totp/` | GET | 挑战 Cookie | — | — | — | — | 只读表单 |
| A6 | `/api/logout/` → `http.logoutPost` | POST | 会话 | 任意 | **必须** | **必须** | — | 删除当前会话行 + 清两份 Cookie |
| A7 | `manage` `begin-totp-enroll` | POST | 会话 | `session` | **必须** | **必须** | `enroll-client`、`challenge-user`、`challenge-client`（**仅在口令校验通过后**） | 签发 enroll 挑战 + 挑战 Cookie |
| A8 | `manage` `disable-totp` | POST | 会话 | `session` | **必须** | **必须** | **无** ← SJ-A-02 | 清空因子、`auth_version+1`、撤销全部证明、清 Cookie |
| A9 | `manage` `regenerate-recovery` | POST | 会话 | `session` | **必须** | **必须** | **无** ← SJ-A-02 | 重建 10 个恢复码、`auth_version+1`、撤销并重建会话 |
| A10 | `manage` `reset-totp` | POST | 会话 | `admin` | **必须** | **必须** | **无** ← SJ-A-02 | 清空**目标**因子、`auth_version+1`、撤销目标全部证明；禁止作用于自己 |
| A11 | `GET /admin/security/` | GET | 会话 | 任意 | — | — | — | 只读因子状态 |

### 2.2 管理写入口（统一 `POST /api/manage/`）

所有 38 个动作共用一条前置链，顺序固定为：

```
requireOrigin → readForm(MANAGE_MAX_BYTES) → 动作级体积上限 → draft 捕获
             → requireCsrf(Origin + 会话 + timingSafeEqual)
             → requireManagePermission(MANAGE_ACTION_ROLES[action])
             → 动作专属参数校验 → 业务事务（actorUser 复查角色 + 审计同事务）
```

| 组 | 动作 | 所需 | 二次服务端角色复查 |
|---|---|---|---|
| 内容草稿 | `save-resource`、`save-guide`、`restore-resource`、`restore-guide`、`bulk-review`、`update-report` | `session` | `actorUser(actor)` |
| 外站检查 | `check-link` | `session` | `actorUser` + `linkcheck-user` 30/10m |
| 媒体上传 | `upload-media` | `session` | `actorUser` + `media-upload` 20/h |
| 自助因子 | `begin-totp-enroll`、`disable-totp`、`regenerate-recovery` | `session` | `actorUser` |
| 发布/撤回/删除 | `publish`、`unpublish`、`delete-resource`、`publish-guide`、`unpublish-guide`、`delete-guide` | `admin` | `actorUser(actor, true)` |
| 生命周期 | `discontinue-resource`、`reactivate-resource` | `admin` | `actorUser(actor, true)` |
| 分类 | `save-category`、`delete-category` | `admin` | `actorUser(actor, true)` |
| 人员 | `create-user`、`update-user`、`reset-totp` | `admin` | `actorUser(actor, true)` |
| 站点配置 | `save-settings`、`save-branding`、`save-sponsor`、`delete-sponsor`、`save-sponsor-settings`、`exit-demo` | `admin` | 各模块内复查（`settings.ts:96`、`site-config.ts:216`、`sponsors.ts:139/257/277/297`、`demo.ts`） |
| 导入导出 | `import-apply` | `admin` | `applyImport` 内 `actor.role`（SJ-A-08） |
| 媒体下架 | `delete-media`、`restore-media`、`purge-media` | `admin` | `media.ts:474/499/526` |
| 回收站 | `restore-trash-resource`、`purge-resource`、`restore-trash-guide`、`purge-guide` | `admin` | `actorUser(actor, true)` |

合计：**11 个 `session` + 27 个 `admin`**，`default: fail(400,'未知管理操作')`，`requireManagePermission` 对未登记动作返回 400（fail-closed）。

### 2.3 读取与匿名写入入口

| 入口 | 方法 | 认证 | 角色 | Origin | 备注 |
|---|---|---|---|---|---|
| `/api/export/` | GET | 会话 | `admin` | —（GET，无 CSRF） | `SameSite=Strict` 使跨站导航不带 Cookie |
| `/api/health/` | GET | 无 | — | — | 只返回 `status` / `db` |
| `/api/health/detail/` | GET | 会话 | `admin` | — | `schema` / `uptime` |
| `/api/import/preview/` | POST | 会话 | `admin` | 经 `requireCsrf` | **授权顺序与错误体详见 SJ-A-03**；**无限流** |
| `/api/preview/` | POST | 会话 | 任意 | 必须 | `requireCsrf`；Markdown 渲染为 JSON |
| `/api/reports/` | POST | 无 | — | 必须 | 蜜罐字段 `website`；`reports-client` 5/h + `reports-site` 500/h |
| `/api/event/` | POST | 无 | — | Origin 或 `Sec-Fetch-Site: same-origin` | 事件名白名单 + 目标存在性 + 每日 200 目标上限 |
| `/admin/*`（12 个页面） | GET | 会话 | `admin` | — | `audit`/`categories`/`import`/`maintenance`/`media`/`metrics`/`settings`/`sponsors`×2/`trash`/`users` |
| `/admin/*`（其余页面） | GET | 会话 | 任意 | — | 管理动作按钮按角色条件渲染，**但不构成控制**（服务端仍需过 2.2 的链） |
| `/media/<file>` | GET/HEAD | 无 | — | — | 每次实时查库，全部 `no-store`；非 GET/HEAD → 405 |

### 2.4 已实现但**没有入口**、以及规范要求但**未实现**的清单

| 项 | 位置 | 状态 |
|---|---|---|
| `deleteUser()` | `src/server/store.ts:323` | **无任何调用点**（无路由、无 `MANAGE_ACTION_ROLES` 登记）→ 死代码，不构成入口；建议删除或补入口并写明门禁 |
| "退出其他/全部会话"、设备列表 | `docs/SECURITY-SPEC.md:152`（**应**提供） | 未实现。§4.3 用的是"应"，不阻断发布，但撤销能力目前只能靠改密/改角色/停用/管理员重置 |
| CSRF 令牌轮换 | `docs/SECURITY-SPEC.md:154`（**应**） | 未实现（由会话令牌派生），规范已注明"现状可接受" |
| `/api/import/preview/` 的**路由级**越权测试 | `tests/*.mjs` | 只有 `importer.previewImport()` 的单元用例，**没有任何用例断言该 HTTP 路由的 401/403**（见 §6 测试缺口） |

---

## 3. 阶段 B：认证与会话安全

| 检查项 | 结论 | 证据 |
|---|---|---|
| 口令哈希机制 | ✅ scrypt（N=16384 默认），每口令独立 16 字节随机盐，`timingSafeEqual` 比较，`scrypt$salt$digest` 三段严格校验 | `security.ts:23-36` |
| 用户不存在时的时序 | ✅ 走 `dummyHash`（模块加载时 `hashPassword(randomToken())`） | `security.ts:28-29`、`auth.ts:264` |
| 登录错误文案统一 | ✅ `INVALID_CREDENTIALS = '用户名或密码错误，或账户已停用'`，未知用户/停用/错口令同一文案同一状态 | `auth.ts:23,265-268` |
| 口令不外泄到日志/响应/审计 | ✅ `log.ts` 只记 method/path/status/ms；审计只记 username 与 target；`exportPayload()` 不含 `password_hash`（既有用例 `tests/server.test.mjs:837` 断言） | `log.ts`、`store.ts#audit` |
| 会话 Cookie 属性 | ✅ `HttpOnly; SameSite=Strict; Path=/`，HTTPS 下加 `Secure`；挑战 Cookie 额外 `Max-Age=300`、无 `Domain`；清除时除 `Max-Age` 外属性完全一致 | 探针 **P-I**（全部 true）；`auth.ts:169-182` |
| 令牌强度与服务端存储 | ✅ 32 字节 CSPRNG → 43 字符 base64url；库内只存 `sha256`（探针 **P-K** 断言库内无明文） | `security.ts:18-19`、`auth.ts:194` |
| `__Host-` 前缀 | ⚠️ 未使用（§2.3 为"建议"）→ **SJ-A-06** | 探针 **P-I** `hostPrefix:false` |
| 登出后旧 Cookie 失效 | ✅ 探针 **P-E** `logout=303 旧Cookie 已失效` | `auth.ts:175-178` |
| 改密 / 改角色 / 停用 / 管理员重置因子后旧会话失效 | ✅ 四条全部 `旧Cookie 已失效`（探针 **P-E**） | `store.ts:301-322`、`account.ts:112-172` |
| 角色变更后旧会话**不残留旧权限** | ✅ 会话被删除而非"改角色"；且 `getSession()` 每请求 JOIN `users` 取当前角色，不存在会话内缓存角色 | `auth.ts:46-53` |
| 会话固定 | ✅ 每次登录 `randomToken()` 新令牌，无"复用旧会话 ID"的路径 | `auth.ts:191-199` |
| 旧会话复用 / 并发会话 | ✅ 同账号最多 10 个会话，超出按 `created_at DESC, rowid DESC` 剪除最旧（探针 **P-K**：12 次登录后 10 行、最旧失效、最新有效） | `auth.ts:196-197` |
| 会话过期 | ✅ 8 小时绝对过期，无滑动续期；`createSession` 顺带清理全局过期行 | `auth.ts:14,193` |
| 登录失败计数 vs 成功 | ✅ 成功零消耗；TOTP 成功后 `resetLimit` 只清 `login-user`/`totp-user`（恢复码额外清 `totp-recovery-user`），**不清客户端桶** | `auth.ts:295,432-433,441-443` |
| 账号级 / 客户端级 / 站点级是否分层 | ⚠️ 口令路径分层正确；**TOTP 路径不结算 `login-site`** → **SJ-A-04** | 探针 **P-B** vs **P-B3** |
| 账号层耗尽的语义 | ⚠️ 实现拒绝该账号**全部**尝试（含正确口令）→ **SJ-A-01** | 探针 **P-A** |
| 错误响应是否泄露账号存在性 | ✅ 429 文案不区分账号存在/被锁；401 文案统一；`Retry-After` 由 `reset_at - now` 算出（探针 **P-A** 得 900s，与 15 分钟窗口一致） | `security.ts:93`、`http.ts:94-97` |

---

## 4. 阶段 C：TOTP 与恢复码

| 检查项 | 结论 | 证据 |
|---|---|---|
| 算法与窗口 | ✅ HMAC-SHA1 / 6 位 / 30s / 窗口 ±1；`verifyTotp` 固定跑完 3 个候选再返回（不提前 return，避免按档位侧信道） | `totp.ts:94-105` |
| 一次性（窗口内重放） | ✅ `isFreshStep` 预检 + 事务内条件更新 `totp_last_step < ?` 双保险。探针 **P-D**：同一步验证码首次 `ok`、再次 `401` | `totp.ts:108`、`auth.ts:370-373` |
| 恢复码一次性 | ✅ 条件更新 `used_at IS NULL`，`changes !== 1` 即拒绝。探针 **P-D2**：首次 `ok`、再次 `401`；既有用例 `恢复码只能用一次` | `auth.ts:375-377` |
| 并发同码 | ✅ 既有用例 `并发：两个挑战提交同一步验证码，只有一个成功`、`并发：两个 enroll 挑战只有一个能安装因子` | `tests/totp-server.test.mjs` |
| 挑战绑定 | ✅ 绑定 `user_id` + `purpose` + `auth_version` + `client_hash` + `expires_at(5min)` + `attempts(≤5)`；`assertChallengeUsable` 逐项校验 | `auth.ts:340-346` |
| 无"半认证会话" | ✅ 第一步只发挑战 Cookie，不签发会话；`getSession()` 只代表完全认证 | 探针 **P-F** 匿名 `/api/manage/` = 401；`tests/totp-server.test.mjs#已启用：第一步只给挑战` |
| 跨客户端挑战被拒 | ✅ `challenge.client_hash !== clientHashFor(client)` → 401 | `auth.ts:345` |
| 失败预算按输入形状分桶 | ✅ 6 位数字 → `totp-user`；恢复码 → `totp-recovery-user`；共用客户端桶。**用命名常量而非数组下标**（P1 已修） | `auth.ts:412-417` |
| 失败结算不随业务回滚 | ✅ `settleChallengeFailure` 用独立短事务；`fail(429)` 与 `fail(401)` 在结算之后 | `auth.ts:314-338` |
| 挑战容量上限 | ✅ 每用户最多 3 个未消费挑战，超出 429 且**不**自动作废他人浏览器正在使用的挑战 | `auth.ts:229-232` |
| 密钥密封 | ✅ AES-256-GCM / 12B IV / 16B tag / AAD=`user:<id>` / `v1:iv:tag:ct`；`openSecret` 严格校验格式；缺失或非法 → 503 fail-closed | `totp.ts:148-191` |
| 二维码 | ✅ 服务端生成 SVG，issuer 与账号来自服务端（实例冻结）；客户端不能提供 secret/账号/参数；页面 `no-store` + `noindex`；既有用例用独立解码器还原 URI 后走真实接口 | `auth.ts:465-496`、`http.ts:472-475` |
| 恢复码只存哈希 | ✅ `sha256("<user_id>:<normalized>")`，40 bit 随机，`XXXX-XXXX` | `totp.ts:126-142` |
| 撤销矩阵 | ✅ 启停/重置/重生成/改密/改角色/停用/策略切换均 `auth_version+1` + `revokeAuthProofs` 清会话/挑战/恢复码 | `store.ts:104-113`、`account.ts` 全文 |
| 管理员不得重置自己 | ✅ `if (current.id === targetId) fail(400, ...)` | `account.ts:160` |
| 策略非法不降级 | ✅ `totpPolicy().valid === false` → 503；`POLICY_VALUES` 只有三个合法值 | `auth.ts:95-118` |
| **新鲜证明无失败预算** | ❌ **SJ-A-02** | 探针 **P-C1/C2/C3** |
| **TOTP 失败不结算站点熔断** | ❌ **SJ-A-04** | 探针 **P-B** |
| **未知 token 计入共享账号桶** | ⚠️ **SJ-A-05** | `auth.ts:397,509` |

---

## 5. 阶段 D / E / F / G

### 5.1 阶段 D — 角色授权与对象级访问控制

| 检查项 | 结论 | 证据 |
|---|---|---|
| 服务端是否为每个敏感操作判权（不靠前端隐藏） | ✅ 38 个动作全部过 `requireManagePermission`；页面按钮只是体验层 | §2.2 |
| `MANAGE_ACTION_ROLES` 覆盖面 | ✅ 与 `managePost` 的 `switch` 分支一一对应，无遗漏分支 | 对照 `http.ts:129-168` 与 `198-440` |
| 未知动作 fail-closed | ✅ 400 `未知管理操作`（探针 **P-G**） | `http.ts:172-173,439` |
| 守卫是否早于动作专属参数校验 | ✅ `requireCsrf` → `requireManagePermission` → `switch`。编辑者对 27 个管理员动作提交**空参数**全部 403（探针 **P-G**），未出现 400/409 泄漏差异化 | 探针 **P-G**；既有用例 `每个管理动作先判权限再做参数校验` |
| 对象级授权（反馈↔修订） | ✅ `revisionId` 必须属于该反馈关联的资源 | `store.ts:361-365`、既有用例 `feedback can link to a revision of its own resource only` |
| 对象级授权（跨用户/跨租户） | 单租户站点，无跨用户对象；所有条目对所有维护者可见，既是设计也已在 `README` 能力矩阵中写明 | — |
| 发布 / 撤回 / 删除 / 停用 / 回收站 / 彻底删除 / 导入 / 导出 / 审计 | ✅ 逐项 `admin`（§2.2）+ 模块内二次复查 | 探针 **P-L**（导出、健康详情） |
| 媒体权限动作拆分 | ✅ 编辑者可上传、不可下架/恢复/彻底删除 | `media.ts:474/499/526` |
| 不同路径/方法/尾斜杠绕过 | ✅ 管理写操作只有 `/api/manage/` 一个 POST 入口，全部走同一链；`trailingSlash: 'always'` 下无第二形态 | `astro.config.mjs`、§2.2 |
| 权限检查与副作用之间的竞态 | ✅ 权限与业务在同一 `BEGIN IMMEDIATE` 事务内，且业务前 `actorUser` 重读角色与 `active` | `db.ts:32-37`、`store.ts:93-99` |
| 版本约束（防旧表单覆盖） | ✅ 带 `version` 的写操作全部 409 而非覆盖；`uid` + 墓碑保证版本号永不复用 | `store.ts:115-125,31-38`；既有用例 `a stale page cannot save or publish a recreated entity` |

### 5.2 阶段 E — CSRF、Origin 与浏览器会话

| 端点 | 无 Origin | 跨站 Origin | 异端口 | 尾斜杠 Origin | `Sec-Fetch-Site: cross-site` | 缺 CSRF | 借用他人 CSRF | 正向对照 |
|---|---|---|---|---|---|---|---|---|
| `/api/manage/` | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 303 |
| `/api/preview/` | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 |
| `/api/logout/` | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 303 |

匿名（无 Cookie）提交上述三者 → 全部 401（探针 **P-F**）。

- ✅ `requireOrigin` 用 `SITE_URL`（生产未配置即 503，不伪装成来源校验失败）；`Origin` 缺失直接拒绝；`Sec-Fetch-Site` 存在时必须是 `same-origin`/`none`。
- ✅ CSRF = `sha256("csrf:" + 会话令牌)`，与 `timingSafeEqual` 比较且先比长度；只有持有 HttpOnly 会话者能算出 → 不可被跨站推导。
- ✅ `SameSite=Strict` 是**附加**层而非唯一防护（Origin + CSRF 均在服务端强制）。
- ✅ GET 无状态变更：`/api/export/` 只读；`/media/` 只读；页面 GET 只渲染。
- ✅ 登录 / 登出 / 口令变更 / TOTP 配置 / 媒体 / 管理动作全部纳入同一条 Origin 链（`loginPost`、`totpPost`、`enrollPost`、`reportsPost`、`eventPost` 各自先 `requireOrigin` 或等价同源判断）。

### 5.3 阶段 F — 可信代理、客户端身份与限流

| 检查项 | 结论 | 证据 |
|---|---|---|
| 判据是否可自我验证（不是循环论证） | ✅ 用**代理共享凭据**而非"对端网段"；`clientIdentity` 只做自己能验证的事 | `security.ts:196-221` |
| `TRUST_PROXY=1` + 凭据缺失 | ✅ fail closed：全部 `unverified`，仅站点级预算（探针 **P-H**：轮换 6 个 XFF 全部 303，`reports-client` 桶 0 个，只有 `reports-site`） | `security.ts:203` |
| 凭据不匹配 / 多值 / 缺失 / 非法 / 带端口 | ✅ 全部 `unverified`（既有用例 `client identity trusts a forwarded address only behind a verified proxy` 覆盖 9 种组合） | `security.ts:204-212` |
| `TRUST_PROXY=0` 时转发头 | ✅ 一律忽略并且**连 `clientAddress` 都不采信**（因为适配器会把 XFF 首值写进 `clientAddress`） | `security.ts:215-217` |
| 私有网段容器是否被误当代理 | ✅ 已无网段判据（历史 N-01 的正确修法） | 同上 |
| `client` / `unverified` 语义不混用 | ✅ 判别联合类型，编译期不可混用；`unverified` 永不进入客户端桶 | `security.ts:128-130,236-242` |
| 不可信身份不产生客户端桶 | ✅ 探针 **P-H**；§6.2.1 反向检查通过 | — |
| `Retry-After` 与真实窗口一致 | ✅ 由 `reset_at - now` 计算（探针 **P-A** 手算 900s 与 15 分钟窗一致） | `security.ts:93`、`http.ts:94-97` |
| 登录三维度协同 | ⚠️ 口令路径 ✅；TOTP 路径缺站点层 → **SJ-A-04** | 探针 **P-B** |
| 部署契约一致性 | ✅ `compose` 只绑 `127.0.0.1`；`TRUST_PROXY` 默认 1 且 `TRUST_PROXY_SECRET` 默认空 → 默认即 fail-closed（安全侧偏保守） | `docker-compose.yml:21-28` |

### 5.4 阶段 G — 授权失败与错误处理

| 检查项 | 结论 | 证据 |
|---|---|---|
| 未认证 → 401 | ✅ 三个 API 匿名均为 401 | 探针 **P-F** |
| 已认证但越权 → 403 | ✅ 27 个管理员动作对编辑者全部 403（含空/非法参数） | 探针 **P-G** |
| 参数错误不先触发敏感副作用 | ✅ 授权在参数校验之前；版本校验在写入之前；审计与业务同事务（审计失败整批回滚，既有用例 `audit entries commit together...`、`审计写入失败时因子安装/挑战消费/会话全部回滚`） | §2.2、`tests/totp-server.test.mjs` |
| 错误响应泄露内部细节 | ✅ `/api/manage/` 的非 `HttpError` 一律 500 + `服务暂时不可用，请稍后重试`，只 `console.error(error.name)`；错误页带 `default-src 'none'` CSP | `http.ts:89-105` |
| 错误响应泄露内部细节（例外） | ⚠️ `/api/import/preview/` 回显 `error.message` → **SJ-A-03** | `src/pages/api/import/preview.ts` |
| 失败是否留半成品 | ✅ 逐条目事务；导入失败条目"留在回收站、版本号未前进"（既有用例） | `store.ts#importResource` |
| 审计记录必要事件且不含秘密 | ✅ 审计只记 `actor/action/target/created_at`；`target` 里只出现 id、username、理由文本 | `security.ts:267-269` |
| 异常/事务失败默认拒绝 | ✅ `transaction()` 出错即 `ROLLBACK` 并抛出；`fail-closed` 覆盖密钥缺失、策略非法、库异常（`pingDatabase` → 503） | `db.ts:32-37` |

---

## 6. 本地回归测试矩阵（角色 × 动作 × 状态）

| 测试类别 | 匿名 | 编辑者 | 管理员 | 旧/失效会话 | 非可信代理 |
|---|---|---|---|---|---|
| 读取管理数据（`/admin/*`、`/api/health/detail/`） | 302→登录 / 401 ✅ | 按页面：12 个页面 403 或 302 ✅ | 200 ✅ | 401/302 ✅ | 不改变认证结论 ✅（P-H） |
| 创建/编辑资源（`save-resource`） | 401 ✅ | 允许（草稿）✅ | 允许 ✅ | 401 ✅ | 不绕过限流 ✅ |
| 发布/撤回（`publish`/`unpublish`/`*-guide`） | 401 ✅ | **403** ✅ | 允许 ✅ | 401 ✅ | 不改变授权结论 ✅ |
| 媒体管理（upload / delete / restore / purge） | 401 ✅ | 上传允许、下架/恢复/彻底删除 **403** ✅ | 允许 ✅ | 401 ✅ | 不绕过 `media-upload` 20/h ✅ |
| 账户与 TOTP 管理 | 401 ✅ | 自助 3 项允许、`reset-totp` **403** ✅ | 允许 ✅ | 401 ✅ | ⚠️ 自助路径**无限流**（SJ-A-02） |
| 导入/导出/恢复（`import-apply`、`/api/export/`、回收站） | 401 ✅ | **403** ✅ | 允许 ✅ | 401 ✅ | 不绕过限流 ⚠️ 导入类端点本就无限流（SJ-A-03） |

每个单元的实际状态码、数据库变化与断言出处见 §7 探针输出与 §9 测试清单。测试数据全部在临时数据库，运行后删除。

---

## 7. 定向探针（可复跑）

脚本：[`scripts/probe-auth.mjs`](scripts/probe-auth.mjs)（只读调用 `src/` 导出函数，临时库，无出站请求）
原始输出：[`probe-output.log`](probe-output.log)

| 用例 | 结论 | 关键事实 |
|---|---|---|
| **P-A** 账号层锁定 | REPRODUCED | 第三方客户端 10 次错误口令后：攻击者客户端带**正确**口令=429，合法客户端带正确口令=429，`Retry-After=900s`，`login-user` 计数=10 |
| **P-A2** | — | 账号层耗尽拒绝该账号**全部**尝试，与 §6.1「拒绝该账号的**失败**尝试」表述相反 |
| **P-B** TOTP 失败预算 | DEVIATION | 13 次 TOTP 失败：`totp-user`=10、`totp-client`=10、**`login-site` 无**、`login-user` 无 |
| **P-B3** 对照 | — | 一次**口令**失败立刻产生 `login-site` → 两条路径不一致 |
| **P-C1** 新鲜证明（口令） | REPRODUCED | `begin-totp-enroll` 连续 30 次错误口令 → 状态集合 `[403]`，`rate_limits` 中 enroll/challenge 桶 **0** 个 |
| **P-C2** 新鲜证明（口令 + 验证码） | REPRODUCED | `disable-totp` 30 次错误口令 → `[403]`；再 30 次错误验证码 → `[403]`；因子仍 `enabled`；`rate_limits` 总行数 3（均无关） |
| **P-C3** | RISK | 该路径无失败预算，可无限次尝试当前口令与 6 位验证码 |
| **P-D** TOTP 重放 | ENFORCED | 同一步验证码首次 `ok`、再次 `401` |
| **P-D2** 恢复码重放 | ENFORCED | 首次 `ok`、再次 `401` |
| **P-E** 撤销矩阵 | OBSERVED | logout / 改密 / 降级 / 停用 / 管理员重置他人因子：**旧 Cookie 全部已失效**；重置他人因子后目标因子 `disabled` |
| **P-F** CSRF / Origin 矩阵 | ENFORCED | 见 §5.2 全表；匿名 401 |
| **P-G** 编辑者 × 管理员动作 | ENFORCED | 27 个动作（空参数）全部 403；未知动作 400 |
| **P-H** 不可信身份 | ENFORCED | 轮换 6 个 XFF 全部 303，非站点桶 **0** 行 |
| **P-I** Cookie 契约 | OBSERVED | HttpOnly / SameSite=Strict / Path=/ / Max-Age=300 / 无 Domain / 清除属性一致 / HTTPS 带 Secure；`__Host-` 前缀 **false** |
| **P-K** 会话上限 | ENFORCED | 12 次登录后 10 行；最旧失效；库内无明文令牌 |
| **P-L** 读入口角色边界 | ENFORCED | 导出[匿名 401 / 编辑者 403 / 管理员 200]；健康详情[同] |

---

## 8. 发现清单

> 分级口径：**已证实** = 可复现且有断言/响应/日志；**规范偏差** = 实现与规范不一致但未证明可利用；**疑似** = 有线索未复现；**环境限制** = 无法验证。

### SJ-A-01（Medium；单管理员站点按 High 对待）｜账号层失败预算耗尽后拒绝全部登录尝试，可被未认证第三方持续锁定

1. **编号**：SJ-A-01
2. **风险等级**：Medium（可用性）。仅影响"新登录"，既有会话不受影响；对"唯一管理员"部署（§9.5 明确设想的形态）等价于管理面不可登录 → 视为 High
3. **受影响位置**：`src/server/auth.ts#login`（`enforceLimits(rules)` 位于 `verifyPassword` 之前，第 259-268 行）；`src/server/security.ts#enforceLimits`
4. **触发条件与所需权限**：知道目标用户名即可，**无需任何凭据**
5. **最小复现**：探针 P-A —— 用任意 `client` 身份对 `operator` 提交 10 次错误口令；随后用**正确**口令登录
6. **预期 vs 实际**：§6.1 表列"账号层…耗尽时的行为：**拒绝该账号的失败尝试**"；实际拒绝该账号的**全部**尝试，任何来源、任何客户端都得到 `429 / Retry-After: 900`
7. **证据**：`probe-output.log` P-A 行（`login-user` 计数 10、正确口令 429、`Retry-After=900s`）；`scripts/security-audit.mjs:113-118` 的 `targeted-account-lockout` 已在 HTTP 层把该行为当作**预期**断言
8. **影响与可利用前提**：每 14 分钟 10 个请求即可无限维持锁定；攻击成本极低、无需凭据；恢复需服务器侧操作（`DELETE FROM rate_limits WHERE key='login-user:<sha256(username)>'`，见 `scripts/security-audit.mjs:122`），但该解锁流程**未写入任何运维文档**
9. **根因**：账号桶按"失败"计数（正确），但准入判断在口令校验之前，因此"失败计数"被当成了"账号封禁"。二者语义不同：前者限制猜测速率，后者禁止登录
10. **建议修复（三选一，必须写进规范）**
    - (a) 账号桶只拦**失败**：先 `verifyPassword`，命中则清 `login-user` 并放行（此时账号桶只限制"每窗口 10 次失败"，与 §6.1 字面一致）；**推荐**
    - (b) 改渐进退避（30s → 2m → 10m → 1h）并在每次成功后清零
    - (c) 保留现行为，但在 §4.2 与 §13 登记为**已接受风险/例外**，并在 `docs/operations.md` 写明解锁命令与演练
    - 回归：新增 `第三方 10 次失败后，正确口令在 (a)/(b) 下必须成功`（或对 (c) 增加"文档存在 + 解锁命令可用"的断言）

### SJ-A-02（Medium）｜敏感操作的"新鲜证明"完全没有失败预算：可无限次猜测当前口令与 6 位 TOTP

1. **编号**：SJ-A-02
2. **风险等级**：Medium
3. **受影响位置**：`src/server/account.ts#consumeFreshProof`（`verifyPassword` + `verifyTotp`）、`#verifyFreshPassword`；调用方 `src/server/http.ts` 的 `begin-totp-enroll` / `disable-totp` / `regenerate-recovery` / `reset-totp`
4. **触发条件与所需权限**：持有一个**有效会话**（Cookie 泄漏、共用终端未登出、XSS 之外的会话窃取等）
5. **最小复现**：探针 P-C1 / P-C2（30 次错误口令、30 次错误验证码，全部 403，`rate_limits` 无相关行）
6. **预期 vs 实际**：§6.1 要求账号层"抗口令猜测"、§4.5 要求敏感操作"必须要求新鲜证明"。实际：证明校验**一次都不计数**，也没有任何客户端/账号维度预算
7. **证据**：`probe-output.log` P-C1（状态集合 `[403]`，enroll/challenge 桶 0 个）、P-C2（`[403]`、因子仍 `enabled`、`rate_limits` 总行数 3）；`grep` 显示 `rateLimit(` 的调用点只有 `challenge-*` / `enroll-client` / `linkcheck-user` / `media-upload` / `reports-*` / `event-*`，**不含新鲜证明**
8. **影响与可利用前提**：拿到会话者可以
   - 无限次猜**当前口令**：一旦猜中，即可在会话被撤销后用口令重新登录（若同时能通过 TOTP）；
   - 若口令已知，可无限次猜 **6 位 TOTP** 以调用 `disable-totp` / `regenerate-recovery`，把"临时会话"升级为"移除第二因子后的持久访问"。
   定量（保守估算，未做吞吐压测）：±1 窗口内每步有 3/10⁶ 命中率；`scryptSync` 约 50–100 ms/次，单进程约 10–20 次/秒。按 15 次/秒计，1 小时（120 步）累计命中率约 `1-(1-3e-6)^54000 ≈ 15%`；多进程并行成倍上升（150 次/秒 → 约 80%）。**这使"新鲜证明"从"知道口令才可通过"退化为"有时间就能通过"**
9. **根因**：§4.2 的维度表只覆盖登录与 TOTP 第二步，**没有"再认证"维度**；`consumeFreshProof()` 设计上只负责"证明消费与变更同事务"，把限流留给了调用方，而调用方一个都没做
10. **建议修复**
    - 新增两个具名预算：`proof-user`（5/15min，**仅失败**，键=username）、`proof-client`（30/15min，**仅失败**，键=客户端身份）；`reset-totp` 用**操作者**维度而非目标
    - 在 `consumeFreshProof()` 开头 `enforceLimits([...])`、失败分支 `consumeLimits([...])`，沿用 `settleChallengeFailure` 的"独立短事务结算、不随业务回滚"结构
    - `verifyFreshPassword()` 复用同一预算（它现在完全不接触限流原语）
    - 回归：错误口令/错误验证码各 6 次后必须 429；**正确**证明在预算未耗尽时仍一次成功（避免误伤正常运维）

### SJ-A-03（Low）｜`/api/import/preview/` 的 500 分支回显原始错误文本；授权晚于读体与 CSRF；该路由无限流

1. **编号**：SJ-A-03
2. **风险等级**：Low
3. **受影响位置**：`src/pages/api/import/preview.ts`
4. **触发条件与所需权限**：会话（任一角色）；触发非 `HttpError` 异常需要库忙/解析器异常等条件，本轮**未能稳定构造**
5. **最小复现（顺序问题，可稳定复现）**：任一编辑者会话向该路由提交 4 MiB 表单体 → 服务端在 `requireCsrf` 与角色判定之前完成 `readForm`（上限 `MANAGE_MAX_BYTES` ≈ 5.1 MiB）
6. **预期 vs 实际**：§9.3「生产关闭详细错误；异常只记录 `error.name` 与 request id」、§5/§10「授权先于动作专属参数校验」。实际：`catch` 分支返回 `error instanceof Error ? error.message : '预检失败'`（**500 也回显 message**），且 role 判定在 `readForm` + `requireCsrf` 之后
7. **证据**：源码对照 `src/pages/api/import/preview.ts`（catch 块）vs `src/server/http.ts#errorResponse`（非 `HttpError` → 固定文案 + `console.error(name)`）；`scripts/security-audit.mjs:112` 已把该顺序问题记录为 `unbounded-editor-import-body-before-csrf`
8. **影响与可利用前提**：① 若将来某个 500 的 message 含路径/SQL/主机名，会直接回显给编辑者；② 编辑者（或被盗的编辑者会话）可反复推送 ~5 MiB 请求体触发解析与 zod 校验，而该路由**没有任何限流**；外层应由 Nginx `client_max_body_size` / `limit_req` 兜底（§9.1b）
9. **根因**：该路由绕过了 `http.ts` 的统一错误与授权顺序约定（§10.1"一个功能只有一个权威实现"）
10. **建议修复**：把 role 判定提到 `readForm` 之前（`getSession` → 401/403 → 再读体 → `requireCsrf`）；错误体改为与服务端统一（非 `HttpError` → 固定文案）；加 `import-user` 预算（如 10/h）

### SJ-A-04（Low）｜TOTP / 恢复码失败不参与 `login-site` 站点熔断

1. **编号**：SJ-A-04
2. **风险等级**：Low
3. **受影响位置**：`src/server/auth.ts#settleChallengeFailure`（`clientLimitRules(client, TOTP_CLIENT_BUDGET, null)`，site 传 `null`）；`#verifyLoginChallenge`、`#confirmEnrollment`
4. **触发条件与所需权限**：需要先通过口令拿到挑战（因此攻击者已知口令）；分布式来源
5. **最小复现**：探针 P-B
6. **预期 vs 实际**：§4.2「`login-site` **必须**参与每一次失败结算」「不是可选优化，而是 `unverified` 身份唯一可用的保护层」。实际：13 次 TOTP 失败后 `totp-user`=10、`totp-client`=10，而 `login-site` **不存在**；对照 P-B3 口令失败立即产生 `login-site`
7. **证据**：`probe-output.log` P-B / P-B3
8. **影响与可利用前提**：已启用 TOTP 的账号面对分布式验证码猜测时**缺站点级上限**；仍受账号 10/15min 与（可信身份的）客户端 30/15min 约束；`unverified` 身份则只有账号桶
9. **根因**：TOTP 失败结算时未把站点预算拼进来（口令路径用 `clientLimitRules(client, LOGIN_CLIENT_BUDGET, LOGIN_SITE_BUDGET)`，TOTP 路径用 `... , null`）
10. **建议修复**：向 `settleChallengeFailure` 与 `confirmEnrollment` 传入 `LOGIN_SITE_BUDGET`；或在 §4.2 明确写"TOTP 失败不参与站点熔断"及理由（二选一，不要留空）

### SJ-A-05（Low）｜未知/畸形挑战 token 计入共享的 `totp-user:unknown` 桶

1. **编号**：SJ-A-05　2. **等级**：Low　3. **位置**：`auth.ts:396-397, 508-509`
4. **条件**：无凭据，任意人　5. **复现**：提交任意非法挑战 Cookie + 任意验证码
6. **预期 vs 实际**：§6.2.7「未知/畸形挑战 token 只能计客户端预算，**禁止**根据未验证的 `user_id` 扣某个账号的额度」。实际计入 `{scope:'totp-user', identity:'unknown'}` — 键固定为 `unknown`，**不牵连任何真实账号**，但与字面不一致
7. **证据**：源码；`limitKey('totp-user','unknown')`
8. **影响**：10 次垃圾 token 后"继续提交垃圾 token"返回 429 而非 401——只影响攻击者自己的探测；不可信身份下这甚至是唯一的全局限流
9. **根因**：需要一个"未知凭据"的计数键，复用了账号 scope
10. **建议**：改为独立 scope（如 `totp-garbage`）并在 §6.2 登记；或在规范中承认该共享桶

### SJ-A-06（Low）｜会话 Cookie 未使用 `__Host-` 前缀

§2.3 为"建议"。现状属性全部正确（探针 P-I），仅缺前缀 → 无法靠前缀阻止同站子域覆盖同名 Cookie。本项目单域部署，风险低。建议切换为 `__Host-sanjiang_session` 并同步 `tokenFrom()`、`sessionCookie()` 与相关测试（需一次强制重新登录）。

### SJ-A-07（Informational）｜`consumeLimits()` 忽略 `consumeLimit()` 的 `allowed`

`security.ts:105-107` 只做 `consumeLimit(rule)` 不检查返回值，计数可超过 `maximum`；后续请求的 `enforceLimits()` 会看到超限并 429，语义仍 fail-closed。
`login()` 全程同步（`enforceLimits` 与 `consumeLimits` 之间无 `await`），**单进程内不存在 peek/consume 竞态**；只有多进程共享同一 SQLite 时才可能多放行 ≈写者数 次。建议让 `consumeLimits` 返回最严状态或在注释中写明"计数可短暂超限"是有意为之。

### SJ-A-08（Informational）｜`applyImport()` 用会话角色而非 `actorUser()`

§5「每个写操作必须在服务端重新读取操作者当前角色」。`applyImport` 用 `actor.role`（`src/lib/importer.ts:370`）。实际上 `getSession()` 每请求查库、`MANAGE_ACTION_ROLES` 用的是同一份新鲜角色、逐条 `importResource/importGuide/createCategoryFromImport` 都走 `actorUser()`，因此残余窗口极窄。建议改为 `const current = actorUser(actor, true)`。

---

## 9. 测试命令、退出码与结果

| # | 命令 | 退出码 | 结果 | 覆盖范围 |
|---|---|---|---|---|
| 1 | `node --test tests/server.test.mjs tests/totp.test.mjs tests/totp-server.test.mjs tests/deployment.test.mjs` | 0 | **137 pass / 0 fail**（11.6s） | 授权顺序、角色矩阵、CSRF/Origin、会话撤销、身份判定、TOTP 全链路、并发、审计回滚、部署自检 |
| 2 | `node --test tests/instances.mjs` | 0 | **4 pass / 0 fail**（2.6s） | 构建产物 + 多实例隔离；含"相同用户名仍是两个独立账户，Cookie 不能跨实例使用" |
| 3 | `node --test tests/admin-e2e.mjs` | 0 | **36 pass / 0 fail**（24.0s） | 真实浏览器：登录跳转、编辑者 vs 管理员、TOTP 真实二维码绑定 / 恢复码登录 / 管理员重置 / 强制策略注册、媒体权限、本地草稿隔离 |
| 4 | `node reports/security/2026-10-25-auth-review/scripts/probe-auth.mjs` | 0 | 19 个用例：REPRODUCED 3、OBSERVED 3、DEVIATION 1、CONTROL 3、RISK 1、ENFORCED 8 | §7 全表 |
| 5 | `node scripts/check-dist-freshness.mjs` | 0 | `{"status":"ok"}` | 确认第 2/3 项跑的是当前源码的构建产物 |
| 6 | `git diff --check` | 0 | 无输出 | 工作区一致性 |

**鉴权相关既有用例（本轮复跑，全部通过）**：`管理动作先判权限再做参数校验`、`每个管理动作先判权限再做参数校验`、`不可信身份不会占用访客额度，也无法用 30 次失败锁死登录（SJ-02 回归）`、`站点级熔断达到阈值后拒绝不可信流量，且轮换转发头无法绕过（SJ-01）`、`登录站点熔断达到阈值后拒绝，并保持账号级额度语义`、`client identity trusts a forwarded address only behind a verified proxy`、`登录失败只计失败、客户端互不影响`、`五次失败作废挑战；重新发行不重置账号失败预算`、`过期挑战、用途不符与客户端不符都会被拒绝`、`改密/改角色/停用后旧挑战与旧会话立即失效`、`恢复码只能用一次，且与 TOTP 分桶计数`、`并发：两个挑战提交同一步验证码，只有一个成功`、`并发：两个 enroll 挑战只有一个能安装因子，旧挑战不能覆盖新密钥`、`审计写入失败时因子安装/挑战消费/会话全部回滚`、`登录审计失败同样回滚会话与步数消费`、`非法策略值拒绝认证；off 下不强制注册`、`密钥缺失或状态异常时 fail-closed，不降级为口令登录`。

### 9.1 建议新增的定向测试（本轮只提出，未改业务源码/未加入测试文件）

| 目标 | 用例名（建议） | 断言 |
|---|---|---|
| SJ-A-01 | `第三方失败不得封锁正确口令`（或 `账号锁定已登记为例外且解锁命令可用`） | 他源 10 次失败后，本源**正确口令**返回 303（方案 a/b）；方案 c 则断言文档与脚本存在 |
| SJ-A-02 | `新鲜证明有失败预算` | `begin-totp-enroll`/`disable-totp` 错误口令 6 次后 429；错误验证码 6 次后 429；预算未耗尽时正确证明一次成功 |
| SJ-A-03 | `/api/import/preview/` 路由级授权 | 匿名 401、编辑者 403（且**未**读完 5 MiB 体）、非 `HttpError` 时响应体为固定文案 |
| SJ-A-04 | `TOTP 失败参与站点熔断`（或规范明确不参与） | 阈值次 TOTP 失败后 `login-site` 桶存在；不可信身份仍被站点层收口 |
| SJ-A-05 | `未知挑战 token 不占用账号桶` | 垃圾 token 只产生客户端/垃圾桶键 |
| SJ-A-06 | `会话 Cookie 前缀` | `sessionCookie()` 以 `__Host-` 开头且清除时属性一致 |
| 会话能力 | `退出其他会话可用`（若采纳 §4.3"应"项） | 已登录设备可批量撤销；IP/UA 只存哈希 |

---

## 10. 未覆盖区域与残余风险（不得记为通过）

| 项 | 原因 | 影响 |
|---|---|---|
| 真实反向代理链路（Nginx + `X-Sanjiang-Proxy-Secret` 正常路径） | 需要容器/代理环境；本轮只验证"凭据缺失 → `unverified`"（P-H）与 9 种组合单测 | `TRUST_PROXY=1` + **正确凭据** + 单值 XFF 的端到端行为**未在 HTTP 层复测**；发布前仍建议按 `docs/deploy-docker.md` 做一次真实反代联调 |
| 多进程/多实例共享同一 SQLite 的并发限流语义 | 单机单进程部署形态；本轮未起多实例 | SJ-A-07 的"多写者可多放行 ≈写者数 次"仅为推理，未实测 |
| `npm run check`（`astro check`） | 与本轮鉴权结论无关；`dist` 已是最新，说明类型检查此前通过 | 未在本轮取得新的类型检查证据 |
| `npm test`（全量） | 会执行 `tests/linkcheck.test.mjs` 的真实 DNS / `93.184.216.34` 出站请求，违反方案 §2.5 | 全量绿灯**未在本轮复现**；只复现了 4 个鉴权相关文件 |
| `npm run test:browser` | 需要外部已启动实例（`tests/browser.mjs` 指向固定 BASE） | 公开页渲染回归未跑 |
| `bash scripts/container-smoke.sh` | 需要 `docker build`，会访问镜像仓库 | 容器冒烟未跑（历史 N-03 记录过 registry 抖动） |
| `scripts/security-audit.mjs`（HTTP 自审） | 需固定端口 4321 的运行实例，且会写 `data/security-audit/` | HTTP 层的端到端复核未做；其 `targeted-account-lockout` / `unbounded-editor-import-body-before-csrf` 两项与 SJ-A-01/A-03 直接相关，建议在 §7 修复后专门跑一次 |
| `/api/import/preview/` 匿名/编辑者越权 | 该路由用无扩展名 import（`'../../../server/auth'`），纯 Node ESM 探针无法装载 | 结论来自源码阅读；**路由级越权仍无自动化断言**（见 §9.1） |
| 时钟漂移对 `reset_at` / TOTP 步长的影响 | 未做时钟偏移实验 | 窗口边界行为仅由单测覆盖 |
| 真实用户账号、真实 TOTP 密钥、生产 Cookie | 方案明确排除 | — |

---

## 11. 与规范的偏差清单

| 规范条款 | 要求 | 实现 | 判定 |
|---|---|---|---|
| §6.1 账号层"耗尽时拒绝该账号的**失败**尝试" | 只拒失败 | 拒绝全部尝试（含正确口令） | **偏差**（SJ-A-01） |
| §4.2 "`login-site` **必须**参与每一次失败结算" | TOTP 失败也结算 | TOTP/恢复码失败不结算 | **偏差**（SJ-A-04） |
| §6.2.7 未知 token 只计客户端预算 | 不进账号桶 | 进 `totp-user:unknown` | **偏差（无跨账号影响）**（SJ-A-05） |
| §9.3 "异常只记录 `error.name`" / §3.2 错误页不回显 | 固定文案 | `/api/import/preview/` 回显 `error.message` | **偏差**（SJ-A-03） |
| §5 / §10 "授权先于动作专属参数校验" | 先判权 | 该路由先读 5 MiB 体与 CSRF | **偏差**（SJ-A-03） |
| §2.3 "建议使用 `__Host-` 前缀" | 建议 | 未使用 | **偏离建议项**（SJ-A-06） |
| §4.3 "**应**提供退出其他/全部会话与设备列表" | 应提供 | 未提供 | **偏离建议项**（§2.4） |
| §4.3 "CSRF **应**可轮换" | 应轮换 | 由会话令牌派生，不可轮换 | 规范已注明"现状可接受" |
| §4.2 维度表未覆盖"再认证/新鲜证明" | — | 无预算 | **规范缺口**（SJ-A-02） |
| §5 "写操作重新读取操作者当前角色" | `actorUser()` | `applyImport` 用会话角色 | 轻微偏差（SJ-A-08） |

---

## 12. 修复建议与优先级

| 优先级 | 项 | 动作 | 预计影响面 |
|---|---|---|---|
| **P1（发布前）** | SJ-A-02 | 新增 `proof-user` / `proof-client` 预算并接入 `consumeFreshProof` + `verifyFreshPassword` | `account.ts`、`auth.ts`、`security.ts` 常量、§4.2 规范、1 个新用例 |
| **P1（发布前）** | SJ-A-01 | 决策并落地 (a)/(b)/(c) 之一；选 (c) 则必须写进 §4.2/§13 与运维文档 | `auth.ts#login`、规范、运维文档、1 个新用例 |
| P2 | SJ-A-04 | 站点预算拼进 TOTP 失败结算，或规范显式声明不参与 | `auth.ts`、§4.2 |
| P2 | SJ-A-03 | 授权前移 + 统一错误体 + 导入端点限额 | `src/pages/api/import/preview.ts`、1 个路由级用例 |
| P3 | SJ-A-05 | 独立 `totp-garbage` scope，或规范承认 | `auth.ts` |
| P3 | SJ-A-06 | 换 `__Host-` 前缀（需一次强制重新登录） | `auth.ts`、测试 |
| P3 | §2.4 死代码 / 缺失能力 | 删除或登记 `deleteUser()`；评估"退出全部会话" | `store.ts`、`admin/security.astro` |
| P4 | SJ-A-07 / SJ-A-08 | 注释说明或收紧返回语义；`applyImport` 改用 `actorUser` | 极小 |

---

## 13. 最终报告要回答的三个问题

### 1）哪些鉴权安全属性已被证据支持？

- **认证前置**：口令错误/未知用户/停用账户同一文案同一状态、dummy 校验、`Retry-After` 由数据算出（P-A、单测）。
- **会话生命周期**：logout / 改密 / 改角色 / 停用 / 管理员重置因子五条路径都使旧 Cookie 立即失效（P-E）；同账号 10 会话上限、库内只存哈希（P-K）。
- **Cookie 契约**：`HttpOnly / SameSite=Strict / Path=/ / Max-Age / 无 Domain / HTTPS 下 Secure / 清除属性一致`（P-I）。
- **TOTP 一次性**：同一步验证码、同一恢复码、同一挑战、两个 enroll 都恰好一次成功（P-D / P-D2 + 并发单测）；挑战绑定用户/用途/代次/客户端/有效期/尝试数。
- **CSRF / Origin**：3 个 Cookie 型写端点 × 7 种变体全部拒绝，匿名 401（P-F）；`SameSite` 只是附加层。
- **授权**：38 个管理动作全部过角色映射；编辑者对 27 个管理员动作（含空/非法参数）一律 403、未知动作 400（P-G）；服务端二次复查角色，不依赖前端隐藏。
- **身份与限流分层**：`client` / `unverified` 不混用；不可信身份不产生客户端桶、只吃站点预算（P-H）；伪造转发头（含凭据缺失）无法获得可信身份。
- **失败安全**：密钥缺失/策略非法/库异常 → 503；审计失败与业务一起回滚；错误页不泄露路径/栈/内部信息（`/api/manage/` 路径）。

### 2）哪些缺陷已被复现，哪些只是疑似或规范偏差？

- **已复现（有断言/状态码）**：SJ-A-01（账号锁定，P-A）、SJ-A-02（新鲜证明无预算，P-C1/C2）。
- **规范偏差（未证明可利用）**：SJ-A-03（错误体与授权顺序）、SJ-A-04（TOTP 不结算站点熔断）、SJ-A-05（未知 token 桶）。
- **疑似 / 推理**：SJ-A-07（多进程 peek/consume 窗口，未实测）。
- **信息性**：SJ-A-06（`__Host-`）、SJ-A-08（`applyImport` 角色来源）。
- **未发现**：可绕过角色、跨对象越权、CSRF/Origin 绕过、TOTP/恢复码重放、会话固定、密钥降级、代理身份伪造、错误信息泄露（`/api/manage/` 路径）。

### 3）在不扩大测试范围的前提下，发布前还需要做什么？

1. **决策 SJ-A-01**：要么改成"只拦失败尝试"，要么把"账号可被第三方锁定 15 分钟"写进 §4.2/§13 并给出运维解锁命令与演练记录（当前 `scripts/security-audit.mjs` 已把该行为当预期，但文档里查不到）。
2. **修 SJ-A-02**：给新鲜证明加账号级 + 客户端级失败预算；这是当前最实际的一条"从临时会话到持久接管"路径。
3. **修 SJ-A-03**：把 `/api/import/preview/` 的错误体与授权顺序对齐 `http.ts` 的统一约定，并给导入端点加预算。
4. **对齐 SJ-A-04 的表述与实现**（二选一，不要留空白）。
5. **补 2 个自动化断言**：路由级 `/api/import/preview/` 越权、敏感操作失败预算 —— 目前这两处**完全没有**测试保护。
6. **做一次真实反代联调**（`TRUST_PROXY_SECRET` + 单值 XFF），这是唯一没被本轮 HTTP 级证据覆盖的鉴权前置条件。
7. 已在本轮排除的项（容器冒烟、全量 `npm test`、`security-audit.mjs`、`test:browser`）**不得记为通过**，若要作为发布门禁，需在允许联网/容器的环境单独执行并留日志。

---

## 14. 目录内容

| 文件 | 说明 |
|---|---|
| `README.md` | 本报告 |
| `scripts/probe-auth.mjs` | 定向探针（临时库、无出站请求、可重复运行） |
| `probe-output.log` | 探针原始输出（19 个用例） |

> 本轮**未修改业务源码、未提交、未推送、未部署**。工作区新增内容仅本目录；`git status --short` 只显示 `?? reports/security/2026-10-25-auth-review/`。
