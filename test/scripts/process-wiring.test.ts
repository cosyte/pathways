/**
 * The gate on this repo's shared-process wiring: `cosyte-process check` from @cosyte/process.
 *
 * It runs from the suite, so it sits inside the required `ci / verify` contexts: a check with a
 * workflow of its own would report under a context no ruleset names, and block nothing. It is also
 * reachable by hand as `pnpm check:process`.
 *
 * What the check grades, and nothing else: the five verb scripts (`build`, `test`, `lint`,
 * `typecheck`, `format`) each exactly `cosyte-process <verb>`; every reserved variant that is
 * present (`test:watch`, `test:coverage`, `lint:fix`, `format:check`) exactly
 * `cosyte-process <verb> <modifier>`; `cosyte-process.config.json` absent or valid; and a direct
 * `vitest` absent or exactly the version process runs.
 *
 * The cases: the real tree passes; its bodies are what this file says, read from package.json
 * rather than from the checker's verdict; a hand-edited body fails (without that negative control a
 * pass proves nothing); and the one tool kept as a direct devDependency, `vitest`, which test files
 * import for its types, is exactly process's pin, with a caret range failing the gate.
 *
 * Fixtures are throwaway directories in a temp dir, because the check reads the package.json of the
 * directory it runs in. Every subprocess is spawnSync with array arguments, never a shell.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

/** What `pnpm check:process` runs: the bin pnpm linked for `@cosyte/process`. */
const BIN = join(REPO_ROOT, "node_modules", ".bin", "cosyte-process");

const VERBS = ["build", "test", "lint", "typecheck", "format"] as const;
const VARIANTS: readonly (readonly [string, string])[] = [
  ["test:watch", "cosyte-process test --watch"],
  ["test:coverage", "cosyte-process test --coverage"],
  ["lint:fix", "cosyte-process lint --fix"],
  ["format:check", "cosyte-process format --check"],
];

const DELEGATED: Record<string, string> = Object.fromEntries(
  VERBS.map((verb) => [verb, `cosyte-process ${verb}`]),
);

interface RunResult {
  readonly code: number;
  readonly out: string;
}

function check(cwd: string): RunResult {
  const result = spawnSync(BIN, ["check"], { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

/** One string-valued field of a manifest, read as text and parsed here. */
function field(manifestPath: string, name: string): Record<string, string> {
  const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error(`${manifestPath} is not an object`);
  const value: unknown = (raw as Record<string, unknown>)[name];
  if (typeof value !== "object" || value === null) throw new Error(`${manifestPath}: no ${name}`);
  return value as Record<string, string>;
}

/** The tool versions @cosyte/process pins, from its installed manifest. */
function processTools(): Record<string, string> {
  const dir = realpathSync(join(REPO_ROOT, "node_modules", "@cosyte", "process"));
  return field(join(dir, "package.json"), "dependencies");
}

let root: string;

function fixture(
  name: string,
  scripts: Record<string, string>,
  devDependencies?: Record<string, string>,
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const manifest = { name: `fixture-${name}`, version: "0.0.0", scripts, devDependencies };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pathways-process-wiring-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("shared-process wiring", () => {
  it("passes cosyte-process check on this repository", () => {
    const result = check(REPO_ROOT);
    expect(result.out).not.toContain("cosyte-process.config.json");
    expect(result.code).toBe(0);
  });

  it("has the bodies this file claims, read from package.json rather than from the check", () => {
    const scripts = field(join(REPO_ROOT, "package.json"), "scripts");
    for (const verb of VERBS) expect(scripts[verb]).toBe(`cosyte-process ${verb}`);
    for (const [name, body] of VARIANTS) expect(scripts[name]).toBe(body);
    expect(scripts["check:process"]).toBe("cosyte-process check");
  });

  it("fails a hand-edited verb body, naming the script", () => {
    const result = check(fixture("drifted", { ...DELEGATED, test: "vitest run" }));
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("test");
  });

  it("keeps vitest direct only at exactly the version process runs, and no other tool", () => {
    const own = field(join(REPO_ROOT, "package.json"), "devDependencies");
    const tools = processTools();
    expect(tools["vitest"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(own["vitest"]).toBe(tools["vitest"]);
    for (const tool of ["tsup", "eslint", "prettier", "typescript", "@vitest/coverage-v8"]) {
      expect(Object.hasOwn(own, tool), tool).toBe(false);
    }
  });

  it("fails a direct vitest that is a range rather than process's pin", () => {
    const pinned = processTools()["vitest"] ?? "";
    expect(check(fixture("vitest-exact", DELEGATED, { vitest: pinned })).code).toBe(0);
    const result = check(fixture("vitest-range", DELEGATED, { vitest: `^${pinned}` }));
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("vitest");
  });
});
