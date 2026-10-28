# 贡献指南

## 环境

- Node.js **24.x**、npm；
- SQLite 由 `node:sqlite` 提供，不需要外部数据库；
- Docker 仅用于容器冒烟与发行验证。

```bash
npm ci
npm run images:build
npm test
npm run check
npm run build
```

## 质量门

提交前至少运行：

```bash
npm run check
npm test
npm run build
npm run test:admin
npm run test:browser
npm run test:instances
```

涉及容器、迁移、备份/恢复或发行文件时，再运行：

```bash
bash scripts/container-smoke.sh
```

测试必须覆盖真实行为；不要为了让测试通过而放宽校验、隐藏错误或删除断言。

## 代码约定

- TypeScript 源码由 Node 24 原生类型剥离直接执行；新增脚本保持可被 `node scripts/xxx.mjs` 运行。
- 业务输入用 Zod 校验；数据库迁移只追加、不修改已发布编号。
- 权限检查在事务内重新读取当前用户；不要信任页面传入的角色或版本。
- 写操作与审计同事务；CAS 冲突返回 409，不覆盖他人修改。
- 前端只输出转义文本；不引入第三方广告 SDK、像素或远程脚本。
- 新增依赖必须确认许可、写入 `THIRD-PARTY-NOTICES.md`，并确认镜像仍保留许可文件。

## 安全

- 漏洞报告遵循 [SECURITY.md](SECURITY.md)；渠道确认前不要公开敏感细节。
- 不要提交密钥、令牌、真实用户数据、生产数据库或备份。
- 涉及 URL/媒体/恢复/认证的改动，需补充拒绝路径与回滚测试。

## 文档与发行

- 用户可见行为变化同步更新 `README.md`、`docs/FEATURES.md` 与相关操作文档。
- 改文档后跑 `npm run docs:check`（校验链接、锚点与索引覆盖）；在 `docs/` 下新增文档时同步登记到 `docs/README.md`，设计文档登记到 `docs/design/README.md`。
- 版本号在 `package.json`；发行镜像使用完整 40 位提交 SHA 与 `scripts/build-image.sh` 构建。
- 发行标签与 Release 由维护者授权；PR 不触发 `.github/workflows/release.yml`，也不应修改版本标签。
- 发布前先跑 workflow dry-run（`push_image=false`、`create_release=false`），确认镜像验收与 digest 元数据。
- 发行步骤、支持范围与许可检查见 [docs/release.md](docs/release.md)。
- 不修改 `LICENSE` 的 MIT 原文；新增第三方组件时更新 `NOTICE`/`THIRD-PARTY-NOTICES.md`。

## 提交与 PR

- 一个 PR 聚焦一个主题；说明用户可见变化、迁移/兼容性、测试证据与回滚方式。
- 不提交生成物（`dist/`、`node_modules/`、备份、临时数据库）。
- 不在 PR 中附加真实凭据、个人数据或未授权素材。
- 维护者可按 issue 标签与领域文档约定处理；见 `docs/agents/`。
