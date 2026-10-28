# 产品化审查问题修复任务书

> 适用：DeepSeek V4.1 Flash 或其他按单任务执行的编码代理。
> 日期：2026-10-23。审查基线：`866a75f82a2145cd49d8c1691cf52843561a527d` 加当前全部未提交、未跟踪的产品化实现。
> 本文只规定已知问题的后续修复，不授予提交、发布、部署或操作生产数据的权限。
>
> 实施状态（2026-10-23）：R01–R06 已完成并通过针对性回归；本文保留任务书原文与验收条件，实际结果以对应测试和报告为准。

## 1. 任务入口与执行规则

原始产品规格见 [产品化工程任务书](productization-deepseek-v4.1-flash.md)。本轮修复优先采用本文更具体的缺陷与验收规则；产品边界继续遵循原规格。

每轮只选择一个任务：先复现，再修复，再验证，最后报告。当前仓库存在大量用户未提交修改，保留它们，不重置、清理或用旧版本覆盖整个文件。

开始前运行：

```bash
git status --short --branch
git log -1 --oneline
git diff --stat
node --version
```

读取 [AGENTS.md](../../AGENTS.md)、[贡献规范](../../CONTRIBUTING.md)、[安全规范](../security/SECURITY-SPEC.md) 和当前任务列出的实现与测试。HEAD 仍为旧提交时，审查使用 `git diff 866a75f --`，并单独读取 `git ls-files --others --exclude-standard` 列出的新增文件；仅比较两个提交会漏掉实现。

执行约束：

- 测试仅使用临时数据库、媒体目录、备份目录和端口；复用现有测试隔离模式。
- 保留 Astro、Node、SQLite、权限与审计事务、TOTP 和已有迁移编号。
- 修复当前问题，不扩大为框架重写、批量品牌替换或新广告平台。
- 所有测试结论来自实际执行。环境阻塞时报告具体错误，不能把未执行写成通过。
- `spawnSync` 的结果同时检查 `error`、`status` 和必要输出；沙箱可能禁止子进程，不能只看到 status=0 就认定命令成功。
- 完成单任务后交接，不自动进入其他未授权任务。
- 文中的函数与行号是审查定位线索，实施前以当前代码为准。

## 2. 已确认问题与任务顺序

| 顺序 | 任务 | 优先级 | 已确认影响 | 推荐范围 |
|---|---|---|---|---|
| 1 | R01 品牌导入并发保护 | P1 | 导入可覆盖另一管理员刚保存的品牌 | importer、品牌服务、并发测试 |
| 2 | R02 Release 引号错误 | P1 | verify 步骤执行 JS 语法错误，正式和 dry-run 均阻断 | workflow、小型脚本、行为测试 |
| 3 | R03 发行环境示例可交付 | P1 | 本地文件被忽略，新 checkout 缺 Release 附件 | gitignore、环境示例、发行测试 |
| 4 | R04 异常库接管幂等 | P2 | general 分类已存在时 --adopt 唯一约束失败 | initialization、CLI 测试 |
| 5 | R05 下架图片预览 | P2 | 后台预览生成必定返回 404 的图片 URL | sponsors、组件、媒体/浏览器测试 |
| 6 | R06 默认镜像素材边界 | P2 | 默认发行仍附带授权未确认的旧截图 | 构建/打包、兼容策略、镜像测试 |

R02/R03 合并后做一次发行路径验收；R06 完成后再执行最终镜像与旧站兼容回归。以上顺序用于连续授权时执行，不要求同时修改全部模块。

## 3. R01：冻结品牌导入版本并在写事务内复核

### 3.1 问题与证据

读取：

- [importer.ts](../../src/lib/importer.ts)：ImportPlan、previewImport、applyImport，审查时约 434–443、510–515 行。
- [site-config.ts](../../src/server/site-config.ts)：品牌读取、版本、saveBranding。
- [request-cache.ts](../../src/server/request-cache.ts)、[db.ts](../../src/server/db.ts)：事务后清请求缓存。
- [server.test.mjs](../../tests/server.test.mjs)、[site-config.test.mjs](../../tests/site-config.test.mjs)。

现实现先检查预检品牌指纹，执行分类/资源导入，再调用：

```ts
const view = getBrandingAdminView();
saveBranding(actor, brandingInputOf(normalized.branding), view.version);
```

中间的事务会清空请求缓存。另一管理员在期间写入品牌 v2 后，导入读取 v2 作为“预期版本”，成功写 v3，覆盖并发修改。

