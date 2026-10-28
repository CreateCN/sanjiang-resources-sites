# 三匠资源站通用化与产品化：工程实施任务书

> 执行对象：DeepSeek V4.1 Flash，或按单任务、短反馈循环工作的编码代理。
> 文档日期：2026-10-23。审计基线：`master@866a75f`。
> 本文是后续实施规格。阅读本文不等于获得修改源码、提交、发布、部署或操作生产数据的授权；执行范围以当前用户指令为准。

## 0. 执行入口

### 0.1 产品目标

将现有 Astro + Node.js + SQLite 学习资源网站，改造成不同高校、学生组织、学习社区和个人可独立部署的资源目录程序。

- 上游暂定名称：**三匠资源站 / Sanjiang Resources**。
- 实例名称由部署者配置，可以与上游品牌完全不同。
- 每个实例独立保存数据库、媒体、账户、认证状态、站点配置、广告与备份。
- 保留现有内容管理、安全、审计、媒体和运维能力。
- 首个可复用版本完成 P0、P1；赞助模块属于 P2，发行自动化属于 P3。

### 0.2 给编码代理的工作方法

1. 先执行第 1 节预检，再选择一个前置依赖已完成且被用户授权的任务。
2. 每次只实现一个任务编号，如 `P0-02`。任务内按“服务层 → 接口 → 页面 → 验证”逐步推进。
3. 先读该任务列出的文件及实际调用者，不以本文中的行号、版本号或函数签名替代当前代码。
4. 开始修改前，用不超过 8 行写清：本次目标、文件范围、调用链、必须保持的行为、验证方式。
5. 优先沿用现有函数与事务模式。新增抽象应承担本文指定职责，不顺手重构其他模块。
6. 先运行当前改动的针对性检查；通过后执行本阶段质量门。失败先定位原因，再做最小修复。
7. 完成后按第 12 节交接格式报告。完成一项不代表完成整个改造，也不代表获准发布。
8. 遇到与基线不同的实现，先追踪当前代码，更新本任务的判断；涉及数据安全或产品边界变化时报告具体差异。

本文通过任务粒度、固定输入、显式规则和完成条件降低执行歧义，不依赖模型专属 API 参数、上下文长度或未经核实的能力假设。

### 0.3 不可变边界

| 边界 | 执行要求 |
|---|---|
| 技术栈 | 保留 Astro、Node.js、SQLite；复用现有 Zod、认证、媒体与迁移 |
| 部署模型 | 单实例；app 与 maintenance 是同实例内两个进程/容器 |
| 数据 | 使用追加迁移；旧内容、用户、历史、审计、媒体和配置保持完整 |
| 发布 | 草稿与公开快照继续分离，只有管理员发布后生效 |
| 安全 | 写入口继续检查 Origin、CSRF、实时角色、版本与审计事务 |
| 品牌兼容 | 保留 Cookie、草稿缓存前缀、备份格式 magic、仓库与包名 |
| 广告 | 默认关闭，本地静态内容，不加载第三方 SDK/追踪脚本 |
| 外部操作 | 提交、push、建 issue、发 Release、推镜像和部署按当次授权执行 |
| 历史 | 保留原始提交、报告、备份和采集证据中的原名称 |
| 范围 | 本项目不增加租户、中央账户、学校公共数据库、微服务或广告计费系统 |

## 1. 实施前预检与事实基线

### 1.1 每次开始都执行

```bash
git status --short --branch
git log -1 --oneline
git diff --stat
node --version
```

然后读取：

- [AGENTS.md](../../AGENTS.md)
- [issue tracker 约定](../agents/issue-tracker.md)
- [领域文档约定](../agents/domain.md)
- 当前任务相关的 `package.json` scripts、Schema、迁移和测试。
- 根 `GLOSSARY.md` 和相关 `docs/adr/` 若存在，遵循其中术语与决策。

完成条件：明确当前分支、已有修改、实际运行时、任务起点；已有他人修改得到保留。若无生产数据操作授权，所有测试指向临时目录与临时数据库。

### 1.2 已审计事实：需要理解的调用链

| 事实 | 代码入口 | 对实施的影响 |
|---|---|---|
| 数据库惰性打开，先迁移，再检查 `metadata.seeded` | [db.ts](../../src/server/db.ts) | build/check 不应初始化生产库 |
| 未 seeded 时写入 12 条资源的草稿和公开快照 | [demo.ts](../../src/data/demo.ts)（原文写 `src/data/resources.ts`，已拆分） | Empty 必须替换默认初始化路径，不能只改页面 |
| 当前迁移为 001–010 | [migrations.ts](../../src/server/migrations.ts) | 实施时重新确认末尾编号，追加迁移 |
| 现有 settings 只含精选和场景，Schema 为 strict | [settings.ts](../../src/server/settings.ts) | 品牌单独用键，避免破坏旧首页配置 |
| 资源公开读取多处直接 JSON.parse | [store.ts](../../src/server/store.ts) | scope 缺省适配不能只写 Zod default |
| JSON 导入优先取 draft，只写草稿 | [importer.ts](../../src/lib/importer.ts) | 内容导入不是完整站点恢复 |
| 导出 v2 不含媒体二进制、账户和完整运行历史 | 同上 | 全量搬迁使用 site backup/restore |
| 预检冻结 digest、uid/version、设置指纹、缺图状态 | 同上 | 扩展品牌预检时保留全部冲突保护 |
| 媒体引用扫描只含资源、指南和修订 | [media-references.ts](../../src/server/media-references.ts) | 品牌/赞助图片必须加入引用图 |
| 离线恢复另有媒体引用扫描 | [restore-site.mjs](../../scripts/restore-site.mjs) | 在线与离线消费者都要覆盖新引用 |
| TOTP issuer 固定为“三江资源” | [totp.ts](../../src/server/totp.ts) | 兼容冻结，不随品牌编辑动态变化 |
| 站点恢复清会话、挑战、恢复码并增加 auth_version | [restore-prepare.ts](../../src/server/restore-prepare.ts) | 普通升级保会话；灾备恢复主动失效 |
| 定时 backup 仍调用 backup-db.mjs | [maintenance-schedule.ts](../../src/lib/maintenance-schedule.ts) | 在线诊断快照不等于完整灾备 |
| CI 已运行前后台浏览器测试 | [ci.yml](../../.github/workflows/ci.yml) | 保留测试，不照抄 README 过时描述 |
| CSP 为 Report-Only | [middleware.ts](../../src/middleware.ts) | 不能宣称已有强制 CSP 防注入 |

