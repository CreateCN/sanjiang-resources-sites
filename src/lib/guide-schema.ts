import { z } from 'zod';
import { MAX_IDENTIFIER_LENGTH } from './identifiers.ts';

export const GuideSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug 只能使用小写字母、数字与连字符')
      .max(MAX_IDENTIFIER_LENGTH),
    title: z.string().trim().min(1, '标题不能为空').max(120),
    summary: z.string().trim().max(400),
    body: z.string().min(1, '正文不能为空').max(20000),
    resources: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(20),
  })
  .strict();

export type Guide = z.infer<typeof GuideSchema>;
