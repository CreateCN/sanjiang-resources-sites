# 三江资源：本地生产部署黑盒安全审查

> 环境状态更新（2026-10-21）：按用户要求，两轮任务创建的容器、专用网络、数据卷、测试镜像、临时证书及凭据已撤回。下文部署地址、账号和容器状态为审查时的历史记录，当前已不可用。

审查日期：2026-10-21（北京时间）。审查请求主要发生于 18:22—18:28；18:29 后切换为干净数据库并完成交付冒烟检查。

## 结论

发现 **1 项中风险可用性问题**：文档推荐的反向代理部署下，匿名反馈额度在不同访客之间共享，可被单人用少量请求耗尽。另记录 **1 项低风险认证策略风险**：针对已知账号触发限流后，另一网络地址使用正确密码也不能登录。第二项属于账号锁定的安全与可用性权衡，不是密码绕过。

在本次覆盖范围内，未复现认证绕过、编辑者提权、草稿公开泄露、可执行 XSS、内网 SSRF 或敏感文件下载。这个结论仅适用于实际测试的输入和部署，不能推导为不存在其他漏洞。

未阅读业务源码、构建后的服务端代码、现有测试或 `scripts/security-audit.mjs`；未修改任何原有源码、配置或文档。只阅读 README、功能清单、AGENTS、package.json、Dockerfile、Compose 和环境变量示例，以部署和明确功能边界。页面 HTML、HTTP 响应、运行日志属于黑盒观察对象。构建会执行项目现有脚本，但不进行源码分析。

## 环境、边界与交付状态

- 基准提交：`135033be93159fcefa23a9a7b7ebb5453613c8ef`。开始时工作区已有 `README.md` 修改，以及未跟踪的 `docs/product/FEATURES.md`、`scripts/security-audit.mjs`；均保留。
- 使用现有 Dockerfile 重新构建生产镜像 `sanjiang-blackbox:20261021`，运行生产入口；没有使用开发服务器。应用镜像 ID 见 [deployment.txt](deployment.txt)。
- 链路：测试客户端 → `https://localhost:8443` → Nginx → 应用 `4321`。`SITE_URL=https://localhost:8443`；数据库完全隔离。Nginx 配置见 [nginx.conf](nginx.conf)。
- Nginx 按 README 剥离来访 `X-Forwarded-For`，并覆盖 `X-Forwarded-Proto`；请求体限制 1 MiB。没有额外添加 WAF、CSP 或限流规则，以便观察应用本身边界。
- HTTPS 使用两天有效的自签名本地测试证书。HTTP 探测客户端仅对本地证书跳过校验；应用的出站 TLS 校验没有被关闭。浏览器未绕过证书警告，公开页的浏览器渲染检查通过环回 HTTP 后端完成；不声称已在受信任 HTTPS 浏览器中走完全部后台流程。
- 匿名、管理员、编辑者三个权限视角。只操作本地测试数据库，不攻击第三方网站、真实云元数据或真实内网服务。内网回显容器仅接入审计网络，没有宿主机公开端口。
- HTTP 索引记录 186 次请求，另有 2 次从独立容器地址发出的对照请求；浏览器检查和最后的干净环境冒烟不计入该数量。见 [http-index.csv](http-index.csv)。

