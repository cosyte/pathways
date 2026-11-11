---
"@cosyte/pathways": patch
---

The transform context: a transform's second argument, `ctx`, with the message's source facts, its id and run, and a configuration map.

The public additions:

- `Transform` and `TransformFor` take `(message, ctx?)`. `ctx` is a `TransformContext`: a frozen plain object built for each message in the transform's worker, holding `messageId`, `attempt` (1, then one more per replay or resend), `source`, `config` and `meta` (always empty in this release).
- `ctx.source` is a `SourceFacts`, by the kind of source, each with `receivedAt`: a file source's `name` and `size`; an HTTP source's `method`, `path`, `remoteAddress` and the `headers` its new `contextHeaders` key lists (`Authorization`, `Proxy-Authorization` and `Cookie` are refused there and never passed); an MLLP source's `remoteAddress` and, over mutual TLS, `tlsPeerSubject`, the common name of the sender's certificate; a custom source's `facts`, what it passes as the new `source` option of `sink.receive`, a map of plain JSON values (anything else is refused with `INVALID_SOURCE_FACTS` before the message is stored). The facts are kept in memory until the message is transformed and are not stored, so `ctx.source` is `undefined` for a message taken in before the engine last started, on a replay, and under `pathways test`.
- A `config:` block in `pathways.yaml` and in `channel.yaml`, the channel's replacing the project's key by key, with its JSON Schema. Each `{ env: NAME }` in it is read in the engine's process when it starts (and by `pathways test` and `pathways replay`); a variable that is not set stops the start with a problem naming the file, key and variable, never a value. `ctx.config` is typed by the exported `TransformConfig` interface, which a project fills in by declaration merging.
- New exported types: `TransformContext`, `TransformConfig`, `SourceFacts`, `FileSourceFacts`, `HttpSourceFacts`, `MllpSourceFacts` and `ModuleSourceFacts`.

Nothing a caller must change: a transform that takes one argument, and every `Transform` and `TransformFor` type, compile and run as before. A project that already used a top-level `config:` key in `pathways.yaml` or `channel.yaml` could not have loaded before, since both refused unknown keys.
