import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The dashes are built from code points so this file never holds one itself.
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const SCRIPT = join(process.cwd(), "scripts", "check-no-emdash.mjs");

let dir: string;

function git(...args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function check(args: string[] = [], input?: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", input });
}

function track(path: string, contents: string | Buffer): void {
  writeFileSync(join(dir, path), contents);
  git("add", path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pathways-no-emdash-"));
  git("init", "-q");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-no-emdash over tracked files", () => {
  it("passes a tree with plain hyphens only", () => {
    track("a.md", "one - two\n");
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 tracked file(s)");
  });

  it("names the file, line and column of each dash, but not the line", () => {
    track("a.md", `fine\nSYNTHETIC ${EM} text ${EN} here\n`);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a.md:2:11: em dash");
    expect(result.stderr).toContain("a.md:2:18: en dash");
    expect(result.stderr).not.toContain("SYNTHETIC");
  });

  it("skips a binary file and says so", () => {
    track("blob.bin", Buffer.from([0x00, 0xe2, 0x80, 0x94]));
    track("a.md", "clean\n");
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 binary file(s) skipped");
  });

  it("gives no verdict when a tracked file cannot be read", () => {
    track("gone.md", "clean\n");
    rmSync(join(dir, "gone.md"));
    const result = check();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not read gone.md");
  });

  it("gives no verdict outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "pathways-no-git-"));
    mkdirSync(join(outside, "x"));
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: outside,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: outside },
    });
    rmSync(outside, { recursive: true, force: true });
    expect(result.status).toBe(2);
  });
});

describe("check-no-emdash over stdin", () => {
  it("passes clean text", () => {
    const result = check(["--stdin", "the pull request"], "title\nbody - fine\n");
    expect(result.status).toBe(0);
  });

  it("flags a dash in the labelled text", () => {
    const result = check(["--stdin", "the pull request"], `title\nbody ${EM} not fine\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the pull request: em dash at line 2, column 6");
  });

  it("refuses arguments it does not know", () => {
    expect(check(["--nope"]).status).toBe(2);
  });
});
