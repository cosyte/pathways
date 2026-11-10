---
id: performance
title: Performance
sidebar_label: Performance
description: "What we measure on Pathways (end-to-end throughput, with encryption on and off, on each database) and how, and how to run the benchmark yourself."
---

# Performance

This page describes what we measure on Pathways, how we measure it, and how to run the benchmark
yourself. The shared method every Cosyte package follows (throughput, latency percentiles, memory,
import time and bundle size, and how a pull request is compared with `main`) is written down in the
performance standard in
[cosyte/config's decision records](https://github.com/cosyte/config/tree/main/documentation/decisions).
The numbers for the current release are in [Current numbers](#current-numbers) below.

## The benchmark

`pnpm bench` (`scripts/bench.ts`) measures one channel end to end: files in, the transform in its
worker, storage, and files out. It:

- writes a number of synthetic `ADT^A01` messages (2,000 by default) as files into a fresh project's
  inbox;
- runs one engine pass, which takes them all in, stores them, transforms each (setting MSH-5), and
  delivers each to a file destination;
- checks that every message was delivered, and reports the time and messages a second;
- does this twice, with encryption at rest off and on, so the cost of encryption shows.

It runs on SQLite by default, or on PostgreSQL, MySQL or SQL Server at an administrator URL, where it
creates a database of its own and drops it afterwards.

What dominates is durable commits: each message is stored, its outputs recorded, and its delivery
marked, each in a transaction that reaches the disk. So the disk under the database matters more than
the CPU, and a figure from one machine is context for that machine, not a promise for another. The
benchmark puts SQLite's file in the system temporary folder, often a memory-backed file system; compare
a database server with its data on the same kind of disk, or say which disk each was on.

## What is not measured yet

The performance standard also asks for latency percentiles, memory over a long run, import time and
bundle size. Pathways does not measure those yet, and the section below says so for each until it
does. The benchmark does not run in CI yet either: we run it before and after a change that could
move throughput, and the pull request gives both numbers.

## What these numbers are not

- **Not a promise for a deployment.** Message sizes, transforms, the disk and the database decide what
  a deployment sees.
- **Not a comparison with other engines.**
- **Not a limit.** Nothing here changes how Pathways behaves under load.

## Run the benchmark yourself

```bash
pnpm install --frozen-lockfile
pnpm bench                       # 2,000 messages through SQLite
pnpm bench 10000                 # more messages
PATHWAYS_BENCH_DATABASE_URL="postgres://postgres:secret@127.0.0.1:5432/postgres" pnpm bench 2000 postgres
```

The database is `sqlite`, `postgres`, `mysql` or `sqlserver`. A server's URL is an administrator's,
in the same form as the test URLs in `.github/workflows/databases.yml`.

## Current numbers

The numbers for this section are measured on `main` at each release and filled in when the release
is built. They are never typed by hand.
