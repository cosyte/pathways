---
id: pass-messages-through-without-storing
title: Pass messages through without storing them
sidebar_label: Store nothing
description: "Run a channel that stores no message: each one is transformed and delivered while its sender waits, and the sender is answered only once every destination accepted it."
---

# Pass messages through without storing them

By default Pathways stores each message before its source answers the sender, then transforms and
delivers it, retrying a destination that is down. That is what lets it replay and resend, and what
keeps a message safe across a crash. It also keeps patient data at rest until
[retention](./set-message-retention.md) deletes it.

A channel that must keep no patient data at all can store nothing instead. With
`storage.content: none`, each message is transformed and sent to every destination while its sender
waits, and the source answers only once every destination has accepted it. The sender's own retry
is the retry.

```yaml title="channels/adt-to-lab/channel.yaml"
storage:
  content: none
  passTimeout: 20s
source:
  mllp: { port: 2575, tls: { cert: ../../certs/server.crt, key: ../../certs/server.key } }
transform: ./transform.ts
destinations:
  - mllp: { host: lab.example.com, port: 2576, tls: { ca: ../../certs/lab-ca.crt } }
```

Only a channel sets `none`: `pathways.yaml`'s `storage.content` is `keep` or `dropAfterDelivery`,
so no channel stores nothing by accident. At start the engine logs `content-none` for each such
channel, with its `passTimeoutMs`.

## What the sender is told

| What happened                                                         | MLLP                          | HTTP                            | File                                          |
| --------------------------------------------------------------------- | ----------------------------- | ------------------------------- | --------------------------------------------- |
| every destination accepted it, or the transform sent it nowhere       | `AA`                          | the source's usual 2xx          | the file is deleted, or moved to `processed/` |
| a destination failed or timed out, or the pass ran past `passTimeout` | no ACK; the connection closes | 503 with `Retry-After`          | the file stays, and the next pass tries again |
| the transform failed, or a destination rejected the message for good  | `AE`                          | 422 (`AE` with `response: ack`) | the file moves into `errorDir`                |

A failure that may pass leaves the sender to send the message again. One that cannot (a transform
that throws, a receiver that answers `AE` or a 4xx) is answered so, and the sender should not send
it again. A message with no usable MSH header is answered as on any channel, and counted
`unreadable`. Over MLLP, `onStoreFailure` still says what a failure that may pass is answered with: by
default it closes the connection without an ACK.

A destination with its own `transform:` is sent what that transform made, as on a stored channel,
and nothing when it filters the message; the pass counts as filtered only when every destination's
transform filtered it. When one destination's transform throws, the others are still sent the
message, and the sender is answered as for a channel transform that throws.

`Retry-After` is the wait the receiver asked for, when it asked, or else the channel's first retry
wait (`retry.first`, 1 second by default), in whole seconds.

The destinations are tried in order, and the outputs of a message in order. When one fails in a way
that may pass, the pass stops there and the later destinations are not sent the message: the
sender's retry sends it to all of them again. When one rejects it for good, the others are still
sent it.

## How long a sender waits

`passTimeout` bounds the whole pass: the transform, and every send to every destination. Past it,
the sender is answered as for a failure that may pass, and a send still in flight is told to give
up. It is 30 seconds by default. Each destination's own timeout still applies within it.

Set it below the time your sender waits for an answer. An MLLP sender that waits 30 seconds for its
ACK and gets none sends again anyway, so a pass that answers later only adds a duplicate. We have not
checked how every HL7 sender behaves when its ACK waits on a downstream send: try yours with a slow
receiver before you rely on it.

Messages pass one at a time per channel, in the order they came in, so each destination gets them in
that order. A slow receiver slows every sender of the channel.

## What is kept, and what is not

- **Nothing is kept to replay.** No body, output or delivery is stored, so there is nothing for
  `pathways replay`, `pathways resend`, `pathways messages` or `pathways rekey` to find, no retry
  queue, and nothing for retention to delete. The engine keeps counts, in memory, since it started.
- **Nothing the sender was told was received is lost in a crash.** The source answers only after
  every destination accepted the message. A crash before that answer leaves the sender with no
  answer, and it sends the message again.
- **Duplicates come from the sender's retry.** A crash or a failure after one destination accepted a
  message and before the answer means the sender sends it again, and that destination gets it twice.
  Pathways does not flag these: there is no stored copy to compare against. A receiver that must not
  act twice on one message should check its control ID (MSH-10) itself.

## Sources

MLLP, tcp and HTTP sources answer as the table says. A tcp source, and a custom source, treat a
refused message as one that could not be stored: no reply, and the sender sends again.

A file source on such a channel needs `errorDir`, where a file no destination will accept moves;
without it, start refuses the channel, since the file would be sent again on every pass. A file
already in `errorDir` under the same name is kept, and the new one goes in under its claimed name.
An S3 or Azure Blob source cannot store nothing yet: start refuses it.

```yaml title="channels/notes/channel.yaml"
format: text
storage:
  content: none
source:
  file: { dir: ../../data/notes/in, errorDir: ../../data/notes/error }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/notes/out }
```

A custom source tells the cases apart with [`PassFailed`](./api/README.md#passfailed): `receive`
rejects with one whose `permanent` says whether the sender should send again, and whose
`retryAfterMs` says how long it might wait.

## Health

The health endpoint shows such a channel with `storage: "volatile"` and `passes`, how its passes
ended since the engine started:

```json
{
  "status": "ok",
  "source": "up",
  "state": "running",
  "messages": { "received": 0, "transformed": 0, "filtered": 0, "failed": 0, "cleared": 0 },
  "deliveries": { "pending": 0, "delivered": 0, "failed": 0, "cleared": 0, "retrying": 0 },
  "storage": "volatile",
  "passes": { "accepted": 41, "filtered": 2, "unreadable": 0, "rejected": 1, "deferred": 3 }
}
```

`deferred` counts the messages a sender was told to send again, and `rejected` those it was told not
to. The counts start from zero on each start. The engine logs each pass by its id (`passed`,
`pass-filtered`, `pass-failed` and the rest in [Logs and codes](./logs-and-codes.md)), never its
content.

## Pass ids

Each message gets a pass id: the time it came in, in microseconds since 1970, or one more than the
last id when two come in the same microsecond. It is the `messageId` a destination is handed, so a
file destination writes `<pass id>-1.<extension>`, an S3 or Azure Blob destination keys its object the
same way, and an email destination puts it in its `Message-ID`. A file source with
`keepProcessed: true` names its kept copy `<pass id>-<file name>`. A later start gives higher ids,
so its outputs never overwrite one an earlier run wrote and its reader has not taken yet. That holds
while the clock does not go back. Two engines that share a database run a channel one at a time,
under the engine lease; two engines on separate databases writing to one folder are not kept apart,
here or on a channel that stores its messages.

A file source with `keepProcessed: true` keeps a plaintext copy of each file it took in, in
`processed/`, on a channel that stores nothing too: leave it off if no copy of a message should stay
on disk.

## In a cluster

A channel that stores nothing runs on the active engine, as every channel does. A
[standby](./store-messages-in-a-database.md#a-standby) takes no message for it until it takes over,
so senders retry against the active one meanwhile.

## Related

- [Set message retention](./set-message-retention.md#drop-content-after-delivery), to keep metadata and
  drop content after delivery instead.
- [How delivery and errors work](./delivery-and-errors.md).
- [Configuration reference](./configuration-reference.md#channelyaml).
