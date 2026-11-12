---
id: example-vet-lab-to-v2-xml
title: "Example: a veterinary lab result as v2 XML over HTTPS"
sidebar_label: A veterinary lab result as v2 XML
description: "A runnable project: take a veterinary lab result as HL7 v2 over MLLP, write it in the HL7 v2 XML encoding, POST it over HTTPS with a client certificate, and settle each delivery by the XML acknowledgement."
---

# Example: a veterinary lab result as v2 XML over HTTPS

A project with one channel, `vet-results-to-xml`, that listens for HL7 v2 over MLLP, writes each
veterinary lab result (`ORU^R01`) in the HL7 v2 XML encoding with
[`@cosyte/hl7`](https://docs.cosyte.com/hl7), and POSTs it over HTTPS, presenting a client
certificate, to a results web service. The service answers each POST with an XML acknowledgement,
and the destination settles the delivery by it. It is in
[`examples/vet-lab-to-v2-xml`](https://github.com/cosyte/pathways/tree/main/examples/vet-lab-to-v2-xml),
with its synthetic test messages, and CI runs its tests and the pass below on every change.
[Send a lab result as v2 XML over HTTPS](./send-a-lab-result-as-v2-xml.md) says what this shows
about a real results service, and what it does not.

## What it shows

- An [MLLP source](./send-and-receive-mllp.md) that stores each message before it sends the ACK.
- A transform that writes each lab result with `toHl7Xml` from `@cosyte/hl7`: the segments placed in
  the `ORU_R01` groups `@cosyte/hl7` ships for HL7 v2.5, and each field's components named for its
  data type from a table in the transform. Every other message is filtered out.
- An [HTTP destination](./send-and-receive-http.md#settle-by-an-hl7-v2-xml-acknowledgement) with
  `ack: xml` that POSTs the document as `application/xml` over TLS, presents a client certificate,
  and settles each delivery by the acknowledgement's `MSA.1`: `AA` delivered, `AE` retried, `AR`
  failed for good, and an acknowledgement whose `MSA.2` names another message retried.
- Three small scripts to try it with no other system: `scripts/dev-certs.ts` makes a development
  CA, server certificate and client certificate with `openssl`; `scripts/lab.ts` stands in for the
  results service, requires the client certificate, reads each POST with `parseHL7Xml` and answers
  with an acknowledgement written by `toHl7Xml`, passing the `ACK` structure `@cosyte/hl7` ships no
  table for; and `scripts/send.ts` sends files over MLLP.

The MLLP source runs plain TCP on the loopback (`plaintext: true`), for this example only. A lab
system on another machine connects over TLS: see [Secure endpoints](./secure-endpoints.md).

## Run it

You need Node.js 24 or later, and the `openssl` command. Copy the folder, then in it:

```bash
npm install
npm run key
npm run certs
npm test
```

`npm install` installs `@cosyte/hl7`, which the transform and the stand-in import, beside Pathways.
`npm run key` writes a development key to `.pathways/dev.key`, which `pathways.yaml` names, and
`npm run certs` writes the CA, the stand-in's certificate and the channel's client certificate to
`.pathways/tls/`, which the channel names; `.gitignore` keeps that folder out of git. `npm test` runs
the channel's tests, shown under [Expected output](#expected-output): each lab result gives the XML
document in its expected file.

Then use three terminals in the same folder. Start the stand-in, which listens for HTTPS on port 8443
and writes each request's body to `data/lab/`. The answers it is given are the codes of its first
five acknowledgements, `other-id` being an `AA` that answers another message; after them it answers
`AA`:

```bash
npm run lab -- AA AE AA AR other-id
```

Start the engine, which listens for MLLP on port 2575:

```bash
npm start
```

Send four lab results:

```bash
npm run send -- channels/vet-results-to-xml/tests/oru-1.hl7 channels/vet-results-to-xml/tests/oru-2.hl7 channels/vet-results-to-xml/tests/oru-3.hl7 channels/vet-results-to-xml/tests/oru-4.hl7
```

Each message is stored, then acknowledged over MLLP:

```text
channels/vet-results-to-xml/tests/oru-1.hl7: AA
channels/vet-results-to-xml/tests/oru-2.hl7: AA
channels/vet-results-to-xml/tests/oru-3.hl7: AA
channels/vet-results-to-xml/tests/oru-4.hl7: AA
```

The destination sends them in order, one at a time, and the stand-in prints each POST's size and
its answer, never the content:

```text
POST /results: 2205 bytes to data/lab/1.xml, answered AA
POST /results: 2205 bytes to data/lab/2.xml, answered AE
POST /results: 2205 bytes to data/lab/3.xml, answered AA
POST /results: 2513 bytes to data/lab/4.xml, answered AR
POST /results: 2849 bytes to data/lab/5.xml, answered AA to another control id
POST /results: 2849 bytes to data/lab/6.xml, answered AA
```

- The first result is accepted and delivered.
- The second draws `AE`. The engine logs `delivery-retry` with the code `ACK_AE`, waits a second,
  and sends it again; the second answer is `AA`, so it is delivered. The results behind it wait.
- The third draws `AR`, and its delivery fails for good: the engine logs `delivery-rejected` with
  the reason `AR`, and the destination moves on. It is kept, and
  [replay](./inspect-replay-and-clear-messages.md#replay-a-failed-message) sends it again.
- The fourth draws an `AA` whose `MSA.2` is not the result's `MSH.10`. That answer is not about this
  result, so the engine logs `delivery-retry` with the code `ACK_CONTROL_ID_MISMATCH` and sends it
  again; the next answer is its own `AA`.

Each file in `data/lab/` matches the expected file of the result it holds. Stop the engine and the
stand-in with Ctrl+C. `npx pathways status` counts three delivered and one failed. `MLLP_PORT`,
`LAB_PORT` and `LAB_URL` move the ports and the URL when 2575 or 8443 is taken.

## Expected output

What `pathways test` prints, which `npm test` runs, as the example's README gives it. This section and the next are generated from the example by `scripts/example-pages.ts`, and CI fails when they no longer match it.

```text
PASS vet-results-to-xml/tests/oru-1.hl7
PASS vet-results-to-xml/tests/oru-2.hl7
PASS vet-results-to-xml/tests/oru-3.hl7
PASS vet-results-to-xml/tests/oru-4.hl7
4 passed, 0 failed
```

## Files

Every file of `examples/vet-lab-to-v2-xml/` but its README and git settings: [vet-lab-to-v2-xml on GitHub](https://github.com/cosyte/pathways/tree/main/examples/vet-lab-to-v2-xml).

Its messages are synthetic, made by `@cosyte/synth`, and are on GitHub with the rest: in `channels/vet-results-to-xml/tests/`, `oru-1.hl7`, `oru-2.hl7`, `oru-3.hl7`, `oru-4.hl7`. Each input in a `tests/` folder has its expected output beside it.

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
    "certs": "node scripts/dev-certs.ts",
    "lab": "node scripts/lab.ts",
    "send": "node scripts/send.ts",
    "start": "pathways start",
    "test": "pathways test"
  },
  "dependencies": {
    "@cosyte/hl7": "^0.1.14"
  },
  "devDependencies": {
    "@cosyte/pathways": "^0.0.4"
  }
}
```

### channels/vet-results-to-xml/channel.yaml

```yaml title="channels/vet-results-to-xml/channel.yaml"
# yaml-language-server: $schema=../../node_modules/@cosyte/pathways/schema/channel.json

# Take veterinary lab results as HL7 v2 over MLLP, write each in the HL7 v2 XML encoding, and POST
# it over HTTPS with a client certificate to a results web service that answers each POST with an
# XML acknowledgement.
name: vet-results-to-xml

# What comes in: the transform receives each message parsed by @cosyte/hl7.
format: hl7v2

source:
  mllp:
    # This machine only, on port 2575 unless MLLP_PORT names another.
    host: 127.0.0.1
    port: { env: MLLP_PORT, default: 2575 }
    # Plain TCP on the loopback, for this example only. A lab system on another machine connects
    # over TLS: give the source tls: { cert, key, ca } in place of this line.
    plaintext: true

transform: ./transform.ts

destinations:
  - http:
      # The stand-in in scripts/lab.ts listens here. A real service's URL comes from its operator.
      url: { env: LAB_URL, default: "https://127.0.0.1:8443/results" }
      headers:
        # The channel's format names what comes in, so set the type of what goes out.
        Content-Type: application/xml
      # The CA the service's certificate is signed by, and the client certificate and key this
      # channel presents. npm run certs makes all three for development, under .pathways/tls/. A
      # real service issues or names its own.
      tls:
        ca: ../../.pathways/tls/ca.crt
        cert: ../../.pathways/tls/client.crt
        key: ../../.pathways/tls/client.key
      # The stand-in service is on this machine, an address the destination refuses unless it is named
      # here. A real endpoint on the public internet needs no allowNetworks line; one on a private
      # network, such as 10.20.0.0/16, needs that network named here.
      allowNetworks: [127.0.0.1]
      # Read each 2xx answer as an HL7 v2 XML acknowledgement and settle the delivery by its MSA.1:
      # AA delivered, AE retried, AR failed. An answer to another MSH.10 is retried.
      ack: xml
```

### channels/vet-results-to-xml/transform.ts

```ts runnable title="channels/vet-results-to-xml/transform.ts"
// Writes each veterinary lab result (ORU^R01) in the HL7 v2 XML encoding with @cosyte/hl7's
// writer, and filters every other message out. The HTTP destination POSTs the document and settles
// the delivery by the XML acknowledgement the service answers with.
import { toHl7Xml, XML_GROUP_TABLES } from "@cosyte/hl7";
import type { Transform } from "@cosyte/pathways";

/**
 * The HL7 v2.5 data type of each field these results fill that has components, and of each
 * component that has subcomponents. The XML encoding names every component for its data type
 * (`PID.5` is an `XPN`, so the family name is `XPN.1`, itself an `FN` whose first part is `FN.1`),
 * and the message itself does not say which type a field is, so the writer takes them here. A field
 * with more than one component whose type is not listed is refused, so a result that fills another
 * such field fails rather than going out in a shape the receiver cannot read. Take your receiver's
 * list from its schema, or read it from a sample document with `xmlDataTypes` from @cosyte/hl7.
 */
const DATA_TYPES: Readonly<Record<string, string>> = {
  "MSH.3": "HD",
  "MSH.4": "HD",
  "MSH.5": "HD",
  "MSH.6": "HD",
  "MSH.7": "TS",
  "MSH.9": "MSG",
  "MSH.11": "PT",
  "MSH.12": "VID",
  "PID.3": "CX",
  "CX.4": "HD",
  "PID.5": "XPN",
  "XPN.1": "FN",
  "PID.7": "TS",
  "PID.11": "XAD",
  "XAD.1": "SAD",
  "PID.13": "XTN",
  "PID.35": "CE",
  "PID.36": "CE",
  "NK1.2": "XPN",
  "NK1.3": "CE",
  "NK1.4": "XAD",
  "NK1.5": "XTN",
  "OBR.2": "EI",
  "OBR.3": "EI",
  "OBR.4": "CE",
  "OBR.7": "TS",
  "OBX.3": "CE",
  "OBX.6": "CE",
  "OBX.14": "TS",
};

export default ((msg) => {
  if (!msg.is("ORU^R01")) return null;

  // The XML encoding places the segments in the message structure's groups
  // (ORU_R01.PATIENT_RESULT and the rest), whose names come from each version's published schema.
  // @cosyte/hl7 ships them for ORU_R01 in v2.5, which these results are. For another version or
  // structure, pass the table your receiver's schema gives as groups, the way scripts/lab.ts passes
  // the ACK's: this transform fails such a result rather than guess its groups.
  const groups = XML_GROUP_TABLES[msg.version ?? ""]?.["ORU_R01"];
  if (groups === undefined) {
    throw new Error("no ORU_R01 group table for this result's HL7 version (MSH-12)");
  }
  return toHl7Xml(msg, { dataTypes: DATA_TYPES, groups });
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

### scripts/dev-certs.ts

```ts title="scripts/dev-certs.ts" no-run a script of the example, which test/examples.test.ts runs
// `npm run certs`: makes development TLS material in .pathways/tls/ with the openssl command, unless
// it is there already: a certificate authority (ca.crt), the certificate scripts/lab.ts presents for
// 127.0.0.1 and localhost (lab.crt, lab.key), and the client certificate the channel presents to it
// (client.crt, client.key). Each is valid for 30 days, and the keys are readable by this user only.
// .gitignore keeps .pathways/ out of git. A real service's client certificate comes from whoever
// runs the service, never from a script like this one.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".pathways/tls";
// An elliptic curve key on P-256, written without a passphrase.
const KEY = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
const DAYS = "30";

if (existsSync(join(DIR, "ca.crt"))) {
  process.stdout.write(`${DIR} is there already\n`);
  process.exit(0);
}

mkdirSync(DIR, { recursive: true, mode: 0o700 });

function openssl(args: readonly string[]): void {
  execFileSync("openssl", args, { cwd: DIR, stdio: "pipe" });
}

/** Writes `lines` to `name` in the folder, for openssl to read. */
function write(name: string, lines: readonly string[]): void {
  writeFileSync(join(DIR, name), [...lines, ""].join("\n"));
}

// The certificate authority, which signs the other two.
write("ca.cnf", [
  "[req]",
  "distinguished_name = dn",
  "prompt = no",
  "[dn]",
  "CN = Pathways example development CA",
  "[v3_ca]",
  "basicConstraints = critical,CA:TRUE",
  "keyUsage = critical,keyCertSign,cRLSign",
  "subjectKeyIdentifier = hash",
]);
openssl([
  "req",
  "-x509",
  "-config",
  "ca.cnf",
  "-extensions",
  "v3_ca",
  ...KEY,
  "-keyout",
  "ca.key",
  "-out",
  "ca.crt",
  "-days",
  DAYS,
]);

/** A certificate the CA signs, for `name`, with the X.509 extensions given. */
function leaf(
  name: string,
  commonName: string,
  serial: number,
  extensions: readonly string[],
): void {
  write(`${name}.cnf`, [
    "[req]",
    "distinguished_name = dn",
    "prompt = no",
    "[dn]",
    `CN = ${commonName}`,
  ]);
  write(`${name}.ext`, [
    "basicConstraints = CA:FALSE",
    "keyUsage = critical,digitalSignature",
    ...extensions,
  ]);
  openssl([
    "req",
    "-new",
    "-config",
    `${name}.cnf`,
    ...KEY,
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-set_serial",
    String(serial),
    "-days",
    DAYS,
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.crt`,
  ]);
  for (const done of [`${name}.cnf`, `${name}.ext`, `${name}.csr`]) rmSync(join(DIR, done));
}

leaf("lab", "localhost", 2, [
  "extendedKeyUsage = serverAuth",
  "subjectAltName = DNS:localhost,IP:127.0.0.1",
]);
leaf("client", "Pathways example lab", 3, ["extendedKeyUsage = clientAuth"]);
rmSync(join(DIR, "ca.cnf"));
for (const key of ["ca.key", "lab.key", "client.key"]) chmodSync(join(DIR, key), 0o600);
process.stdout.write(`wrote ${DIR}: ca.crt, lab.crt, lab.key, client.crt, client.key\n`);
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

### scripts/lab.ts

```ts title="scripts/lab.ts" no-run a script of the example, which test/examples.test.ts runs
// `npm run lab -- [answer...]`: a stand-in for a results web service that takes HL7 v2 XML. It
// listens for HTTPS on 127.0.0.1, port 8443 unless LAB_PORT names another, with the certificate
// `npm run certs` made, and refuses a connection that presents no client certificate signed by the
// same CA. It reads each request's body as HL7 v2 XML with @cosyte/hl7, writes it to data/lab/ as a
// file of its own, and answers 200 with an XML acknowledgement (ACK) to it. Each answer's MSA.1 is
// the next one named on the command line: AA, AE or AR, or other-id for an AA whose MSA.2 names
// another message. Once they run out, it answers AA. It prints sizes and codes, never content.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";

import {
  buildAck,
  Hl7XmlError,
  parseHL7Xml,
  toHl7Xml,
  type XmlMessageStructure,
} from "@cosyte/hl7";

const OUT = "data/lab";
const TLS = ".pathways/tls";
/** The most of a request's body it reads, 1 MiB. */
const MAX_BODY = 1_048_576;
const ANSWERS = ["AA", "AE", "AR", "other-id"] as const;
type Answer = (typeof ANSWERS)[number];

/**
 * The ACK message structure, as the HL7 v2.5 standard gives it. @cosyte/hl7 ships group tables for
 * ORU_R01 only, so the writer is given this one: an ACK has no groups, and the table also makes the
 * writer refuse a segment that has no place in it.
 */
const ACK_STRUCTURE: XmlMessageStructure = {
  structure: "ACK",
  items: ["MSH", "SFT*", "MSA", "ERR*"],
};

/** The data types of the ACK's fields that have components, in HL7 v2.5. */
const ACK_DATA_TYPES: Readonly<Record<string, string>> = {
  "MSH.3": "HD",
  "MSH.4": "HD",
  "MSH.5": "HD",
  "MSH.6": "HD",
  "MSH.7": "TS",
  "MSH.9": "MSG",
  "MSH.11": "PT",
  "MSH.12": "VID",
};

const queue: Answer[] = [];
for (const given of process.argv.slice(2)) {
  if (!(ANSWERS as readonly string[]).includes(given)) {
    process.stderr.write(`unknown answer ${given}: give AA, AE, AR or other-id\n`);
    process.exit(2);
  }
  queue.push(given as Answer);
}

let received = 0;
mkdirSync(OUT, { recursive: true });

/** The XML acknowledgement to the message in `body`, with the answer `answer`. */
function acknowledge(body: string, answer: Answer): string {
  const message = parseHL7Xml(body);
  const ack = buildAck(message, { code: answer === "other-id" ? "AA" : answer });
  if (answer === "other-id") ack.setField("MSA.2", "SYN-OTHER-0001");
  return toHl7Xml(ack, { dataTypes: ACK_DATA_TYPES, groups: ACK_STRUCTURE });
}

const server = createServer(
  {
    cert: readFileSync(`${TLS}/lab.crt`),
    key: readFileSync(`${TLS}/lab.key`),
    ca: readFileSync(`${TLS}/ca.crt`),
    requestCert: true,
    rejectUnauthorized: true,
  },
  (request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    request.on("end", () => {
      received += 1;
      const file = `${OUT}/${String(received)}.xml`;
      const head = `${String(request.method)} ${String(request.url)}: ${String(size)} bytes to ${file}`;
      const body = Buffer.concat(chunks);
      writeFileSync(file, body);
      const answer = queue.shift() ?? "AA";
      let ack: string;
      try {
        if (size > MAX_BODY) throw new Error("too large");
        ack = acknowledge(body.toString("utf8"), answer);
      } catch (error) {
        const code = error instanceof Hl7XmlError ? error.code : "unreadable";
        process.stdout.write(`${head}, not HL7 v2 XML (${code}), answered 400\n`);
        response.writeHead(400).end();
        return;
      }
      const said = answer === "other-id" ? "AA to another control id" : answer;
      process.stdout.write(`${head}, answered ${said}\n`);
      response.writeHead(200, { "Content-Type": "application/xml" }).end(ack);
    });
  },
);

const port = Number(process.env["LAB_PORT"] ?? 8443);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening on https://127.0.0.1:${String(port)}\n`);
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
