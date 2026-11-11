import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cosyteTsup } from "@cosyte/tsup-config";

import { configJsonSchemas } from "./src/config/schema.js";

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
 *
 * Once the entries are built, `onSuccess` writes the JSON Schemas of `channel.yaml` and
 * `pathways.yaml`, from the Zod schemas in src/config/schema.ts, to `schema/channel.json` and
 * `schema/project.json` at the package root, beside `dist/`. package.json exports each at its own
 * path (`@cosyte/pathways/schema/channel.json`), so a resolver that ignores `exports`, such as
 * TypeScript's node10, finds it too; and the starter's YAML files name them in a
 * `yaml-language-server` modeline, by their path under `node_modules`.
 */
export default cosyteTsup({
  entry: {
    index: "src/index.ts",
    "bin/pathways": "src/bin/pathways.ts",
    "bin/pathways-worker": "src/engine/worker-entry.ts",
  },
  shims: true,
  onSuccess: async () => {
    const dir = "schema";
    await mkdir(dir, { recursive: true });
    for (const [name, schema] of Object.entries(configJsonSchemas())) {
      await writeFile(join(dir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
    }
  },
});
