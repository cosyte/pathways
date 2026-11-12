---
id: quickstart
title: Quickstart
sidebar_label: Quickstart
description: "From pathways init to a delivered message: write the starter project, run its tests, and run its channel on two synthetic messages."
---

# Quickstart

This takes a new project from nothing to a delivered message: write the starter project, run its
tests, run its channel on two synthetic messages, and look at what was stored. You need Node.js 24
or later.

## 1. Write the starter project

```bash
npx @cosyte/pathways init my-project
cd my-project
npm install
```

`init` writes into an empty folder (or a new one) and refuses anything else, so it never overwrites a
file. It writes:

```text
.dockerignore
.gitignore
.pathways/dev.key
Dockerfile
channels/adt-to-lab/channel.yaml
channels/adt-to-lab/tests/a01.expected.hl7
channels/adt-to-lab/tests/a01.hl7
channels/adt-to-lab/tests/a08.expected.hl7
channels/adt-to-lab/tests/a08.hl7
channels/adt-to-lab/transform.ts
package.json
pathways.yaml
```

- `pathways.yaml` holds the settings for the whole project: where messages are stored (SQLite, in
  `.pathways/`), and the key that encrypts them.
- `.pathways/dev.key` is a development key that `init` generated for this project alone. The
  `.gitignore` keeps `.pathways/` out of git, with the database beside it.
- `Dockerfile` and `.dockerignore` build the project's own image on the Pathways image, with the
  channels inside: see [Deploy the image](./deploy-the-image.md).
- `channels/adt-to-lab/` is one channel: it reads HL7 v2 files from `data/adt-to-lab/in`, keeps only
  admissions (`ADT^A01`), sets the receiving application to `LAB`, and writes them to
  `data/adt-to-lab/out`.

The transform is this file:

```ts runnable title="channels/adt-to-lab/transform.ts"
// The channel's transform. It receives each message parsed (an Hl7Message from @cosyte/hl7) and
// returns what to send on: the message, an array of messages, or null to filter it out.
//
// Node runs this file as it is, by stripping the types, so there is no build step. Syntax that
// needs compiling, such as enums and namespaces, is not available here.
//
// It runs in a worker thread of the channel's own, with a time limit per message, so a transform
// that hangs or throws fails that message only.
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  // Only admissions go to the lab. Every other message is filtered out.
  if (!msg.is("ADT^A01")) return null;
  // MSH-5 is the receiving application.
  msg.setField("MSH.5", "LAB");
  return msg;
}) satisfies Transform;
```

## 2. Run the channel's tests

```bash
npm test
```

`npm test` runs `pathways test`, which sends each file in `tests/` through the transform, in the same
kind of worker the engine uses, and compares the output with the `.expected` file beside it, byte for
byte:

```text
PASS adt-to-lab/tests/a01.hl7
PASS adt-to-lab/tests/a08.hl7
2 passed, 0 failed
```

`a08.expected.hl7` is empty: the transform filters the `ADT^A08` out, and a filtered message expects
no output.

## 3. Run the channel

Start the engine. It runs every channel until you stop it:

```bash
npm start
```

In a second terminal, in the same folder, drop the two test messages into the channel's inbox:

```bash
mkdir -p data/adt-to-lab/in
cp channels/adt-to-lab/tests/a01.hl7 channels/adt-to-lab/tests/a08.hl7 data/adt-to-lab/in/
```

Within a few seconds the engine logs each step as a JSON line: both messages `received`, the
admission `transformed` and the update `filtered`, and one output `delivered`. Each line carries ids
and counts, never a message's content. Stop the engine with Ctrl+C.

The admission is now `data/adt-to-lab/out/1-1.hl7`: message 1, output 1. It matches
`tests/a01.expected.hl7`. The inbox is empty again: the file source deletes each file once it is
stored, encrypted, in the database.

## 4. Look at what was stored

```bash
npx pathways status
npx pathways messages
```

```text
adt-to-lab: ok
  messages: 0 received, 1 transformed, 1 filtered, 0 failed, 0 cleared
  deliveries: 0 pending (0 retrying), 1 delivered, 0 failed, 0 cleared
```

`pathways messages` lists both messages, newest first, with their states: `delivered` and
`filtered`. It never prints content; `pathways messages show 1 --content` does, and writes that view
to the audit log first.

## Next

- [Write a channel](./write-a-channel.md) of your own, with its tests.
- Run an example project, each on synthetic messages with its tests:
  [HL7 v2 over MLLP in, HTTP out](./example-mllp-to-http.md),
  [a file drop to SFTP](./example-file-to-sftp.md), [HL7 v2 to FHIR](./example-hl7-to-fhir.md),
  [filter, then send to two destinations](./example-filter-and-route.md), and
  [replay after a failure](./example-replay-after-failure.md).
- [Transform and filter messages](./transform-and-filter-messages.md): what a transform can return.
- [Encrypt stored messages](./encrypt-stored-messages.md): the keys to use outside development.
- [How delivery and errors work](./delivery-and-errors.md).