审查已确定性复现：分类创建 COMMIT 后，用独立 SQLite 连接更新品牌至 v2；applyImport 最终返回 `branding: true`、`errors: []`，品牌被导入值 v3 覆盖。

违反安全规范的预检规则：应用时使用冻结的版本与摘要，不用新查询版本代替。

### 3.2 推荐实现

1. 定义品牌存储快照：`expectedVersion` 与 `rawFingerprint`。缺行版本为 0，合法行使用其 version，损坏行版本为 null。
2. rawFingerprint 根据“是否存在 + 原始 settings.value”计算，区分缺行、损坏行与默认投影；不对公开回退值做摘要。
3. previewImport 将快照冻结进 `plan.branding`，保留现有媒体状态与 payload digest。
4. 为 saveBranding 增加可选的原值指纹保护参数，或等价的明确命名导入写入口；统一复用现有写实现，不复制整套品牌保存逻辑。
5. 在品牌写事务内，重新读取账户角色和原始配置，同时核对冻结版本、原值指纹，再校验媒体、写入和审计。
6. applyImport 只传入预检冻结值，移除结束时“查询最新版本再接受”的路径。
7. 导入开始前仍进行冲突预检。旧计划缺少新增保护字段时返回“重新预检”，不猜测当前版本。
8. 普通后台品牌编辑原有 CAS 保持工作；损坏配置显式修复路径保持有效。

事务边界：不将整个批次强行包成新大事务。开始前已发现冲突时，在业务写入前拒绝；若并发改动发生在其他条目已提交之后，品牌写入必须失败并保留对方值，结果明确 `branding:false` 和冲突原因，允许此前已完成的逐条内容写入按现有语义保留。

### 3.3 必须增加的测试

| 用例 | 方法 | 通过条件 |
|---|---|---|
| 预检后、应用前改品牌 | 已有普通冲突用例 | 应用在开始写内容前拒绝 |
| 导入期间改品牌 | 在真实分类/资源 COMMIT 后，用独立连接保存品牌，再继续导入 | 对方品牌/版本保持，品牌导入失败并报告冲突 |
| 版本相同但原值变化 | 独立连接改原 JSON，不推进 version | 原值指纹保护拒绝覆盖 |
| 缺行/损坏行/正常行 | 分别生成预检计划并施加并发变化 | 不能用默认回退掩盖存储状态变化 |
| 无并发合法导入 | 原 fixture | 品牌正常导入，版本推进一次，审计同事务 |
| 角色/审计/媒体失败 | 原拒绝用例扩充 | 无越权，无半截品牌更新 |

并发测试使用同步屏障或确定性的事务提交钩子，不靠随机 sleep。若测试包装连接 exec，仅在测试内拦截并在 finally 还原，不在生产模块新增任意 SQL 回调口。

针对性验证：

```bash
node --test tests/site-config.test.mjs tests/server.test.mjs
```

**完成条件：** 所有读写分支使用冻结保护，确定性复现不能覆盖并发品牌；保留原导入、权限、媒体和审计测试。

## 4. R02：修复 Release 元数据脚本引用

### 4.1 问题与证据

读取：

- [release.yml](../../.github/workflows/release.yml)：Validate tag, version and commit，审查时 70–76 行。
- [release-check.mjs](../../scripts/release-check.mjs)、[release-version.mjs](../../scripts/release-version.mjs)。
- [release-workflow.test.mjs](../../tests/release-workflow.test.mjs)。

外层 `node -e '…'` 内写 `require('node:fs')` 等单引号。Bash 剥离引号后生成 `require(node:fs)`，Node 报 `SyntaxError: missing ) after argument list`。只做 YAML 正则或 bash -n 无法证明 JS 可执行。

### 4.2 推荐实现

1. 将此段 JSON 更新移动到小型 `.mjs` 脚本，或扩展现有 release-check；输入参数明确，保留版本/tag 校验。
2. workflow 通过正常参数传入 SHA 与文件路径，避免多层 shell/JS 拼接。
3. 保留完整 SHA、HEAD/tag 一致性、同提交 CI、权限分离、PR 不触发、amd64 与 dry-run 边界。
4. 元数据输出为可解析 JSON，commit 与版本正确，末尾是真实换行。
5. 错误参数或不匹配版本非零退出，不生成看似成功的输出。

### 4.3 测试与完成条件

- 使用临时 JSON 文件实际执行修复后的脚本，检查 commit、version 和返回码。
- 实际执行 workflow 对应的本地元数据调用；只对 git/环境作最小隔离，不调用 gh 发布或 registry。
- 保留既有权限/触发条件文本检查，同时增加行为测试。

