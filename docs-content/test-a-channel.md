---
id: test-a-channel
title: Test a channel with sample messages
sidebar_label: Test a channel
description: "Run each channel's sample messages through its transform and compare the output with saved expected files, locally and in CI."
---

# Test a channel with sample messages

`pathways test` runs every file in each channel's `tests/` folder through the channel's transform and
compares the output with the expected file saved beside it. It runs the transform in the same kind of
worker the engine uses, with the channel's time limit and memory cap, so a test that passes behaves the
same when the channel runs.

## Name the files

Each input is a file in `tests/`. Its expected output has the same name with `.expected` before the
extension:

| Input          | Expected                |
| -------------- | ----------------------- |
| `a01.hl7`      | `a01.expected.hl7`      |
| `patient.json` | `patient.expected.json` |
| `claim`        | `claim.expected`        |

Files whose name contains `.expected` are never inputs, and hidden files are skipped. The comparison is
byte for byte, whatever the format:

- a message the transform filters out expects an empty file;
- several outputs are joined by one newline (`\n`) into one expected file.

On a channel where a destination has its own `transform:`, each destination's outputs have an
expected file of their own: `<input without its extension>.expected.<destination name>.<extension of
the destination's format>`, with the destination's place in the list, from 1, when it has no
`name:`. A destination with no expected file is expected to filter the input out, so `--update`
removes the file of a destination that filtered it.

| Input     | Destination                     | Expected                     |
| --------- | ------------------------------- | ---------------------------- |
| `a01.hl7` | `name: ehr`, format `hl7v2`     | `a01.expected.ehr.hl7`       |
| `a01.hl7` | `name: registry`, format `json` | `a01.expected.registry.json` |
| `a01.hl7` | the third, with no `name:`      | `a01.expected.3.hl7`         |

Use synthetic messages only: [`@cosyte/synth`](https://docs.cosyte.com/synth) generates them, as
[Make sample messages](./make-sample-messages.md) shows, or write them by hand with values that are
visibly invented.

## Keep git from changing their line endings

HL7 v2 ends each segment with a carriage return, and the comparison is byte for byte, so git must
store and check out the test files exactly as written. Git on Windows can turn line endings into
CRLF on checkout (`core.autocrlf`), which breaks a message and its expected file. Mark them in a
`.gitattributes` at the project's root, beside `pathways.yaml`:

```text title=".gitattributes"
*.hl7 -text
```

`-text` tells git never to convert those files on any system. Add a line for each other extension
your channels' tests use whose bytes must not change, such as `*.x12 -text`.

## Run them

```bash
npx pathways test                 # every channel
npx pathways test adt-to-lab      # one channel, or several by name
```

Each input prints `PASS`, `FAIL` with the reason, or `SKIP` for a channel with no inputs, then a
summary line. A failure names the file and where the output parts from the expected, by line and
column, never the content:

```text
FAIL results-to-ehr/tests/final.hl7: output differs from the expected at line 1, column 32 (final.expected.hl7)
```

A transform that throws, times out or cannot parse the input fails its test with the stage, the error's
name and, for a throw, the line in the transform.

## Save new expected outputs

```bash
npx pathways test results-to-ehr --update
```

`--update` writes each input's current output as its expected file and compares nothing. Read the
difference before you commit it: an expected file is the record of what the channel must produce.

## Run them in CI

`pathways test` exits 0 when every test passes and 1 when one fails, so a CI job runs it as it is. It
needs no database and no encryption keys, and stores nothing:

```yaml title=".github/workflows/channels.yml" no-check other tools read this file, not Pathways
name: Channels
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - run: npx pathways test
```

## Related

- [Write a channel and its tests](./write-a-channel.md), the tutorial.
- [Make sample messages](./make-sample-messages.md) with a fixed seed.
- [Command reference](./command-reference.md#pathways-test).