审计时远端可见 Tag/Release 列表为空；Packages 查询因缺 `read:packages` 返回 403。此信息仅为历史观察，发行前重新只读查询，不推断 Packages 未启用。

## 2. 已固定的实现决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D01 | 新安装默认 Empty | 不把原站资源与学校定位灌入用户站 |
| D02 | 品牌存 `settings.branding`，首页编排仍存 `settings.site` | 兼容现有 strict Schema 和旧导入 |
| D03 | SITE_URL 只由环境变量生效 | canonical、Origin、Cookie、HTTPS 行为保持一致 |
| D04 | 旧站升级保留原显示品牌，迁入实例配置 | 避免升级突然改名；源码不再绑定学校 |
| D05 | 资源增加轻量 scope，缺字段为 unknown | 不把缺证据误认为通用，不建学校关系表 |
| D06 | 内容导出下一版为 v3，接受旧格式、拒绝未来版本 | 防止新字段被旧解析静默丢弃 |
| D07 | 广告仅本地图片或纯文本卡片 | 复用媒体，减少隐私和供应商维护成本 |
| D08 | issuer 按实例冻结，旧实例保留旧值 | 页面改名不改变验证器绑定展示 |
| D09 | 第一版 CLI 初始化，无公开抢首管入口 | 保持运维授权边界，避免安装期接管 |
| D10 | 第一版根路径部署 | 当前路由、Cookie 和静态路径不承诺子路径实例 |
| D11 | 完整备份与升级回滚演练是稳定发行门槛 | 安装成功不能证明可维护 |
| D12 | 推荐统一 Node 24；若保留 Node 22，先补 CLI 全矩阵 | 当前运维脚本直接执行 TS，声明需与实际能力一致 |

后续可以延后：最终商标命名、仓库改名、学校代码目录、地区层级、第三方广告、支付、动态分享图、主题市场、多语言、无停机完整备份、多机高可用。

## 3. 模块契约：实施时的唯一规格

### 3.1 配置分层

```text
软件常量：上游名称、仓库、版本、许可证
部署环境：SITE_URL、数据库/媒体/备份路径、代理信任、密钥、TOTP策略、配额、任务时间
SQLite：实例品牌、首页编排、赞助开关、赞助活动
```

拟新增文件职责：

| 文件 | 单一职责 |
|---|---|
| `src/lib/site-config.ts` | 纯类型、Zod、默认值、上游软件常量；不导入 DB |
| `src/server/site-config.ts` | branding 读写、CAS、媒体校验、审计、公开投影 |
| `src/server/deployment-config.ts` | 环境变量校验、权威 origin；不暴露密钥对象给页面 |
| `src/server/initialization.ts` | 新库分类、Empty/Demo 初始化与元数据 |
| `scripts/init-site.mjs` | 运维 CLI，调用初始化服务 |
| `src/lib/resource-scope.ts` | scope 类型/显示/兼容辅助，按代码复用需要创建 |
| `src/lib/sponsor-schema.ts` | 赞助输入 Schema |
| `src/server/sponsors.ts` | 赞助管理员操作和公开查询 |
| `src/components/SponsorSlot.astro` | 固定广告位渲染 |

以上是职责边界，不要求为了文件数量机械拆分。保持纯 Schema 与数据库依赖分离。

### 3.2 品牌数据

`settings.branding` 保存以下版本化 JSON。字段名在整个实现中保持一致。

```json
{
  "schemaVersion": 1,
  "version": 1,
  "name": "三匠资源站",
  "subtitle": "学习与创作的资源入口",
  "description": "整理工具、课程与公共学习资源，并说明费用和使用条件。",
  "footerText": "由本站维护者独立整理。",
  "organizationName": "",
  "nonOfficialStatement": "本站不代表学校或资源提供方授权、合作或认可。",
  "logoMediaId": null,
  "faviconMediaId": null,
  "shareImageMediaId": null,
  "accentColor": "#245c42",
  "showProjectAttribution": true
}
```

校验：

- name：trim 后 1–60 字；subtitle：0–100；description：0–500。
- footerText、nonOfficialStatement：0–500；organizationName：0–100。
- 文案为纯文本；通过 Astro 默认转义输出。
- accentColor：严格 `#RRGGBB`。以白色按钮文字至少 4.5:1 对比度校验；从合法输入派生 hover 色，相关文字不直接假定白底可读。
- media ID：null 或 64 位小写十六进制。写入时校验 ready、未下架、授权已确认并有 credit。
- schemaVersion 固定为支持值。version 初始 1，仅由服务端递增。
- 公开读取只返回明确白名单，不合并 `process.env`、用户行或安全配置。
- 缺行返回默认值；损坏行保留原文，公开页中性回退，后台报告配置异常。

建议接口契约（可按当前类型作必要适配）：

```ts
getBranding(): BrandingSettings
getPublicSiteConfig(): PublicSiteConfig
saveBranding(actor: User, input: unknown, expectedVersion: number): BrandingSettings
getSiteOrigin(requestUrl?: URL): string
```

CAS 要求：事务内重新读取当前角色和原配置；版本不符返回 409。无行时只允许约定的初始版本状态。可用原始 value 条件更新，不能只在事务外比较后无条件覆盖。

