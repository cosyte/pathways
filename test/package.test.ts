import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { VERSION } from "../src/index.js";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly scripts: Record<string, string>;
  readonly engines: { readonly node: string };
  readonly bin: Record<string, string>;
  readonly files: readonly string[];
}

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");

interface CallingJob {
  readonly uses: string;
  readonly with?: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly secrets?: unknown;
}

interface Workflow {
  readonly on: unknown;
  readonly permissions: unknown;
  readonly jobs: Record<string, CallingJob>;
}

function workflow(file: string): Workflow {
  return parse(readFileSync(`.github/workflows/${file}`, "utf8")) as Workflow;
}

/** The commit a caller pins the shared workflow at: the part of `uses` after the `@`. */
function pinnedCommit(uses: string): string | undefined {
  return /^cosyte\/\.github\/\.github\/workflows\/[a-z-]+\.yml@([0-9a-f]{40})$/.exec(uses)?.[1];
}

describe("package facts that must agree", () => {
  it("VERSION equals package.json's version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("ships the pathways command from the built bin", () => {
    expect(pkg.bin).toEqual({ pathways: "./dist/bin/pathways.mjs" });
  });

  // `pathways init` reads templates/starter/ from two folders above dist/bin/pathways.mjs, so the
  // templates ship in the tarball beside dist.
  it("ships the starter project's templates", () => {
    expect(pkg.files).toContain("templates");
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

// The release is the shared pipeline: Changesets opens a Version Packages pull request, and merging
// it publishes through npm trusted publishing from the job that holds the `release` environment.
// These pin the caller to what that pipeline reads, so a drift fails here rather than in the first
// release run, where it would cost a version.
describe("the release workflow", () => {
  const release = workflow("release.yml");
  const ci = workflow("ci.yml");
  const job = release.jobs["release"];

  it("runs on pushes to main and nowhere else, with a read-only default token", () => {
    expect(release.on).toEqual({ push: { branches: ["main"] } });
    expect(release.permissions).toEqual({ contents: "read" });
    expect(Object.keys(release.jobs)).toEqual(["release"]);
  });

  it("calls the shared release workflow at the same published commit as CI", () => {
    expect(job?.uses).toMatch(/^cosyte\/\.github\/\.github\/workflows\/release\.yml@/);
    const ciCommit = pinnedCommit(ci.jobs["ci"]?.uses ?? "");
    expect(ciCommit, "ci.yml must pin the shared workflow by commit").toBeDefined();
    expect(pinnedCommit(job?.uses ?? "")).toBe(ciCommit);
  });

  // A called workflow can only narrow the caller's token, so each write the shared jobs ask for has
  // to be granted here, and `actions: read` is what its environment gate reads protection with.
  it("grants the calling job exactly what the shared pipeline requests", () => {
    expect(job?.permissions).toEqual({
      actions: "read",
      contents: "write",
      "id-token": "write",
      "pull-requests": "write",
    });
    expect(job?.secrets).toBe("inherit");
  });

  it("names this package and the same unpublished-dependency allowance as CI's prepublish", () => {
    expect(job?.with?.["package-name"]).toBe(pkg.name);
    expect(job?.with?.["expect-unpublished-deps"]).toBe(
      ci.jobs["ci"]?.with?.["expect-unpublished-deps"],
    );
  });

  it("has the scripts the shared pipeline runs", () => {
    expect(pkg.scripts["version"]).toBe(
      "changeset version && tsx scripts/sync-version.ts && cosyte-process format",
    );
    expect(pkg.scripts["pack:docs"]).toBe("cosyte-process pack-docs");
    expect(pkg.scripts["release"]).toBe("changeset publish");
  });

  // The shared pipeline refuses to release a version whose CHANGELOG.md has no section for it, and
  // Changesets writes that section only when a changelog generator is configured.
  it("has Changesets write the changelog the release checks for", () => {
    const config = JSON.parse(readFileSync(".changeset/config.json", "utf8")) as {
      changelog: unknown;
    };
    expect(config.changelog).toBe("@changesets/cli/changelog");
  });
});
