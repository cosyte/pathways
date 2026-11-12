---
id: set-message-retention
title: Set message retention
sidebar_label: Retention
description: "Decide how long messages, their content and failed messages are kept, archive what retention removes, see what a run would do, and know what it never touches."
---

# Set message retention

Stored messages are patient data at rest, so Pathways deletes them once they are done and their
retention period has passed. A message is done when it is delivered, filtered or cleared; its period
runs from its last activity. The default is 30 days.

Failed messages are never deleted by retention: they wait until you [replay or clear
them](./inspect-replay-and-clear-messages.md). Neither is a message with a delivery still pending.

## Set the period

For the whole project, and for one channel:

```yaml title="pathways.yaml"
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
defaults:
  retention: 30d
  retentionInterval: 1h
```

```yaml title="channels/adt-to-lab/channel.yaml"
retention: 7d
source:
  file: { dir: ../../data/adt-to-lab/in }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/adt-to-lab/out }
```

A channel that has stored messages but is no longer in the project keeps the project's period.

## When it runs

A running engine (`pathways start`) runs retention once it has made its first pass, then every
`retentionInterval` (1 hour by default). Each run deletes in batches, so the engine is never held up
long, and writes one entry to the audit log with what it deleted. `pathways start --once` does not run
retention.

To run it yourself, or to see first what it would do:

```bash
npx pathways retention --dry-run
npx pathways retention
```

```text
Retention dry run: 0 messages and 0 deliveries would be deleted. Nothing was deleted.
  adt-to-lab: 0 messages, 0 deliveries (done, and last active before 2026-10-11T07:40:48.263Z)
```

A dry run deletes nothing and is not audited.

## Separate clocks

`retention: 30d` is shorthand for one clock, the metadata clock: how long a done message's row is
kept. Written out as a block, `retention:` sets up to three clocks, each counted from a message's
last activity:

```yaml title="pathways.yaml"
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
defaults:
  retention:
    content: 7d
    metadata: 90d
    failed: 180d
```

- `content`: once a done message is this old, its body, its outputs, every error text and its
  `ctx.meta` (with the index tags over it) are emptied, and its row stays: ids, times, statuses,
  attempts and sizes. Unset, content is kept as long as the row.
- `metadata`: once a done message is this old, its row is deleted with its deliveries. 30 days when
  unset. A written-out block also deletes, on this clock, a message whose content was dropped
  (after delivery or by the `content` clock); the shorthand leaves such a message, as it always has.
- `failed`: once a failed message is this old, it is deleted with its deliveries. Unset, a failed
  message is kept until you replay or clear it. A delivery that failed for good keeps no time of its
  own, so its last attempt's due time stands for it.

Any block counts as written out, even one that sets no clock: `retention: { archive: { dir: ./archive
} }` or `retention: { audit: never }` alone switches it on. The metadata clock stays 30 days, and
from then on it also deletes each message whose content was dropped after delivery, which the
shorthand kept. To keep those rows, stay with the shorthand, or set `metadata:` as long as you want
them kept.

`metadata` shorter than `content` is refused when the project loads: a row must outlive its content.
A channel's `retention:` sets the clocks it names and keeps the project's others; the shorthand in a
channel sets its metadata clock alone.

Once a message's content is gone, `pathways replay` and `pathways replay --resend` refuse it with
`content-dropped`, changing nothing, just as for [content dropped after
delivery](#drop-content-after-delivery).

A dry run prints each clock's counts:

```text
Retention dry run: 0 messages and 0 deliveries would be deleted. Nothing was deleted.
  Content would be dropped from 0 messages.
  adt-to-lab: 0 messages, 0 deliveries (done, and last active before 2026-08-13T07:40:48.263Z)
    content: 0 messages (done, and last active before 2026-11-04T07:40:48.263Z)
    failed: 0 messages, 0 deliveries (last active before 2026-05-15T07:40:48.263Z)
```

A store from a custom module needs the optional `countExpiring`, `listExpiring`, `applyExpiry` and
`archiveRows` methods for the content and failed clocks and for an archive; on a store without them, retention
leaves a channel with a written-out block alone and logs `retention-skipped` with
`ERR_PATHWAYS_RETENTION_UNSUPPORTED`.

## Archive before delete

To keep a copy of everything retention changes or deletes, name a folder for archives:

```yaml title="pathways.yaml"
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
defaults:
  retention:
    archive: { dir: ./archive }
    content: 7d
    metadata: 90d
```

An archive is sealed under your encryption keys, so `archive` with `encryption: none` is refused
when the project loads. `archive` and `audit` are set in `pathways.yaml` only.

Retention works a batch of at most 500 messages at a time, and fewer when an archive reaches 256 MiB.
For each batch, in this order:

1. It reads every message of the batch as it stands, decrypted: every column of its row and of each
   of its deliveries, of every generation, so nothing a step empties or deletes is left out.
2. It writes them to a new file under `archive/<channel>/`, ending in `.partial`, readable by its
   own user alone, and flushes the file to disk.
3. It renames the file to its name, ending in `.pwa`, and flushes the folder.
4. It reads the file back, opens it and checks its trailer and that it holds the messages it wrote.
5. It writes an `archive` entry to the audit log, with the step and the number of messages.
6. Only then does it drop the content of, or delete, those messages, in one transaction.

A stop at any point leaves either no archive and nothing changed, or an archive and nothing changed,
or both done: a message is never changed without its archive. A stop between steps 5 and 6 leaves
the messages in place, and the next run archives them again, so the same message can be in two
archives. When an archive cannot be written, flushed, read back, checked or audited, what was
written is removed, nothing more of that channel is changed in that run, and the engine logs
`retention-skipped` with the channel and the code (`pathways retention` prints it and exits 1). The
next run tries again.

An archive file is NDJSON, compressed with gzip and then encrypted with the envelope that encrypts
stored messages, under a fresh data key for each file:

- the first line is a header: `format` (`pathways-archive`), `version` (1), `channel`, `keyId` (the
  master key it is sealed under), `created`, the retention `step` (`content`, `metadata` or
  `failed`), and `mac`, the trailer's key, wrapped under that master key;
- each line after it is one message: its id, channel, status, times, size, generation, duplicate
  and idempotency keys, whether it held its key's claim (`idempotencyClaim`, absent from an archive
  written before Pathways kept claims), content hash, error text, `ctx.meta`, and its body in base64; `outputs`,
  the current generation's outputs in order; and `deliveries`, every delivery of every generation
  with its status, attempts, times, error text and body in base64;
