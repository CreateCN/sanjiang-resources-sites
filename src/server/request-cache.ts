import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage<Map<string, unknown>>();

/** Shared by layouts/components within one request, never between visitors. */
export function withRequestCache<T>(operation: () => T): T {
  return requests.run(new Map(), operation);
}

export function requestMemo<T>(key: string, load: () => T): T {
  const cache = requests.getStore();
  if (!cache) return load();
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key) as T;
}

export function clearRequestCache(): void { requests.getStore()?.clear(); }