首次采用品牌配置的旧站迁移只补缺失键。现有 `settings.site` 的形状和存量值保持不变；新站首页精选为空，场景文案只对应实际分类。

### 3.3 品牌消费清单

| 消费者 | 必须接入的值 |
|---|---|
| Layout | name、subtitle、description、Logo、favicon、分享图、页脚、声明、归属开关、主题色 |
| AdminLayout/登录 | name、favicon、主题色 |
| index | 通用引导、WebSite JSON-LD、空站状态 |
| about | 实例介绍、组织信息、非官方声明、收录规则与隐私 |
| guides/index | 通用描述，移除学校专属文案 |
| 各内容页面/场景/updates | 统一 origin；不覆盖内容本身标题和摘要 |
| sitemap/robots | 与页面一致的环境 origin |
| TOTP enroll | 由服务端返回的实际冻结 issuer |

SEO 规则：title/OG/Twitter 的站点后缀用同一个 name；WebSite 使用同一 name、origin 和 description；JSON-LD 继续把 `<` 编码为 `\u003c`。

Logo/分享图复用现有媒体，缺失或下架则回退中性素材。favicon 源图沿用现有最小尺寸校验，上传说明要求至少 200px；如需 PNG favicon，使用 sharp 的受控派生输出，限制输出尺寸并实时检查源媒体，不开放任意转换参数。派生输出也采用 no-store。动态生成带站名的分享图推迟。

主题只开放受校验强调色，不开放原始 CSS/HTML/JS。归属开关控制页面上游归属区及对应 Commit 展示；发行物中的 LICENSE/NOTICE 始终保留。部署者署名与代码版权分开。

### 3.4 认证兼容

- 保留 `sanjiang_session`、`sanjiang_mfa` 及属性，不迁移 Cookie 名称。
- 保留 `sanjiang:draft:v1:` 及已有草稿缓存兼容逻辑。
- 旧实例 `metadata.auth_issuer` 缺失时补“三江资源”。
- 新实例初始化时写入初始化名称或“三匠资源站”，之后品牌编辑不改变它。
- 新初始化名称可通过 init CLI 参数提供；既有实例单独改品牌时保留 issuer。
- `buildOtpauthUri` 接收服务端解析的 issuer；label 与 query 一致。
- TOTP 的 secret、AES-GCM、AAD、SHA1/位数/周期、恢复码、撤销矩阵均保持现有语义。
- 改名不递增 auth_version、不清会话、不要求重绑。
- 灾备恢复继续清会话/挑战/恢复码、抬升步数；不能为了“兼容”取消净化。

### 3.5 初始化状态机

```text
打开数据库，识别现有应用状态
  ├─ 已有 seeded 或新初始化完成标记：只迁移，不灌种子
  ├─ 有应用业务数据但缺标记：拒绝自动灌种子，给诊断说明
  └─ 明确新库：迁移 → 原子初始化 → 写完成标记
```

新库判断不能只依赖文件不存在：预创建空文件也应可初始化。已完成迁移但尚无初始化数据的新库允许安全重试；历史异常库接管必须显式执行，不能靠环境变量偷偷补种子。

环境参数：`SITE_INIT_MODE=empty|demo`，默认 empty；仅作用于新库。Import 是认证后的内容导入路径，不作为启动时自动读取任意文件的模式。

CLI 目标交互：

```text
init-site --mode empty|demo [--name <实例名称>]
create-admin                  # 复用现有隐藏输入与密码校验
```

约束：

- Empty：一个 `general/综合资源` 分类；`all` 保持虚拟；资源和指南为零。
- Demo：明确示例标记、小量资源、无默认管理员；素材许可明确。
- 同模式重跑无写入；不同模式重跑拒绝自动转换；不提供隐式清库操作。
- 必要分类、品牌、首页设置、issuer、初始化模式/版本和 `seeded=1` 在同一事务提交。
- 不删除旧 seeded 标记，以免旧程序回灌。
- 复用现有管理员 CLI；其创建额外管理员的应急能力保留。若提供 first-admin 模式，零账户检查在同一事务内完成，不替换现有运维入口。
- CLI 非零退出不打印密码、密钥或完整敏感环境变量。

Demo 标记写入初始化元数据，并在 Demo 站前台显示“演示内容，请替换并重新核验”。编辑者审核示例不能自动提升 verified。退出演示标记由管理员显式确认，不改变资源内容和发布状态。

### 3.6 scope 与内容格式

```ts
type ResourceScope =
  | { type: 'unknown' }
  | { type: 'global' }
  | { type: 'institutions'; institutions: string[] };
```

- institutions：1–20 个 trim 后非空、最多 100 字的名称，去重；无需外部学校 API。
- 缺字段视为 unknown；存在但非法的字段在写入/导入时拒绝。
- unknown 显示“适用范围待确认，请查阅资格说明”。
- global 不表示永久免费、不受地区或个人资格限制。
- scope 与现有 access 独立，`student-verification` 不自动对应 global。
- 不批量改写旧草稿、发布快照、revisions、audit 或核验日期。
- 读取旧快照时增加兼容投影；不能仅因缺 scope 重新验证并拒绝全部旧数据。
- 新增写入按完整 Schema 校验；草稿范围改变，发布前公开快照保持原值。
- 编辑器序列化、历史差异、历史恢复、预览、目录、场景、详情、导入导出共同覆盖。

导出 v3 保留旧结构，增加可选 `branding`；资源内部可带 scope。

| 输入版本 | 处理 |
|---|---|
| 无版本 | 旧格式适配，预检提示 |
| 1、2 | 旧格式适配，缺 scope 为 unknown |
| 3 | 新 Schema 校验 |
| 其他数字/非法类型 | 写入前拒绝，不降级猜测 |

