---
id: retention-and-archives
title: How retention and archives work
sidebar_label: Retention and archives
description: "Why Pathways deletes the messages it stores, how its retention clocks count, how an archive is written before a change, and what retention never reaches."
---

# How retention and archives work

Stored messages are patient data at rest. Pathways keeps them so an operator can trace a message and
replay one that failed, and keeps them no longer than that needs: once a message is done and its
retention period has passed, it is deleted. This page says how the periods count, how a run deletes,
how an archive is written before anything changes, and what retention leaves alone.

## When a message's period starts

A message is done when it is delivered, filtered or cleared; its period runs from its last activity,
not from when it arrived, so a message replayed last week counts from last week. The default is 30
days. Two kinds of message are never deleted by the default retention:

- **A failed message** waits until an operator replays or clears it: deleting it would lose a message
  nobody has dealt with.
- **A message with a delivery still pending** is not done, however old it is.

## Three clocks

`retention: 30d` is shorthand for one clock, the metadata clock: how long a done message's row is kept.
A written-out `retention:` block can set three, each counted from a message's last activity, because
the parts of a message are worth keeping for different lengths of time:

- The **content** clock empties a done message's body, outputs, error texts and `ctx.meta`, and keeps
  its row: ids, times, statuses, attempts and sizes. The content is what holds patient data, and
  what a replay needs; once nobody will replay the message, it is only a risk.
- The **metadata** clock deletes the row with its deliveries. The row says that a message passed
  through, when, and what became of it, which is worth keeping longer than the content, to trace a
  message a receiver says it never got. A row must outlive its content, so a metadata clock shorter
  than the content clock is refused.
- The **failed** clock deletes a failed message after its period, for a project that would rather
  lose an old failure than keep it until an operator acts. A delivery that failed for good keeps no
  time of its own, so its last attempt's due time stands for it.

The shorthand and a written-out block differ in one case: a message whose content was dropped after
delivery keeps its row under the shorthand for good, as it always has, and a written-out block deletes
it on the metadata clock.

## A run

A running engine runs retention once it has made its first pass, then every `retentionInterval` (1
hour by default). Each run works one channel at a time and deletes in batches of at most 500
messages, so the engine is never held up long. Inside the transaction that deletes a batch, the
messages are marked first, so a change that reaches one of them meanwhile takes it out of the batch. Each run writes one entry to the audit log with what it deleted. A dry run counts and
deletes nothing, and is not audited.

## Archive before delete

An archive keeps a copy of everything retention changes or deletes, for a project that must keep
messages longer than it wants them in the live database. It is sealed under the project's encryption
keys, the same as the database, so an archive needs encryption.

Retention works a batch of at most 500 messages at a time, and fewer when an archive reaches 256 MiB.
For each batch, in this order:

1. It reads every message of the batch as it stands, decrypted: every column of its row and of each
   of its deliveries, of every generation, so nothing a step empties or deletes is left out.
2. It writes them to a new file under `archive/<channel>/`, ending in `.partial`, readable by its own
   user alone, and flushes the file to disk.
3. It renames the file to its name, ending in `.pwa`, and flushes the folder.
4. It reads the file back, opens it and checks its trailer and that it holds the messages it wrote.
5. It writes an `archive` entry to the audit log, with the step and the number of messages.
6. Only then does it drop the content of, or delete, those messages, in one transaction.

A stop at any point leaves either no archive and nothing changed, or an archive and nothing changed,
or both done: a message is never changed without its archive. A stop between steps 5 and 6 leaves the
messages in place, and the next run archives them again, so the same message can be in two archives.
When an archive cannot be written, flushed, read back, checked or audited, what was written is
removed, nothing more of that channel is changed in that run, and the engine logs `retention-skipped`
with the channel and the code (`pathways retention` prints it and exits 1). The next run tries again.

### What an archive holds

An archive file is NDJSON, compressed with gzip and then encrypted with the envelope that encrypts
stored messages, under a fresh data key for each file:

- the first line is a header: `format` (`pathways-archive`), `version` (1), `channel`, `keyId` (the
  master key it is sealed under), `created`, the retention `step` (`content`, `metadata` or
  `failed`), and `mac`, the trailer's key, wrapped under that master key;
- each line after it is one message: its id, channel, status, times, size, generation, duplicate
  and idempotency keys, whether it held its key's claim (`idempotencyClaim`, absent from an archive
  written before Pathways kept claims), content hash, error text, `ctx.meta`, and its body in
  base64; `outputs`, the current generation's outputs in order; and `deliveries`, every delivery of
  every generation with its status, attempts, times, error text and body in base64;
- the last line is the trailer: the `count` of messages and an HMAC-SHA-256 over the header and every
  message line.

The index tags over `ctx.meta` are not in an archive: they are worked out from `ctx.meta` under your
keys, so the archived `ctx.meta` gives them back. A message whose content was dropped after delivery
(`storage.content: dropAfterDelivery`) lost its bodies, error texts and `ctx.meta` at delivery, before
retention reached it, so its archive holds what its row still has.

An archive can be opened only with the master key that sealed it, and retention never deletes one:
how long archives are kept, and where, is the project's to decide.

## The audit log is never pruned

The audit log records every retention run and every archive, with every other operator action, and
retention never deletes from it: `audit: never` is its only value. It holds ids, counts, codes and
hashes, never a message's content.

## What retention never reaches

Retention works on the database alone. It does not reach files a file source keeps with
`keepProcessed: true`, files a file destination wrote, the audit log, the archives it writes, or copies
of the database in backups. On SQLite a deleted message's bytes are overwritten with zeros in the file;
on a database server earlier row versions can stay in its logs and free space for a while
([what a database keeps after a delete](./storage-and-encryption.md#what-a-database-keeps-after-a-delete)).

## Pathways is not the system of record

Pathways moves messages between systems; it does not keep the legal record of a patient's care. The
periods set here are how long Pathways keeps its own copies, for tracing and replaying messages, and
none of them is set to meet a records law.

For context only: how long records must be kept is set by federal and state law, by contracts, and by
your own policy, and it differs by state and by the kind of record. Those periods apply to the systems
that hold the record, such as an EHR, and to documents such as your policies. Pathways takes no
default from them. Ask whoever decides your records policy which period applies before you set one,
and keep archives or backups as that policy says.

## Apply it

- [Set message retention](./set-message-retention.md).
- [Pass messages through without storing them](./pass-messages-through-without-storing.md).
- [Read and forward the audit log](./read-the-audit-log.md).
- [The security model](./security-model.md).
