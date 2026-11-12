---
"@cosyte/pathways": patch
---

Batch reading for the file and HTTP sources: one file or request body cut into many messages, each stored on its own.

The public additions:

- `batch:` on `source.file` and `source.http` in `channel.yaml`, with its JSON Schema: `split: hl7 | lines | delimiter`, and `delimiter` for the last. `hl7` cuts with `@cosyte/hl7`'s `readMessages` (batch envelopes, bare messages one after another, MLLP frames); `lines` at each LF, a CR before it dropped; `delimiter` at each run of its UTF-8 bytes. Every cut is made on bytes, and each piece is stored as exactly the bytes it held. There is no cut by regular expression.
- `maxFileSize`, a file source's cap on a batch file: a larger one is failed whole with the code `BATCH_FILE_TOO_LARGE`.
- `onIncomplete` and `holdFor`: with `split: hl7`, a batch lacking its `BTS` or `FTS` trailer, or whose `BTS-1` or `FTS-1` count does not match, is held claimed for `holdFor` (5 minutes) by default and then failed with `BATCH_INCOMPLETE`, or stored as it is (`accept`), or failed at once (`fail`). An HTTP source answers 422 by default, or takes `accept`.
- The `Idempotency-Key` request header on an HTTP source with `batch:`: with the body's hash, the origin of every piece's key, so a retry stores no piece twice. A key used before for another body answers 422 with `BATCH_KEY_REUSED` and stores nothing, and requests under one key are stored one after another, so two sent at once store their pieces once. Without the header the body's hash takes its place. The answer is 202 with `{"ids": [...]}`, every piece's id, never content.
- `ctx.source.batch`, `{ piece, hash }`, for a message cut from a file or body: its place, and the first 16 hexadecimal digits of the SHA-256 of the whole, with the `BatchFacts` type.
- A `batch` audit action, each batch's counts (`pieces`, `stored`, `failed`, `duplicates`) and, for one failed whole, its `reason`; and on `MessageSink`, the optional `receivePiece`, `batchDone` and `heldOrigin` the built-in sources call, with the `ReceivedPiece` and `BatchResult` types; on `MessageStore`, the optional `heldIdempotencyKey` that `heldOrigin` reads.
- `pathways test` cuts each input of a channel with `batch:` the same way and compares all its pieces' outputs.

A file source reads a batch file twice, a chunk at a time (once for its size, hash and envelope, once to store its pieces), so memory holds about one piece. Each piece is stored under the key of the claimed name, the file's hash and its place, and the file is deleted only once its last piece is stored: a stop part way leaves it claimed, and the next pass hands every piece in again with `resumed`, storing each once. A piece `@cosyte/hl7` cannot read is stored as failed with `batch: <code>` and no content while the rest go on; a file with no piece is failed whole with `BATCH_EMPTY`. A file failed whole is stored as one failed message and moved into `errorDir`, or into `.claimed/<channel>/failed/`, and no pass reads it again.

`@cosyte/hl7` moves to `^0.1.12`, the first release range with `readMessages`.

Nothing a caller must change: without `batch:` a source reads each file or body as one message, as before. A custom `MessageSink` needs none of the new methods; a batch read through one without `receivePiece` counts no duplicates, and one without `heldOrigin` stores a changed body sent under a used key as a batch of its own rather than answering 422. A custom store without `heldIdempotencyKey` does the same.
