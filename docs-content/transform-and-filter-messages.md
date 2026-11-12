---
id: transform-and-filter-messages
title: Transform and filter messages
sidebar_label: Transform and filter
description: "Write a channel's transform: edit or filter a message, send several outputs, transform for one destination, load a lookup table, and fail a message."
---

# Transform and filter messages

A transform is the default export of the module a channel's `transform:` names. It receives each
message parsed in the channel's format and returns what to send on.

| It returns                        | What happens                                                    |
| --------------------------------- | --------------------------------------------------------------- |
| a message, or a string            | one output, sent to every destination                           |
| an array of messages or strings   | one output each, in order                                       |
| `null` or `undefined`             | the message is filtered: stored as `filtered`, and nothing sent |
| it throws, or its promise rejects | the message is marked `failed`, and the channel moves on        |

A transform may be `async`. Each message's transform runs in the channel's own worker thread, one
message at a time and in the order they arrived.

## Edit a message and filter the rest

```ts runnable title="channels/adt-to-lab/transform.ts"
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  // Admissions and registrations go on; everything else is filtered out.
  if (!msg.is("ADT^A01") && !msg.is("ADT^A04")) return null;
  msg.setField("MSH.5", "LAB");
  msg.setField("MSH.6", "SYNTHHOSP");
  return msg;
}) satisfies Transform;
```

`Transform` with no type argument types `msg` as an `Hl7Message` from `@cosyte/hl7`, which is what an
`hl7v2` channel receives. `satisfies` checks the function in your editor and leaves Node.js free to
run the file as it is.

## Send several outputs

Return an array. This transform, on a `json` channel, splits an export that holds a list of records
into one message per record:

```ts runnable title="channels/export-to-records/transform.ts"
import type { TransformFor } from "@cosyte/pathways";

export default ((value) => (Array.isArray(value) ? value : [value])) satisfies TransformFor<"json">;
```

`TransformFor<"json">` types the input from the format name in `channel.yaml`. Each record that is an
object, an array, a number or a boolean is written back as JSON, and a string is sent as it is. Each
one becomes a delivery of its own to every destination, and a file destination
names them `<message id>-1.json`, `<message id>-2.json` and so on.

## Transform or filter for one destination

A destination block may name a `transform:` of its own. It runs in the same worker, in the same pass,
after the channel's transform: once for each output the channel's transform returned, with that
output parsed in the channel's format. It returns what that destination gets, by the same rules
as the table above, so it can edit the message for one receiver, send it several, or route it away
from this destination with `null`.

```yaml title="channels/results-out/channel.yaml"
source:
  mllp: { port: 6661, plaintext: true }
transform: ./transform.ts
destinations:
  - name: ehr
    mllp: { host: ehr.example.test, port: 2575, plaintext: true }
  - name: billing
    file: { dir: ../../data/billing }
    transform: ./billing.ts
  - name: registry
    http: { url: "https://registry.example.test/results" }
    transform: ./registry.ts
    format: json
```

```ts runnable title="channels/results-out/billing.ts"
import type { Transform } from "@cosyte/pathways";

// Billing takes final results only; anything else is filtered for billing alone.
export default ((msg) => (msg.get("OBR.25") === "F" ? msg : null)) satisfies Transform;
```

```ts runnable title="channels/results-out/registry.ts"
import type { TransformFor } from "@cosyte/pathways";

// It reads the channel's hl7v2 and, with format: json, what it returns goes out as JSON.
export default ((msg, ctx) => ({
  destination: ctx?.destination?.name ?? null,
  control: msg.get("MSH.10") ?? null,
})) satisfies TransformFor<"hl7v2", "json">;
```

The destination's three keys:

