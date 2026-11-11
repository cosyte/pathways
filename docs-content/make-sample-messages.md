---
id: make-sample-messages
title: Make sample messages with @cosyte/synth
sidebar_label: Make sample messages
description: "Generate synthetic HL7 v2 test inputs with a fixed seed, save their expected outputs once, and keep real patient messages out of your tests."
---

# Make sample messages with @cosyte/synth

A channel's tests need inputs that look like what the sending system produces.
[`@cosyte/synth`](https://docs.cosyte.com/synth) generates them: synthetic messages, built through the
same parser Pathways uses, with names, identifiers and dates that belong to nobody. With a fixed seed
it generates the same bytes on every machine and every run, so the inputs can be committed and
regenerated without a difference.

You need a project made by `pathways init`, such as the one from the [quickstart](./quickstart.md).
Every command runs in its folder.

**A copied real message is PHI.** Never put a message from a live system in `tests/`, not even one
with the names changed. It is patient data: once committed, it is in the repository's history, every
clone and every CI log that prints it. Generate inputs, or write them by hand with values that are
plainly invented.

## 1. Install the generator at a pinned minor

```bash
npm install --save-dev @cosyte/synth@~0.1.5
```

The `~` keeps the generator on the 0.1 line. Below 1.0, a new minor version may change what a seed
generates, and the inputs would change with it. Move to a new version on purpose: run the script
again and read the difference before you commit it. Pathways already installs `@cosyte/hl7`, the
parser the HL7 v2 generator builds with.

## 2. Generate the inputs with a fixed seed

Create `scripts/make-samples.mjs`. It writes a synthetic admission (`ADT^A01`) and a synthetic update
(`ADT^A08`) into the starter channel's `tests/` folder:

```js title="scripts/make-samples.mjs" no-run it writes into a project's tests folder; the docs test runs it in a project made by pathways init
import { writeFileSync } from "node:fs";

import { generateAdt, roundTrip } from "@cosyte/synth/hl7";

// A fixed seed: the same messages on every machine and every run. Change it only on purpose.
const SEED = 20261111;
const TESTS = "channels/adt-to-lab/tests";

for (const trigger of ["A01", "A08"]) {
  const message = roundTrip(generateAdt({ seed: SEED, trigger }));
  if (!message.specClean) throw new Error(`the ${trigger} sample did not re-parse cleanly`);
  writeFileSync(`${TESTS}/synth-${trigger.toLowerCase()}.hl7`, message.content);
}
```

```bash
node scripts/make-samples.mjs
```

It writes `synth-a01.hl7` and `synth-a08.hl7`. Run it again and the files do not change.

## 3. Save the expected outputs once

```bash
npx pathways test adt-to-lab --update
```

```text
UPDATED adt-to-lab/tests/a01.hl7 -> a01.expected.hl7
UPDATED adt-to-lab/tests/a08.hl7 -> a08.expected.hl7
UPDATED adt-to-lab/tests/synth-a01.hl7 -> synth-a01.expected.hl7
UPDATED adt-to-lab/tests/synth-a08.hl7 -> synth-a08.expected.hl7
0 passed, 0 failed, 4 updated
```

`--update` saves what the transform produces today; it checks nothing. Read each new expected file
before you commit it. The starter transform keeps admissions and addresses them to the lab, so
`synth-a01.expected.hl7` is the admission with `LAB` in MSH-5, and `synth-a08.expected.hl7` is empty,
since the update is filtered out. The starter's own expected files come out as they were.

## 4. Commit the inputs and the reviewed expected files

The expected file you read and committed is the check. From now on `pathways test` compares each
output with it, byte for byte, so a change to the transform that changes an output fails until you
save and review the new expected file:

```bash
npx pathways test adt-to-lab
```

```text
PASS adt-to-lab/tests/a01.hl7
PASS adt-to-lab/tests/a08.hl7
PASS adt-to-lab/tests/synth-a01.hl7
PASS adt-to-lab/tests/synth-a08.hl7
4 passed, 0 failed
```

Commit `scripts/make-samples.mjs`, the generated inputs and their expected files. CI runs
`pathways test` on the committed files; it does not run the script, so the inputs never change under a
test.

## Related

- [Test a channel](./test-a-channel.md): how inputs and expected files are matched.
- [Write a channel and its tests](./write-a-channel.md), the tutorial.
