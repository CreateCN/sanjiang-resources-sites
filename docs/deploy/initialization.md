# 新实例初始化

新库只会被初始化一次。之后升级、重启或修改环境变量都不会重新灌入示例内容。

## 1. 状态机

| 数据库状态 | 行为 |
|---|---|
| 有初始化完成标记 | 只跑迁移，不写种子 |
| 旧实例（只有 `seeded=1`） | 只跑迁移，保留原分类、内容、账户与设置 |
| 没有任何业务数据的新库 | 按 `empty` 或 `demo` 原子初始化 |
| 有业务数据但缺少标记 | 拒绝自动写入，给出诊断；需要显式 `--adopt` |

"新库"不是按文件是否存在判断：预创建的空文件、刚跑完迁移但没有数据的库都可以安全初始化；
初始化事务失败会整体回滚，修复后可以重试。

## 2. 两种模式

| 模式 | 内容 | 适合 |
|---|---|---|
| `empty`（默认） | 一个 `general/综合资源` 分类；0 条资源、0 篇指南；默认品牌 | 正式站点 |
| `demo` | 2 条通用示例（Zotero、LibreOffice）；前台显示"演示内容"横幅 | 体验界面 |

两种模式都**不会创建默认账户**。Demo 示例不带截图、不写核验日期；退出演示标记只隐藏提示，
不修改内容或发布状态。

## 3. 本地安装

```bash
npm ci
npm run site:init -- --mode empty --name "你的实例名称"
# 或显式体验模式
npm run site:init -- --mode demo --name "示例站"

npm run db:admin
npm run dev
```

也可以只对一次启动使用环境变量（仅新库生效）：

```bash
SITE_INIT_MODE=demo SITE_INIT_NAME="示例站" npm run dev
```

## 4. Docker

先构建镜像；需要选择 Demo 时，在第一次 `up` 之前用一次性容器初始化（app 未运行）：

```bash
docker compose build
docker compose run --rm --no-deps app node scripts/init-site.mjs --mode demo --name "示例站"
docker compose up -d
```

不指定模式时，app 首次启动会按 `SITE_INIT_MODE`（默认 `empty`）初始化。
app 与 maintenance 必须使用同一个 `SITE_INIT_MODE`/`SITE_INIT_NAME`；compose 已经同步。
维护容器不会向已初始化实例灌入 Demo。

## 5. 已有实例与异常库

- 同模式重跑：`already-initialized`，不写入；
- 不同模式重跑：拒绝自动转换，不提供隐式清库；
- 旧实例：只迁移，不转换模式；
- 有业务数据但缺标记：应用启动会失败并提示。确认数据归属后，停止写入者并执行：

```bash
npm run site:init -- --mode empty --adopt --name "接管后的名称"
# Docker（app 已停止）
docker compose run --rm --no-deps app node scripts/init-site.mjs --mode empty --adopt --name "接管后的名称"
```

`--adopt` 只补缺失配置与标记，不写示例内容、不删除旧数据。只有分类完全为空时才补 `general`；已有任意分类（包括原 `general` 或自定义分类）保留原集合与名称。它不能配合 `--mode demo`。

## 6. 初始化、内容导入与灾备恢复的区别

| 操作 | 用途 | 会覆盖什么 |
|---|---|---|
| `site:init` | 新库第一次建立分类/品牌/标记 | 只在完全空库写入；异常库需显式 `--adopt` |
| 内容 JSON 导入 | 批量添加/更新草稿 | 只写草稿；首页/品牌需单独勾选 |
| `site:restore` | 整站灾备（DB + 媒体） | 替换数据库与媒体，按安全语义清空认证 |

内容导入不是初始化，也不会创建首个管理员。完整恢复前必须停止所有写入者，步骤见
[升级与回滚](../ops/upgrade.md) 与 [运维](../ops/operations.md)。

## 7. 初始化后检查

```bash
curl -fsS http://127.0.0.1:4321/api/health/ | grep '"db":"ok"'
curl -fsS http://127.0.0.1:4321/ | grep "站点名称"
```

- 后台登录并确认品牌、首页编排；
- 修改品牌不会改变已冻结的 TOTP issuer；
- 需要对外发布前，先删除/替换 Demo 示例并重新核验。