| Key         | Meaning                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transform` | the destination's own transform module, relative to `channel.yaml`. Without one, the destination is sent the channel's outputs as they are.                                                                                   |
| `name`      | lowercase letters, digits and hyphens, unique in the channel. `pathways messages show` prints it beside the destination, and `pathways test` puts it in the expected file's name. Without one, its place in the list is used. |
| `format`    | the format the destination sends: what its transform's return is written in, the extension a `file` destination writes and the `Content-Type` an `http` destination sends. The channel's `format` by default.                 |

Each delivery records the destination it was made for: by its `name`, or, without one, by its kind
and target (a `file` destination's folder, or its bucket or container and prefix, an `http` destination's URL, an `mllp` or `tcp`
destination's host and port, an `smtp` destination's server and recipients, a `module` destination's module). Adding a destination anywhere in the
list, removing one or reordering them is safe: after a restart, each queued delivery goes to the
destination it was made for, and a resend or `pathways verify` reads each destination's own stored
outputs. A delivery queued for a destination the channel no longer has waits, and is logged at
start as `deliveries-held` with the code `destination-gone`; it is sent if that destination comes
back. A destination given a removed one's identity, its `name`, or without one its kind and target,
takes over that destination's pending deliveries and sends them. Renaming a destination, setting a `name` on one that had none, or changing the target of one
without a name makes it a new destination, so what was queued for it waits in the same way: give
each destination a `name` when you add it, and it stays the same destination when its URL, host or
folder changes.

Two destinations with no `name`, of the same kind and sending to the same place, would share one
identity, and nothing would tell their deliveries apart once one of them is removed or moved. So
`pathways validate` and a start refuse such a pair, naming both, as in
`destinations.2: sends where destinations.0 sends, and neither has a name:`; a `name` on either
one is enough. Two `module` destinations of one module with different `options` are such a pair.

Its context is the channel transform's, with `ctx.destination` beside it: the destination's `index`
(from 0), its `name` and its `kind` (`file`, `http`, `mllp`, `tcp`, `smtp` or `module`).

What each destination gets is recorded in one write with the message, so a destination's queue keeps
the order messages arrived in:

- **Outputs.** Each is a delivery of its own to that destination, as for a channel transform.
- **`null`.** That destination's delivery is recorded as `filtered` and nothing is sent to it. A
  `filtered` delivery is done, like a `delivered` one: the message counts as delivered once the other
  destinations have it, and retention treats it the same. When every destination filters a message,
  the message is stored as `filtered`.
- **A throw.** Only that destination's delivery fails, with the error's name, code and line stored
  and its text stored encrypted, never logged; the other destinations go on. Fix the transform and
  [replay the message](./inspect-replay-and-clear-messages.md).

The channel's `timeout` and `memory` cover the channel's transform and every destination's together,
as one pass. A pass that runs past the timeout, or runs out of memory, fails the whole message, as a
channel transform's would. A destination transform that will not load stops the channel's start, and
the error names the destination.

## Load a lookup table once

Module-level state lives as long as the channel's worker, so a table read on the first message
serves the ones after it. This transform maps a sender's local test codes in OBX-3 to LOINC codes,
from a `codes.json` beside it:

```ts runnable title="channels/results-to-ehr/transform.ts"
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Transform } from "@cosyte/pathways";

// Read once per worker, on the first message, then kept.
let table: Promise<Record<string, string>> | undefined;

async function loinc(): Promise<Record<string, string>> {
  const text = await readFile(join(import.meta.dirname, "codes.json"), "utf8");
  return JSON.parse(text) as Record<string, string>;
}

export default (async (msg) => {
  table ??= loinc();
  const codes = await table;
  for (let i = 0; i < msg.parts("OBX").length; i += 1) {
    const local = msg.get(`OBX[${i}].3.1`);
    const code = local === undefined ? undefined : codes[local];
    // An unknown code fails the message rather than sending a result the EHR cannot file.
    if (code === undefined) throw new Error("an OBX-3 code is not in codes.json");
    msg.setField(`OBX[${i}].3.1`, code);
    msg.setField(`OBX[${i}].3.3`, "LN");
  }
  return msg;
}) satisfies Transform;
```

```json title="channels/results-to-ehr/codes.json"
{ "GLU": "2345-7", "K": "2823-3" }
```

The worker is replaced after a message times out, runs out of memory or crashes it, and the table is
read again in the new one. A transform can also import any npm package the project installs.

## Run code when the worker starts and stops

A transform module may export `onStart` and `onStop` beside its default export. `onStart` runs in the
channel's worker before the worker takes its first message, and receives the channel's name, its
configuration (`ctx.config`, as each message's context holds it) and a logger. `onStop` runs in the
worker once its last message is done, before the worker ends. Both may be async.

```ts runnable title="channels/results-to-ehr/transform.ts"
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { OnStart, OnStop, Transform } from "@cosyte/pathways";

let codes: Record<string, string> = {};

// Runs in each new worker: loads the table, so the first message does not wait for it.
export const onStart: OnStart = async (ctx) => {
  const text = await readFile(join(import.meta.dirname, "codes.json"), "utf8");
  codes = JSON.parse(text) as Record<string, string>;
  ctx.logger.info("codes-loaded", { entries: Object.keys(codes).length });
};

