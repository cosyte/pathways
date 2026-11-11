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
  readonly exports: Record<string, unknown>;
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

  // tsup.config.ts writes the two JSON Schemas into schema/ at the package root once the entries are
  // built, and the starter's modelines name them there, under node_modules. Each subpath is the
  // file's own path, so a resolver that ignores `exports` (TypeScript's node10) finds it too.
  it("exports the JSON Schemas of the two YAML files from where the build writes them", () => {
    expect(pkg.exports["./schema/channel.json"]).toBe("./schema/channel.json");
    expect(pkg.exports["./schema/project.json"]).toBe("./schema/project.json");
    expect(pkg.files).toContain("schema");
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

  // Windows and macOS run the shared `verify` on the floor alone, at the same published commit as
  // Linux, and the packed package is installed and run on all three. Each context is a check the
  // ruleset can require, so a system dropped here is a check that silently stops running.
  it("runs verify on Windows and macOS on the floor, and the tarball smoke on all three systems", () => {
    const ci = workflow("ci.yml");
    const floor = /^>=(\d+)/.exec(pkg.engines.node)?.[1];
    const systems = ci.jobs["systems"];
    expect(pinnedCommit(systems?.uses ?? "")).toBe(pinnedCommit(ci.jobs["ci"]?.uses ?? ""));
    expect(JSON.parse(String(systems?.with?.["node-versions"]))).toEqual([floor]);
    expect(JSON.parse(String(systems?.with?.["os"]))).toEqual(["windows-latest", "macos-latest"]);
    expect(systems?.with?.["run-phi-scan"]).toBe(true);
    // Linux alone runs the rest, once.
    expect(ci.jobs["ci"]?.with?.["os"]).toBeUndefined();

    const smoke = ci.jobs["tarball-smoke"] as unknown as {
      readonly strategy: { readonly matrix: { readonly os: readonly string[] } };
      readonly steps: readonly { readonly run?: string }[];
    };
    expect(smoke.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest", "macos-latest"]);
    expect(smoke.steps.map((step) => step.run).at(-1)).toMatch(/^node scripts\/tarball-smoke\.ts /);
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
    expect(Object.keys(release.jobs)).toEqual(["release", "image-version", "image-publish"]);
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

  // The shared pipeline's `version` job installs on Node 22 unless told otherwise, and pnpm refuses
  // to install a package whose engines.node starts above it, so every release job runs on our floor.
  it("runs every shared release job on the package's own Node floor", () => {
    const floor = /^>=(\d+)/.exec(pkg.engines.node)?.[1];
    expect(floor, "engines.node must state a floor").toBeDefined();
    expect(job?.with?.["node-version"]).toBe(floor);
  });

  it("has the scripts the shared pipeline runs", () => {
    expect(pkg.scripts["version"]).toBe(
      "changeset version && tsx scripts/sync-version.ts && cosyte-process format",
    );
    expect(pkg.scripts["pack:docs"]).toBe("cosyte-process pack-docs");
    expect(pkg.scripts["release"]).toBe("changeset publish");
  });

  // A pull request that changes an export without regenerating docs-content/api/, or adds an export
  // with no TSDoc summary, fails `docs-reference`; a broken link or sidebar id fails `ci / verify`.
  it("runs both docs checks on every pull request", () => {
    const ci = workflow("ci.yml");
    expect(ci.jobs["ci"]?.with?.["check-docs-content"]).toBe(true);
    expect(pkg.scripts["check:docs-reference"]).toBe("cosyte-docs-reference --check");
    const job = ci.jobs["docs-reference"] as unknown as {
      readonly steps: readonly { readonly run?: string }[];
    };
    expect(job.steps.map((step) => step.run).filter(Boolean)).toEqual([
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm check:docs-reference",
    ]);
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

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}

interface Job {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly permissions?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly concurrency?: unknown;
  readonly steps: readonly Step[];
}

/** A job of a workflow; a missing one has no steps, so each test that reads it fails on its own. */
function job(file: string, name: string): Job {
  return (workflow(file).jobs[name] as unknown as Job | undefined) ?? { steps: [] };
}

/** A step by its name, or by the action it uses when it has none. */
function step(of: Job, key: string): Step {
  const found = of.steps.find((s) => s.name === key || s.uses?.split("@")[0] === key);
  expect(found, `no step ${key}`).toBeDefined();
  return found as Step;
}

/** The identity a cosign keyless signature from release.yml carries, on a push to main. */
const SIGNER = "https://github.com/cosyte/pathways/.github/workflows/release.yml@refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";

// Each release publishes the image to GHCR, signed, for two platforms, with an SBOM and provenance.
// A pull request cannot push, so docker.yml's `platforms` job runs the same steps with `push:
// false`; these hold the two equal, so what a pull request proves is what a release runs.
describe("the image release", () => {
  const publish = job("release.yml", "image-publish");
  const decide = job("release.yml", "image-version");
  const platforms = job("docker.yml", "platforms");

  // The steps both run, in the same order, the same in every field.
  const SHARED = [
    "Read the version and the commit",
    "docker/setup-qemu-action",
    "docker/setup-buildx-action",
    "Build each platform alone and run it on a starter project",
  ];

  it("runs after the release job, deciding with a read-only token, and publishes only when told", () => {
    expect(decide.needs).toBe("release");
    expect(decide.if).toBe("${{ !cancelled() }}");
    expect(decide.permissions).toEqual({ contents: "read", packages: "read" });
    expect(publish.needs).toBe("image-version");
    expect(publish.if).toBe("needs.image-version.outputs.publish == 'true'");
    expect(publish.permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
    });
    expect(publish.concurrency).toEqual({ group: "image-publish", "cancel-in-progress": false });
    // Built from the release tag, never from a later main.
    expect(publish.steps[0]?.with?.["ref"]).toBe("v${{ needs.image-version.outputs.version }}");
    expect(step(publish, "The release tag holds the released version").run).toBe(
      'test "$VERSION" = "$RELEASED"',
    );
  });

  it("runs the same steps on a pull request as on a release, up to the login", () => {
    expect(platforms.env).toEqual({ IMAGE: "ghcr.io/cosyte/pathways" });
    expect(publish.env?.["IMAGE"]).toBe("ghcr.io/cosyte/pathways");
    for (const name of SHARED) expect(step(platforms, name), name).toEqual(step(publish, name));
    const order = (of: Job): number[] => SHARED.map((name) => of.steps.indexOf(step(of, name)));
    expect(order(platforms)).toEqual([...order(platforms)].sort((a, b) => a - b));
    expect(order(publish)).toEqual([...order(publish)].sort((a, b) => a - b));
    // The smoke runs the image of each platform on SQLite, through its native binary.
    const smoke = step(publish, "Build each platform alone and run it on a starter project").run;
    expect(smoke).toContain("for arch in amd64 arm64; do");
    expect(smoke).toContain('"${run[@]}" "pathways:$arch" start --once');
  });

  it("builds both platforms with an SBOM and max-mode provenance, and pushes only from a release", () => {
    const name = "Build both platforms with SBOM and provenance";
    const released = step(publish, name);
    const dryRun = step(platforms, name);
    expect(released.with).toMatchObject({
      platforms: "linux/amd64,linux/arm64",
      push: true,
      sbom: true,
      provenance: "mode=max",
      tags: "${{ env.IMAGE }}:${{ env.VERSION }}",
    });
    expect(dryRun.with).toEqual({ ...released.with, push: false });
    expect(dryRun.uses).toBe(released.uses);
    // No `latest`: a deployment names a version or a digest.
    expect(String(released.with?.["tags"])).not.toContain("latest");
  });

  it("pushes, logs in and signs nowhere but the release", () => {
    const docker = readFileSync(".github/workflows/docker.yml", "utf8");
    for (const word of ["docker/login-action", "cosign", "push: true", "packages: write"]) {
      expect(docker, word).not.toContain(word);
    }
    expect(platforms.permissions).toEqual({ contents: "read" });
    // The only `docker push` in docker.yml is to the job's own registry on the runner's loopback.
    expect(docker.match(/docker push .*/g)).toEqual(["docker push localhost:5000/pathways:ci"]);
  });

  it("signs the pushed digest keylessly and checks it by digest, as a deployment does", () => {
    const sign = step(publish, "Sign the image by digest");
    expect(sign.run).toBe('cosign sign --yes "$IMAGE@$DIGEST"');
    expect(sign.env).toEqual({ DIGEST: "${{ steps.build.outputs.digest }}" });
    expect(step(publish, "sigstore/cosign-installer").uses).toMatch(/@[0-9a-f]{40}$/);

    const verify = step(publish, "Pull the image by digest and check its signature");
    expect(verify.env).toEqual({ DIGEST: "${{ steps.build.outputs.digest }}" });
    expect(verify.run).toContain('ref="$IMAGE@$DIGEST"');
    expect(verify.run).toContain(`--certificate-identity "${SIGNER}"`);
    expect(verify.run).toContain(`--certificate-oidc-issuer "${ISSUER}"`);
    expect(verify.run).toContain('docker pull --platform "$platform" "$ref"');
    const names = publish.steps.map((s) => s.name ?? s.uses?.split("@")[0]);
    expect(names.indexOf("Sign the image by digest")).toBeLessThan(
      names.indexOf("Pull the image by digest and check its signature"),
    );
  });

  // The identity a reader is told to check is the one the release signs with.
  it("tells a project and the docs to check the identity the release signs with", () => {
    for (const file of [
      "templates/starter/Dockerfile",
      "docs-content/run-in-docker.md",
      "docs-content/deploy-the-image.md",
    ]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toContain(`--certificate-identity ${SIGNER}`);
      expect(text, file).toContain(`--certificate-oidc-issuer ${ISSUER}`);
    }
  });

  // Every action is pinned by commit, as the rest of the repository's workflows are.
  it("pins every action it uses by commit", () => {
    for (const of of [publish, decide, platforms, job("docker.yml", "project-image")]) {
      for (const s of of.steps) {
        if (s.uses !== undefined) expect(s.uses).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
      }
    }
  });
});
