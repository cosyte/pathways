/**
 * Tests for the version sync the release's `version` script runs after `changeset version`.
 *
 * Changesets rewrites `package.json`'s version and nothing else, so without this step a Version
 * Packages pull request would bump the manifest and leave `VERSION` behind, and the suite's
 * "VERSION equals package.json's version" test would fail on the very commit that releases. The
 * shared `cosyte-process sync-version` reads `src/index.ts`; ours lives in `src/version.ts`, which
 * the CLI and `pathways init` import without loading the whole package, so the sync is ours too.
 *
 * The first half drives the pure rewrite. The second half runs the script itself in a throwaway
 * directory with spawnSync and array arguments, never a shell, so the exit code, the streams and
 * the file on disk are what is asserted.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rewriteVersion, syncVersion } from "../../scripts/version-sync.js";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts", "sync-version.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

const DOC = '/** The version. */\nexport const VERSION = "0.0.0";\n';

describe("rewriteVersion", () => {
  it("writes the manifest's version into the one declaration", () => {
    expect(rewriteVersion(DOC, "0.1.0")).toEqual({
      ok: true,
      changed: true,
      text: '/** The version. */\nexport const VERSION = "0.1.0";\n',
    });
  });

  it("reports an already-synced source as unchanged and returns it as is", () => {
    expect(rewriteVersion(DOC, "0.0.0")).toEqual({ ok: true, changed: false, text: DOC });
  });

  it("splices the version literally, never as a replacement pattern", () => {
    const result = rewriteVersion(DOC, "1.0.0-$&.$1");
    expect(result).toEqual({
      ok: true,
      changed: true,
      text: '/** The version. */\nexport const VERSION = "1.0.0-$&.$1";\n',
    });
  });

  it("refuses an empty version", () => {
    expect(rewriteVersion(DOC, "")).toEqual({
      ok: false,
      reason: "package.json has no usable version",
    });
  });

  it("refuses a version that would break out of the string literal", () => {
    expect(rewriteVersion(DOC, '1.0.0"; evil()')).toEqual({
      ok: false,
      reason: "package.json has no usable version",
    });
  });

  it("refuses a source with no declaration, so a rename cannot pass silently", () => {
    expect(rewriteVersion("export const PACKAGE_VERSION = '0.0.0';\n", "0.1.0")).toEqual({
      ok: false,
      reason: 'found no `export const VERSION = "...";` line at column 0',
    });
  });

  it("does not take an indented or commented declaration for the real one", () => {
    const source = ' * export const VERSION = "9.9.9";\n  export const VERSION = "9.9.9";\n';
    expect(rewriteVersion(source, "0.1.0").ok).toBe(false);
  });

  it("refuses two declarations, so the first one cannot win by position", () => {
    expect(rewriteVersion(`${DOC}${DOC}`, "0.1.0")).toEqual({
      ok: false,
      reason: 'found 2 `export const VERSION = "...";` lines; expected exactly one',
    });
  });
});

describe("syncVersion and the script", () => {
  let dir: string;

  function layout(manifest: unknown, source: string | null): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    if (source !== null) {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "version.ts"), source);
    }
  }

  function run(): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(TSX_BIN, [SCRIPT], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pathways-sync-version-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the new version and says so", () => {
    layout({ version: "0.2.0" }, DOC);
    expect(syncVersion(dir)).toEqual({
      code: 0,
      message: "sync-version: src/version.ts now reads 0.2.0",
    });
    expect(readFileSync(join(dir, "src", "version.ts"), "utf8")).toContain('VERSION = "0.2.0";');
  });

  it("leaves an already-synced file untouched", () => {
    layout({ version: "0.0.0" }, DOC);
    const before = statSync(join(dir, "src", "version.ts")).mtimeMs;
    expect(syncVersion(dir)).toEqual({
      code: 0,
      message: "sync-version: src/version.ts already reads 0.0.0",
    });
    expect(statSync(join(dir, "src", "version.ts")).mtimeMs).toBe(before);
  });

  it("refuses a manifest whose version is not a string", () => {
    layout({ version: 1 }, DOC);
    expect(syncVersion(dir)).toEqual({
      code: 1,
      message: "sync-version: package.json has no usable version",
    });
  });

  it("refuses a manifest that is not an object", () => {
    layout(null, DOC);
    expect(syncVersion(dir).code).toBe(1);
  });

  it("names the file when the declaration is missing, and does not write", () => {
    layout({ version: "0.2.0" }, "export {};\n");
    expect(syncVersion(dir)).toEqual({
      code: 1,
      message:
        'sync-version: src/version.ts: found no `export const VERSION = "...";` line at column 0',
    });
    expect(readFileSync(join(dir, "src", "version.ts"), "utf8")).toBe("export {};\n");
  });

  it("refuses, rather than crashes, when a file cannot be read", () => {
    layout({ version: "0.2.0" }, null);
    const result = syncVersion(dir);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/^sync-version: could not read or write: /);
  });

  it("refuses, rather than crashes, when package.json does not parse", () => {
    layout({ version: "0.2.0" }, DOC);
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(syncVersion(dir)).toEqual({
      code: 1,
      message: "sync-version: could not read or write: an unparsable file",
    });
  });

  it("runs as a script: exit 0, the report on stderr, stdout empty", () => {
    layout({ version: "0.3.0" }, DOC);
    const result = run();
    expect(result).toEqual({
      code: 0,
      stdout: "",
      stderr: "sync-version: src/version.ts now reads 0.3.0\n",
    });
    expect(readFileSync(join(dir, "src", "version.ts"), "utf8")).toContain('VERSION = "0.3.0";');
  });

  // The same entry point loaded in this process, so the coverage report sees its lines too.
  it("sets the exit code and writes the one report line from the working directory", async () => {
    layout({ version: "0.4.0" }, DOC);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitCode = process.exitCode;
    try {
      await import("../../scripts/sync-version.js");
      expect(process.exitCode).toBe(0);
      expect(stderr).toHaveBeenCalledWith("sync-version: src/version.ts now reads 0.4.0\n");
    } finally {
      process.exitCode = exitCode;
      cwd.mockRestore();
      stderr.mockRestore();
    }
  });

  it("runs as a script: exit 1 on a refusal", () => {
    layout({ version: "0.3.0" }, "export {};\n");
    const result = run();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("found no `export const VERSION");
  });
});
