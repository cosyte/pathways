---
id: performance
title: Performance
sidebar_label: Performance
description: "What we measure on Pathways (end-to-end throughput, latency, memory, import time and scaling) and how, and how to run the benchmarks yourself."
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

## The bench suite

`bench/pathways.bench.mjs` measures the built package the way the performance standard asks, on
[`@cosyte/bench`](https://github.com/cosyte/config/tree/main/packages/bench). Every input is
synthetic and built in code by `bench/shapes.mjs`, in the shapes real traffic has: the small message
a feed sends all day (an HL7 v2 `ADT^A01`, a FHIR Patient, one X12 837P claim, a C-CDA CCD, a JSON
record), a dense large one (an `ORU^R01` with thousands of results, a FHIR Bundle of Observations, a
JSON array of records), and a large opaque payload (an `ORU^R01` carrying a base64 PDF, a text body).

- **Engine passes.** Each benchmark runs the built `pathways` command in a fresh process for one
  pass, `pathways start --once`, over a project with one channel: a file source, SQLite, encryption at
  rest, the transform in its worker, and a file destination. A pass with no input gives the fixed
  cost of a pass (process start, configuration, a fresh database, the worker and its parser); the
  larger passes show what each message adds, from one message to 1,000 in a row and from 64 KiB to
  8 MiB.
- **The ACK builder.** `defaultAckBuilder`, which an MLLP source runs for every message it takes in,
  is measured in process, with its allocations, peak heap and a long run for leaks.
- **The profile.** `bench/profile.mjs` reads what a reading cannot: the memory of one whole engine
  pass (the engine thread's peak heap and external memory, and the whole process's peak resident
  set, above an empty pass, over the input's bytes), the worker's transform path in process (parse,
  transform, serialize: throughput from the smallest size to the largest, allocations, peak memory,
  a long run for leaks), the cold import of the transform worker and the start of the command, a
  CPU and a sampled heap profile of the hottest paths named by their place in `src/`, and the
  proposed budgets read from those numbers.

The Bench reading workflow takes the reading and the profile on a GitHub-hosted runner, by hand or
on a pull request that changes the bench. On every pull request, CI runs the scaling gates
(`pnpm test:perf`: `test/perf/scaling-gate.perf.ts` holds the header read of an MLLP source and the
JSON read of the transform worker to a cost that grows no faster than their input) and times the
base build against the head build with the bench suite, interleaved on one runner. The comparison
is advisory: it reports and never fails a pull request.

## How the engine keeps a message's cost down

- **A body moves; it is not copied.** Encryption and decryption write into one buffer. A store
  that copies what it stores (the SQL store, and any store under encryption) frees its own copy once
  it is stored or read back; the body moves to the transform worker and its outputs move back; and
  the file source and destination free a body once it is stored or written. A large payload the
  engine only passes through is held about once in the engine's own thread, where it was held about
  nine times.
- **Each SQLite statement is prepared once** for the connection, and kept.
- **A JSON body is read once.** Its numbers are checked for a value a JavaScript number cannot hold
  in one pass over the text, rather than through a reviver on every value.
- **Importing the package does not load `@cosyte/hl7`.** `defaultAckBuilder` loads it on its first
  ACK.

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

The bench suite and the profile run against a build:

```bash
pnpm build
pnpm bench:reading --out reading.json   # every benchmark, in fresh processes
pnpm bench:profile --out profile        # memory, the transform path, profiles and budgets
pnpm test:perf                          # the scaling gates
```

The database is `sqlite`, `postgres`, `mysql` or `sqlserver`. A server's URL is an administrator's,
in the same form as the test URLs in `.github/workflows/databases.yml`.

## Current numbers

The numbers for this section are measured on `main` at each release and filled in when the release
is built. They are never typed by hand.
