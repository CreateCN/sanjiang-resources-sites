import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, checkResourceLink, isPrivateAddress } from '../src/server/linkcheck.ts';

test('内网与保留地址被识别', () => {
  for (const address of ['10.0.0.5', '127.0.0.1', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('非 http、带凭据与本机地址被拒绝', async () => {
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /http/);
  await assert.rejects(() => assertPublicUrl('ftp://example.com/x'), /http/);
  await assert.rejects(() => assertPublicUrl('https://user:pass@example.com/'), /账号/);
  await assert.rejects(() => assertPublicUrl('http://localhost:4321/'), /内网/);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/'), /内网/);
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data'), /内网/);
  assert.equal((await assertPublicUrl('https://93.184.216.34/')).hostname, '93.184.216.34');
});

test('检查结果分类：可访问、失效、拒绝、重定向到内网', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 200 });
    assert.equal((await checkResourceLink('https://93.184.216.34/')).status, 'ok');

    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal((await checkResourceLink('https://93.184.216.34/')).status, 'broken');

    globalThis.fetch = async () => new Response(null, { status: 403 });
    assert.equal((await checkResourceLink('https://93.184.216.34/')).status, 'warn');

    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
    const redirected = await checkResourceLink('https://93.184.216.34/');
    assert.equal(redirected.status, 'error');
    assert.match(redirected.message, /内网/);

    globalThis.fetch = async () => { throw new Error('boom'); };
    assert.equal((await checkResourceLink('https://93.184.216.34/')).status, 'error');
  } finally { globalThis.fetch = original; }
});
