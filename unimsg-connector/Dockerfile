# syntax=docker/dockerfile:1
# ============================================================================
# LinkHub 独立部署镜像（赛题 A「独立部署包」）
#
# 两阶段：
#   build   —— 安装全量依赖，用 Vite 产出前端静态资源；
#   runtime —— 只装生产依赖，由同一个 Node 进程同时提供 /api、/ws 与前端页面。
#
# 因此评审现场只需一个容器、一个端口（3001），不依赖宿主机 Node/pnpm，
# 也不需要额外的 nginx / 数据库容器。
# ============================================================================

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# 先只拷清单，命中依赖层缓存；源码变动不触发重装
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .

# 同源部署：前端用相对 /api 路径访问后端；令牌必须与运行期 API_TOKEN 一致
ARG VITE_API_BASE=/
ARG VITE_API_TOKEN=linkhub-local-demo-2026-change-me
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_API_TOKEN=$VITE_API_TOKEN
RUN pnpm --filter @unimsg/web build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile --prod

COPY packages/shared packages/shared
COPY packages/server packages/server
COPY --from=build /app/packages/web/dist packages/web/dist

# 闭环数据（消息 / trace / 死信队列）落在这个卷里，重启后回放不丢
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    SERVER_PORT=3001 \
    SERVER_HOST=0.0.0.0 \
    WEB_DIST=/app/packages/web/dist \
    DATA_DIR=/app/data \
    MAX_UPLOAD_MB=32

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||3001)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# tsx 属于运行期依赖（packages/server 的 dependencies），直接跑 TS 源码
CMD ["pnpm", "--filter", "@unimsg/server", "start"]
