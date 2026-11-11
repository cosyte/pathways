---
id: use-the-message-context
title: Use the message context
sidebar_label: Use the message context
description: "Read a message's source facts, its id and the channel's configuration from the second argument of a transform."
---

# Use the message context

A transform receives a second argument, `ctx`, beside the message. It is a frozen plain object, built
for each message:

| Field           | What it holds                                                                     |
| --------------- | --------------------------------------------------------------------------------- |
| `ctx.messageId` | the stored message's id; `0` under `pathways test`                                |
| `ctx.attempt`   | `1` the first time the message is transformed, one more for each replay or resend |
| `ctx.source`    | what the source knew when it took the message in, by kind; see below              |
| `ctx.config`    | the channel's configuration, from `config:` blocks, read when the engine started  |
| `ctx.meta`      | a per-message map; always empty in this release                                   |

A transform that takes one argument keeps working unchanged: `ctx` is optional in the `Transform`
type, so a test can still call a transform with the message alone. Nothing in `ctx` is logged, sent
to a hook or shown on the health endpoint.

## Configure a transform

Put the values a transform reads in a `config:` block, in `pathways.yaml` for every channel and in a
channel's `channel.yaml` for that channel. The channel's block replaces the project's key by key.

```yaml title="pathways.yaml"
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
config:
  facility: SYNTHHOSP
  lookupUrl: https://codes.example.test/v1
```

A value is any YAML value: a string, a number, a boolean, null, a list or a mapping. A mapping with
the key `env`, `{ env: NAME }`, reads an environment variable when the engine starts, so a secret
stays out of the YAML. `{ env: NAME, default: value }` takes the default when the variable is not set
or is empty:

```yaml title="channels/results-to-ehr/channel.yaml"
source:
  http:
    port: 8443
    tls: { cert: ./tls/server.crt, key: ./tls/server.key }
    contextHeaders: [X-Sending-Facility]
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
config:
  facility: SYNTHLAB
  lookupToken: { env: LOOKUP_TOKEN }
  lookupUrl: { env: LOOKUP_URL, default: "https://codes.example.test/v1" }
```

The variable is read in the engine's own process, never in the transform's worker, and its value is
never part of the loaded configuration that `pathways validate --print` shows. When it is not set, or
is empty, and the reference has no default, `pathways start` stops before it takes anything in, and
names the file, the key and the variable, never a value:

```text
channels/results-to-ehr/channel.yaml: config.lookupToken: the environment variable LOOKUP_TOKEN is not set
```

`pathways test` and `pathways replay` read the configuration the same way, from the environment they
run in.

## Type the configuration

`ctx.config` is typed by the `TransformConfig` interface, which is empty until your project names its
keys. Add them once, in any TypeScript file of the project, by declaration merging:

```ts runnable title="channels/transform-config.ts"
declare module "@cosyte/pathways" {
  interface TransformConfig {
    readonly facility: string;
    readonly lookupUrl: string;
    readonly lookupToken?: string;
  }
}

export {};
```

A key the interface does not name does not type-check, so a misspelled key shows in the editor.

## Read the configuration and the source

This transform stamps the receiving facility from the configuration into MSH-6, and the sending
facility from a request header the HTTP source passed into MSH-4:

```ts runnable title="channels/results-to-ehr/transform.ts"
import type { Transform } from "@cosyte/pathways";

export default ((msg, ctx) => {
  if (ctx === undefined) return msg;
  msg.setField("MSH.6", ctx.config.facility);
  if (ctx.source?.kind === "http") {
    const sender = ctx.source.headers["x-sending-facility"];
    if (sender !== undefined) msg.setField("MSH.4", sender);
  }
  return msg;
}) satisfies Transform;
```

`ctx` is `undefined` only when something other than Pathways calls the transform, such as a unit
test of your own that passes the message alone.

## What each source tells a transform

`ctx.source.kind` names the kind of source, and every kind carries `receivedAt`, when the message was
stored, as an ISO 8601 time.

| Kind     | Fields                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `file`   | `name`, the file's name as it was dropped; `size`, in bytes                                                 |
| `http`   | `method`; `path`, as the source matched it, without a query; `remoteAddress`; `headers`, by lower-case name |
| `mllp`   | `remoteAddress`; `tlsPeerSubject`, the common name of the sender's certificate over mutual TLS              |
| `module` | `facts`: what the custom source passed to `sink.receive` as `source`                                        |

An HTTP source passes only the headers its `contextHeaders` lists. `Authorization`,
`Proxy-Authorization` and `Cookie` carry credentials: the configuration refuses them there, and the
source never passes them. Any other header the list names is passed as it came, so a header that
carries a credential of its own, such as an API key header or a custom token header, reaches the
transform if you list it. A custom source passes a map of plain JSON values,
`sink.receive(body, { source: { queue: "inbound" } })`; anything else is refused with the code
`INVALID_SOURCE_FACTS` before the message is stored. The engine keeps a copy taken when
`sink.receive` is called, so a source may reuse or change its object afterwards. See
[Write custom connectors](./write-custom-connectors.md).

A file's name, a header and a certificate's name can identify a patient or a person. Read them, and
log them only where your own logs may hold such data.

### When the source facts are not known

The engine keeps a message's source facts in memory, from the moment the message is stored until it
is transformed; they are not stored with the message. So `ctx.source` is `undefined`:

- for a message taken in before the engine last started, transformed after the restart;
- on a replay, with `pathways replay`;
- under `pathways test`;
- for a message among the oldest of a backlog of more than 4,096 messages of one channel waiting
  for their transform: the engine keeps the facts of at most 4,096 such messages, and drops the
  oldest first.

A transform that depends on a source fact should handle its absence: filter the message, fail it, or
use a value from the configuration. A transform that branches on `ctx.source` can therefore treat a
replayed message differently from its first run, and send it to other destinations or none.

## Keep state between messages

Module-level state in a transform, such as a lookup table read on the first message, lives in the
channel's worker. It is a cache, not a store: it is lost when the worker is replaced after a timeout,
a crash or running out of memory, and it is not shared with a replay or with `pathways test`, which
run their own workers. Rebuild it from its source when it is missing, as
[Load a lookup table once](./transform-and-filter-messages.md#load-a-lookup-table-once) does.

## Related

- [Transform and filter messages](./transform-and-filter-messages.md): what a transform returns.
- [Configuration reference](./configuration-reference.md#transform-configuration): the `config`
  block and an HTTP source's `contextHeaders`.
- [Transforms in worker threads](./the-transform-worker.md): where a transform runs.
