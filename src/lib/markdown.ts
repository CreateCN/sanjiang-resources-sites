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
const MEDIA_MASTER = /^\/media\/[a-f0-9]{64}\.webp$/;

/**
 * 图片只允许站内静态路径：`/images/...`（构建期资源）或 `/media/<sha256>.webp`
 * （已登记的运行时媒体主图）。先要求字面量前缀，再用 URL 解析处理编码与路径段，
 * 最后重复解码检查 ..、空段和控制字符；远程、协议相对、data: 以及绝对 URL
 * 即使指向本站也不接受。
 */
export function siteImageSource(source: string): string | null {
  const value = source.trim();
  if (MEDIA_MASTER.test(value)) return value;
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
  // 运行时媒体可能已下架/缺失：SSR 传入可用性判定，绝不再输出指向 404 的 <img>。
  if (source.startsWith('/media/')) {
    const available = (env as { mediaAvailable?: (src: string) => boolean } | undefined)?.mediaAvailable;
    if (available && !available(source)) {
      const alt = markdown.utils.escapeHtml(token.content ?? '');
      return `<span class="media-missing" role="img" aria-label="${alt}">（图片已下架）${alt}</span>`;
    }
  }
  token.attrSet('src', source);
  return defaultImage(tokens, index, options, env, self);
};

function checked(input: string): string {
  if (input.length > LIMIT) throw new Error('Markdown 文本过长');
  return input;
}

export interface MarkdownOptions {
  /** 运行时媒体可用性判定；未提供时按语法层渲染（后台预览等未保存内容）。 */
  mediaAvailable?: (src: string) => boolean;
}

/** 用于简介、许可、资格等单行字段：只产出内联元素，不产生块级结构。 */
export function renderInlineMarkdown(input: string, options: MarkdownOptions = {}): string {
  return markdown.renderInline(checked(input), { mediaAvailable: options.mediaAvailable });
}

/** 用于“详细说明”等正文：允许标题、列表、引用、代码块与表格。 */
export function renderMarkdown(input: string, options: MarkdownOptions = {}): string {
  return markdown.render(checked(input), { mediaAvailable: options.mediaAvailable });
}

/**
 * 提取真正会渲染成 `<img>` 的图片地址（含引用式语法）。
 * 引用扫描与渲染共用同一 Markdown 配置，避免"扫描用的规则和渲染用的规则不一致"。
 */
export function extractImageSources(input: string): string[] {
  if (!input) return [];
  const sources: string[] = [];
  const walk = (tokens: ReturnType<typeof markdown.parse>): void => {
    for (const token of tokens) {
      if (token.type === 'image') {
        const source = siteImageSource(token.attrGet('src') ?? '');
        if (source) sources.push(source);
      }
      if (token.children) walk(token.children);
    }
  };
  walk(markdown.parse(checked(input), {}));
  return sources;
}
