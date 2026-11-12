---
"@cosyte/pathways": patch
---

An MLLP source can dial out to its sender, and can send each ACK to another address.

- New `source.mllp` key `connect: { host, port }`, in place of `port`: the source dials out to the sender and reads messages from that connection, storing each and answering it on the same connection. A dial that fails, or a connection that drops, is dialled again after 1 second, doubling to 5 minutes and back to 1 second once a connection opens; until then the health report shows the source `down`, and the engine logs `source-lost` with a code such as `ECONNREFUSED`, `CONNECT_TIMEOUT` or `MLLP_CONNECTION_CLOSED`. With `connect`, the `tls` block is a client's: `tls: {}` verifies the sender against Node.js's built-in roots, `ca` trusts your own CA, and `cert` and `key` (or `pfx`) present a client certificate. `port`, `host`, `maxConnections`, `keepOpen` and `replyTo` cannot be set with it. The engine logs the new event `mllp-connected` at each connection.
- New `source.mllp` key `replyTo: { host, port }`: each ACK goes on a new connection to that address, never on the connection the message came on, and the address comes from the channel's file only, never from the message. Over TLS the reply host is verified against the source's `tls.ca`, or the built-in roots. A reply that cannot be sent leaves the message stored and logs the new event `mllp-reply-failed` with the message id and a code.
- New `source.mllp` key `connectTimeout` (a duration, 10 seconds by default) bounds each connection the source opens itself, its TLS handshake included. It is refused on a source with neither `connect` nor `replyTo`.
- An MLLP source's `port` is required only when `connect` is not set, in `pathways start` and in the JSON Schema `schema/channel.json` an editor reads. A configuration that loaded before loads unchanged, and nothing a caller writes needs to change.
- The MLLP page now says that over TLS a sender that stalls its handshake holds a `maxConnections` place until Node.js's 120 second handshake timeout, and how to shorten it.
