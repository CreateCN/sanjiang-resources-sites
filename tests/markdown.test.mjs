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

test('超长文本被拒绝', () => {
  assert.throws(() => renderMarkdown('a'.repeat(20001)), /过长/);
});
