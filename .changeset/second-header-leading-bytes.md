---
"@cosyte/pathways": patch
---

A second HL7 v2 header behind leading bytes is refused, a second patient where one is allowed is refused, and an HTTP sender is told when its body is refused.

- A body or MLLP frame whose second `MSH`, `FHS` or `BHS` header stands behind bytes that are not printable ASCII (a space, a tab, a NUL, a form feed, a byte order mark in the middle of the body) is now refused with `MULTIPLE_MESSAGES`, on every source, as a second header in any case already was. The HL7 parser keeps such bytes as part of the segment id, so it read the line as an unknown segment and attached the second message's segments, its PID among them, to the first. An MLLP source answers `AR`, an HTTP source in `ack` mode `AE`, and any source's body is stored as failed with `inbound: MULTIPLE_MESSAGES` and never reaches a transform or a destination.
- The transform worker refuses an `hl7v2` message holding more than one PID with the new code `MULTIPLE_PATIENTS`, and the message is stored as failed, when the structure HL7 publishes for its type allows one PID there (read with `@cosyte/hl7`'s `validateMessageStructure`). ADT^A17, ORU^R01 and any other type whose structure repeats the patient pass, and so does a type the published structures do not cover, such as RSP^K22.
- What a sender sees change: an HTTP source without `response: ack` now answers a body its channel refuses with 422 and `{"error": ..., "code": "MULTIPLE_MESSAGES", "id": <message id>}`, whatever `response` says. It answered 202 (or the fixed response) before, while the engine stored the body as failed. Sending it again will not help; send each message in its own request. The engine logs `http-unreadable` for it, with the message id and the code.
- What a caller must change: nothing. A message that held a second patient where its type allows one, and reached a transform before, now fails with `MULTIPLE_PATIENTS`.
