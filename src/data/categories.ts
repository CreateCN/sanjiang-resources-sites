/**
 * 不带实例内容的系统分类：新站只需要一个综合分类，所有实例都有虚拟的 all。
 * 示例分类与业务测试分类分别由 Demo 数据和 tests/fixtures 提供。
 */
export const SYSTEM_CATEGORIES = [
  { id: 'all', name: '全部资源' },
  { id: 'general', name: '综合资源' },
] as const;