```bash
node --test tests/release-version.test.mjs tests/release-workflow.test.mjs
```

**完成条件：** 同一调用在本地正常生成元数据，旧引号错误回归用例能够检出；未创建 Tag、Release 或推送镜像。

## 5. R03：让发行环境示例进入可交付文件集合

### 5.1 问题与证据

读取：

- [.gitignore](../../.gitignore)：`.env.*` 与现有 `.env.example` 例外。
- [release.yml](../../.github/workflows/release.yml)：gh release create 附件，审查时 248 行。
- [release.md](../deploy/release.md)：部署说明引用 `.env.release.example`。
- 本地 `.env.release.example`，只确认其示例性质，避免输出真实凭据。

审查时文件本地存在，但 `git ls-files .env.release.example` 无结果，`git check-ignore -v` 显示被 `.env.*` 忽略。新 checkout 没有此必需附件，Release 创建失败。

### 5.2 推荐实现

1. 添加精确的 `!.env.release.example` 例外，继续忽略真实 `.env` 及其他敏感环境文件。
2. 校验示例只有公开默认值、空秘密项或明确占位；与 compose.release.yml 变量和文档一致。
3. 将文件列为本次修复的必交付新增文件。授权暂存/提交时确保实际纳入；仅在本地存在不足以通过。
4. 在任何 registry 推送之前增加必需发行附件存在性检查，避免先推镜像再因文件缺失失败。
5. 测试同时验证忽略例外、附件清单和存在性。后续在真实干净 checkout 上验证纳入情况。

验证：

```bash
git check-ignore -v .env.release.example
git status --short --untracked-files=all -- .env.release.example
git ls-files -- .env.release.example
node --test tests/release-workflow.test.mjs
```

第一条预期不再将该路径视为被忽略；路径已获授权纳入 Git 后，第三条应输出它。尚未授权暂存/提交时，报告“待纳入的新增文件”，不声称干净 checkout 已验证。

**完成条件：** 示例不含秘密、可随源代码和发行附件交付；缺附件时流程在推送前失败；R02/R03 的本地发行准备路径共同通过。

## 6. R04：异常库显式接管只补缺失分类

### 6.1 问题与证据

读取：

- [initialization.ts](../../src/server/initialization.ts)：anomalous/adopt 分支，审查时 165–170 行。
- [init-site.mjs](../../scripts/init-site.mjs)、[initialization.md](../deploy/initialization.md)。
- [initialization.test.mjs](../../tests/initialization.test.mjs)。

接管分支无条件 `insertCategories(db, 'empty')`。最小复现：Empty 初始化，删除 initialized/seeded 标记，再 adopt；已有 general 导致 `UNIQUE constraint failed: categories.id`。应用建议接管，但接管本身不能完成。

### 6.2 推荐实现

1. 保留 BEGIN IMMEDIATE 中的状态检查。
2. 仅在 categories 完全为空时补系统分类；已有任意分类时保留原集合及名称，不额外补 general。
3. 继续仅补缺失配置/标记，不覆盖用户品牌、首页、冻结 issuer，不插 Demo 内容。
4. 正常新库插分类保持严格插入，不用全局 INSERT OR IGNORE 掩盖其他初始化错误。
5. 接管写入或审计/触发器异常仍整体回滚；已有实例重复执行不改变数据。

测试矩阵：

| 初始状态 | 预期 |
|---|---|
| 无分类、有用户、缺标记 | 补 general，保留用户 |
| 已有 general，缺标记 | 成功接管，原名称与分类数量不变 |
| 已有自定义分类，无 general，缺标记 | 成功接管，不新增 general |
| 品牌/首页/issuer 已存在 | 原值不变 |
| 中途故障 | 全部接管写入回滚 |
| 未传 adopt | 自动启动仍拒绝异常库 |

```bash
node --test tests/initialization.test.mjs tests/migrations.test.mjs
```

**完成条件：** 内存函数测试与真实 CLI 均覆盖 general 已存在场景，接管后可打开应用且旧数据摘要不变。

## 7. R05：赞助后台预览遵守媒体下架状态

### 7.1 问题与证据

读取：

- [sponsors.ts](../../src/server/sponsors.ts)：sponsorPreview，审查时 326–336 行。
- [SponsorSlot.astro](../../src/components/SponsorSlot.astro)。
- [赞助后台页面](../../src/pages/admin/sponsors/index.astro)及实际编辑页面。
- [media-references.ts](../../src/server/media-references.ts)、[media-http.ts](../../src/server/media-http.ts)。
- [sponsors.test.mjs](../../tests/sponsors.test.mjs)、[admin-e2e.mjs](../../tests/admin-e2e.mjs)。

