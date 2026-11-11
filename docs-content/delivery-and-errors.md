---
id: delivery-and-errors
title: How delivery and errors work
sidebar_label: Delivery and errors
description: "Why a message is stored before it is acknowledged, how order and retries work per destination, what fails a message, and what replay does."
---

# How delivery and errors work

Pathways is built so that a message it has acknowledged is never lost, and so that one broken
destination or one bad message does not stop the others. Each rule below is the default.

## At least once

Every message is stored, durably, before its source acknowledges it, and every output is recorded as
delivered only after its destination accepted it. So a crash at any point loses nothing.

The price is that a crash between a destination accepting an output and Pathways recording it means
the output is sent again on restart. A receiver can, rarely, see a duplicate. Pathways sends at least
once, not exactly once.

## Taking a message in

- **MLLP** answers `AA` only once the message is stored. If it cannot be stored, it sends no ACK and
  closes the connection by default, so the sender sends it again.
- **HTTP** answers 202 once the message is stored, and 503 if it cannot be, so the sender sends it
  again.
- **Files** are moved aside, stored, and only then deleted. A file part way through when the engine
  stopped is stored once on the next pass.

A message the source can take but not read (an HL7 v2 message with no usable MSH header, say) is
stored, marked failed, and answered `AR`, so it is kept for an operator rather than lost or retried
forever. A message that repeats an earlier one's sender and control ID is processed as usual and
flagged as a possible duplicate, never dropped: dropping it would lose a message the sender meant to
send twice.

## Transforming

Each channel transforms its messages one at a time, in the order they were stored, in its own worker
thread. A message whose transform throws, times out (5 seconds) or runs out of memory (256 MB), or
that does not parse in the channel's format, is marked failed with what went wrong, and the channel
moves on to the next. One bad message does not stop a channel.

## Order and retries, per destination

Each destination has its own queue, in the order the outputs were made.

- When a delivery fails in a way worth trying again, the destination retries it after 1 second, then
  2, 4, 8 and so on, up to 5 minutes between tries, **for as long as it takes**: until it succeeds or
  someone acts. Later outputs for that destination wait behind it, so they arrive in order.
- When an HTTP 429 or 503 carries a `Retry-After` header, the retry waits as long as the server asks
  if that is longer, still never more than 5 minutes. The time of the next attempt is stored, so a
  restart keeps the wait.
- Other destinations of the same channel, and other channels, keep going.

Worth trying again means the receiver may take it later: a refused connection, a timeout, no ACK, an
MLLP `AR`, an HTTP 5xx, 408, 425 or 429. A delivery the receiver rejects for good (an MLLP `AE`, an
HTTP 101, any other HTTP 4xx) is marked failed, and the destination moves on to the next
output: sending the same message again cannot help.

An HTTP redirect (a 3xx) is neither: it is never followed, since following one could send a message to
a host nobody configured. The delivery is held, tried again every 5 minutes with later outputs behind
it, and reported as `delivery-redirected`, naming the host the redirect points to, until someone fixes
the destination's URL.

Retrying forever, in order, is the choice that loses nothing and reorders nothing. Its cost is that a
destination that is down for a day holds a day of messages, and an operator has to see that; the
health endpoint shows the channel `retrying`, and a hook can page on `delivery-retry`.

## Replay

A failed message stays failed, and is never deleted by retention, until an operator acts:

- `pathways replay <id>` runs the stored message through the transform as it is now, so a fixed
  transform can be replayed, and queues its outputs at the back of each destination's queue;
- `pathways replay <id> --resend` sends the stored outputs again, without transforming;
- `pathways clear <id>` marks it cleared, and retention deletes it later.

## Health

The health endpoint answers 503 only when the engine itself is broken: the database cannot be read,
or a source cannot listen. A destination that is down shows as its channel `retrying`, with the answer
still 200, because restarting the engine does not bring a destination back.

If the database stops answering while the engine runs, the engine stops, with exit code 1, for a
supervisor to restart it. That loses nothing either: what was stored is still stored, and what was not
was never acknowledged.

## Apply it

- [Inspect, replay and clear messages](./inspect-replay-and-clear-messages.md).
- [Check status and health](./check-status-and-health.md).
- [Add lifecycle hooks and webhooks](./add-lifecycle-hooks.md), to page on a retry or a rejection.
- [Write your own sources, destinations and ACKs](./write-custom-connectors.md), which follow the same
  rules.
