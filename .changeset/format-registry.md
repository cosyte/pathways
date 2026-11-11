---
"@cosyte/pathways": patch
---

One format registry, and bytes a transform returns sent as they are.

- Each message format is now one entry in a registry in the transform worker: how a body is read, how its library's model is written, its file extension, its content type and the parser a worker loads. The formats a channel may declare, the `format` enum of the `channel.yaml` JSON Schema, the extensions a file destination writes, the content types an HTTP destination sends, `Format` and `MessageFor` are all read from it. The six formats read and write the same bytes as before.
- A transform may return bytes: a `Uint8Array`, which a `Buffer` is, on a channel of any format, alone or in an array. They are sent exactly as they are, so a body in Latin-1 or a binary one is not encoded as UTF-8 on its way out. Before, a transform that returned bytes failed with `the transform returned something that is neither a message nor a string`.
- A public type change: `TransformOutput<M>` now includes `Uint8Array`, and `MessageTypes` is a type mapped from the registry rather than an interface. Nothing a caller must change, unless a project added keys to `MessageTypes` by declaration merging, which never gave a channel a new format: such a project drops that declaration. Code that took a transform's return value as a `TransformOutput` and handled each case now has a `Uint8Array` case to handle.
