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
| `delivered` | every delivery is done: delivered, or filtered by its destination's transform       |
| `dry-run`   | every delivery is done, and at least one destination ran dry: recorded, never sent  |
| `filtered`  | the transform returned no output, or every destination's transform filtered it      |
| `failed`    | the transform failed, the source stored it as failed, or a delivery failed for good |
| `cleared`   | it failed, and an operator cleared it                                               |

## Look at one message

```bash
npx pathways messages show 17
npx pathways messages show 17 --content
```

`show` prints the message's state, times, size and duplicate flag, the stored error cut to its stage,
name, code and location, and each delivery with its destination (by its place in the list, and its
`name:` when it has one), status, attempts and last error. A delivery a destination's transform
filtered is listed as `filtered`, with `-` for its output. It prints the content
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

## Send the outputs again

```bash
npx pathways replay 17 --resend
```

`--resend` queues the outputs stored from the last transform, without running the transform again:
for a destination that lost what it was sent, or one that rejected a message and has since been fixed.

A resend queues each destination the outputs stored for it, even when its transform has changed
since; a destination its transform filtered stays `filtered`, and one whose transform failed keeps
its failure, even when that failed delivery was cleared since. Each delivery records the destination
it was made for by its identity: its `name:`, or, without one, its kind and target (a folder, a URL,
a host and port, a module). A resend finds each destination's stored outputs by that identity, never
by its place in `channel.yaml`'s list, so adding a destination anywhere in the list, removing one or
reordering them never sends one destination the outputs stored for another.

A destination with nothing stored under its identity for the message's last transform (added to the
channel since, renamed, or, without a name, given another target) is sent nothing and gets no
delivery. The command counts those destinations, with the code `not-stored`, and the `resend` audit
entry carries the count as `notStored`:

```text
message 17: resent: 1 delivery queued; 1 destination with nothing stored for this message was sent nothing (not-stored)
```

To send such a destination the message, replay it instead. A replay runs the channel's transform
and every destination's transform as they are on disk now.

A message whose outputs were stored by a Pathways before deliveries recorded their destination has
no identity to match, so a resend of it is refused with the code `destination-unknown` and sends
nothing; replay it instead.

## Clear a failed message

```bash
npx pathways clear 17
```

`clear` marks a failed message, and its deliveries that failed for good, `cleared`. It no longer
counts as failed in `pathways status` or on the health endpoint, and retention can delete it once its
retention period has passed. Nothing is sent.

## Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | done                                                                      |
| 1    | a replay, resend or clear was refused, or a replayed message failed again |
| 4    | a message named does not exist; the others named were still acted on      |

`messages`, `messages show`, `replay`, `clear`, `status`, `retention` and `audit` take `--json`, for
one JSON document in place of the text.

## Related

- [How delivery and errors work](./delivery-and-errors.md).
- [Command reference](./command-reference.md).
