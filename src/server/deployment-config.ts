/**
 * 部署环境配置的唯一解析入口。
 *
 * 规则（任务书 §3.1 / P0-01）：
 * - SITE_URL 是唯一权威 origin 来源；页面、canonical、Origin 校验、Cookie Secure
 *   与 HSTS 都从这里取，不再各自拼字符串。
 * - 生产环境必须显式配置合法绝对 http/https origin；拒绝凭据、query、fragment
 *   与子路径，因为这些都会让 canonical 和 Origin 校验产生歧义。
 * - 开发回退（请求 origin / localhost）只用于非生产环境。
 * - 本模块不读数据库，也不向页面暴露任何密钥或完整环境变量。
 */

export class SiteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteConfigError';
  }
}

export interface SiteUrlState {
  configured: boolean;
  valid: boolean;
  origin: string | null;
  secure: boolean;
  /** 配置存在但不合法时的具体原因；缺省时由 resolve* 决定生产是否报错。 */
  error: string | null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** 纯校验：不读环境、不抛异常，便于后台只读展示与测试。 */
export function parseSiteUrl(raw: string | null | undefined): SiteUrlState {
  const value = raw?.trim() ?? '';
  if (!value) return { configured: false, valid: false, origin: null, secure: false, error: null };
  let url: URL;
  try { url = new URL(value); } catch {
    return { configured: true, valid: false, origin: null, secure: false, error: 'SITE_URL 必须是绝对地址，例如 https://resources.example.edu' };
  }
  const protocol = url.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { configured: true, valid: false, origin: null, secure: false, error: 'SITE_URL 只接受 http 或 https' };
  }
  if (url.username || url.password) {
    return { configured: true, valid: false, origin: null, secure: false, error: 'SITE_URL 不能包含用户名或密码' };
  }
  if (url.search || url.hash) {
    return { configured: true, valid: false, origin: null, secure: false, error: 'SITE_URL 不能包含查询参数或片段' };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { configured: true, valid: false, origin: null, secure: false, error: '第一版只支持根路径部署，SITE_URL 不能包含子路径' };
  }
  return { configured: true, valid: true, origin: url.origin, secure: protocol === 'https:', error: null };
}

export function siteUrlState(raw: string | null | undefined = process.env.SITE_URL): SiteUrlState {
  return parseSiteUrl(raw);
}

/**
 * 权威 origin。requestUrl 仅用于开发环境的请求回退；
 * 生产缺少 SITE_URL 或配置非法时抛错，由调用方 fail-closed。
 */
export function resolveSiteOrigin(requestUrl?: URL): string {
  const state = siteUrlState();
  if (state.configured) {
    if (!state.valid || !state.origin) throw new SiteConfigError(state.error ?? 'SITE_URL 不合法');
    return state.origin;
  }
  if (isProduction()) throw new SiteConfigError('生产环境必须配置 SITE_URL');
  if (requestUrl) return requestUrl.origin;
  return 'http://localhost:4321';
}

/**
 * 校验一次请求的 Origin 时使用的期望 origin。
 * 开发环境保留 Node 适配器的 Host 回退：适配器在未配置 host 校验时会把 URL
 * 重建成裸 `localhost`，此时浏览器实际访问的 Host 头才是可靠来源；
 * X-Forwarded-Proto 只参与协议，不能扩大 host。
 */
export function resolveRequestOrigin(request: Request): string {
  const state = siteUrlState();
  if (state.configured) {
    if (!state.valid || !state.origin) throw new SiteConfigError(state.error ?? 'SITE_URL 不合法');
    return state.origin;
  }
  if (isProduction()) throw new SiteConfigError('生产环境必须配置 SITE_URL');
  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (host && url.hostname === 'localhost' && !url.port) {
    const protocol = request.headers.get('x-forwarded-proto') === 'https' ? 'https' : url.protocol.replace(':', '');
    return `${protocol}://${host}`;
  }
  return url.origin;
}

/** Cookie Secure / HSTS 的统一判断：解析失败一律按不安全处理。 */
export function isSecureSite(requestUrl?: URL): boolean {
  try { return resolveSiteOrigin(requestUrl).startsWith('https://'); } catch { return false; }
}
