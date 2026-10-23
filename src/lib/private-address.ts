/**
 * 私网/保留网段的判定必须基于地址字节，而不是字符串正则：
 * URL 解析器会把 http://[::ffff:127.0.0.1]/ 规范化成 [::ffff:7f00:1]，
 * 只在点分形式里匹配 IPv4 会把实际指向回环的地址放行。
 */
const BLOCKED_V4_RANGES: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}
function blockedV4(value: number): boolean {
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const text = ipv4ToInt(base);
    if (text === null) return false;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (text & mask);
  });
}
/** 解析 IPv6（含 :: 压缩、IPv4 尾巴与 zone id）；无法解析返回 null。 */
function ipv6Bytes(input: string): Uint8Array | null {
  let value = input.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value.includes('.')) {
    const cut = value.lastIndexOf(':');
    const embedded = ipv4ToInt(value.slice(cut + 1));
    if (embedded === null) return null;
    value = `${value.slice(0, cut + 1)}${((embedded >>> 16) & 0xffff).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(value)) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 ? groups < 1 : head.length !== 8) return null;
  const filled = [...head, ...Array<string>(groups).fill('0'), ...tail];
  if (filled.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (const [index, group] of filled.entries()) {
    if (group.length === 0 || group.length > 4 || !/^[0-9a-f]+$/.test(group)) return null;
    const number = Number.parseInt(group, 16);
    bytes[index * 2] = (number >> 8) & 0xff;
    bytes[index * 2 + 1] = number & 0xff;
  }
  return bytes;
}
function v4At(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}
function blockedV6(bytes: Uint8Array): boolean {
  // IPv4-mapped（::ffff:a.b.c.d 与 ::ffff:7f00:1）与 NAT64（64:ff9b::/96）：低 32 位就是 IPv4。
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return blockedV4(v4At(bytes, 12));
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return blockedV4(v4At(bytes, 12));
  // ::/96 里的其余兼容地址（含 ::、::1）在公网没有正当用途，直接拒绝。
  if (bytes.slice(0, 10).every((byte) => byte === 0)) return true;
  // 6to4 2002::/16 内嵌 IPv4；6bone 2001::/32 与文档前缀 2001:db8::/32 一律拒绝。
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return blockedV4(v4At(bytes, 2));
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0xff) return true; // 组播
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // 唯一本地 fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // 链路本地 fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true; // 站点本地（已废弃但仍可能配置）
  return false;
}

/** 无法解析的地址按危险处理（fail closed）：宁可拒绝检查，也不放行未识别的写法。 */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().replace(/^\[|\]$/g, '');
  const v6 = ipv6Bytes(value);
  if (v6) return blockedV6(v6);
  const v4 = ipv4ToInt(value);
  if (v4 !== null) return blockedV4(v4);
  return true;
}
