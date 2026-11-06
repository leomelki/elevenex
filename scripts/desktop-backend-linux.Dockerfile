ARG NODE_VERSION=24
# Docker Official Images mirror avoids Docker Hub login/rate-limit requirements.
FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm AS build
ARG PNPM_VERSION
WORKDIR /workspace
RUN npm install --global pnpm@${PNPM_VERSION}
COPY manifests/ ./
# The context retains the exact source lock entries for runtime externals.
# The root postinstall builds UI assets, supplied from the Mac instead.
RUN pnpm --filter elevenex-backend install --prod --frozen-lockfile --ignore-scripts \
    && pnpm --filter elevenex-backend... rebuild better-sqlite3 node-pty ffmpeg-static onnxruntime-node \
    && rm -rf /root/.local/share/pnpm/store /root/.cache/node-gyp
COPY runtime/ ./
ARG DEVELOPMENT_VERSION
RUN ELEVENEX_BACKEND_STAGE_VERSION=${DEVELOPMENT_VERSION} node scripts/desktop-backend-runtime.mjs

FROM scratch
COPY --from=build /workspace/dist-runtime/ /