首页设置、品牌分别由管理员显式勾选，默认不选；无 branding 不更改目标品牌。预检冻结品牌版本/指纹、媒体状态和归一化后的有效输入摘要。预检与应用必须复用同一个归一化函数，避免兼容默认值改变 digest。

保留现有 uid/version 与缺图冲突保护、逐条事务和失败明细。内容导入只写草稿，媒体元数据不是二进制。第一版不新建跨实例媒体搬运协议，缺图条目清楚报错，修正后重新预检。

### 3.7 迁移与恢复

建议下一迁移为 `011-instance-configuration`，实际编号按实施时末尾确定。迁移只补缺失旧配置和元数据；schema 新键见本节，不覆盖用户值。

赞助另建后续迁移，不修改已执行的 001–010。

- 每个 migration 继续事务执行并记账；整次升级可能有多个已提交迁移。
- 数据库打开与两种恢复入口共用未知迁移拒绝规则。
- 兼容检查发生在改写、迁移未知库之前。
- 旧备份先在暂存副本迁移和净化，通过后才切换目标。
- 保留备份格式 `sanjiang-site-backup/1`；新增 manifest 可选字段时保持旧文件可读。
- 新 manifest 增补软件版本、Commit、迁移列表；不要写密钥。
- 业务核对覆盖分类、资源两份快照、指南、用户、历史、审计、设置、媒体、赞助；数量和稳定内容摘要同时比较。
- 恢复时允许的变化仅为迁移元数据、规定认证净化和恢复审计。
- 失败和硬中断都需阶段化验收，不能把“有 catch 回滚”当作全部故障已安全。

## 4. 任务顺序与阶段质量门

| 阶段 | 顺序 | 阶段质量门 |
|---|---|---|
| P0 品牌去耦合 | P0-01 → 02 → 03 → 04 → 05 | 品牌全展示面一致；旧库、会话、TOTP、媒体完整 |
| P1 基础产品化 | P1-01 → 02 → 03 → 04 → 05 → 06 | Empty/Demo/Import、升级与全站恢复可重复验证 |
| P2 静态赞助 | P2-01 → 02 → 03 → 04 | 默认无广告；管理员边界、素材、排期、备份通过 |
| P3 发行维护 | P3-01 → 02 → 03 | 固定发行物安装、升级、回滚；许可与版本可追溯 |

同一任务内部可将测试与实现放在一个补丁内。本文的任务边界是可独立审查的变更边界，不自动要求创建 commit。

### 通用质量门

先读取当前 scripts；基线命令如下：

```bash
npm run check
npm test
npm run build
npm run test:admin
```

前台浏览器测试需要先启动隔离生产服务器，再设置 `TEST_BASE_URL` 运行 `npm run test:browser`；参考当前 CI 的启动、健康轮询和清理实现。测试服务只用临时 DATABASE_PATH、MEDIA_DIR、维护状态路径与端口。

注意：check/test/build 的 pre 脚本会生成图片产物。结束时检查 `git diff`，只保留本任务必要变化，不无条件覆盖已有修改。环境不具备依赖、浏览器或 Docker 时，明确记录未验证项，不能称阶段通过。

## 5. P0：品牌去耦合任务

### P0-01 建立兼容 fixture 与品牌/部署配置内核

**读取**：settings.ts、db.ts、migrations.ts、security.ts、auth.ts、request-cache.ts、migrations/server/request-cache tests。

**修改范围**：新增配置模块、追加兼容迁移、配置测试与旧库 fixture；本项不修改页面。

**执行**：

1. 建立带 seeded、首页设置、用户、草稿/发布差异、历史和审计的旧库 fixture。
2. 实现第 3.1、3.2 节 Schema、公开投影、品牌读取与事务 CAS 保存。
3. 旧实例仅补缺失 branding 和 auth_issuer；保留原名称与现有首页值。
4. 集中解析环境 origin。生产要求合法绝对 http/https origin，拒绝凭据、query、fragment 和子路径；生产公开部署文档使用 HTTPS，开发回退只用于开发。
5. 统一调用前先为 Origin、Secure、canonical 行为建立回归用例。

**验证**：新增 `tests/site-config.test.mjs`；扩展 migrations/server/request-cache tests。

**完成条件**：合法配置可读写，损坏配置不被覆盖；并发写 409；匿名/编辑者不能保存；公开对象无安全字段；旧内容与设置摘要保持。

### P0-02 打通品牌媒体引用与离线检查

**依赖**：P0-01。

**读取**：media.ts、media-http.ts、media-references.ts、restore-site.mjs、backup-site.mjs、media/backup-site tests。

**修改范围**：媒体引用提取、品牌媒体校验、恢复引用检查；需要时新增受控 favicon 输出适配与测试。

**执行**：

1. 将三个品牌媒体 ID 作为独立引用来源，转换为统一媒体 ID 集合。
2. purge、引用列表、离线恢复使用一致规则；对接受显式 DB 连接的扫描辅助函数复用，避免离线脚本意外打开默认生产库。
3. 保持资源/指南/回收站/修订引用完整。
4. 下架后回退；彻底删除前要求解除配置引用。
5. 实现 favicon 适配时遵守第 3.3 节，不增加任意文件/远程读取入口。

**完成条件**：一张图片即使只被 branding 引用也不能 purge；解除后可按原规则删除；缺图恢复拒绝或按既定回退规则诊断，已有媒体测试保留。

### P0-03 接入前后台、SEO 与主题

**依赖**：P0-02。

**读取/修改**：Layout、AdminLayout、index、about、guides/index、resources/[id]、guides/[slug]、scenarios/[id]、updates、sitemap、robots、catalog、CommitVersion、site/admin CSS、favicon、og-default。

**执行**：

1. 按第 3.3 节逐项接入，不全仓替换 sanjiang。
2. 中性默认图片去除学校字样，使用许可明确素材。
3. 统一强调色 token、hover、主题 meta；保留错误/危险操作语义色。
4. footer 分离实例维护者与软件版权，落实归属开关。
5. 保留 about 的核验、资格、隐私和版权边界。

