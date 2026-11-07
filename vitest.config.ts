import { cosyteVitest } from "@cosyte/vitest-config";

/**
 * Vitest config for `@cosyte/pathways` from the shared @cosyte/vitest-config standard: the global
 * >= 90 coverage gate over `src/`. Add `src/<dir>` names to `coverageDirs` as the engine grows, to
 * gate each directory on its own as well.
 */
export default cosyteVitest({
  coverageDirs: [],
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
