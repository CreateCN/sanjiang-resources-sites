/**
 * 与后台路由冲突的保留标识。
 * 例：/admin/resources/new/ 与 /admin/guides/new/ 是"新建"页面，
 * 因此资源 ID / 指南 slug 不能取这些值，否则条目建好后无法再打开编辑。
 */
export const RESERVED_IDENTIFIERS = new Set(['new']);

export function isReservedIdentifier(value: string): boolean {
  return RESERVED_IDENTIFIERS.has(value.trim().toLowerCase());
}

export const RESERVED_IDENTIFIER_MESSAGE = '标识 new 为系统保留（与"新建"页面冲突），请改用其它标识';

/**
 * 实体标识（资源 ID / 指南 slug）长度上限。
 * schema、事件上报与统计必须共用同一个上限，否则长 ID 会被截断合并或直接拒绝。
 */
export const MAX_IDENTIFIER_LENGTH = 100;

/**
 * 分类的保留标识。`all` 是前台虚拟的"全部资源"书架，
 * 不是真实分类：存进 categories 表后既不能当场景使用，也无法在后台改名。
 * 分类写入的所有入口（分类管理、导入预检、导入应用）共用这一份判断。
 */
export const RESERVED_CATEGORY_IDS = new Set(['all']);

export function isReservedCategory(value: string): boolean {
  return RESERVED_CATEGORY_IDS.has(value.trim().toLowerCase());
}

export const RESERVED_CATEGORY_MESSAGE = '分类标识 all 为系统保留（前台表示"全部资源"），请改用其它标识';
