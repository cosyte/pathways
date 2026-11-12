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

const LATEST = [
  "## What the latest release ships",
  "",
  "What follows is in 0.0.3, the version on npm:",
  "",
  "- **Old.** A synthetic thing an earlier release shipped.",
  "",
  "---",
  "",
].join("\n");

const STATUS = "## Status\n\nEarly, and released: 0.0.3 is on npm.\n";

/** A version named as the one on npm, as the release-status test reads it. */
const ON_NPM = /\b\d+\.\d+\.\d+(?=,\s+the\s+version\s+on\s+npm\b|\s+is\s+on\s+npm\b)/g;

const README = `# Synthetic\n\n${CONTENTS}\n---\n\n${LATEST}${SECTION}${STATUS}`;

/** The README with the latest-release list holding `moved` and every on-npm line naming 0.0.4. */
function released(text: string, moved: readonly string[]): string {
  return text
    .replace(
      "- **Old.** A synthetic thing an earlier release shipped.\n",
      ["- **Old.** A synthetic thing an earlier release shipped.", ...moved, ""].join("\n"),
    )
    .replace("in 0.0.3, the version on npm", "in 0.0.4, the version on npm")
    .replace("0.0.3 is on npm", "0.0.4 is on npm");
}

describe("rewriteNextRelease", () => {
  it("moves a released bullet up, without its comment, and names the new version", () => {
    const result = rewriteNextRelease(README, ["pending-thing"], "0.0.4");
    expect(result).toEqual({
      ok: true,
      changed: true,
      moved: 1,
      kept: 1,
      narrowed: 1,
      text: released(README, ["- A synthetic shipped thing."])
        .replace("- A synthetic shipped thing.\n  <!-- changesets: shipped-thing -->\n", "")
        .replace("not in 0.0.3:", "not in 0.0.4:")
        .replace("shipped-other, pending-thing", "pending-thing"),
    });
  });

  it("moves every bullet up and removes the section and its Contents line", () => {
    const result = rewriteNextRelease(README, [], "0.0.4");
    expect(result).toEqual({
      ok: true,
      changed: true,
      moved: 2,
      kept: 0,
      narrowed: 0,
      text: `# Synthetic\n\n${CONTENTS.replace("- [In the next release](#in-the-next-release)\n", "")}\n---\n\n${released(
        LATEST,
        ["- A synthetic shipped thing.", "- A synthetic pending thing, over", "  two lines."],
      )}${released(STATUS, [])}`,
    });
  });

  it("leaves a current section as it is", () => {
    const text = README.replace("shipped-other, pending-thing", "pending-thing");
    const result = rewriteNextRelease(text, ["shipped-thing", "pending-thing"], "0.0.3");
    expect(result).toEqual({ ok: true, changed: false, moved: 0, kept: 2, narrowed: 0, text });
  });

  // release-status fails a next-release bullet that names any consumed changeset, so a bullet with
  // one consumed and one pending stays, naming only the pending one: part of it is not out yet.
  it("keeps a bullet naming a consumed and a pending changeset, naming only the pending one", () => {
    const result = rewriteNextRelease(README, ["shipped-thing", "pending-thing"], "0.0.4");
    expect(result.ok && result.narrowed).toBe(1);
    expect(result.ok && result.text).toContain(
      "- A synthetic pending thing, over\n  two lines.\n  <!-- changesets: pending-thing -->\n",
    );
    expect(result.ok && result.text).not.toContain("shipped-other");
  });

  it("keeps a bullet that names no changeset, for the release-status test to report", () => {
    const text = README.replace("  <!-- changesets: shipped-thing -->\n", "");
    const result = rewriteNextRelease(text, [], "0.0.4");
    expect(result.ok && result.kept).toBe(1);
    expect(result.ok && result.text).toContain("- A synthetic shipped thing.\n\nThe changelog");
  });

  it("keeps a pending bullet in a list whose bullets are separated by blank lines", () => {
    const text = README.replace(
      "  <!-- changesets: shipped-thing -->\n- A synthetic pending",
      "  <!-- changesets: shipped-thing -->\n\n- A synthetic pending",
    );
    const result = rewriteNextRelease(text, ["pending-thing"], "0.0.4");
    expect(result.ok && result.moved).toBe(1);
    expect(result.ok && result.kept).toBe(1);
    expect(result.ok && result.text).toContain(
      "not in 0.0.4:\n\n- A synthetic pending thing, over\n  two lines.\n  <!-- changesets: pending-thing -->\n\nThe changelog",
    );
  });

  it("keeps the blank lines between the bullets it keeps in such a list", () => {
    const text = [
      "# Synthetic\n\n## What the latest release ships\n\nIn 0.0.3, the version on npm:\n\n- **Old.** Shipped.\n",
      "## In the next release\n\n- Gone. <!-- changesets: a -->\n\n- One. <!-- changesets: b -->",
      "  More of one.\n\n  A second paragraph of one.\n\n- Two. <!-- changesets: c -->\n\nEnd.\n",
    ].join("\n");
    const result = rewriteNextRelease(text, ["b", "c"], "0.0.4");
    expect(result.ok && result.text).toContain(
      "\n- One. <!-- changesets: b -->\n  More of one.\n\n  A second paragraph of one.\n\n- Two. <!-- changesets: c -->\n\nEnd.\n",
    );
    expect(result.ok && result.text).toContain("- **Old.** Shipped.\n- Gone.\n");
  });

  it("removes a comment on a bullet's own line and its trailing space when moving it", () => {
    const text = README.replace(
      "  <!-- changesets: shipped-thing -->\n",
      "  in two lines. <!-- changesets: shipped-thing -->  \n",
    );
    const result = rewriteNextRelease(text, ["pending-thing"], "0.0.4");
    expect(result.ok && result.text).toContain(
      "- **Old.** A synthetic thing an earlier release shipped.\n- A synthetic shipped thing.\n  in two lines.\n\n---",
    );
  });

  it("rewrites the version lines when the README has no next-release section", () => {
    const text = `# Synthetic\n\n${LATEST}${STATUS}`;
    expect(rewriteNextRelease(text, [], "0.0.4")).toEqual({
      ok: true,
      changed: true,
      moved: 0,
      kept: 0,
      narrowed: 0,
      text: released(text, []),
    });
  });

  it("rewrites a version line wrapped over two lines", () => {
    const text = "# Synthetic\n\nEarly, and released:\n0.0.3\nis on npm.\n";
    const result = rewriteNextRelease(text, [], "0.0.4");
    expect(result.ok && result.text).toBe(
      "# Synthetic\n\nEarly, and released:\n0.0.4\nis on npm.\n",
    );
  });

  it("leaves a README with no such sections untouched", () => {
    const text = "# Synthetic\n\n## Status\n\nEarly.\n";
    expect(rewriteNextRelease(text, [], "0.0.4")).toEqual({
      ok: true,
      changed: false,
      moved: 0,
      kept: 0,
      narrowed: 0,
      text,
    });
  });

  it("removes a section with no bullets once nothing is pending", () => {
    const text = "# Synthetic\n\n## In the next release\n\nNothing is pending.\n\n## Status\n";
    const result = rewriteNextRelease(text, [], "0.0.4");
    expect(result.ok && result.text).toBe("# Synthetic\n\n## Status\n");
  });

  it("removes a last section and the rule before it", () => {
    const text = `# Synthetic\n\n${LATEST}## In the next release\n\n- Gone. <!-- changesets: a -->\n`;
    const result = rewriteNextRelease(text, [], "0.0.4");
    expect(result.ok && result.text).toBe(
      `# Synthetic\n\n${released(LATEST, ["- Gone."])}`.replace(/\n+---\n+$/, "\n"),
    );
  });

  it("keeps a last section that ends on its bullet", () => {
    const text =
      "## Contents\n\n## In the next release\n\nNot in 0.0.3:\n\n- Kept. <!-- changesets: a -->";
    const result = rewriteNextRelease(text, ["a"], "0.0.4");
    expect(result.ok && result.text).toBe(text.replace("0.0.3", "0.0.4"));
  });

  it("refuses to move a released bullet when there is no latest-release list to hold it", () => {
    const noLatest = README.replace(LATEST, "");
    expect(rewriteNextRelease(noLatest, ["pending-thing"], "0.0.4")).toEqual({
      ok: false,
      reason: "1 released bullet(s) have no What the latest release ships list to move into",
    });
    const noList = README.replace("- **Old.** A synthetic thing an earlier release shipped.\n", "");
    expect(rewriteNextRelease(noList, ["pending-thing"], "0.0.4").ok).toBe(false);
  });

  it("writes a CRLF README back with CRLF line endings", () => {
    const result = rewriteNextRelease(README.replace(/\n/g, "\r\n"), ["pending-thing"], "0.0.4");
    const lf = rewriteNextRelease(README, ["pending-thing"], "0.0.4");
    expect(result.ok && lf.ok && result.text).toBe(lf.ok && lf.text.replace(/\n/g, "\r\n"));
  });

  it("refuses a README that mixes line endings", () => {
    expect(rewriteNextRelease(README.replace("\n", "\r\n"), [], "0.0.4")).toEqual({
      ok: false,
      reason: "it mixes CRLF and LF line endings",
    });
    expect(rewriteNextRelease(README.replace("\n", "\r"), [], "0.0.4").ok).toBe(false);
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

  /** A section of `readme` from its heading to the next one. */
  function sectionOf(readme: string, heading: string): string {
    const start = readme.indexOf(`\n${heading}\n`);
    if (start === -1) return "";
    const rest = readme.slice(start + 1);
    const end = rest.indexOf("\n## ", 1);
    return end === -1 ? rest : rest.slice(0, end);
  }

  /** Each next-release bullet of `readme`, as it reads once moved: its comment line gone. */
  function nextReleaseTexts(readme: string): string[] {
    return sectionOf(readme, "## In the next release")
      .split(/^(?=- )/m)
      .slice(1)
      .map((b) => (b.split(/\n\n/)[0] ?? b).replace(/\n\s*<!--[^>]*-->/, "").trimEnd());
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

  // What npm shows for the release: every bullet it shipped is under What the latest release ships,
  // without its comment, and the README names the new version as the one on npm. On the Version
  // Packages commit itself the README has no next-release bullets left, and this still holds.
  it("moves the repository's released bullets up and names the new version on npm", () => {
    const bullets = nextReleaseTexts(repoReadme);
    layout({ version: "9.9.9" }, repoReadme, []);
    expect(syncNextRelease(dir).code).toBe(0);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    const latest = sectionOf(after, "## What the latest release ships");
    for (const bullet of bullets) expect(latest).toContain(bullet);
    expect(latest).not.toContain("<!--");
    expect([...after.matchAll(ON_NPM)].map((m) => m[0])).toEqual(
      [...repoReadme.matchAll(ON_NPM)].map(() => "9.9.9"),
    );
    expect([...after.matchAll(ON_NPM)].length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the repository's pending bullets where they are", () => {
    const ids = bulletIds(repoReadme).flat();
    const last = ids.at(-1);
    layout({ version: "9.9.9" }, repoReadme, last === undefined ? [] : [last]);
    expect(syncNextRelease(dir).code).toBe(0);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    expect(bulletIds(after)).toEqual(last === undefined ? [] : [[last]]);
  });

  it("writes and says what it moved", () => {
    layout({ version: "0.0.4" }, README, ["pending-thing"]);
    expect(syncNextRelease(dir)).toEqual({
      code: 0,
      message:
        "sync-next-release: README.md moved 1 released bullet(s) up; 1 left, 1 naming only pending changesets; the version lines name 0.0.4",
    });
  });

  it("says when nothing is left", () => {
    layout({ version: "0.0.4" }, README, []);
    expect(syncNextRelease(dir)).toEqual({
      code: 0,
      message:
        "sync-next-release: README.md moved 2 released bullet(s) up; 0 left; the version lines name 0.0.4",
    });
  });

  it("leaves a current README untouched", () => {
    layout({ version: "0.0.3" }, README.replace("shipped-other, ", ""), [
      "shipped-thing",
      "pending-thing",
    ]);
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
      stderr:
        "sync-next-release: README.md moved 2 released bullet(s) up; 0 left; the version lines name 0.0.4\n",
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
        "sync-next-release: README.md moved 0 released bullet(s) up; 2 left, 1 naming only pending changesets; the version lines name 0.0.4\n",
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
