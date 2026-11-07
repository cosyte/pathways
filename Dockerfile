# The Pathways image: the `pathways` command on Google's distroless Node 24 image, which has no shell
# and no package manager (the fewest packages to patch) and has glibc for the native SQLite driver.
# It runs as the distroless `nonroot` user (uid 65532). Mount a project folder at /project:
#
#   docker build --tag pathways .
#   docker run --rm --volume "$PWD:/project" pathways              # pathways start -C /project
#   docker run --rm --volume "$PWD:/project" pathways test
#   docker run --rm --volume "$PWD:/project" pathways start --once
#
# The `debug` target is the same image on distroless's debug variant, which adds busybox's shell for
# troubleshooting. Do not run it in production:
#
#   docker build --target debug --tag pathways:debug .
#   docker run --rm -it --entrypoint /busybox/sh --volume "$PWD:/project" pathways:debug
#
# Every base image is pinned by the digest of its multi-platform index, with its tag in the comment
# above it. To move one, look up the tag's current index digest and change the two together.
#
# .github/workflows/docker.yml builds this and runs it against a starter project made by
# `pathways init`.

# node:24-trixie-slim (Node 24, Debian 13), pinned 2026-11-07.
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS toolchain
ENV CI=true \
    SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# The pnpm that package.json#packageManager pins. Its value, such as "pnpm@10.34.5", is also an npm
# package spec, so the pin lives in one place. hadolint cannot see the version inside it.
# hadolint ignore=DL3016
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"

# dist/: the bundled command and its transform worker, side by side in dist/bin/.
#
# Both installs skip install scripts. better-sqlite3 carries its native binaries inside the package,
# built for glibc and musl on each platform; its only script runs node-gyp, which needs Python, to
# confirm that a binary is there. The other scripts are esbuild's, which pnpm already skips here,
# and this package's own `prepare`, which installs git hooks.
FROM toolchain AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

# The production dependencies only. better-sqlite3 also carries what this image never uses: the C
# sources it was built from and its binaries for other platforms. Those are dropped, keeping the
# glibc build for this platform; `test -f` fails the build if that one is missing.
FROM toolchain AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
 && sqlite="$(node -p 'require("node:path").dirname(require.resolve("better-sqlite3/package.json"))')" \
 && keep="$(node -p 'process.platform + "-" + process.arch').node" \
 && test -f "$sqlite/prebuilds/$keep" \
 && find "$sqlite/prebuilds" -type f ! -name "$keep" -delete \
 && rm -r "$sqlite/deps" "$sqlite/src"

# What both runtime targets copy: owned by root, so the nonroot user can read it but not change it.
# init reads templates/starter/ from two folders above dist/bin/pathways.mjs.
FROM scratch AS app
COPY --from=deps /build/node_modules /app/node_modules
COPY --from=build /build/dist /app/dist
COPY package.json LICENSE /app/
COPY templates /app/templates

# gcr.io/distroless/nodejs24-debian13:debug-nonroot, pinned 2026-11-07.
FROM gcr.io/distroless/nodejs24-debian13:debug-nonroot@sha256:3113adad6d98116a67d4a60b23d227fbafa704208b3b114c4a91470c244c3af1 AS debug
LABEL org.opencontainers.image.source="https://github.com/cosyte/pathways" \
      org.opencontainers.image.licenses="MIT"
COPY --from=app /app /app
USER 65532:65532
WORKDIR /project
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs"]
CMD ["start", "-C", "/project"]

# gcr.io/distroless/nodejs24-debian13:nonroot, pinned 2026-11-07. The default target: keep it last.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba AS runtime
LABEL org.opencontainers.image.source="https://github.com/cosyte/pathways" \
      org.opencontainers.image.licenses="MIT"
COPY --from=app /app /app
USER 65532:65532
WORKDIR /project
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs"]
CMD ["start", "-C", "/project"]
