---
id: delivery-and-errors
title: How delivery and errors work
sidebar_label: Delivery and errors
description: "Why a message is stored before it is acknowledged, how order and retries work per destination, how to set retries, what fails a message, and what replay does."
---

# How delivery and errors work

Pathways is built so that a message it has acknowledged is never lost, and so that one broken
destination or one bad message does not stop the others. Each rule below is the default.

## At least once

Every message is stored, durably, before its source acknowledges it, and every output is recorded as
delivered only after its destination accepted it. So a crash at any point loses nothing.

The price is that a crash between a destination accepting an output and Pathways recording it means
the output is sent again on restart. A receiver can, rarely, see a duplicate. Pathways sends at least
once, not exactly once, and it flags the resend.

## A resend after a crash is flagged

Before each attempt, Pathways writes a marker on the delivery: the attempt's number and when it
started. The write that records the outcome (delivered, retry, or failed) clears it. So a delivery
found still marked, on the next start, is one whose attempt was cut off after the destination was
handed the output: the receiver may have it. Pathways sends it again, never drops it, and:

- logs `possible-duplicate` (a warning) with the message, the delivery, the destination, the reason
  `send-interrupted` and the attempt that was cut off;
- hands the destination `resend: { previousAttempts }` on the outgoing message, and puts the same
  `resend` on the attempt's lifecycle events (`delivered`, `delivery-retry` and the rest);
- keeps the flag on the delivery, so every later attempt of it is flagged too, and
  `pathways messages show` names it under `RESENT`.

What the receiver sees depends on the destination:

- **HTTP** sends the message unchanged. With `resendHeader` set on the destination, a resend carries
  that header, its value the number of attempts before it; no other request carries it.
- **MLLP** sends the message unchanged: the same bytes, with the same MSH-10 control ID, so a
  receiver that checks control IDs can spot the repeat. Pathways adds nothing to the message.
- **Files** are written again under the same name, so the copy replaces the first.
- **A custom destination** reads `message.resend` and does what its receiver needs.

A delivery cut off before its marker was written was never handed over, and is sent as usual.

What the flag does not cover:

- **A retry after a timeout or a lost answer goes out unflagged.** When a destination times out, or
  the connection drops before the answer, the receiver may already hold the message, but Pathways
  records that attempt as failed and retries it as usual. The flag covers a process that was cut off
  between the send and the record, not an attempt whose answer never came.
- **Two engines on one database are fenced by the engine lease.** A second engine is refused, and an
  engine whose lease another has taken can no longer record an outcome: see
  [one engine per database](./store-messages-in-a-database.md#one-engine-per-database). An engine
  paused around a send can still mean that delivery is sent once more; that page says when the
  extra copy is flagged and when it is not.
- **The marker is as durable as the database.** On SQLite it survives a process kill. Whether it
  survives a power loss depends on the database's sync setting (SQLite's `synchronous`), the same as
  for stored messages.
- **Migration `0005-send-markers` has no rollback step.** It only adds three columns that may be
  null, and nothing in Pathways removes them.

The marker costs one more write per attempt. On a GitHub runner, two runs of the same comparison
put it between about 1% and 5% for `pathways start --once` with a single 1 MiB message on SQLite,
and about 1.5% to 2% on 100 small HL7 v2 messages, under the comparison's 3% regression threshold
both times. A channel that would rather save it sets
`resendFlag: false` (in `defaults:` or its `channel.yaml`); then no marker is written, and a resend
after a crash goes out unflagged, as it did before.

## Drop a duplicate at the receiver

Each output Pathways sends carries an id that stays the same on every attempt, a resend after a
crash, a retry after a timeout and a `pathways replay --resend` included: its message's id and its
output number, `messageId` and `seq` on the outgoing message. A file destination names each file
`<messageId>-<seq>`, so a second copy replaces the first. A custom destination can send the pair to
its receiver, as a header or a key, and the receiver can keep the last ids it took and drop a copy.
An MLLP receiver can do the same with the MSH-10 control ID, which Pathways sends unchanged.

The pair is unique within one Pathways database: a second database numbers its messages from 1 too,
so a receiver fed by two prefixes the pair with which one sent it.

## Every attempt has a deadline

