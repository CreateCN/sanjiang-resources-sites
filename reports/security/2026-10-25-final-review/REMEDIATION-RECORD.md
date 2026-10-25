# 终审后修复记录（P1 + 两项 P2）

依据：[REMEDIATION-PLAN.md](REMEDIATION-PLAN.md)（2026-10-25 终审后修复方案）。
基准提交：`37ed44c74a723290f03b53bb2025617a9d00042c`；执行时工作区含上一轮全部未提交修改，本轮**未 commit、未 push、未部署**。
原报告 [README.md](README.md) 与 `/tmp/sanjiang-local-security-report.md` 均未覆盖。

---

## 0. 结论

| 项 | 状态 | 一句话 |
|---|---|---|
| **P1** 不可信身份下恢复码失败不计数（HTTP 500） | **已修复，已复现前后差异** | 规则改为具名常量；修复前 4 次提交全是 **500**，修复后 `401,401,401,429`，挑战 `attempts` 1→3 |
| **P2-1** `deploy:check --strict` 未兑现升级契约 | **已修复** | `report()` 统一把 `warn` 升级为 `error`（带 `raised: true`）；矩阵测试覆盖 4 组配置 × 2 模式 |
| **P2-2** 部署文档未同步凭据模型 | **已完成** | `deploy-local` / `deploy-docker` / `FEATURES` / `SECURITY-SPEC` 四处均改为凭据模型，并处理 nginx `proxy_set_header` 的整组继承陷阱 |
| 执行环境"子进程输出为空" | **已调查，未能复现；已消除该失败模式** | 400 次串行 + 60 次并发 spawn 均正常；部署自检的判定矩阵改为**进程内调用**，不再依赖子进程；CLI 契约单独覆盖且失败信息带诊断，见 §5 |

终审的验收结论**不变**：仍是**有条件通过**——本记录只关闭了 P1/P2，发布前仍需满足终审 §11 的四条部署条件（见 §8）。

---

## 1. P1：恢复码失败在不可信身份下抛异常、不计数

### 根因

`verifyLoginChallenge()` 用"客户端规则 + 账号规则"拼出数组后**按下标**取账号规则：

```ts
const rules = [totpUserRule, ...clientLimitRules(client, TOTP_CLIENT_BUDGET, null)];
if (input.kind === 'recovery') rules.push(recoveryRule);
const accountRule = input.kind === 'recovery' ? rules[2]! : rules[0]!;
```

`clientLimitRules()` 对 `unverified` 身份返回**空数组**（设计如此：不可信身份不建访客桶），
于是恢复码分支下 `rules = [totp-user, totp-recovery-user]`，`rules[2]` 是 `undefined`。
`settleChallengeFailure(..., undefined)` 在 `consumeLimit(rule)` 处抛
`TypeError: Cannot read properties of undefined (reading 'scope')` → HTTP 500，
**挑战尝试次数与恢复码失败额度都不增加**，攻击者拿到有效挑战后可在有效期内持续猜恢复码。

### 修复

`src/server/auth.ts`：把两条账号规则提升为具名常量，按输入形状直接选择，不再依赖数组下标。

```ts
const totpAccountRule: LimitRule = { scope: 'totp-user', … };
const recoveryAccountRule: LimitRule = { scope: 'totp-recovery-user', … };
const rules: LimitRule[] = [totpAccountRule, ...clientLimitRules(client, TOTP_CLIENT_BUDGET, null)];
if (input!.kind === 'recovery') rules.push(recoveryAccountRule);
enforceLimits(rules);
const accountRule = input!.kind === 'recovery' ? recoveryAccountRule : totpAccountRule;
```

`settleChallengeFailure()` 的第三个参数类型由内联对象收紧为 `LimitRule`；失败结算事务、
成功消费恢复码事务、账号/客户端预算、以及"不可信身份不建客户端桶"的语义全部未动。

### 复现前后（同一场景，`unverified` 身份，格式合法的错误恢复码 `AAAA-BBBB`）

| | 第 1–4 次 HTTP 状态 | 挑战 `attempts` | `totp-recovery-user` | `totp-user` |
|---|---|---|---|---|
| 修复前（临时回退两行） | `500, 500, 500, 500` | 0 | 无桶 | 无桶 |
| 修复后 | `401, 401, 401, 429`（第 4 次 `Retry-After: 3600`） | 1→2→3，第 4 次不再推进 | 1→2→3 | 0（不受影响） |

