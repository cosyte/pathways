// croner reads cron expressions, which only a source whose `poll` sets `cron` has, so loading the
// configuration and its schedule must not load it: `pathways start` would pay for its import on every
// project. These run the modules in a fresh Node process (which strips their types), with a resolve
// hook that maps the sources' `.js` specifiers to their `.ts` files and records every module it
// reaches.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Runs `body` as an ES module in a fresh process, after a hook that records what resolves. */
function run(body: string): { status: number | null; stdout: string; stderr: string } {
  const script = [
    'import { registerHooks } from "node:module";',
    "const resolved = [];",
    "registerHooks({ resolve(specifier, context, next) {",
    "  let result;",
    "  try { result = next(specifier, context); } catch (error) {",
    "    if (!specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;",
    "    result = next(specifier.slice(0, -3) + '.ts', context);",
    "  }",
    "  resolved.push(result.url);",
    "  return result;",
    "} });",
    "const loadedCroner = () => resolved.some((url) => url.includes('/croner'));",
    body,
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", script],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("loading croner", () => {
  it("does not load it when the configuration schema and the schedule are imported", () => {
    const { status, stdout, stderr } = run(
      [
        'const { pollOf } = await import("./src/engine/schedule.ts");',
        "pollOf({ source: { kind: 'file', dir: 'in' } }, 1000);",
        "process.stdout.write(String(loadedCroner()));",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toBe("false");
  });

  it("loads it on the first cron schedule read, as the module an import gives", () => {
    const { status, stdout, stderr } = run(
      [
        'const { cronClass } = await import("./src/config/cron.ts");',
        'const { Cron } = await import("croner");',
        "const first = cronClass();",
        "const next = new first('0 2 * * *', { mode: '5-part', paused: true, timezone: 'UTC' }).nextRun(new Date(Date.UTC(2026, 10, 11, 12)));",
        "process.stdout.write(JSON.stringify({ same: first === Cron && cronClass() === first, next: next.toISOString() }));",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ same: true, next: "2026-11-12T02:00:00.000Z" });
  });
});
