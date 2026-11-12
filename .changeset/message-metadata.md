---
"@cosyte/pathways": patch
---

Pathways now sets each message's metadata, `ctx.meta`, when it takes the message in, so an HTTP destination's URL placeholders and an SMTP destination's `{{ meta.<key> }}` placeholders have values to fill.

- On an `hl7v2` channel the keys are `messageType`, `messageCode`, `triggerEvent`, `controlId`, `version`, `processingId`, `sendingApp`, `sendingFacility`, `receivingApp` and `receivingFacility` from the MSH segment, and `mrn` from the first PID segment. Each is set only when its field holds a value of at most 200 characters. A channel of any other format gets none in this release. The configuration reference lists them under Message metadata.
- The metadata is stored with the message, encrypted like the body, and an `index:` block can search it. A transform reads it as `ctx.meta`, and a replay and `pathways test` work it out from the message the same way.
- An HTTP destination whose URL names a key the message's metadata lacks now fails that attempt with `MetaKeyMissing` (code `URL_TEMPLATE_MISSING`) and keeps the delivery for a retry under its `retry` block, its error naming the key (`delivery: URL_TEMPLATE_MISSING mrn`), where before it failed the delivery for good. An empty path value, a value of `.` or `..`, or text that cannot be encoded still fails it for good.
- An SMTP destination whose subject or body names `{{ meta.<key> }}` is now handed the message's metadata; before, such a placeholder was always filled with nothing.
- What a caller must change: nothing. A transform that took `ctx.meta` to be empty now sees the keys above on an HL7 v2 channel, and a channel whose deliveries were failing on a missing URL key now retries them instead.
