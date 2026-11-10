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

We do not publish the image yet; build it from a clone of the repository:

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

`docker stop` sends the engine SIGTERM, and it stops cleanly: sources stop taking messages, what is
being stored is answered, and the process exits 0.

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
command line. A listening endpoint inside a container must bind to `host: 0.0.0.0` to be reached
through a published port (`--publish 2575:2575`).

## Troubleshoot inside the image

The `debug` target is the same image on distroless's debug variant, which adds a busybox shell. Do not
run it in production:

```bash
docker build --target debug --tag pathways:debug pathways
docker run --rm -it --entrypoint /busybox/sh --volume "$PWD:/project" pathways:debug
```

## Related

- [Store messages in a database server](./store-messages-in-a-database.md).
- [Check status and health](./check-status-and-health.md): the health endpoint, for a monitor or an
  orchestrator's probe. The image has no shell or `curl`, so a probe calls it from outside.
