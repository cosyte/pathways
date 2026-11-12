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

**Pathways is early.** We are building it in the open, and it is not released yet. The package is not
on npm, and nothing here is ready to run.

---

## Contents

- [Why this exists](#why-this-exists)
- [What we are building](#what-we-are-building)
- [Status](#status)
- [Build from source](#build-from-source)
- [Layout](#layout)
- [Documentation](#documentation)
- [Support](#support)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

Pathways is for a developer who writes and runs integrations: someone who would rather review a
channel in a pull request and test a transform with sample messages than configure both in a product.
So a channel is a file in git, a transform is TypeScript, and both go through review and tests like
the rest of a project's code. Pathways runs on one machine, from the command line or in Docker.

It is not a web UI, not a drop-in replacement for another engine (it does not import channels from
one), and not a sandbox: a transform is your own trusted code.

---

## What we are building

- **Channels in git.** A channel is a YAML file that wires a source to its destinations. Its
  transform is a TypeScript file that receives the parsed message and returns what to send.
- **Formats.** HL7 v2, FHIR, X12, and C-CDA arrive parsed, through Cosyte's open-source
  [`@cosyte/*`](https://github.com/cosyte) libraries. Anything else passes through as text or JSON.
- **Connectors.** MLLP, HTTP, TCP with your own framing, and files, in and out.
- **Nothing lost.** Every message is stored before it is acknowledged. When a destination is down,
  Pathways retries and keeps that destination's messages in order. A failed message can be replayed
  once the transform is fixed.
- **Storage.** SQLite to start with no setup; PostgreSQL, MySQL or MariaDB, and SQL Server for
  production.
- **Tests.** `pathways test` will run synthetic messages through a channel and compare the output with
  saved snapshots.
- **Security controls.** TLS in transit, encryption at rest, an audit log of operator actions, and no
  message contents in logs or errors. Compliance is a property of how an organization runs software,
  so we describe the controls Pathways provides rather than claim compliance for it.

---

## Status

Today the repository holds working slices; nothing is released yet:

- Sources and destinations for MLLP, HTTP, TCP, and files, over TLS by default, with a bearer token or
  mutual TLS on every endpoint that listens.
- HL7 v2, FHIR R4 JSON, X12, C-CDA, JSON, CSV and fixed-width text, and text, each parsed for a
  TypeScript transform that runs in its own worker thread.
- Storage on SQLite, PostgreSQL, MySQL or MariaDB, and SQL Server, with every stored message
  encrypted at rest.
- An audit log of every operator action, and the commands to inspect, replay, and clear messages.
- Your own connectors, hooks, storage, and key providers, loaded from YAML.
- A health endpoint, a Docker image, and the `pathways init`, `pathways start`, and
  `pathways test` commands.

Watch or star the repository to follow along.

Pathways is an open engine, MIT licensed and free to self-host. We plan to offer hosted, managed
Pathways as well. Need an integration built, or hosted and run for you? See our
[integration services](https://cosyte.com/integration-services).

---

## Build from source

Until the first release, the code on `main` runs from a clone. It needs Node.js 24 or later and pnpm
at the version `packageManager` in `package.json` names:

```bash
git clone https://github.com/cosyte/pathways.git
cd pathways
pnpm install --frozen-lockfile
pnpm build
node dist/bin/pathways.mjs --version
```

`node dist/bin/pathways.mjs` then stands in for `pathways` in every command the documentation shows.
[Install Pathways](https://github.com/cosyte/pathways/blob/main/docs-content/installation.md) and the
[quickstart](https://github.com/cosyte/pathways/blob/main/docs-content/quickstart.md) go on from
there.

---

## Layout

- `src/`: the engine, its connectors, storage, encryption and the `pathways` command.
- `test/`: the test suites.
- `templates/starter/`: the starter project `pathways init` writes.
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
