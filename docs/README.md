# 文档索引

本目录是**产品与工程文档**。安全评估的过程记录（报告、证据、脚本）在 [`reports/security/`](../reports/security/README.md)，不属于产品文档。

| 文档 | 面向 | 什么时候改 |
|---|---|---|
| [功能清单](FEATURES.md) | 使用者、维护者 | 功能上线/下线、边界变化、已知限制变化 |
| [运维手册](operations.md) | 部署与维护的人 | 图片构建、定时任务、Compose 行为变化 |
| [非 Docker 部署](deploy-local.md) | 没有 Docker 的部署者 | 宿主机安装步骤、systemd/Nginx、定时任务变化 |
| [Docker 生产部署](deploy-docker.md) | 用容器的部署者 | Compose 拓扑、端口与源 IP、反代容器、备份升级 |
| [边缘防护（CDN/CC/DDoS）](edge-cdn-hardening.md) | 所有对外部署 | 源站隐身、真实 IP、限流参数、DCDN/WAF 升级与应急预案 |
| [设计提案](design/README.md) | 写代码的人、评审者 | 新功能的设计、取舍与阶段划分变化 |
| [安全设计与实现规范](SECURITY-SPEC.md) | 写代码的人、评审者 | 安全约束变化（必须同步评审与测试） |
| [Agent 约定](agents/domain.md) | 自动化代理 | issue tracker、标签、领域文档约定变化 |

## 约定

1. **先改规范，再改代码。** 行为变化涉及安全边界（身份、限流、输入输出、出站请求、响应头）时，先更新 `SECURITY-SPEC.md`，再落实现与测试。
2. **报告只追加，不重写。** 安全评估结论有误时，在原报告内标注「更正」并写日期，同时在 `reports/security/2026-10-21-attacker/ROOT-CAUSE-AND-FIX.md` 的变更记录里登记。
3. **不重复描述同一事实。** README 保留安装与部署入口；功能细节写进 `FEATURES.md`；运维步骤写进 `operations.md`；安全约束写进 `SECURITY-SPEC.md`。
4. **文档里的命令必须可执行。** 示例命令使用占位符（`TARGET`、`DOMAIN`）时，要在同段落说明如何替换。

## 与根目录文档的分工

- `README.md`：项目介绍、快速开始、配置项、部署要点、上线核对。
- `AGENTS.md`：自动化代理的仓库约定（指向本目录与 `docs/agents/`）。
- `public/images/CREDITS.md`：图片版权与下架记录。