修复前的 500 是"临时把 `rules[2]!` 改回去"跑同一测试得到的，不是推断。

### 新增回归（`tests/totp-server.test.mjs` 3 项 + `tests/server.test.mjs` 1 项）

| 用例 | 断言要点 |
|---|---|
| 不可信身份下错误恢复码会计入额度、推进挑战尝试，且不会 500 | 3 次 401 时 `(恢复码桶, attempts) = (1,1)(2,2)(3,3)`；第 4 次 429 且 attempts 不增（窗口不因攻击请求延长）；`totp-user` 与 `totp-client` 均无桶 |
| 可信身份下错误恢复码同样计入客户端桶 | 可信身份额外产生 `totp-client` 桶；`totp-user` 不变 |
| 不可信身份下正确恢复码仍可登录一次，复用被拒绝 | 正向路径不被修复破坏；成功不消耗失败额度；`used_at` 只 1 条 |
| **HTTP 层**：不可信身份走真实 `/api/login/` + `/api/login/totp/` | 先断言 `clientIdentity()` 确实是 `unverified`；再断言 `401,401,401,429`、`Retry-After ∈ (0,3600]`、attempts=3、无 `totp-client` 桶 |

（前三个用例先写过一次失败：暴露了测试本身把身份双包装的问题；已修正为与既有 helper 一致的传参方式，断言未放宽。）

---

## 2. P2-1：`--strict` 未兑现"警告升级为错误"

### 根因

`site-url-not-https` 在调用点硬编码为 `'warn'`，而升级只看另一处分支的 `strict ? 'error' : 'warn'`。
于是"生产站点仍用 http + `--strict`"输出 `status: ok`、退出码 0。

### 修复（`scripts/check-deployment.mjs`）

```ts
function report(level, code, message) {
  const raised = strict && level === 'warn';
  findings.push({ level: raised ? 'error' : level, code, message, ...(raised ? { raised: true } : {}) });
}
```

调用点只表达原始等级（`report('warn', …)`）；`status` 与退出码继续从转换后的 findings 计算，
没有第二套失败判断。被升级的条目带 `raised: true`，运维能区分"本来就是错误"与"严格模式下才算错误"。

### 矩阵验证（`tests/deployment.test.mjs`，断言等级 + `status` + `strict` + 退出码）

| 配置 | 普通 | `--strict` |
|---|---|---|
| production、HTTPS、凭据齐全 | ok / exit 0 | ok / exit 0 |
| production、**HTTP**、凭据齐全 | warn / exit 0 | **error / exit 1**（`raised: true`）|
| 凭据缺失 | error / exit 1 | error / exit 1（不是升级项）|
| 凭据过短 | error / exit 1 | error / exit 1 |
| 直连部署转发头提示 | warn / exit 0 | error / exit 1（`raised: true`）|
| `SITE_URL` 缺失 | error / exit 1 | error / exit 1 |

---

## 3. P2-2：文档与实现同步

| 文件 | 改动 |
|---|---|
| `docs/deploy-local.md` | 环境文件示例加入 `TRUST_PROXY_SECRET`（并注明该文件因此含密钥、保持 640）；变量表新增一行；Nginx 示例加入 `include …/sanjiang-proxy-secret.conf` 与"凭据单独落盘 600"的命令；上线清单加入 `check-deployment --strict` 与"空 `login-client` = 凭据/头没配对"的判读；安全注意事项补凭据轮换与"不进日志/备份" |
| `docs/deploy-docker.md` | Nginx 示例把 `proxy_set_header` 提到 server 级并显式警告 **nginx 是整组继承**（location 里写任意一条就会覆盖整组）；加入 `/media/` 示例与凭据 include；compose 片段挂载 `proxy-secret.conf`；补充 `--strict` 与 `raised` 说明 |
| `docs/FEATURES.md` | 健康检查改为"只返回 `status`/`db`，详细诊断在 `/api/health/detail/`（管理员）"；限流说明补凭据要求与不可信身份的降级行为（只吃站点级预算） |
| `docs/SECURITY-SPEC.md` | 必测矩阵删除已删除的 CIDR 机制与 `tests/trusted-proxy.test.mjs` 引用，改为现行凭据模型的实际测试路径；§4.2 增补"失败预算必须具名规则、禁止数组下标"；部署自检一行补 strict 矩阵；变更记录加 1.8 |
| `docs/edge-cdn-hardening.md` | Caddy 示例的凭据改用占位值（不再暗示可读环境变量）|