预览仅查询尺寸，只要 sponsor.mediaId 非空就输出图片 URL。图片下架后媒体路由实时拒绝，编辑页仍输出 404 img，违反媒体可用性展示规则。

### 7.2 推荐实现

1. 预览在同一读取路径检查媒体存在、ready、未下架，复用现有可用性规则。
2. 不可用时 imageSrc 为 null，保留原 mediaId、imageAlt 和明确的不可用状态；预览不能顺便修改数据库引用。
3. 后台展示带替代文本的占位和“图片已下架或不可用”说明。
4. 不为管理员预览绕过媒体下架，不从文件系统直出对象。
5. 公开位继续整项隐藏缺图的图片型广告；纯文本赞助正常展示，默认关闭行为不变。
6. 预览可独立于广告总开关，但不能独立于媒体安全状态。不要为修复预览自动恢复图片或活动。

测试：可用图正常；下架/purging/不存在状态无损坏 img；替代文本可读；恢复图片后预览恢复；引用仍保护 purge；编辑页不产生已知 404 图片请求。

```bash
node --test tests/sponsors.test.mjs tests/media.test.mjs
npm run test:admin
```

**完成条件：** 下架后打开编辑页有明确占位、没有指向不可用媒体的 img，公开查询与媒体权限保持原行为。

## 8. R06：默认发行排除授权未确认的旧截图

### 8.1 问题与证据

读取：

- [Dockerfile](../../Dockerfile)：COPY public 与 runtime COPY dist，审查时 7、45 行。
- [.dockerignore](../../.dockerignore)、[optimize-images.mjs](../../scripts/optimize-images.mjs)。
- [CREDITS.md](../../public/images/CREDITS.md)、[图片变体清单](../../src/data/image-variants.json)。
- [images.test.mjs](../../tests/images.test.mjs)、[browser.mjs](../../tests/browser.mjs)。
- [container-smoke.sh](../../scripts/container-smoke.sh)、[verify-image.sh](../../scripts/verify-image.sh)。

已确认以下授权未确认原图和 WebP 派生图仍在默认 dist/client/images，并会进入运行镜像：

- zotero-interface.png
- obs-interface.png
- vlc-interface.jpg

Demo 不再引用截图，只解决内容引用；没有解决默认分发边界。本项是打包规格缺口，不对素材作新的法律结论。

### 8.2 推荐实现：默认中性构建 + 显式兼容资产

1. 建立明确的静态素材清单，区分许可明确的系统素材与历史资源截图；依据 CREDITS 核对，不用文件名关键词猜授权。
2. 默认 Docker 与非 Docker生产发行只打包许可明确的素材；至少排除上述三张原图和全部对应派生图。
3. 从发行构建暂存区筛选素材，不删除工作区原图、历史采集说明或用户数据。
4. 图片优化与变体 manifest 必须与最终发行集合一致；不能仅删除原图却留下 optimized 派生文件或失效 manifest 引用。
5. 为旧实例提供显式选择的兼容素材路径，并记录其权利核查由部署者负责；默认不自动附加该包、不从远端自动下载。
6. 兼容路径采用单一、文档化选项，如构建参数/命令选项 `INCLUDE_LEGACY_ASSETS=1`。具体实现复用现有构建脚本和临时 staging，不要求引入新打包框架。
7. 旧站切换默认镜像前，文档要求先核对 /images 引用，再选择许可已确认的兼容素材构建或通过后台替换。禁止批量删除旧数据库 image 字段来掩盖缺图。
8. 兼容构建保留原 URL 和变体行为；默认构建不输出指向已排除图片的 picture/srcset，使用已有占位逻辑。实际渲染的其他路径也需检查。
9. 调整依赖历史图片的浏览器 fixture：明确使用测试/兼容素材模式或许可明确的新 fixture；保留响应式图片行为测试。
10. 更新镜像验收、Node 发行说明和必要 notices，不宣称“未引用就未分发”。

旧备份只保证 DB+媒体对象，不一定包含 public 静态图片。兼容文档明确这一差别，不能要求用户用媒体恢复工具找回构建期截图。

### 8.3 必须验证的发行矩阵

