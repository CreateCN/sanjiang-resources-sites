import MarkdownIt from 'markdown-it';

const LIMIT = 20000;

/**
 * 资源字段的 Markdown 渲染。
 * html: false 会把原始 HTML 当作文本转义，因此后台写入的 <script>、onerror
 * 等不会进入页面；markdown-it 默认还会拒绝 javascript: / vbscript: / data: 链接。
 */
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const defaultLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (!token) return defaultLinkOpen(tokens, index, options, env, self);
  const href = token.attrGet('href') ?? '';
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, index, options, env, self);
};

const defaultImage = markdown.renderer.rules.image
  ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
const IMAGE_BASE = 'https://site.invalid';

/**
 * 图片只允许站内静态路径。先要求字面量以 /images/ 开头，再用 URL 解析处理
 * 编码与路径段，最后重复解码检查 ..、空段和控制字符；远程、协议相对、data:
 * 以及绝对 URL 即使指向本站也不接受。
 */
function siteImageSource(source: string): string | null {
  const value = source.trim();
  if (!value || !value.startsWith('/images/')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value, IMAGE_BASE); } catch { return null; }
  if (url.origin !== IMAGE_BASE || url.username || url.password || url.search || url.hash) return null;
  let path = url.pathname;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { path = decodeURIComponent(path); } catch { return null; }
  }
  if (!path.startsWith('/images/')) return null;
  const segments = path.slice(1).split('/');
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(segments.join('/'))) return null;
  return url.pathname;
}

markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (!token) return defaultImage(tokens, index, options, env, self);
  const source = siteImageSource(token.attrGet('src') ?? '');
  if (!source) {
    // 不生成 <img>：alt 文本以纯文本保留，避免浏览器发出任何跨源或 data: 请求。
    return markdown.utils.escapeHtml(token.content ?? '');
  }
  token.attrSet('src', source);
  return defaultImage(tokens, index, options, env, self);
};

function checked(input: string): string {
  if (input.length > LIMIT) throw new Error('Markdown 文本过长');
  return input;
}

/** 用于简介、许可、资格等单行字段：只产出内联元素，不产生块级结构。 */
export function renderInlineMarkdown(input: string): string {
  return markdown.renderInline(checked(input));
}

/** 用于“详细说明”等正文：允许标题、列表、引用、代码块与表格。 */
export function renderMarkdown(input: string): string {
  return markdown.render(checked(input));
}