所有示例均为占位值，未写入真实凭据。

### 3.1 复审追加（2026-10-25 第二轮）：`deploy-local.md` 两处 P2

| 问题 | 原写法 | 修复 |
|---|---|---|
| **凭据进入 sudo 审计日志 / 进程列表** | `sudo sh -c "printf … '$PROXY_SECRET'"`：`$PROXY_SECRET` 在调用 sudo 前被展开，成为 sudo 的命令参数（sudoers `log_input`、审计记录、`ps -ef` 可见） | 改为**经 stdin 传入**：`printf … "$PROXY_SECRET" \| sudo sh -c 'umask 077 && cat > /etc/nginx/snippets/sanjiang-proxy-secret.conf'`。sudo 只执行固定命令，文件由 root 侧 `umask 077` 以 0600 创建；并补了 `ls -l` / `grep -c` 两条核对命令。若 sudoers 开了 `log_input`（stdin 也会被记录），文档给出 `sudo -e` 或配置管理工具落盘的替代路径 |
| **Caddy 等价配置缺凭据头** | 只有 `X-Forwarded-For` / `X-Real-IP`，照抄会全部退化为站点级限流 | 补 `header_up X-Sanjiang-Proxy-Secret "<同一凭据>"`，并说明 `{env.…}` 形式要求变量在 **caddy 进程**环境里，另提示凭据生成用 `openssl rand -hex 32`（只含 0-9a-f，不会与 nginx 引号冲突） |

---

## 4. 变更文件（本轮新增/修改）

```
src/server/auth.ts                      P1 规则选择 + LimitRule 类型
src/server/http.ts                      注释（不再提"对端地址"判定）
scripts/check-deployment.mjs            strict 统一升级
docs/deploy-local.md / deploy-docker.md / FEATURES.md / SECURITY-SPEC.md / edge-cdn-hardening.md   文档同步
tests/totp-server.test.mjs              P1 回归 ×3
tests/server.test.mjs                   P1 HTTP 回归 ×1
tests/deployment.test.mjs               strict 矩阵重写（5 项）
tests/restore-failure.test.mjs / backup-site.test.mjs / instances.mjs / admin-e2e.mjs   子进程失败诊断
tests/fixtures/child-report.mjs         新增：子进程失败诊断（不重试、不改断言）
```

---

## 5. 关于"子进程输出为空"（终审在他机观察到的失败）

- **本机无法复现**：400 次串行 `spawnSync` + 60 次并发带大输出的子进程，0 次失败、0 次 `error`；
  三个相关套件连续跑 3 轮均 122/122。故**不能**把该失败归因于代码或用例。
- **可诊断性已补**：`tests/fixtures/child-report.mjs` 在"状态非 0 且 stderr 为空"时补写
  `spawn error 码 / signal / stdout 尾部 / 超时提示`，已接入 `restore-failure`、`backup-site`、
  `instances`、`admin-e2e`、`deployment` 的子进程调用点。
- **第二轮复审后进一步消除该失败模式**：`scripts/check-deployment.mjs` 的判定逻辑导出为
  `evaluateDeployment(env, { strict })`（纯函数），`tests/deployment.test.mjs` 的 4 条判定矩阵
  改为**进程内调用**——即使目标机器无法启动子进程，矩阵也不会再出现 `report=null` 引发的
  5/5 `TypeError`。只剩 2 条 CLI 契约用例仍起子进程（先断言退出码，再断言 JSON 可解析，
  失败信息拼上 `describeChild` 的完整诊断：`spawn error` / `signal` / stdout 尾部）。
  CLI 入口用 `realpath(argv[1]) === realpath(import.meta.url)` 守卫，被测试 import 时不会自启动。
- **没有做的**：没有加自动重试、没有放宽任何断言、没有把未复现的失败记为通过。
  若在目标环境复现，报错会直接给出 `error.code`（EAGAIN/ENOMEM 等）或信号，据此判断是资源竞争
  还是用例问题；判定逻辑本身已被进程内矩阵独立证明正确。

---

## 6. 命令与结果（本轮实际执行，构建早于使用 dist 的测试）

