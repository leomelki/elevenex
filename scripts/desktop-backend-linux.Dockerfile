ARG NODE_VERSION=24
# Docker Official Images mirror avoids Docker Hub login/rate-limit requirements.
FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm AS node
# Native addons inherit the builder's libc requirements. Keep the compiler on
# glibc 2.31 so archives also run on Ubuntu 20.04 servers. Copy portable Node
# separately so the launcher's exact version needs no matching Bullseye tag.
FROM public.ecr.aws/docker/library/node:24-bullseye AS build
COPY --from=node /usr/local/ /usr/local/
ARG PNPM_VERSION
WORKDIR /workspace
RUN npm install --global pnpm@${PNPM_VERSION}
COPY manifests/ ./
# The context retains the exact source lock entries for runtime externals.
# The root postinstall builds UI assets, supplied from the Mac instead.
RUN pnpm --filter elevenex-backend install --prod --frozen-lockfile --ignore-scripts \
    && pnpm --filter elevenex-backend... rebuild better-sqlite3 ffmpeg-static onnxruntime-node \
    && npm_config_build_from_source=true pnpm --filter elevenex-backend... rebuild node-pty \
    && rm -rf /root/.local/share/pnpm/store /root/.cache/node-gyp
COPY runtime/ ./
ARG DEVELOPMENT_VERSION
RUN ELEVENEX_BACKEND_STAGE_VERSION=${DEVELOPMENT_VERSION} node scripts/desktop-backend-runtime.mjs

FROM scratch
COPY --from=build /workspace/dist-runtime/ /