| 构建/数据 | 检查 | 通过条件 |
|---|---|---|
| 默认 Docker | 容器内列举 dist/client 与图片 HTTP 请求 | 三张原图及对应派生图不存在，也不可公开获取 |
| 默认 Node 发行 | 检查最终构建与 manifest | 同样排除，manifest 不含失效条目 |
| Empty/Demo | 首页与静态文件检查 | 只有默认允许素材，无旧截图自动附带 |
| 显式兼容构建 + 旧库 | 原 /images 路径与 picture/srcset | 图片可正常读取，旧数据库内容未变 |
| 已换成许可明确素材的旧站 | 默认构建启动 | 无断图；原核验、资格、资源发布状态保持 |
| 含过往优化文件的工作区 | 从脏构建缓存重新构建默认发行 | 旧 optimized 文件不能残留进入产物 |

```bash
node --test tests/images.test.mjs tests/catalog.test.mjs
npm run build
bash scripts/container-smoke.sh
```

额外执行默认镜像素材缺席断言和兼容镜像检查，接入 verify-image/CI。仅运行原 container-smoke 不足以证明素材已经排除。

**完成条件：** 默认发行中素材实际缺席、兼容路径显式且可操作、旧内容不被自动改写、相关响应式图片测试保留。

## 9. 最终质量门与交付状态

六项修复完成后运行：

```bash
npm run check
npm test
npm run build
npm run test:admin
npm run test:instances
bash scripts/container-smoke.sh
```

另在临时目录/端口启动生产构建，设置独立 DATABASE_PATH、MEDIA_DIR、维护状态路径和 TEST_BASE_URL，执行 `npm run test:browser`。初始化 fixture 和服务清理沿用现有 CI/浏览器测试约定。

R06 改变构建与旧实例静态素材行为，还需执行：

- 默认与兼容镜像的素材矩阵。
- `scripts/verify-image.sh` 的镜像/许可/CLI 检查。
- `npm run rehearsal:upgrade`，或等价临时旧站升级回滚流程；使用正确素材模式，明确媒体与静态图的覆盖范围。
- R02 的实际元数据脚本执行、R03 的发行文件可交付检查；本地质量门不等同于真实 GitHub Actions 已通过。

基准证据仅供对照：上次审查 check/build 通过；250 个测试中 249 通过、1 跳过；admin 35/35、browser 10/10、instances 4/4、container smoke PASS。修复后测试数量可增长，不能硬编码旧数量作为完成条件；跳过项说明原因。

不为验证而创建正式 Tag、Release 或推送 GHCR。真实发行需单独授权，且目标提交的 CI 必须成功。

交付要求：

| 项目 | 要求 |
|---|---|
| R01 | 确定性并发复现从“覆盖”变“拒绝且保留对方数据” |
| R02 | 实际脚本可执行，非仅正则检查 |
| R03 | 示例进入应交付集合，真实 checkout 验证状态如实报告 |
| R04 | 已有 general 的 CLI 接管成功且数据不变 |
| R05 | 下架预览有占位，无已知不可用 img |
| R06 | 默认产物不含未确认截图，旧站兼容路径通过 |
| 工作区 | 保留原有修改，新增文件明确列出，不自动提交或发布 |

## 10. 可直接交给 DeepSeek V4.1 Flash 的提示词

### 单任务执行

```text
请阅读 docs/design/productization-review-fixes-deepseek-v4.1-flash.md。
本轮仅授权修复 R01（按需替换编号）。

先做仓库预检，读取本任务列出的实现和测试，确认缺陷仍存在。
保留当前全部其他未提交修改。
按复现 → 最小修复 → 针对性验证执行；测试只用临时数据。
不要自动进入下一项，不创建提交、Tag、Release，不推镜像或部署。
结束报告文件变化、真实命令结果、缺陷回归证据和未验证边界。
```

### 连续修复（仅在用户明确授权全部时使用）

```text
请按修复任务书 R01–R06 顺序执行全部修复。
每项先确认复现，完成独立验证后再进入下一项。
R02/R03 做共同发行路径验收，R06 之后跑完整质量门和旧站兼容矩阵。
保留已有修改；不自动提交、发布或部署。
若环境阻塞，继续不依赖该环境的工作，并准确记录未验证项。
```

### 每项交接模板

```markdown
任务：R01
状态：完成 / 未完成 / 环境阻塞
起点：<commit、当前未提交修改摘要>
变更：<文件及具体行为>
回归证据：<原触发步骤、修复后的可观察结果>
验证：<实际命令与结果，未运行项写明原因>
兼容性：<旧数据、权限、认证、媒体和发行边界>
未完成项：<具体项；没有则写无>
下一任务：<编号与前置状态，不自动执行>
```

本文创建时 R01–R06 全部处于待修复状态。只有完成对应行为验收，才能更新为完成。
