import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// Once a version is released (package.json holds it and CHANGELOG.md has its heading), the pages a
// reader lands on first stop saying the package is not, and the README's "In the next release"
// lists only what no release has shipped yet. Each bullet there names the changesets it stands for
// in an HTML comment, `<!-- changesets: tcp-connector -->`. The release pull request consumes those
// changesets into CHANGELOG.md, so this test fails on it until the bullet moves up. With no
// changeset pending, the section may be empty or gone; while one is, it lists at least one bullet.

const ROOT = join(import.meta.dirname, "..");

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

interface PackageJson {
  readonly version: string;
  readonly description: string;
}

const pkg = JSON.parse(read("package.json")) as PackageJson;
const changelog = read("CHANGELOG.md");

const UNRELEASED = [
  /\bnot (?:yet )?released\b/i,
  /\bnot yet (?:been )?(?:released|published)\b/i,
  /\bunpublished\b/i,
  /\bnot (?:yet )?(?:on|published to|available on) npm\b/i,
  /\bnothing (?:here )?is ready to run\b/i,
  /\buntil the first release\b/i,
  /\bfirst release waits\b/i,
  /\(once released\)/i,
  /\bwill be published to npm\b/i,
];

function unreleasedClaims(text: string): string[] {
  const flat = text.replace(/\s*\n\s*/g, " ");
  return UNRELEASED.flatMap((p) => {
    const m = p.exec(flat);
    return m ? [m[0]] : [];
  });
}

/** The text under each released `## x.y.z` heading of CHANGELOG.md, joined. */
function releasedChangelog(): string {
  const sections = changelog.split(/^## /m).slice(1);
  return sections.filter((s) => /^\d+\.\d+\.\d+\s*$/.test(s.slice(0, s.indexOf("\n")))).join("\n");
}

/** The bullets of the README's "In the next release" section, each with its body. */
function nextReleaseBullets(readme: string): string[] {
  const start = readme.indexOf("\n## In the next release\n");
  if (start === -1) return [];
  const rest = readme.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section
    .split(/^- /m)
    .slice(1)
    .map((b) => b.split(/\n\n/)[0] ?? b);
}

/** The first line of a pending changeset's summary, or undefined once it is consumed. */
function changesetSummary(dir: string, id: string): string | undefined {
  const file = join(dir, `${id}.md`);
  if (!existsSync(file)) return undefined;
  const body = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  return body.trim().split("\n")[0];
}

/** The ids of the changesets still pending in a changeset folder, its own README aside. */
function pendingChangesets(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.slice(0, -".md".length))
    .sort();
}

/**
 * Why the README's "In the next release" is missing, or nothing when it may be empty. While a
 * changeset is pending it lists at least one bullet; once a release consumed every changeset (the
 * Version Packages pull request, and main right after a release) it may be empty or absent. Not
 * every pending changeset needs a bullet: a small fix can ship without a README line.
 */
function missingNextRelease(readme: string, dir: string): string[] {
  if (nextReleaseBullets(readme).length > 0) return [];
  const pending = pendingChangesets(dir);
  if (pending.length === 0) return [];
  return [
    `the README lists nothing in the next release, but these are pending: ${pending.join(", ")}`,
  ];
}