Each attempt, connecting, sending and waiting for the receiver to confirm, is cut off at a deadline:
an HTTP destination's `timeout` and a second, twice an MLLP destination's `ackTimeout` and a second,
and a file or module destination's `timeout` (30 seconds unless its block sets one). An attempt cut
off is retried as any other failure, with the code `DELIVERY_TIMEOUT`, and the destination was handed
an aborted `signal`. A delivery cut off at its deadline may still arrive: the receiver may have it
by then, and a destination that does not honour the `signal` may finish its send after the cut. The
retry is not flagged as a possible duplicate, so a receiver should drop duplicates by `messageId`
and `seq`, as above. See
[Every delivery has a deadline](./configuration-reference.md#every-delivery-has-a-deadline).

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
  someone acts. Later outputs for that destination wait behind it, so they arrive in order. Those
  are the defaults: [each is a setting](#set-retries-per-destination).
- When an HTTP 429 or 503 carries a `Retry-After` header, the retry waits as long as the server asks
  if that is longer, still never more than 5 minutes (`retry.max`). The time of the next attempt is stored, so a
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

## Set retries per destination

Each of those numbers is a setting: in `defaults:` in `pathways.yaml`, at the top level of a
`channel.yaml`, or in one destination's block. The narrowest that sets a key wins, key by key, so a
destination that sets only `limit` keeps its channel's waits.

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  mllp: { port: 2575, plaintext: true }
retry:
  max: 1m
destinations:
  - mllp: { host: lab.example.test, port: 2575, plaintext: true }
    retry: { first: 500ms, limit: 20, jitter: full }
  - file: { dir: ./archive }
```

| Key         | Default  | What it does                                                                                 |
| ----------- | -------- | -------------------------------------------------------------------------------------------- |
| `first`     | `1s`     | the first retry's wait                                                                       |
| `max`       | `5m`     | the longest wait, whatever a `Retry-After` asks; a held redirect waits this long             |
| `factor`    | `2`      | how much longer each wait is than the one before; `1` waits `first` every time               |
| `jitter`    | `none`   | `full` waits a random time between 0 and the wait, so retries spread out                     |
| `limit`     | `none`   | the most attempts a delivery gets, the first included                                        |
| `maxAge`    | `none`   | how long after it was queued a delivery may still be retried                                 |
| `onExhaust` | `failed` | what happens at the limit or the age                                                         |
| `rotate`    | `false`  | `true` lets later deliveries go ahead of one waiting for a retry, **which breaks the order** |

The defaults are the behaviour described above: 1 second, doubling to 5 minutes, for as long as it
takes, in order.

**Jitter.** With `jitter: none` every destination that failed at the same moment retries at the same
moment, and keeps doing so. When several destinations send to one receiver, or several engines run,
set `jitter: full`: each wait is then a random time between 0 and the wait it would have been, so a
receiver that comes back is not met by every retry at once.

**Running out.** With a `limit` or a `maxAge`, a delivery that fails its last allowed attempt, or
whose next attempt would come later than `maxAge` after it was queued, is marked failed, and the
destination moves on to the next output. Nothing is dropped:

- the delivery keeps its body, so `pathways replay <id> --resend` sends it again once the receiver
  is fixed;
- its stored error names why, such as `exhausted (limit, 20 attempts): delivery: ECONNREFUSED`;
- the engine logs `delivery-exhausted` and sends hooks a `delivery-exhausted` event, with the reason
  `limit` or `maxAge`;
- the channel shows `failed` on the health endpoint and in `pathways status` once nothing of it is
  retrying.

A delivery's age counts from when it was queued: its message's transform, or the replay or resend
that queued it again. Time spent waiting behind an earlier delivery counts. `limit: none` and
`maxAge: none` lift a limit a wider level set. `onExhaust` has one value, `failed`, today.

**Rotate.** With `rotate: true`, a delivery waiting for a retry steps aside: later outputs for that
destination are sent while it waits, and it is tried again when its wait is over. The receiver then
gets them out of order, which for HL7 v2 can leave it with an older picture of a patient than the
newest message. Use it only for a receiver that does not depend on order. A delivery whose wait is
over at once, with full jitter, is tried once a pass, so it does not hold the engine in a loop.

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
