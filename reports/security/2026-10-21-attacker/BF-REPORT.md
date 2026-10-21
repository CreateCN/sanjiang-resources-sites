# 三江资源：暴力式攻击测试（隔离 Docker 环境）

第二轮，2026-10-21 19:17–19:40（北京时间）。基准提交 `135033be93159fcefa23a9a7b7ebb5453613c8ef`，镜像 `sanjiang-attacker:20261021`。与本目录 [REPORT.md](REPORT.md)（攻击者视角黑盒审查）互补：上一轮找"能不能打穿"，本轮量化"能打多快、能打多少、限流能不能绕"。

> **状态（2026-10-21 20:00）**：本报告与 BF-REPORT 的主要问题已修复并验证，改动与数据见 [ROOT-CAUSE-AND-FIX.md](ROOT-CAUSE-AND-FIX.md) §13 与 `evidence-bf/23-fix-verification.json`。

> 后续的暴力式攻击测试见同目录

**没有找到任何能突破登录/反馈配额的绕过路径。** 五条常见绕过思路全部实测失败：

| 绕过思路 | 实测结果 |
|---|---|
| 轮换 `X-Forwarded-For` | 无效。分桶不看客户端写入的 XFF 值（[19-keying.json](evidence-bf/19-keying.json)） |
| 并发竞态（同一账号 40 并发） | 无效。恰好 10 次通过、30 次 429（[20-race.json](evidence-bf/20-race.json)） |
| 并发竞态（同一来源 40 并发反馈） | 无效。恰好 5 次通过、35 次 429 |
| 用户名大小写/空格/Unicode 变体 | 无效。规范化后同一桶 |
| 多来源容器同时打 | 只对"来源桶"有效，账号桶仍按用户名 10 次/15 分钟 |

**但配额内确实打得穿口令，也能把指标打空。** 三条新结论：

1. **BF-01（中）：配额内的弱口令喷洒可行。** 每账号 10 次/15 分钟的额度足以命中"人 memorable"式口令：真实口令放在 10 条字典第 5 位，**第 5 次命中，耗时 0.23 秒**。折算 960 次/账号/天，攻击瓶颈完全由配额而非计算成本决定。
2. **BF-02（中）：匿名指标接口 600 次/小时后可被"打空"，并在此之前批量注入伪造数据。** 1500 次并发写入中 600 次 200、900 次 429；随后 3000 次全部 429。后果是最长 1 小时内全站真实浏览统计被静默丢弃，后台 Top 10 停在攻击者注入的字符串上；写入造成 WAL 从 0.76 MB 涨到 4.1 MB。窗口按源码为 1 小时（`http.ts:263`），`Retry-After` 恒 900 是另一处不一致，详见 [ROOT-CAUSE-AND-FIX.md](ROOT-CAUSE-AND-FIX.md)。
3. **BF-03（低）：账号枚举防护到位。** 响应时间无可用差异（现有账号中位 40.4 ms vs 不存在 38.9 ms，比值 1.04），429 也不泄露存在性——**不存在的用户名同样在它自己的第 11 次尝试被 429**（[25-unknown-bucket.json](evidence-bf/25-unknown-bucket.json)）。

**产能观察（非漏洞）**：单实例约 425–560 rps 上限，50 并发把 p95 压到 351 ms、80 并发压到 685 ms，但零错误；慢连接（30 个半开）对正常请求无影响；1 MiB+ 请求体全部 413。

## 环境与边界

- 专用实例：`sp-*`（8703，喷洒）、`sp2-*`（8713，枚举判定）、`bf-*`（8603 文档配置 / 8604 透传 XFF）、`xf-*`（8643/8644，分桶判定）。全部在独立 Docker 网络 `bf-net` 内，数据卷独立，`SITE_URL` 指向各自前端。
- 账号：`bf-admin/bf-victim/bf-editor`、`xu-a..c`、`sp-admin/sp-victim`、`o-admin` 等，均由文档化 CLI 创建；口令记录在 `/tmp/sj-attacker/bf-runtime.env`（0600），不入库。
- 客户端：宿主机 Python + httpx（异步并发），另用容器作为独立 TCP 来源。所有目标为 `127.0.0.1:86xx/87xx` 或 Docker 网络内服务名，**未触碰任何外部网络、真实第三方或宿主机内网**。
- 限幅：并发上限 80，单轮总请求上限 3000，慢连接仅 30 条、40 秒，压测总时长 < 2 分钟。测试期间宿主 16 核 / 30 GB，应用容器内存峰值 247 MiB。
- 未读源码（延续上一轮约束），结论均为黑盒行为推断。

## BF-01：配额内的弱口令喷洒（已复现）

`sp-*` 实例，目标 `sp-victim`，口令 `Library2026!` 放在 10 条候选的第 5 位，每请求一次即判定：

```
attempt 1 password1234   -> 401
attempt 2 Password2026   -> 401
attempt 3 Sanjiang2026   -> 401
attempt 4 Welcome123456  -> 401
attempt 5 Library2026!   -> 303  ← 命中
```