- the last line is the trailer: the `count` of messages and an HMAC-SHA-256 over the header and every
  message line.

The index tags over `ctx.meta` are not in an archive: they are worked out from `ctx.meta` under your
keys, so the archived `ctx.meta` gives them back. A message whose content was dropped after delivery
(`storage.content: dropAfterDelivery`) lost its bodies, error texts and `ctx.meta` at delivery,
before retention reached it, so its archive holds what its row still has.

`dir` takes an environment reference too, such as `dir: { env: PATHWAYS_ARCHIVE_DIR }`, read when
the project loads.

Keep each master key that sealed an archive for as long as you keep the archive: without it the
archive cannot be opened. Retention never deletes an archive; how long you keep them, and where,
is yours to decide.

## The audit log's clock

The audit log is never pruned: `audit: never` is its only value, and the default. An archive's
`archive` entry, and every other entry, stays.

## Drop content after delivery

Retention deletes a message some time after it is done. To keep as little patient data as you can,
drop a message's content as soon as it is delivered instead:

```yaml title="pathways.yaml"
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
storage:
  content: dropAfterDelivery
```

`storage.content` is `keep` by default. A channel overrides the project's:

```yaml title="channels/adt-to-lab/channel.yaml"
storage:
  content: keep
source:
  file: { dir: ../../data/adt-to-lab/in }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/adt-to-lab/out }
```

With `dropAfterDelivery`, the transaction that records a message's last delivery as delivered also
deletes the message's body as it was received and the body of every one of its deliveries. Only the
deliveries of the message's current generation count: one that failed for good before a replay or
resend does not hold the drop back. While any delivery of the current generation has failed or waits
to be tried again, every body is kept, so you can still replay or resend it. A filtered message, and
one whose transform failed, keeps its content until retention deletes it. So does a message with a
delivery that was cleared or sent as a dry run: neither is delivered, so the drop never comes.

What stays is the message's metadata: its id, channel, times, status and its deliveries' statuses,
attempts and times, its size, the possible-duplicate flag, and a SHA-256 hash of the body as it was
received, which the engine works out as it stores the message. `pathways messages show` prints the
hash and when the content was dropped. Each delivery's last error text goes with the bodies, since
encryption treats it as content too; its attempts count stays.

The message's `ctx.meta` goes with the bodies too, and so do the tags of every index over it
([search messages by metadata](./search-messages-by-metadata.md)), in the same transaction: they
hold identifiers such as a medical record number. A message whose content is dropped can no longer
be found with `pathways messages --where`.

The hash is plain SHA-256 with no key, and it is stored unencrypted, even with encryption at rest.
Anyone who can read the database and can guess a message's exact text, which for a short or
predictable message may not be hard, can hash the guess and confirm whether that message passed
through. Protect the hash as you would the content.

Once the content is dropped:

- `pathways replay` and `pathways replay --resend` refuse the message, changing nothing: there is
  nothing to send again.
- `pathways messages show --content` has no content to print.
- `pathways rekey` skips it: it holds nothing encrypted.
- Retention's shorthand leaves it: its metadata is kept, and no retention period deletes it. A
  written-out `retention:` block deletes it on its [metadata clock](#separate-clocks).

The engine logs `content-dropped` with the channel, the message and the delivery. A message
received under `keep` and delivered after you switch to `dropAfterDelivery` is dropped too, without
a hash. A custom store needs `markDeliveredAndDropContent` for this; `pathways start` refuses a
channel that asks for it on a store without it. What each database still holds after the delete is
on [Store messages in a database server](./store-messages-in-a-database.md#what-a-database-keeps-after-a-delete).

To store no message at all, a channel sets `storage.content: none`: see [Pass messages through
without storing them](./pass-messages-through-without-storing.md).

## What retention does not reach

- Files a file source keeps with `keepProcessed: true`, in its `processed/` folder.
- Files a file destination wrote.
- The audit log, which is never deleted by Pathways.
- The archives retention writes.
- Copies of the database in backups, and on a database server, earlier row versions in its logs.

On SQLite, a deleted message's bytes are overwritten with zeros in the file; on a server they can
stay for a while, as [what a database keeps after a
delete](./store-messages-in-a-database.md#what-a-database-keeps-after-a-delete) says. The period your
policy needs, and what happens to backups and output folders, are yours to decide.

## Pathways is not the system of record

Pathways moves messages between systems; it does not keep the legal record of a patient's care. The
periods set here are how long Pathways keeps its own copies, for tracing and replaying messages, and
none of them is set to meet a records law.

For context only: how long records must be kept is set by federal and state law, by contracts, and by
your own policy, and it differs by state and by the kind of record. Those periods apply to the
systems that hold the record, such as an EHR, and to documents such as your policies. Pathways takes
no default from them. Ask whoever decides your records policy which period applies before you set
one here, and keep archives or backups as that policy says.

## Related

- [The security model](./security-model.md).
- [Configuration reference](./configuration-reference.md#settings).
