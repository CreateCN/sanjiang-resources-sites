# 第三方组件与许可

本文件列出运行时直接依赖及其许可。完整许可文本随镜像中的 `node_modules/<包>/LICENSE` 一起分发；本文件不修改这些许可。

| 组件 | 运行时版本 | 许可 | 项目 |
|---|---|---|---|
| Astro | 5.18.2 | MIT | https://astro.build/ |
| @astrojs/node | 9.5.5 | MIT | https://docs.astro.build/en/guides/integrations-guide/node/ |
| markdown-it | 14.3.3 | MIT | https://github.com/markdown-it/markdown-it |
| qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode |
| sharp | 0.34.5 | Apache-2.0 | https://sharp.pixelplumbing.com/ |
| undici | 8.12.3 | MIT | https://undici.nodejs.org/ |
| zod | 3.25.76 | MIT | https://zod.dev/ |

## sharp / libvips

`sharp` 以 Apache-2.0 分发，并依赖预编译的 libvips 二进制（`@img/sharp-libvips-*`，LGPL-3.0-or-later）。镜像保留：

- `node_modules/sharp/LICENSE`（Apache-2.0）
- `node_modules/@img/sharp-linux-*/LICENSE`（Apache-2.0）
- `node_modules/@img/sharp-libvips-*/README.md`（列出捆绑库及许可）
- `licenses/LGPL-3.0.txt`（libvips 的 LGPL-3.0-or-later 文本）

这些文件是相应组件的完整许可文本或入口；分发镜像时不要删除。

## 基础镜像与系统库

运行时基于 `node:24-bookworm-slim`（Debian）。Node.js、Debian 及基础镜像内系统库的许可与版权声明随基础镜像分发；本仓库的 MIT 许可不覆盖它们。

## 不在本文件范围

- 站内收录的第三方软件、课程、服务与其页面内容；
- 资源截图、商标与官方文案（权利归各提供方）；
- 部署者自行加入的插件、反向代理、CDN 或监控组件。

## 维护

升级直接依赖时同步更新本表，并在镜像构建后检查上述许可文件仍存在。发布检查见 `docs/release.md`。