**验证**：browser/admin-e2e 两套品牌；解析 JSON-LD；390px 与桌面截图；检查源 HTML 的 title/OG/Twitter/canonical。

**完成条件**：自定义品牌所有展示面一致；旧学校字样只出现在保留历史、旧实例配置或明确资源正文；无密钥和配置原文泄漏。

### P0-04 后台品牌编辑与首页并发保护

**依赖**：P0-03。

**读取/修改**：admin/settings、http.ts、settings.ts、site-config.ts、媒体上传/选择 UI、server/admin-e2e tests。

**执行**：

1. 在设置页区分品牌和首页编排表单，各带自己的预期版本/指纹。
2. 显示环境 SITE_URL 的只读值和运维修改说明。
3. 增加媒体选择/上传、说明、颜色与长度校验反馈。
4. 品牌保存和首页保存分别更新各自键，不相互覆盖。
5. 首页设置以独立元数据版本或事务内原值指纹做 CAS，不为保持旧 JSON 形状而放弃并发检查。

**完成条件**：无需改源码即可换名称、简介、Logo、favicon、分享图、颜色；设置即时生效；直接 POST 越权失败；两个管理员旧页面提交不覆盖新值。

### P0-05 issuer 兼容与阶段回归

**依赖**：P0-04。

**读取/修改**：totp.ts、auth.ts 的 enroll 视图、enroll 页面、totp/totp-server/admin-e2e tests；README、NOTICE 现行定位。

**执行**：

1. 服务端读取冻结 issuer，作为参数交给纯 URI 构造函数。
2. enroll 视图返回实际 issuer，页面和二维码一致。
3. 测试旧实例、新实例、品牌改名、编码特殊字符和二维码解码。
4. 运行 P0 阶段质量门。

**完成条件**：改名后旧会话/TOTP 仍有效；密钥、算法与恢复码语义不变；无非必要的认证撤销。

## 6. P1：初始化与基础产品化任务

### P1-01 Empty/Demo 初始化服务与 CLI

**依赖**：P0。

**读取/修改**：db.ts、初始化模块/CLI、create-admin.mjs、package scripts、migrations；新增 `tests/initialization.test.mjs`。

**执行**：

1. 将 seed 分支替换为第 3.5 节状态机，保留数据库惰性打开。
2. default Empty；显式 Demo；初始化事务与完成标记。
3. CLI 支持 mode/name，验证输入，旧库参数不触发模式转换。
4. 保留原管理员 CLI 与应急创建能力。
5. 对异常“有业务数据但缺标记”库给出诊断，不自动修复或覆盖。

**完成条件**：空文件、新路径、重试、两初始化进程竞争、旧 seeded 空站、异常库、故障回滚全部通过；无弱密码或默认账户。

### P1-02 分离 Demo、素材与测试数据

**依赖**：P1-01。

**读取/修改**：resources.ts、图片 CREDITS、catalog/server/browser/admin-e2e tests、图片构建脚本及必要打包路径。

**执行**：

1. 系统默认分类与 Demo 数据分离；核心 Resource 类型引用 resource-schema，不维护重复业务接口。
2. Demo 使用小量明确示例；不默认装入授权未确认截图，不伪造当前核验日期。
3. 将业务测试所需资源改为显式 fixture，保留 Demo 专项测试。
4. 普通测试不依赖默认 zotero、资源数量或固定“三步”。
5. 保留原始采集与安全证据；现有数据库内容不自动修改。

**完成条件**：Empty 零资源测试与 Demo 测试各自稳定；搜索/图片测试在明确 fixture 下仍覆盖原能力。

### P1-03 scope 全链路

**依赖**：P1-02。

**读取/修改**：resource-schema、store 全部资源读取/保存/恢复/发布、资源编辑器序列化、ResourceDetail、index、scenarios、预览、revision-fields、相关 tests。

**执行**：

1. 实现第 3.6 节 union 与旧读取兼容。
2. 表单显式序列化 scope；学校输入不影响 access。
3. 列表/详情显示范围，unknown 有提示，学校专属不混为通用。
4. 保存只改草稿；历史恢复不批量改原修订。
5. 对原 12 条资源列出待人工审核项，不批量升级为 global/verified。

**完成条件**：旧快照可读；新非法字段拒绝；草稿/公开独立；旧修订恢复范围为 unknown；核验日期与资格说明保持。

### P1-04 v3 内容导入导出

**依赖**：P1-03。

**读取/修改**：importer、api/export、api/import/preview、http import 动作、admin/import、server/admin-e2e tests。

**执行**：

1. 共享版本分发与归一化，按第 3.6 节接受旧版、拒绝未来版。
2. 导出 v3，增加安全 branding 投影；不导出部署环境与认证数据。
3. 首页/品牌分别确认，默认不选；无字段不覆盖目标配置。
4. 预检冻结品牌、媒体和内容；应用重新核对，保留原 uid/version 防护。
5. 清楚报告 JSON 只导草稿、媒体缺失与逐条失败，不新增未经设计的媒体搬运。

**完成条件**：无版本、v1、v2、v3 fixture 均按规格工作；版本 999 写入前拒绝；预检后改品牌/媒体返回冲突；编辑者不可导入导出。

### P1-05 备份恢复可靠性

**依赖**：P1-04。

**读取/修改**：migrations/db、backup-site、restore-site、restore-db、restore-prepare、media 引用辅助；backup/restore/migrations tests。

**执行**：

1. 三个数据库入口在迁移前共用未知迁移拒绝。
2. 旧备份暂存升级，新增品牌媒体与设置完整性核对。
3. 比较关键业务摘要，认证净化单独断言。
4. 分别注入切换前、DB/对象移动之间、切换后校验失败；验证原 DB 与 sidecar 的保全/恢复。
5. 硬中断需可诊断与恢复：若不能自动回滚，提供明确日志、离线恢复步骤与测试证据，不宣称全自动。
6. 保留旧备份 magic，密钥单独保管。

