---
id: send-and-receive-tcp
title: Send and receive over TCP
sidebar_label: TCP
description: "Take in and send messages over TCP or TLS for feeds that are not MLLP, framed by delimiter, length prefix, start and end bytes, or close."
---

# Send and receive over TCP

Some feeds send messages over a TCP socket without MLLP: lines that end in a newline, records after
a length, text between STX and ETX, or one message per connection. A `tcp` source and destination
carry these. Both run over TLS unless the block says `plaintext: true`, as MLLP does.

HL7 v2 with ACKs stays with [MLLP](./send-and-receive-mllp.md): a tcp source sends no HL7 ACK and
reads no MSH-10. A channel with a tcp endpoint and the format `hl7v2`, said or by default, loads
with a warning that says so; set the format the feed carries, such as `text` or `json`.

## Choose a framing

The framing says where one message ends and the next begins. Name exactly one:

| Framing                                    | One message is                                                      |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `{ delimiter: "0a" }`                      | the bytes before the delimiter, 1 to 16 bytes                       |
| `{ lengthPrefix: { bytes: 4 } }`           | the bytes after their length, an unsigned number of 1, 2 or 4 bytes |
| `{ startEnd: { start: "02", end: "03" } }` | the bytes between the start and the end bytes, each 1 to 16 bytes   |
| `{ raw: true }`                            | every byte on a connection until the sender closes its side         |

Bytes are written in hex, two digits a byte, in quotes: `"0d0a"` is a carriage return and a line
feed. Without quotes YAML reads `10` as a number, and the channel is refused.

A length prefix is big-endian unless it says `endian: little`, and counts the message's bytes alone
unless it says `inclusive: true`, when it counts its own bytes too. With start and end bytes, any
bytes between one frame's end and the next frame's start are dropped and logged as
`tcp-discarded-bytes`.

## Listen for messages

```yaml title="channels/orders-in/channel.yaml"
format: text
source:
  tcp:
    port: 7001
    host: 0.0.0.0
    tls:
      cert: ../../certs/server.pem
      key: ../../certs/server.key
      ca: ../../certs/senders-ca.pem
    framing: { delimiter: "0a" }
    maxMessageSize: 64KB
    reply: { hex: "06" }
destinations:
  - file: { dir: ../../data/orders-in/out }
```

- **`host`** is `127.0.0.1` by default: only this machine can connect.
- **`tls`** takes the server's certificate and key, and with `ca` requires every sender to present a
  certificate that CA signed. The transform reads the sender's address and that certificate's common
  name in `ctx.source`, as [`TcpSourceFacts`](./api/README.md#tcpsourcefacts).
- **`plaintext: true`** in place of `tls` listens without TLS. The engine logs `plaintext` for the
  channel at every start.

Each message is stored before anything is answered, and the messages on one connection are handled
one at a time, in order.

### Every frame is bounded

| What happens                                             | What the source does                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| more than `maxConnections` (`100`) at once               | closes the new connection at accept, logs `tcp-connection-refused`, and counts it on health          |
| a frame longer than `maxMessageSize` (`10MB` by default) | closes the connection once the messages before it are stored and answered; the frame is never stored |
| a length prefix that declares more than `maxMessageSize` | the same, before a byte of the message is read                                                       |
| a frame begun, then no byte for `stallTimeout` (`30s`)   | the same; the part is dropped                                                                        |
| no frame begun for `idleTimeout` (`5m`)                  | closes the connection                                                                                |
| the sender closes or resets mid-frame                    | drops the part, and logs `tcp-partial-frame` with its length                                         |
| the sender closes or resets after whole frames           | stores every whole frame it sent; a reply has nowhere to go, so none is written                      |
| an empty frame                                           | skips it: nothing is stored or answered                                                              |

Raw framing has no end marker, so `maxMessageSize` is required with it: a connection that sends more
is closed and stores nothing. A raw connection that sends nothing before it closes, such as a port
check, stores nothing either.

### Reply once a message is stored

Without `reply:` the source answers nothing. With it, each message is answered once it is stored,
framed as messages are:

- **`reply: { hex: "06" }`** sends the same bytes for every message, at most 4,096.
- **`reply: { builder: ./reply.ts }`** runs a module of your own, given the stored message's id.

```ts runnable title="channels/orders-in/reply.ts"
import type { TcpReplyBuilder } from "@cosyte/pathways";

export default (({ messageId }) => `OK ${messageId}`) satisfies TcpReplyBuilder;
```

The builder returns bytes, or a string sent as UTF-8. It runs in the engine's own thread, once per
message, under the channel's transform time limit. When a message cannot be stored, no reply is sent
and the connection closes, so the sender sends again. When the builder throws, runs out of time, or
returns a reply its framing cannot carry, the source logs `tcp-reply-failed` or
`tcp-reply-unsendable` and closes the connection without a reply: the message is already stored, so
a sender that sends it again stores it twice. In either case the whole frames queued behind it on
that connection are not stored, and `tcp-frames-dropped` counts them at warn, as it counts a frame
that arrives while the source stops or the connection closes: the sender has to send them again.

With raw framing the sender closes its side to end the message, and the source sends the reply on
its own side before it closes.

## Send messages

```yaml title="channels/orders-out/channel.yaml"
format: text
source:
  file: { dir: ../../data/orders-out/in }
destinations:
  - tcp:
      host: lab.example.com
      port: 7002
      tls: { ca: ../../certs/lab-ca.pem }
      framing: { lengthPrefix: { bytes: 4 } }
      timeout: 10s
      expectReply: true
      replyCheck: ./check.ts
```

Each output goes as one frame on a connection of its own, so a late reply can never answer the
wrong output. `tls: {}` verifies the receiver against Node.js's built-in roots, `tls.ca` against
your own CA, and `tls.cert` with `tls.key` present a client certificate. `timeout` (10 seconds by
default) is how long to wait to connect, and then for the send and its reply.

Without `expectReply`, an output is delivered once it is written: the operating system has taken
the bytes, which says nothing of whether the receiver read them. With `expectReply: true`, the
destination reads one framed reply, at most `maxMessageSize`, and any reply means delivered unless a
reply check says otherwise:

```ts runnable title="channels/orders-out/check.ts"
import type { TcpReplyCheck } from "@cosyte/pathways";

export default ((reply) => {
  const text = Buffer.from(reply.body).toString("latin1");
  if (text === "ACK") return "delivered";
  return text === "NAK" ? "rejected" : "retry";
}) satisfies TcpReplyCheck;
```

| The check answers, or what happens                                                                 | The delivery                                   |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `delivered`, or any reply with no check                                                            | delivered                                      |
| `rejected`                                                                                         | failed for good; the destination moves on      |
| `retry`, no reply in time, a reply too long, a closed or failed connection, or a check that throws | retried, with later messages waiting behind it |

An output that holds the delimiter or the end bytes, or is too long for the length prefix, can never
be sent, so it fails at once. With raw framing the destination closes its side to end the output,
and reads the reply until the receiver closes, so `maxMessageSize` is required with
`expectReply: true`. Each code is listed in [Logs, errors and codes](./logs-and-codes.md#delivery-codes).

## Related

- [Send and receive HL7 v2 over MLLP](./send-and-receive-mllp.md).
- [Authenticate endpoints and use TLS](./secure-endpoints.md).
- [Configuration reference: TCP](./configuration-reference.md#tcp-source).
