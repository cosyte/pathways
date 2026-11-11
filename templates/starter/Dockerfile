# This project's own image: the published Pathways image with this project's channels inside it, so a
# deploy is one immutable image tag and a rollback is the tag before it. Channels stay in git and
# reach a node only as a new image.
#
#   docker build --tag my-project:1 .
#   docker run --rm my-project:1 test
#
# The build runs `pathways validate` and `pathways test`, so an image whose configuration is invalid
# or whose channel tests fail is never made. The tests' messages go into the image with the channels,
# so they must be synthetic, as they are in tests/.
#
# The image holds no secrets and no messages: .dockerignore keeps .pathways/ (the development key and
# the SQLite database), data/ and node_modules/ out. At run time, mount the master key and pass the
# database URL as the deploy's secrets, and give the engine somewhere to write.
#
# PATHWAYS_IMAGE names the Pathways image by digest, so the same Dockerfile builds on the same image
# every time. The build stops while it names a tag alone. Look up the digest of the release you want
# (the `Digest:` line of the first command), check its signature, and add it to the line below, as
# ghcr.io/cosyte/pathways:<version>@sha256:<digest>:
#
#   docker buildx imagetools inspect ghcr.io/cosyte/pathways:<version>
#   cosign verify ghcr.io/cosyte/pathways@sha256:<digest> \
#     --certificate-identity https://github.com/cosyte/pathways/.github/workflows/release.yml@refs/heads/main \
#     --certificate-oidc-issuer https://token.actions.githubusercontent.com
ARG PATHWAYS_IMAGE=ghcr.io/cosyte/pathways:{{pathwaysVersion}}

# The packages this project adds: extensions, cloud secret and key providers, and anything a transform
# imports, as package.json's dependencies list them. The devDependencies (@cosyte/pathways itself,
# for the editor and `npm test`) stay out: the image carries Pathways already. Install scripts do not
# run; remove --ignore-scripts if a package needs its own to work.
#
# node:24-trixie-slim (Node 24, Debian 13), the toolchain the Pathways image of this version is built
# with, pinned by the digest of its multi-platform index. Move it when you move PATHWAYS_IMAGE.
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS packages
ARG PATHWAYS_IMAGE
RUN case "$PATHWAYS_IMAGE" in \
      *@sha256:*) ;; \
      *) echo "PATHWAYS_IMAGE is $PATHWAYS_IMAGE: name it by digest (see the top of this Dockerfile)" >&2; exit 1 ;; \
    esac
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /project
COPY package.json package-lock.json* ./
# With a package-lock.json, exactly the versions it pins. Without one, package.json's dependencies
# alone, so nothing of the devDependencies is fetched.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts; \
    else \
      node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync("package.json", "utf8")); delete p.devDependencies; fs.writeFileSync("package.json", JSON.stringify(p));' \
      && npm install --omit=dev --ignore-scripts --no-package-lock; \
    fi \
 && mkdir -p node_modules

# The Pathways image, with the project laid into /project, owned by root so the engine's user can
# read it but not change it. Copy any other folder your channels import from here too.
FROM ${PATHWAYS_IMAGE}
COPY --from=packages /project/node_modules /project/node_modules
COPY package.json pathways.yaml /project/
COPY channels /project/channels
# The image has no shell, so these run the command directly.
RUN ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs", "validate", "-C", "/project"]
RUN ["/nodejs/bin/node", "/app/dist/bin/pathways.mjs", "test", "-C", "/project"]
