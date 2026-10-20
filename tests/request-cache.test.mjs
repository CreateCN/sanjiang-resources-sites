import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestMemo, withRequestCache, clearRequestCache } from '../src/server/request-cache.ts';

test('同一请求只加载一次，undefined 结果也会复用，写入后可失效', () => {
  let calls = 0;
  const load = () => { calls++; return undefined; };
  withRequestCache(() => {
    requestMemo('missing', load);
    requestMemo('missing', load);
    assert.equal(calls, 1);
    clearRequestCache();
    requestMemo('missing', load);
    assert.equal(calls, 2);
  });
});

test('并发请求不会共享缓存；请求外不缓存数据', async () => {
  const read = (value, delay) => withRequestCache(async () => {
    requestMemo('same', () => value);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return requestMemo('same', () => 'wrong');
  });
  assert.deepEqual(await Promise.all([read('one', 5), read('two', 1)]), ['one', 'two']);
  assert.equal(requestMemo('same', () => 'outside'), 'outside');
  assert.equal(requestMemo('same', () => 'new'), 'new');
});
