import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { resolveBuildRevision } from './scripts/build-revision.mjs';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  devToolbar: { enabled: false },
  trailingSlash: 'always',
  // 关闭 Astro 自带同源检查：Node 适配器未配置 allowedDomains 时会把 URL
  // 还原成不带端口的 http://localhost，导致校验误判。服务器端在
  // src/server/security.ts 的 requireOrigin 中按 SITE_URL / Host 做更严格的校验。
  security: { checkOrigin: false },
  vite: {
    server: { allowedHosts: true },
    define: { 'import.meta.env.PUBLIC_COMMIT_SHA': JSON.stringify(resolveBuildRevision()) },
  },
});
