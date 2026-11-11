import { cosyteVitest } from "@cosyte/vitest-config";
import { configDefaults } from "vitest/config";

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
    // Skipped on Windows: test/scripts/phi-scan.test.ts starts the scanner through
    // node_modules/.bin/tsx, which is a shell script there (the runnable link is tsx.cmd), so every
    // case fails to start. The reason lives here, not in that file: it holds the scanner's own
    // realistic test values, which a scan of the file by path refuses to let through, so it is
    // changed only with them. The scan itself runs on Windows CI too (`pnpm phi-scan` in verify).
    exclude: [
      ...configDefaults.exclude,
      ...(process.platform === "win32" ? ["test/scripts/phi-scan.test.ts"] : []),
    ],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
