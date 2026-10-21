import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, checkResourceLink, isPrivateAddress, pinnedLookup } from '../src/server/linkcheck.ts';

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

test('IPv4 映射与兼容编码不能绕过私网判定', async () => {
  for (const address of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::', '::7f00:1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['::ffff:93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  for (const url of [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]:80/probe',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
    'http://[::1]/',
    'http://[fe80::1]/',
  ]) {
    await assert.rejects(() => assertPublicUrl(url), /内网/, url);
  }
  assert.equal((await assertPublicUrl('https://[2606:4700:4700::1111]/')).hostname, '[2606:4700:4700::1111]');
});

test('重定向到映射回环地址会在解析该跳时被拒绝', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://[::ffff:7f00:1]/owned-echo' } });
    const result = await checkResourceLink('https://93.184.216.34/');
    assert.equal(result.status, 'error');
    assert.match(result.message, /内网/);
  } finally { globalThis.fetch = original; }
});

test('固定连接的 lookup 同时满足 all 与单地址契约', async () => {
  const pinned = pinnedLookup({ address: '93.184.216.34', family: 4 });
  const all = await new Promise((resolve) => pinned('rebind.example', { all: true }, (error, addresses) => resolve({ error, addresses })));
  assert.equal(all.error, null);
  assert.deepEqual(all.addresses, [{ address: '93.184.216.34', family: 4 }], 'options.all 为真时必须回地址数组');
  const single = await new Promise((resolve) => pinned('rebind.example', { all: false }, (error, address, family) => resolve({ error, address, family })));
  assert.equal(single.address, '93.184.216.34');
  assert.equal(single.family, 4);
});

test('固定连接失败时终止检查，绝不回退到重新解析域名的普通请求', async () => {
  const fallbackCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { fallbackCalls.push(String(input)); return new Response(null, { status: 200 }); };
  try {
    const result = await checkResourceLink('https://rebind.example/entry', {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => { throw new Error('pinned connection failed'); },
    });
    assert.equal(result.status, 'error');
    assert.match(result.message, /pinned connection failed/);
    assert.deepEqual(fallbackCalls, [], '固定连接失败后不能发起任何未校验的请求');
  } finally { globalThis.fetch = originalFetch; }
});

test('DNS 重绑定：每一跳都重新校验，解析到私网时连接不会发生', async () => {
  const connects = [];
  const hosts = [];
  let lookupRound = 0;
  const resolve = async (hostname) => {
    hosts.push(hostname);
    lookupRound += 1;
    return lookupRound === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
  };
  const result = await checkResourceLink('https://rebind.example/entry', {
    resolve,
    transport: async (url, _init, target) => {
      connects.push(`${url.hostname}->${target.addresses[0].address}`);
      return new Response(null, { status: 302, headers: { location: 'https://rebind.example/next' } });
    },
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /内网/);
  assert.deepEqual(connects, ['rebind.example->93.184.216.34'], '第二次解析到回环后不能再发起连接');
  assert.deepEqual(hosts, ['rebind.example', 'rebind.example']);
});

test('域名检查成功时使用已校验地址并保留原 Host', async () => {
  const seen = [];
  const result = await checkResourceLink('https://normal.example/page', {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async (url, init, target) => {
      seen.push({ hostname: url.hostname, address: target.addresses[0].address, method: init.method });
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(seen, [{ hostname: 'normal.example', address: '93.184.216.34', method: 'HEAD' }]);
});

test('重绑定域名不会打到回环服务（需 root 才能绑定 80 端口）', { skip: process.getuid?.() !== 0 }, async () => {
  const http = await import('node:http');
  const hits = [];
  const echo = http.createServer((request, response) => { hits.push(`${request.method} ${request.url}`); response.end('owned'); });
  await new Promise((resolve, reject) => { echo.once('error', reject); echo.listen(80, '127.0.0.1', resolve); });
  try {
    const result = await checkResourceLink('http://rebind.example/round5-owned-echo', {
      // 校验看到的是公网地址；固定连接只会去这个地址，不会重新解析域名。
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      timeoutMs: 1200,
    });
    assert.ok(['ok', 'error'].includes(result.status), result.status);
    assert.deepEqual(hits, [], '回环服务必须一次请求都收不到');
  } finally { await new Promise((resolve) => echo.close(resolve)); }
});
