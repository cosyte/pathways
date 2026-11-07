#!/usr/bin/env node
/**
 * scripts/attw.mjs: this package's `attw` publish gate.
 *
 * THE GATE ITSELF IS `@cosyte/script-utils/attw`, AND THIS FILE IS A CALLER OF
 * IT RATHER THAN A COPY. Read that module's docblock for what the gate checks,
 * which routes it refuses and the measurement behind each; nothing is restated
 * here, because a claim written down twice is a claim that drifts.
 *
 * WHY THIS FILE STILL EXISTS AT ALL, GIVEN IT HAS ONE STATEMENT IN IT. Three
 * independent things pin `attw` to exactly `node scripts/attw.mjs` with a file
 * beside it: `drift-manifest.json` lists `attw` in the package baseline's
 * required scripts, `test/attw-scaffold.test.ts` asserts that exact string for
 * this package and for the parser template, and the sibling repos' own suites
 * assert it for theirs. The entry point does not move; what moved is the body
 * behind it.
 *
 * `callerUrl` IS THE WHOLE OF WHAT A CALLER OWNS. The gate spawns
 * `../node_modules/.bin/attw` resolved from THIS file's URL, which is THIS
 * package's own binary. It is not defaulted inside the gate: from there the
 * relative path would land in `node_modules/@cosyte/`, and a gate that ran some
 * other package's attw would be analysing a dependency tree nobody asked about.
 *
 * `process.exitCode` RATHER THAN `process.exit`, AND THAT IS NOT STYLE. The pass
 * line and every refusal are written to a pipe under CI, where a write is
 * asynchronous; `process.exit` can truncate one that has not drained. Setting
 * the code lets node exit on its own once the output is out.
 */

import { runAttwGate } from "@cosyte/script-utils/attw";

process.exitCode = runAttwGate({ callerUrl: import.meta.url });
