import { defineConfig } from "vitest/config";

/**
 * The scaling gates' own Vitest run, `pnpm test:perf`: the tests that read a clock, run apart from
 * `pnpm test` and never under coverage. Coverage instrumentation compiles a counter into every
 * measured function, at a cost that does not cancel cleanly in a ratio, so `@cosyte/test-utils/perf`
 * asks for a run of its own.
 *
 * One file at a time in one fork, so no other test shares the machine with a timed phase.
 */
export default defineConfig({
  test: {
    include: ["test/perf/**/*.perf.ts"],
    pool: "forks",
    fileParallelism: false,
    // A phase is well under a second, but the warmup may take up to its 5 s bound per axis, and
    // each self-check runs a deliberately quadratic version of its work at the same sizes.
    testTimeout: 180_000,
  },
});
