---
id: upgrade-pathways
title: Upgrade Pathways
sidebar_label: Upgrade Pathways
description: "Check what a newer Pathways, or a changed transform, would send differently before it sends anything: verify it against stored and sample messages, and run new destinations dry."
---

# Upgrade Pathways

A newer Pathways can parse and write a message a little differently, and so can a transform you have
changed. Before either sends anything, check it two ways: `pathways verify` runs messages you already
sent through the new version and names every output that would change, and a destination that runs
dry does everything but the send, so you can watch its outputs on live traffic.

## Make a candidate project

Keep the running project as it is, and make the candidate beside it: a second checkout of the same
repository, on its own branch.

```bash
git worktree add ../pathways-next -b upgrade-pathways
cd ../pathways-next
npm install @cosyte/pathways@latest
```

The candidate reads the same database, under the same encryption keys, as the running project. On a
database server it does already: `pathways.yaml` reads the same connection URL from the environment.
On SQLite, name the running project's file in the candidate's `pathways.yaml`, since a relative path
is resolved against each project's own folder:

```yaml title="pathways.yaml"
encryption:
  keys: [{ id: main, file: ../pathways/.pathways/dev.key }]
  current: main
storage:
  sqlite:
    file: ../pathways/.pathways/pathways.db
```

Keep that change out of the commit you will deploy.

`pathways verify` opens the database as every command does, so on a newer Pathways it brings the
schema up to date as that version's `pathways start` would. Read the release notes for a schema
change before you point the candidate at production's database.

## Verify against samples

Start with synthetic messages, which need no database and read no stored message. Lay them out as a
channel's `tests/` folder is, one folder per channel, each input beside its `.expected` file saved by
the running version (`pathways test --update` saves them):

```text
samples/
  adt-to-lab/
    a01.hl7
    a01.expected.hl7
```

```bash
npx pathways verify --samples ../pathways/samples
```

## Verify against stored messages

Then run what the running project actually took in, through the candidate:

```bash
npx pathways verify --since 7d
npx pathways verify --channel adt-to-lab --ids 1042,1043
```

Each stored message is run through the candidate's transform, in the same worker the engine uses,
and its outputs are compared byte for byte with the outputs stored when it was sent:

```text
Verified 3 messages stored since 2026-11-04T09:00:00.000Z.
adt-to-lab, destination 0: 2 same, 1 different, 0 failed
  message 1042: different, output 1 at PID[1]-8
adt-to-lab, destination 1: 2 same, 1 different, 0 failed
  message 1042: different, output 1 at PID[1]-8
```

A difference is named by where it is, never by what changed: an HL7 v2 field path, a JSON pointer
for FHIR and JSON, or a byte offset for the other formats. To see the values, look at the message
with `pathways messages show 1042 --content`, which is audited. A message that failed names its
stage and error, never the error's text. The command exits 1 on any difference or failure, so a
script or a CI job can stop on it.

Verify reads each message decrypted in memory only, and writes each one to the audit log (`verify`)
before it reads it. It writes nothing to the message or delivery tables, so it is safe beside the
running engine. A message that has no recorded outputs (still waiting, or failed) is skipped.

A transform that writes the time or a counter into its output, such as a fresh `MSH-7`, differs on
every run: expect that field in the report, and look for the others.

## Watch a destination before it sends

A destination block with `dryRun: true` takes part in everything but the send. Each output is
transformed and stored as it would be, and its delivery is marked `dry-run` instead of being sent.
No connector is built for it, so no TLS file or secret is read and no connection is opened:

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  mllp: { port: 2575, plaintext: true }
transform: ./transform.ts
destinations:
  - mllp: { host: lab.example.test, port: 2576, plaintext: true }
  - http: { url: https://new-lab.example.test/in }
    dryRun: true
```

The first destination sends as before; the second records what it would have sent. Read its outputs
with `pathways messages show <id> --content`. `pathways status` counts them as `dry-run (recorded,
not sent)`, a message whose destinations are done and one of them ran dry is in the `dry-run` state,
and retention deletes them as it deletes delivered ones. Remove `dryRun` to start sending: messages
taken in from then on are sent, and those recorded dry stay recorded.

`pathways start --dry-run` runs every destination dry, which suits a staging engine with a database
of its own that is fed a copy of production's traffic. It logs `dry-run` at start.

## Switch over

Once verify shows only the differences you expect:

1. Merge the candidate's branch, without the storage change above.
2. Stop the running engine, deploy the new version, and start it.

A custom store implemented against an earlier Pathways keeps working. To run a destination dry it
needs a `markDryRun` method; without one, `pathways start` refuses a project with a destination that
runs dry and says so.
