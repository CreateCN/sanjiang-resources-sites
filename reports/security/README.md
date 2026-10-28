# 安全评估档案

本目录存放本仓库的安全评估产物，**不是产品文档**。产品相关的规范与手册在 [docs/](../../docs/README.md) 下。

## 目录

| 路径 | 内容 | 状态 |
|---|---|---|
| [2026-10-21-blackbox/](2026-10-21-blackbox/REPORT.md) | 早期黑盒审查：本地生产部署 + 攻击者视角（反馈配额共享、账号锁定） | 历史报告；问题已在 2026-10-21 修复 |
| [2026-10-21-isolated-partial/](2026-10-21-isolated-partial/README.md) | 上一轮隔离测试中止前的残留证据（非完整报告） | 仅存档 |
| [2026-10-21-attacker/REPORT.md](2026-10-21-attacker/REPORT.md) | 攻击者视角黑盒审查（部署、限流、授权、注入、SSRF、HTTP 边界） | 结论有效；限流窗口已按源码更正 |
| [2026-10-21-attacker/BF-REPORT.md](2026-10-21-attacker/BF-REPORT.md) | 暴力式攻击测试（配额绕过、弱口令喷洒、指标打空、压力画像） | 结论有效 |
| [2026-10-21-attacker/ROOT-CAUSE-AND-FIX.md](2026-10-21-attacker/ROOT-CAUSE-AND-FIX.md) | 源码级根因 + 修复方案 + §13 实施与验证记录 | 截至 2026-10-21 的权威记录；此后状态见 2026-10-25-fix |
| [2026-10-25-fix/README.md](2026-10-25-fix/README.md) | 本地审查（SJ-01…SJ-12）的修复记录、前后对照与保留项分析 | 修复过程记录；SJ-01 方案已在终审中修正（见终审 N-01）|
| [2026-10-25-final-review/README.md](2026-10-25-final-review/README.md) | 终审：独立代码复核、凭据模型修正（N-01）、发布顺序检查与验收结论 | **当前权威**：发布验收以本文为准 |
| [2026-10-25-final-review/REMEDIATION-PLAN.md](2026-10-25-final-review/REMEDIATION-PLAN.md) / [REMEDIATION-RECORD.md](2026-10-25-final-review/REMEDIATION-RECORD.md) | 终审后 P1（恢复码失败不计数/500）与两项 P2（strict 自检、部署文档）的修复方案与复验记录 | 已实施；发布条件仍见终审 §11 |
| [2026-10-25-auth-review/README.md](2026-10-25-auth-review/README.md) | 本地鉴权审查（SJ-A-01…A-08）：入口—角色—守卫—副作用矩阵、探针 P-A…P-L、规范偏差清单 | 结论有效；其中四个前提已在修复轮被更正，以 `FIX-PROMPT.md` 与 `FIX-RESULT.md` 为准 |
| [2026-10-25-auth-review/FIX-PROMPT.md](2026-10-25-auth-review/FIX-PROMPT.md) / [FIX-RESULT.md](2026-10-25-auth-review/FIX-RESULT.md) | SJ-A-01…A-05 的修复约束、四轮复核意见与修复后证据（`probe-output-after-fix.log`） | **当前权威**：认证/再认证/导入预检的最终行为以本文为准 |
| [TEARDOWN-2026-10-21.md](TEARDOWN-2026-10-21.md) | 早期测试环境撤回记录 | 仅存档 |

## 阅读顺序

1. 需要了解"现在有什么保证"：读 [docs/SECURITY-SPEC.md](../../docs/SECURITY-SPEC.md)。
2. 需要了解"认证与再认证现在到底怎么算"：读 [2026-10-25-auth-review/FIX-RESULT.md](2026-10-25-auth-review/FIX-RESULT.md)；
   规范条款对应 SECURITY-SPEC v1.10 的 §4.2、§4.5、§5、§9.3。
3. 需要了解"修了什么、怎么验证的"：读 [ROOT-CAUSE-AND-FIX.md §13](2026-10-21-attacker/ROOT-CAUSE-AND-FIX.md)
   与 [2026-10-25-final-review/README.md](2026-10-25-final-review/README.md)。
4. 需要了解"当时怎么打的"：读 REPORT / BF-REPORT 及其 `evidence/`。
5. 按目录时间线读：blackbox → attacker → isolated-partial → fix → auth-review → final-review。

## 版本控制范围

只把**报告、脚本、校验和**纳入 git；`evidence/`、`evidence-bf/`、`*.log(.gz)`、`nginx-*.conf`、`*.json/*.txt/*.ndjson` 证据文件由 `.gitignore` 排除，留在本地。

因此：clone 之后 `sha256sum -c SHA256SUMS` 只会校验存在的文件（报告与脚本），缺失条目属于未入库的证据，不是损坏。需要完整证据时在原始评估环境里重新生成，或向维护者索取。

## 证据与校验和

- `evidence/`、`evidence-bf/` 为逐请求证据（响应头、状态码、截断正文、headless Chrome DOM）。会话 Cookie、CSRF 值、回执令牌已脱敏；不含口令、私钥、数据库文件。
- 每个报告目录内的 `SHA256SUMS` 覆盖该目录全部文件；改动任何证据后需重算。
- 大日志压缩为 `.log.gz`（`gzip -dc <file>.gz` 可直接阅读）；报告中的链接指向压缩后的文件名。

## 复跑黑盒脚本

`2026-10-21-attacker/scripts/*.py` 只依赖 Python 3 + `httpx`/`requests`，目标地址与账号通过常量或环境变量指定。复跑前请：

1. 用 `docker compose up -d --build` 起一套隔离实例（`SITE_URL` 指向本地 HTTPS 地址）；
2. 通过 `node scripts/create-admin.mjs` 建测试账号；
3. 按脚本里的 `BASE`/`SITE` 常量改成本地地址；
4. 只对本机或自建环境运行。

## 保留策略

- 报告与根因分析长期保留；证据按需保留，体积过大时优先保留 `.json` 元数据、压缩或裁剪 boilerplate HTML。
- 已修复的问题不再新增独立报告，统一记入 `ROOT-CAUSE-AND-FIX.md` 的变更记录。