**完成条件**：坏备份/未来 schema 不改变目标；有效恢复媒体齐全；会话等按安全语义清空；失败现场有可验证的恢复路径。

### P1-06 部署文档、隔离安装与 CI

**依赖**：P1-05。

**读取/修改**：Dockerfile、docker-compose、.env.example、ci.yml、README、FEATURES、deploy-docker、deploy-local、operations；新增 configuration/initialization/branding/resource-policy/upgrade 文档及容器测试。

**执行**：

1. 所有会访问 DB 的初始化入口/容器配置一致，maintenance 不触发 Demo 回灌。
2. 更新 Empty、Demo、内容 Import 与完整恢复说明。
3. 定时 DB 快照明确标为诊断；提供宿主机停写全站备份流程，不直接替换为在线 site:backup，不挂 Docker socket。
4. 统一 Node 支持声明，镜像保留运维 CLI 所需源码和依赖。
5. CI 保留原门槛，新增 Empty/Demo、品牌配置、旧库升级、全站恢复与两实例隔离。
6. 文档给出停止服务后使用一次性工具容器的步骤，不在已停止 app 上执行 exec。

**完成条件**：按文档在干净卷安装、改品牌、导入、升级、备份、回滚成功；两实例内容/账户/广告预留设置不相互影响；P1 阶段质量门通过。

## 7. P2：静态赞助任务

### 7.1 固定数据与安全规则

新增 `sponsors` 表：

| 字段 | 规则 |
|---|---|
| id | 服务端随机稳定 ID |
| version | INTEGER，默认 1，更新时 CAS |
| title | 1–100 字 |
| body | 0–300 字纯文本 |
| sponsor_name | 1–100 字，公开来源 |
| media_id | 可空，媒体外键 ON DELETE RESTRICT |
| image_alt | 有图时 1–300 字 |
| target_url | 合法绝对 HTTPS，最多 2048 字 |
| placement | `home-sidebar` 或 `catalog-promotion` |
| enabled | 0/1，默认 0 |
| starts_at / ends_at | 可空，规范化 UTC；两者存在时 start < end |
| created_at / updated_at | 服务端生成 |
| created_by / updated_by | 操作人标识，保留审计信息 |

总开关 `settings.sponsors`：`{ "schemaVersion": 1, "version": 1, "enabled": false }`，缺行等于关闭，CAS 保存。

有效展示条件：总开关开启、单项启用、`start <= now < end`、所需媒体可用。null 边界代表无该方向限制。服务器以 UTC 计算，后台标注输入时区并明确转换。

每位置最多一个生效项；启用/修改时在事务中检查重叠，不能只检查“当前是否展示”。区间为空一端时作为无限边界处理。

target_url：拒绝其他协议、协议相对 URL、凭据、控制字符、localhost、回环和明显私有 IP；用 URL 解析而非字符串前缀。展示目标 hostname 供管理员审核。服务端不抓取广告 URL，不下载远程素材；URL 检查不保证第三方后续跳转内容。

素材要求：ready、未下架、rights confirmed、有 credit。纯文本卡片可无图。全部商业赞助固定显示“广告 · 赞助”，不提供关闭标识字段。

### P2-01 表、Schema、管理员服务

**依赖**：P1。

**修改范围**：追加迁移、sponsor-schema、sponsors 服务、总开关、sponsors/server tests。

**执行**：按 7.1 建表；事务内实时 admin 校验、CAS、媒体/URL/时间校验；变更和审计同事务。创建默认停用，关闭总开关不删除数据。保留 created 字段，更新仅改 updated 字段。

**完成条件**：匿名 401、编辑者 403、伪造 role 无效、降级旧页面无效；并发 409；审计失败业务回滚；重叠时间拒绝；边界时刻行为确定。

### P2-02 媒体与备份扩展

**依赖**：P2-01。

**修改范围**：媒体引用图、restore/backup 业务核对、media/backup-site tests。

**执行**：包括停用/过期活动的 media_id，直到明确移除引用才可 purge；全站备份恢复包含赞助表、开关与图片。普通内容 JSON 不增加广告导入功能。

**完成条件**：赞助唯一引用阻止 purge；图片下架即时停止图片型赞助展示；恢复活动内容、开关、图片与业务摘要一致；旧备份获得空表和关闭默认值。

### P2-03 后台与前台展示

**依赖**：P2-02。

**修改范围**：admin/sponsors、http actions、AdminLayout 导航、SponsorSlot、index、样式、about、admin/browser tests。

**执行**：

1. 新建/编辑/预览/启停/删除活动与总开关；动作均走现有 manage/安全模式。
2. sidebar 位置进入现有 aside；移动端转正常流，不浮层、不遮挡。
3. catalog 推广区独立于 `[data-resource]`、搜索结果数量和资源 ItemList。
4. 无生效内容时不渲染容器、不设占位高度。
5. 外链 `rel="sponsored noopener noreferrer"`；不挂资源 outbound 统计属性。
6. about 根据功能启用情况准确说明本地赞助、不做画像；不扩 CSP 来源。

**完成条件**：关闭/空/过期/缺图状态均无空位；无第三方脚本/像素/广告 Cookie；键盘、屏幕阅读与移动端可用；资源核验、筛选和数量不变。

### P2-04 安全与阶段验收

**依赖**：P2-03。

**修改范围**：赞助安全/浏览器/恢复测试、`docs/sponsorship.md`，必要缺陷修复。

**执行**：覆盖 javascript/data/伪造协议、HTML、控制字符、畸形时间、媒体状态并发变化、表单重复字段、直接 API 越权、缺 Origin/CSRF、撤销会话和审计失败。

