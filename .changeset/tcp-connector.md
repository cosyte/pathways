---
"@cosyte/pathways": patch
---

A `tcp` source and destination carry feeds that are not MLLP, over TLS unless the block says `plaintext: true`.

- New channel keys: `source.tcp` (`port`, `host`, `tls`, `plaintext`, `framing`, `maxConnections`, `maxMessageSize`, `idleTimeout`, `stallTimeout`, `reply`) and `destinations[].tcp` (`host`, `port`, `tls`, `plaintext`, `framing`, `maxMessageSize`, `timeout`, `expectReply`, `replyCheck`). Nothing changes for a channel without them.
- `framing` names exactly one of `{ raw: true }` (one message per connection, read until the sender closes its side; `maxMessageSize` required), `{ delimiter: "0a" }`, `{ lengthPrefix: { bytes: 1 | 2 | 4, endian, inclusive } }` or `{ startEnd: { start, end } }`, the bytes in hex in quotes.
- Every frame is bounded: a frame past `maxMessageSize` (10MB by default), a length prefix that declares more, or a frame that sends no byte for `stallTimeout` (30s) closes the connection once the messages before it are stored and answered, and is never stored; a connection with no frame begun for `idleTimeout` (5m) is closed; an empty frame is skipped, and a frame cut off by a close or a reset is dropped and logged with its length. A sender that closes or resets still has every whole frame it sent stored, and a whole frame that cannot be stored is counted in `tcp-frames-dropped` at warn.
- A source holds `maxConnections` (100 by default) at once: one over it is closed at accept, logged as `tcp-connection-refused`, and counted in the channel's `connections.refused` on health, as for an MLLP source.
- A source answers nothing unless `reply` is set: `{ hex }` sends the same bytes for every message, and `{ builder: ./reply.ts }` runs a module given the stored message's id. Either runs only once the message is stored, and is framed as messages are.
- A destination sends each output as one frame on a connection of its own. With `expectReply: true` it reads one framed reply within `timeout`, and any reply means delivered unless `replyCheck`, a module, answers `retry` or `rejected`.
- A channel with a tcp endpoint and the format `hl7v2`, said or by default, loads with a warning: HL7 v2 with ACKs stays with MLLP.
- Public API: the types `TcpReplyBuilder`, `TcpReplyRequest`, `TcpReplyCheck`, `TcpReply`, `TcpReplyVerdict` and `TcpSourceFacts`, and `SourceFacts` gains the `tcp` kind. A transform that switches on `ctx.source.kind` and lists every kind gains a case to handle; nothing else changes for a caller.
- Two configuration messages name the new kind: "name exactly one of: file, http, mllp, tcp, module", and `poll` on a listening source now says "http, mllp and tcp listen rather than poll".
- The docs gain "Send and receive over TCP", and the configuration reference, the codes page, the endpoint security page and the API reference list the new keys, events and codes.