| 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| `node --test tests/totp-server.test.mjs tests/server.test.mjs tests/deployment.test.mjs`（定向，第二轮复审后） | 0 | **124 / 124** | `/tmp/sj5-directed.log` |
| `npm run check` | 0 | 164 文件，0 error / 0 warning / 0 hint | `/tmp/sj-r-check.log` |
| `npm test` | 0 | **291** tests，290 pass，0 fail，**1 skipped** | `/tmp/sj5-test.log` |
| `npm run build` | 0 | Astro check + build + 资源裁剪成功 | `/tmp/sj5-build.log` |
| `node scripts/check-dist-freshness.mjs` | 0 | dist 不旧于源码 | — |
| `npm run test:server` | 0 | **93 / 93** | `/tmp/sj5-server.log` |
| `npm run test:instances` | 0 | 4 / 4 | `/tmp/sj5-instances.log` |
| `npm run test:admin` | 0 | 36 / 36 | `/tmp/sj5-admin.log` |
| `npm run test:browser` | 0 | 10 / 10（先 seed + 起 4321 实例） | `/tmp/sj5-browser.log` |
| `bash scripts/container-smoke.sh`（第二轮，第 1 次） | **1** | `failed to build: … auth.docker.io … TLS handshake timeout`（未产生容器，与代码无关） | `/tmp/sj-r-smoke.log` |
| `bash scripts/container-smoke.sh`（第二轮，第 2 次） | 0 | `container smoke: PASS` | `/tmp/sj-r-smoke2.log` |
| `bash scripts/container-smoke.sh`（第三轮，一次通过） | 0 | `container smoke: PASS` | `/tmp/sj5-smoke.log` |
| `git diff --check` | 0 | 无输出 | — |

测试数变化：284 → 289 → **291**（`totp-server` +3、`server` +1、`deployment` 由 4 条改写为 7 条：4 条进程内矩阵 + 2 条 CLI 契约 + 1 条能力边界）。
跳过项仍是"需 root 绑定 :80 的回环用例"，未伪造通过。

---

## 7. 复核提示（供独立复审使用）

- 恢复码失败路径：`src/server/auth.ts` 中 `verifyLoginChallenge()` 的 `totpAccountRule` /
  `recoveryAccountRule`；`settleChallengeFailure(_, _, account: LimitRule)`。
- 复跑证据：修复前把 `const accountRule = …` 一行改回 `rules[2]!` 即可重现 `500 ×4`；
  判定命令 `node --test --test-name-pattern "不可信身份走 HTTP" tests/server.test.mjs`。
- strict：`scripts/check-deployment.mjs` 的 `report()`；证据
  `NODE_ENV=production SITE_URL=http://… TRUST_PROXY=1 TRUST_PROXY_SECRET=<32> node scripts/check-deployment.mjs --strict` → exit 1、`raised: true`。

---

## 8. 仍未关闭的发布条件（沿用终审 §11）

1. 目标环境配置 `TRUST_PROXY_SECRET` 与反代同名头，`check-deployment --strict` 通过；
2. **真实反代联调**：客户端 A 5 次反馈后第 6 次 429，客户端 B 独立额度，`rate_limits` 出现多个 `reports-client` 键；
   - 第三轮已把这套判据做成**可重复的本地回归**（`npm run acceptance:proxy`，见 §9），
     应用侧行为已用真实套接字验证；目标环境仍需确认**真实反代软件**的配置（同名头、覆盖写 XFF、CDN 回源改写）；
3. 确认 4321 只绑 `127.0.0.1` / 端口映射不外泄；
4. 确认凭据不进 `log_format`、仓库与备份包。

本轮完成 **不等于** 目标环境已验收或已部署。

---

## 9. 第三轮：把"反代联调"从一次性手工验证变成可重复门禁

### 9.1 动机

终审 §11 把"真实反代联调"列为**唯一无法在本地替代**的验证，而 N-01 恰恰是在"没有部署侧联调"时
由单元测试 + 产物级对照给出错误结论的（当时判定"对端网段可信"成立，实际 `@astrojs/node` 把
`X-Forwarded-For` 首值直接塞进 `clientAddress`）。只读配置的自检管不到这段，靠人记着手工 `curl`
也不可重复。因此把它固化为脚本。

### 9.2 新增 `scripts/proxy-acceptance.mjs`（`npm run acceptance:proxy`）

只连 `127.0.0.1`、只跑**真实构建产物**（`dist/server/entry.mjs`），流程：

1. 临时目录建独立数据库，起一个应用实例（`HOST=127.0.0.1`，随机端口，`TRUST_PROXY=1` + 随机 32 字节凭据）；
2. 起本地反代替身，做与部署文档要求**同样的三件事**：覆盖写 `X-Forwarded-For`/`X-Real-IP`、
   丢弃客户端自带的 `X-Sanjiang-Proxy-Secret`、注入正确凭据；