**当前可用的干净部署：** [https://localhost:8443](https://localhost:8443)，仅绑定 `127.0.0.1`。首页、数据库健康检查、管理员登录均通过；攻击测试资源和指南返回 404，见 [clean-deployment-smoke.json](clean-deployment-smoke.json)。

当前容器为 `sanjiang-audit-app`、`sanjiang-audit-nginx`；数据在命名卷 `sanjiang-local-data-20261021`。管理员名 `audit-admin`；随机口令在本机 `/tmp/sanjiang-blackbox-20261021/runtime.env`（权限 0600），不包含在报告中。该文件也供容器重建时使用，应妥善保存。自签名证书是短期审计配置，不应直接用作正式公网证书。

原审计应用已停止并更名为 `sanjiang-audit-evidence-app`，保留测试数据库供复核；`sanjiang-audit-callback` 已停止。交付实例的数据与审计数据分开。没有自动重启策略，主机重启后需要手动启动容器。停止当前服务可运行 `docker stop sanjiang-audit-app sanjiang-audit-nginx`，不会删除命名卷。

## BB-01：匿名反馈共用额度，可被低成本耗尽

**风险：中；已复现。影响：匿名反馈、版权或下架反馈的可用性。前提：能够访问公开反馈接口，无需账号。**

在剥离 `X-Forwarded-For` 的文档推荐代理配置下，先提交带合法 Origin 的反馈。当前窗口内第 1 次成功发生于存储型注入测试，随后又成功提交 4 次；接下来的反馈返回 `429`、`Retry-After: 900`。

随后从另一个容器作为独立访客访问同一个 HTTPS Nginx，并提交合法反馈，也得到 `429`。Nginx 日志确认原客户端地址为 `172.21.0.1`，独立客户端为 `172.21.0.4`。这证明影响跨越两个不同传输来源，而不只是同一个客户端自己的正常限流。

关键证据：

- 第一次成功：[131-feedback-stored-payload.json](evidence/131-feedback-stored-payload.json)。
- 后续成功：[136-feedback-rate-0.json](evidence/136-feedback-rate-0.json) 至 [139-feedback-rate-3.json](evidence/139-feedback-rate-3.json)。
- 额度耗尽：[140-feedback-rate-4.json](evidence/140-feedback-rate-4.json)。
- 独立来源被拒绝：[distinct-client-feedback.txt](evidence/distinct-client-feedback.txt)，来源对照见 [nginx-access.log](nginx-access.log)。

复现步骤（仅对独立测试环境）：

1. 通过当前反向代理访问 `/feedback/`，使用表单实际支持的字段。
2. 在新窗口内依次向 `/api/reports/` 提交 5 次合法表单，设置 `Origin: https://localhost:8443`；示例字段为 `resourceId=`、`kind=其他建议`、`title=Audit`、`body=Controlled local audit submission.`、`website=`。
3. 换另一个真实网络来源或容器，经同一个代理再提交一次。
4. 比较返回状态、`Retry-After` 与代理访问日志中的来源地址。应观察到独立来源也被 429 拒绝。

攻击者只需少量正常格式提交即可占满反馈预算，可能阻断包括版权下架在内的正常反馈。响应宣告等待 900 秒；**没有等待完整窗口验证实际恢复时刻，也没有验证持续续锁能力**，不据此声称永久拒绝服务。

建议：在可信代理边界建立可靠的访客身份并设置分层配额，例如每来源额度和容量更高的站点总保护额度。可以先在 Nginx 按可信连接来源限流，但单靠代理限流不能解除应用已有的共享额度。不能直接透传用户提供的 `X-Forwarded-For`；需要同步设计应用的代理信任配置、规范化身份和防伪造策略。修复验收应包含“两来源互不耗尽配额”和“伪造转发头不能绕过配额”。关于分层限流与服务可用性的设计参考 [OWASP Denial of Service Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html)。

## BB-02：已知账号可被匿名触发跨来源登录锁定

**风险：低；策略风险已复现。影响：指定账号的新登录。前提：知道或猜到账号名。**

在 `audit-admin` 当前登录窗口内再发送错误密码请求，8 次返回 `401`，第 9 次返回 `429`。该窗口此前有成功登录，不能把这次结果解释为“系统固定允许 8 次错误密码”。触发后，使用正确管理员密码仍返回 `429`、`Retry-After: 900`；另一个网络地址使用正确密码也返回 429。其他编辑者账号仍能正常登录，已有管理员会话在退出前也仍可使用。

关键证据：

- 错误密码请求：[165-known-account-failure-0.json](evidence/165-known-account-failure-0.json) 至 [173-known-account-failure-8.json](evidence/173-known-account-failure-8.json)。
- 正确管理员密码被拒：[174-known-valid-account-after-lock.json](evidence/174-known-valid-account-after-lock.json)。
- 不同来源的正确密码也被拒：[distinct-client-login.txt](evidence/distinct-client-login.txt)。
- 不同账号正常登录：[175-other-valid-account-after-lock.json](evidence/175-other-valid-account-after-lock.json)。

这说明限流可以被用于有针对性地阻断账号的新登录，但不代表所有后台账号同时失效，也不代表原有会话被撤销。账户锁定本身具有阻止密码猜测的价值，因此将其作为低风险策略权衡单独记录。没有验证恢复机制、完整锁定时长或持续锁定。

建议：结合可信来源限速、渐进退避、异常登录告警及可控恢复流程，避免把少量匿名失败直接变成对正常用户的长时间硬拒绝。保持统一错误提示，防止账号枚举。参考 [OWASP Authentication Cheat Sheet 的账号锁定与拒绝服务权衡](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)。

## 加固观察（不作为已证实的利用漏洞）

1. 正常首页及后台页面未返回 CSP；部分拒绝响应已返回严格 CSP。已测内容仍正确转义，未因缺少 CSP 执行脚本。建议后续配置经过验证的 nonce/hash 策略，先使用 Report-Only 收集兼容性问题。证据见 [001-home.json](evidence/001-home.json)。这与功能清单中的已知限制一致。
2. 本次临时 Nginx 没有配置 HSTS，健康接口公开迁移标识和 uptime，Nginx 返回版本号。这些是部署加固或少量信息暴露观察，不构成凭据泄露、提权或远程执行证据。HSTS 应在真实 HTTPS 域名和证书稳定后评估；本地自签证书不能代表线上 TLS 配置。

## 已验证的防护与覆盖范围

| 类别 | 实际测试 | 观察结果 |
|---|---|---|
| 匿名访问控制 | 后台、人员、导入、审计、指标、维护、预览、导出 | 302 到登录或 API 401；无数据返回 |
| 编辑者权限 | 人员、设置、导出、分类、发布、撤回、删除、导入 | 管理页面重定向；写操作返回 403；不是仅隐藏按钮 |
| CSRF 与 Origin | 无 CSRF、错误 CSRF、异站 Origin、`null`、无 Origin | 管理写操作均 403；登录 Origin 不合法也被拒绝 |
| 会话 | Cookie 属性、重置密码、退出重放、GET 退出 | HTTPS Cookie 有 Secure / HttpOnly / SameSite=Strict；密码重置后旧会话读操作重定向、写操作 401；退出后旧 Cookie 不能重用；GET 不执行退出 |
| 存储型注入 | 编辑者写入资源/指南标题、简介、Markdown、闭合 script/textarea 载荷；管理员发布；匿名反馈在后台呈现 | 预览、公开资源、公开指南与反馈无注入事件节点；JSON-LD 的 `<` 被转义；浏览器 DOM 中未形成事件节点或 javascript/data 链接 |
| 反射注入及查询边界 | 搜索参数、反馈参数、资源路径中的 HTML 与 SQL 语句 | 未形成可执行注入节点；路径查询未产生数据越权；不代表穷尽 SQL 注入测试 |
| 草稿分离 | 未发布测试资源/指南的公开 URL 和 sitemap | 未发布指南公开 URL 404；sitemap 不含该指南；之后由管理员显式发布才变为 200 |
| SSRF | HTTP、file、javascript 链接，以及 HTTPS 的 IPv4 回环、IPv6 回环、整数形式 IPv4、本地 DNS 名 | 非 HTTPS 保存被拒；HTTPS 私网链接可存草稿，但检查阶段报“不允许检查内网或本机地址”；回显服务无请求记录 |
| 敏感文件与路径 | `.env`、`.git/config`、SQLite、备份路径、package.json、常见源码/构建入口路径、编码穿越 | 404、400 或规范化重定向；未下载到文件内容 |
| HTTP 边界 | CORS 探测、TRACE、伪造 Host/转发头、1.1 MB 请求、非法路径编码、异常 Cookie | 未返回授权跨域读取头；TRACE 405；canonical 不随伪造 Host 改为攻击域；Nginx 拒绝过大请求 413；未出现堆栈泄露或崩溃 |
| 限流对照 | 15 个不同不存在的用户名、随后正确管理员/编辑者登录 | 错误密码被拒；未造成所有账号的全局登录锁定；与 BB-02 的指定账号锁定区分 |
| 最终可用性 | 健康接口及干净环境登录 | 数据库正常；首页 200；干净管理员登录 303 |

存储型注入的浏览器观察为：测试标题中的脚本标签按文字显示；DOM 中 `[onerror],[onload]` 为 0，`javascript:`/`data:` 链接为 0。未读取前端 JS 源码。HTML 和请求证据见 `123-xss-resource-preview`、`127-published-xss-resource`、`130-published-xss-guide` 相关文件。

SSRF 测试没有走到“受信任公网 HTTPS 服务返回到内网的重定向”或 DNS rebinding；这些路径明确未覆盖。HTTP 重定向回显地址在保存时即因非 HTTPS 被拒绝，不能据此宣称已验证重定向防护。私网测试也不等价于枚举全部地址编码或云元数据协议。

## 限制与后续验收

没有做源码审计、依赖漏洞扫描、密码哈希及数据库落盘审计、宿主机/容器逃逸、真实外网攻击、容量压测、请求走私、完整 TLS 扫描或备份恢复演练。对未实现功能没有凭空生成安全结论。没有检查真实生产环境、真实账户或外部数据库。

建议优先处理 BB-01，随后确认 BB-02 的锁定策略是否符合维护者的可用性预期，再推进 CSP 等加固。验收至少用两个独立来源做互不误伤测试，同时验证伪造转发头不能获得新额度；不应通过简单移除登录保护来修复拒绝服务风险。

## 附件说明

- [http-index.csv](http-index.csv)：186 条 HTTP 证据索引；`evidence/` 包含响应元数据与对应 HTML/正文。
- [surface-results.txt](surface-results.txt)、[roles-results.txt](roles-results.txt)、[content-results.txt](content-results.txt)、[deeper-results.txt](deeper-results.txt)、[finalchecks-results.txt](finalchecks-results.txt)：各阶段简要记录。
- [nginx-access.log](nginx-access.log)、[app-runtime.log](app-runtime.log)、[callback.log](callback.log)：审计运行日志；回显日志为空。
- `*.py`：本次新写的黑盒测试驱动，不是项目现有源码。使用临时目录、测试账号和既定顺序；没有打包私有口令与 Cookie 文件，不能原样对真实站点运行。
- [SHA256SUMS](SHA256SUMS)：报告及附件校验和。会话 Cookie、CSRF 值和反馈回执令牌已在交付证据中脱敏；当前部署口令、自签证书私钥及数据库文件未打包。

所有问题只记录和建议，没有实施修复或创建 GitHub issue。
