---
id: installation
title: Install Pathways
sidebar_label: Installation
description: "Install the pathways command in a project, check it runs, and add the driver for a database server if you use one."
---

# Install Pathways

Pathways is one npm package, `@cosyte/pathways`, with the `pathways` command inside. It needs
Node.js 24 or later.

## Start a new project

`pathways init` writes a starter project into an empty folder, with the package already listed in
its `package.json`:

```bash
npx @cosyte/pathways init my-project
cd my-project
npm install
```

The [quickstart](./quickstart.md) goes on from here.

## Add Pathways to an existing project

Install it as a development dependency, so the project pins the version it runs:

```bash
npm install --save-dev @cosyte/pathways
npx pathways --version
```

The project needs a `channels/` folder with at least one channel in it before `pathways test` or
`pathways start` will run; [configure a channel](./configure-a-channel.md) shows the layout.

## Add a database driver

SQLite works with no setup: its driver, better-sqlite3, ships with Pathways and carries prebuilt
binaries for Linux, macOS and Windows on x64 and arm64. For a database server, install its driver in
the project:

| Database         | `storage:` key | Install                    |
| ---------------- | -------------- | -------------------------- |
| PostgreSQL       | `postgres`     | `npm install pg`           |
| MySQL or MariaDB | `mysql`        | `npm install mysql2`       |
| SQL Server       | `sqlserver`    | `npm install tedious tarn` |

[Store messages in a database server](./store-messages-in-a-database.md) shows the rest. The Docker
image carries every driver.

## Run from the repository

To run the code on `main`, build it from a clone. This needs pnpm, at the version `packageManager`
in `package.json` names:

```bash
git clone https://github.com/cosyte/pathways.git
cd pathways
pnpm install --frozen-lockfile
pnpm build
node dist/bin/pathways.mjs --version
```

`node dist/bin/pathways.mjs` then stands in for `pathways` in every command on these pages.

## Next

- [Quickstart](./quickstart.md): from `pathways init` to a delivered message.
- [Run Pathways in Docker](./run-in-docker.md), with no Node.js on the host.
