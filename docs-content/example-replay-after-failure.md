---
id: example-replay-after-failure
title: "Example: replay after a failure"
sidebar_label: Replay after a failure
description: "A runnable project: a message fails because a code table is missing an entry, waits stored, and is replayed and delivered once the table is fixed."
---

# Example: replay after a failure

A project with one channel, `adt-to-registry`, that reads HL7 v2 ADT files from a folder, gives each
the registry's code for its event from a table, and writes it to the registry's inbound folder. An
update arrives whose event the table has no code for: its transform fails, the message waits, stored
and encrypted, and once the table has the code a replay delivers it. It is in
[`examples/replay-after-failure`](https://github.com/cosyte/pathways/tree/main/examples/replay-after-failure),
with its synthetic messages, and CI runs its tests and the pass below on every change.

## What it shows

- A transform that [fails a message on purpose](./transform-and-filter-messages.md#fail-a-message-on-purpose)
  rather than send one the receiver cannot file, and the next message goes ahead.
- A lookup table read once per worker, from a JSON file beside the transform: see
  [load a lookup table once](./transform-and-filter-messages.md#load-a-lookup-table-once).
- `pathways status`, then a [bulk replay](./inspect-replay-and-clear-messages.md#replay-every-failed-message-at-once)
  of every failed message of the channel, once the cause is fixed.

## Run it

You need Node.js 24 or later. Copy the folder, then in it:

```bash
npm install
npm run key
npm test
```

`npm run key` writes a development key to `.pathways/dev.key`, which `pathways.yaml` names.
`npm test` runs the channel's tests, shown under [Expected output](#expected-output).

Drop an admission, a registration and an update into the channel's folder, then run one pass and
exit:

```bash
mkdir -p data/adt-to-registry/in
cp -p channels/adt-to-registry/tests/a01.hl7 channels/adt-to-registry/tests/a04.hl7 samples/a08.hl7 data/adt-to-registry/in/
npx pathways start --once
npx pathways status
```

`cp -p` keeps each file's time, so it is already older than the 1 second a file source waits for a
file to stop changing. Files are taken by name: the admission and the registration, messages 1 and 2,
are delivered to `data/adt-to-registry/out/`, and the update, message 3, failed, since
`event-codes.json` has no code for `A08`:

```text
adt-to-registry: failed
  messages: 0 received, 2 transformed, 0 filtered, 1 failed, 0 cleared
  deliveries: 0 pending (0 retrying), 2 delivered, 0 failed, 0 cleared
  failed: message 3, since 2026-11-12T08:29:11.112Z
```

The engine logged `transform-failed` with the error's name and the line in the transform that threw,
never the message or the error's text. `npx pathways messages show 3` shows the same. Fix the cause:
give `A08` a code in `channels/adt-to-registry/event-codes.json`:

```json title="channels/adt-to-registry/event-codes.json"
{
  "A01": "ADMIT",
  "A04": "REGISTER",
  "A08": "UPDATE"
}
```

Then replay every failed message of the channel, and run a pass to deliver it:

```bash
npx pathways replay --status failed --channel adt-to-registry --yes
npx pathways start --once
```

The replay runs each message through the transform as it is now, and queues its delivery:

```text
1 failed messages to replay:
  channel: adt-to-registry
  ids up to 3
  unchanged since 2026-11-12T08:29:19.466Z; one changed later is skipped
batch 1: messages 3 to 3: 1 replayed, 0 failed again, 0 refused, 0 skipped
Run 8: 1 replayed, 0 failed again, 0 refused, 0 skipped of 1.
```

The update is now `data/adt-to-registry/out/3-1.hl7`, with `UPDATE` in EVN-4, and
`npx pathways status` reads `ok`. A replay before the fix counts the message as failed again, and it stays failed.
Each replay is in the audit log, under the run's id.

## Expected output

What `pathways test` prints, which `npm test` runs, as the example's README gives it. This section and the next are generated from the example by `scripts/example-pages.ts`, and CI fails when they no longer match it.

```text
PASS adt-to-registry/tests/a01.hl7
PASS adt-to-registry/tests/a04.hl7
2 passed, 0 failed
```

## Files

Every file of `examples/replay-after-failure/` but its README and git settings: [replay-after-failure on GitHub](https://github.com/cosyte/pathways/tree/main/examples/replay-after-failure).

Its messages are synthetic, made by `@cosyte/synth`, and are on GitHub with the rest: in `channels/adt-to-registry/tests/`, `a01.hl7`, `a04.hl7`; in `samples/`, `a08.hl7`. Each input in a `tests/` folder has its expected output beside it.

### package.json

```json title="package.json"
{
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "key": "node scripts/dev-key.ts",
    "start": "pathways start",
    "test": "pathways test"
  },
  "devDependencies": {
    "@cosyte/pathways": "^0.0.5"
  }
}
```

### channels/adt-to-registry/channel.yaml

```yaml title="channels/adt-to-registry/channel.yaml"
# yaml-language-server: $schema=../../node_modules/@cosyte/pathways/schema/channel.json

# Read HL7 v2 ADT files from a folder, give each the registry's code for its event, and write it to
# the registry's inbound folder. An event with no code fails, and waits, stored, for a replay.
name: adt-to-registry
format: hl7v2

source:
  file:
    dir: ../../data/adt-to-registry/in

transform: ./transform.ts

destinations:
  - file:
      dir: ../../data/adt-to-registry/out
```

### channels/adt-to-registry/event-codes.json

```json title="channels/adt-to-registry/event-codes.json"
{
  "A01": "ADMIT",
  "A04": "REGISTER"
}
```

### channels/adt-to-registry/transform.ts

```ts runnable title="channels/adt-to-registry/transform.ts"
// Gives each ADT message the registry's code for its event, from event-codes.json beside this file,
// in EVN-4. An event the table has no code for fails the message: it is stored as failed, sent
// nowhere, and waits for a replay once the table has the code.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Transform } from "@cosyte/pathways";

// Read once per worker, on the first message, then kept. A replay runs in a new worker, which reads
// the table as it is then.
let table: Promise<Readonly<Record<string, string>>> | undefined;

async function eventCodes(): Promise<Readonly<Record<string, string>>> {
  const text = await readFile(join(import.meta.dirname, "event-codes.json"), "utf8");
  return JSON.parse(text) as Record<string, string>;
}

export default (async (msg) => {
  table ??= eventCodes();
  const codes = await table;
  // MSH-9.2 is the trigger event, such as A01.
  const code = codes[msg.get("MSH.9.2") ?? ""];
  if (code === undefined) throw new Error("MSH-9.2 is not in event-codes.json");
  msg.setField("EVN.4", code);
  msg.setField("MSH.5", "REGISTRY");
  return msg;
}) satisfies Transform;
```

### pathways.yaml

```yaml title="pathways.yaml"
# yaml-language-server: $schema=./node_modules/@cosyte/pathways/schema/project.json

# Messages are stored in SQLite under .pathways/, each encrypted with the development key that
# `npm run key` writes there. .gitignore keeps the folder out of git.
storage:
  sqlite:
    file: .pathways/pathways.db
encryption:
  keys:
    - id: dev
      file: .pathways/dev.key
  current: dev
```

### scripts/dev-key.ts

```ts title="scripts/dev-key.ts" no-run a script of the example, which test/examples.test.ts runs
// `npm run key`: writes a development master key to .pathways/dev.key, the file pathways.yaml
// names, unless one is there already. A key is 32 random bytes in base64, readable by this user
// only. .gitignore keeps .pathways/ out of git. A key for real messages comes from a secret store,
// never from a file made like this one.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const KEY_FILE = ".pathways/dev.key";

mkdirSync(".pathways", { recursive: true, mode: 0o700 });
try {
  // "wx" refuses a file that exists, so a key that has encrypted messages is never replaced.
  writeFileSync(KEY_FILE, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`wrote ${KEY_FILE}\n`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  process.stdout.write(`${KEY_FILE} is there already\n`);
}
```
