---
id: the-message-model
title: The message model
sidebar_label: Message model
description: "What Pathways keeps for each message a channel takes in: its id, its deliveries and their output numbers, its states, its generations and its duplicate flags."
---

# The message model

A channel takes messages in from one source, runs each through its transform, and delivers what the
transform returns to each of its destinations. Pathways keeps a record of every step in its database,
so that a restart loses nothing and an operator can see where each message stands. This page says
what that record is: a message, its deliveries, the states each can be in, and the keys that tell one
message from another.

## A message and its deliveries

A **message** is one thing a source took in: one file, one object, one MLLP frame, one HTTP request
body. It is stored as it arrived, before the source acknowledges the sender, under an **id** the
database numbers from 1. The id is unique within one database, never across two: a second database
numbers its messages from 1 too.

A **delivery** is one output on its way to one destination. When the transform has run, Pathways
stores its outputs and makes one delivery of each output for each destination, all in one
transaction. A delivery carries:

- its message's id;
- its **output number**, `seq`, which output of the transform it is, counted from 0. A destination
  is handed the pair `messageId` and `seq`, and the file, S3 and Azure Blob destinations name what
  they write `<messageId>-<seq + 1>`, so the first output of message 12 on an `hl7v2` channel is
  `12-1.hl7`;
- its destination, by its place in the channel's list and by a **key** that the destination keeps
  when others are added, removed or moved: its `name:` when it has one, else its kind and target
  ([how a destination is known](./transform-and-filter-messages.md#transform-or-filter-for-one-destination));
- its status, how many attempts it has had, and when it may be tried next.

The pair of a message id and an output number stays the same on every attempt, a retry, a resend
after a crash and a `pathways replay --resend` among them, which is what lets a receiver
[drop a duplicate](./delivery-and-errors.md#drop-a-duplicate-at-the-receiver).

A channel with destination transforms can give each destination its own outputs. A destination whose
own transform returned nothing gets one delivery with no output, marked `filtered`; one whose own
transform failed gets one marked `failed`. Each has the output number -1, and nothing is sent for it.

## Message statuses

A stored message has one of five statuses:

| Status        | What it means                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------- |
| `received`    | stored, waiting for its transform                                                             |
| `transformed` | the transform ran, and its outputs are queued as deliveries                                   |
| `filtered`    | the transform returned no output, or every destination's own transform returned none          |
| `failed`      | the transform failed, or the source stored the message as failed because it could not read it |
| `cleared`     | it failed, and an operator cleared it with `pathways clear`                                   |

A source that can take a message but not read it, an HL7 v2 message with no usable MSH header for
example, stores it as `failed` with the reason, so it is kept for an operator and never transformed.

## Delivery statuses

| Status      | What it means                                                                           |
| ----------- | --------------------------------------------------------------------------------------- |
| `pending`   | waiting for its first attempt, or for a retry after a failed one                        |
| `delivered` | its destination accepted it                                                             |
| `failed`    | it failed for good: the receiver rejected it, or it ran out of attempts or age          |
| `cleared`   | it had failed for good, and an operator cleared it or replayed its message              |
| `dry-run`   | its destination runs dry, so its output was recorded and never sent                     |
| `filtered`  | its destination's own transform returned nothing for the message, so nothing goes to it |

## The state an operator sees

`pathways messages` and `pathways messages show` give a message's **state**, which is worked out from its status and its current deliveries. A message that is not `transformed` has its status as
its state. A `transformed` one takes the first of these that holds:

1. `failed`, when a delivery failed for good;
2. `retrying`, when a delivery failed at least once and waits to be tried again;
3. `queued`, when a delivery waits for its first attempt;
4. `cleared`, when an operator cleared a delivery;
5. `dry-run`, when a delivery was recorded and never sent;
6. `delivered`, when every delivery is done.

So one destination that is down makes the whole message `retrying`, though its other destinations
may have taken it long since. [Inspect, replay and clear messages](./inspect-replay-and-clear-messages.md#find-messages)
lists the states as the command line prints them.

## Order

Each channel transforms its messages one at a time, in the order they were stored, in a worker thread
of its own ([transforms in worker threads](./the-transform-worker.md)). Each destination has its own
queue, in the order the outputs were made, and by default sends the oldest pending delivery first and
holds the rest behind it while it retries. So the order a sender used is the order each receiver
sees, one destination at a time. [How delivery and errors work](./delivery-and-errors.md#order-and-retries-per-destination)
says when that order can be given up.

## Generations: replay and resend

A message starts at **generation** 0. A replay, which runs the stored message through the transform
again, and a resend, which queues the stored outputs again, each raise the generation by one and
queue fresh deliveries for it at the back of each destination's queue. Earlier deliveries that had
failed for good are marked `cleared`. The message's state, and every count of its deliveries, read
the current generation only, and `pathways messages show` lists every generation's deliveries.

A replay or a resend is refused, changing nothing, while a delivery of the message is still pending,
when the message changed since the operator read it, or when its content was dropped after delivery,
so there is nothing to send again. Both are recorded in the audit log in the
same transaction, whichever way they go.

## Two keys that tell messages apart

A message can arrive twice: a sender that saw no acknowledgement sends it again, or a source stopped
between storing a message and acknowledging it. Pathways keeps two keys for these cases, each stored
as a SHA-256 hash, so a sender's identifiers and a file's name are not kept in the database:

- **The duplicate key** is who sent the message and its control ID: MSH-3, MSH-4 and MSH-10 of an
  HL7 v2 message taken in over MLLP, or over HTTP by a source that answers with an HL7 ACK. When an
  earlier message of the same channel has the same key, the new one is stored and processed as usual,
  and flagged as a possible duplicate of the latest such message (`duplicateOf`). It is never
  dropped: a sender can mean to send the same message twice.
- **The idempotency key** names one message to its source: for a file source, the file's claim; for
  S3 or Azure Blob, the bucket or container, the object's key, its entity tag and its modification
  time. A source that hands a message in again after a stop marks it resumed, and when the channel
  already holds a message with that key, nothing new is stored and the source is told the id of the
  one it holds. [How a source claims files and objects](./file-and-object-claims.md) says when that
  happens.

## What else a message carries

- **Its size**, in bytes as it arrived, and the times it was received and last changed.
- **Its metadata**, `ctx.meta`: flat values by key, stored with the message (encrypted, under
  encryption at rest), with a tag for each key a channel's `index:` block names, so it can be
  [searched](./search-messages-by-metadata.md) without decrypting every row. In this release nothing
  in the engine sets `ctx.meta` yet: it is stored only when the code that stores a message passes it.
- **A content hash**, on a channel that drops content after delivery: the SHA-256 of the body as it
  arrived, kept after the body is gone.
- **The send marker** on each delivery: the attempt in flight and when it started, written before the
  send and cleared by its outcome, so a delivery found still marked after a crash is sent again
  flagged as a possible duplicate ([a resend after a crash is flagged](./delivery-and-errors.md#a-resend-after-a-crash-is-flagged)).

[How storage and encryption work](./storage-and-encryption.md) says which of these are encrypted and
which are kept in the clear.

## When a message is done

A message is done when it is `filtered` or `cleared`, or `transformed` with no delivery pending or
failed: each one delivered, run dry, filtered or cleared. Retention deletes a done message once its period has passed, counted from its
last activity, and never deletes a failed one unless a written-out `retention:` block sets a clock for
failed messages ([how retention and archives work](./retention-and-archives.md)).

A channel with `storage.content: none` keeps no message at all: each one is transformed and sent
before its sender is answered, and a destination is handed a pass id in place of a message id
([pass messages through without storing them](./pass-messages-through-without-storing.md#pass-ids)).

## Apply it

- [Inspect, replay and clear messages](./inspect-replay-and-clear-messages.md).
- [Transform and filter messages](./transform-and-filter-messages.md).
- [Search messages by metadata](./search-messages-by-metadata.md).
- [Set message retention](./set-message-retention.md).
