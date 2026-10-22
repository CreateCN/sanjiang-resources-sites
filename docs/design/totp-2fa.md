# 设计：后台 TOTP 双因素认证

> 状态：**P0 已实现（2026-10-22）**；§14 已合入 [SECURITY-SPEC](../SECURITY-SPEC.md) v1.5。
> 迁移：`010-totp-2fa`（已应用）。P1（密钥轮换 `TOTP_ENC_KEY_OLD`）与 P2（WebAuthn）未实现。
>
> 实现相对本文的差异（均不削弱约束）：
> - 挑战 Cookie 名 `sanjiang_mfa`，`Path=/`、`HttpOnly`、`SameSite=Strict`、`Max-Age=300`，HTTPS 站点加 `Secure`；清除时除 `Max-Age=0` 外属性一致。
> - 最终事务实现为 `auth.ts#commitVerifiedChallenge` / `confirmEnrollment`；条件更新 `WHERE auth_version=? AND (totp_last_step IS NULL OR totp_last_step < ?)`。
> - 撤销助手集中在 `store.ts#revokeAuthProofs/bumpAuthVersion`；`updateUser` 在改密/改角色/启用状态变化时递增代次。
> - 恢复净化抽到 `src/server/restore-prepare.ts`，`restore-db` 与 `restore-site` 共用；审计动作名 `restore-purge`。
> - 策略切换脚本 `scripts/set-totp-policy.mjs`；CLI 重置 `scripts/reset-totp.mjs`。
> - 二维码生成失败时注册页退回手输密钥（`EnrollView.qrError`），不阻断验证码确认。
> - `qrcode@1.5.4`（MIT）为运行时依赖；`@types/qrcode`、`jsqr@1.4.0`（仅测试用，独立解码）为开发依赖。

## 1. 现有约束

| 现状 | 约束 |
|---|---|
| `auth.ts#login` 口令通过即发会话，`getSession` 被后台页面和 CSRF 校验共用 | 拆分口令验证与会话签发；`getSession` 保持“完全认证 / 未认证”，不能引入半认证 session |
| `users.version` 保护人员表单；改密/角色变更/停用撤销全部会话 | 新增独立 `auth_version` 表示凭据代次，挑战必须绑定；保留 UI 的 version 乐观锁 |
| `login` 已在签发事务中复查密码哈希和 active | 两步登录同样要在最终事务复查有效状态及凭据代次，不能相信几分钟前的口令结果 |
| 无邮件找回；唯一有效管理员不可被停用/降级 | P0 必须有 CLI 与另一管理员的恢复路径，强制策略不得先于恢复演练上线 |
| 现有失败计数、Origin/CSRF、审计规则 | 复用安全原语，分别核算口令、第二因子和挑战发行成本；每个新写入口直接验证权限 |

## 2. 范围与基本决策

- 使用 TOTP（RFC 6238）、一次性恢复码；不新增短信、邮件、WebAuthn 或“记住设备”。
- 独立 `login_challenges`：32 字节随机 token，DB 只存 SHA-256，5 分钟，绑定客户端身份、用途和 `auth_version`，最多 5 次失败。
- 挑战 Cookie：`sanjiang_mfa`，**`Path=/`**、HttpOnly、SameSite=Strict、Max-Age=300；HTTPS/SITE_URL 使用 HTTPS 时必须 Secure，不设置 Domain。页面与 `/api/login/*` 都能接收；Path 不充当授权边界。
- Cookie 只作为挑战凭据，不产生后台身份。缺失、重复或形状不符一律拒绝；消费、作废、退出挑战时用同一 Path 清除。token 不进入 URL、HTML 隐藏字段、日志或浏览器存储。
- `TOTP_REQUIRED_FOR=off|admin|admin,editor`，初始 off；未知值拒绝认证相关操作并给出配置错误，不能当作 off。
- **P0 使用 QRCode 扫码绑定，并以服务端校验 6 位验证码完成启用。** 新增服务端运行依赖 `qrcode`（以 `QRCode` 导入），必要时增加开发类型依赖 `@types/qrcode`；只生成二维码，不承担 TOTP 验证。TOTP/AES 仍使用 `node:crypto`，不增加客户端第三方脚本；手输密钥保留为扫码不可用时的备用入口。

## 3. 数据模型（迁移 `010-totp-2fa`）

