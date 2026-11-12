---
"@cosyte/pathways": patch
---

An `hl7v2` message a transform returns is now written with `@cosyte/hl7`'s `toBytes()`, in the
character set its MSH-18 declares, so a Latin-1 message that nothing changed leaves byte for byte as
it arrived. Before, every `Hl7Message` was written as UTF-8. A message that holds a character its
declared set has no byte for now fails its output with `UNENCODABLE_CHARACTER`, an error that names
the segment, field and set but never the field's text. A transform that wants UTF-8 out sets MSH-18
to `UNICODE UTF-8`, or returns `message.toString()`. The `@cosyte/hl7` dependency is raised to
0.1.13, the first release with `toBytes()`.