5 次尝试总耗时 0.23 秒（单次约 46 ms，其中大部分是 scrypt 与服务端处理）。证据 [23-spray-hit.json](evidence-bf/23-spray-hit.json)。

结论与边界：

- 12 字符最小长度 + scrypt 让"经典弱口令表"基本失效（`123456`、`qwerty` 根本无法成为口令）；真正的风险面是**可预测的构造式口令**（品牌名/年份/季节 + 符号），这类口令只要落在攻击者前 10 个候选里就会被命中。
- 吞吐上限由配额决定：每账号 10 次/900 秒 → 960 次/天/账号。攻击者若只想打一个已知管理员账号，一天约 960 次机会；对 6 位以上随机口令仍不可行，对构造式口令则完全可行。
- 未测"命中率 vs 字典规模"的统计分布（需大量实例与长时间窗口），也不声称对任意真实站点口令有同样效果。

## BF-02：匿名指标接口可被批量注入并打空（已复现）

`/api/event/` 无账号门槛，`Origin` 校验通过即可写。1500 次并发（50 并发）：

- 600 次 200，900 次 429；用时 5.71 秒，262.7 请求/秒。
- 紧接着再打 3000 次：**全部 429**（说明该桶在窗口内已耗尽，且不会因高频请求而提前恢复）。
- 库体积：`site.sqlite` 217 KB，`site.sqlite-wal` 从 **758 KB → 4.10 MB**（600 次写入，约 5.6 KB/次）。
- 影响面：页面本身仍 200（首页/详情/反馈页均正常），**损失的是统计与后台指标**；15 分钟内全站"浏览/外跳/零结果搜索"被静默丢弃，Top 10 保留攻击者写入的字符串（后台表格转义显示，无脚本执行）。
- 同一机制还在"另一只桶"上重复一次：文档配置桶耗尽后，经携带 XFF 的前端仍可写 200（[26-event-identity.json](evidence-bf/26-event-identity.json)）——即一次攻击可打空两个桶。

## BF-03：账号枚举防护（未发现 oracle）

- 时间侧信道：现有账号 10 次采样中位 40.4 ms（p10 38.7 / p90 49.6），不存在账号 24 次采样中位 38.9 ms（p10 37.2 / p90 39.9），比值 **1.04**；以两者中位均值为阈值分类，误判率接近随机。结论：不可用于枚举。
- 状态侧信道：对一个**不存在**的用户名连续尝试 11 次，第 11 次同样 429；10 个不同 ghost 名字各 1 次全部 401，第 11 个新 ghost 仍 401（[25-unknown-bucket.json](evidence-bf/25-unknown-bucket.json)）。结论：429 只说明"这个名字的 10 次额度用完了"，与账号是否存在无关。
- 副作用：由于**每个用户名（含不存在）各自有个桶**，攻击者可以用 30 次/窗口的额度为任意名字预填额度（写入限流表），属于低强度写放大，不构成安全问题。

## 限流机制实测画像（本轮补强）

| 维度 | 额度 | 触发点 | 证据 |
|---|---|---|---|
| 每用户名（登录） | 10 次 / 900 s | 第 11 次 429，`Retry-After: 900`；成功登录也计数；不存在的用户名同样单独计数 | [19-keying.json](evidence-bf/19-keying.json)、[24-enum-oracle.json](evidence-bf/24-enum-oracle.json) |
| 每来源（登录） | 30 次 / 900 s | 第 31 次 429；代理后该"来源"= 代理自身 → 全站 | `REPORT.md` ATK-01 |
| 每来源（反馈） | 5 次 / **3600 s** | 第 6 次 429；非法请求也计数；`Retry-After` 恒 900 与实际窗口不符 | [19-keying.json](evidence-bf/19-keying.json)、源码 `http.ts:216` |
| 每来源（指标） | 600 次 / **3600 s** | 前 600 次 200，其后全部 429（未逐次定位第 601 次） | [21-flood.json](evidence-bf/21-flood.json) |
| 并发原子性 | — | 40 并发下恰好放行 10（登录）/ 5（反馈），无超发 | [20-race.json](evidence-bf/20-race.json) |
| 分桶键 | 代理形态（是否携带 XFF） | 客户端 XFF 数值不参与分桶；轮换无效 | [19-keying.json](evidence-bf/19-keying.json) |

## 压力与慢连接（能力画像，非漏洞）

| 场景 | 结果 |
|---|---|
| 基线 `GET /` | p50 4.4 ms |
| `GET /` 50 并发 × 20 s | 8508 请求，0 错误，p50 86 ms / p95 351 ms / p99 563 ms，425 rps |
| `GET /api/health/` 80 并发 × 10 s | 4295 请求，0 错误，p95 685 ms / p99 1524 ms |
| `GET /resources/gimp/` 40 并发 × 15 s | 6801 请求，0 错误，p95 96 ms，453 rps |
| `GET /guides/` 40 并发 × 10 s | 5585 请求，0 错误，p95 220 ms，558 rps |
| 30 条慢连接占位 40 s | 正常请求 p50 3.3 ms / max 5.0 ms（Nginx 吸收，未影响 Node） |
| 20 并发 1 MiB+ 请求体 | 全部 413（Nginx 拒绝，未到应用） |
| 压测后状态 | 容器健康，内存 247 MiB，`/api/health/` 200 |

