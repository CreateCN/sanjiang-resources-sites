import type { Resource } from '../lib/resource-schema.ts';

/**
 * Demo 初始化内容：少量示例，只用官方公开入口，不附带截图。
 *
 * - 不写入 current 核验日期：status 保持 review、checkedAt 为 null；
 * - 不引用站点媒体或本地截图，避免把授权未确认的素材带进新实例；
 * - 文案保持通用，不含学校、机构或"已实测"承诺。
 * 部署者应在退出演示标记前替换为真实核对过的内容。
 */
export const demoCategories = [
  { id: 'all', name: '全部资源' },
  { id: 'general', name: '综合资源' },
] as const;

export const demoResources: Resource[] = [
  {
    id: 'demo-zotero',
    title: 'Zotero 文献管理',
    summary: '把论文、网页与阅读笔记整理到同一个文献库，写作时生成引用。',
    category: 'general',
    kind: '开源工具',
    cost: '软件免费；在线同步空间可能收费',
    platforms: ['桌面', '浏览器扩展'],
    tags: ['文献管理', '引用', '写作'],
    url: 'https://www.zotero.org/',
    sourceUrl: 'https://www.zotero.org/support/',
    license: '桌面端以 AGPL 开源，托管与附加服务另有条款。',
    eligibility: '任何人可下载使用；在线同步需要注册账户。',
    caveat: '演示条目：请以官方说明为准，并在对外发布前替换为本站实际核对的内容。',
    steps: ['下载并安装桌面端。', '安装浏览器扩展，保存第一份文献。', '按官方说明确认同步空间与费用。'],
    status: 'review',
    checkedAt: null,
    access: 'open',
    scope: { type: 'unknown' },
  },
  {
    id: 'demo-libreoffice',
    title: 'LibreOffice 办公套件',
    summary: '离线可用的文档、表格与演示套件，适合打开常见办公格式。',
    category: 'general',
    kind: '开源工具',
    cost: '免费下载与使用',
    platforms: ['桌面'],
    tags: ['办公', '文档', '表格'],
    url: 'https://www.libreoffice.org/',
    sourceUrl: 'https://www.libreoffice.org/about-us/license/',
    license: 'MPL 2.0；第三方字体与模板可能另有许可。',
    eligibility: '任何人可下载使用，无需账户。',
    caveat: '演示条目：复杂格式的兼容性因文件而异，请在官方页面确认当前版本。',
    steps: ['从官方下载页选择对应系统。', '安装后打开一份现有文档检查格式。'],
    status: 'review',
    checkedAt: null,
    access: 'open',
    scope: { type: 'unknown' },
  },
];

export const demoFeaturedResourceId = demoResources[0]?.id ?? '';
