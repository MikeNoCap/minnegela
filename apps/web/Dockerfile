# Next.js standalone build. Build context is the repo root:
#   podman build -f apps/web/Dockerfile -t minnegela-web .
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @minnegela/web... --ignore-scripts

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY tsconfig.base.json ./
RUN pnpm --filter @minnegela/shared build && pnpm --filter @minnegela/web build

FROM node:22-slim AS run
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
