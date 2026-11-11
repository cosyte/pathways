---
id: deploy-the-image
title: Deploy the image
sidebar_label: Deploy the image
description: "Build your project's own image on the published Pathways image, pinned by digest, with its channels tested at build time, and ship each change as a new image tag so a rollback is the tag before."
---

# Deploy the image

Channels stay in git. They reach a node only inside an image: your project's own image, built on the
Pathways image with the channels copied in. Each change to a channel is a commit, the commit builds a
new image tag, and a deploy runs that tag. Nothing on a node is edited by hand, so what runs is what
git holds, and a rollback is running the tag before.

## The Pathways image

From the first release on, each release of Pathways publishes its image to
`ghcr.io/cosyte/pathways`, tagged with the version, for `linux/amd64` and `linux/arm64`. Each one
carries an SBOM and build provenance, and is signed with cosign keyless signing by the release
workflow. It holds the `pathways` command and the four database drivers, nothing else; your
project's image adds what your channels need. There is no `latest` tag.

The image is built from the same commit and the same `pnpm-lock.yaml` as the npm package of that
version, through the repository's `Dockerfile`. It is not the npm tarball: the two are built
separately from one source, so their files are not byte for byte the same.

The release pushes the image by digest first, with no tag. It signs that digest, pulls it back, and
checks the signature and the SBOM and provenance of both platforms, and only then puts the version
tag on it. Just before that it looks the tag up once more, and writes it only when the registry
says the tag does not exist, so a version tag is never replaced. So a version tag always names a
signed, checked image. A release run that fails before
the tag leaves no version tag, only an untagged digest that nothing points at, and the next run
builds and checks the version again from the start.

Look up the digest of the version you want, the `Digest:` line, and check its signature:

```bash
docker buildx imagetools inspect ghcr.io/cosyte/pathways:<version>
cosign verify ghcr.io/cosyte/pathways@sha256:<digest> \
  --certificate-identity https://github.com/cosyte/pathways/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`cosign verify` exits 0 only when the image was signed by the release workflow of this repository,
on `main`.

## Pin it in your project

`pathways init` writes a `Dockerfile` and a `.dockerignore` into the starter project. The
`Dockerfile`'s first instruction names the Pathways image of the version that wrote it, by tag:

```dockerfile
ARG PATHWAYS_IMAGE=ghcr.io/cosyte/pathways:<version>
```

Add the digest you checked, so the same `Dockerfile` builds on the same image every time:

```dockerfile
ARG PATHWAYS_IMAGE=ghcr.io/cosyte/pathways:<version>@sha256:<digest>
```

The build stops, saying so, while the line names a tag alone. To upgrade Pathways, change the line
to the new version's tag and digest in a commit of its own, and follow
[Upgrade Pathways](./upgrade-pathways.md).

## Add packages

Extensions, cloud secret and key providers, and anything a transform imports go in `package.json`'s
`dependencies`, with the `package-lock.json` committed beside it:

```bash
npm install --save <package>
git add package.json package-lock.json
```

The build installs them in a stage of its own, with `npm ci --omit=dev` when there is a
`package-lock.json`, so the image holds exactly the versions it pins. The `devDependencies`, where
`@cosyte/pathways` itself is listed for your editor and `npm test`, stay out: the image carries
Pathways already. Install scripts do not run; take `--ignore-scripts` out of the `Dockerfile` if a
package needs its own.

## Build the project's image

```bash
docker build --tag registry.example.com/integration/my-project:"$(git rev-parse --short HEAD)" .
```

The build copies `package.json`, `pathways.yaml` and `channels/` into `/project`, then runs
`pathways validate` and `pathways test`. A configuration that does not validate, or a channel test
that fails, stops the build, so no image of it exists to deploy. The channels' test messages go into
the image with them, so keep them synthetic.

The `.dockerignore` lets in only what the `Dockerfile` copies: `.pathways/` (the development key and
the SQLite database), `data/`, `node_modules/` and any `.env` never reach the image or the build
cache. If your channels import from another folder, add it to both files.

Tag each image by the commit it was built from, and never build a second image under a tag that is
already in use: a tag that always means the same image is what makes a rollback exact. For both
platforms, build with `docker buildx build --platform linux/amd64,linux/arm64 --push` instead.

## Run it

The project's image runs `pathways start -C /project`, as the Pathways image does, as the `nonroot`
user (uid 65532). It holds no secrets and no messages, so the deploy supplies them:

- the master key and the database URL, as environment variables or files your secret store mounts
  (see [Read secrets](./read-secrets.md) and
  [Encrypt stored messages](./encrypt-stored-messages.md#use-a-key-from-a-file-or-the-environment));
- somewhere to write: a database server, or a volume at `/project/.pathways` for SQLite, and a
  volume for each folder a file source or destination uses. `/project` itself belongs to root, so
  each volume must be writable by uid 65532, or the container run as a user who can write it (see
  [Files and permissions](./run-in-docker.md#files-and-permissions)).

```bash
docker run --rm \
  --env PATHWAYS_DATABASE_URL \
  --env PATHWAYS_KEY_2026_11 \
  registry.example.com/integration/my-project:3f2a91c
```

One image serves staging and production when the settings that differ between them are read from
the environment: see
[settings from the environment](./configuration-reference.md#settings-from-the-environment). Before
you replace a running engine, run `pathways secrets check` in the new image with the same variables
and mounts (see [Check secrets before a deploy](./read-secrets.md#check-secrets-before-a-deploy)).

## Roll back

Run the tag before. The image holds the channels and the Pathways version they were tested with, so
the old tag brings back both, exactly as they were.

When the two tags run different Pathways versions, the database is the one thing they share, and
the image does not roll it back. [Upgrade Pathways: Roll back](./upgrade-pathways.md#roll-back) says
which versions run on a schema a newer one has changed; read it before you roll back across a
Pathways upgrade.

## Related

- [Run Pathways in Docker](./run-in-docker.md): the Pathways image itself, its health check and its
  debug target.
- [Test a channel](./test-a-channel.md): the tests the build runs.
- [Upgrade Pathways](./upgrade-pathways.md).
