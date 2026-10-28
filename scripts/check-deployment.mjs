#!/usr/bin/env node
/**
 * 部署配置自检：只检查**进程可见的配置**，不探测网络、不连接外部目标。
 *
 *   node scripts/check-deployment.mjs            # 普通检查
 *   node scripts/check-deployment.mjs --strict   # 把"可运行但降级"的提示升级为错误
 *
 * 它回答三个问题（另有一条 `info` 提示说明"边缘限速无法自动判定"）：
 * 1. `SITE_URL` 是否是一个可用于 Origin 校验与 Cookie 的绝对地址；
 * 2. `TRUST_PROXY=1` 时是否配置了可用于验证代理的共享凭据（`TRUST_PROXY_SECRET`，
 *    长度 ≥ 16）。缺失时应用 fail closed：所有请求按不可信身份处理，只吃站点级限流；
 * 3. `TRUST_PROXY=0` 时是否仍由代理注入转发头——应用无法自己判断这一点，
 *    只能提示部署者检查代理配置。
 *
 * **不判断**宿主机端口发布或容器网络拓扑：应用进程看不到 Docker 的端口映射，
 * 也不该声称能检测。那部分靠 compose 绑定地址、`ss -lntp` 与部署文档。
 *
 * 判定逻辑导出为 `evaluateDeployment(env, { strict })`，测试直接调用它，
 * 不依赖"再起一个 Node 子进程"——子进程启动失败（EAGAIN/超时/被信号终止）会让
 * 断言退化成"stdout 为空"，看起来像配置问题，实际是执行环境问题。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSiteUrl } from '../src/server/deployment-config.ts';
import { PROXY_SECRET_MIN_LENGTH } from '../src/server/security.ts';

/**
 * 评估一份部署配置。纯函数：只读入参 `env`，不读 `process.env`、不写文件、不退出进程。
 * @param {Record<string, string | undefined>} env
 * @param {{ strict?: boolean }} [options]
 */
export function evaluateDeployment(env = process.env, options = {}) {
  const strict = Boolean(options.strict);
  const findings = [];
  /**
   * 记录一条结论。`--strict` 在这里统一把 warn 升级为 error：
   * 发布门禁要能兑现"降级也算失败"，否则调用点各自判断会漏（终审 P2 就是漏了 HTTP 那条）。
   * 被升级的项保留 `raised: true`，方便运维区分"本来就是错误"和"严格模式下才算错误"。
   */
  const report = (level, code, message) => {
    const raised = strict && level === 'warn';
    findings.push({ level: raised ? 'error' : level, code, message, ...(raised ? { raised: true } : {}) });
  };

  const site = parseSiteUrl(env.SITE_URL);
  if (!site.configured) {
    report('error', 'site-url-missing', '生产环境必须配置 SITE_URL；缺失时 Origin 校验与 Cookie 安全属性无法确定');
  } else if (!site.valid) {
    report('error', 'site-url-invalid', `SITE_URL 不合法：${site.error}`);
  } else if (env.NODE_ENV === 'production' && !site.secure) {
    report('warn', 'site-url-not-https', '生产环境的 SITE_URL 不是 https://，Session Cookie 不会带 Secure，HSTS 也不会下发');
  }

  const trustProxy = /^(1|true|on|yes)$/i.test(env.TRUST_PROXY ?? '');
  const secret = (env.TRUST_PROXY_SECRET ?? '').trim();
  if (trustProxy) {
    if (!secret) {
      report('error', 'proxy-secret-missing',
        'TRUST_PROXY=1 但没有配置 TRUST_PROXY_SECRET：应用无法验证转发头确实来自本代理，'
        + '所有请求会按不可信身份处理（仅站点级限流）。请设置长度 ≥ 16 的共享凭据，'
        + '并让代理写入 X-Sanjiang-Proxy-Secret，或关闭 TRUST_PROXY');
    } else if (secret.length < PROXY_SECRET_MIN_LENGTH) {
      report('error', 'proxy-secret-weak',
        `TRUST_PROXY_SECRET 长度不足 ${PROXY_SECRET_MIN_LENGTH}，按未配置处理（fail closed）；请换成长随机值`);
    } else {
      report('info', 'trust-mode', '限流身份来自已验证的代理：代理必须覆盖写单值 X-Forwarded-For 并携带共享凭据');
    }
  } else {
    report('info', 'trust-mode', 'TRUST_PROXY 未启用：只按连接对端地址分桶；若前面有反向代理，所有访客会共享同一个桶');
    report('warn', 'proxy-header-check',
      '请确认反向代理没有注入 X-Forwarded-For：该头存在时应用无法确认对端，会一律按不可信身份处理');
  }

  // 边缘限速无法由应用进程判定：只做提示，**不声称**已检测到 Nginx/CDN 的 limit_req。
  // 用 info 而不是 warn——`--strict` 会把 warn 升级成 error，一条不可自动判定的项
  // 会让严格模式永远失败，把真正的降级信号淹掉。
  report('info', 'edge-rate-limit',
    '边缘按真实 IP 的限速无法自动检查：本脚本不检测 Nginx/CDN 的 limit_req/limit_conn，'
    + '也不代表它们已经配置。请人工确认 /api/login/、/api/login/totp/、/api/login/enroll/ '
    + '三个认证端点共用同一条按还原后 $remote_addr 的限速，并按 docs/edge-cdn-hardening.md §3b 实测验收');

  const errors = findings.filter((finding) => finding.level === 'error');
  return { event: 'deployment-check', status: errors.length > 0 ? 'error' : 'ok', strict, findings };
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  const result = evaluateDeployment(process.env, { strict: process.argv.includes('--strict') });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ok') process.exitCode = 1;
}
