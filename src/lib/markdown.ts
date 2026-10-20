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
