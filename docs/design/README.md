# 设计文档索引

本目录存放功能设计、产品化任务书与评审记录。设计文档描述目标、取舍与交付阶段，是否已实现以 [功能清单](../product/FEATURES.md)、代码与测试为准；P0/P1/P2 是交付顺序，不是漏洞等级。

- 提案阶段只修改文档。评审通过后先将各方案的 SECURITY-SPEC 增补合入规范，再改实现与测试。
- 规范与提案冲突时先消除冲突；不得把未实现条目在 FEATURES 标记完成。
- 稳定决策可升级为 ADR，本目录保留取舍背景。

| 提案 | 状态 | 迁移预留 | 修订重点 |
|---|---|---|---|
| [资料图片上传与媒体库](media-upload.md) | P0 已实现，保留设计记录 | 009-media-library | 不可变文件组、跨进程操作占位、实际容量预留、全量引用保护、实时下架、同批备份恢复 |
| [后台 TOTP 双因素认证](totp-2fa.md) | P0 已实现，保留设计记录 | 010-totp-2fa | QRCode 扫码与验证码确认、Cookie 覆盖 API、auth_version、单次事务兑换、恢复与策略撤销 |

009/010 已按 `migrations` 数组顺序落地，迁移 ID 不复用；旧库升级、全新安装与恢复路径都必须继续测试。

### 产品化与复审记录

| 文档 | 状态 |
|---|---|
| [产品化工程任务书](productization-deepseek-v4.1-flash.md) | P0–P3 已实施，保留任务规格与边界 |
| [第一轮 R01–R06 修复任务书](productization-review-fixes-deepseek-v4.1-flash.md) | R01–R06 已完成并验证，保留验收条件 |
| [第二轮复审与修复计划](productization-review-round2-plan.md) | B01 已修复；N01 待下轮处理；保留原始审查证据 |

## 共享改动与边界

| 位置 | 媒体 | TOTP |
|---|---|---|
| migrations.ts | media、media_tombstones、media_operations、media_store_guard | users 的 auth_version/totp_*、login_challenges、recovery_codes |
| http.ts / store.ts | 上传/下架/恢复/purge 动作；保存、导入、历史恢复、发布的媒体依赖校验 | 登录两步；安全动作；所有人员/认证变更统一撤销 |
| package.json / package-lock.json | 复用现有 sharp | P0 增加服务端 qrcode 及必要开发类型/二维码解码测试依赖 |
| security.ts | 上传/删除限流，复用事务与审计 | 失败与挑战发行的分层限流；复用口令、随机数、哈希与审计 |
| middleware / 部署 | 保留 /media/ 的 no-store，代理/CDN禁缓存，禁止 alias 直出 | 所有秘密与挑战页 no-store/noindex；HTTPS Cookie Secure |
| AdminLayout | P0 最小下架/恢复入口，P1 媒体库/选择 | 账户安全、管理员重置；挑战页使用不要求完整 session 的登录 Layout |
| 备份/恢复工具 | DB+媒体同批、哈希校验、目标保全与恢复日志 | 密钥独立备份、恢复时撤销会话/挑战并轮换恢复码 |
| 配置 | MEDIA_DIR、MEDIA_QUOTA_BYTES、MEDIA_MIN_FREE_BYTES；P1 清理时刻 | TOTP_ENC_KEY、TOTP_REQUIRED_FOR；P1 TOTP_ENC_KEY_OLD |
| 文档与验收 | SECURITY-SPEC、FEATURES、部署/运维、媒体和浏览器回归 | 同左；009/010 安装顺序、旧库升级与恢复回归 |

不得为了任一功能放宽另一功能的默认安全边界：普通表单/内容导入保持各自上限；上传权限不包含恢复下架权限；挑战 Cookie 不等于后台会话。

## 实施顺序与上线门禁

> 以下为原始实施顺序；媒体与 TOTP 的 P0 已完成，P1/P2 仍按同一门禁推进。

1. 先评审并合入 SECURITY-SPEC 增补，保持“拟实现”和“现状覆盖”分开标注。
2. 先做 TOTP。P0 包括 QRCode 生成与扫码验证码确认、两步状态机、版本与撤销、CLI/管理员恢复、策略切换、DB 恢复净化和浏览器验收；全部通过再开放自愿启用。
3. 再做媒体。P0 包括上传/引用/下架、容量与文件所有权、离线对账、DB+媒体备份恢复；恢复演练通过再开放上传。
4. 后续补媒体列表、GC、密钥轮换体验；这些不能代替首批必须具备的恢复能力。

## 采用的产品默认值

| 议题 | 默认值 | 边界 |
|---|---|---|
| 编辑者上传 | 允许 | 只能上传/复用正常资产；不能恢复管理员下架、不能全局删除共享资产 |
| 2FA 强制策略 | 初始 off | 观察至少一周且人工核对恢复能力后，离线切换 admin 并撤销旧认证证明；不自动定时强制 |
| 二维码与校验 | P0 使用 qrcode 服务端生成 QRCode，扫码后提交 6 位码校验才启用 | 手输密钥仅为备用入口；不使用第三方二维码服务或客户端认证结论 |
| 媒体缓存 | no-store | 优先保证实时状态判定；不能同时承诺一年 immutable 缓存和即时下架 |
| 历史媒体保留 | 仍有任意修订引用就保留 | 30 天只是无引用且已下架资产的最短等待期，不能覆盖引用保护 |
