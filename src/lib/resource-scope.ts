import { z } from 'zod';

/**
 * 资源的适用范围。
 *
 * - unknown：缺少证据或尚未审核；不得当作通用资源。
 * - global：不面向特定机构，但不等于永久免费、无地区限制或无个人资格要求。
 * - institutions：仅面向列出的机构；名称只是说明，不建学校关系表。
 *
 * scope 与 access 独立：student-verification 不自动成为 global，campus-network
 * 也不自动对应某个机构。发布快照与草稿各自保存自己的 scope。
 */
const institutionName = z.string()
  .trim()
  .min(1, '机构名称不能为空')
  .max(100, '机构名称不能超过 100 个字符');

export const ResourceScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unknown') }).strict(),
  z.object({ type: z.literal('global') }).strict(),
  z.object({
    type: z.literal('institutions'),
    institutions: z.array(institutionName).min(1, '至少填写一个机构名称').max(20, '最多填写 20 个机构名称'),
  }).strict(),
]);

export type ResourceScope = z.infer<typeof ResourceScopeSchema>;

export const UNKNOWN_SCOPE: ResourceScope = { type: 'unknown' };

/** 去重并保持首次出现的顺序；仅在合法的 scope 上调用。 */
export function canonicalScope(scope: ResourceScope): ResourceScope {
  if (scope.type !== 'institutions') return scope;
  return { type: 'institutions', institutions: [...new Set(scope.institutions)] };
}

/**
 * 读取旧数据用的兼容投影：缺字段或损坏时回退 unknown。
 * 写入/导入仍走完整 Schema，非法值不会被静默接受。
 */
export function projectScope(value: unknown): ResourceScope {
  if (value === null || value === undefined) return { ...UNKNOWN_SCOPE };
  const parsed = ResourceScopeSchema.safeParse(value);
  return parsed.success ? canonicalScope(parsed.data) : { ...UNKNOWN_SCOPE };
}

export function scopeLabel(scope: ResourceScope): string {
  if (scope.type === 'unknown') return '适用范围待确认，请查阅资格说明';
  if (scope.type === 'global') return '通用范围，不面向特定机构';
  return `仅限：${scope.institutions.join('、')}`;
}

/** 列表用短标签；unknown 仍然明确提示，不伪装成通用。 */
export function scopeShortLabel(scope: ResourceScope): string {
  if (scope.type === 'unknown') return '范围待确认';
  if (scope.type === 'global') return '通用范围';
  return scope.institutions.length === 1 ? `限 ${scope.institutions[0]}` : `限 ${scope.institutions.length} 个机构`;
}

export function scopeHint(scope: ResourceScope): string {
  if (scope.type === 'unknown') return '维护者尚未确认适用范围；请先阅读资格说明，或向提供方核实。';
  if (scope.type === 'global') return '不代表永久免费、无地区限制或无需个人资格；费用与条件仍以提供方说明为准。';
  return '仅面向所列机构；是否符合资格以提供方核验结果为准，不代表其他机构或公众同样可用。';
}
