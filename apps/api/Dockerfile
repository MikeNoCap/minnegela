# syntax=docker/dockerfile:1
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @minnegela/api...
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @minnegela/shared build && pnpm --filter @minnegela/db build && pnpm --filter @minnegela/api build
RUN pnpm --filter @minnegela/api --prod deploy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
# migrations ship with the db package so the container can run them at start
EXPOSE 4000
USER node
CMD ["node", "dist/main.js"]
