---
id: inspect-replay-and-clear-messages
title: Inspect, replay and clear messages
sidebar_label: Messages, replay and clear
description: "Find stored messages, look at one, run a failed one through a fixed transform, send outputs again, and clear what will not be fixed."
---

# Inspect, replay and clear messages

The operator commands work on the database, beside a running engine or without one. They open it as
`pathways start` does, so they need the same `pathways.yaml`, encryption keys and environment. Every
search, view, replay, resend and clear is written to the [audit log](./read-the-audit-log.md) with the
operating system user.

## Find messages

```bash
npx pathways messages
npx pathways messages --channel adt-to-lab --status failed --since 24h
```

```text
ID  CHANNEL     STATE      RECEIVED                  BYTES  DUPLICATE OF  DELIVERIES
2   adt-to-lab  filtered   2026-11-10T07:40:35.685Z  205    -             -
1   adt-to-lab  delivered  2026-11-10T07:40:35.679Z  205    -             1 delivered
```

Messages come newest first, 50 to a page (`--limit`, up to 1,000; the last line gives the
`--before <id>` for the next page). The list holds ids, states, times, sizes and duplicate flags, never
content. A message's state is one of:

| State       | Meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `received`  | stored, waiting for its transform                                                   |
| `queued`    | transformed; a delivery waits for its first try                                     |
| `retrying`  | transformed; a delivery failed and waits to be tried again                          |
| `delivered` | every delivery is done                                                              |
| `dry-run`   | every delivery is done, and at least one destination ran dry: recorded, never sent  |
| `filtered`  | the transform returned no output                                                    |
| `failed`    | the transform failed, the source stored it as failed, or a delivery failed for good |
| `cleared`   | it failed, and an operator cleared it                                               |

## Look at one message

```bash
npx pathways messages show 17
npx pathways messages show 17 --content
```

`show` prints the message's state, times, size and duplicate flag, the stored error cut to its stage,
name, code and location, and each delivery with its attempts and last error. It prints the content
only with `--content`: the message as received and its current outputs. That view is PHI, so it is
written to the audit log first, and not shown if the entry cannot be written. For a message whose
content was [dropped after delivery](./set-message-retention.md#drop-content-after-delivery), it
prints the content hash and when the content was dropped, and there is no content to show.

## Replay a failed message

Fix the transform, then:

```bash
npx pathways replay 17
```

```text
message 17: replayed: 1 delivery queued
```

`replay` runs the stored message through its channel's transform as it is on disk now, in the same
kind of worker the engine uses, and queues the outputs as fresh deliveries at the back of each
destination's queue. Deliveries of the message that had failed for good are cleared. Replay several at
once with `replay 17 18 23`; they run in the order given.

A replay is refused, changing nothing, when the message is still `received` (the engine will
transform it), has deliveries still pending (retrying ones included), its channel is no longer
configured, or its content was dropped after delivery. It is safe beside a running engine: it never
touches a message the engine is working on.

```text
message 21: refused: its content was dropped after delivery (storage.content: dropAfterDelivery), so there is nothing to send again
```

## Replay every failed message at once

After a fix that covers many failed messages, replay them together:

```bash
npx pathways replay --status failed --channel adt --since 24h
```

```text
3 failed messages to replay:
  channel: adt
  received since 2026-11-10T09:00:00.000Z
  ids up to 412
  unchanged since 2026-11-11T09:00:00.000Z; one changed later is skipped
Type 3 to replay 3 messages: 3
batch 1: messages 398 to 412: 3 replayed, 0 failed again, 0 refused, 0 skipped
Run 1207: 3 replayed, 0 failed again, 0 refused, 0 skipped of 3.
```

It counts first and shows the scope, and replays nothing until you type the count back. Where no one
can type it (a script, or `--json`), add `--yes`. The filters are `--channel`, `--since` and `--until`
(the time received), and `--destination <n>` with `--channel`: only messages whose delivery to that
destination failed, by its place in the channel's `destinations:` list from 0, as `pathways status`
shows it. A replay still queues the new outputs to every destination of the channel, so a destination
that already took the message is sent it again; add `--resend` to send the stored outputs instead of
running the transform.

The run replays oldest first, in batches of 100 (`--batch <n>`, at most 1,000). A message counted that
changed before its turn (replayed, resent or cleared by someone else, or a message that failed after
the count) is skipped, never replayed twice. Each message gets its own `replay` audit entry, as
always, and the run writes `bulk-replay` entries: the scope before the first replay, whose id is the
run's id, one per batch with its first and last ids and counts, and a summary.

Stopped (Ctrl-C ends the run after the batch in hand), it says how to go on:

```text
Stopped with 120 left; go on with: pathways replay --resume 1207
```

`--resume <run>` counts again under the run's own scope: the same filters, ids up to the same one,
and only messages unchanged since the first count. What the run replayed changed when it was
replayed, so it is not replayed again. A message whose delivery was still pending or retrying at the
first count and failed for good after it is left out too: each delivery records when it failed. If
the project was reloaded since and the channel or the `--destination` place is gone, the resume is
refused with exit 2 before it counts. "Unchanged since" compares each message's last change time,
as Pathways' clock wrote it, with the count's start: run a resume where the first run ran, or on a
host whose clock agrees with it.

## Send the outputs again

```bash
npx pathways replay 17 --resend
```

`--resend` queues the outputs stored from the last transform, without running the transform again:
for a destination that lost what it was sent, or one that rejected a message and has since been fixed.

## Clear a failed message

```bash
npx pathways clear 17
```

`clear` marks a failed message, and its deliveries that failed for good, `cleared`. It no longer
counts as failed in `pathways status` or on the health endpoint, and retention can delete it once its
retention period has passed. Nothing is sent.

## Exit codes

| Code | Meaning                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0    | done                                                                                                                              |
| 1    | a replay, resend or clear was refused, or a replayed message failed again; a bulk replay's count was not typed, or it was stopped |
| 2    | a bulk replay's count could not be asked for: add `--yes`                                                                         |
| 4    | a message named does not exist; the others named were still acted on; the run given to `--resume` does not exist                  |

`messages`, `messages show`, `replay`, `clear`, `status`, `retention` and `audit` take `--json`, for
one JSON document in place of the text.

## Related

- [How delivery and errors work](./delivery-and-errors.md).
- [Command reference](./command-reference.md).
