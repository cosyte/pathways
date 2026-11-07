/**
 * Unit tests for scripts/phi-scan.ts: the STARTER PHI commit-gate.
 *
 * These exercise the SHARED MACHINERY and the cross-cutting SSN/email FLOOR that
 * ships with the template. They deliberately do NOT test structured, field-level
 * PHI detection. That is format-specific and is the author's obligation to add
 * (see the STARTER banner in scripts/phi-scan.ts). When you add structured
 * detectors, add positive tests here proving they CATCH real-looking names /
 * DOBs / ids for this standard: a weak scanner is worse than none.
 *
 * The scanner is invoked via spawnSync (array args, no shell) so the full CLI
 * path (argv parse, exit code, stderr) is exercised. Violator/clean files are
 * written to a throwaway temp dir so they never pollute the committed corpus.
 *
 * SECURITY: every subprocess call here uses spawnSync with array args. No exec,
 * no shell-form.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();
const SCANNER_PATH = join(REPO_ROOT, "scripts", "phi-scan.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

let dir: string;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScanner(args: string[]): RunResult {
  const r = spawnSync(TSX_BIN, [SCANNER_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Write a file to the temp dir and scan it by path (paths mode, no git needed). */
function scan(name: string, content: string): RunResult {
  const path = join(dir, name);
  writeFileSync(path, content);
  return runScanner([path]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "phi-scan-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("phi-scan starter: the cross-cutting floor catches SSN + email", () => {
  it("catches a dashed SSN (exit 1), naming a position and never the token", () => {
    const r = scan("ssn.txt", "patient ssn 123-45-6789 on file\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/segment=\(ssn\)/);
    expect(r.stderr).toMatch(/dashed SSN/);
    // A REPORT IS A POSITION AND A RULE. stderr is a CI log, so a gate that quoted what it matched
    // would put the identifier somewhere with no retention policy: the finding names the file and
    // the rule, and the developer opens the file. This is the observable the suite asserts on;
    // looking for the payload would pass over a gate that echoes bytes it never graded.
    expect(r.stderr).not.toMatch(/123-45-6789/);
  });

  it("catches an email at a non-test domain (exit 1), naming a position and never the token", () => {
    const r = scan("email.txt", "contact jane.doe@hospital.org for records\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/segment=\(email\)/);
    expect(r.stderr).toMatch(/non-test domain/);
    expect(r.stderr).not.toMatch(/jane\.doe@hospital\.org/);
  });
});

describe("phi-scan starter: clean + allow-listed content passes", () => {
  it("a clean file with no PHI shapes exits 0", () => {
    const r = scan("clean.txt", "just some ordinary text, no identifiers here\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK: no hits/);
  });

  it("honors the allow-list: an email at a reserved test domain passes (exit 0)", () => {
    const r = scan("allowed-email.txt", "reach the team at hello@example.com anytime\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });
});

describe("phi-scan starter: paths mode reads EVERY path it was given", () => {
  it("a clean path first does not hide a violator second (exit 1, the violator named)", () => {
    // The floor-of-one polarity, pinned without needing an override entry. The
    // scanner used to have a whole-run floor of one: a run could enumerate more
    // than it read and still report clean. This is the cheap positive that
    // guards the read half of it in the template's own suite. The refusal half
    // needs a LOGGED bypass, which a committed template must not ship, so it is
    // exercised in `cosyte/config`'s `test/phi-scan-scaffold.test.ts` against a
    // throwaway scaffold instead.
    const clean = join(dir, "first-clean.txt");
    const violator = join(dir, "second-dirty.txt");
    writeFileSync(clean, "ordinary text\n");
    writeFileSync(violator, "patient ssn 123-45-6789 on file\n");
    const r = runScanner([clean, violator]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/second-dirty\.txt/);
    expect(r.stderr).toMatch(/segment=\(ssn\)/);
  });
});

describe("phi-scan starter: the override-log gate", () => {
  it("rejects --allow-fixture without a matching override entry (exit 2)", () => {
    const clean = join(dir, "override-me.txt");
    writeFileSync(clean, "nothing to see\n");
    const r = runScanner(["--allow-fixture", clean]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/phi-scan-overrides\.md/);
  });

  it("the hit footer does not advertise --allow-fixture as a remedy", () => {
    // A bypass withdraws a file from the read set, and the completeness rule
    // refuses (exit 2) over a target enumerated and never read. So the flag can
    // no longer reach exit 0, and printing it as the remedy for a hit would walk
    // a developer from exit 1 into exit 2: a printed remedy that cannot reach
    // the state it promises, which is a false green with the sign flipped.
    const r = scan("footer.txt", "patient ssn 123-45-6789 on file\n");
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/scripts\/phi-allow-list\.txt/);
    expect(r.stderr).not.toMatch(/run with --allow-fixture/);
    expect(r.stderr).toMatch(/REFUSED/);
  });
});
