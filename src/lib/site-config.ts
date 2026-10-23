import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * 实例品牌配置的纯类型、Schema、默认值与软件常量。
 *
 * 这里不导入数据库、不读 process.env：公开投影与写入校验必须能在不打开
 * SQLite 的检查、构建和导入预检里复用。全部文案按纯文本处理，输出端由
 * Astro 默认转义，不允许存 HTML。
 */

export const BRANDING_SCHEMA_VERSION = 1 as const;
/** settings 表中的键名；首页编排继续使用 `site`，两者互不覆盖。 */
export const BRANDING_SETTINGS_KEY = 'branding';
/** metadata 表中的键名：TOTP issuer 按实例冻结，改名不改变已绑定的验证器。 */
export const AUTH_ISSUER_METADATA_KEY = 'auth_issuer';
/** 旧实例没有 auth_issuer 时补的值，与改造前的验证器展示保持一致。 */
export const LEGACY_AUTH_ISSUER = '三江资源';
/** 与 media.ts 的上传最小边一致；favicon 复用同一门槛，不另开转换参数。 */
export const FAVICON_MIN_EDGE = 200;
/** 白色按钮文字与强调色的最低对比度（WCAG AA 正文标准）。 */
export const MIN_WHITE_TEXT_CONTRAST = 4.5;

