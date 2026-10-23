import { z } from 'zod';
import { MAX_IDENTIFIER_LENGTH } from './identifiers.ts';
import { ResourceScopeSchema, canonicalScope } from './resource-scope.ts';
const text = z.string().trim().min(1).max(4000);
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', '请使用 HTTPS 官方链接');
export const ResourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(MAX_IDENTIFIER_LENGTH),
  title: text.max(150), summary: text.max(800),
  category: z.string().regex(/^[a-z0-9-]+$/).max(80),
  kind: z.enum(['开源工具', '免费课程', '学生权益', '公共资源']),
  cost: text.max(200), platforms: z.array(text.max(100)).min(1).max(20),
  tags: z.array(text.max(50)).min(1).max(20), url: httpsUrl, sourceUrl: httpsUrl,
  license: text, eligibility: text, caveat: text,
  steps: z.array(text.max(1000)).min(1).max(10), status: z.enum(['review', 'verified']),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  image: z.string().regex(/^(?:\/images\/[a-zA-Z0-9._-]+|\/media\/[a-f0-9]{64}\.webp)$/, '图片必须是站内文件：/images/ 下的构建资源或已上传的 /media/ 媒体').optional(),
  imageAlt: z.string().trim().max(300).optional(),
  details: z.string().max(20000).optional(),
  access: z.enum(['open', 'student-verification', 'campus-network', 'application', 'conditional', 'unknown']).optional(),
  /** 旧数据缺字段时按 unknown 投影；存在但非法仍拒绝。 */
  scope: ResourceScopeSchema.default({ type: 'unknown' }),
  imageRights: z.enum(['confirmed', 'unconfirmed']).optional(),
  imageCredit: z.string().max(300).optional(),
}).superRefine((resource, ctx) => {
  if (resource.status === 'verified' && (!resource.checkedAt || Number.isNaN(Date.parse(resource.checkedAt)))) ctx.addIssue({ code: 'custom', message: '已核对条目必须填写有效核对日期' });
  // 图片必须有替代文本：缺图占位与屏幕阅读器都依赖它。
  if (resource.image && !resource.imageAlt) ctx.addIssue({ code: 'custom', path: ['imageAlt'], message: '设置图片时必须填写图片说明（alt）' });
}).transform((resource) => ({ ...resource, scope: canonicalScope(resource.scope) }));
export type Resource = z.infer<typeof ResourceSchema>;
