import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';

/**
 * TOTP 与密钥密封的权威实现。
 *
 * 设计约束（docs/security/SECURITY-SPEC.md §4.5）：
 * - 算法固定 HMAC-SHA1 / 6 位 / 30 秒，窗口 ±1；窗口内固定跑完全部候选再返回。
 * - 密钥以 AES-256-GCM 密封，AAD 绑定 user:<id>，禁止明文或仅 base32 存放。
 * - 恢复码只存 sha256("<user_id>:<normalized>")，一次性。
 * - 这里不读写数据库、不审计、不发 Cookie：所有状态变更由 auth.ts 的单一事务完成。
 */

export const STEP_SECONDS = 30;
export const STEP_MS = STEP_SECONDS * 1000;
export const DIGITS = 6;
export const WINDOW = 1;
export const SECRET_BYTES = 20;
export const RECOVERY_CODE_COUNT = 10;
export const TOTP_ISSUER = '三江资源';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_INDEX = new Map([...BASE32].map((character, index) => [character, index]));
/** RFC 4648 未填充 base32 的合法长度余数。 */
const BASE32_REMAINDERS = new Set([0, 2, 4, 5, 7]);

export class TotpKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpKeyError';
  }
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/** 接受空格、连字符与尾部 '=' 填充；拒绝非法字符、非法长度余数与非零填充位。 */
export function base32Decode(input: string): Buffer {
  const text = input.replace(/[\s-]/g, '').replace(/=+$/u, '').toUpperCase();
  if (!/^[A-Z2-7]*$/u.test(text)) throw new Error('密钥包含非法字符');
  if (!BASE32_REMAINDERS.has(text.length % 8)) throw new Error('密钥长度不合法');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text) {
    const index = BASE32_INDEX.get(character);
    if (index === undefined) throw new Error('密钥包含非法字符');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // 尾部不足一字节的位必须为零，否则同一密钥存在多种写法（重编码攻击面）。
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) throw new Error('密钥填充位不为零');
  return Buffer.from(bytes);
}

export function generateSecret(bytes = SECRET_BYTES): string {
  return base32Encode(randomBytes(bytes));
}

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / STEP_MS);
}

/**
 * 返回命中的时间步；不匹配返回 null。三个候选全部参与比较且不提前返回，
 * 避免通过响应时间暴露"命中了窗口中的第几档"。
 */
export function verifyTotp(secret: Buffer, code: string, step: number): number | null {
  if (!new RegExp(`^\\d{${DIGITS}}$`, 'u').test(code)) return null;
  const provided = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let delta = -WINDOW; delta <= WINDOW; delta += 1) {
    const candidate = Buffer.from(hotp(secret, step + delta), 'utf8');
    if (candidate.length === provided.length && timingSafeEqual(candidate, provided) && matched === null) {
      matched = step + delta;
    }
  }
  return matched;
}

/** 一次性判据：命中步必须严格大于已记录步（窗口内重放被拒）。 */
export function isFreshStep(lastStep: number | null | undefined, matched: number): boolean {
  return lastStep === null || lastStep === undefined || matched > Number(lastStep);
}

export type OtpInput =
  | { kind: 'totp'; code: string }
  | { kind: 'recovery'; normalized: string };

/** 按输入形状分流：6 位数字 → TOTP；8 位 base32（允许连字符/空格）→ 恢复码。 */
export function classifyOtpInput(raw: string): OtpInput | null {
  const text = raw.trim();
  if (new RegExp(`^\\d{${DIGITS}}$`, 'u').test(text)) return { kind: 'totp', code: text };
  const normalized = text.replace(/[\s-]/g, '').toUpperCase();
  if (/^[A-Z2-7]{8}$/u.test(normalized)) return { kind: 'recovery', normalized };
  return null;
}

/** 恢复码：40 位随机性 → base32 8 位 → XXXX-XXXX 展示。 */
export function createRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const normalized = base32Encode(randomBytes(5));
    codes.add(`${normalized.slice(0, 4)}-${normalized.slice(4)}`);
  }
  return [...codes];
}

export function normalizeRecoveryCode(raw: string): string | null {
  const normalized = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{8}$/u.test(normalized) ? normalized : null;
}

export function hashRecoveryCode(userId: number, normalized: string): string {
  return createHash('sha256').update(`${userId}:${normalized}`).digest('hex');
}

/**
 * 加密密钥。格式：32 字节 base64url（也接受标准 base64）。
 * 非法或缺失一律返回 null，由调用方 fail-closed（禁止降级为口令登录）。
 */
export function encryptionKey(raw = process.env.TOTP_ENC_KEY): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9_\-+/=]{43,44}$/u.test(trimmed)) return null;
  let key: Buffer;
  try {
    key = trimmed.includes('+') || trimmed.includes('/') || trimmed.endsWith('=')
      ? Buffer.from(trimmed, 'base64')
      : Buffer.from(trimmed, 'base64url');
  } catch { return null; }
  return key.length === 32 ? key : null;
}

export function requireEncryptionKey(raw = process.env.TOTP_ENC_KEY): Buffer {
  const key = encryptionKey(raw);
  if (!key) throw new TotpKeyError('TOTP_ENC_KEY 未配置或格式不正确（需要 32 字节 base64url）');
  return key;
}

export function sealSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

/** 严格校验 v1 格式 + tag + 长度；任何异常都视为不可用（不返回部分结果）。 */
export function openSecret(sealed: string, key: Buffer, aad: string): string {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文版本不受支持');
  const [, ivText = '', tagText = '', dataText = ''] = parts;
  if (!/^[A-Za-z0-9_-]{16}$/u.test(ivText)) throw new Error('密文 IV 非法');
  if (!/^[A-Za-z0-9_-]{22}$/u.test(tagText)) throw new Error('密文 tag 非法');
  if (!/^[A-Za-z0-9_-]+$/u.test(dataText)) throw new Error('密文内容非法');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
}

export function secretAad(userId: number): string {
  return `user:${userId}`;
}

/**
 * Key URI：标签与 query 分开编码，issuer 两处一致，参数固定。
 * issuer 由服务端解析后传入（实例初始化时冻结）；默认值只用于兼容旧调用。
 */
export function buildOtpauthUri(username: string, secret: string, issuer: string = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * 服务端生成二维码 SVG。原始标记只来自该固定配置的库输出，
 * 不拼接任何用户内容；不接受客户端传入的数据。
 */
export async function renderOtpauthSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 320,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}
