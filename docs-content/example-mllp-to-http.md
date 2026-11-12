---
id: example-mllp-to-http
title: "Example: HL7 v2 over MLLP in, HTTP out"
sidebar_label: MLLP in, HTTP out
description: "A runnable project: listen for HL7 v2 over MLLP, keep the ADT messages, and POST each to an HTTP endpoint, with a stand-in receiver and a sender to try it."
---

# Example: HL7 v2 over MLLP in, HTTP out

A project with one channel, `adt-to-http`, that listens for HL7 v2 over MLLP, keeps the admissions,
registrations and updates, addresses each to the EHR, and POSTs it to an HTTP endpoint. A lab result
on the same feed is acknowledged and filtered out. It is in
[`examples/mllp-to-http`](https://github.com/cosyte/pathways/tree/main/examples/mllp-to-http), with
its synthetic test messages, and CI runs its tests and the pass below on every change.

## What it shows

- An [MLLP source](./send-and-receive-mllp.md) that stores each message before it sends the ACK.
- A transform that filters by message type and edits the header.
- An [HTTP destination](./send-and-receive-http.md#post-each-output-to-a-url) that POSTs each output.
- Ports and URLs read from the environment, with defaults, so one YAML runs on every machine: see
  [settings from the environment](./configuration-reference.md#settings-from-the-environment).
- Two small scripts to try it with no other system: `scripts/receiver.ts` stands in for the EHR, and
  `scripts/send.ts` sends files over MLLP.

Both ends run plain TCP and HTTP on the loopback (`plaintext: true`), for this example only. A
sender on another machine connects over TLS, and a real endpoint is an `https://` URL: see
[Secure endpoints](./secure-endpoints.md).

## Run it

You need Node.js 24 or later. Copy the folder, then in it:

```bash
npm install
npm run key
npm test
```

`npm run key` writes a development key to `.pathways/dev.key`, which `pathways.yaml` names;
`.gitignore` keeps that folder out of git. `npm test` runs the channel's tests, shown under
[Expected output](#expected-output).

Then use three terminals in the same folder. Start the receiver, which listens on port 8080 and
writes each request's body to `data/receiver/`:

```bash
npm run receiver
```

Start the engine, which listens for MLLP on port 2575:

```bash
npm start
```

Send an admission and a lab result:

```bash
npm run send -- channels/adt-to-http/tests/a01.hl7 channels/adt-to-http/tests/oru.hl7
```

Each message is stored, then acknowledged:

```text
channels/adt-to-http/tests/a01.hl7: AA
channels/adt-to-http/tests/oru.hl7: AA
```

The receiver gets one POST, the admission addressed to `SYNTH-EHR`, and writes it to
`data/receiver/1.hl7`; the lab result was filtered out. It prints the size, never the content:

```text
POST /adt application/hl7-v2: 283 bytes to data/receiver/1.hl7
```

`data/receiver/1.hl7` matches `channels/adt-to-http/tests/a01.expected.hl7`. Stop the engine and the
receiver with Ctrl+C. `npx pathways status` counts one delivered and one filtered. `MLLP_PORT`,
`RECEIVER_PORT` and `RECEIVER_URL` move the ports when 2575 or 8080 is taken.

## Expected output

What `pathways test` prints, which `npm test` runs, as the example's README gives it. This section and the next are generated from the example by `scripts/example-pages.ts`, and CI fails when they no longer match it.

```text
PASS adt-to-http/tests/a01.hl7
PASS adt-to-http/tests/a08.hl7
PASS adt-to-http/tests/oru.hl7
3 passed, 0 failed
```

## Files

Every file of `examples/mllp-to-http/` but its README and git settings: [mllp-to-http on GitHub](https://github.com/cosyte/pathways/tree/main/examples/mllp-to-http).

Its messages are synthetic, made by `@cosyte/synth`, and are on GitHub with the rest: in `channels/adt-to-http/tests/`, `a01.hl7`, `a08.hl7`, `oru.hl7`. Each input in a `tests/` folder has its expected output beside it.

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
    "receiver": "node scripts/receiver.ts",
    "send": "node scripts/send.ts",
    "start": "pathways start",
    "test": "pathways test"
  },
  "devDependencies": {
    "@cosyte/pathways": "^0.0.3"
  }
}
```

### channels/adt-to-http/channel.yaml

```yaml title="channels/adt-to-http/channel.yaml"
# yaml-language-server: $schema=../../node_modules/@cosyte/pathways/schema/channel.json

# Take HL7 v2 over MLLP, keep the ADT messages, address each to the EHR, and POST it there.
name: adt-to-http
format: hl7v2

source:
  mllp:
    # This machine only, on port 2575 unless MLLP_PORT names another.
    host: 127.0.0.1
    port: { env: MLLP_PORT, default: 2575 }
    # Plain TCP on the loopback, for this example only. A sender on another machine connects over
    # TLS: give the source tls: { cert, key, ca } in place of this line.
    plaintext: true

transform: ./transform.ts

destinations:
  - http:
      url: { env: RECEIVER_URL, default: "http://127.0.0.1:8080/adt" }
      # The receiver in scripts/receiver.ts answers plain HTTP on the loopback. A real endpoint is
      # an https:// URL, which needs no plaintext line.
      plaintext: true
```

### channels/adt-to-http/transform.ts

```ts runnable title="channels/adt-to-http/transform.ts"
// Keeps admissions, registrations and updates, and addresses each to the EHR. Every other message,
// such as a lab result on the same feed, is filtered out: stored, acknowledged, and sent nowhere.
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  if (!msg.is("ADT^A01") && !msg.is("ADT^A04") && !msg.is("ADT^A08")) return null;
  // MSH-5 and MSH-6 are the receiving application and facility.
  msg.setField("MSH.5", "SYNTH-EHR");
  msg.setField("MSH.6", "SYNTH-HOSP");
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

### scripts/receiver.ts

```ts title="scripts/receiver.ts" no-run a script of the example, which test/examples.test.ts runs
// `npm run receiver`: a stand-in for the system the channel POSTs to. It listens on 127.0.0.1, port
// 8080 unless RECEIVER_PORT names another, writes each request's body to data/receiver/ as a file
// of its own, and answers 200. It prints the file's name and size, never what is in it.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const OUT = "data/receiver";
const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/hl7-v2": "hl7",
  "application/fhir+json": "json",
};

let received = 0;
mkdirSync(OUT, { recursive: true });

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    received += 1;
    const type = (request.headers["content-type"] ?? "").split(";")[0] ?? "";
    const file = `${OUT}/${String(received)}.${EXTENSIONS[type] ?? "txt"}`;
    const body = Buffer.concat(chunks);
    writeFileSync(file, body);
    process.stdout.write(
      `${String(request.method)} ${String(request.url)} ${type}: ${String(body.length)} bytes to ${file}\n`,
    );
    response.writeHead(200).end();
  });
});

const port = Number(process.env["RECEIVER_PORT"] ?? 8080);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening on http://127.0.0.1:${String(port)}\n`);
});
```

### scripts/send.ts

```ts title="scripts/send.ts" no-run a script of the example, which test/examples.test.ts runs
// `npm run send -- <file...>`: sends each HL7 v2 file to the channel's MLLP source on 127.0.0.1,
// port 2575 unless MLLP_PORT names another, one at a time on one connection, and prints the code of
// the ACK each draws: AA once the message is stored.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