3. 判据 11 项（任一失败即 `status: fail`、退出码 1）：

| # | code | 判据 |
|---|---|---|
| 1 | `build-present` | 存在 `dist/server/entry.mjs`（不跑源码态） |
| 2 | `app-ready` | 应用在 30s 内 `/api/health/` 返回 200 |
| 3 | `client-a-budget` | 客户端 A 6 次提交 = `303×5, 429` |
| 4 | `client-b-independent` | 客户端 B 仍有独立额度（`303, 303`） |
| 5 | `two-client-buckets` | `rate_limits` 出现 **2 个** `reports-client` 键（不是 1 个共享访客桶） |
| 6 | `keys-are-hashed` | 键里没有明文本机地址 |
| 7 | `no-client-bucket-without-secret` | 直连应用端口伪造 XFF 14 次（无凭据/错凭据/有凭据无 XFF）→ `reports-client` 键 **0** 个 |
| 8 | `site-budget-still-counts` | 上述 14 次全部计入站点桶（上限 14，不是 429） |
| 9 | `secret-not-in-logs` | 应用进程输出里没有凭据 |
| 10 | `secret-not-in-database` | 数据库文件与 WAL 里没有凭据 |
| 11 | `listen-loopback-only` | `ss` 显示只监听 `127.0.0.1:PORT`；没有 `ss` 时记 `skipped`（不假装检测过） |

细节：直连伪造的那组请求带**正确**的 `Origin`——否则会在 Origin 校验处就 403，根本走不到限流分支，
"没有访客桶"就成了假证据（第一版脚本正是踩了这个坑：14 次全 403、站点桶计数 0，被第 8 项判据抓出来）。

### 9.3 有效性证明（变异测试，不是"跑绿了就算数"）

| 变异 | 位置 | 结果 |
|---|---|---|
| 反代**忘记**注入凭据 | `scripts/proxy-acceptance.mjs` 的代理层 | `status: fail`；`client-a-budget` 变成 `303×6`（第 6 次不再 429）、`two-client-buckets` 变成 0 个键——即 fail closed 到站点级限流的真实表现 |
| 回到 N-01 的做法（不校验凭据只信 XFF） | `src/server/security.ts` 的 `clientIdentity()` | `status: fail`；`no-client-bucket-without-secret` 报"直连伪造 14 次产生 `reports-client` 键 **11** 个"——正是终审 N-01 的绕过形态 |

两处变异均已还原（`git diff` 中无 `MUTATION` 标记），还原后重建并复跑：11/11 通过、退出码 0。

### 9.4 边界（不夸大）

- 反代是**替身**：真实 nginx/Caddy 的 `proxy_set_header` 继承陷阱、CDN 回源改写、`log_format`、
  端口发布与容器网络，本地一律测不到，仍按 §8 的第 2～4 条由运维在目标环境确认；
- 不并入 `npm test`：它需要构建产物与空闲端口，属发布门禁而非单元测试；已挂
  `preacceptance:proxy → check-dist-freshness`，避免拿旧 `dist` 出假结论；
- 文档入口：`docs/deploy-local.md` §10 第 4b 项、`docs/deploy-docker.md` §12。

### 9.5 第三轮实际执行

| 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| `npm run build`（变异还原后重建） | 0 | Astro check + build + 资源裁剪成功 | `/tmp/sj5-restore-build.log` |
| `node scripts/proxy-acceptance.mjs`（还原后） | 0 | `status: ok`，11/11 | `/tmp/sj5-proxy-acceptance-after.json` |
| 变异：代理不注入凭据 | 1 | 11 项中 2 项失败（预期） | — |
| 变异：`clientIdentity` 不校验凭据 + 重建 | 1 | 11 项中 1 项失败（预期） | `/tmp/sj5-mutation-build.log` |
| `npm run build`（改完 `package.json` 脚本后重建） | 0 | 同上 | `/tmp/sj5-build3.log` |
| `npm run acceptance:proxy` | 0 | `status: ok`，11/11；`preacceptance:proxy` 先跑新鲜度检查 | `/tmp/sj5-acceptance-npm.log` |
| `npm run check` | 0 | 166 文件，0 error / 0 warning | `/tmp/sj5-check3.log` |
| `npm test` | 0 | **291** tests，290 pass，0 fail，**1 skipped**（root :80 用例，未伪造通过） | `/tmp/sj5-test3.log` |
| `npm run test:instances` | 0 | 4 / 4 | `/tmp/sj5-instances3.log` |
| `npm run test:admin` | 0 | 36 / 36 | `/tmp/sj5-admin3.log` |
| `npm run test:browser` | 0 | 10 / 10（先 `seed-site.mjs` 播种 + 起 127.0.0.1:4321 实例） | `/tmp/sj5-browser3.log` |
| `bash scripts/container-smoke.sh` | 0 | `container smoke: PASS` | `/tmp/sj5-smoke3.log` |
| `node scripts/check-dist-freshness.mjs` | 0 | dist 不旧于源码 | — |
| `git diff --check` | 0 | 无输出 | — |

