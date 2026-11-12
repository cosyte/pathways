---
id: example-filter-and-route
title: "Example: filter, then send to two destinations"
sidebar_label: Filter and send to two
description: "A runnable project: keep only final lab results, and send each to two destinations, the EHR and an archive, each with a queue of its own."
---

# Example: filter, then send to two destinations

A project with one channel, `results-out`, that reads HL7 v2 files from a folder, keeps the lab
results whose every observation is final, addresses each to the EHR, and sends it to two
destinations: the EHR's inbound folder and an archive. It is in
[`examples/filter-and-route`](https://github.com/cosyte/pathways/tree/main/examples/filter-and-route),
with its synthetic test messages, and CI runs its tests and the pass below on every change.

## What it shows

- A transform that filters on the content of each message: the message type, then each OBX-11
  result status. A filtered message is stored as `filtered` and sent nowhere.
- A channel with two destinations. Each output goes to every destination, and each destination keeps
  a queue of its own, in order: when the EHR's folder cannot be written, the archive goes on. See
  [How delivery and errors work](./delivery-and-errors.md).

Each output goes to every destination of its channel. To send different messages to different
systems, give each system a channel of its own, each with its own filter.

## Run it

You need Node.js 24 or later. Copy the folder, then in it:

```bash
npm install
npm run key
npm test
```

`npm run key` writes a development key to `.pathways/dev.key`, which `pathways.yaml` names.
`npm test` runs the channel's tests, shown under [Expected output](#expected-output).

Drop a final result, a preliminary one and an admission into the channel's folder, then run one
pass and exit:

```bash
mkdir -p data/results-out/in
cd channels/results-out/tests
cp -p adt.hl7 final.hl7 preliminary.hl7 ../../../data/results-out/in/
cd ../../..
npx pathways start --once
npx pathways status
```

`cp -p` keeps each file's time, so it is already older than the 1 second a file source waits for a
file to stop changing. Files are taken by name, so the final result is message 2, and it is written
to both folders as `data/results-out/ehr/2-1.hl7` and `data/results-out/archive/2-1.hl7`, each
matching `channels/results-out/tests/final.expected.hl7`. The admission and the preliminary result
are filtered:

```text
results-out: ok
  messages: 0 received, 1 transformed, 2 filtered, 0 failed, 0 cleared
  deliveries: 0 pending (0 retrying), 2 delivered, 0 failed, 0 cleared
```

One message, two deliveries: one to each destination.

## Expected output

What `pathways test` prints, which `npm test` runs, as the example's README gives it. This section and the next are generated from the example by `scripts/example-pages.ts`, and CI fails when they no longer match it.

```text
PASS results-out/tests/adt.hl7
PASS results-out/tests/final.hl7
PASS results-out/tests/preliminary.hl7
3 passed, 0 failed
```

## Files

Every file of `examples/filter-and-route/` but its README and git settings: [filter-and-route on GitHub](https://github.com/cosyte/pathways/tree/main/examples/filter-and-route).

Its messages are synthetic, made by `@cosyte/synth`, and are on GitHub with the rest: in `channels/results-out/tests/`, `adt.hl7`, `final.hl7`, `preliminary.hl7`. Each input in a `tests/` folder has its expected output beside it.

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

### channels/results-out/channel.yaml

```yaml title="channels/results-out/channel.yaml"
# yaml-language-server: $schema=../../node_modules/@cosyte/pathways/schema/channel.json

# Read HL7 v2 files from a folder, keep the final lab results, and send each to two destinations:
# the EHR's inbound folder and an archive.
name: results-out
format: hl7v2

source:
  file:
    dir: ../../data/results-out/in

transform: ./transform.ts

# Each output goes to every destination, and each destination keeps a queue of its own, in order:
# when one is down, only its own messages wait.
destinations:
  - file:
      dir: ../../data/results-out/ehr
  - file:
      dir: ../../data/results-out/archive
```

### channels/results-out/transform.ts

```ts runnable title="channels/results-out/transform.ts"
// Keeps lab results whose every observation is final, and addresses each to the EHR. Any other
// message, and a result with a preliminary or corrected observation, is filtered out.
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  const observations = msg.parts("OBX").length;
  if (!msg.is("ORU^R01") || observations === 0) return null;
  for (let i = 0; i < observations; i += 1) {
    // OBX-11 is the observation's result status: F for final.
    if (msg.get(`OBX[${String(i)}].11`) !== "F") return null;
  }
  // MSH-5 and MSH-6 are the receiving application and facility.
  msg.setField("MSH.5", "EHR");
  msg.setField("MSH.6", "HOSPITAL");
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
