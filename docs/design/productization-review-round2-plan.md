# 产品化第二轮复审：阻断项与下轮修复计划

日期：2026-10-23。

审查对象：`866a75f82a2145cd49d8c1691cf52843561a527d` 基线上的当前未提交产品化实现及 R01–R06 修复，包含未跟踪文件。

本轮仅审查与记录，不修改实现、不创建提交或发布。遵循用户要求：非致命缺陷仅加入下轮计划，不据此扩大本轮修复范围。

关联规格：

- [产品化工程任务书](productization-deepseek-v4.1-flash.md)
- [第一轮 R01–R06 修复任务书](productization-review-fixes-deepseek-v4.1-flash.md)
- [安全规范](../SECURITY-SPEC.md)

## 1. 已复核修复与剩余状态

| 项目 | 本轮结论 |
|---|---|
| R01 品牌导入并发 | 已使用预检冻结的版本和原值指纹；写事务内复核，新增并发测试通过 |
| R02 Release 引号 | 元数据移入独立脚本；tag/image/notes/field 实际调用链可执行 |
| R03 发行示例 | gitignore 例外及构建/发行前附件检查已加入；示例仍未跟踪，授权提交时必须纳入 |
| R04 异常库接管 | 仅在分类为空时补 general；原 UNIQUE 复现已变为成功 |
| R05 下架预览 | 预览与公开查询共用状态规则；不可用图片不再输出 URL，保留占位和原因 |
| R06 默认素材 | 默认剪裁及显式兼容路径已接通；Markdown 静态图片有非致命遗漏，列为 N01 |

本轮新增确认：1 项恢复数据安全阻断 B01；1 项可延期显示问题 N01。

`.env.release.example` 尚未纳入 Git、私密漏洞渠道待配置、实际 Tag/GHCR/Release 未执行，是已知交付前置条件，不重复计为新缺陷。

## 2. B01：失败恢复的自动回滚遗漏原 WAL

**优先级：P1；数据安全阻断。建议在稳定发行前修复。**

### 2.1 定位与性质

- [restore-site.mjs](../../scripts/restore-site.mjs)：审查时 rollback() 第 164–167 行，只复制保全的主库。
- 同文件第 182 行保全了原 WAL/SHM，但第 193–194 行切换时删除目标 sidecar，自动回滚未还原它们。
- [restore-failure.test.mjs](../../tests/restore-failure.test.mjs)：现有失败用例主要在正常关闭数据库、已完成 checkpoint 的状态下比较主库字节。

这是当前恢复路径中的遗留缺陷，本轮才补充验证，不能表述为 R01–R06 新引入的回归。

### 2.2 确定性复现

所有操作在临时目录，数据库无生产数据：

1. 初始化 Empty 实例，建立合法的离线 site 备份。
2. 独立 SQLite 写进程打开目标库，启用 WAL、关闭自动 checkpoint，提交一条新反馈。
3. 用 SIGKILL 结束该自建进程，留下包含已提交记录的 WAL；此时无活跃写入者。
4. 使用已有测试钩子 `NODE_ENV=test`、`SITE_RESTORE_TEST_HOOK=fail-after-swap` 执行站点恢复。
5. 恢复故意失败并触发自动 rollback。脚本日志包含 `db-restored`、`objects-restored`。
6. 查询回滚后的目标库，再查询保全主库加保全 WAL 的副本。

本轮实际结果：

```json
{
  "restoreExit": 1,
  "rollback": ["db-restored", "objects-restored"],
  "preservedCommittedRows": 1,
  "rowsAfterAutomaticRollback": 0,
  "demonstratesLoss": true
}
```

影响：自动回滚后的活动库缺少已提交记录。保全目录中仍存在可恢复证据，因此不应表述为数据已永久销毁；但当前自动回滚不满足恢复原状态的承诺。

### 2.3 后续授权修复范围

读取 restore-site、restore-db、restore-prepare、现有恢复规范与测试，再确定最小统一方案：

1. 将“原主库和与它匹配的已提交 WAL 状态”作为整体保全与回退。
2. 推荐在全部写入者离线时生成并校验独立一致性保全副本，使回退不依赖遗留 WAL；也可采用经过验证的主库/sidecar 成组恢复，但不能只复制主库。
3. 回退前处理候选库生成的 sidecar，防止新 WAL 与原库混用；SHM 应按 SQLite 规则安全重建或配套恢复。
4. 不在生成可恢复保全状态之前删除原 WAL。
5. 覆盖切换前后失败，不仅测试成功 rename 后的异常；检查 `dbInstalled` 标记与实际文件变更时序。
6. 核对原业务记录、媒体与完整性后才能记录“已回滚”；回退失败应明确报错并保留现场。
7. 保持成功灾备恢复的认证净化。失败回退是还原操作前状态，不应擅自重置原账户和内容。
8. 更新硬中断手册，保证其步骤与自动回退使用的保全格式一致。