**完成条件**：第 9 节 A08–A13 及完整阶段质量门通过。第三方 SDK、计费、自助投放与点击画像不在本阶段。

## 8. P3：发行与长期维护任务

### P3-01 发行物与治理文档

**依赖**：P1；若发行包含赞助则同时依赖 P2。

**修改范围**：Dockerfile、package/build-revision、拟新增 compose.release.yml、README、CONTRIBUTING、SECURITY、第三方许可清单、NOTICE。

**执行**：

1. 保留开发 Compose，发行 Compose 直接拉固定镜像；app/maintenance 使用同一 digest。
2. 镜像带 LICENSE、NOTICE、必要第三方 notices 和 OCI source/version/revision/license 元数据。
3. 源码归档无 .git 时可识别版本；Commit 注入使用可验证完整 SHA。
4. 先支持经实际验证的平台；镜像瘦身不得删除运维脚本依赖。
5. SECURITY 的私密渠道必须由维护者确认真实可用；未确认前标明待配置，不虚构邮箱。
6. MIT 原文不改；页面归属可隐藏，但分发许可文本保留。

**完成条件**：发行 Compose 无源码构建需求；镜像运行、管理员 CLI、备份恢复工具均可用；许可完整、支持范围明确。

### P3-02 Tag / Release / 可选 GHCR

**依赖**：P3-01。

**修改范围**：新增 release workflow、对应文档与版本校验。

**执行**：受控 `vX.Y.Z` → 校验 package version → 同提交 CI → 镜像构建验收 → 可选 GHCR → digest → Release。PR 无发布权限；packages:write 与 contents:write 分离到必要 job。首次只准备可审查工作流，实际发布依用户授权。

**完成条件**：候选流程或不推送的构建验证通过；Tag、SHA、版本、digest 可追溯；无权限令牌泄漏；没有未经验证的多架构声明。

### P3-03 升级回滚演练与维护政策

**依赖**：P3-02。

**修改范围**：upgrade 文档、容器验收、版本支持说明、必要缺陷修复。

**执行**：按第 10 节完成一轮旧版本 → 候选版本 → 恢复升级前批次 → 旧版本；记录可重复命令、数据核对与恢复结果。主题预设、动态分享图和 SBOM/证明可独立后续任务，不阻塞基础发行。

**完成条件**：完整演练可复现；文档清楚区分程序回退与数据恢复；离线准备发行物后核心运行无中央依赖。

## 9. 验收矩阵与测试改造

### 9.1 场景矩阵

| ID | 场景 | 测试位置 | 可观察的通过条件 |
|---|---|---|---|
| A01 | Empty | 新 initialization test + browser | 零资源/指南、无账号、必要分类、空态可用、重跑不变 |
| A02 | Demo | initialization/catalog/browser | 明确示例标记，无弱账号，不重复导入，无默认未授权素材 |
| A03 | 品牌自定义 | site-config/admin-e2e | 名称/Logo/简介/主题无需源码修改，保存即时生效 |
| A04 | 品牌一致 | browser/admin-e2e | 前后台、登录、SEO、OG、Twitter、JSON-LD 一致 |
| A05 | 旧库升级 | migrations + 新 upgrade test | 草稿/公开/用户/修订/审计/设置/媒体稳定摘要不变，普通升级保会话 |
| A06 | 旧文件 | server/importer/admin-e2e | 无版本/v1/v2 正常预检导草稿，未来版本拒绝，品牌不隐式覆盖 |
| A07 | 旧字段 | scope/store/browser | 缺 scope 为 unknown，学校范围与 access 独立，发布前不公开草稿变化 |
| A08 | 广告默认 | sponsors/browser | 关闭/空/过期不渲染容器，无空白、第三方请求与追踪 |
| A09 | 权限 | server/sponsors/site-config | 匿名/编辑者拒绝，伪造角色与旧页面不能越权写入 |
| A10 | 广告校验 | sponsor-schema/media/http | 危险 URL、注入、缺媒体拒绝，媒体引用保护有效 |
| A11 | 安全兼容 | 原认证/媒体/恢复测试 | TOTP、撤销、CSRF/Origin、限流、媒体、恢复净化继续通过 |
| A12 | Docker 运维 | 新 docker-smoke + backup/restore | 安装、升级、完整备份、恢复、失败回滚按文档可验证 |
| A13 | 实例隔离 | 两 Compose project 临时卷 | 相同用户名仍独立，账户/内容/品牌/赞助不共享 |
| A14 | 无中央服务 | 限制出网的本地服务场景 | 浏览、配置、认证、内容管理、媒体和离线运维正常 |

A14 不要求外部资源页面或主动外链检查在断网下成功；这些是部署者主动使用的外部访问。容器网络需允许浏览器测试访问本地服务，不以完全禁网导致不可访问来误判。

### 9.2 原测试保留清单

| 文件/组 | 保留能力 | 需要调整 |
|---|---|---|
| server.test.mjs | 权限、草稿发布、版本/UID、审计事务、导入冲突 | 显式 fixture，初始化分 Empty/Demo |
| migrations.test.mjs | 旧库升级、幂等、乱序补迁移 | 新头部迁移、未来版本、数据摘要 |
| totp.test / totp-server.test | RFC 向量、加密、挑战、恢复码、重放、撤销、fail-closed | 旧/新 issuer 及改名兼容 |
| media.test.mjs | 重编码、元数据清除、容量/占位、路径/引用、下架 | 品牌/赞助唯一引用、授权状态 |
| backup/backup-site/restore | 完整性、坏备份、WAL、认证净化、媒体 | 新配置/广告、未知 schema、阶段故障/硬中断 |
| catalog.test.mjs | 内容质量、ID、来源、图片描述 | 固定三步变 Schema 范围；种子仅 Demo 专项 |
| browser/admin-e2e | 交互、响应式、无 JS 阅读、后台流程 | 去掉生产默认品牌/ID/数量假设，保留业务断言 |
| markdown/linkcheck/maintenance/request-cache/draft-recovery | 既有安全与一致性 | 只因实际新依赖扩充，不删断言迁就改造 |

