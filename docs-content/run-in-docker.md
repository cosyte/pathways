---
id: run-in-docker
title: Run Pathways in Docker
sidebar_label: Docker
description: "Build the Pathways image, mount a project into it, and run the engine, its tests and the operator commands with every database driver included."
---

# Run Pathways in Docker

The repository's `Dockerfile` builds an image with the `pathways` command on Google's distroless
Node.js 24 image: no shell and no package manager, so it has few packages to patch. It carries every
database driver, so one image stores messages in SQLite, PostgreSQL, MySQL or MariaDB, or SQL Server,
as `pathways.yaml` says. It runs as the distroless `nonroot` user (uid 65532).

From the first release on, each release publishes the image to `ghcr.io/cosyte/pathways`, tagged
with its version, for `linux/amd64` and `linux/arm64`, with an SBOM and build provenance, signed with
cosign keyless signing by the release workflow. Pull it by version, or by digest once you have
checked its signature:

```bash
docker pull ghcr.io/cosyte/pathways:<version>
cosign verify ghcr.io/cosyte/pathways@sha256:<digest> \
  --certificate-identity https://github.com/cosyte/pathways/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

To run your channels in production, build your project's own image on it, with the channels inside:
see [Deploy the image](./deploy-the-image.md). The commands below mount a project folder instead,
which suits development and trying it out. They name the image `pathways`; tag the pulled image so,
or build it from a clone of the repository:

```bash
git clone https://github.com/cosyte/pathways.git
docker build --tag pathways pathways
```

## Mount a project

The image runs in `/project`. Mount your project folder there; the default command is
`pathways start -C /project`, and any arguments replace it:

```bash
docker run --rm --volume "$PWD:/project" pathways              # pathways start
docker run --rm --volume "$PWD:/project:ro" pathways test      # the channels' tests
docker run --rm --volume "$PWD:/project" pathways start --once
docker run --rm --volume "$PWD:/project" pathways status
```

`docker stop` sends the engine SIGTERM, the image's stop signal, and it drains: readiness turns 503,
sources stop taking messages, what is being stored is answered, the work in flight finishes within
`drain.timeout`, and the process exits 0. Docker sends SIGKILL 10 seconds after SIGTERM unless told
otherwise, which is less than the 30 second default `drain.timeout`: give it longer than
`drain.notReadyDelay` plus `drain.timeout` with `docker stop --time 40`, or `--stop-timeout 40` on
`docker run`. See [Stop and upgrade a node](./stop-and-upgrade-a-node.md).

## Health check

The image has no shell and no `curl`, so its `HEALTHCHECK` runs
`pathways probe --if-configured -C /project` every 30 seconds. With a `probes` block in
`pathways.yaml`, it asks the probe listener for `/livez` and exits 0 or 1. Without one it exits 0
and asks nothing, so the container is `healthy` once it has started, and all the check then says is
that the engine process is running. Add the block for a check that means more:

```yaml title="pathways.yaml"
probes:
  port: 9091
  plaintext: true
```

What happens on `unhealthy` depends on what reads it. Under plain `docker run` the container keeps
running, and Docker only reports it. Docker Swarm replaces a task that turns `unhealthy`, so with
the block a `stalled` engine is restarted. Compose does not restart on it, but `depends_on` with
`condition: service_healthy` holds back the services that depend on Pathways until it is `healthy`.
A project without the block turns `healthy` under all three. To leave the check out, run with `--no-healthcheck`. For a probe from outside the
container (a load balancer, an orchestrator), set `host: 0.0.0.0` and publish the port
(`--publish 9091:9091`). See
[probe liveness and readiness](./check-status-and-health.md#probe-liveness-and-readiness).

## Files and permissions

The engine writes to the project: the SQLite database in `.pathways/`, and the folders file sources
and destinations use. The image's user is uid 65532, so either give that user the project folder, or
run as your own user:

```bash
mkdir my-project
docker run --rm --user "$(id -u):$(id -g)" --volume "$PWD/my-project:/project" pathways init /project
docker run --rm --user "$(id -u):$(id -g)" --volume "$PWD/my-project:/project" pathways start
```

## Secrets and a database server

Pass master keys, tokens and the database URL as environment variables, or mount the files your
secret store writes:

```bash
docker run --rm \
  --env PATHWAYS_DATABASE_URL \
  --env PATHWAYS_KEY_2026_11 \
  --volume "$PWD:/project" \
  pathways
```

`--env NAME` with no value passes the variable from your shell, so its value does not appear in the
command line.

Before you replace a running engine, run `pathways secrets check` in the new image with the same
variables and mounts: it reads every secret and wraps and unwraps a throwaway key, prints what
resolved but never a value, and exits 1 if anything cannot be had, so a deploy stops before the old
engine does. In Kubernetes it fits an `initContainer`, or a Helm pre-install and pre-upgrade hook; in
Terraform, a step before the service is replaced:

```bash
docker run --rm \
  --env PATHWAYS_DATABASE_URL \
  --env PATHWAYS_KEY_2026_11 \
  --volume "$PWD:/project" \
  pathways secrets check -C /project
```

See [Read secrets: check secrets before a deploy](./read-secrets.md#check-secrets-before-a-deploy). A listening endpoint inside a container must bind to `host: 0.0.0.0` to be reached
through a published port (`--publish 2575:2575`).

## Troubleshoot inside the image

The `debug` target is the same image on distroless's debug variant, which adds a busybox shell. Do not
run it in production:

```bash
docker build --target debug --tag pathways:debug pathways
docker run --rm -it --entrypoint /busybox/sh --volume "$PWD:/project" pathways:debug
```

## Related

- [Deploy the image](./deploy-the-image.md): your project's own image, built on this one, and
  rollbacks.
- [Store messages in a database server](./store-messages-in-a-database.md).
- [Check status and health](./check-status-and-health.md): the health endpoint, for a monitor, and
  the probe listener, for a load balancer or an orchestrator.
