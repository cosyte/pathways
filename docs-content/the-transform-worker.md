---
id: the-transform-worker
title: Transforms in worker threads
sidebar_label: Transform workers
description: "Why each channel runs its transform in a worker thread of its own, what that protects the engine from, and what it does not."
---

# Transforms in worker threads

Pathways runs in one Node.js process. Its main thread holds the sockets, the database, the ACKs, the
health endpoint and the scheduling. Each channel's transform runs in a worker thread of that channel's
own.

## What happens to one message

1. A source hands the message to the main thread, which stores it as it arrived (encrypted) and only
   then acknowledges the sender. No transform has run yet.
2. On its next pass the engine reads the oldest message waiting on the channel and sends its bytes to
   the channel's worker.
3. The worker parses the bytes in the channel's format, with the `@cosyte/*` library for it, calls the
   transform, and writes what it returns back to bytes.
4. The main thread stores the outputs and queues one delivery of each for every destination.

The worker loads the parser for its own format when it starts, and any other library only when a
transform returns that library's model, so a channel does not pay to load formats it never sees.

## What the worker protects against

- **A transform that hangs.** Each message has a time limit (5 seconds by default). Past it, the
  worker is stopped, that message is marked failed, and a new worker takes the next message. The main
  thread kept running all along, so other channels, the health endpoint and the ACKs were never held
  up.
- **A transform that runs out of memory.** Each worker has a heap cap (256 MB by default). A worker
  past it exits with `ERR_WORKER_OUT_OF_MEMORY`; the message is marked failed and the engine carries
  on. Writing an HL7 v2 message back out builds its whole parsed tree, about 44 times the message's
  size for a dense result report of short OBX segments, so under the default cap such a message
  gets through up to about 5 MiB. Set a larger `memory` on a channel that takes larger ones.
- **A transform that throws.** The message is marked failed with the error's name, its code and the
  line in the transform, and the channel moves on.

Messages of one channel go through its worker one at a time, so they leave the transform in the order
they arrived. Module-level state in a transform is per channel and lasts as long as the worker: it is
lost when a worker is replaced, and never shared between channels.

## What it does not protect against

A worker thread is not a sandbox. A transform, and the `onStart` and `onStop` its module may export,
can read files, open connections and import any package the project installs, with the worker's full
Node.js access: it is your own code, trusted like the rest of the project, and reviewed in the same
pull requests. The worker keeps a mistake in a transform from taking the engine down; it does not
keep out a transform written to do harm.

## The same in tests

`pathways test` and `pathways replay` run a transform in the same kind of worker, with the channel's
time limit and memory cap. A transform that passes its tests runs the same way in the engine, and one
that times out in production times out in its test.

## The alternatives we did not choose

- **Running transforms in the main thread** costs nothing per message, but a transform stuck in a
  loop stops everything, and one that runs out of memory takes the engine down.
- **`node:vm`** stops only synchronous loops, cannot cap memory, and Node.js's own documentation says
  it is not a security mechanism.
- **`isolated-vm`** is a native addon, and a transform inside it could not import npm packages.
- **A child process per channel** costs more than a worker thread and adds no protection a trusted
  transform needs.

The cost of a worker is its memory and a short start, paid once for each channel when the engine
starts, and again whenever a worker is replaced. A module's `onStart` runs in each new worker, a
replacement among them, before it takes a message: see
[run code when the worker starts and stops](./transform-and-filter-messages.md#run-code-when-the-worker-starts-and-stops).

## Apply it

- [Transform and filter messages](./transform-and-filter-messages.md): the time limit and the memory
  cap.
- [Configure a channel](./configure-a-channel.md#set-limits-and-defaults).