export const onStop: OnStop = () => {
  codes = {};
};

export default ((msg) => {
  const local = msg.get("OBX.3.1");
  const code = local === undefined ? undefined : codes[local];
  if (code !== undefined) msg.setField("OBX.3.1", code);
  return msg;
}) satisfies Transform;
```

- **On every new worker.** `onStart` runs when the engine starts, on a
  [reload](./pause-stop-and-reload-a-channel.md), under `pathways test`, `pathways replay` and
  `pathways verify`, and again in the worker that replaces one after a message timed out, ran out of
  memory or crashed it. So it must be idempotent: safe to run again in a fresh worker, setting up
  anew what it needs and assuming nothing kept.
- **A failure is a load failure.** An `onStart` that throws, or runs past its limit, is treated as a
  transform that will not load. At engine start, the start stops and says which channel and why. On
  a reload, the reload is refused and the running transform kept. In a replacement worker, that
  channel stops (it takes no part in a pass, and the messages it holds wait), the
  [health endpoint](./check-status-and-health.md#serve-a-health-endpoint) answers 503 and says why,
  and the other channels run on; `pathways channel reload` loads it again.
- **`onStop` runs on every clean stop**: `SIGTERM` or `SIGINT` to `pathways start`, a reload for the
  worker it replaces, and the end of a command that ran the transform. A worker ended because a
  message ran past its timeout or crashed it runs no `onStop`. One that throws is logged as
  `on-stop-failed` by name and code, and the worker ends either way.
- **Limits.** Each has the channel's `scriptTimeout`, its transform `timeout` (5 seconds) unless
  set. `onStart` is timed from when it begins, not from the module's load. `onStop` past its limit is
  cut off, logged as `on-stop-timeout`, and the worker ends.
- **A logger that takes ids only.** `ctx.logger.info`, `warn` and `error` take a code of lower-case
  words joined by hyphens and numbers by name, and nothing else, so no message content, patient
  detail or secret reaches the log through them. Each line is a `channel-script` event with the
  channel's name. See [what is safe to log from a channel](./logs-and-codes.md#what-is-safe-to-log-from-a-channel).

```yaml title="channels/results-to-ehr/channel.yaml"
source:
  file: { dir: ../../data/results/in }
transform: ./transform.ts
scriptTimeout: 10s
destinations:
  - file: { dir: ../../data/results/out }
```

These scripts are your code, run with the worker's full Node.js access, as the transform is: see
[transforms in worker threads](./the-transform-worker.md#what-it-does-not-protect-against).

Pathways has no project-wide deploy script. To run something once a deployment is up, give
`pathways.yaml` a [hook](./add-lifecycle-hooks.md#run-a-step-when-the-engine-starts) on the
`engine-start` audit entry.

## Fail a message on purpose

Throwing is how a transform says a message cannot be handled. The message is stored as `failed`, with
the error's name, its `code` if it has one, and the line in the transform that threw; the next message
goes ahead. The error's own text is stored encrypted with the message and never logged, because it
can quote the message. Fix the transform, then [replay the message](./inspect-replay-and-clear-messages.md).

## Limits

- **Time.** A message's transform has 5 seconds by default (`timeout`). Past it, the worker is
  stopped, the message is marked failed, and a new worker takes the next message.
- **Memory.** Each channel's worker is capped at 256 MB by default (`memory`). A transform that runs
  out fails that message only.
- **Scripts.** `onStart` and `onStop` each have `scriptTimeout`, the transform's `timeout` unless set.
- **Syntax.** Node.js runs the file by stripping its types, with no build step, so syntax that needs
  compiling (enums, namespaces, parameter properties) is not available.

Set both limits per channel or for the project; see [Configure a channel](./configure-a-channel.md).

## Related

- [Test a channel](./test-a-channel.md), so a change to a transform shows in a pull request.
- [Handle FHIR, X12, C-CDA, JSON, CSV, XML and text](./work-with-formats.md): what each format hands a
  transform, and turning one format into another.
- [Transforms in worker threads](./the-transform-worker.md): why each channel has its own.
- Reference: [`Transform`](./api/README.md#transform), [`TransformFor`](./api/README.md#transformfor)
  and [`TransformOutput`](./api/README.md#transformoutput).
