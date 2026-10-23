import { isIP } from 'node:net';
import { z } from 'zod';
import { isPrivateAddress } from './private-address.ts';

/**
 * 静态赞助的输入 Schema。纯校验，不读 DB。
 *
 * 赞助是"广告"，但不加载第三方脚本：target_url 只做静态跳转，服务端不会抓取；
 * 媒体复用本站图片。所有文案按纯文本输出，模板负责转义。
 */

export const SPONSOR_SETTINGS_KEY = 'sponsors';
export const SPONSOR_LABEL = '广告 · 赞助';
export const SPONSOR_PLACEMENTS = ['home-sidebar', 'catalog-promotion'] as const;
export type SponsorPlacement = (typeof SPONSOR_PLACEMENTS)[number];
export const SPONSOR_PLACEMENT_LABELS: Record<SponsorPlacement, string> = {
  'home-sidebar': '首页侧栏',
  'catalog-promotion': '目录推广位',
};

const CONTROL = /[\u0000-\u001f\u007f]/u;
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

function text(min: number, max: number) {
  return z.string().trim().min(min, min > 0 ? '不能为空' : undefined).max(max).refine((value) => !CONTROL.test(value), '不能包含控制字符');
}

const mediaId = z.string().regex(/^[a-f0-9]{64}$/u, '媒体 ID 必须是 64 位小写十六进制').nullable().default(null);

/** 只接受带时区的 ISO 8601，避免服务器本地时区把无偏移时间解释错。 */
const instant = z.string().datetime({ offset: true, message: '时间必须是带时区的 ISO 8601（例如 2026-10-01T10:00:00+08:00）' }).nullable().default(null);

function hostProblem(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '');
  if (!host) return '目标地址缺少主机名';
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return '目标地址不能指向本机、内网或保留域名';
  }
  if (isIP(host) !== 0) return isPrivateAddress(host) ? '目标地址不能是回环、私网或保留 IP' : null;
  if (!host.includes('.')) return '目标地址必须是公开域名或公网 IP';
  return null;
}

/** 返回可公开展示的 hostname；Schema 已保证 URL 合法。 */
export function sponsorHostname(targetUrl: string): string {
  try { return new URL(targetUrl).hostname.toLowerCase(); } catch { return ''; }
}

export const SponsorInputSchema = z.object({
  title: text(1, 100),
  body: z.string().trim().max(300).refine((value) => !BODY_CONTROL.test(value), '不能包含控制字符').default(''),
  sponsorName: text(1, 100),
  mediaId,
  imageAlt: z.string().trim().max(300).default(''),
  targetUrl: z.string().trim().min(1).max(2048).superRefine((value, ctx) => {
    if (CONTROL.test(value)) { ctx.addIssue({ code: 'custom', message: '链接不能包含控制字符' }); return; }
    let url: URL;
    try { url = new URL(value); } catch { ctx.addIssue({ code: 'custom', message: '目标地址必须是合法绝对 URL' }); return; }
    if (url.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: '赞助链接必须使用 HTTPS' });
    if (url.username || url.password) ctx.addIssue({ code: 'custom', message: '赞助链接不能包含账号或密码' });
    const problem = hostProblem(url.hostname);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  placement: z.enum(SPONSOR_PLACEMENTS),
  enabled: z.boolean().default(false),
  startsAt: instant,
  endsAt: instant,
}).strict().superRefine((sponsor, ctx) => {
  if (sponsor.mediaId && !sponsor.imageAlt) ctx.addIssue({ code: 'custom', path: ['imageAlt'], message: '使用图片时必须填写替代文本' });
  if (sponsor.startsAt && sponsor.endsAt && Date.parse(sponsor.startsAt) >= Date.parse(sponsor.endsAt)) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: '结束时间必须晚于开始时间' });
  }
});

export type SponsorInput = z.infer<typeof SponsorInputSchema>;

export const SponsorSettingsInputSchema = z.object({ enabled: z.boolean() }).strict();
export const SponsorSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().min(1),
  enabled: z.boolean(),
}).strict();
export type SponsorSettings = z.infer<typeof SponsorSettingsSchema>;
export const DEFAULT_SPONSOR_SETTINGS: SponsorSettings = { schemaVersion: 1, version: 1, enabled: false };
