---
id: intro
title: Pathways
sidebar_label: Overview
description: "A code-first healthcare integration engine for Node.js. Channels are YAML files in git, transforms are TypeScript, and both are tested like code."
---

# Pathways

A code-first healthcare integration engine for Node.js. Channels are YAML files in git, transforms
are TypeScript functions, and both are tested like any other code.

> **Pathways is early.** We are building it in the open, and it is not released yet. The package is
> not on npm, and nothing here is ready to run.

## What it does

Pathways takes messages in from one system, runs each through a transform you write, and delivers
the result to one or more other systems. Every message is stored before its sender is acknowledged,
so a restart loses nothing.

- **Channels in git.** A channel is a folder with a `channel.yaml` that wires a source to its
  destinations, a `transform.ts`, and a `tests/` folder of sample messages with their expected
  output.
- **Transforms in TypeScript.** A transform receives the parsed message and returns a message,
  several messages, or `null` to filter it out. Node.js runs it as it is, with no build step, in a
  worker thread of the channel's own.
- **Formats.** HL7 v2, FHIR R4 JSON, X12, and C-CDA arrive parsed, through our open-source
  `@cosyte/*` libraries. JSON arrives as a value and anything else as text.
- **Connectors.** MLLP, HTTP, and files, in and out, over TLS by default.
- **Storage.** SQLite with no setup, or PostgreSQL, MySQL or MariaDB, and SQL Server, with every
  stored message encrypted at rest.
- **Operations from the command line.** `pathways status`, `messages`, `replay`, `clear`,
  `retention` and `audit`, an append-only audit log of operator actions, and a health endpoint.
- **Yours to extend.** Your own sources, destinations, MLLP ACK builders, lifecycle hooks, storage
  adapters and key providers, each a TypeScript module named in the YAML.

## Who it is for

A developer who writes and runs integrations: someone who would rather review a channel in a pull
request and test a transform with sample messages than configure both in a product. Pathways runs
on one machine, from the command line or in Docker.

## What it is not

- **Not a web UI.** Pathways has a command line and a health endpoint, and no screens, logins or
  roles.
- **Not a drop-in replacement** for another engine. It does not import channels from one.
- **Not a sandbox.** A transform is your own trusted code. Its worker thread protects the engine
  from a transform that hangs, throws or runs out of memory, not from one written to do harm.
- **Not a compliance claim.** Pathways provides security controls; compliance is a property of how
  an organization runs software. [The security model](./security-model.md) says what Pathways does
  and what stays with you.

## Where to go next

- [Install Pathways](./installation.md), then follow the [quickstart](./quickstart.md) from
  `pathways init` to a delivered message.
- [Write a channel](./write-a-channel.md) from nothing, with its tests.
- [How delivery and errors work](./delivery-and-errors.md), before you run Pathways for real.

The repository: https://github.com/cosyte/pathways
