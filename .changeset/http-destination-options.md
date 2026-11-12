---
"@cosyte/pathways": patch
---

The HTTP destination takes a method, fills its URL from each message's metadata, names each output with an idempotency header, and checks every address it connects to.

- `method:` sends each output by `POST` (the default), `PUT`, `PATCH`, `DELETE` or `GET`; `GET` and `DELETE` send no body and no `Content-Type`, so a destination with either and `ack: xml` is refused when the configuration loads: there is no message for the acknowledgement to answer.
- The `url:` path, and each value of the new `query:` mapping, may hold placeholders, a `ctx.meta` key in braces such as `{mrn}`. Each is filled per message, percent-encoded, so a value never changes the scheme, the host or the port; a placeholder anywhere else is refused when the configuration loads. A key the metadata lacks, an empty path value, a value of `.` or `..`, or text that cannot be encoded fails that delivery for good, with an error naming the key and never the value (`rejected: URL_TEMPLATE_MISSING mrn`). `ctx.meta` is still empty in this release, so a URL with a placeholder fails every delivery until it can be set. The docs warn that values in a URL reach server and proxy logs.
- `idempotencyHeader:` names a header sent on every attempt, its value `<messageId>-<seq>`.
- Every connection an HTTP destination opens is checked at connect against the address it connects to, so a name that rebinds to an internal address is caught too: loopback, link-local (cloud metadata), private and unspecified addresses are refused, and the delivery retried with the code `ADDRESS_REFUSED`, unless the new `allowNetworks:` list names the network.
- What a caller must change: an HTTP destination whose host is, or resolves to, a loopback, link-local or private address (`127.0.0.1`, `10.x`, `192.168.x` and the like) now needs `allowNetworks:` naming it, such as `allowNetworks: [10.20.0.0/16]`; until then its deliveries wait with `ADDRESS_REFUSED`. The webhook hook is not checked.
- API additions: the channel keys `method`, `query`, `idempotencyHeader` and `allowNetworks` on an HTTP destination; `OutgoingMessage` gains an optional `meta`, handed to a destination that fills its URL from it; `MessageStore` gains the optional `messageMeta`, which reads one message's metadata back through the codec (a custom store without it hands over none). No custom connector or store needs to change.
