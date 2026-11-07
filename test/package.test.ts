import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/index.js";

interface PackageJson {
  readonly version: string;
  readonly engines: { readonly node: string };
  readonly bin: Record<string, string>;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");

describe("package facts that must agree", () => {
  it("VERSION equals package.json's version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("ships the pathways command from the built bin", () => {
    expect(pkg.bin).toEqual({ pathways: "./dist/bin/pathways.mjs" });
  });

  // engines.node and the CI matrix describe the same promise: the lowest Node line CI tests is the
  // floor package.json states. Each matrix value is also a required check, so change the ruleset
  // before changing either.
  it("tests the Node floor that engines.node states, and nothing below it", () => {
    const floor = /^>=(\d+)\.0\.0$/.exec(pkg.engines.node)?.[1];
    expect(floor, "engines.node must read >=N.0.0").toBeDefined();

    const matrix = /node-versions:\s*'(\[[^\]]*\])'/.exec(ciWorkflow)?.[1];
    expect(matrix, "ci.yml must state node-versions").toBeDefined();
    const lines = (JSON.parse(matrix ?? "[]") as string[]).map(Number);

    expect(Math.min(...lines)).toBe(Number(floor));
    expect(lines).toEqual([24, 26]);
  });
});
