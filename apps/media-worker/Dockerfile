# Media worker: sharp (libvips) + ffmpeg. Build context is the repo root.
#   podman build -f apps/media-worker/Dockerfile -t minnegela-media-worker .
#
# GPU box: for NVENC transcodes use an ffmpeg build with --enable-nvenc (e.g. the jrottenberg/ffmpeg:*-nvidia
# images, or build ffmpeg against nv-codec-headers) and run with FFMPEG_NVENC=1 and the nvidia CDI device.
# The Debian ffmpeg package below is CPU-only (libx264) and works everywhere.
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/media-worker/package.json apps/media-worker/
RUN pnpm install --frozen-lockfile --filter @minnegela/media-worker...
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/media-worker apps/media-worker
RUN pnpm --filter @minnegela/shared build && pnpm --filter @minnegela/db build && pnpm --filter @minnegela/media-worker build \
 && pnpm --filter @minnegela/media-worker --prod deploy /out

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production WORKER_CACHE_DIR=/cache
WORKDIR /app
COPY --from=build /out /app
VOLUME ["/cache"]
CMD ["node", "dist/main.js"]
