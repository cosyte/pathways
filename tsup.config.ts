import { cosyteTsup } from "@cosyte/tsup-config";

/**
 * tsup build for `@cosyte/pathways`: dual ESM + CJS + `.d.ts` from the shared @cosyte/tsup-config
 * standard, which bundles each entry on its own (no shared chunks).
 *
 *   - `index`: the programmatic API, the `.` export in package.json.
 *   - `bin/pathways`: the `pathways` command. tsup keeps its `#!/usr/bin/env node` line;
 *     `package.json#bin` points at `dist/bin/pathways.mjs`.
 *   - `bin/pathways-worker`: the transform worker. The command starts it from beside itself
 *     (`defaultWorkerUrl` in src/engine/channel-worker.ts), so the two names must stay siblings.
 *
 * `shims` gives the CJS builds a working `import.meta.url`.
 */
export default cosyteTsup({
  entry: {
    index: "src/index.ts",
    "bin/pathways": "src/bin/pathways.ts",
    "bin/pathways-worker": "src/engine/worker-entry.ts",
  },
  shims: true,
});
