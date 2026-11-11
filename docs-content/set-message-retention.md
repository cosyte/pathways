---
id: set-message-retention
title: Set message retention
sidebar_label: Retention
description: "Decide how long delivered, filtered and cleared messages are kept, see what a run would delete, and know what retention never touches."
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
one whose transform failed, keeps its content until retention deletes it.

What stays is the message's metadata: its id, channel, times, status and its deliveries' statuses,
attempts and times, its size, the possible-duplicate flag, and a SHA-256 hash of the body as it was
received, which the engine works out as it stores the message. `pathways messages show` prints the
hash and when the content was dropped. Each delivery's last error text goes with the bodies, since
encryption treats it as content too; its attempts count stays.

Once the content is dropped:

- `pathways replay` and `pathways replay --resend` refuse the message, changing nothing: there is
  nothing to send again.
- `pathways messages show --content` has no content to print.
- `pathways rekey` skips it: it holds nothing encrypted.
- Retention leaves it: its metadata is kept, and no retention period deletes it.

The engine logs `content-dropped` with the channel, the message and the delivery. A message
received under `keep` and delivered after you switch to `dropAfterDelivery` is dropped too, without
a hash. A custom store needs `markDeliveredAndDropContent` for this; `pathways start` refuses a
channel that asks for it on a store without it. What each database still holds after the delete is
on [Store messages in a database server](./store-messages-in-a-database.md#what-a-database-keeps-after-a-delete).

## What retention does not reach

- Files a file source keeps with `keepProcessed: true`, in its `processed/` folder.
- Files a file destination wrote.
- The audit log, which is never deleted by Pathways.
- Copies of the database in backups, and on a database server, earlier row versions in its logs.

On SQLite, a deleted message's bytes are overwritten with zeros in the file; on a server they can
stay for a while, as [what a database keeps after a
delete](./store-messages-in-a-database.md#what-a-database-keeps-after-a-delete) says. The period your
policy needs, and what happens to backups and output folders, are yours to decide.

## Related

- [The security model](./security-model.md).
- [Configuration reference](./configuration-reference.md#settings).