所有新集成 fixture 在 import 实现前设置临时 DATABASE_PATH/MEDIA_DIR。测试清理仅删除自身创建并校验归属的临时目录。

### 9.3 故障用例

初始化中断；迁移中断重跑；审计失败；两管理员并发；缺 COMPLETE；DB/对象哈希错误；媒体占位未结算；旧 WAL/SHM；未来 schema；恢复各切换阶段异常；进程硬中断；磁盘不足；品牌或广告唯一图片引用；旧备份缺新表。

失败后验证目标未被错误覆盖或可以按明确记录恢复。数量一致不足以通过，需比较草稿/公开 JSON、历史、配置与媒体摘要。

## 10. 发布、升级与回滚运行手册规格

### 10.1 发行清单

版本号、不可变 Tag、完整 SHA、Release notes、固定镜像 digest、发行 Compose、环境示例、支持 Node/平台、迁移与导入/备份兼容范围、升级回滚要求、许可证/第三方 notices。

推荐先以 `v0.3.0-rc.*` 验证再稳定；最终版本号由实际实施起点决定。`private:true` 只限制 npm 发布，不阻止 GHCR。

### 10.2 升级顺序

1. 阅读 Release，确认来源版本兼容；记录旧镜像 digest、配置和迁移头。
2. 提前准备新旧镜像/源码依赖，确认 TOTP_ENC_KEY 单独保管且可用。
3. 停 app、maintenance、cron/timer 和手动写入者，确认无其他容器共享写入卷。
4. 用旧发行工具执行离线 site:backup，验证 COMPLETE 与全部哈希。
5. 在隔离副本上用目标版本演练迁移，核对内容和媒体。
6. 正式启动目标 app，验证健康、品牌、登录、媒体、草稿与发布。
7. 通过后启动 maintenance，恢复正常访问。

### 10.3 失败回退

- 仅当 Release 明确声明数据格式双向兼容时，允许只回退镜像。
- 否则先停写、保存故障现场，用旧版本恢复工具恢复升级前 DB+媒体同批备份，再运行旧程序。
- 恢复会丢失备份后的写入，并撤销会话/挑战/恢复码；应重新登录并生成新恢复码。
- 保留原 TOTP 加密密钥。站点备份不代替密钥备份。
- 不使用 `down -v`；不直接用 cp 覆盖带 WAL 的生产库；不让新恢复工具先升级备份后交旧程序。

### 10.4 自动备份边界

maintenance 的在线 DB 快照标为诊断；全站备份要求停写。第一版由宿主机维护流程协调停服务、备份、验证和重启，可配 timer。容器不持有 Docker socket。无停机快照协议另立任务。

## 11. 许可证、内容与审核

- MIT 代码许可不因启用赞助改变，保留 CreateCN 版权与许可文本。
- 资源方的软件/课程条款、截图、商标和依赖许可分别核对。
- 旧截图授权未明的，不作为默认通用发行素材；已有站点内容不在升级中批量删改。
- 原 12 条资源逐条审核；尤其 Inkscape、智慧教育平台不因改造变 verified，GitHub Education 不承诺所有学校或个人通过。
- 非官方声明通用化，不暗示高校采购、资源方授权或上游背书。
- 商业发布时另行核查品牌、广告经营与实际地区规则，不将软件功能标识当作自动合规证明。

责任：上游维护程序与安全发行；部署者负责实例内容、账号、隐私、备份和广告审核；资源提供方决定资格/价格/可用性；广告主负责素材与商业声明。

参考：

- [GitHub 镜像发布](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker digest 固定镜像](https://docs.docker.com/reference/cli/docker/image/pull/)
- [互联网广告管理办法](https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2023/art_d93a579afd45413e8576e4623fab348f.html)
- [互联网广告可识别性执法指南](https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/ggjgs/art/2024/art_89824524f2804c5594e95408fbdf8602.html)

外部文档在实际发行/广告上线前重新核实。商标研究、法律定性不是编码任务的隐含扩展。

## 12. 执行提示词与交接模板

### 12.1 单任务调用模板

```text
请阅读 docs/design/productization-deepseek-v4.1-flash.md。

本轮授权实施：<任务编号>。
先完成预检，并检查该任务前置依赖是否成立。
按该任务的读取文件、修改范围、模块契约和完成条件执行。
保留当前其他修改；验证使用临时数据库和媒体目录。
只完成本任务，不自动进入下一任务，不创建提交、发布或部署。
结束按文档第 12.2 节报告实际结果。
```

若用户明确授权连续任务，按依赖逐个完成，每个任务仍独立验证。耗尽上下文或遇环境阻塞时记录准确断点，不将未测项目标成通过。

### 12.2 每项任务完成报告

```markdown
任务：P0-01
状态：完成 / 未完成 / 环境阻塞
基线：<commit 与已有修改摘要>

变化：
- <文件：具体行为与原因>

验证：
- <实际命令>：通过 / 失败 / 未运行；<结果摘要>
- <场景编号>：<可观察证据>

兼容性：
- <旧数据、权限、认证、导入、媒体的实际检查结果>

未完成项：
- <失败原因、依赖或缺失环境；没有则写无>

下一步：<下一个可执行任务编号与起点>
```

### 12.3 最终完成判据

- P0/P1 全部完成并通过阶段门，才可称“基础通用化完成”。
- P2 完成并通过后，才可称“静态赞助模块完成”。
- P3 的发行物、完整运维演练与授权发布分别报告，不能相互替代。
- 报告只使用真实执行证据；静态读到测试代码不能写“测试已通过”。
- 本任务书创建时所有工程任务均待实施，文档中的拟议文件和接口不是现有能力声明。
