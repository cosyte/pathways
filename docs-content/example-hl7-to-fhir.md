---
id: example-hl7-to-fhir
title: "Example: HL7 v2 to FHIR"
sidebar_label: HL7 v2 to FHIR
description: "A runnable project: turn each HL7 v2 admission, registration and update into a FHIR R4 Patient and POST it to a FHIR server, with a stand-in server to try it."
---

# Example: HL7 v2 to FHIR

A project with one channel, `adt-to-fhir`, that reads HL7 v2 files from a folder, turns each
admission, registration and update into a FHIR R4 Patient, and POSTs it as JSON to a FHIR server. A
lab result in the same folder is filtered out. It is in
[`examples/hl7-to-fhir`](https://github.com/cosyte/pathways/tree/main/examples/hl7-to-fhir), with its
synthetic test messages, and CI runs its tests and the pass below on every change, and checks each
Patient with `@cosyte/fhir`'s validator.

## What it shows

- A transform that takes one format in and sends another out: see
  [turn one format into another](./work-with-formats.md#turn-one-format-into-another).
- Fields read from the parsed message (`PID-3`, `PID-5`, `PID-7`, `PID-8`) and mapped to FHIR, with
  a value table for administrative sex.
- An [HTTP destination](./send-and-receive-http.md#send-each-output-to-a-url) whose `Content-Type`
  is set for what goes out, since the channel's format names what comes in.
- Tests whose expected output is JSON: an input's expected file keeps its extension, so the expected
  output of `a01.hl7` is `a01.expected.hl7`.

The receiver runs plain HTTP on the loopback (`plaintext: true`), for this example only. A FHIR
server is an `https://` URL, and one that needs a token reads it from the environment: see
[Send and receive messages over HTTP](./send-and-receive-http.md).

## Run it

You need Node.js 24 or later. Copy the folder, then in it:

```bash
npm install
npm run key
npm test
```

`npm run key` writes a development key to `.pathways/dev.key`, which `pathways.yaml` names.
`npm test` runs the channel's tests, shown under [Expected output](#expected-output).

Start the stand-in FHIR server in a second terminal. It listens on port 8080 and writes each
request's body to `data/receiver/`:

```bash
npm run receiver
```

Back in the first, drop an admission and a lab result into the channel's folder, then run one pass
and exit:

```bash
mkdir -p data/adt-to-fhir/in
cp -p channels/adt-to-fhir/tests/a01.hl7 channels/adt-to-fhir/tests/oru.hl7 data/adt-to-fhir/in/
npx pathways start --once
```

`cp -p` keeps each file's time, so it is already older than the 1 second a file source waits for a
file to stop changing. The receiver gets one POST, the Patient, and prints its size, never its
content:

```text
POST /fhir/Patient application/fhir+json: 286 bytes to data/receiver/1.json
```

`data/receiver/1.json` matches `channels/adt-to-fhir/tests/a01.expected.hl7`. Set `FHIR_URL` to
send to your own server, and `RECEIVER_PORT` when 8080 is taken.

## Expected output

What `pathways test` prints, which `npm test` runs, as the example's README gives it. This section and the next are generated from the example by `scripts/example-pages.ts`, and CI fails when they no longer match it.

```text
PASS adt-to-fhir/tests/a01.hl7
PASS adt-to-fhir/tests/a04.hl7
PASS adt-to-fhir/tests/oru.hl7
3 passed, 0 failed
```

## Files

Every file of `examples/hl7-to-fhir/` but its README and git settings: [hl7-to-fhir on GitHub](https://github.com/cosyte/pathways/tree/main/examples/hl7-to-fhir).

Its messages are synthetic, made by `@cosyte/synth`, and are on GitHub with the rest: in `channels/adt-to-fhir/tests/`, `a01.hl7`, `a04.hl7`, `oru.hl7`. Each input in a `tests/` folder has its expected output beside it.

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
    "start": "pathways start",
    "test": "pathways test"
  },
  "devDependencies": {
    "@cosyte/pathways": "^0.0.4"
  }
}
```

### channels/adt-to-fhir/channel.yaml

```yaml title="channels/adt-to-fhir/channel.yaml"
# yaml-language-server: $schema=../../node_modules/@cosyte/pathways/schema/channel.json

# Read HL7 v2 files from a folder, turn each admission, registration and update into a FHIR Patient,
# and POST it to a FHIR server.
name: adt-to-fhir

# What comes in: the transform receives each message parsed by @cosyte/hl7.
format: hl7v2

source:
  file:
    dir: ../../data/adt-to-fhir/in

transform: ./transform.ts

destinations:
  - http:
      url: { env: FHIR_URL, default: "http://127.0.0.1:8080/fhir/Patient" }
      headers:
        # The channel's format names what comes in, so set the type of what goes out.
        Content-Type: application/fhir+json
      # The receiver in scripts/receiver.ts answers plain HTTP on the loopback. A FHIR server is
      # an https:// URL, which needs no plaintext line.
      plaintext: true
      # The receiver is on this machine, an address the destination refuses unless it is named
      # here. A real endpoint on the public internet needs no allowNetworks line; one on a private
      # network, such as 10.20.0.0/16, needs that network named here.
      allowNetworks: [127.0.0.1]
```

### channels/adt-to-fhir/transform.ts

```ts runnable title="channels/adt-to-fhir/transform.ts"
// Turns each admission, registration and update into a FHIR R4 Patient, as JSON. Every other
// message is filtered out.
import type { Transform } from "@cosyte/pathways";

// PID-8, administrative sex, as FHIR's administrative-gender codes.
const GENDER: Readonly<Record<string, string>> = {
  F: "female",
  M: "male",
  O: "other",
  U: "unknown",
};

/** An HL7 v2 date or time (YYYYMMDD...) as a FHIR date (YYYY-MM-DD), or undefined. */
function fhirDate(value: string | undefined): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value ?? "");
  return match === null ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
}

export default ((msg) => {
  if (!msg.is("ADT^A01") && !msg.is("ADT^A04") && !msg.is("ADT^A08")) return null;
  const patient = {
    resourceType: "Patient",
    // PID-3: the medical record number, and the authority that assigned it.
    identifier: [
      {
        type: {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" }],
        },
        value: msg.get("PID.3.1"),
        assigner: { display: msg.get("PID.3.4") },
      },
    ],
    // PID-5: family name, then given name.
    name: [{ family: msg.get("PID.5.1"), given: [msg.get("PID.5.2")] }],
    gender: GENDER[msg.get("PID.8") ?? ""],
    birthDate: fhirDate(msg.get("PID.7")),
  };
  // A key whose value is undefined is left out of the JSON.
  return JSON.stringify(patient);
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
