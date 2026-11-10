import { cosyteVitest } from "@cosyte/vitest-config";

/**
 * Vitest config for `@cosyte/pathways` from the shared @cosyte/vitest-config standard, with the
 * coverage floor raised to what the suite reaches without a database server (the `databases` job
 * reaches more). A floor only rises. Add `src/<dir>` names to `coverageDirs` to gate each directory
 * on its own as well.
 */
export default cosyteVitest({
  coverageDirs: [],
  coverageThresholds: { lines: 99, branches: 99, functions: 100, statements: 99 },
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