一条**真实发生**的旁证：加完 `npm run acceptance:proxy` 后第一次跑，前置新鲜度检查以 `status: stale`
（`newestSource: package.json`）退出 1，拦住了一次"用旧 `dist` 出绿灯"的机会——这正是该守卫要防的事。

未新增/削弱任何既有测试与断言；`npm test` 用例数不变（291）。

### 9.6 第三轮变更文件

```
scripts/proxy-acceptance.mjs        新增：反代联调门禁（真实套接字，11 项判据）
package.json                        acceptance:proxy / preacceptance:proxy（先查 dist 新鲜度）
docs/deploy-local.md                §10 上线清单新增 4b 项
docs/deploy-docker.md               §12 上线核对新增一条（容器内运行）
reports/security/2026-10-25-final-review/README.md            §12 补记（结论与四条条件不变）
reports/security/2026-10-25-final-review/REMEDIATION-RECORD.md §8 注解 + §9
```

`src/` 下代码**未改动**（变异测试的改动已还原，`git diff` 中无残留）。

---

## 10. 提交前独立复核：修复验收脚本启动失败时的错误成功退出

独立复核发现：`proxy-acceptance.mjs` 在缺少构建产物或应用未就绪时提前 `return`，
跳过末尾的 JSON 汇总与 `process.exitCode`。使用隔离临时项目分别模拟缺 `dist`、
入口 `process.exit(7)`，两种情况原先都无 JSON、退出码 **0**，不能作为可靠门禁。

提交前已修复：

- 将结果输出与退出码设置移到 `main()` 外层，所有提前返回也会输出 `status: fail`、退出 **1**；执行异常退出 **2**。
- 捕获应用子进程的启动错误；健康探测每次最多 1 秒、反馈与代理上游每次最多 5 秒，避免单次请求挂起使总等待期限失效。
- 清理时断开代理连接，并处理应用正常退出与信号退出；临时凭据改用 `randomBytes(32)`。
- 新增 `tests/proxy-acceptance.test.mjs`，在隔离目录使用缺产物、提前退出入口、不响应健康检查入口三个场景，断言失败 JSON 与退出码 **1**。不移动或修改工作区的 `dist`。

本轮重新执行结果（源码与重新构建的产物）：

| 命令 | 结果 | 日志 |
|---|---|---|
| `npm run check` | 167 文件，0 error / 0 warning / 0 hint | `/tmp/sj-push-check.log` |
| `npm test` | **294 tests / 293 pass / 0 fail / 1 skipped**；新增三项失败路径回归通过 | `/tmp/sj-push-test.log` |
| `npm run build` | 退出 0 | `/tmp/sj-push-build.log` |
| `npm run test:instances` | 4/4 | `/tmp/sj-push-instances.log` |
| `npm run test:admin` | 36/36 | `/tmp/sj-push-admin.log` |
| `npm run test:browser` | 10/10；独立临时夹具库与回环实例，测试后清理 | `/tmp/sj-push-browser.log` |
| `npm run acceptance:proxy` | `status: ok`，11/11，退出 0；前置新鲜度检查通过 | `/tmp/sj-push-proxy.log` |
| `bash scripts/container-smoke.sh` | 一次通过，`container smoke: PASS` | `/tmp/sj-push-container.log` |
| `git diff --check` | 无输出 | — |

此前复核中的部署测试子进程空输出已明确诊断为当前沙箱的 `spawnSync EPERM`；
允许本地子进程执行后，部署测试 7/7 通过。本轮上述质量门均在允许所需子进程、回环服务与 Docker 的环境中执行。

本地代码审查与提交门禁通过，可以提交并推送本轮修复。发布结论仍为**有条件通过**，
§8 的目标环境真实反代、端口与凭据检查继续保留；本记录不表示已部署或已完成目标环境验收。
