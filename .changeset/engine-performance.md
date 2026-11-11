---
"@cosyte/pathways": patch
---

Faster and leaner on large messages, with the same outputs: every transform output, ACK, stored row, delivered file and log line is unchanged on a corpus of 705 synthetic inputs across every format.

- `@cosyte/hl7` 0.1.9, `@cosyte/fhir` 0.1.9, `@cosyte/x12` 0.1.11, `@cosyte/ccda` 0.1.6 and `@cosyte/mllp` 0.1.7. Under the default 256 MB memory cap, the transform worker now carries a dense HL7 v2 result report of up to about 5 MiB, where it carried about 2 MiB. Writing an HL7 v2 message back out still builds its whole parsed tree, about 44 times its size, so a channel that takes larger dense messages needs a larger `memory`.
- Importing `@cosyte/pathways` no longer loads `@cosyte/hl7`: `defaultAckBuilder` loads it on its first ACK, as the same module an `import` of it gives, so a header you parsed with `parseHL7` is accepted as before.
- A `json` channel checks its numbers in one pass over the body instead of through a reviver on every value. It accepts and refuses exactly the bodies it did, with the same codes.
- SQLite prepares each statement once per connection instead of on every query.
- The engine hands a body from stage to stage, or frees it once a stage is done, instead of copying it: encryption and decryption write into one buffer, the body moves to the transform worker and its outputs move back, and the file source and destination free a body once it is stored or written. A text payload the engine only passes through is now held about once in its own thread, where it was held about nine times. A custom store, source or destination sees no change: a body it is handed or hands over is never freed or moved.
