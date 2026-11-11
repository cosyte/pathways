---
"@cosyte/pathways": patch
---

A published, signed container image, and a starter `Dockerfile` that builds a project's own image on it.

- Each release publishes the image to `ghcr.io/cosyte/pathways`, tagged with the version, for `linux/amd64` and `linux/arm64`, with an SBOM and build provenance attached. The release pushes it by digest alone, signs that digest with cosign keyless signing, pulls it back and checks the signature and both platforms' SBOM and provenance, and only then adds the version tag, so a version tag always names a signed, checked image. The image is built from the same commit and lockfile as the npm package, not from the npm tarball. There is no `latest` tag. Check an image with `cosign verify ghcr.io/cosyte/pathways@sha256:<digest> --certificate-identity https://github.com/cosyte/pathways/.github/workflows/release.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
- The image stays as it was: the `pathways` command and the four database drivers. Extensions and cloud packages go in a project's own image.
- `pathways init` now also writes a `Dockerfile` and a `.dockerignore`. The `Dockerfile` builds the project's image FROM the Pathways image of this version, by digest (the build stops until the digest is added to its `PATHWAYS_IMAGE` line), installs the project's `dependencies` in a build stage, copies in `package.json`, `pathways.yaml` and `channels/`, and runs `pathways validate` and `pathways test`, so an image whose channels do not validate or whose tests fail is never made. The `.dockerignore` keeps the development key, the database, the message folders and `node_modules` out. A new how-to, "Deploy the image", says how to ship each change as a new image tag and roll back to the tag before.
- `pathways init` lists the two new files in what it prints. Nothing for an existing project to change; a script that compares `init`'s list of files with a fixed one gains `.dockerignore` and `Dockerfile`.
