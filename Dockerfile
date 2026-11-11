# The Pathways image: the `pathways` command on Google's distroless Node 24 image, which has no shell
# and no package manager (the fewest packages to patch) and has glibc for the native SQLite driver.
# It carries every database driver, so one image stores messages in SQLite (the default), PostgreSQL
# (pg), MySQL or MariaDB (mysql2), or SQL Server (tedious and tarn), as pathways.yaml's storage says.
# It runs as the distroless `nonroot` user (uid 65532). Mount a project folder at /project:
#
#   docker build --tag pathways .
#   docker run --rm --volume "$PWD:/project" pathways              # pathways start -C /project
#   docker run --rm --volume "$PWD:/project" pathways test
#   docker run --rm --volume "$PWD:/project" pathways start --once
#
# `docker stop` sends SIGTERM (STOPSIGNAL says so outright): the engine turns not ready, closes its
# sources, and exits 0. The image has no shell or curl, so its HEALTHCHECK runs `pathways probe`,
# which asks the probe listener of pathways.yaml's `probes` block for /livez. Without that block the
# check fails and Docker reports the container unhealthy; add the block, or run with
# --no-healthcheck.
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
# `pathways init`, on SQLite and on PostgreSQL, MySQL and SQL Server. Each release builds it for
# linux/amd64 and linux/arm64 and publishes it to ghcr.io/cosyte/pathways (release.yml), signed and
# with an SBOM and provenance. The image stays lean: the four database drivers and nothing else. A
# project's own image adds extension and cloud packages on top of it (templates/starter/Dockerfile).
#
# A multi-platform build runs the toolchain stages below on the builder's own platform, since what
# they make (the bundled JavaScript, the pure JavaScript drivers) is the same on every platform. Only
# `deps` runs on the target platform: it keeps that platform's native SQLite binary.

# node:24-trixie-slim (Node 24, Debian 13), pinned 2026-11-07. `build-toolchain` below names the same
# digest: move the two together.
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

# The same toolchain on the builder's own platform, for the stages whose output is the same on
# every platform. On a one-platform build the two are the same image.
# node:24-trixie-slim (Node 24, Debian 13), pinned 2026-11-07, the digest `toolchain` names.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS build-toolchain
ENV CI=true \
    SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# hadolint ignore=DL3016
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"

# dist/: the bundled command and its transform worker, side by side in dist/bin/.
#
# Both installs skip install scripts. better-sqlite3 carries its native binaries inside the package,
# built for glibc and musl on each platform; its only script runs node-gyp, which needs Python, to
# confirm that a binary is there. The other scripts are esbuild's, which pnpm already skips here,
# and this package's own `prepare`, which installs git hooks.
#
# The database server drivers and the SFTP client (ssh2) are optional peer dependencies, which a
# production install leaves out. scripts/copy-drivers.ts copies each one package.json's
# peerDependencies names, with every package it loads, from this full install into /drivers, at the
# versions the lockfile pins. They are pure JavaScript (ssh2's optional native add-ons are never
# installed or built, as pnpm-workspace.yaml says), so the copy made on the builder's platform loads
# on every target.
FROM build-toolchain AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY scripts/copy-drivers.ts ./scripts/
RUN node scripts/copy-drivers.ts . /drivers
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

# The production dependencies, with the database drivers laid over them. better-sqlite3 also
# carries what this image never uses: the C sources it was built from and its binaries for other
# platforms. Those are dropped, keeping the glibc build for this platform; `test -f` fails the build
# if that one is missing. The drivers come from the same lockfile, so a package both installs hold
# is the same files. The last step fails the build if any driver does not load.
FROM toolchain AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
 && sqlite="$(node -p 'require("node:path").dirname(require.resolve("better-sqlite3/package.json"))')" \
 && keep="$(node -p 'process.platform + "-" + process.arch').node" \
 && test -f "$sqlite/prebuilds/$keep" \
 && find "$sqlite/prebuilds" -type f ! -name "$keep" -delete \
 && rm -r "$sqlite/deps" "$sqlite/src"
COPY --from=build /drivers/node_modules /build/node_modules
RUN node --input-type=module --eval 'for (const name of Object.keys(JSON.parse(process.argv[1]))) await import(name);' \
      "$(node -p 'JSON.stringify(require("./package.json").peerDependencies)')"

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
STOPSIGNAL SIGTERM
# Asks the probe listener when pathways.yaml has a probes block, and passes when it has none.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs", "probe", "--if-configured", "-C", "/project"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs"]
CMD ["start", "-C", "/project"]

# gcr.io/distroless/nodejs24-debian13:nonroot, pinned 2026-11-07. The default target: keep it last.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba AS runtime
LABEL org.opencontainers.image.source="https://github.com/cosyte/pathways" \
      org.opencontainers.image.licenses="MIT"
COPY --from=app /app /app
USER 65532:65532
WORKDIR /project
STOPSIGNAL SIGTERM
# Asks the probe listener when pathways.yaml has a probes block, and passes when it has none.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs", "probe", "--if-configured", "-C", "/project"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs"]
CMD ["start", "-C", "/project"]
