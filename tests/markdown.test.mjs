import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInlineMarkdown, renderMarkdown } from '../src/lib/markdown.ts';

test('块级 Markdown 渲染标题、列表、引用与表格', () => {
  const html = renderMarkdown('## 先看条件\n\n- 费用\n- 资格\n\n> 引用一句\n\n| 项目 | 值 |\n| --- | --- |\n| 费用 | 免费 |');
  assert.match(html, /<h2>先看条件<\/h2>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<table>/);
});

test('内联 Markdown 只产生内联元素与安全外链', () => {
  const html = renderInlineMarkdown('用 **Zotero** 管理文献，见 [官网](https://www.zotero.org/)。');
  assert.match(html, /<strong>Zotero<\/strong>/);
  assert.match(html, /href="https:\/\/www\.zotero\.org\/"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<p>|<h2>/);
});

test('原始 HTML 被转义，不产生脚本或事件属性', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
});

test('危险协议链接不会被渲染成可点击链接', () => {
  const html = renderMarkdown('[点我](javascript:alert(1)) [数据](data:text/html,<script>alert(1)</script>)');
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /href="data:/i);
});

test('相对链接保持原样，不强制新窗口', () => {
  const html = renderMarkdown('[资源目录](/resources/zotero/)');
  assert.match(html, /href="\/resources\/zotero\/"/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test('正文与内联字段只渲染规范的站内 /images/ 图片', () => {
  const html = renderMarkdown([
    '![正常](/images/optimized/zotero-abc.webp)',
    '![下划线](/images/my_image_2.png)',
    '![远程](https://tracker.invalid/pixel.png)',
    '![协议相对](//tracker.invalid/pixel.png)',
    '![内嵌](data:image/png;base64,iVBORw0KGgo=)',
    '![绝对本站](https://site.invalid/images/zotero.webp)',
    '![未规范化](images/zotero.webp)',
    '![跳出目录](/images/../secret.png)',
    '![编码跳出](/images/%2e%2e/secret.png)',
    '![双重编码](/images/%252e%252e/secret.png)',
    '![编码斜杠](/images/a%2f..%2fsecret.png)',
    '![空段](/images//secret.png)',
    '![查询串](/images/zotero.webp?track=1)',
  ].join('\n\n'));
  assert.equal((html.match(/<img\b/g) ?? []).length, 2, '只有规范站内图片生成 img');
  assert.match(html, /<img src="\/images\/optimized\/zotero-abc\.webp"/);
  assert.match(html, /<img src="\/images\/my_image_2\.png"/);
  assert.doesNotMatch(html, /tracker\.invalid|data:image|secret\.png|site\.invalid\/images/i);
  assert.match(html, /远程/, '被拒绝的图片保留 alt 文本，便于编辑者发现');
  assert.doesNotMatch(renderInlineMarkdown('![远程](https://tracker.invalid/x.png)'), /<img/i, '内联字段共用同一策略');
  assert.match(renderInlineMarkdown('![站内](/images/zotero.webp)'), /<img src="\/images\/zotero\.webp"/);
});

test('超长文本被拒绝', () => {
  assert.throws(() => renderMarkdown('a'.repeat(20001)), /过长/);
});
