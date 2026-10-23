# 实例品牌与主题

品牌属于实例数据，不写代码。管理员在 **站点与首页 → 站点品牌** 修改，保存即时生效。

## 1. 字段与限制

| 字段 | 限制 | 展示位置 |
|---|---|---|
| name | trim 后 1–60 字 | 页头、标题后缀、OG/Twitter、后台、JSON-LD |
| subtitle | 0–100 字 | 页头名称下方 |
| description | 0–500 字 | 默认 description、首页引导、WebSite JSON-LD |
| footerText | 0–500 字 | 页脚 |
| organizationName | 0–100 字 | 页脚版权行 |
| nonOfficialStatement | 0–500 字 | 页脚与 about |
| logoMediaId / faviconMediaId / shareImageMediaId | 媒体 ID 或空 | Logo、favicon、OG/Twitter |
| accentColor | `#RRGGBB` | 主题色、按钮、链接、HSTS/主题 meta |
| showProjectAttribution | 布尔 | 页面上游项目与 Commit 展示 |

文案按纯文本处理，由模板转义；不接受 HTML、CSS 或脚本。

## 2. 主题色

- 强调色必须与白色按钮文字达到 **4.5:1** 对比度；
- hover、浅色表面、paper 背景由服务端从强调色派生，不接收第二种颜色或原始 CSS；
- 错误、危险操作保留独立语义色，不跟随主题；
- 修改后前台与后台同时生效，不需要重新构建。

## 3. 媒体

- 只接受媒体库中 `state=ready`、未下架、`rights=confirmed` 且有 credit 的图片；
- favicon 源图至少 **200×200** 像素；
- 下架或删除后页面自动回退：Logo 字形、`/favicon.svg`、`/og-default.png`；
- 彻底删除前必须先解除品牌引用；引用扫描覆盖品牌三个槽位；
- 品牌图片不复制、不转存，仍由 `/media/<id>.webp` 实时提供。

## 4. TOTP issuer

新实例初始化时把实例名称冻结为 TOTP issuer。之后改品牌**不会**改变 issuer、不会撤销会话、
不会要求重新绑定。旧实例升级保留原 issuer（旧版为"三江资源"）。绑定页显示服务端返回的实际值，
与二维码标签一致。

## 5. 归属开关

- 开启：前台/页脚显示上游项目名称、仓库链接与 Commit；后台页脚显示 Commit；
- 关闭：隐藏上游项目与 Commit 展示；MIT 许可说明仍保留，发行物中的 LICENSE/NOTICE 不变；
- 部署者署名（organizationName）与代码版权分离：署名属于实例，MIT 属于上游代码。

## 6. 不提供的自定义

第一版不开放任意 CSS/HTML/JS、主题市场、动态生成带站名的分享图、多语言或子路径部署。
需要新的主题能力时应先补 Schema、校验与回退规则，而不是在页面里直接读环境变量或数据库原文。

## 7. 验收

1. 保存后前台标题、OG、Twitter、JSON-LD、页脚一致；
2. 390px 与桌面无横向溢出；
3. favicon/Logo/分享图在配置与下架两种状态都可用；
4. 改名后既有 TOTP 会话与恢复码仍然有效；
5. 直接 POST 越权、旧版本页面提交返回 403/409。
