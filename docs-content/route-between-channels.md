---
id: route-between-channels
title: Route messages between channels
sidebar_label: Route between channels
description: "Hand a message from one channel to another through the store, with a channel destination or ctx.route in a transform, under the same at-least-once and order rules as any delivery."
---

# Route messages between channels

One channel can hand a message to another channel of the same project. The hand-off goes through
the store: the target channel gets a new message of its own, stored in the same transaction as the
source's record, so a crash never loses it and never stores it twice. Two ways start one:

- a **channel destination**, `channel: { name }`, hands every output of the source channel over;
- **`ctx.route(name, message)`** in a transform hands over one message of its choosing, beside what
  the transform returns.

The target channel's source is `channel: {}`: nothing listens or polls, and it takes in only what
other channels hand it.

## Hand every output to another channel

```yaml title="channels/adt-in/channel.yaml"
source:
  mllp: { port: 2575, tls: { cert: ../../tls/server.crt, key: ../../tls/server.key } }
transform: ./transform.ts
destinations:
  - channel: { name: adt-to-lab, carryMeta: [mrn] }
  - channel: { name: adt-archive }
```

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  channel: {}
transform: ./transform.ts
destinations:
  - mllp: { host: lab.example.test, port: 2575, tls: {} }
```

Each output of `adt-in` becomes a message of `adt-to-lab`, received there as if a source had taken
it in, and runs through that channel's own transform and destinations.

- **`name`** is the target channel. Its source must be `channel:`.
- **`carryMeta`** lists the `ctx.meta` keys copied from the source message to the new one, by
  name. None are copied by default, and there is no way to copy all of them: a key you do not name
  stays with the source message.

A channel destination takes `retry` and `dryRun` like any other; it takes no `timeout`, since
nothing is sent over a connection. Run dry, it records the output and hands nothing over.

## Route from a transform

`ctx.route(name, message)` hands `message` to channel `name` and returns nothing. The message is
anything a transform may return: a model, a string or bytes.

```ts runnable title="channels/adt-in/transform.ts"
import type { Transform } from "@cosyte/pathways";

export default ((msg, ctx) => {
  if (msg.includes("ORU^R01")) ctx?.route("results-in", msg);
  return msg;
}) satisfies Transform<string>;
```

The target's source is `channel:`, with `routed: true` when only `ctx.route` feeds it, since start
cannot see a call in a transform:

```yaml title="channels/results-in/channel.yaml"
source:
  channel: { routed: true }
destinations:
  - file: { dir: ../../data/results }
```

The routes are stored in the same transaction that records the transform's outcome. When the
transform fails, none of its routes are kept; when it succeeds, all of them are. That includes a
transform that returns nothing: its routes are kept, and its own message is recorded as filtered.
A name that is no channel with a `channel:` source fails the message with
`ERR_PATHWAYS_UNKNOWN_ROUTE`, and nothing is handed over.

A channel with `storage.content: none` stores nothing, so it can neither hand over nor be handed
to: start refuses a channel destination or a `channel:` source on one, and a transform there that
calls `ctx.route` fails its pass with `ROUTE_UNSTORED` (logged as `pass-transform-failed` with the
code `ERR_PATHWAYS_UNKNOWN_ROUTE`), so its sender is told not to send it again.

`pathways test` runs a transform that routes, and keeps nothing it routes. `pathways replay`
refuses a message whose transform routes, and changes nothing; `pathways replay --resend` works,
since it runs no transform.

### Recover a message a route failed

A message whose transform failed on a route, with `ERR_PATHWAYS_UNKNOWN_ROUTE`,
`ERR_PATHWAYS_HOP_LIMIT` or `ERR_PATHWAYS_TOO_MANY_ROUTES`, cannot be replayed: the replay runs the
transform again, which routes again, so `pathways replay` refuses it, and it has no outputs for
`pathways replay --resend` to send. Fix the configuration or the transform first, then send the
message in again: from its sender, or, when it was itself handed over by a channel destination, with
`pathways replay --resend` on its parent in the source channel, which hands it over anew. A channel
destination's delivery that failed with `ERR_PATHWAYS_HOP_LIMIT` is sent again the same way, with
`pathways replay --resend` on the source message once the target's `maxHops` is raised.

## What start checks

`pathways start` and `pathways validate` refuse a project when:

- a channel destination names a channel that does not exist, or one whose source is not `channel:`;
- a `channel:` source is named by no channel destination and does not set `routed: true`;
- channel destinations make a loop. The problem names it, such as
  `channels/a/channel.yaml: destinations: channel destinations make a loop, a -> b -> a`.

## Hops and loops

Each message counts the hand-offs that brought it: 1 for the first, one more for each after it. A
hand-off past the target's `maxHops` (8 by default) fails instead, with `ERR_PATHWAYS_HOP_LIMIT`:
the channel destination's delivery fails, or the transform's message does. This catches a loop
made through `ctx.route`, which start cannot see.

## A full or stopped target

A paused or stopped target still takes hand-offs: they wait as stored messages until it runs
again. So that a stopped target cannot grow the store without bound, each target holds at most
`maxPending` messages waiting for its transform (10,000 by default):

```yaml title="channels/adt-to-lab/channel.yaml"
source:
  channel: { maxPending: 2000, maxHops: 4 }
destinations:
  - mllp: { host: lab.example.test, port: 2575, tls: {} }
```

A target is full for a hand-off when the messages it holds waiting, with the ones this hand-off
brings it, would come to more than `maxPending`. A store without the `handOff` method counts the
same way.

When the target is full, a channel destination's delivery waits and is tried again after its
`retry.first`, without counting an attempt, and the deliveries behind it wait too; its error reads
`hand-off: ERR_PATHWAYS_TARGET_FULL`. A transform that routes into a full target leaves its
message received, to run again on a later pass.

A transform that routes more messages to one target in one run than that target's `maxPending`
could never be taken whole, however long it waited: its message fails with
`ERR_PATHWAYS_TOO_MANY_ROUTES`, nothing is handed over, and the channel goes on to its next
message.

## Order, replays and crashes

- **Order** is kept per source channel: a channel destination hands its outputs over in the order
  it delivers them, so the target receives them in that order. When several channels feed one
  target, their messages interleave in the order they were handed over.
- **A crash** before the hand-off's transaction commits leaves nothing handed over, and the work
  is done again. A store without the `handOff` method, such as a custom one, stores the new
  message first and records the source after it; each hand-off carries an idempotency key built
  from the source channel, the delivery and the message's generation, so a crash between the two
  hands over once.
- **A replay or resend** of the source message queues new deliveries, which hand over again as new
  messages. Their parent link carries the generation, above 0 for a replay or resend, so the key
  of a replay never matches that of the first hand-off.

## See the link

`pathways messages show` names a handed-over message's parent, and lists what a message handed
over:

```text
Message 41
  channel           adt-to-lab
  ...
  handed over from  message 12 of adt-in (delivery 30)
  hops              1
```

`pathways status` names, for each channel, the channels it feeds and those that feed it through
channel destinations (`feeds:` and `fed by:`).

Because the hand-off goes through the store, every engine node on the same database sees it.

## Related

- [Configuration reference](./configuration-reference.md#channel-source)
- [Use the message context](./use-the-message-context.md)
- [Delivery and errors](./delivery-and-errors.md)
