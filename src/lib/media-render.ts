import { mediaImageInfo } from '../server/media';
import { requestMemo } from '../server/request-cache';
import { renderInlineMarkdown, renderMarkdown } from './markdown';

/**
 * SSR 专用 Markdown 包装：给渲染器提供"这张运行时媒体现在是否可用"的判定。
 * 只在服务端页面里用；后台预览等未保存内容仍可就地渲染语法。
 */
const available = (src: string): boolean => Boolean(requestMemo(`media-available:${src}`, () => mediaImageInfo(src)));

export function renderMediaInline(input: string): string {
  return renderInlineMarkdown(input, { mediaAvailable: available });
}

export function renderMediaMarkdown(input: string): string {
  return renderMarkdown(input, { mediaAvailable: available });
}

/** 列表页用的占位判定（不渲染 Markdown 时也能显示缺图提示）。 */
export function mediaSrcAvailable(src: string | undefined): boolean {
  if (!src) return true;
  return available(src);
}
