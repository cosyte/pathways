#!/usr/bin/env node
import { run } from "../cli.js";

// The process entry: glue between the real stdout, stderr, signals and exit code and `run`, which
// the tests cover directly. It is excluded from coverage because it runs only as a separate process.
// No top-level await: the shared build also emits this entry as CommonJS.
/* v8 ignore start */
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

void run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  signal: stop.signal,
}).then((code) => {
  process.exitCode = code;
});
/* v8 ignore stop */