/** 上游软件常量：页面归属区与发行物使用，不随实例品牌变化。 */
export const UPSTREAM = Object.freeze({
  name: '三匠资源站',
  repository: 'https://github.com/CreateCN/sanjiang-resources-sites',
  license: 'MIT',
  copyrightHolder: 'CreateCN',
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function plainText(max: number, min = 0) {
  return z.string()
    .trim()
    .min(min, min > 0 ? '不能为空' : undefined)
    .max(max, `不能超过 ${max} 个字符`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), '不能包含控制字符');
}

const mediaId = z.string()
  .regex(/^[a-f0-9]{64}$/u, '媒体 ID 必须是 64 位小写十六进制')
  .nullable();

/** #RRGGBB，统一小写。对比度不足的强调色在写入前就被拒绝。 */
const accentColor = z.string()
  .regex(/^#[0-9a-fA-F]{6}$/u, '强调色必须是 #RRGGBB')
  .transform((value) => value.toLowerCase())
  .refine((value) => contrastRatio(value, '#ffffff') >= MIN_WHITE_TEXT_CONTRAST,
    `强调色与白色文字的对比度必须至少 ${MIN_WHITE_TEXT_CONTRAST}:1`);

const brandingShape = {
  name: plainText(60, 1),
  subtitle: plainText(100),
  description: plainText(500),
  footerText: plainText(500),
  organizationName: plainText(100),
  nonOfficialStatement: plainText(500),
  logoMediaId: mediaId,
  faviconMediaId: mediaId,
  shareImageMediaId: mediaId,
  accentColor,
  showProjectAttribution: z.boolean(),
};

export const BrandingInputSchema = z.object(brandingShape).strict();
export const BrandingSchema = z.object({
  schemaVersion: z.literal(BRANDING_SCHEMA_VERSION),
  /** 仅由服务端递增；客户端提交里不包含该字段。 */
  version: z.number().int().min(1),
  ...brandingShape,
}).strict();

export type BrandingInput = z.infer<typeof BrandingInputSchema>;
export type BrandingSettings = z.infer<typeof BrandingSchema>;

/** 新实例的中性默认值；默认站不指向任何学校。 */
export const DEFAULT_BRANDING: BrandingSettings = {
  schemaVersion: BRANDING_SCHEMA_VERSION,
  version: 1,
  name: '三匠资源站',
  subtitle: '学习与创作的资源入口',
  description: '整理工具、课程与公共学习资源，并说明费用和使用条件。',
  footerText: '由本站维护者独立整理。',
  organizationName: '',
  nonOfficialStatement: '本站不代表学校或资源提供方授权、合作或认可。',
  logoMediaId: null,
  faviconMediaId: null,
  shareImageMediaId: null,
  accentColor: '#245c42',
  showProjectAttribution: true,
};

/**
 * 旧实例升级时迁入的品牌快照：保持升级前页面上实际显示的文案，
 * 避免一次升级把站点改名。部署者之后可在后台自行修改。
 */
export const LEGACY_BRANDING: BrandingSettings = {
  schemaVersion: BRANDING_SCHEMA_VERSION,
  version: 1,
  name: '三江资源',
  subtitle: '同学们的开放工具书架',
  description: '为三江学院同学整理的开源工具、开放课程与学生资源。先了解条件，再放心开始。',
  footerText: '让好工具走进学习日常。',
  organizationName: '',
  nonOfficialStatement: '面向三江学院学生的非官方整理项目，不代表学校或资源方授权。',
  logoMediaId: null,
  faviconMediaId: null,
  shareImageMediaId: null,
  accentColor: '#245c42',
  showProjectAttribution: true,
};

/** 公开投影：只含页面需要的白名单字段，永不透传数据库行或环境变量。 */
export interface PublicSiteConfig {
  name: string;
  subtitle: string;
  description: string;
  footerText: string;
  organizationName: string;
  nonOfficialStatement: string;
  logoMediaId: string | null;
  faviconMediaId: string | null;
  shareImageMediaId: string | null;
  accentColor: string;
  accentHoverColor: string;
  accentSoftColor: string;
  accentSoftestColor: string;
  accentPaperColor: string;
  showProjectAttribution: boolean;
}

export interface BrandingRead {
  value: BrandingSettings;
  /** settings 中是否存在该键（无论是否损坏）。 */
  stored: boolean;
  /** 存了但不合法：公开页回退默认值，后台据此提示配置异常。 */
  corrupt: boolean;
  /** 原始字符串仅供服务层诊断，不进入公开投影。 */
  raw: string | null;
}

function channelOf(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function linearChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  return 0.2126 * linearChannel(channelOf(hex, 0))
    + 0.7152 * linearChannel(channelOf(hex, 1))
    + 0.0722 * linearChannel(channelOf(hex, 2));
}

function channelHex(value: number): string {
  return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0');
}

/** 两个 #RRGGBB 颜色的 WCAG 对比度（1–21）。 */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 从合法强调色派生 hover 色：向黑色混合 15%。
 * 合法强调色已通过白字 4.5:1 校验，变暗只会提高与白字的对比度，
 * 因此派生结果不需要、也不允许另开一套颜色输入。
 */
export function deriveAccentHover(hex: string): string {
  const ratio = 0.15;
  const mix = (index: number) => channelHex(channelOf(hex, index) * (1 - ratio));
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

/** 按比例把强调色与白色混合（ratio 是强调色占比），得到柔和的表面色。 */
function tint(hex: string, ratio: number): string {
  const mix = (index: number) => channelHex(channelOf(hex, index) * ratio + 255 * (1 - ratio));
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

export interface ThemeTokens {
  accent: string;
  accentHover: string;
  soft: string;
  softest: string;
  paper: string;
}

/**
 * 主题只开放强调色；其余表面色从强调色派生，避免自定义颜色后残留绿色底。
 * 派生值全部是服务端计算的 #RRGGBB，不接收原始 CSS。
 */
export function deriveThemeTokens(accent: string): ThemeTokens {
  return {
    accent,
    accentHover: deriveAccentHover(accent),
    soft: tint(accent, 0.1),
    softest: tint(accent, 0.06),
    paper: tint(accent, 0.03),
  };
}

export function cloneBranding(value: BrandingSettings): BrandingSettings {
  return { ...value };
}

/**
 * 解析 settings.branding 的原始值。
 * - 缺行：默认值（stored=false）。
 * - 合法：直接使用。
 * - 损坏：保留原文（stored=true, corrupt=true），公开页中性回退到默认值。
 */
export function parseStoredBranding(raw: string | null | undefined): BrandingRead {
  if (raw === null || raw === undefined) {
    return { value: cloneBranding(DEFAULT_BRANDING), stored: false, corrupt: false, raw: null };
  }
  try {
    const parsed = BrandingSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { value: parsed.data, stored: true, corrupt: false, raw };
  } catch { /* 损坏行按异常处理，不猜测修复 */ }
  return { value: cloneBranding(DEFAULT_BRANDING), stored: true, corrupt: true, raw };
}

export function projectPublicSiteConfig(value: BrandingSettings): PublicSiteConfig {
  return {
    name: value.name,
    subtitle: value.subtitle,
    description: value.description,
    footerText: value.footerText,
    organizationName: value.organizationName,
    nonOfficialStatement: value.nonOfficialStatement,
    logoMediaId: value.logoMediaId,
    faviconMediaId: value.faviconMediaId,
    shareImageMediaId: value.shareImageMediaId,
    accentColor: value.accentColor,
    accentHoverColor: deriveAccentHover(value.accentColor),
    accentSoftColor: tint(value.accentColor, 0.1),
    accentSoftestColor: tint(value.accentColor, 0.06),
    accentPaperColor: tint(value.accentColor, 0.03),
    showProjectAttribution: value.showProjectAttribution,
  };
}

/** 品牌版本 + 内容的稳定摘要，供导入预检冻结。 */
export function brandingFingerprint(value: BrandingSettings): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
