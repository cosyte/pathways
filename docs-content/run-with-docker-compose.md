---
id: run-with-docker-compose
title: Run Pathways with Docker Compose
sidebar_label: Docker Compose
description: "Start the Pathways image beside PostgreSQL with Docker Compose, send a synthetic HL7 v2 message through a channel, and check that it arrived."
---

# Run Pathways with Docker Compose

The repository's
[`examples/docker-compose/`](https://github.com/cosyte/pathways/tree/main/examples/docker-compose)
runs the engine from the published image beside a PostgreSQL server that stores its messages. It
holds:

- `compose.yaml`: the two services, each with a health check, and a named volume for each of the
  database and the message folders.
- `.env.example`: the variables the example's `compose.yaml` uses and the ones Pathways reads by a
  fixed name, each with a comment and no real secret.
- `channels/adt-to-lab/`: the starter's channel, which reads HL7 v2 files from
  `data/adt-to-lab/in`, keeps only admissions (`ADT^A01`), sets the receiving application to `LAB`,
  and writes them to `data/adt-to-lab/out`. Its tests hold synthetic messages only.

A project from `pathways init` carries the same `compose.yaml` and `.env.example`, so the steps
below run in it too. You need Docker with Compose 2.23.1 or later, and `openssl` to make the secrets.

## 1. Fill in .env

Copy the example's `.env.example` to `.env`, which `.gitignore` keeps out of git:

```bash
cd examples/docker-compose
cp .env.example .env
```

Then give the three variables at the top a value:

- `PATHWAYS_VERSION`, the release to run: a version tag of `ghcr.io/cosyte/pathways`. In a project
  from `pathways init` it is already the version that wrote the project. For production, pin the
  image by its digest as well, as the tag followed by `@` and the digest:
  `PATHWAYS_VERSION=0.1.0@sha256:<digest>`. Compose then runs that image and no other, even if the
  tag is moved. [Run Pathways in Docker](./run-in-docker.md) says how to check its signature.
- `POSTGRES_PASSWORD`, the database password, in letters and digits: `openssl rand -hex 24`.
- `PATHWAYS_KEY`, the master key that wraps each stored message's data key: `openssl rand -base64 32`.
  Keep a copy in your secret store; without it the stored messages cannot be read.

Compose refuses to start while any of the three is empty, and names it. The other variables in the
file are the ones Pathways reads by a fixed name, commented out. Compose hands every variable in
`.env` to the engine, so a channel's `{ env: NAME }` settings go there too.

How that list is kept: Pathways' source exports `ENGINE_VARIABLES`, the variables it reads by a
fixed name, and a test compares each `.env.example` with it both ways. The type checker and lint
refuse the listed ways for the source to read a fixed-name variable outside that list; any other
route is caught by review, not by a check.

Until `ghcr.io/cosyte/pathways` is public, pulling it can fail with an authentication error
(`unauthorized` or `denied`): sign in first with `docker login ghcr.io`, or build the image
locally. Before the first release no image is published yet, so build one from the clone, tagged as
the version you set in `.env`, here the version on `main`:

```bash
docker build --tag "ghcr.io/cosyte/pathways:$(jq -r .version ../../package.json)" ../..
```

## 2. Start it

```bash
docker compose up --detach --wait
```

Compose starts PostgreSQL, waits for its health check, gives the message folders' volume to the
engine's user (uid 65532) alone, with mode 700, and starts the engine. `--wait` returns once the engine's own health
check passes: it runs `pathways probe --ready` inside the container, which asks the probe listener
for `/readyz`.

Under Compose the engine reads the `pathways.yaml` inside `compose.yaml` (its `configs` block), not
one beside it. It is this:

```yaml title="pathways.yaml"
storage:
  postgres:
    url: { env: PATHWAYS_DATABASE_URL }
    plaintext: true
encryption:
  keys:
    - id: compose
      env: PATHWAYS_KEY
  current: compose
probes:
  port: 9091
  plaintext: true
```

The database is reached only on the project's own Compose network, which is why the connection is
`plaintext`; for a server elsewhere, use `tls: {}` and set `PATHWAYS_DATABASE_URL` in `.env`. In a
project from `pathways init`, the project's own `pathways.yaml` (SQLite and the development key)
stays for running on your machine, so put a setting the engine needs under Compose in both.

## 3. Send a synthetic message through

Copy the channel's synthetic admission into the folder its source reads:

```bash
docker compose cp channels/adt-to-lab/tests/a01.hl7 pathways:/project/data/adt-to-lab/in/
```

Within a few seconds the engine stores it, encrypted, in PostgreSQL, deletes the file, runs the
transform, and writes the output. Ask the engine what it stored:

```bash
docker compose exec pathways /nodejs/bin/node /app/dist/bin/pathways.mjs messages --status delivered
```

The image has no shell, so `exec` runs the command with its full path. Then copy the output out and
compare it with what the channel's test expects:

```bash
docker compose cp pathways:/project/data/adt-to-lab/out ./delivered
cmp delivered/1-1.hl7 channels/adt-to-lab/tests/a01.expected.hl7
```

## 4. Stop it

```bash
docker compose down
```

`docker compose down` stops the engine with SIGTERM, which it ends cleanly, and keeps both volumes.
Add `--volumes` to delete the stored messages and the message folders too.

## In CI

The repository's `compose` workflow runs these steps on every pull request: it builds the image,
fills in `.env` with throwaway secrets, starts the example, sends the synthetic A01 through, and
checks that the engine stored it as delivered and that the output equals the expected file.

## Related

- [Run Pathways in Docker](./run-in-docker.md): the image, its health check and its user.
- [Deploy the image](./deploy-the-image.md): your project's own image, with the channels inside, for
  production.
- [Store messages in a database server](./store-messages-in-a-database.md).
- [Read secrets](./read-secrets.md): master keys and tokens from a secret store.