解读：单实例吞吐约 425–560 rps，p95 在 50–80 并发时劣化一个数量级但**不报错**；页面全部 `no-store`、无缓存层，因此"打满带宽/并发"成本很低，属于容量规划问题而非可修复漏洞。慢连接与超大体量请求已被 Nginx 边界挡住。

## 与上一轮报告的差异（更正）

上一轮 REPORT.md 曾写"透传 `X-Forwarded-For` 时配额身份可被伪造、可无限刷新"，**本轮决定性实验推翻该推断**：伪造同一值 6 次后 429，轮换 4 个不同伪造值仍全部 429。真实机制是"**两种代理形态 → 两只互不相通的共享桶**"（剥离 XFF 一只、携带 XFF 一只），客户端可控的 XFF 数值不参与分桶。上一轮 I7 看到的"伪造后立即 303"其实是第二轮桶尚未消耗，而非绕过成功。原报告与 `evidence/rate-limit-measurements.json` 已同步更正并标注更正记录。

## 修复建议（在上一轮基础上新增）

1. 指标接口加最小化校验与分层配额（按访客较宽、站点级较保守），并把 429 变成可观测事件（计数、告警），避免"全站统计静默丢失"。
2. 指标写入做去重/采样（同一 `target` 窗口内只记一次、超阈值改为采样），把 600 次写入的存储放大压到常数级。
3. 登录配额建议从"每用户名 10 次硬锁"改为"失败计数 + 指数退避 + 验证码"，并对构造式弱口令做在线强度提示；成功登录清零，避免正常运维自锁。
4. 若需要更强的抗爆破：引入 IP + 用户名 + 设备指纹的分层策略，或对管理端启用 2FA（当前无）。
5. 保留现状中做对的部分：并发计数原子、429 不泄露账号存在性、慢连接与大包被 Nginx 拦住。

## 未覆盖

- 未做长时间（>1 小时）持续爆破，未测 900 秒窗口的精确恢复抖动；未测跨窗口的额度累积行为。
- 未做分布式多 IP（真实公网来源）爆破；多来源仅用 Docker 容器模拟。
- 未测验证码/2FA（功能不存在）、未测口令喷洒的统计命中率曲线、未测 DB 长时间写放大的稳态（WAL 是否自动截断）。
- 压测为单机限幅测试，不能作为容量规划结论；未做带宽级 DoS、TLS 层攻击、HTTP/2 或慢 POST 长连接。

## 附件

- 量化数据：[17-enum-timing.json](evidence-bf/17-enum-timing.json)、[18-enum-and-spray.json](evidence-bf/18-enum-and-spray.json)、[19-keying.json](evidence-bf/19-keying.json)、[20-race.json](evidence-bf/20-race.json)、[21-flood.json](evidence-bf/21-flood.json)、[22-load.json](evidence-bf/22-load.json)、[22b-load-expensive.json](evidence-bf/22b-load-expensive.json)、[23-spray-hit.json](evidence-bf/23-spray-hit.json)、[25-unknown-bucket.json](evidence-bf/25-unknown-bucket.json)、[26-event-identity.json](evidence-bf/26-event-identity.json)。
- 前端配置：[nginx-bf-instance.conf](nginx-bf-instance.conf)（8603 文档 / 8604 透传）、[nginx-bf-keying.conf](nginx-bf-keying.conf)（8643/8644 分桶判定）、[nginx-bf-spray.conf](nginx-bf-spray.conf)（8703 弱口令喷洒）、[nginx-bf-oracle.conf](nginx-bf-oracle.conf)（8713 枚举判定）。
- 日志：[nginx-bf-access.log.gz](nginx-bf-access.log.gz)（8603/8604）、[nginx-bf-spray-access.log](nginx-bf-spray-access.log)（8703 喷洒）、[nginx-bf-oracle-access.log](nginx-bf-oracle-access.log)（8713 枚举判定）、[app-runtime-bf.log.gz](app-runtime-bf.log.gz)。
- 脚本：`scripts/17_enum_timing.py` … `scripts/22_load.py`（本轮新写，含限幅参数）。

**当前状态**：暴力测试实例保留 `bf-app` / `bf-nginx`（`127.0.0.1:8603` 文档配置、`127.0.0.1:8604` 透传），数据卷 `bf-data`；其指标与反馈桶已耗尽、部分账号处于锁定状态，属于**受污染环境，仅供复核**。`sp-*`、`sp2-*`、`xf-*` 实例及其卷已删除。主审查实例 `sanjiang-atk-app/nginx`（8443/8080）仍在运行。清理：`docker rm -f bf-app bf-nginx && docker volume rm bf-data && docker network rm bf-net`。
