---
id: upgrade-pathways
title: Upgrade Pathways
sidebar_label: Upgrade
description: "Move a running Pathways to a new version: check what it would send differently, expand the schema, start the new version, keep the way back open, and contract once nothing older runs."
---

# Upgrade Pathways

A new Pathways version can change the database schema. It changes it in steps, each tagged `expand`
or `contract`, so that an upgrade never leaves an engine on a schema it cannot run on:

- An **expand** step only adds (a table, a column that may be empty, an index). The version before it
  keeps running on the schema after it.
- A **contract** step removes or changes something an older version reads. It is applied only when
  you ask for it, with `pathways migrate --contract`.

A release's code runs on its schema both before and after its own contract steps. That is the rule
every step follows, and it is what makes the way back below work. The
[database page](./store-messages-in-a-database.md#schema-changes-expand-and-contract) says how
Pathways records each step and locks while it applies them.

A new version can also parse and write a message a little differently, and so can a transform you
have changed. Before either sends anything, [check it](#check-before-you-upgrade): `pathways verify`
runs messages you already sent through the new version and names every output that would change,
and a destination that runs dry does everything but the send.

## Check before you upgrade

### Make a candidate project

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

`pathways verify` opens the database as every command does, but applies no schema step, as
`pathways start --no-migrate` does, so it never changes the schema under the running engine. A
candidate on a newer Pathways whose expand steps the database lacks is refused, naming both versions.
Verify against samples until then, or apply the expand steps first with `pathways migrate` from the
candidate (step 4 of [Upgrade](#upgrade)): the running version keeps running on them.

The candidate's transforms run with the environment of the process that runs `pathways verify`, as
the engine's do, so they can read any key or secret in it, and what they write to the console goes
to the command's output. Run verify only on a candidate whose code you would deploy. It builds no
destination, so it sends no message.

### Verify against samples

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

### Verify against stored messages

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
for FHIR and JSON, or a byte offset for the other formats. A FHIR pointer names field names only,
but for the `json` format a pointer's keys are the message's own keys, and those can be patient data
(a map keyed by medical record number, say): treat a `json` channel's report as you would its
messages. To see the values, look at the message with `pathways messages show 1042 --content`, which
is audited. A message that failed names its stage and error, never the error's text. The command
exits 1 on any difference or failure, so a script or a CI job can stop on it.

Verify reads each message decrypted in memory only, and writes each one to the audit log (`verify`)
before it reads it. It writes nothing to the message or delivery tables, so it is safe beside the
running engine. A message that has no recorded outputs (still waiting, or failed) is skipped.

A transform that writes the time or a counter into its output, such as a fresh `MSH-7`, differs on
every run: expect that field in the report, and look for the others.

### Watch a destination before it sends

A destination block with `dryRun: true` takes part in everything but the send. Each output is
transformed and stored as it would be, and its delivery is marked `dry-run` instead of being sent.
No connector is built for it, so no TLS file is read and no connection is opened. None of its
secrets is read either: start does not ask a provider for them, so a missing or expired one does not
stop it, and no real credential is held for a destination that never sends:

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  mllp: { port: 2575, plaintext: true }
transform: ./transform.ts
destinations:
  - mllp: { host: lab.example.test, port: 2576, plaintext: true }
  - http: { url: https://new-lab.example.test/in }
    dryRun: { env: NEW_LAB_DRY_RUN, default: true }
```

The first destination sends as before; the second records what it would have sent, unless
`NEW_LAB_DRY_RUN` is `false`. Read its outputs with `pathways messages show <id> --content`.
`pathways status` counts them as `dry-run (recorded, not sent)`, a message whose destinations are
done and one of them ran dry is in the `dry-run` state, and retention deletes them as it deletes
delivered ones.

Turning dry run on for a destination that already has a backlog marks the whole backlog `dry-run`:
every delivery still pending, those queued or waiting for a retry before dry run was turned on, and
one cut off mid-send, which may have reached the receiver. None of them is sent. `pathways start`
warns at start (`dry-run-pending`, with the channel's pending count) when this is about to happen.
To send them later, turn dry run off, then send each message's stored outputs again with
`pathways replay <id> --resend` before retention deletes it. That queues them for every destination
of the channel, so one that already sent the message sends it again.

Remove `dryRun` to start sending: messages taken in from then on are sent, and those recorded dry
stay recorded.

`pathways start --dry-run` runs every destination dry, which suits a staging engine with a database
of its own that is fed a copy of production's traffic. It logs `dry-run` at start.

A custom store implemented against an earlier Pathways keeps working. To run a destination dry it
needs a `markDryRun` method; without one, `pathways start` refuses a project with a destination that
runs dry and says so.

## Upgrade

Once verify shows only the differences you expect, merge the candidate's branch, without the storage
change above. Then:

1. Upgrading from Pathways 0.0.1? Take a backup of the database first: 0.0.1 cannot run on a
   database a later version has opened (see [Roll back](#back-to-pathways-001)).
2. Install the new version where the engine runs (`npm install @cosyte/pathways@<version>`, or the new
   image).
3. See what it would change, from the project folder:

   ```bash
   npx pathways migrate --dry-run
   ```

   It prints the database's schema generation, the Pathways that last changed it, and each step the
   new version would apply, with its generation and tag. It applies nothing.

4. Apply the expand steps. Either start the new version, which applies them itself before it takes the
   engine lease, or apply them from one place first and start every engine with `--no-migrate`:

   ```bash
   npx pathways migrate
   npx pathways start --no-migrate
   ```

   With `--no-migrate` an engine applies nothing, and refuses a database that lacks a step it needs,
   naming both versions. When several engines start at once without it, each step is still applied
   once, under the migration lock.

5. Check the engine: `pathways status`, and the health endpoint if you run one.

## Roll back

### Back to a version that reads schema_info

When the version you go back to reads `schema_info` (the version that added it, or a later one), the
way back stays open until you contract: the schema holds only expand steps, so the version before
still runs on it. Stop the new version and start the old one on the same database. The old version
sees steps it does not know, checks that the schema still allows it, and runs without migrating
anything.

### Back to Pathways 0.0.1

Pathways 0.0.1 does not read `schema_info`, and knows schema steps `0001` to `0004` only. The first
version after it applies `0005-send-markers`, `0006-leases` and `0007-schema-info` together when it
opens a 0.0.1 database. Pathways 0.0.1 refuses a database that holds a step it does not know, so once
a later version has opened the database (with `pathways start` or any command that opens it), 0.0.1
stops with `the database schema could not be brought up to date`.

The only way back to 0.0.1 is the backup taken before the upgrade: stop every engine, restore that
backup, then start 0.0.1. Messages stored after the backup are not in it.

## Contract

Once every engine on the database runs the new version, and you no longer need the way back, apply
the contract steps:

```bash
npx pathways migrate --contract
```

From then on, a version older than the one the contract steps name refuses the database, naming both
versions:

```text
pathways: the database schema is generation 9 and needs Pathways 0.3.0 or later; this is Pathways 0.2.0.
```

To keep the way back open for a set time after every upgrade, set a rollback window in
`pathways.yaml`. Contract steps are then refused until that long after the schema last changed:

```yaml title="pathways.yaml"
migrations:
  rollbackWindow: 7d
```

`pathways migrate --contract` does not see which versions your other engines run: stop or upgrade
them first. Every run of `pathways migrate`, a dry run and a refusal too, is written to the audit log
as `migrate`, with the versions and generations involved.

## Related

- [Store messages in a database server](./store-messages-in-a-database.md).
- [Command reference: pathways migrate](./command-reference.md#pathways-migrate).
- [Command reference: pathways verify](./command-reference.md#pathways-verify).
- [Read the audit log](./read-the-audit-log.md).