无需增加新业务表或修改用户内容。不要为了通过测试而忽略 WAL、删除已提交记录或改写原反馈。

### 2.4 完成条件

| 场景 | 必须满足 |
|---|---|
| 目标有已提交、未 checkpoint 的 WAL，切换后失败 | 所有原业务记录仍在，完整性检查通过 |
| sidecar 清理与 DB 替换之间失败 | 能回到一致的原库，或明确失败并提供已验证恢复路径 |
| 原库已正常 checkpoint | 原有失败回滚测试继续通过 |
| 无原目标的新安装恢复失败 | 状态和日志明确，不伪称原库已还原 |
| 成功恢复备份 | 数据来自备份，认证净化仍生效 |
| 硬中断 | 保全信息可诊断；文档步骤实际恢复 DB 与媒体 |

建议新增确定性 WAL 场景测试到 restore-failure；用子进程 SIGKILL 产生真实 WAL，不用伪造空 sidecar。子进程同时检查 error、signal、输出及 WAL 文件存在性。

## 3. N01：Markdown 中被排除的旧静态图仍输出 img

**优先级：P2；非致命，可延期。仅加入下一轮修复计划。**

### 3.1 定位与证据

- [markdown.ts](../../src/lib/markdown.ts)：审查时第 69–78 行，仅对 `/media/` 调用可用性判定。
- [media-render.ts](../../src/lib/media-render.ts)：SSR Markdown 包装。
- [prune-release-assets.mjs](../../scripts/prune-release-assets.mjs)：默认发行删除旧静态截图。
- [ResourceImage.astro](../../src/components/ResourceImage.astro) 已有 manifest 缺图占位，但 Markdown 图片不经过此组件。

最小复现：

```js
renderMarkdown('![旧截图](/images/zotero-interface.png)')
```

实际输出：

```html
<p><img src="/images/zotero-interface.png" alt="旧截图"></p>
```

默认产物中的该原图已不存在。因此资源 details、指南正文或其他 Markdown 字段引用旧图时，会发出确定的 404 图片请求。

影响仅为图片显示与无障碍体验，不损坏内容、账户和数据库，不阻断主要运行及发行流程。原 Markdown 文本应保留，不自动删除引用。

### 3.2 下轮修复建议

1. 为静态 `/images/` 建立与实际发行素材一致的可用性投影，供 SSR Markdown 调用。
2. 保持纯 Markdown 语法校验与服务器依赖分离，不在通用渲染器中读取任意文件或打开数据库。
3. 默认构建中不可用的旧图输出转义 alt 和明确占位，不输出 img/srcset。
4. 显式兼容构建中图片继续正常显示。
5. 保留 `/media/` 下架规则、路径规范化、远程图拒绝和 HTML 转义。
6. 后台未保存预览与公开 SSR 使用哪种可用性策略应明确说明，不通过修改 DB 内容实现回退。

### 3.3 下轮验收

默认与兼容构建分别覆盖：资源 details、指南正文、内联字段、普通与引用式 Markdown 图片；默认模式无被排除图片请求且 alt 可读，兼容模式正常显示。保留恶意路径、外部 URL、data URL 与已下架媒体的原测试。

建议测试位置：markdown.test、images.test、browser/admin-e2e 的相关预览场景。

## 4. 本轮实际验证与边界

- `npm run check`：159 个文件，0 errors / 0 warnings / 0 hints。
- `npm test`：265 项，264 通过、0 失败、1 跳过。
- 独立临时数据库 WAL 失败回滚复现：确认 B01。
- Markdown 最小输出与默认产物缺图检查：确认 N01。
- Release 元数据直接调用链与剪裁脚本隔离夹具：通过。
- R01 新增并发与存储快照定向测试：通过。

本轮未重新执行整套容器/默认兼容镜像/升级演练矩阵，用户报告的上一轮通过结果不冒充本轮重新执行。当前绿灯测试未覆盖 B01，不据此关闭该阻断。

## 5. 后续执行入口

```text
请阅读 docs/design/productization-review-round2-plan.md。
本轮仅授权处理 B01（若另有授权则替换为 N01）。
先检查当前代码与预检状态，保留其他全部未提交修改。
在临时目录复现，再做最小修复与针对性回归。
只修改本任务所需实现/测试/文档，不自动进入其他任务。
不创建提交、Tag、Release，不推送镜像，不操作生产数据。
报告原复现结果、修复后结果、实际命令及未验证边界。
```

后续状态（2026-10-23）：B01 已修复并完成针对性回归；N01 仍待下轮处理。本文件保留审查时的原始记录，不把当时的绿灯结果当作修复证据。修复后的自动与手工复演结果见 `tests/restore-failure.test.mjs`、[运维手册](../operations.md) 与 [升级回滚](../upgrade.md)。