// MLLP frames each message as a vertical tab, the message, then a file separator and a carriage return.
const START = Buffer.of(0x0b);
const END = Buffer.of(0x1c, 0x0d);

const port = Number(process.env["MLLP_PORT"] ?? 2575);
const socket = connect({ host: "127.0.0.1", port });
socket.setTimeout(10_000, () => socket.destroy(new Error("no ACK within 10 seconds")));

let buffered = Buffer.alloc(0);
const waiting: ((frame: string) => void)[] = [];
socket.on("data", (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (let end = buffered.indexOf(END); end !== -1; end = buffered.indexOf(END)) {
    const frame = buffered.subarray(buffered.indexOf(START) + 1, end).toString("latin1");
    buffered = buffered.subarray(end + END.length);
    waiting.shift()?.(frame);
  }
});

/** Sends one message and resolves with the ACK it draws. */
function exchange(message: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    waiting.push((frame) => {
      socket.off("error", reject);
      resolve(frame);
    });
    socket.write(Buffer.concat([START, message, END]));
  });
}

for (const file of process.argv.slice(2)) {
  const ack = await exchange(readFileSync(file));
  // MSA-1 is the acknowledgment code.
  const msa = ack.split("\r").find((segment) => segment.startsWith("MSA|"));
  process.stdout.write(`${file}: ${msa?.split("|")[1] ?? "no MSA segment"}\n`);
}
socket.end();
```
