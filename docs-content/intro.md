---
id: intro
title: Pathways
sidebar_position: 1
description: "A code-first healthcare integration engine for Node.js. Channels are YAML files in git, transforms are TypeScript functions, and both are tested like any other code."
---

# Pathways

A code-first healthcare integration engine for Node.js. Channels are YAML files in git, transforms
are TypeScript functions, and both are tested like any other code.

> **Pathways is early.** We are building it in the open, and it is not released yet. The package is
> not on npm, and nothing here is ready to run.

## Status

Today the repository holds working slices; nothing is released yet:

- Sources and destinations for MLLP, HTTP, and files, over TLS by default, with a bearer token or
  mutual TLS on every endpoint that listens.
- HL7 v2, FHIR R4 JSON, X12, C-CDA, JSON, and text, each parsed for a TypeScript transform that
  runs in its own worker thread.
- Storage on SQLite, PostgreSQL, MySQL or MariaDB, and SQL Server, with every stored message
  encrypted at rest.
- An audit log of every operator action, and the commands to inspect, replay, and clear messages.
- Your own connectors, hooks, storage, and key providers, loaded from YAML.
- A health endpoint, a Docker image, and the `pathways init`, `pathways start`, and
  `pathways test` commands.

Watch or star the repository to follow along.

The repository: https://github.com/cosyte/pathways
