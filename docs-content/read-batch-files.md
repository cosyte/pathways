---
id: read-batch-files
title: Read a batch file or body as many messages
sidebar_label: Batch files
description: "Cut one file or HTTP request body into many messages, each stored on its own, with nothing stored twice after a crash or a retry."
---

# Read a batch file or body as many messages

Some senders put many messages in one file or one request: an HL7 v2 batch with its `FHS` and `BHS`
envelope, a night's results one after another, or a file with one message per line. A file or HTTP
source's `batch:` setting cuts each file or body into pieces, and stores each piece as a message of
its own, which the transform then receives one at a time.

```yaml title="channels/lab-results/channel.yaml"
format: hl7v2
source:
  file:
    dir: ../../data/lab-results/in
    batch:
      split: hl7
transform: ./transform.ts
destinations:
  - file:
      dir: ../../data/lab-results/out
```

## Choose how a batch is cut

`split` takes one of three cuts. Each is made on the file's bytes, never on text decoded from them,
and each piece is stored as exactly the bytes it held: nothing is parsed into a model and written
out again, so a message in any character set keeps its bytes.

| `split`     | A piece is                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hl7`       | each HL7 v2 message, as `@cosyte/hl7`'s `readMessages` finds them: inside `FHS`, `BHS`, `BTS` and `FTS` envelopes (which are not stored), one after another with no envelope, or in MLLP frames |
| `lines`     | each line, ended by a line feed; a carriage return before it is dropped                                                                                                                         |
| `delimiter` | the bytes between each `delimiter`, written as UTF-8; YAML's double-quoted escapes write a control character                                                                                    |

An empty piece, such as a blank line, is passed over. There is no cut by regular expression.

```yaml title="channels/notes/channel.yaml"
format: text
source:
  file:
    dir: ../../data/notes/in
    batch:
      split: delimiter
      delimiter: "\n---\n"
destinations:
  - file:
      dir: ../../data/notes/out
```

[`pathways test`](./test-a-channel.md) cuts each input in a channel's `tests/` folder the same way,
runs every piece through the transform, and compares all their outputs, joined by a newline, with
the one `.expected` file.

## What the transform reads

`ctx.source.batch` holds the piece's place in the file, from 0, and `hash`, the first 16
hexadecimal digits of the SHA-256 of the whole file or body, which every piece of it shares.
`ctx.source.size` is the piece's size.

```ts runnable title="channels/lab-results/transform.ts"
import type { Hl7Message, TransformContext } from "@cosyte/pathways";

export default (msg: Hl7Message, ctx: TransformContext): Hl7Message => {
  if (ctx.source?.kind === "file" && ctx.source.batch !== undefined) {
    msg.setField("MSH.10", `${ctx.source.batch.hash}-${String(ctx.source.batch.piece)}`);
  }
  return msg;
};
```

## How a file is read

The file source claims a batch file as it claims any file, then reads it twice, a chunk at a time,
so memory holds about one piece however large the file is:

1. Once for its size and its hash, and, with `split: hl7`, to check its envelope.
2. Once more to cut it, storing each piece before it reads the next.

Each piece is stored under its own key: the file's claimed name, its hash and the piece's place. The
file is deleted, or moved into `processed/` with `keepProcessed`, only once its last piece is stored.
If the engine stops part way, the file waits claimed; the next pass hands every piece in again, the
pieces stored already are found by their keys, and each piece is stored once.

`maxFileSize` caps the size of a batch file. A larger one is failed whole, as described below,
with the code `BATCH_FILE_TOO_LARGE`. The file source's own `maxSize` still applies before the claim.

## Pieces and files that cannot be read

- With `split: hl7`, a piece `@cosyte/hl7` cannot read (text before the first `MSH`, a header too
  short) is stored as a failed message, with an error such as `batch: NO_MSH_SEGMENT` and no
  content. The pieces after it are stored as usual.
- A file with no piece at all, such as one of blank lines, is failed whole with `BATCH_EMPTY`.

A file failed whole is stored as one failed message, with an error such as `batch: BATCH_EMPTY` and
no content, and moved aside: into `errorDir` under its path from `dir` when the source has one, or
into `.claimed/<channel>/failed/` otherwise. No pass reads it again.

## Incomplete HL7 batches

With `split: hl7`, a batch opened by `BHS` must be closed by `BTS`, one opened by `FHS` by `FTS`,
`BTS-1` must count the messages of its batch, and `FTS-1` the batches of its file, as
`@cosyte/hl7`'s `splitBatch` checks them. A count that is absent or not a number is not checked, and
messages with no envelope at all are complete. `onIncomplete` says what a batch that fails these
checks gets:

| `onIncomplete` | A file source                                                                                | An HTTP source                            |
| -------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `hold`         | the default: leaves it claimed for `holdFor` (5 minutes) from its claim, then fails it whole | not taken                                 |
| `accept`       | stores its pieces as they are                                                                | stores its pieces as they are             |
| `fail`         | fails it whole at once, with `BATCH_INCOMPLETE`                                              | the default: answers 422, storing nothing |

`hold` is for a sender that may still be writing the file: a file that gets its trailer while it
waits is stored whole on a later pass.

## Read batches over HTTP

An HTTP source with `batch:` reads each request body the same way, and answers 202 with the id of
every piece, in order, never their content:

```yaml title="channels/lab-batches/channel.yaml"
format: hl7v2
source:
  http:
    port: 8443
    path: /batches
    tls: { cert: ./tls/server.crt, key: ./tls/server.key }
    batch:
      split: hl7
destinations:
  - file:
      dir: ../../data/lab-batches/out
```

```text title="the answer"
HTTP/1.1 202 Accepted
Content-Type: application/json

{"ids":[41,42,43]}
```

Send an `Idempotency-Key` header with each request, as the IETF HTTPAPI working group's draft
describes it: a string of up to 255 visible ASCII characters, quoted or not, the same on every retry
of one request. Each piece's key is built from it, so a retry after a 503 or a dropped connection
stores no piece twice and answers with the same ids. Without the header the body's hash takes its
place, so a body sent again byte for byte is stored once. A header that is not a key answers 400. A
body with no piece answers 422 with `{"error":"BATCH_EMPTY"}`. `batch:` cannot go with
`response: ack`, which answers one message with one ACK.

## The audit log

Each batch read to the end is recorded in the [audit log](./read-the-audit-log.md) as a `batch` entry
with counts only: `pieces`, `stored`, `failed` (stored as failed), and `duplicates` (stored before,
by an earlier run or an earlier request). A file failed whole is recorded `refused`, with its
`reason`. An envelope warning, such as `BATCH_COUNT_MISMATCH` on a batch taken with `accept`, is
in `warnings`. No entry, log line or error names a file or holds message text.

## Related

- [Read and write message files](./read-and-write-files.md)
- [Send and receive over HTTP](./send-and-receive-http.md)
- [Configuration reference](./configuration-reference.md#batch-block)
