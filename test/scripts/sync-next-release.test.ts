/**
 * Tests for the README step the release's `version` script runs after `changeset version`.
 *
 * `changeset version` consumes every pending changeset into CHANGELOG.md and edits nothing else, so
 * without this step a Version Packages pull request keeps README bullets whose changesets are gone,
 * and `test/release-status.test.ts` fails on the very commit that releases. The first half drives the
 * pure rewrite. The second half lays out a throwaway copy of the repository's own README with
 * pending and consumed changesets and runs the step there, in this process and as a script started
 * with spawnSync and array arguments, never a shell.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pendingChangesets,
  rewriteNextRelease,
  syncNextRelease,
} from "../../scripts/next-release-sync.js";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts", "sync-next-release.ts");
/** tsx's command, run by Node, as in sync-version.test.ts: `.bin/tsx` is a shim on Windows. */
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const CONTENTS = [
  "## Contents",
  "",
  "- [Install](#install)",
  "- [In the next release](#in-the-next-release)",
  "- [Status](#status)",
  "",
].join("\n");

const SECTION = [
  "## In the next release",
  "",
  "These are on `main` and land in the next release, not in 0.0.3:",
  "",
  "- A synthetic shipped thing.",
  "  <!-- changesets: shipped-thing -->",
  "- A synthetic pending thing, over",
  "  two lines.",
  "  <!-- changesets: shipped-other, pending-thing -->",
  "",
  "The changelog lists each once it is released.",
  "",
  "---",
  "",
].join("\n");

const README = `# Synthetic\n\n${CONTENTS}\n---\n\n${SECTION}## Status\n\nEarly.\n`;

describe("rewriteNextRelease", () => {
  it("drops a bullet whose changesets are all consumed and names the new version", () => {
    const result = rewriteNextRelease(README, ["pending-thing"], "0.0.4");
    expect(result).toEqual({
      ok: true,
      changed: true,
      dropped: 1,
      kept: 1,
      text: README.replace(
        "- A synthetic shipped thing.\n  <!-- changesets: shipped-thing -->\n",
        "",
      ).replace("not in 0.0.3:", "not in 0.0.4:"),
    });
  });

  it("removes the section and its Contents line once every bullet is released", () => {
    const result = rewriteNextRelease(README, [], "0.0.4");
    expect(result).toEqual({
      ok: true,
      changed: true,
      dropped: 2,
      kept: 0,
      text: `# Synthetic\n\n${CONTENTS.replace("- [In the next release](#in-the-next-release)\n", "")}\n---\n\n## Status\n\nEarly.\n`,
    });
  });

  it("leaves a current section as it is", () => {
    const result = rewriteNextRelease(README, ["shipped-thing", "pending-thing"], "0.0.3");
    expect(result).toEqual({ ok: true, changed: false, dropped: 0, kept: 2, text: README });
  });

  it("keeps a bullet that names no changeset, for the release-status test to report", () => {
    const text = README.replace("  <!-- changesets: shipped-thing -->\n", "");
    const result = rewriteNextRelease(text, [], "0.0.4");
    expect(result.ok && result.kept).toBe(1);
    expect(result.ok && result.text).toContain("- A synthetic shipped thing.\n\nThe changelog");
  });

  it("leaves a README with no such section untouched", () => {
    const text = "# Synthetic\n\n## Status\n\nEarly.\n";
    expect(rewriteNextRelease(text, [], "0.0.4")).toEqual({
      ok: true,
      changed: false,
      dropped: 0,
      kept: 0,
      text,
    });
  });

  it("removes a section with no bullets once nothing is pending", () => {
    const text = "# Synthetic\n\n## In the next release\n\nNothing is pending.\n\n## Status\n";
    const result = rewriteNextRelease(text, [], "0.0.4");
    expect(result.ok && result.text).toBe("# Synthetic\n\n## Status\n");
  });

  it("removes a last section and the rule before it", () => {
    const text =
      "# Synthetic\n\nIntro.\n\n---\n\n## In the next release\n\n- Gone. <!-- changesets: a -->\n";
    const result = rewriteNextRelease(text, [], "0.0.4");
    expect(result.ok && result.text).toBe("# Synthetic\n\nIntro.\n");
  });

  it("keeps a last section that ends on its bullet", () => {
    const text =
      "## Contents\n\n## In the next release\n\nNot in 0.0.3:\n\n- Kept. <!-- changesets: a -->";
    const result = rewriteNextRelease(text, ["a"], "0.0.4");
    expect(result.ok && result.text).toBe(text.replace("0.0.3", "0.0.4"));
  });

  it("refuses a version a replacement could read as a pattern", () => {
    const result = rewriteNextRelease(README, ["pending-thing"], "1.0.0-$1");
    expect(result.ok).toBe(false);
  });

  it("refuses an empty version", () => {
    expect(rewriteNextRelease(README, [], "")).toEqual({
      ok: false,
      reason: "package.json has no usable version",
    });
  });
});

