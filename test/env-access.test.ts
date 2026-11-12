/**
 * src/env.ts is the one place in src/ that reads the process's environment, and the lint rule in
 * eslint.config.js holds every other file to it. Here ESLint, with the rules the gate's own
 * configuration gives a file in src/, lints each case in test/env-access-cases.ts: every way a
 * reviewer found to reach a variable without src/env.ts is refused, and ordinary uses of `process`
 * and of an environment object handed along are not.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  configuredVariable,
  ENGINE_VARIABLES,
  engineVariable,
  type EngineVariable,
  processEnv,
} from "../src/env.js";

import { ALLOWED, REFUSED } from "./env-access-cases.js";

const ROOT = join(import.meta.dirname, "..");

/** The rules that keep the environment in src/env.ts. */
const RULES = [
  "no-restricted-properties",
  "no-restricted-imports",
  "no-restricted-syntax",
] as const;

/** The part of ESLint's API this test uses. */
interface Linter {
  calculateConfigForFile(path: string): Promise<{
    readonly languageOptions?: { readonly parser?: unknown };
    readonly rules?: Readonly<Record<string, unknown>>;
  }>;
  lintText(
    text: string,
    options: { readonly filePath: string },
  ): Promise<readonly { readonly messages: readonly { readonly ruleId: string | null }[] }[]>;
}

interface EslintModule {
  readonly ESLint: new (options: Record<string, unknown>) => Linter;
}

/** ESLint, as the shared configuration the gate runs it with resolves it. */
async function eslintModule(): Promise<EslintModule> {
  const config = createRequire(join(ROOT, "package.json")).resolve("@cosyte/eslint-config");
  const path = createRequire(config).resolve("eslint");
  return (await import(pathToFileURL(path).href)) as EslintModule;
}

let gate: Linter;
let rules: Readonly<Record<string, unknown>> = {};
let lint: (text: string) => Promise<readonly string[]>;

beforeAll(async () => {
  const { ESLint } = await eslintModule();
  gate = new ESLint({ cwd: ROOT });
  const config = await gate.calculateConfigForFile(join(ROOT, "src", "cli.ts"));
  rules = Object.fromEntries(RULES.map((rule) => [rule, config.rules?.[rule] ?? "off"]));
  // The gate's parser and these three rules alone: they read syntax, so no type information is
  // needed, and the case files need not exist.
  const linter = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: config.languageOptions?.parser },
        rules,
      },
    ],
  });
  lint = async (text) => {
    const [result] = await linter.lintText(text, { filePath: join(ROOT, "src", "case.ts") });
    return (result?.messages ?? []).map((message) => message.ruleId ?? "parse error");
  };
}, 60_000);

describe("the lint rule that keeps the environment in src/env.ts", () => {
  it("is on for every file in src/ but src/env.ts", async () => {
    for (const rule of RULES) expect(rules[rule], rule).not.toBe("off");
    for (const rule of RULES) expect(JSON.stringify(rules[rule]), rule).toMatch(/^\[2,/);
    const env = await gate.calculateConfigForFile(join(ROOT, "src", "env.ts"));
    for (const rule of RULES) expect(env.rules?.[rule], rule).toBeUndefined();
  });

  for (const [name, text] of Object.entries(REFUSED)) {
    it(`refuses ${name}`, async () => {
      const found = await lint(text);
      expect(found.filter((rule) => (RULES as readonly string[]).includes(rule))).not.toEqual([]);
      expect(found).not.toContain("parse error");
    });
  }

  for (const [name, text] of Object.entries(ALLOWED)) {
    it(`allows ${name}`, async () => {
      expect(await lint(text)).toEqual([]);
    });
  }
});

describe("src/env.ts", () => {
  it("reads a variable Pathways knows from a stand-in, or from the process", () => {
    expect(engineVariable("XDG_RUNTIME_DIR", { XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
      "/run/user/1000",
    );
    expect(engineVariable("XDG_RUNTIME_DIR", {})).toBeUndefined();
    expect(processEnv()).toBe(process.env);
    expect(engineVariable("XDG_RUNTIME_DIR")).toBe(process.env["XDG_RUNTIME_DIR"]);
  });

  it("reads a variable configuration names", () => {
    expect(configuredVariable({ LAB_TOKEN: "synthetic-token" }, "LAB_TOKEN")).toBe(
      "synthetic-token",
    );
    expect(configuredVariable({}, "LAB_TOKEN")).toBeUndefined();
  });

  it("takes only a listed name as a fixed one", () => {
    const listed: EngineVariable = "PATHWAYS_DATABASE_URL";
    expect(ENGINE_VARIABLES).toContain(listed);
    // @ts-expect-error A name the list does not hold is not an EngineVariable.
    const unlisted: EngineVariable = "PATHWAYS_NEW";
    expect(ENGINE_VARIABLES).not.toContain(unlisted);
  });
});
