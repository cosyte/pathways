---
id: performance
title: Performance
sidebar_label: Performance
description: "What we measure on Pathways (throughput, open-loop latency and capacity, memory, import time and scaling), how, and how to run the benchmarks yourself."
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

What dominates is durable commits. With the default settings and one destination, each message takes
four, each a transaction that reaches the disk: the message is stored, its outputs are recorded, its
delivery is marked as sending before the send (the marker that flags a resend after a crash), and
then marked delivered. Each further destination adds two more, and `resendFlag: false` saves the
marker, one for each destination. So the disk under the database matters more than
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

## The open-loop bench

`pnpm bench` and the engine passes above are closed loops: every message is already waiting, and
the engine sets the pace. That says how fast the engine drains a backlog, not how it answers
traffic that arrives on its own schedule. `bench/open-loop/run.mjs` measures that, from outside the
engine, in three processes:

- **The engine** is the built `pathways start`, as production runs it: the engine lease held, the
  marker written before each send, encryption at rest on, a health endpoint, and the fault points
  compiled out of the build. Each channel takes synthetic HL7 v2 `ADT^A01` messages, sets MSH-5 in
  its worker, and delivers to an MLLP receiver (and, in one case, an HTTP receiver and a folder too).
- **The sender** sends MLLP, MLLP over TLS or HTTPS at a fixed rate, in a process of its own. It is
  an open loop: message _n_ is due at _start + n / rate_ and goes out when it is due, answered or
  not. Each message's latency runs from when it was due to its ACK, so a sender that falls behind is
  charged for the wait, rather than quietly sending less while the engine is slow (the coordinated
  omission that wrk2 describes). Latency is recorded in HdrHistogram and reported as p50, p99, p99.9
  and the maximum, never a mean.
- **The driver** runs the receivers, reads the engine's queue (stored messages not yet transformed,
  and deliveries not yet done) from the health endpoint once a second, and reads the engine's
  resident set from the operating system.

**Capacity** is written down as a rule. A ladder of rates runs each rate for 20 seconds. A rate
holds when every message is answered `AA`, the p99 is at most 100 ms, and the queue stays flat: its
fitted growth over the step (a Theil-Sen slope, which one outlying sample cannot move) is less than
one second of the step's traffic. The capacity of a run is the highest rate that holds, with every
rate below it holding too.

The cases are MLLP, MLLP over TLS and HTTPS on SQLite; MLLP over TLS on PostgreSQL; four channels
with three destinations each; a retry backlog, where the MLLP receiver goes down for 30 seconds
while traffic keeps coming and then returns (how long the backlog takes to drain, how long the
engine's first delivery on its new connection takes, and how long a new sender connection waits
for its first ACK meanwhile); a startup with a backlog, where the engine is stopped with a backlog
and started again (the time to answer health, to the first ACK on a new connection, and to drain);
an hour at one rate, for the slope of the resident set; and the closed-loop drain, for comparison.

Each case runs five times on one runner, and every run is reported with the spread: none is picked.
Each reading states the message size, the destinations, the storage and the disk under it,
encryption, TLS, the runner, the Node version and the commit, in the results format of
[`@cosyte/bench`](https://github.com/cosyte/config/tree/main/packages/bench). The Bench reading
workflow runs them on GitHub-hosted runners, which share their machines, so the readings are
advisory.

### The first published figure

The figure on the Pathways page of cosyte.com, about 1,100 messages a second, is a closed-loop
drain: `pnpm bench` with 2,000 messages already waiting in a folder, one channel, file to file
through SQLite, on Node 26 and a developer machine's local disk, taken once by hand. It is how fast
that machine drained a backlog, not a rate the engine holds under traffic. The Bench reading
workflow's `closed loop` job runs the same command on a GitHub-hosted runner, and names the disk it
ran on, beside the open-loop readings.

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

The open-loop bench runs one case at a time against a build, five runs by default (`--runs`), and
needs the `openssl` command for its TLS material. The PostgreSQL case reads an administrator's URL
from `PATHWAYS_BENCH_POSTGRES_URL`, and makes and drops a database of its own for each run:

```bash
pnpm build
node bench/open-loop/run.mjs --case mllps --out mllps.json --summary mllps.md
node bench/open-loop/run.mjs --case soak --runs 1 --seconds 3600
```

The cases are `mllp`, `mllps`, `https`, `postgres`, `channels`, `retry-backlog`, `startup-backlog`,
`soak` and `drain`.

The database is `sqlite`, `postgres`, `mysql` or `sqlserver`. A server's URL is an administrator's,
in the same form as the test URLs in `.github/workflows/databases.yml`.

## Current numbers

The numbers for this section are measured on `main` at each release and filled in when the release
is built. They are never typed by hand.