describe("syncNextRelease and the script", () => {
  let dir: string;

  /** A copy of the repository's own README with a changeset folder holding `pending`. */
  function layout(manifest: unknown, readme: string | null, pending: readonly string[]): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    if (readme !== null) writeFileSync(join(dir, "README.md"), readme);
    mkdirSync(join(dir, ".changeset"), { recursive: true });
    writeFileSync(join(dir, ".changeset", "README.md"), "# Changesets\n");
    writeFileSync(join(dir, ".changeset", "config.json"), "{}\n");
    for (const id of pending) {
      writeFileSync(
        join(dir, ".changeset", `${id}.md`),
        `---\n"@cosyte/pathways": patch\n---\n\nA synthetic ${id}.\n`,
      );
    }
  }

  /** The changeset ids each next-release bullet of `readme` names, as release-status reads them. */
  function bulletIds(readme: string): string[][] {
    const start = readme.indexOf("\n## In the next release\n");
    if (start === -1) return [];
    const rest = readme.slice(start + 1);
    const end = rest.indexOf("\n## ", 1);
    return (end === -1 ? rest : rest.slice(0, end))
      .split(/^- /m)
      .slice(1)
      .map((b) => /<!--\s*changesets:\s*([\w\s,-]+?)\s*-->/.exec(b)?.[1]?.split(/[\s,]+/) ?? []);
  }

  function run(): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [TSX, SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  const repoReadme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pathways-next-release-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the pending changesets, sorted, the folder's README aside", () => {
    layout({ version: "0.0.4" }, null, ["b-thing", "a-thing"]);
    expect(pendingChangesets(join(dir, ".changeset"))).toEqual(["a-thing", "b-thing"]);
    expect(pendingChangesets(join(dir, "nowhere"))).toEqual([]);
  });

  // The Version Packages commit: `changeset version` consumed every changeset.
  it("leaves the repository's README with no released bullet once all are consumed", () => {
    layout({ version: "9.9.9" }, repoReadme, []);
    expect(syncNextRelease(dir).code).toBe(0);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    expect(bulletIds(after)).toEqual([]);
    expect(after).not.toContain("(#in-the-next-release)");
  });

  it("writes and says what it dropped", () => {
    layout({ version: "0.0.4" }, README, ["pending-thing"]);
    expect(syncNextRelease(dir)).toEqual({
      code: 0,
      message:
        "sync-next-release: README.md dropped 1 released bullet(s); 1 left, the lead names 0.0.4",
    });
  });

  it("says when the section is gone", () => {
    layout({ version: "0.0.4" }, README, []);
    expect(syncNextRelease(dir)).toEqual({
      code: 0,
      message: "sync-next-release: README.md dropped 2 released bullet(s); the section is gone",
    });
  });

  it("leaves a current README untouched", () => {
    layout({ version: "0.0.3" }, README, ["shipped-thing", "pending-thing"]);
    const before = statSync(join(dir, "README.md")).mtimeMs;
    expect(syncNextRelease(dir)).toEqual({
      code: 0,
      message: "sync-next-release: README.md already lists only pending work",
    });
    expect(statSync(join(dir, "README.md")).mtimeMs).toBe(before);
  });

  it("refuses a manifest whose version is not a string", () => {
    layout({ version: 1 }, README, []);
    expect(syncNextRelease(dir)).toEqual({
      code: 1,
      message: "sync-next-release: package.json has no usable version",
    });
  });

  it("refuses a manifest that is not an object", () => {
    layout(null, README, []);
    expect(syncNextRelease(dir).code).toBe(1);
    layout("0.0.4", README, []);
    expect(syncNextRelease(dir).code).toBe(1);
    layout({ name: "synthetic" }, README, []);
    expect(syncNextRelease(dir).code).toBe(1);
  });

  it("refuses an unusable version and does not write", () => {
    layout({ version: '1.0.0"' }, README, []);
    expect(syncNextRelease(dir)).toEqual({
      code: 1,
      message: "sync-next-release: README.md: package.json has no usable version",
    });
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(README);
  });

  it("refuses, rather than crashes, when the README cannot be read", () => {
    layout({ version: "0.0.4" }, null, []);
    const result = syncNextRelease(dir);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/^sync-next-release: could not read or write: /);
  });

  it("refuses, rather than crashes, when package.json does not parse", () => {
    layout({ version: "0.0.4" }, README, []);
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(syncNextRelease(dir)).toEqual({
      code: 1,
      message: "sync-next-release: could not read or write: an unparsable file",
    });
  });

  it("runs as a script: exit 0, the report on stderr, stdout empty", () => {
    layout({ version: "0.0.4" }, README, []);
    expect(run()).toEqual({
      code: 0,
      stdout: "",
      stderr: "sync-next-release: README.md dropped 2 released bullet(s); the section is gone\n",
    });
    expect(readFileSync(join(dir, "README.md"), "utf8")).not.toContain("## In the next release");
  });

  // The same entry point loaded in this process, so the coverage report sees its lines too.
  it("sets the exit code and writes the one report line from the working directory", async () => {
    layout({ version: "0.0.4" }, README, ["shipped-thing", "pending-thing"]);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitCode = process.exitCode;
    try {
      await import("../../scripts/sync-next-release.js");
      expect(process.exitCode).toBe(0);
      expect(stderr).toHaveBeenCalledWith(
        "sync-next-release: README.md dropped 0 released bullet(s); 2 left, the lead names 0.0.4\n",
      );
    } finally {
      process.exitCode = exitCode;
      cwd.mockRestore();
      stderr.mockRestore();
    }
  });

  it("runs as a script: exit 1 on a refusal", () => {
    layout({ version: 7 }, README, []);
    const result = run();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no usable version");
  });
});
