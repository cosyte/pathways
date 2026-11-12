<a href="https://cosyte.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cosyte.com/tile/cosyte-lockup-tile-on-dark-1200x300.png">
    <img alt="The Cosyte logo on its own white ground: the icon beside the word Cosyte." src="https://cosyte.com/tile/cosyte-lockup-tile-on-light-1200x300.png">
  </picture>
</a>

# Pathways

> A code-first healthcare integration engine for Node.js: channels in YAML, transforms in TypeScript.

[![CI](https://img.shields.io/github/actions/workflow/status/cosyte/pathways/ci.yml?branch=main&label=CI)](https://github.com/cosyte/pathways/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/cosyte/pathways/blob/main/LICENSE)

A code-first healthcare integration engine for Node.js. Channels are YAML files in git, transforms
are TypeScript functions, and both are tested like any other code.

Pathways is published on npm as [`@cosyte/pathways`](https://www.npmjs.com/package/@cosyte/pathways),
and a signed container image of each release is at `ghcr.io/cosyte/pathways`. It is early: the
version is 0.0.x, and a release may still change a key or an API, which its changelog says.

---

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Why this exists](#why-this-exists)
- [What the latest release ships](#what-the-latest-release-ships)
- [In the next release](#in-the-next-release)
- [Status](#status)
- [Build from source](#build-from-source)
- [Layout](#layout)
- [Documentation](#documentation)
- [Support](#support)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## Install

Pathways needs Node.js 24 or later. Start a new project with the starter, which lists the package in
its own `package.json`:

```bash
npx @cosyte/pathways init my-project
cd my-project
npm install
```

Or add it to a project you have, as a development dependency so the project pins its version:

```bash
npm install --save-dev @cosyte/pathways
npx pathways --version
```

SQLite works with no setup. For PostgreSQL, MySQL or MariaDB, or SQL Server, install that
database's driver in the project:
[Install Pathways](https://github.com/cosyte/pathways/blob/main/docs-content/installation.md) lists
them.

---

## Quickstart

The starter holds one channel, `adt-to-lab`: it reads HL7 v2 files from `data/adt-to-lab/in`, keeps
only admissions (`ADT^A01`), sets the receiving application to `LAB`, and writes them to
`data/adt-to-lab/out`. Its two test messages are synthetic.

In the project `init` wrote, run the channel's tests, then start the engine:

```bash
npm test
npm start
```

`npm test` runs `pathways test`, which sends each test message through the transform and compares
the output with the `.expected` file beside it. `npm start` runs the channel until you stop it. In a
second terminal, in the same folder, drop the test messages into the channel's inbox:

```bash
mkdir -p data/adt-to-lab/in
cp channels/adt-to-lab/tests/a01.hl7 channels/adt-to-lab/tests/a08.hl7 data/adt-to-lab/in/
```

Within a few seconds the admission is delivered to `data/adt-to-lab/out/1-1.hl7` and the update is
filtered out. Stop the engine with Ctrl+C, and `npx pathways status` counts one delivered. The
[quickstart](https://github.com/cosyte/pathways/blob/main/docs-content/quickstart.md) walks through
each step and what the engine logs.

For the common shapes, start from an example in
[`examples/`](https://github.com/cosyte/pathways/tree/main/examples): a small project that runs on
synthetic messages, with its tests, which CI runs on every change. Each has a page:

- [HL7 v2 over MLLP in, HTTP out](https://github.com/cosyte/pathways/blob/main/docs-content/example-mllp-to-http.md)
- [A file drop to SFTP](https://github.com/cosyte/pathways/blob/main/docs-content/example-file-to-sftp.md)
- [HL7 v2 to FHIR](https://github.com/cosyte/pathways/blob/main/docs-content/example-hl7-to-fhir.md)
- [Filter, then send to two destinations](https://github.com/cosyte/pathways/blob/main/docs-content/example-filter-and-route.md)
- [Replay after a failure](https://github.com/cosyte/pathways/blob/main/docs-content/example-replay-after-failure.md)
- [A veterinary lab result to FHIR](https://github.com/cosyte/pathways/blob/main/docs-content/example-vet-lab-to-fhir.md)

---

## Why this exists

Pathways is for a developer who writes and runs integrations: someone who would rather review a
channel in a pull request and test a transform with sample messages than configure both in a product.
So a channel is a file in git, a transform is TypeScript, and both go through review and tests like
the rest of a project's code. Pathways runs on one machine, from the command line or in Docker.

It is not a web UI, not a drop-in replacement for another engine (it does not import channels from
one), and not a sandbox: a transform is your own trusted code.

---

## What the latest release ships

What follows is in 0.0.3, the version on npm:

- **Channels in git.** A channel is a YAML file that wires a source to its destinations. Its
  transform is a TypeScript file that receives the parsed message and returns what to send.
- **Formats.** HL7 v2, FHIR R4 JSON, X12, and C-CDA arrive parsed, through Cosyte's open-source
  [`@cosyte/*`](https://github.com/cosyte) libraries. CSV and fixed-width text arrive as a table.
  JSON arrives as a value and anything else as text.
- **Connectors.** MLLP, HTTP, TCP with your own framing, and files in a folder, on an SFTP server,
  or on Amazon S3 and Azure Blob Storage, in and out, and an SMTP destination. Over TLS by default,
  with a bearer token or mutual TLS on every endpoint that listens, and limits on MLLP connections
  and message sizes.
- **Nothing lost.** Every message is stored before it is acknowledged. When a destination is down,
  Pathways retries and keeps that destination's messages in order. A failed message can be replayed
  once the transform is fixed, and every failed message in a scope at once, counted first and
  resumable.
- **Storage.** SQLite with no setup, or PostgreSQL, MySQL or MariaDB, and SQL Server, with every
  stored message encrypted at rest, separate retention clocks, and sealed archives.
- **Tests.** `pathways test` runs synthetic messages through a channel and compares the output with
  saved files, and `pathways validate` checks a project's configuration without its secrets.
- **Operations.** An audit log of every operator action; commands to inspect, replay and clear
  messages, and to pause, stop and reload one channel of a running engine; a bounded drain when the
  engine is told to stop; a health endpoint with liveness and readiness probes; and a signed Docker
  image.
- **Yours to extend.** Your own sources, destinations, hooks, storage and key providers, each a
  TypeScript module named in the YAML.
- **Security controls.** TLS in transit, encryption at rest, an audit log of operator actions, and no
  message contents in logs or errors. Compliance is a property of how an organization runs software,
  so we describe the controls Pathways provides rather than claim compliance for it.

---

## In the next release

These are on `main` and land in the next release, not in 0.0.3:

- The package description on npm no longer says Pathways is not yet out.
  <!-- changesets: release-status -->
- An `xml` format: any XML body reaches the transform as a DOM document, read by `@cosyte/ccda`'s
  hardened reader, with size and shape caps, and an untouched document leaves byte for byte.
  <!-- changesets: xml-format -->

The changelog lists each once it is released.

---

## Status

Early, and released: 0.0.3 is on npm. Each release is published with provenance from this
repository's release workflow, with its signed image. Watch or star the repository to follow along.

Pathways is an open engine, MIT licensed and free to self-host. We plan to offer hosted, managed
Pathways as well. Need an integration built, or hosted and run for you? See our
[integration services](https://cosyte.com/integration-services).

---

## Build from source

To work on Pathways itself, or to run what is on `main` before it is released, build it from a
clone. It needs Node.js 24 or later and pnpm at the version `packageManager` in `package.json`
names:

```bash
git clone https://github.com/cosyte/pathways.git
cd pathways
pnpm install --frozen-lockfile
pnpm build
node dist/bin/pathways.mjs --version
```

`node dist/bin/pathways.mjs` then stands in for `pathways` in every command the documentation shows.
`AGENTS.md` lists the checks to run before a pull request.

---

## Layout

- `src/`: the engine, its connectors, storage, encryption and the `pathways` command.
- `test/`: the test suites.
- `templates/starter/`: the starter project `pathways init` writes.
- `examples/`: example projects, each with its tests and a page in `docs-content/`.
- `examples/docker-compose/`: the engine under Docker Compose, beside PostgreSQL.
- `docs-content/`: the documentation pages.
- `bench/`: the benchmark suites.
- `scripts/`: the repository's own scripts.
- `Dockerfile`: the container image.

---

## Documentation

The pages live in this repository's
[`docs-content/`](https://github.com/cosyte/pathways/tree/main/docs-content). Start with these:

- [Overview](https://github.com/cosyte/pathways/blob/main/docs-content/intro.md): what Pathways does,
  who it is for and what it is not.
- [Write a channel](https://github.com/cosyte/pathways/blob/main/docs-content/write-a-channel.md):
  a channel from nothing, with its tests.
- [How delivery and errors work](https://github.com/cosyte/pathways/blob/main/docs-content/delivery-and-errors.md),
  before you run Pathways for real.
- [The security model](https://github.com/cosyte/pathways/blob/main/docs-content/security-model.md):
  what Pathways does to protect the data it moves and stores, and what stays with you.
- [Run Pathways with Docker Compose](https://github.com/cosyte/pathways/blob/main/docs-content/run-with-docker-compose.md):
  the engine beside PostgreSQL, from
  [`examples/docker-compose/`](https://github.com/cosyte/pathways/tree/main/examples/docker-compose),
  with a synthetic message sent through.
- [Testing and quality](https://github.com/cosyte/pathways/blob/main/docs-content/testing-and-quality.md)
  and [Performance](https://github.com/cosyte/pathways/blob/main/docs-content/performance.md).

---

## Support

Questions, bug reports and feature requests go on the
[issue tracker](https://github.com/cosyte/pathways/issues).

---

## Security

Report a vulnerability privately, as the
[security policy](https://github.com/cosyte/.github/blob/main/SECURITY.md) describes, never in a
public issue.

### PHI and safety

Pathways moves messages that carry patient data between clinical systems. Logs, errors and the
health body carry ids, counts and codes, never a message's content. A transform is your own trusted
code: its worker thread protects the engine from a transform that hangs, throws or runs out of
memory, not from one written to do harm.
[The security model](https://github.com/cosyte/pathways/blob/main/docs-content/security-model.md)
says what Pathways does and what stays with the organization that runs it.

Never attach a real patient's message, a log from a live system or anything else that holds patient
data to an issue: a synthetic message that shows the problem is enough, and
[`@cosyte/synth`](https://docs.cosyte.com/synth) makes one.

---

## Contributing

Pull requests are welcome. For anything that changes how a message is stored, routed or delivered, or
moves the public API, open an issue first so the behavior can be agreed before it is written. Every
fixture is synthetic, a change in behavior comes with a test that fails without it, and a change to
what a reader sees updates the pages in `docs-content/` in the same pull request. `AGENTS.md` lists
the checks a pull request must pass, and
[Testing and quality](https://github.com/cosyte/pathways/blob/main/docs-content/testing-and-quality.md)
says the floor they hold a change to. The organization's
[contributing guide](https://github.com/cosyte/.github/blob/main/CONTRIBUTING.md) and
[code of conduct](https://github.com/cosyte/.github/blob/main/CODE_OF_CONDUCT.md) apply here.

---

## License

MIT, Copyright (c) 2026 Cosyte LLC. See
[LICENSE](https://github.com/cosyte/pathways/blob/main/LICENSE).
