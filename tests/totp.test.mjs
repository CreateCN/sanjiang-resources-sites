import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import jsQR from 'jsqr';
import {
  base32Decode, base32Encode, buildOtpauthUri, classifyOtpInput, createRecoveryCodes, currentStep,
  encryptionKey, generateSecret, hashRecoveryCode, hotp, isFreshStep, normalizeRecoveryCode, openSecret,
  renderOtpauthSvg, requireEncryptionKey, sealSecret, secretAad, verifyTotp, TotpKeyError, STEP_SECONDS, WINDOW,
} from '../src/server/totp.ts';

const RFC_SECRET_TEXT = '12345678901234567890';
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('RFC 6238 SHA-1 vectors (8-digit reference truncated to our 6 digits)', () => {
  const secret = Buffer.from(RFC_SECRET_TEXT, 'ascii');
  assert.equal(base32Encode(secret), RFC_SECRET_BASE32, 'base32 编码必须与 RFC 4648 示例一致');
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(hotp(secret, Math.floor(seconds / STEP_SECONDS)), expected, `T=${seconds}`);
    assert.equal(hotp(base32Decode(RFC_SECRET_BASE32), Math.floor(seconds / STEP_SECONDS)), expected, '解码后的密钥必须等价');
    assert.equal(verifyTotp(secret, expected, Math.floor(seconds / STEP_SECONDS)), Math.floor(seconds / STEP_SECONDS));
  }
});

test('base32 accepts legacy whitespace/padding and rejects illegal forms', () => {
  const raw = Buffer.from('hello world');
  const encoded = base32Encode(raw);
  assert.deepEqual(base32Decode(encoded), raw);
  assert.deepEqual(base32Decode(`${encoded.slice(0, 4)} ${encoded.slice(4)}`.toLowerCase()), raw, '空格与小写被归一化');
  assert.deepEqual(base32Decode(`${encoded}===`), raw, '尾部填充被接受');
  assert.deepEqual(base32Decode(encoded.replace(/(.{4})/g, '$1-')), raw, '连字符被接受');

  assert.throws(() => base32Decode('ABC1'), /非法字符/);
  assert.throws(() => base32Decode('A'), /长度不合法/);
  assert.throws(() => base32Decode('ABC'), /长度不合法/);
  assert.throws(() => base32Decode('ABCDEF'), /长度不合法/);
  // 2 个字符 = 10 位：1 字节 + 2 位填充，填充位必须为零。
  assert.throws(() => base32Decode('AB'), /填充位/);
  assert.equal(base32Decode('AA').length, 1);
});

test('窗口为 ±1 步且窗口内固定跑完全部候选', () => {
  const secret = base32Decode(RFC_SECRET_BASE32);
  const step = 58000000;
  const codeAtStep = (offset) => hotp(secret, step + offset);
  assert.equal(verifyTotp(secret, codeAtStep(0), step), step);
  assert.equal(verifyTotp(secret, codeAtStep(-1), step), step - 1);
  assert.equal(verifyTotp(secret, codeAtStep(1), step), step + 1);
  assert.equal(verifyTotp(secret, codeAtStep(-2), step), null, `窗口 ${WINDOW}：更早的步不接受`);
  assert.equal(verifyTotp(secret, codeAtStep(2), step), null);
  assert.equal(verifyTotp(secret, '12345', step), null);
  assert.equal(verifyTotp(secret, '1234567', step), null);
  assert.equal(verifyTotp(secret, 'abcdef', step), null);
  // 同一输入重复验证必须稳定（不能因为内部状态导致第二次失败）。
  assert.equal(verifyTotp(secret, codeAtStep(0), step), step);
  assert.equal(verifyTotp(secret, codeAtStep(0), step), step);
});

test('replay guard compares against the recorded step', () => {
  assert.equal(isFreshStep(null, 100), true);
  assert.equal(isFreshStep(100, 101), true);
  assert.equal(isFreshStep(100, 100), false);
  assert.equal(isFreshStep(100, 99), false);
});

test('AES-256-GCM sealing binds user id and rejects tampering', () => {
  const key = Buffer.alloc(32, 7);
  const sealed = sealSecret(generateSecret(), key, secretAad(42));
  assert.match(sealed, /^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/);
  assert.ok(openSecret(sealed, key, secretAad(42)).length > 0);
  assert.throws(() => openSecret(sealed, key, secretAad(43)), '错误 AAD 必须失败');
  assert.throws(() => openSecret(sealed, Buffer.alloc(32, 8), secretAad(42)), '错误密钥必须失败');
  const parts = sealed.split(':');
  const tamperedTag = [...parts];
  tamperedTag[2] = `${parts[2].slice(0, -2)}${parts[2].endsWith('A') ? 'BA' : 'AA'}`;
  assert.throws(() => openSecret(tamperedTag.join(':'), key, secretAad(42)));
  assert.throws(() => openSecret(sealed.replace('v1:', 'v2:'), key, secretAad(42)), /版本/);
  assert.throws(() => openSecret('not-a-seal', key, secretAad(42)));
  // 同一明文两次密封的 IV 不同（随机化），密文也不同。
  const again = sealSecret('GEZDGNBVGY3TQOJQ', key, secretAad(42));
  assert.notEqual(again, sealed);
});

