import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type * as Croner from "croner";

// croner reads cron expressions, which only a source whose `poll` sets `cron` has, so it is loaded
// on first use: a project without one never loads it, and `pathways start` does not pay for its
// import. It is loaded synchronously, since validation and the schedule are, and as the very module
// an `import` of it gives, as `@cosyte/hl7` is in src/connectors/ack.ts: ES modules resolve its
// `import` entry with `import.meta.resolve` and require it, and the CommonJS build, which has no
// `import.meta.resolve`, requires its CommonJS entry.

let library: typeof Croner | undefined;

/**
 * croner's `Cron` class, loaded on first use.
 *
 * @example
 * ```ts
 * new (cronClass())("0 2 * * *", { mode: "5-part", paused: true }).nextRun();
 * ```
 */
export function cronClass(): typeof Croner.Cron {
  if (library !== undefined) return library.Cron;
  const require = createRequire(import.meta.url);
  const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
  /* v8 ignore next 3 -- the CommonJS build's branch: the tests run the ES module source */
  library = (
    resolve === undefined ? require("croner") : require(fileURLToPath(resolve("croner")))
  ) as typeof Croner;
  return library.Cron;
}
