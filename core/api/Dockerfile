# Build context: the repository root (see core/docker-compose.yml and core/README.md).
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock* ./
COPY tsconfig.base.json ./
COPY packages/schema packages/schema
COPY core/api core/api
RUN bun install --production --filter '@core/api'
WORKDIR /app/core/api
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER bun
CMD ["bun", "src/server.ts"]
