/**
 * Keep `VERSION` in `src/version.ts` equal to `package.json`'s version.
 *
 * Changesets rewrites the manifest's version and nothing else. The release's `version` script runs
 * `changeset version` and then `scripts/sync-version.ts`, so the bump and the constant land in the
 * same Version Packages commit, and the suite's "VERSION equals package.json's version" test holds
 * on the commit that releases. The shared `cosyte-process sync-version` reads `src/index.ts`; ours
 * lives in `src/version.ts`, which the CLI and `pathways init` import without the whole package.
 *
 * The rules: exactly one `export const VERSION = "...";` line at column 0, so a declaration in a
 * comment or a second copy can never be rewritten in place of the real one, and a rename refuses
 * rather than passing silently; the version is spliced in literally; an already-synced file is not
 * written. Reports name the file and the rule, never the file's text.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The one declaration form the sync rewrites. */
const DECLARATION = /^export const VERSION = "([^"\n]*)";$/gm;

/** A version Changesets can write, with nothing that would end the string literal. */
const USABLE_VERSION = /^[0-9A-Za-z.+$&-]+$/;

const VERSION_FILE = "src/version.ts";

/** What a rewrite produced: the new text, or why there is none. */
export type Rewrite =
  | { readonly ok: true; readonly changed: boolean; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Rewrite the one `VERSION` declaration in `source` to `version`.
 *
 * @example
 * ```ts
 * rewriteVersion('export const VERSION = "0.0.0";\n', "0.1.0");
 * // => { ok: true, changed: true, text: 'export const VERSION = "0.1.0";\n' }
 * ```
 */
export function rewriteVersion(source: string, version: string): Rewrite {
  if (!USABLE_VERSION.test(version)) {
    return { ok: false, reason: "package.json has no usable version" };
  }
  const found = [...source.matchAll(DECLARATION)];
  if (found.length === 0) {
    return { ok: false, reason: 'found no `export const VERSION = "...";` line at column 0' };
  }
  if (found.length > 1) {
    return {
      ok: false,
      reason: `found ${String(found.length)} \`export const VERSION = "...";\` lines; expected exactly one`,
    };
  }
  if (found[0]?.[1] === version) return { ok: true, changed: false, text: source };
  const text = source.replace(DECLARATION, () => `export const VERSION = "${version}";`);
  return { ok: true, changed: true, text };
}

/** What a sync did: the exit code and the one line to report. */
export interface SyncResult {
  readonly code: 0 | 1;
  readonly message: string;
}

/**
 * Sync `src/version.ts` under `root` to `root`'s `package.json` version.
 *
 * @example
 * ```ts
 * const { code, message } = syncVersion(process.cwd());
 * ```
 */
export function syncVersion(root: string): SyncResult {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? manifest.version
        : undefined;
    if (typeof version !== "string") {
      return { code: 1, message: "sync-version: package.json has no usable version" };
    }
    const path = join(root, VERSION_FILE);
    const result = rewriteVersion(readFileSync(path, "utf8"), version);
    if (!result.ok) return { code: 1, message: `sync-version: ${VERSION_FILE}: ${result.reason}` };
    if (!result.changed) {
      return { code: 0, message: `sync-version: ${VERSION_FILE} already reads ${version}` };
    }
    writeFileSync(path, result.text);
    return { code: 0, message: `sync-version: ${VERSION_FILE} now reads ${version}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an unparsable file";
    return { code: 1, message: `sync-version: could not read or write: ${code}` };
  }
}
