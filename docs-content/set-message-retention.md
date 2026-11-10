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

## What retention does not reach

- Files a file source keeps with `keepProcessed: true`, in its `processed/` folder.
- Files a file destination wrote.
- The audit log, which is never deleted by Pathways.
- Copies of the database in backups, and on a database server, earlier row versions in its logs.

On SQLite, a deleted message's bytes are overwritten with zeros in the file. The period your policy
needs, and what happens to backups and output folders, are yours to decide.

## Related

- [The security model](./security-model.md).
- [Configuration reference](./configuration-reference.md#settings).
