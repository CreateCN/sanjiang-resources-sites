# 文档索引

本目录是**产品与工程文档**。安全评估的过程记录（报告、证据、脚本）在 [`reports/security/`](../reports/security/README.md)，不是产品文档；两者的边界见本页 §3。

新增或重命名文档后，跑一次 `npm run docs:check`（校验链接、锚点与索引覆盖）。

## 1. 按任务查文档

| 我要… | 读这篇 | 什么时候改 |
|---|---|---|
| 知道现在有哪些功能、哪些不做 | [功能清单](FEATURES.md) | 功能上线/下线、边界变化、已知限制变化 |
| 装起来、跑起来 | [Docker 生产部署](deploy-docker.md) · [非 Docker 部署](deploy-local.md) | Compose 拓扑、端口与源 IP、反代容器、systemd/Nginx |
| 搞清配置项从哪来、谁负责 | [配置与部署边界](configuration.md) | 环境变量、优先级、密钥边界变化 |
| 第一次建站/换库/接管异常库 | [新实例初始化](initialization.md) | Empty/Demo 语义、`site:init` 行为、接管规则变化 |
| 改站点名称与主题 | [实例品牌与主题](branding.md) | 品牌字段、强调色、issuer 与归属开关变化 |
| 放一个静态赞助位 | [静态赞助位](sponsorship.md) | 数据字段、展示条件、URL/媒体校验变化 |
| 决定一条资源该怎样收录、写给谁 | [资源范围与政策](resource-policy.md) | scope/access 语义、审核口径、素材边界变化 |
| 逐条核对旧资源的适用范围 | [原资源 scope 审核清单](resource-scope-review.md) | 审核进度与待确认条目变化 |
| 发布镜像、验签、上线 | [发行与部署](release.md) | 镜像内容、OCI 元数据、digest 与支持范围变化 |
| 定时任务、图片构建、站点备份 | [运维手册](operations.md) | 图片构建、维护进程、Compose 行为变化 |
| 升级、备份、回滚 | [升级、备份与回滚](upgrade.md) | 停写顺序、迁移前置、回滚与硬中断恢复变化 |
| 看一次真实回滚演练 | [升级回滚演练记录](upgrade-rehearsal.md) | 每次演练追加记录（不重写历史） |
| 把站点放到公网、扛 CC/DDoS | [边缘防护（CDN/CC/DDoS）](edge-cdn-hardening.md) | 源站隐身、真实 IP、限流参数、DCDN/WAF 升级与应急预案 |
| 改身份、限流、输入输出、出站请求 | [安全设计与实现规范](SECURITY-SPEC.md) | **先改规范，再改代码**；安全约束变化必须同步评审与测试 |
| 看某个功能当初怎么设计的 | [设计文档索引](design/README.md) | 新功能的设计、取舍与阶段划分变化 |

## 2. 全部文档

**产品与内容（给使用者与维护者）**

- [功能清单](FEATURES.md)：已实现 / 未实现 / 明确不做，以及重新评估的触发条件。
- [资源范围与政策](resource-policy.md)：`scope` 与 `access` 的区别、核验要求、非官方边界。
- [原资源 scope 审核清单](resource-scope-review.md)：升级后仍为 `unknown` 的条目，以及审核口径。
- [实例品牌与主题](branding.md)：品牌属于实例数据、不写代码；字段限制与展示位置。
- [静态赞助位](sponsorship.md)：本地静态广告位的数据、展示规则、安全边界与运维。

**部署与运维（给部署与维护的人）**

- [配置与部署边界](configuration.md)：三层配置、环境变量、`SITE_URL` 与密钥边界。
- [新实例初始化](initialization.md)：状态机、Empty/Demo、异常库诊断与 `--adopt`。
- [Docker 生产部署](deploy-docker.md)：推荐路径；Compose 拓扑、端口与源 IP、反代容器、备份升级。
- [非 Docker 部署](deploy-local.md)：systemd + Nginx 的等价宿主机方案。
- [发行与部署](release.md)：镜像构建、OCI 元数据、固定 digest、支持范围与检查清单。
- [运维手册](operations.md)：图片构建、维护进程、站点级备份恢复与时间配置。
- [升级、备份与回滚](upgrade.md)：停写备份、升级顺序、回滚与硬中断恢复。
- [升级回滚演练记录](upgrade-rehearsal.md)：旧版本 → 候选 → 数据恢复 → 旧版本的实际记录与复现脚本。
- [边缘防护（CDN/CC/DDoS）](edge-cdn-hardening.md)：源站隐身、真实 IP 还原、边缘限流与应急预案。

**工程约束（给写代码与评审的人）**

- [安全设计与实现规范](SECURITY-SPEC.md)：版本化规范；标注「必须」的条款在评审与发布门禁中逐条检查，偏离走其 §13 例外流程。

**设计记录（历史提案与任务书；是否已实现以 FEATURES、代码与测试为准）**

- [设计文档索引](design/README.md)：媒体库、TOTP、产品化任务书与两轮复审记录。

**自动化代理约定**

- [Agent 约定](agents/domain.md)：领域词汇与 ADR 的目录布局（单上下文）。
- [Issue tracker 约定](agents/issue-tracker.md)：用 `gh` 管理 GitHub issue 的具体命令。
- [Triage 标签](agents/triage-labels.md)：五个状态标签与技能里的角色名对照。

## 3. 与本目录之外的分工

| 位置 | 属于什么 | 维护者 |
|---|---|---|
| `README.md` | 项目介绍、快速开始、配置项、部署要点、上线核对 | 产品入口；改动需同步本索引 |
| `AGENTS.md` | 自动化代理的仓库约定（指向本目录与 `docs/agents/`） | 仓库约定 |
| `SECURITY.md` | 漏洞披露渠道与支持版本 | 安全响应 |
| `CONTRIBUTING.md` | 贡献流程与提交规范 | 协作流程 |
| `public/images/CREDITS.md` | 图片版权与下架记录 | 素材合规 |
| `reports/security/` | 安全评估的报告、证据、脚本（过程记录，只追加不重写） | 报告作者 |

## 4. 约定

1. **先改规范，再改代码。** 行为变化涉及安全边界（身份、限流、输入输出、出站请求、响应头）时，先更新 `SECURITY-SPEC.md`，再落实现与测试。
2. **报告只追加，不重写。** 安全评估结论有误时，在原报告内标注「更正」并写日期，同时在 `reports/security/2026-10-21-attacker/ROOT-CAUSE-AND-FIX.md` 的变更记录里登记。
3. **不重复描述同一事实。** README 保留安装与部署入口；功能细节写进 `FEATURES.md`；运维步骤写进 `operations.md`；安全约束写进 `SECURITY-SPEC.md`。
4. **文档里的命令必须可执行。** 示例命令使用占位符（`TARGET`、`DOMAIN`）时，要在同段落说明如何替换。
5. **新文档必须登记。** 在 `docs/` 下新增 `.md` 时同步在本页 §1/§2 加一行；设计文档登记到 `design/README.md`。`npm run docs:check` 会拦住漏登记、失效链接与失效锚点。
6. **文件不随便挪。** 文档路径已出现在 README、报告与外部链接中；确需移动时，同一次改动里更新全部引用，并在旧位置留一句跳转说明。
7. **记录与规范分开放。** 带日期的审查/演练记录留在 `reports/` 或本目录的 `upgrade-rehearsal.md` 这类记录文件里；规范正文只写「现在必须怎样」。