使用幂等迁移，为现有账户回填 `auth_version=1`；不自动启用 2FA。

```sql
-- users 新增字段（实际迁移先 hasColumn 再 ALTER）
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_confirmed_at TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('login','enroll')),
  client_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  pending_secret TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK(expires_at > created_at),
  CHECK((purpose='enroll' AND pending_secret IS NOT NULL)
     OR (purpose='login' AND pending_secret IS NULL))
);
CREATE INDEX IF NOT EXISTS login_challenges_user ON login_challenges(user_id);
CREATE INDEX IF NOT EXISTS login_challenges_expiry ON login_challenges(expires_at);

CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY(user_id, code_hash)
);
```

用户状态只有两种正常状态：secret/confirmed 都为空为未启用，两者均有值为已启用。待确认密钥只在挑战 `pending_secret` 中。部分字段不一致属于异常，登录 fail-closed 并提示运维恢复，不自动降级口令登录。

- `auth_version` 只递增，不复用；凭据/认证策略相关的账户变更时递增，见 §9。TOTP 每次成功仅更新 last_step，不递增此版本，避免合法并行登录互相作废。
- TOTP 设置变更同时递增人员表单 `users.version`，防旧人员表单覆盖安全设置；旧版普通人员管理入口也必须执行 §9 的撤销规则。
- 过期和已消费挑战设保留上限，由维护清理。过期不会触发 ON DELETE CASCADE：任务必须显式删除挑战行及其 pending_secret，不能只依赖用户删除。

## 4. 密钥管理与算法

- `TOTP_ENC_KEY` 为 32 字节 base64url 随机密钥；密文 `v1:<iv>:<tag>:<ct>` 使用 AES-256-GCM，12 字节随机 IV、16 字节 tag，AAD=`user:<id>`，严格检查格式、长度及版本。
- 密钥与 DB 分开备份；备份记录非秘密的密钥版本标识，运维保留恢复旧备份所需的历史密钥。仅恢复 DB 不等于恢复 TOTP 登录能力。
- 缺失/非法密钥不影响匿名公开站；所有需要密钥的启用、验证、重生成等路径返回 503。已启用用户或策略要求用户不能因此退回口令登录；CLI 离线重置不依赖解密。
- P1 轮换工具支持 `TOTP_ENC_KEY_OLD`，逐账户解密后在事务中重加密并审计数量；混合新旧密文期间显式支持两把钥匙。轮换不改变 TOTP 秘密及 auth_version，不作凭据重置。不得在仍需恢复旧备份时销毁旧钥。
- 20 字节随机 secret，base32 无填充；TOTP HMAC-SHA1、6 位、30 秒、±1 窗口。固定跑完三个候选，使用 timingSafeEqual；返回匹配步，由事务与当前 last_step 比较，不在纯函数内声称已消费。
- Base32 只接受约定字符/合法长度与零填充位；允许用户输入的空格、连字符和合法尾部填充先归一化。不能粗略按“奇数长度非法”判断。
- 恢复码 10 个，`randomBytes(5)` 产生 40 位随机性，base32 为 `XXXX-XXXX`；去连字符、转大写后的 8 位串用于 `sha256(user_id:normalized_code)`。DB 不存明文；唯一冲突时重新生成。
- 审计与错误不得包含 secret、otpauth URI、验证码、恢复码或密文；带这些数据的页面/响应全部 no-store。

## 5. 统一认证事务

引入仅服务端内部可调用的最终签发函数，接收本次校验所见的账户凭据代次。普通口令登录与第二步均使用它，不能让业务路由绕过校验直接 INSERT session。

**每次兑换最终事务的检查顺序：**

1. `BEGIN IMMEDIATE`，重读挑战和用户：token 哈希、用途、客户端、有效期、未消费、attempts<5、active、`auth_version` 均匹配；当前策略也必须允许该分支。
2. 普通直接口令登录核对第一步验证过的 password_hash 与当前值；第二步必须核对挑战的 auth_version，确认密码证明尚未被改密等动作撤销。
3. `login` 只允许当前已启用的账户，校验的密文必须仍是当前密文；TOTP 命中步必须大于**事务中重读的** last_step。`enroll` 只允许当前仍未启用、pending_secret 属于本挑战的账户。
4. TOTP 更新以 `WHERE auth_version=? AND (totp_last_step IS NULL OR totp_last_step < ?)` 条件执行，检查恰好更新一行；恢复码以 `UPDATE ... SET used_at=? WHERE ... AND used_at IS NULL` 检查一行。
5. 条件消费挑战（`consumed_at IS NULL` 等）并检查更新一行；需要时安装因子/撤销旧凭据；创建最终 session、修剪到含新会话最多 10 个、写审计。
6. COMMIT 后才给浏览器 session Cookie，清除挑战 Cookie、重置成功路径相关账号失败计数。审计失败则凭据消费/last_step/会话全部回滚。

