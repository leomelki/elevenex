ARG NODE_VERSION=24.22.3
ARG LINUX_BUILD_IMAGE=quay.io/pypa/manylinux_2_28_aarch64
# Take the portable upstream Node binary, not the Debian build environment.
FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm AS node
# Native addons must target Node's glibc 2.28 baseline too. Building on Bookworm
# introduces GLIBC_2.34 pthread symbols and breaks Ubuntu 20.04 servers.
FROM ${LINUX_BUILD_IMAGE} AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
ARG PNPM_VERSION
WORKDIR /workspace
RUN node /usr/local/lib/node_modules/npm/bin/npm-cli.js install --global pnpm@${PNPM_VERSION}
COPY manifests/ ./
# The context retains the exact source lock entries for runtime externals.
# The root postinstall builds UI assets, supplied from the Mac instead.
# pnpm 8 bundles node-gyp 9, whose gyp imports distutils (removed in Python 3.12).
RUN pnpm --filter elevenex-backend install --prod --frozen-lockfile --ignore-scripts \
    && npm_config_python=/opt/python/cp311-cp311/bin/python3 npm_config_build_from_source=true pnpm --filter elevenex-backend... rebuild better-sqlite3 node-pty \
    && pnpm --filter elevenex-backend... rebuild ffmpeg-static onnxruntime-node \
    && rm -rf /root/.local/share/pnpm/store /root/.cache/node-gyp
COPY runtime/ ./
ARG DEVELOPMENT_VERSION
RUN ELEVENEX_LINUX_RUNTIME_BUILDER=1 ELEVENEX_BACKEND_STAGE_VERSION=${DEVELOPMENT_VERSION} node scripts/desktop-backend-runtime.mjs

FROM scratch
COPY --from=build /workspace/dist-runtime/ /
