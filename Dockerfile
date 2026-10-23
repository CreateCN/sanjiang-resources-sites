# 构建阶段
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json astro.config.mjs ./
COPY public ./public
COPY src ./src
COPY scripts ./scripts
ARG COMMIT_SHA
ARG INCLUDE_LEGACY_ASSETS=0
ENV COMMIT_SHA=$COMMIT_SHA \
    INCLUDE_LEGACY_ASSETS=$INCLUDE_LEGACY_ASSETS
RUN npm run build

# 生产依赖：只安装 dependencies，避免把 Playwright/TypeScript 等开发工具带进运行时。
# 运维 CLI 仍可使用：它们依赖的 zod/sharp/undici/qrcode 都在 dependencies 中。
FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 运行阶段
FROM node:24-bookworm-slim AS runtime
ARG VERSION="0.2.0"
ARG COMMIT_SHA=""
ARG SOURCE_URL="https://github.com/CreateCN/sanjiang-resources-sites"
ARG INCLUDE_LEGACY_ASSETS=0
LABEL org.opencontainers.image.title="Sanjiang Resources" \
      org.opencontainers.image.description="An open-source catalog for learning resources with local content, media, and static sponsorships." \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT_SHA}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="CreateCN" \
      org.opencontainers.image.base.name="docker.io/library/node:24-bookworm-slim" \
      com.createcn.sanjiang.legacy-assets="${INCLUDE_LEGACY_ASSETS}"
# 让运行时的备份 manifest 与构建产物记录同一个完整提交。
ENV COMMIT_SHA=${COMMIT_SHA} \
    APP_VERSION=${VERSION} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    DATABASE_PATH=/app/data/site.sqlite \
    MEDIA_DIR=/app/data/media \
    SITE_INIT_MODE=empty
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# 管理员初始化 CLI 直接运行 TypeScript 源文件（Node 24 原生类型剥离），需要源码与 zod。
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md ./
COPY licenses ./licenses
RUN mkdir -p /app/data/media && chown -R node:node /app/data
USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4321/api/health/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "./dist/server/entry.mjs"]
