---
"@cosyte/pathways": patch
---

HTTP source options: an HL7 ACK as HL7 over HTTP sets it, PUT, several paths, and a fixed response.

The public addition is three keys of `source.http` in `channel.yaml`, with their JSON Schema:

- `response: ack`, on an `hl7v2` channel, answers each stored message with 200 and the HL7 ACK in the request's media type (`x-application/hl7-v2+er7` or `application/hl7-v2`, others answer 415), with a charset and a `Date` header. The message is stored before the ACK is sent; one with no usable MSH header is stored as failed and answered `AE`, and logged as `http-unreadable`; a store failure answers 503 with no ACK. It takes POST alone, and every answer that is not 2xx is plain text.
- `response: { status, contentType, headers, body }` gives the same 2xx answer to every stored message, checked when the configuration loads, with headers by the HTTP destination's rules. Nothing is copied from the request, and the message is never echoed.
- `methods: [POST, PUT]` takes PUT beside POST; a method not named answers 405 with an `Allow` list.
- `paths: [...]` listens on several paths in place of `path`. Every request path is read by one written rule: the query is ignored, one trailing `/` is ignored, percent-encoding is decoded, and an encoded slash or backslash, a dot segment or an empty segment answers 400.

Nothing a caller must change: a configuration that loaded before answers as before, except that a request path with a dot segment, an empty segment or an encoded slash now answers 400 where it answered 404, and `/path/` now reaches the source on `/path`.