test('encryption key parsing fails closed', () => {
  assert.equal(encryptionKey(undefined), null);
  assert.equal(encryptionKey(''), null);
  assert.equal(encryptionKey('short'), null);
  assert.equal(encryptionKey(Buffer.alloc(31).toString('base64url')), null, '31 字节不够');
  const valid = Buffer.alloc(32).toString('base64url');
  assert.equal(encryptionKey(valid)?.length, 32);
  assert.equal(encryptionKey(Buffer.alloc(32).toString('base64'))?.length, 32, '标准 base64 也能读');
  const original = process.env.TOTP_ENC_KEY;
  try {
    delete process.env.TOTP_ENC_KEY;
    assert.throws(() => requireEncryptionKey(), TotpKeyError, '缺少密钥必须 fail-closed');
    process.env.TOTP_ENC_KEY = 'not-a-key';
    assert.throws(() => requireEncryptionKey(), TotpKeyError);
  } finally {
    if (original === undefined) delete process.env.TOTP_ENC_KEY; else process.env.TOTP_ENC_KEY = original;
  }
});

test('recovery codes are 40-bit, grouped, unique and user-bound', () => {
  const codes = createRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(normalizeRecoveryCode(' abcd-efgh '), 'ABCDEFGH');
  assert.equal(normalizeRecoveryCode('abcd efgh'), 'ABCDEFGH');
  assert.equal(normalizeRecoveryCode('abcd-efg'), null);
  assert.equal(normalizeRecoveryCode('abcd-efg1'), null, '1 不在 base32 字母表');
  const normalized = normalizeRecoveryCode(codes[0]);
  assert.notEqual(hashRecoveryCode(1, normalized), hashRecoveryCode(2, normalized), '哈希必须绑定用户');
  assert.equal(hashRecoveryCode(1, normalized), hashRecoveryCode(1, normalized));
});

test('OTP input classification keeps TOTP and recovery buckets separate', () => {
  assert.deepEqual(classifyOtpInput('123456'), { kind: 'totp', code: '123456' });
  assert.deepEqual(classifyOtpInput(' 123456 '), { kind: 'totp', code: '123456' });
  assert.deepEqual(classifyOtpInput('abcd-efgh'), { kind: 'recovery', normalized: 'ABCDEFGH' });
  assert.equal(classifyOtpInput('12345'), null);
  assert.equal(classifyOtpInput('1234567'), null);
  assert.equal(classifyOtpInput('abcd-efg1'), null, '1 不在 base32 字母表');
  assert.equal(classifyOtpInput(''), null);
});

test('otpauth URI encodes issuer/label/parameters exactly as specified', () => {
  const uri = buildOtpauthUri('editor.one', 'GEZDGNBVGY3TQOJQ');
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.host, 'totp');
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), '三江资源:editor.one', '标签是 issuer:账号且各自编码');
  assert.equal(parsed.searchParams.get('secret'), 'GEZDGNBVGY3TQOJQ');
  assert.equal(parsed.searchParams.get('issuer'), '三江资源');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
  // 用户名里的特殊字符必须被编码，不能破坏 URI 结构。
  const awkward = buildOtpauthUri('a b&c=d/中文', 'GEZDGNBVGY3TQOJQ');
  assert.equal(new URL(awkward).searchParams.get('issuer'), '三江资源');
  assert.equal(decodeURIComponent(new URL(awkward).pathname.slice(1)), '三江资源:a b&c=d/中文');
});

test('显式传入的实例 issuer 同时出现在标签与 query，并支持特殊字符', async () => {
  const issuer = '星河 & 学习 "站"';
  const uri = buildOtpauthUri('a b&c=d/中文', 'GEZDGNBVGY3TQOJQ', issuer);
  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('issuer'), issuer);
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), `${issuer}:a b&c=d/中文`);
  const { text } = await decodeQr(uri);
  assert.equal(text, uri, '二维码必须编码同一个 issuer');
});

async function decodeQr(uri) {
  const svg = await renderOtpauthSvg(uri);
  assert.match(svg, /^<svg[\s>]/, '必须是 SVG');
  assert.doesNotMatch(svg, /<script|onload=|javascript:/i, '二维码 SVG 不得包含脚本或事件属性');
  const { data, info } = await sharp(Buffer.from(svg)).resize(480, 480).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  assert.ok(decoded, '独立解码器必须能读出二维码');
  return { text: decoded.data, svg };
}

test('QRCode decodes back to the exact otpauth URI (Chinese issuer, encoded account)', async () => {
  const secret = generateSecret();
  const uri = buildOtpauthUri('zhang.san', secret);
  const { text } = await decodeQr(uri);
  assert.equal(text, uri, '解码结果必须与待绑定 URI 完全一致');
  const parsed = new URL(text);
  assert.equal(parsed.searchParams.get('secret'), secret);
  assert.equal(parsed.searchParams.get('issuer'), '三江资源');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), '三江资源:zhang.san');
});

test('regenerating the SVG for the same challenge yields the same code (secret is stable)', async () => {
  const secret = generateSecret();
  const uri = buildOtpauthUri('stable.user', secret);
  const first = await decodeQr(uri);
  const second = await decodeQr(uri);
  assert.equal(first.text, second.text);
  assert.equal(first.svg, second.svg, '同一 URI 的编码结果必须确定，刷新不换秘密');
  const different = await decodeQr(buildOtpauthUri('stable.user', generateSecret()));
  assert.notEqual(different.text, first.text);
});

test('code generated from the decoded secret verifies against that secret', async () => {
  const secret = generateSecret();
  const { text } = await decodeQr(buildOtpauthUri('verify.user', secret));
  const decodedSecret = new URL(text).searchParams.get('secret');
  const code = hotp(base32Decode(decodedSecret), currentStep());
  assert.equal(verifyTotp(base32Decode(secret), code, currentStep()), currentStep());
});
