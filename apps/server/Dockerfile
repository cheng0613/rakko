# 镜像按 K8s 规范：非 root、单进程、只读根文件系统可用、SIGTERM 优雅退出。
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /repo/apps/server/package.json ./apps/server/package.json

USER node
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
