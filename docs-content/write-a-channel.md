---
id: write-a-channel
title: Write a channel and its tests
sidebar_label: Write a channel
description: "Build a channel from nothing: send only final lab results on to an EHR, test it with sample messages, and run it."
---

# Write a channel and its tests

In this tutorial you add a second channel to the starter project. It reads HL7 v2 lab results from a
folder, keeps only final results, addresses them to an EHR, and writes them to another folder. You
write its tests before you run it.

You need the project from the [quickstart](./quickstart.md). Every command runs in its folder.

## 1. Make the channel's folder

A channel is a folder under `channels/`. Its name is the folder's name: lowercase letters, digits and
hyphens.

```bash
mkdir -p channels/results-to-ehr/tests
```

## 2. Wire the source to a destination

Create `channels/results-to-ehr/channel.yaml`:

```yaml title="channels/results-to-ehr/channel.yaml"
# Lab results in, final results out to the EHR. Paths are relative to this file.
format: hl7v2
source:
  file:
    dir: ../../data/results-to-ehr/in
transform: ./transform.ts
destinations:
  - file:
      dir: ../../data/results-to-ehr/out
```

The source reads each file in its folder as one message. The destination writes each output as a
file of its own.

## 3. Write the transform

Create `channels/results-to-ehr/transform.ts`:

```ts runnable title="channels/results-to-ehr/transform.ts"
import type { Transform } from "@cosyte/pathways";

export default ((msg) => {
  // Only lab results go on.
  if (!msg.is("ORU^R01")) return null;
  // OBR-25 is the result status. F is final; a preliminary result waits for its final one.
  if (msg.get("OBR.25") !== "F") return null;
  // MSH-5 is the receiving application.
  msg.setField("MSH.5", "EHR");
  return msg;
}) satisfies Transform;
```

`msg` is an `Hl7Message` from `@cosyte/hl7`. Returning `null` filters the message out: it is stored
and marked `filtered`, and nothing is sent.

## 4. Add sample messages

Each file in `tests/` is one input. Save these two synthetic results, one final and one preliminary:

```text title="channels/results-to-ehr/tests/final.hl7"
MSH|^~\&|SYNTHLAB|SYNTHHOSP|SYNTHRCV|SYNTHHOSP|20261107130000||ORU^R01^ORU_R01|SYNTH00101|P|2.5.1
PID|1||TEST000001^^^SYNTHHOSP^MR||TESTPATIENT^ALPHA||19700101|U
OBR|1||SYNTHORD0001|24331-1^Lipid panel^LN|||20261107120000|||||||||||||||20261107130000|||F
OBX|1|NM|2093-3^Cholesterol^LN||182|mg/dL|<200||||F
```

```text title="channels/results-to-ehr/tests/preliminary.hl7"
MSH|^~\&|SYNTHLAB|SYNTHHOSP|SYNTHRCV|SYNTHHOSP|20261107130000||ORU^R01^ORU_R01|SYNTH00102|P|2.5.1
PID|1||TEST000001^^^SYNTHHOSP^MR||TESTPATIENT^ALPHA||19700101|U
OBR|1||SYNTHORD0001|24331-1^Lipid panel^LN|||20261107120000|||||||||||||||20261107130000|||P
OBX|1|NM|2093-3^Cholesterol^LN||182|mg/dL|<200||||P
```

## 5. Run the tests, and save what they produce

```bash
npx pathways test results-to-ehr
```

```text
FAIL results-to-ehr/tests/final.hl7: no final.expected.hl7; run "pathways test --update" to save the current output
FAIL results-to-ehr/tests/preliminary.hl7: no preliminary.expected.hl7; run "pathways test --update" to save the current output
0 passed, 2 failed
```

Each input needs an expected output beside it, named after it: `final.hl7` expects
`final.expected.hl7`. Save the transform's current output as the expected one:

```bash
npx pathways test results-to-ehr --update
```

```text
UPDATED results-to-ehr/tests/final.hl7 -> final.expected.hl7
UPDATED results-to-ehr/tests/preliminary.hl7 -> preliminary.expected.hl7
0 passed, 0 failed, 2 updated
```

Open both files before you trust them. `final.expected.hl7` is the result with `EHR` in MSH-5, its
segments ending in carriage returns as HL7 v2 is sent. `preliminary.expected.hl7` is empty: the
transform filtered it out. These files are now what the channel must keep producing, so commit them
with the channel.

## 6. See a test catch a change

Run every channel's tests:

```bash
npx pathways test
```

```text
PASS adt-to-lab/tests/a01.hl7
PASS adt-to-lab/tests/a08.hl7
PASS results-to-ehr/tests/final.hl7
PASS results-to-ehr/tests/preliminary.hl7
4 passed, 0 failed
```

Now change `"EHR"` in the transform to `"EHR2"` and run the channel's tests again:

```text
FAIL results-to-ehr/tests/final.hl7: output differs from the expected at line 1, column 32 (final.expected.hl7)
PASS results-to-ehr/tests/preliminary.hl7
1 passed, 1 failed
```

The report names the file and the place the output parts from the expected, never the content. Put
`"EHR"` back.

## 7. Run it

Start the engine, and in a second terminal drop both samples into the channel's inbox:

```bash
npm start
```

```bash
mkdir -p data/results-to-ehr/in
cp channels/results-to-ehr/tests/final.hl7 channels/results-to-ehr/tests/preliminary.hl7 data/results-to-ehr/in/
```

Once the engine logs `delivered`, stop it with Ctrl+C. The final result is in
`data/results-to-ehr/out`, and the preliminary one is stored as `filtered`:

```bash
npx pathways messages --channel results-to-ehr
```

## What you built

A channel in three files you can review in a pull request, and two tests that hold its behavior. The
same loop serves every change: edit the transform, run `pathways test`, and update an expected file
only once you have read the difference.

## Next

- [Transform and filter messages](./transform-and-filter-messages.md): several outputs, other
  formats, and async transforms.
- [Test a channel](./test-a-channel.md): how inputs and expected files are matched.
- [Send and receive over MLLP](./send-and-receive-mllp.md), to take results from a lab system
  directly.
