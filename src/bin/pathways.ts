#!/usr/bin/env node
import { run } from "../cli.js";

// The process entry: glue between the real stdout, stderr and exit code and `run`, which the tests
// cover directly. It is excluded from coverage because it runs only as a separate process.
/* v8 ignore start */
process.exitCode = run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
/* v8 ignore stop */
