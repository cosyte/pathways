/**
 * The scan behind test/env-example.test.ts, held to each way code can read an environment variable:
 * a read it cannot name must fail the test, never pass it unseen.
 */

import { describe, expect, it } from "vitest";

import { scanEnvReads } from "./env-reads.js";

const scan = (text: string) => scanEnvReads([{ path: "src/new.ts", text }]);

describe("scanEnvReads", () => {
  it("names a variable read by property or by a string key", () => {
    expect(
      scan('process.env.PATHWAYS_ONE;\nenv["PATHWAYS_TWO"];\ncontext.env?.["PATHWAYS_THREE"];\n'),
    ).toEqual({ names: ["PATHWAYS_ONE", "PATHWAYS_THREE", "PATHWAYS_TWO"], unresolved: [] });
  });

  it("names a variable destructured from process.env or an env object", () => {
    expect(scan("const { PATHWAYS_NEW } = process.env;\n")).toEqual({
      names: ["PATHWAYS_NEW"],
      unresolved: [],
    });
    expect(
      scan('const { PATHWAYS_A: a, PATHWAYS_B = "x", "PATHWAYS_C": c } = context.env;\n'),
    ).toEqual({ names: ["PATHWAYS_A", "PATHWAYS_B", "PATHWAYS_C"], unresolved: [] });
  });

  it("refuses a rest element destructured from the environment, as it reads every name", () => {
    expect(scan("const { PATHWAYS_A, ...rest } = process.env;\n")).toEqual({
      names: ["PATHWAYS_A"],
      unresolved: [{ path: "src/new.ts", line: 1, read: "{ ...rest } = process.env" }],
    });
  });

  it("refuses a helper that reads a name it is passed", () => {
    expect(
      scan(
        'function readVar(n: string) {\n  return process.env[n];\n}\nreadVar("PATHWAYS_NEW");\n',
      ),
    ).toEqual({ names: [], unresolved: [{ path: "src/new.ts", line: 2, read: "env[n]" }] });
  });

  it("names a variable read through a typed constant", () => {
    expect(scan('const NEW_ENV: string = "PATHWAYS_NEW";\nprocess.env[NEW_ENV];\n')).toEqual({
      names: ["PATHWAYS_NEW"],
      unresolved: [],
    });
    expect(scan("const NAME = 'PATHWAYS_NEW' as const;\nenv[NAME];\n")).toEqual({
      names: ["PATHWAYS_NEW"],
      unresolved: [],
    });
  });

  it("names a variable read by a template literal key, and refuses one built from parts", () => {
    expect(scan("process.env[`PATHWAYS_NEW`];\n")).toEqual({
      names: ["PATHWAYS_NEW"],
      unresolved: [],
    });
    expect(scan("process.env[`PATHWAYS_${part}`];\n")).toEqual({
      names: [],
      unresolved: [{ path: "src/new.ts", line: 1, read: "env[`PATHWAYS_${part}`]" }],
    });
  });

  it("follows the environment into another name and into a parameter typed as one", () => {
    expect(scan("const vars = process.env;\nvars.PATHWAYS_A;\n")).toEqual({
      names: ["PATHWAYS_A"],
      unresolved: [],
    });
    expect(scan('function f(vars: Env) {\n  return vars["PATHWAYS_B"];\n}\n')).toEqual({
      names: ["PATHWAYS_B"],
      unresolved: [],
    });
  });

  it("follows an alias whose name has a dollar sign in it", () => {
    expect(scan("const $env = process.env;\n$env.PATHWAYS_A;\n$env[key];\n")).toEqual({
      names: ["PATHWAYS_A"],
      unresolved: [{ path: "src/new.ts", line: 3, read: "$env[key]" }],
    });
  });

  it("names a variable tested with in, and refuses a walk over every name", () => {
    expect(scan('"PATHWAYS_A" in process.env;\n')).toEqual({
      names: ["PATHWAYS_A"],
      unresolved: [],
    });
    expect(scan("Object.keys(process.env);\n")).toEqual({
      names: [],
      unresolved: [{ path: "src/new.ts", line: 1, read: "Object.keys(process.env)" }],
    });
  });

  it("reads no file name in a string as a variable", () => {
    expect(scan('const files = { "env.example": ".env.example" };\n')).toEqual({
      names: [],
      unresolved: [],
    });
  });

  it("refuses a key it cannot resolve, and leaves comment lines out", () => {
    expect(scan("env[name];\n// process.env.PATHWAYS_NOTE\n * env[other]\n")).toEqual({
      names: [],
      unresolved: [{ path: "src/new.ts", line: 1, read: "env[name]" }],
    });
  });
});
