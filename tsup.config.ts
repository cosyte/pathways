import { cosyteTsup } from "@cosyte/tsup-config";

/**
 * tsup build for `@cosyte/pathways`: dual ESM + CJS + `.d.ts` from the shared @cosyte/tsup-config
 * standard.
 *
 *   - `index`: the programmatic API, the `.` export in package.json.
 *   - `bin/pathways`: the `pathways` command. tsup keeps its `#!/usr/bin/env node` line;
 *     `package.json#bin` points at `dist/bin/pathways.mjs`.
 */
export default cosyteTsup({
  entry: {
    index: "src/index.ts",
    "bin/pathways": "src/bin/pathways.ts",
  },
});
