export const ACCESS_OPTIONS = [
  { id: 'open', label: '无需申请', hint: '打开即可使用，或注册普通账户即可' },
  { id: 'student-verification', label: '需学生认证', hint: '需要学生身份或教育邮箱审核' },
  { id: 'campus-network', label: '需校园网', hint: '需要在校园网或校内认证环境访问' },
  { id: 'application', label: '需申请审核', hint: '需要提交申请并等待人工审核' },
  { id: 'conditional', label: '有条件使用', hint: '部分功能或内容需额外条件' },
  { id: 'unknown', label: '门槛待确认', hint: '尚未核实完整使用条件' },
] as const;

export type AccessId = (typeof ACCESS_OPTIONS)[number]['id'];

export function accessLabel(id: string | undefined): string {
  return ACCESS_OPTIONS.find((option) => option.id === id)?.label ?? '门槛待确认';
}

export function accessHint(id: string | undefined): string {
  return ACCESS_OPTIONS.find((option) => option.id === id)?.hint ?? '尚未核实完整使用条件';
}

export const PLATFORM_OPTIONS = ['Windows', 'macOS', 'Linux', '网页', 'iOS', 'Android'];
