---
id: transform-and-filter-messages
title: Transform and filter messages
sidebar_label: Transform and filter
description: "Write a channel's transform: edit a message, filter it out, send several outputs, load a lookup table, and fail a message on purpose."
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
  channel's name.

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
- [Handle FHIR, X12, C-CDA, JSON, CSV and text](./work-with-formats.md): what each format hands a
  transform, and turning one format into another.
- [Transforms in worker threads](./the-transform-worker.md): why each channel has its own.
- Reference: [`Transform`](./api/README.md#transform), [`TransformFor`](./api/README.md#transformfor)
  and [`TransformOutput`](./api/README.md#transformoutput).