/** Why each next-release bullet is out of date, or nothing when every one is still unreleased. */
function staleNextRelease(readme: string, released: string, dir: string): string[] {
  return nextReleaseBullets(readme).flatMap((bullet) => {
    const label = (bullet.split("<!--")[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const ids = /<!--\s*changesets:\s*([\w\s,-]+?)\s*-->/.exec(bullet)?.[1]?.split(/[\s,]+/) ?? [];
    if (ids.length === 0) return [`"${label}" names no changeset`];
    return ids.flatMap((id) => {
      const summary = changesetSummary(dir, id);
      if (summary === undefined) return [`"${label}": changeset ${id} is consumed, so released`];
      if (released.includes(summary)) return [`"${label}": ${id} is in a released version`];
      return [];
    });
  });
}

describe("release status", () => {
  it("holds a released version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(changelog.split("\n")).toContain(`## ${pkg.version}`);
  });

  for (const file of ["README.md", "docs-content/intro.md", "AGENTS.md", "CLAUDE.md"]) {
    it(`${file} does not say the package is unreleased`, () => {
      expect(unreleasedClaims(read(file))).toEqual([]);
    });
  }

  it("package.json's description does not say the package is unreleased", () => {
    expect(unreleasedClaims(pkg.description)).toEqual([]);
  });

  it("the README lists something in the next release while a changeset is pending", () => {
    expect(missingNextRelease(read("README.md"), join(ROOT, ".changeset"))).toEqual([]);
  });

  it("the README's In the next release lists nothing a released version holds", () => {
    expect(
      staleNextRelease(read("README.md"), releasedChangelog(), join(ROOT, ".changeset")),
    ).toEqual([]);
  });

  describe("the next-release check itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-status-"));
    writeFileSync(
      join(dir, "pending-thing.md"),
      '---\n"@cosyte/pathways": patch\n---\n\nA synthetic pending thing.\n\nMore detail.\n',
    );
    const empty = mkdtempSync(join(tmpdir(), "release-status-"));
    writeFileSync(join(empty, "README.md"), "# Changesets\n");
    writeFileSync(join(empty, "config.json"), "{}\n");
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    });

    const readme = (bullets: string[]): string =>
      ["", "## In the next release", "", ...bullets, "", "## Status", ""].join("\n");

    it("passes a bullet whose changeset is pending and unreleased", () => {
      const text = readme(["- A pending thing. <!-- changesets: pending-thing -->"]);
      expect(staleNextRelease(text, "## 0.0.1\n\n- abc1234: Something else.", dir)).toEqual([]);
    });

    it("fails a bullet whose changeset a release consumed", () => {
      const text = readme(["- A shipped thing. <!-- changesets: pending-thing, gone-thing -->"]);
      expect(staleNextRelease(text, "", dir)).toEqual([
        '"A shipped thing.": changeset gone-thing is consumed, so released',
      ]);
    });

    it("fails a bullet whose changeset text is under a released version", () => {
      const text = readme(["- A pending thing. <!-- changesets: pending-thing -->"]);
      expect(staleNextRelease(text, "- abc1234: A synthetic pending thing.", dir)).toEqual([
        '"A pending thing.": pending-thing is in a released version',
      ]);
    });

    it("fails a bullet that names no changeset", () => {
      expect(staleNextRelease(readme(["- A thing with no reference."]), "", dir)).toEqual([
        '"A thing with no reference." names no changeset',
      ]);
    });

    it("fails an empty or absent section while a changeset is pending", () => {
      const problem = [
        "the README lists nothing in the next release, but these are pending: pending-thing",
      ];
      expect(missingNextRelease(readme([]), dir)).toEqual(problem);
      expect(missingNextRelease("\n## Status\n", dir)).toEqual(problem);
    });

    it("passes an empty or absent section once a release consumed every changeset", () => {
      // The state of a Version Packages pull request, and of main right after a release.
      expect(missingNextRelease(readme([]), empty)).toEqual([]);
      expect(missingNextRelease(readme(["Nothing is pending."]), empty)).toEqual([]);
      expect(missingNextRelease("\n## Status\n", empty)).toEqual([]);
      expect(staleNextRelease(readme([]), "", empty)).toEqual([]);
    });

    it("still fails a leftover bullet once a release consumed every changeset", () => {
      const text = readme(["- A shipped thing. <!-- changesets: pending-thing -->"]);
      expect(staleNextRelease(text, "", empty)).toEqual([
        '"A shipped thing.": changeset pending-thing is consumed, so released',
      ]);
    });
  });
});
