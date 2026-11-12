---
id: example-vet-lab-to-fhir
title: "Example: a veterinary lab result to FHIR"
sidebar_label: A veterinary lab result to FHIR
description: "A runnable project: take a veterinary lab result over MLLP, turn it into a FHIR Bundle that keeps the animal's species and breed, and POST it to a FHIR server."
---

# Example: a veterinary lab result to FHIR

A project with one channel, `vet-results-to-fhir`, that listens for HL7 v2 over MLLP, turns each
veterinary lab result (`ORU^R01`) into a FHIR R4 message Bundle with
[`@cosyte/transform`](https://docs.cosyte.com/transform), and POSTs it to a FHIR server. The
animal's species and breed go into the Patient's `patient-animal` extension, and the transform checks
that they did. An admission on the same feed is acknowledged and filtered out. It is in
[`examples/vet-lab-to-fhir`](https://github.com/cosyte/pathways/tree/main/examples/vet-lab-to-fhir),
with its synthetic test messages, and CI runs its tests and the pass below on every change.
[Route a veterinary lab result](./route-a-veterinary-lab-result.md) says what this shows about a
real veterinary feed, and what it does not.

## What it shows

- An [MLLP source](./send-and-receive-mllp.md) that stores each message before it sends the ACK.
- A transform that reads the species (PID-35) and breed (PID-36) by name, as `msg.patient.species`
  and `msg.patient.breed` from `@cosyte/hl7`, and accepts one exact shape: one PID, a control id in
  MSH-10, one species as a plain code and a plain coding system, and no breed or one breed of the
  same shape. It fails every other result, one with no species or a second patient among them,
  rather than send it on in part or as another patient's.
- `toFhir` from `@cosyte/transform`, which turns the result into a message Bundle: a
  `MessageHeader`, the `Patient` with the `patient-animal` extension, the owner as a
  `RelatedPerson`, and an `Observation` for each result.
- Entry ids made from the message's control id, so the same message always gives the same Bundle:
  `pathways test` compares it byte for byte, and a replay sends what the first pass sent.
- An [HTTP destination](./send-and-receive-http.md#send-each-output-to-a-url) that POSTs each Bundle
  as `application/fhir+json`.
- Two small scripts to try it with no other system: `scripts/receiver.ts` stands in for the FHIR
  server, and `scripts/send.ts` sends files over MLLP.

Both ends run plain TCP and HTTP on the loopback (`plaintext: true`), for this example only. A lab
on another machine connects over TLS, and a FHIR server is an `https://` URL: see
[Secure endpoints](./secure-endpoints.md).

## Run it

You need Node.js 24 or later. Copy the folder, then in it:

```bash
npm install
npm run key
npm test
```

`npm install` installs `@cosyte/transform` and `@cosyte/fhir`, which the transform imports, beside
Pathways. `npm run key` writes a development key to `.pathways/dev.key`, which `pathways.yaml` names;
`.gitignore` keeps that folder out of git. `npm test` runs the channel's tests, shown under
[Expected output](#expected-output): the lab result gives the Bundle in `oru.expected.hl7`, and the
admission gives nothing.

Then use three terminals in the same folder. Start the receiver, which listens on port 8080 and
writes each request's body to `data/receiver/`:

```bash
npm run receiver
```

Start the engine, which listens for MLLP on port 2575:

```bash
npm start
```

Send a lab result for a cat and an admission:

```bash
npm run send -- channels/vet-results-to-fhir/tests/oru.hl7 channels/vet-results-to-fhir/tests/adt.hl7
```

Each message is stored, then acknowledged:

```text
channels/vet-results-to-fhir/tests/oru.hl7: AA
channels/vet-results-to-fhir/tests/adt.hl7: AA
```

The receiver gets one POST, the lab result as a FHIR Bundle, and writes it to
`data/receiver/1.json`; the admission was filtered out. It prints the size, never the content:

```text
POST /fhir/$process-message application/fhir+json: 2690 bytes to data/receiver/1.json
```

`data/receiver/1.json` matches `channels/vet-results-to-fhir/tests/oru.expected.hl7`. Its Patient
carries the species and breed the lab sent:

```json
{
  "url": "http://hl7.org/fhir/StructureDefinition/patient-animal",
  "extension": [
    {
      "url": "species",
      "valueCodeableConcept": { "coding": [{ "code": "CAT", "display": "Cat" }] }
    },
    {
      "url": "breed",
      "valueCodeableConcept": { "coding": [{ "code": "CAT-DSH", "display": "Domestic Shorthair" }] }
    }
  ]
}
```

Stop the engine and the receiver with Ctrl+C. `npx pathways status` counts one delivered and one
filtered. `MLLP_PORT`, `RECEIVER_PORT` and `FHIR_URL` move the ports and the URL when 2575 or 8080
is taken.

## Expected output

What `pathways test` prints, which `npm test` runs, as the example's README gives it. This section and the next are generated from the example by `scripts/example-pages.ts`, and CI fails when they no longer match it.

```text
PASS vet-results-to-fhir/tests/adt.hl7
PASS vet-results-to-fhir/tests/oru.hl7
2 passed, 0 failed
```

## Files

Every file of `examples/vet-lab-to-fhir/` but its README and git settings: [vet-lab-to-fhir on GitHub](https://github.com/cosyte/pathways/tree/main/examples/vet-lab-to-fhir).

Its messages are synthetic, made by `@cosyte/synth`, and are on GitHub with the rest: in `channels/vet-results-to-fhir/tests/`, `adt.hl7`, `oru.hl7`. Each input in a `tests/` folder has its expected output beside it.

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
  "dependencies": {
    "@cosyte/fhir": "^0.1.12",
    "@cosyte/transform": "^0.2.4"
  },
  "devDependencies": {
    "@cosyte/pathways": "^0.0.3"
  }
}
```

### channels/vet-results-to-fhir/channel.yaml

```yaml title="channels/vet-results-to-fhir/channel.yaml"
# yaml-language-server: $schema=../../node_modules/@cosyte/pathways/schema/channel.json

# Take veterinary lab results as HL7 v2 over MLLP, turn each into a FHIR message Bundle that keeps
# the animal's species and breed, and POST it to a FHIR server.
name: vet-results-to-fhir

# What comes in: the transform receives each message parsed by @cosyte/hl7.
format: hl7v2

source:
  mllp:
    # This machine only, on port 2575 unless MLLP_PORT names another.
    host: 127.0.0.1
    port: { env: MLLP_PORT, default: 2575 }
    # Plain TCP on the loopback, for this example only. A lab on another machine connects over
    # TLS: give the source tls: { cert, key, ca } in place of this line.
    plaintext: true

transform: ./transform.ts

destinations:
  - http:
      # A FHIR server takes a message Bundle at its $process-message operation.
      url: { env: FHIR_URL, default: "http://127.0.0.1:8080/fhir/$process-message" }
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

### channels/vet-results-to-fhir/transform.ts

```ts runnable title="channels/vet-results-to-fhir/transform.ts"
// Turns each veterinary lab result (ORU^R01) into a FHIR R4 message Bundle with @cosyte/transform,
// keeping the animal's species and breed, and filters every other message out. A result fails
// unless it has one header, one patient, no patient or visit segment after its first order, a
// control id, one plain coded species and no breed or one plain coded breed: one exact shape is
// accepted, and everything else fails rather than going on in part.
import { createHash } from "node:crypto";

import { serializeResource } from "@cosyte/fhir";
import type { Transform } from "@cosyte/pathways";
import { toFhir } from "@cosyte/transform";

/** The FHIR R4 core extension that carries an animal patient's species and breed. */
const PATIENT_ANIMAL = "http://hl7.org/fhir/StructureDefinition/patient-animal";

/**
 * The ids of the Bundle's entries, made from the message's control id (MSH-10) and a count, each
 * shaped as a UUID: the same message always gives the same Bundle, so a replay sends what the
 * first pass sent, and `pathways test` can compare it byte for byte.
 */
function idsFor(controlId: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    const hex = createHash("sha256")
      .update(`${controlId}/${String(count)}`)
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
}

/** The code of one part (`species` or `breed`) of the Patient's patient-animal extension. */
function animalPart(bundle: string, part: "species" | "breed"): string | undefined {
  interface Coded {
    readonly url: string;
    readonly valueCodeableConcept?: { readonly coding?: readonly { readonly code?: string }[] };
  }
  interface Entry {
    readonly resource?: {
      readonly resourceType?: string;
      readonly extension?: readonly { readonly url: string; readonly extension?: Coded[] }[];
    };
  }
  const { entry = [] } = JSON.parse(bundle) as { readonly entry?: readonly Entry[] };
  const patient = entry.find((each) => each.resource?.resourceType === "Patient")?.resource;
  const animal = patient?.extension?.find((each) => each.url === PATIENT_ANIMAL);
  const coded = animal?.extension?.find((each) => each.url === part);
  return coded?.valueCodeableConcept?.coding?.[0]?.code;
}

/** The segments of an ORU^R01's patient and visit, which come before its first order (OBR). */
const PATIENT_OR_VISIT: ReadonlySet<string> = new Set(["PID", "PD1", "NK1", "PV1", "PV2"]);

/** The message a transform is given: an HL7 v2 message parsed by @cosyte/hl7. */
type Message = Parameters<Transform>[0];

/** One field of a segment, as @cosyte/hl7 reads it. */
type Field = ReturnType<NonNullable<ReturnType<Message["segments"]>[number]>["field"]>;

/**
 * Whether `field` holds exactly one coded value of the one shape this channel accepts, read from its
 * wire text under the message's own delimiters: one repetition of a code, a text and a coding
 * system (`CODE^Text^SYSTEM`, the text may be empty). The code and the coding system must each be
 * one plain value: no subcomponent, no escape sequence, no space, and not the HL7 null (`""`). The
 * text must have no subcomponent. Anything else is refused, never trimmed to its first part, since
 * the parts left out would be dropped without a trace.
 */
function oneCodedValue(field: Field, msg: Message): boolean {
  const {
    component,
    escape,
    field: separator,
    repetition,
    subcomponent,
    truncation,
  } = msg.encodingCharacters;
  const delimiters = [separator, component, repetition, escape, subcomponent, truncation ?? ""];
  const plain = (value: string): boolean =>
    value !== "" &&
    value !== '""' &&
    !/\s/u.test(value) &&
    delimiters.every((each) => each === "" || !value.includes(each));
  if (field.isNull || field.repetitions.length !== 1) return false;
  const parts = field.text.split(component);
  if (parts.length !== 3) return false;
  const [code = "", text = "", system = ""] = parts;
  return plain(code) && plain(system) && !text.includes(subcomponent);
}

export default ((msg) => {
  if (!msg.is("ORU^R01")) return null;

  // One header per message. The parser reads a segment id in any case, so a second header (`MSH`
  // or `msh`) in the same text starts what is in truth a second message, and the results after it,
  // with no PID of their own, would be sent as this patient's. The message fails instead.
  if (msg.segments("MSH").length !== 1) {
    throw new Error("the message must hold exactly one MSH segment");
  }

  // One patient per message. A second PID, a person's or another animal's, would have its results
  // sent as the first one's, so the message fails instead.
  const pids = msg.segments("PID");
  const [pid] = pids;
  if (pid === undefined || pids.length !== 1) {
    throw new Error("the message must hold exactly one PID segment");
  }

  // In ORU^R01 the patient and visit segments open the message, before the first order (OBR). One
  // after it starts a second patient's group, whatever its header says, so the message fails.
  const firstOrder = msg.allSegments().findIndex((segment) => segment.type === "OBR");
  if (
    firstOrder !== -1 &&
    msg
      .allSegments()
      .slice(firstOrder)
      .some((segment) => PATIENT_OR_VISIT.has(segment.type))
  ) {
    throw new Error(
      "no patient or visit segment (PID, PD1, NK1, PV1, PV2) may follow the first OBR",
    );
  }

  // The Bundle's entry ids are made from MSH-10, so two messages without one would share them. A
  // control id of only spaces is no id.
  const controlId = msg.segments("MSH")[0]?.field(10);
  if (controlId === undefined || controlId.isNull || controlId.text.trim() === "") {
    throw new Error("MSH-10 must hold the message's control id");
  }

  // PID-35 species and PID-36 breed. Each must be exactly one plain coded value (see
  // oneCodedValue); PID-36 may also be empty. Only then are they read by name through
  // @cosyte/hl7's typed patient.
  const speciesField = pid.field(35);
  if (speciesField.isNull || speciesField.repetitions.length === 0) {
    throw new Error("no species in PID-35: not a veterinary result");
  }
  if (!oneCodedValue(speciesField, msg)) {
    throw new Error(
      "PID-35 must hold exactly one species, as one plain code and one plain coding system",
    );
  }
  const breedField = pid.field(36);
  const breedEmpty = !breedField.isNull && breedField.repetitions.length === 0;
  if (!breedEmpty && !oneCodedValue(breedField, msg)) {
    throw new Error(
      "PID-36 must be empty or hold exactly one breed, as one plain code and one plain coding system",
    );
  }
  const { species, breed } = msg.patient ?? {};
  if (species?.identifier === undefined || (!breedEmpty && breed?.identifier === undefined)) {
    throw new Error("@cosyte/hl7 did not read the species and breed that PID-35 and PID-36 hold");
  }

  const { bundle } = toFhir(msg, { generateId: idsFor(controlId.text) });
  const json = serializeResource(bundle);

  // The Patient in the Bundle carries the same species and breed, or the message fails here.
  if (animalPart(json, "species") !== species.identifier) {
    throw new Error("the Bundle's Patient does not carry the species from PID-35");
  }
  if (!breedEmpty && animalPart(json, "breed") !== breed?.identifier) {
    throw new Error("the Bundle's Patient does not carry the breed from PID-36");
  }
  return json;
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