密码哈希、解密和 HMAC 可在事务外计算以缩短锁占用，但只能提交对当前凭据代次、密文及状态仍然有效的结果。失败次数、挑战作废与对应限流计数在明确的短事务中结算；不能抛错先回滚掉失败预算。事务中不得嵌套现有自带 BEGIN 的限流 helper，需复用同连接的内部操作。

并发两个挑战使用同一 TOTP/恢复码只能一个成功。并发两个 enroll 只能一个安装因子，后者必须重新登录，不能覆盖第一个密钥。这也是 [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238#section-5.2) 一次性验证要求的事务落点。

## 6. 登录时序

### 6.1 第一步：`POST /api/login/`

`requireOrigin → readForm(96 KiB) → 原有 login-client/login-user 限流 → 通用口令校验`。

| 当前状态 | 策略 | 结果 |
|---|---|---|
| 未启用 | off 或该角色不强制 | 事务复核账户状态/密码证明/当前策略后签最终会话，兼容现状 |
| 已启用 | 任意 | 建 purpose=login 挑战，不发 session |
| 未启用 | 该角色强制 | 建 purpose=enroll 挑战，pending_secret 加密，不发 session |
| 字段不一致、所需密钥不可用 | 任意 | 拒绝认证，不能口令降级 |

挑战发行也要事务重查账户状态/代次；新建前执行发行限流，清理该用户过期挑战。保留最多 3 个未消费有效挑战，超出拒绝发行（不自动作废其他浏览器的有效挑战）。303 跳到 `/admin/login/totp/` 或 `/admin/login/enroll/`，设置 Path=/ 的挑战 Cookie。口令通过但还需第二步时不清除 login-user 失败计数。

### 6.2 第二步：`POST /api/login/totp/`

Origin + 有界表单 → 验证挑战 Cookie → 校验用途及客户端 → 分层限流 → 6 位数字走 TOTP，规范恢复码走恢复分支 → §5 最终事务 → 303 `/admin/`，签 session 并清挑战 Cookie。

失败统一“验证码不正确或登录请求已失效”，不回显输入。五次失败作废挑战，但重新获取挑战不重置 totp-user / recovery-user 的累计失败预算。

### 6.3 首次注册：`POST /api/login/enroll/`

1. GET 注册页凭有效 enroll 挑战显示服务端生成的 QRCode、分组密钥备用入口和 6 位验证码输入框，无后台权限；响应 no-store。刷新须复用该挑战的 pending_secret，不重新生成秘密；二维码生成与校验见 §6.4。
2. POST 需要 Origin、挑战、客户端与注册验证码；不能仅凭“我已保存”按钮完成注册。限流/尝试预算与第二步一致。
3. §5 同一事务内：核对仍未启用及代次 → 校验 pending_secret 的码 → 消费挑战 → 安装 secret/confirmed/last_step → 生成并登记恢复码哈希 → auth_version/version 递增 → 撤销所有旧 session 和其余挑战 → 创建一个新最终 session → 审计。
4. 成功响应 **200 HTML，同时设置最终 session Cookie、清除挑战 Cookie**，一次性显示 10 个恢复码（no-store、转义、不得进入 URL/日志）。页面“我已保存，进入后台”只是普通 GET 导航，不签发、不重复兑换任何凭据。
5. 若响应丢失，因子已经启用，用户用已绑定设备重新登录后可重新生成恢复码；不重显旧恢复码。关闭/刷新结果页不重新执行安装操作。

这一流程也用于自愿启用：`begin-totp-enroll` 需现有 session+CSRF+再次输入当前口令；只对未启用账户发行 enroll 挑战。已启用账户禁止通过 begin 覆盖密钥，必须走明确的停用/恢复流程。

### 6.4 QRCode 与扫码确认（P0 必须）

**用户流程：**“使用验证器扫码” → 设备添加账号 → 输入设备当前显示的 6 位验证码 → 服务端验证成功才启用 → 展示一次性恢复码。二维码被展示、被扫描或用户点击“已扫码”，都不构成验证成功。

**生成契约：**

- QRCode 仅在合法、未消费、未过期、用途为 enroll 且认证代次匹配的挑战页生成。服务器解密该挑战的 pending_secret；不接受客户端传入 secret、otpauth URI、账号或 issuer 来决定绑定对象。
- issuer 固定为“三江资源”，账号使用挑战所属用户的规范用户名；label 的 issuer 前缀与 query 的 issuer 相同。参数固定 `algorithm=SHA1`、`digits=6`、`period=30`，secret 为该挑战的无填充 base32。
- 标签各部分单独进行 URI 编码，query 使用 URLSearchParams；secret/issuer 不能未经编码直接拼接用户输入。依据 [Key URI 格式](https://github.com/google/google-authenticator/wiki/Key-Uri-Format) 构造，示意实现如下：

```ts
import QRCode from 'qrcode';

const issuer = '三江资源';
const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(user.username)}`;
const query = new URLSearchParams({
  secret: pendingSecret,
  issuer,
  algorithm: 'SHA1',
  digits: '6',
  period: '30',
});
const uri = `otpauth://totp/${label}?${query.toString()}`;
const svg = await QRCode.toString(uri, {
  type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 320,
  color: { dark: '#000000ff', light: '#ffffffff' },
});
```

- 使用 [node-qrcode 的服务端 SVG 输出](https://github.com/soldair/node-qrcode#tostringtext-options-cberror-string)，在注册 HTML 内嵌生成结果，不新增可公开访问或可缓存的二维码文件/URL，不上传媒体库，也不请求第三方二维码服务。依赖评审并锁定 package-lock，实施时添加到 package.json；本提案阶段不安装。
- SVG 的原始标记只来自该固定配置的库输出；不得拼入用户名、标题、样式或任何外来 SVG/HTML。可访问名称放在外部受模板转义的容器上。QRCode 数据编码在图案中，不把 URI 用作图像请求 URL；不放宽任意用户内容的 HTML/SVG 白名单。
- 二维码与 secret 都是敏感凭据：页面 no-store/noindex，禁止持久化、审计、分析埋点或记录响应正文；测试截图和 trace 仅允许临时账号数据。备用手输密钥由同一 pending_secret 产生，复制无需第三方 JS。
- 生成失败显示“二维码暂时无法生成，可手动输入密钥”并保留验证码确认；不启用账户、不发行会话、不自动更换秘密或绕过 §5。挑战过期后停止展示，明确要求重新开始绑定。

**校验契约：**

- 确认 POST 只接受验证码，secret 必须来自 HttpOnly 挑战对应的服务端记录；缺码、非 6 位数字、其他秘密生成的码、过期/已消费挑战和已撤销代次均不能完成绑定。
- 客户端可提示输入格式，但只有服务端 `verifyTotp` 与 §5 原子提交决定成功；注册确认不接受恢复码，因为本次绑定尚未生成恢复码。
- 正确码必须对应展示二维码中同一 secret，遵守 ±1 步与 last_step 防重放。错误码不更换二维码，在原挑战上累计尝试；达到 5 次失败则作废，旧二维码对应挑战不能再用于确认。
- 不接收“扫码成功”的布尔值或客户端校验结果作为认证证明。二维码只用于配置验证器，后续登录仍输入 TOTP/恢复码，不要求每次重新绑定。

## 7. 路由与输出

| 路由 | 方法 | 规则 |
|---|---|---|
| `/api/login/` | POST | 口令检查、直接最终会话或发行挑战 |
| `/api/login/totp/` | POST | 挑战+TOTP/恢复码兑换最终会话 |
| `/api/login/enroll/` | POST | 确认注册并返回一次性恢复码页和最终会话 |
| `/admin/login/totp/` | GET | 挑战输入页；无会话也可访问，无写副作用 |
| `/admin/login/enroll/` | GET | 同一待确认秘密的 QRCode 与验证码输入页；刷新不生成/更换秘密 |
| `/admin/security/` | GET | 完全认证用户的安全设置，不展示已有 secret/旧恢复码 |
| `/api/manage/` | POST | begin-totp-enroll / disable-totp / regenerate-recovery / reset-totp |

所有登录挑战页、恢复码结果页都 no-store/noindex，不复用需要完整会话的后台 Layout 鉴权逻辑；最小登录 Layout 不引第三方资源。登录 API 不用现有 session CSRF，而以严格 Origin+挑战 Cookie 防跨站；管理动作仍需 session+CSRF+实时授权。

管理员、编辑者都能管理自己的因子；仅管理员能重置他人。安全表单含人员 version，发生冲突返回 409。敏感动作要重新核对口令；已启用账户还须当前 TOTP 或恢复码，证明消费与变更同事务，不能用点击确认框代替。

## 8. 限流与挑战容量

| scope | identity | 额度 / 窗口 | 计数语义 |
|---|---|---|---|
| login-user | 规范用户名 | 10 / 15min | 仅口令失败 |
| login-client | clientIdentity | 30 / 15min | 仅口令失败 |
| totp-user | 规范用户名 | 10 / 15min | 仅 TOTP 失败（含注册确认） |
| totp-client | clientIdentity | 30 / 15min | TOTP、恢复码及无效挑战请求失败 |
| totp-recovery-user | 规范用户名 | 3 / 60min | 仅恢复码失败 |
| enroll-client | clientIdentity | 5 / 60min | 新建 enroll 挑战 |
| challenge-user | 规范用户名 | 10 / 15min | 所有挑战发行，防正确口令无限建行 |
| challenge-client | clientIdentity | 30 / 15min | 所有挑战发行 |

- 继承现有 clientIdentity 的可信代理契约；不把 UA 或任意 XFF 当作唯一身份。客户端网络变化会使挑战失效，用户重新走第一步。
- 无效/未知 token 只能计客户端预算，不允许根据未验证的 user_id 影响任意账号。合法挑战失败同时累计自身 attempts 与相应账号/客户端预算。
- 不因为恢复码预算耗尽就禁止合法 TOTP：按输入形状选择对应的账号失败桶，共用客户端失败桶。畸形输入计挑战失败并受客户端预算约束。
- 发行配额为请求计数，不在成功时清零；第二步成功只清本次认证相关的账号失败桶，不清客户端累计或另一因子的失败桶。
- 限流常量集中定义；429 的 Retry-After 取真实剩余窗口。维护删除过期/已消费挑战，定期报告数量，不泄漏凭据。

## 9. 凭据代次与撤销矩阵

实现一个事务内部使用的认证状态变更 helper；所有入口包括 `updateUser`、CLI 必须复用规则。撤销会话、挑战、恢复码和审计不能分散到几个独立事务。

| 动作 | auth_version | sessions / challenges | 恢复码与因子 |
|---|---|---|---|
| 正常 TOTP/恢复码登录 | 不变 | 只消费当前挑战；会话总数≤10 | 更新 last_step 或原子消费一码 |
| 首次启用确认 | +1 | 全部旧会话/挑战撤销，再签一个最终会话 | 安装因子与新恢复码 |
| 停用/管理员或 CLI 重置 | +1 | 全部撤销，不自动签会话 | 清 secret/confirmed/last_step 和恢复码 |
| 重新生成恢复码 | +1 | 全部旧会话/挑战撤销，给本人签一个最终会话 | 旧码全部失效，新码只显示一次；secret 保持 |
| 改密/改角色/停用或重新启用账号 | +1 | 全部撤销 | 因子保留；对失窃凭据另执行重置 |
| 密钥轮换（明文因子未变） | 不变 | 保持，必须支持轮换期间密文读写一致性 | 恢复码不变 |

上述安全设置变更同时递增 users.version；普通人员保存是否真实改变认证字段按既有逻辑判断，但 auth_version 不能被旧表单带回。

自助停用需要口令+因子，策略要求该角色时 403。管理员重置他人还需要操作者口令、其已启用时的当前因子、目标 version 和确认理由。管理员不得借“重置他人”路径重置自己；自助重置受同一策略约束，设备完全丢失走另一管理员或离线 CLI。

强制策略更改只能在停止 app/登录写入后执行配套运维命令：递增受影响账户 auth_version、撤销其会话及挑战、记录审计，再带新配置启动。禁止仅改环境变量就假定旧会话已完成新策略要求。

## 10. 恢复与运维（P0）

- `/admin/users/` 的 `reset-totp`：按 §9 验证操作者及目标状态，重置、版本递增、撤销与审计同事务。被重置者在 off 下可口令登录，强制策略下进入 enroll；页面必须明确此差别。
- `scripts/reset-totp.mjs <username> --yes`：明确目标并离线运行；先停 app/maintenance/认证脚本，清目标因子与恢复码、递增两个版本、撤销全部会话及挑战、审计 actor=cli。不依赖加密密钥，不静默改密或关掉全站强制策略。
- `scripts/set-totp-policy.mjs --from <值> --to <值> --yes`：离线执行 §9 的受影响账户撤销及审计，运维同步配置后启动；同值重复执行不应恢复任何旧证明。
- 密钥遗失：优先恢复与备份匹配的密钥；否则逐个 CLI 重置并完成新设备注册。疑似失窃同时改密，不能把重置 2FA 当作修复泄漏口令。
- TOTP 启用前必须演练唯一管理员丢设备/丢恢复码、加密密钥丢失和 DB 恢复三条路径。P0 没有已验证 CLI 与管理员重置入口时，禁止开放启用或强制策略。
- P0 必须同步扩展现有 `scripts/restore-db.mjs`：在独立暂存库完成受支持迁移和下述认证净化，再验证为独立一致性快照，才允许替换目标；异常不修改原库。后续媒体 `restore-site` 复用同一净化 hook，不允许另留一个能恢复旧会话的入口。
- 站点恢复保留旧业务数据，但**不恢复认证证明**：恢复后、开放 app 前，离线清空 sessions/login_challenges，递增全部账户 auth_version，并审计恢复事件。恢复码与 last_step 可能倒退：恢复后先作废所有旧恢复码，用户通过 TOTP 登录后重新生成，丢设备者走 CLI/管理员重置；保留因子的账户将 last_step 至少提高到恢复时 `currentStep + WINDOW`，恢复后的可用验证码必须严格晚于该步，避免重放刚才已经使用的码（文案提示等待最多约 90 秒）。服务器时钟须先同步；无法保证因子未泄漏/备份可信时一并重置因子。不得直接让备份中的已消费挑战或旧 session 再度生效。

## 11. 灰度与实施范围

1. P0 QRCode 扫码绑定及服务端验证码确认、全流程、恢复工具和恢复演练完成；默认 `TOTP_REQUIRED_FOR=off`，运维已配置独立备份的加密密钥。
2. 自愿启用管理员，观察登录、失败、恢复操作至少一周；观察期不是自动切换定时器，操作者确认恢复能力和异常率后再强制。
3. 停服务，执行策略变更撤销命令，配置 admin，重启；未启用管理员下次以口令启动首次注册，这是注册引导，不宣称已有第二因子保护。
4. 回退强制范围仍走策略变更流程；off 只取消强制注册，已启用账户仍需因子。禁止因密钥缺失、校验失败或配置解析失败自动降级。
5. CI 临时库显式设策略 off，不继承开发者/宿主机密钥；新增启用/强制用例独立生成临时密钥与可控时钟，并覆盖真实浏览器的 Cookie 与表单流程。

## 12. 测试清单

单元 `tests/totp.test.mjs`：

1. RFC 6238 Appendix B 的 SHA-1 向量，8 位结果取末 6 位；base32 往返、合法归一化、非法字符/长度/填充位；窗口边界及畸形验证码。
2. AES-GCM 往返、错误 AAD/密钥/tag/版本 fail-closed；密文/URI 不进入错误输出。
3. TOTP 同步步数、恢复码 40 位随机生成、规范化、哈希归属及冲突重生成。

QRCode 生成与独立解码集成（P0）：生成 SVG 后用现有 sharp 栅格化，再由独立二维码解码器（只作开发/测试依赖，实施时选定并锁定）解码；断言解出的完整 URI 与待绑定用户、secret、issuer、SHA1/6/30 一致。不能只检查存在一个 SVG。覆盖中文 issuer、标签编码、刷新同挑战图码不变及二维码生成失败的手输回退；用解码取得的 secret 计算验证码并通过真实注册接口完成绑定。

服务端/多连接集成：

4. off 未启用正常登录；已启用只给挑战；强制未启用只给 enroll；密钥缺失与用户字段异常不能口令降级。
5. 每个挑战过期/用途/客户端/attempts/消费状态校验；重新发行不重置失败预算；无效 token 不能扣任意用户预算；恢复码桶耗尽不阻断合法 TOTP。
6. 先拿挑战再改密/改角色/停用后重启用/重置因子/重生成恢复码，旧挑战一律失败且不发会话。
7. 两个有效挑战同时提交同一步 TOTP、同一恢复码、同一 token，恰好一次成功；两个 enroll 竞争只安装一个密钥；旧 enroll 不得覆盖已启用因子。
8. 审计故障时恢复码消费、last_step、挑战消费、因子安装及 session 全部回滚；失败计数不能随业务异常被清零。
9. 人员和自助表单版本冲突、CSRF/Origin、编辑者 reset 他人、管理员通过 reset 路径重置自己均按规则拒绝；敏感动作缺少新鲜证明不能执行。
10. 007/008 库升级、010 单独安装、009 后补和迁移幂等；不得为凑序号创建媒体表的占位迁移。
11. 普通登录会话上限、改密会话撤销、自助改密、最后管理员保护均回归。
12. 单管理员恢复、失钥恢复、恢复旧 DB 后旧会话/挑战不复活，恢复码轮换；策略变更会清理旧认证证明。

真实浏览器（并入 `tests/admin-e2e.mjs`）：

13. 口令→挑战 GET 页→API POST，确认三个路径实际收到/不收到正确 Cookie；未完成因子不能访问任一后台/API；Cookie 缺失、重复、过期、HTTPS Secure 与清除一致。
14. 首次注册展示可解码 QRCode，使用图中 secret 生成正确验证码后 POST 才返回恢复码页和最终 session；错误码、未提交码、仅点击“已扫码”均不启用；刷新/返回/“我已保存”导航不会重新注册或签发会话；响应丢失仍能用设备重新登录。
15. 自愿启用、强制注册、恢复码登录和管理员重置完整流程；在至少一种实际 TOTP 验证器完成扫码与码值互通验收，测试重放/过期挑战不能确认；结果页 no-store/noindex、无第三方请求；日志、trace 工件不得发布真实密钥/恢复码（只用临时测试凭据）。

## 13. 交付阶段

| 阶段 | 内容 | 放行条件 |
|---|---|---|
| P0 | 010、QRCode 生成/扫码绑定与服务端校验、密码/因子/挑战状态机、单次事务兑换、一次性恢复码页、账户安全页、管理员重置、CLI 重置/策略变更、恢复净化、限流与完整测试 | 浏览器登录及并发用例通过，唯一管理员/失钥/DB 恢复演练通过后才开放启用 |
| P1 | 密钥轮换工具、会话管理体验改进 | 不改变 P0 的 Cookie/代次/撤销及恢复契约 |
| P2 | WebAuthn 独立提案，评估设备记忆等需求 | 单独威胁建模与规范评审 |

## 14. SECURITY-SPEC 增补草案（实施前合入）

- §4.5：TOTP ≤±1 步、恒定时间比较、AES-GCM+AAD 用户绑定、加密密钥与 DB 分离；无密钥/无效配置不能降级登录。
- §4.5：口令结果用 ≤5min 的一次性挑战承载，禁止半认证 session；HttpOnly/SameSite=Strict、HTTPS Secure、Path 必须同时覆盖输入与 API；禁止凭据进入 URL/日志。
- §4.5/§5.1：挑战绑定 auth_version 与用途；凭据、安全设置及策略变更撤销所有旧证明。注册只安装一次；校验与单次消费、步数、恢复码、会话、审计同事务。
- §4.5：P0 必须提供服务器生成的 QRCode；secret、账号与参数来自有效注册挑战；必须验证该 secret 对应的验证码才启用，扫码或客户端回报不能代替验证。二维码与密钥同级保护、禁止第三方生成/持久化/缓存。
- §4.5：注册 POST 一次性展示恢复码并签最终 session，GET 导航不签发；恢复码只存哈希，重生成撤销旧码与挑战；敏感设置需要新鲜证明。
- §4.4/§9.5：CLI 与管理员恢复、策略切换撤销、旧 DB 恢复净化均为首批上线门禁；不能把恢复工具延期后先上线强制认证。
- §4.2/§6：§8 的分层失败计数、发行成本、挑战数量上限与保留期；成功不能刷掉客户端及无关因子预算。
- §11.1：§12 的跨连接重放/注册竞争、旧挑战撤销、故障回滚、真实 Cookie 路径与恢复演练必须覆盖。
