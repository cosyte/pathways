import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      "changeset version && tsx scripts/sync-version.ts && cosyte-process format && cosyte-docs-reference",
    );
    expect(pkg.scripts["pack:docs"]).toBe("cosyte-process pack-docs");
    expect(pkg.scripts["release"]).toBe("changeset publish");
  });

  // The reference documents VERSION by its value, so a bump that does not regenerate
  // docs-content/api/ leaves the Version Packages pull request red on `docs-reference`. The
  // generator runs after the version is written into src/version.ts, never before it.
  it("regenerates the API reference after the version bump", () => {
    const steps = (pkg.scripts["version"] ?? "").split(" && ");
    const sync = steps.indexOf("tsx scripts/sync-version.ts");
    const reference = steps.indexOf("cosyte-docs-reference");
    expect(sync, "the version script must sync src/version.ts").toBeGreaterThan(-1);
    expect(reference, "the version script must regenerate docs-content/api/").toBeGreaterThan(sync);
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
// A pull request cannot push to GHCR, so docker.yml's `platforms` job runs the same steps against a
// registry of its own on the runner's loopback; these hold the two equal, so what a pull request
// proves is what a release runs.
describe("the image release", () => {
  const publish = job("release.yml", "image-publish");
  const decide = job("release.yml", "image-version");
  const platforms = job("docker.yml", "platforms");

  // The steps both run, in the same order, the same in every field.
  const SHARED = [
    "Read the version and the commit",
    "docker/setup-qemu-action",
    "Build each platform alone and run it on a starter project",
    "The version is still not published",
    "Build both platforms with SBOM and provenance, and push them by digest",
    "Pull the image by digest and check both platforms and their attestations",
    "Tag the verified digest with the version",
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

  it("runs the same steps on a pull request as on a release, against its own registry", () => {
    expect(platforms.env).toEqual({ IMAGE: "localhost:5000/cosyte/pathways" });
    expect(publish.env?.["IMAGE"]).toBe("ghcr.io/cosyte/pathways");
    for (const name of SHARED) expect(step(platforms, name), name).toEqual(step(publish, name));
    // The one difference: the dry run's builder is on the host's network, to reach that registry.
    const buildx = "docker/setup-buildx-action";
    expect(step(platforms, buildx).uses).toBe(step(publish, buildx).uses);
    expect(step(platforms, buildx).with).toEqual({ "driver-opts": "network=host" });
    expect(step(publish, buildx).with).toBeUndefined();
    const order = (of: Job): number[] => SHARED.map((name) => of.steps.indexOf(step(of, name)));
    expect(order(platforms)).toEqual([...order(platforms)].sort((a, b) => a - b));
    expect(order(publish)).toEqual([...order(publish)].sort((a, b) => a - b));
    // The smoke runs the image of each platform on SQLite, through its native binary.
    const smoke = step(publish, "Build each platform alone and run it on a starter project").run;
    expect(smoke).toContain("for arch in amd64 arm64; do");
    expect(smoke).toContain('"${run[@]}" "pathways:$arch" start --once');
  });

  it("builds both platforms with an SBOM and max-mode provenance, and pushes them by digest", () => {
    const released = step(
      publish,
      "Build both platforms with SBOM and provenance, and push them by digest",
    );
    expect(released.with).toMatchObject({
      platforms: "linux/amd64,linux/arm64",
      outputs: "type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true,push=true",
      sbom: true,
      provenance: "mode=max",
    });
    // No `latest`: a deployment names a version or a digest, and the version tag is the only tag.
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).not.toMatch(/:latest/);
    expect(workflow.match(/--tag "\$IMAGE[^"]*"/g)).toEqual([
      '--tag "$IMAGE:$VERSION"',
      '--tag "$IMAGE:$VERSION"',
    ]);
  });

  it("pushes, logs in and signs nowhere but the release", () => {
    const docker = readFileSync(".github/workflows/docker.yml", "utf8");
    for (const word of ["docker/login-action", "cosign", "push: true", "packages: write"]) {
      expect(docker, word).not.toContain(word);
    }
    expect(platforms.permissions).toEqual({ contents: "read" });
    // The only `docker push` in docker.yml is to the job's own registry on the runner's loopback,
    // and the dry run's image lives there too.
    expect(docker.match(/docker push .*/g)).toEqual(["docker push localhost:5000/pathways:ci"]);
    expect(platforms.env?.["IMAGE"]).toMatch(/^localhost:5000\//);
  });

  it("signs the pushed digest keylessly and checks it by digest, as a deployment does", () => {
    const sign = step(publish, "Sign the image by digest");
    expect(sign.run).toBe('cosign sign --yes "$IMAGE@$DIGEST"');
    expect(sign.env).toEqual({ DIGEST: "${{ steps.build.outputs.digest }}" });
    expect(step(publish, "sigstore/cosign-installer").uses).toMatch(/@[0-9a-f]{40}$/);

    const verify = step(publish, "Check the signature by digest");
    expect(verify.env).toEqual({ DIGEST: "${{ steps.build.outputs.digest }}" });
    expect(verify.run).toContain('cosign verify "$IMAGE@$DIGEST"');
    expect(verify.run).toContain(`--certificate-identity "${SIGNER}"`);
    expect(verify.run).toContain(`--certificate-oidc-issuer "${ISSUER}"`);
    const pull = step(
      publish,
      "Pull the image by digest and check both platforms and their attestations",
    );
    expect(pull.env).toEqual({ DIGEST: "${{ steps.build.outputs.digest }}" });
    expect(pull.run).toContain('ref="$IMAGE@$DIGEST"');
    expect(pull.run).toContain('docker pull --platform "$platform" "$ref"');
    const names = publish.steps.map((s) => s.name ?? s.uses?.split("@")[0]);
    expect(names.indexOf("Sign the image by digest")).toBeLessThan(
      names.indexOf("Check the signature by digest"),
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

// The version tag is the one name a deployment trusts, so it goes on last: the image is pushed by
// digest alone, signed, pulled back and checked, and only then tagged. A run that fails before the
// tag leaves at most an untagged digest that nothing points at, and the next run starts clean.
describe("the image's version tag", () => {
  const publish = job("release.yml", "image-publish");
  const decide = job("release.yml", "image-version");
  const platforms = job("docker.yml", "platforms");
  const TAG = "Tag the verified digest with the version";
  const CHECKS = [
    "Sign the image by digest",
    "Check the signature by digest",
    "Pull the image by digest and check both platforms and their attestations",
  ];

  /**
   * The steps that can put a tag on an image in a registry: a copy or a tag command, or a build that
   * pushes (`--push`, or an output that pushes to a registry).
   */
  const writesTag = (s: Step): boolean =>
    s.with?.["tags"] !== undefined ||
    /imagetools create|docker (image )?push|docker tag|crane|oras|skopeo/.test(s.run ?? "") ||
    /--push\b|push=true|type=registry/.test(s.run ?? "");

  it("counts a build that pushes as a step that writes a tag", () => {
    for (const run of [
      'docker buildx build --push --tag "$IMAGE:$VERSION" .',
      'docker buildx build --platform linux/amd64,linux/arm64 \\\n  --tag "$IMAGE:$VERSION" --push .',
      'docker buildx build --tag "$IMAGE:$VERSION" --output type=registry .',
      'docker buildx build --output type=image,name="$IMAGE:$VERSION",push=true .',
      'docker push "$IMAGE:$VERSION"',
    ]) {
      expect(writesTag({ run }), run).toBe(true);
    }
    // A build loaded into the runner's own Docker writes no tag in a registry.
    expect(writesTag({ run: 'docker buildx build --load --tag "pathways:$arch" .' })).toBe(false);
  });

  it("is written only after the signature and the attestations are checked", () => {
    const names = publish.steps.map((s) => s.name ?? s.uses?.split("@")[0]);
    expect(publish.steps.filter(writesTag).map((s) => s.name)).toEqual([TAG]);
    for (const check of CHECKS) {
      expect(names.indexOf(check), check).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(check), check).toBeLessThan(names.indexOf(TAG));
    }
    const build = step(
      publish,
      "Build both platforms with SBOM and provenance, and push them by digest",
    );
    expect(build.with?.["tags"]).toBeUndefined();
    expect(String(build.with?.["outputs"])).toContain("push-by-digest=true");
    const tag = step(publish, TAG);
    expect(tag.env).toEqual({ DIGEST: "${{ steps.build.outputs.digest }}" });
    expect(tag.run).toContain('docker buildx imagetools create --tag "$IMAGE:$VERSION" "$ref"');
    // The tag names the digest that was checked, or the step fails.
    expect(tag.run).toContain('test "$tagged" = "$DIGEST"');
  });

  it("goes on the same way in the pull request's dry run, against a throwaway registry", () => {
    expect(platforms.steps.filter(writesTag).map((s) => s.name)).toEqual([TAG]);
    expect(step(platforms, TAG)).toEqual(step(publish, TAG));
    expect(platforms.env?.["IMAGE"]).toMatch(/^localhost:5000\//);
  });

  const ABSENT = "The version is still not published";
  const DECIDE = "Has this version a GitHub release, and no image yet?";

  it("is checked for again just before the push, failing closed on an answer it does not know", () => {
    const absent = step(publish, ABSENT);
    expect(absent.run).toContain("exit 1");
    expect(step(platforms, ABSENT)).toEqual(absent);
  });

  // Each of the three look-ups runs as its own script, with a stand-in `docker` that gives the
  // registry's answer for the version tag, a stand-in `gh` that finds the GitHub release, and, for
  // the tag step, a registry that holds the pushed digest and has the tag once the step writes it.
  describe.skipIf(process.platform === "win32")("the registry's answers", () => {
    const INDEX = '{"schemaVersion":2,"manifests":[]}';
    const DIGEST = `sha256:${createHash("sha256").update(INDEX).digest("hex")}`;
    const VERSION_TAG = "0.0.0-example";
    const FAKE_DOCKER = [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_DIR/calls"',
      'case "$*" in',
      "  login*) cat > /dev/null; exit 0 ;;",
      "  logout*) exit 0 ;;",
      '  *"create --dry-run"*) printf \'%s\' "$FAKE_INDEX"; exit 0 ;;',
      '  *"imagetools create"*) touch "$FAKE_DIR/tagged"; exit 0 ;;',
      "esac",
      'if [ -e "$FAKE_DIR/tagged" ]; then printf \'%s\' "$FAKE_INDEX"; exit 0; fi',
      "printf '%s\\n' \"$FAKE_OUT\"",
      'exit "$FAKE_STATUS"',
      "",
    ].join("\n");

    interface Answer {
      readonly status: number | null;
      readonly outputs: string;
      readonly tagged: boolean;
    }

    function answer(script: string, image: string, output: string, status: number): Answer {
      const dir = mkdtempSync(join(tmpdir(), "pathways-registry-"));
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "docker"), FAKE_DOCKER);
        writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, "docker"), 0o755);
        chmodSync(join(bin, "gh"), 0o755);
        writeFileSync(join(dir, "package.json"), JSON.stringify({ version: VERSION_TAG }));
        writeFileSync(join(dir, "calls"), "");
        const outputs = join(dir, "outputs");
        writeFileSync(outputs, "");
        const summary = join(dir, "summary");
        writeFileSync(summary, "");
        const result = spawnSync("bash", ["-c", script], {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
            IMAGE: image,
            VERSION: VERSION_TAG,
            DIGEST,
            GH_TOKEN: "stand-in",
            GITHUB_ACTOR: "stand-in",
            RUNNER_TEMP: dir,
            GITHUB_OUTPUT: outputs,
            GITHUB_STEP_SUMMARY: summary,
            FAKE_DIR: dir,
            FAKE_INDEX: INDEX,
            FAKE_OUT: output,
            FAKE_STATUS: String(status),
          },
          encoding: "utf8",
        });
        const calls = readFileSync(join(dir, "calls"), "utf8").split("\n");
        return {
          status: result.status,
          outputs: readFileSync(outputs, "utf8"),
          tagged: calls.some((c) => c.includes("imagetools create --tag")),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // The release looks the tag up on GHCR; the pull request's dry run, on the job's own registry.
    const IMAGES = [publish.env?.["IMAGE"] ?? "", platforms.env?.["IMAGE"] ?? ""];

    // The registry's own answers for a tag it does not have, each the whole output: the resolver's
    // not-found for this very tag, and the registry's error codes in the form `code: message`.
    const missing = (image: string): readonly string[] => [
      `ERROR: ${image}:${VERSION_TAG}: not found`,
      "ERROR: manifest unknown",
      "ERROR: manifest unknown: manifest unknown",
      "ERROR: name unknown: repository name not known to registry",
    ];
    // GHCR's answer while the package does not exist yet.
    const DENIED = [
      "ERROR: denied: denied",
      "ERROR: denied: requested access to the resource is denied",
    ];
    // Errors, some of them holding the words of a not-found answer, that are not the registry
    // saying it does not have this tag.
    const unknown = (image: string): readonly string[] => [
      "ERROR: unexpected status from HEAD request: 503 Service Unavailable",
      "ERROR: toomanyrequests: retry later",
      "ERROR: failed to do request: dial tcp: i/o timeout",
      "",
      `ERROR: ${image}:0.0.1-example: not found`,
      `ERROR: ${image}:${VERSION_TAG}-rc: not found`,
      'ERROR: error getting credentials - err: exec: "docker-credential-example": executable file not found in $PATH',
      "ERROR: failed to authorize: failed to fetch oauth token: 404 page not found",
      "ERROR: unexpected status from GET request: 502 Bad Gateway: upstream said manifest unknown",
      "ERROR: failed to resolve: name unknown host in proxy configuration",
      "ERROR: unexpected status from HEAD request: 403 Forbidden: access denied by policy",
      `ERROR: ${image}:${VERSION_TAG}: not found\nERROR: failed to do request: dial tcp: i/o timeout`,
      `WARNING: proxy settings ignored\nERROR: ${image}:${VERSION_TAG}: not found`,
    ];

    describe("the first look-up, before the build", () => {
      const script = (): string => step(decide, DECIDE).run ?? "exit 0";
      const image = publish.env?.["IMAGE"] ?? "";

      it("publishes on each answer that says the tag is not there, and on denied", () => {
        for (const output of [...missing(image), ...DENIED]) {
          expect(answer(script(), image, output, 1), output).toMatchObject({
            status: 0,
            outputs: `version=${VERSION_TAG}\npublish=true\n`,
          });
        }
      });

      it("stands down when the version is there", () => {
        expect(answer(script(), image, `Name: ${image}:${VERSION_TAG}`, 0)).toMatchObject({
          status: 0,
          outputs: `version=${VERSION_TAG}\npublish=false\n`,
        });
      });

      it("fails, and publishes nothing, on any other answer", () => {
        for (const output of unknown(image)) {
          const result = answer(script(), image, output, 1);
          expect(result.status, output).not.toBe(0);
          expect(result.outputs, output).not.toContain("publish=true");
        }
      });
    });

    describe.each(IMAGES)("the recheck after the wait, on %s", (image) => {
      const script = (): string => step(publish, ABSENT).run ?? "exit 0";

      it("publishes on each answer that says the tag is not there, and on denied", () => {
        for (const output of [...missing(image), ...DENIED]) {
          expect(answer(script(), image, output, 1), output).toMatchObject({
            status: 0,
            outputs: "absent=true\n",
          });
        }
      });

      it("stands down when the version is there", () => {
        expect(answer(script(), image, `Name: ${image}:${VERSION_TAG}`, 0)).toMatchObject({
          status: 0,
          outputs: "absent=false\n",
        });
      });

      it("fails, and publishes nothing, on any other answer", () => {
        for (const output of unknown(image)) {
          const result = answer(script(), image, output, 1);
          expect(result.status, output).not.toBe(0);
          expect(result.outputs, output).not.toContain("absent=true");
        }
      });
    });

    describe.each(IMAGES)("the look-up just before the tag, on %s", (image) => {
      const script = (): string => step(publish, TAG).run ?? "exit 0";

      it("tags the checked digest when the registry says it has no such tag", () => {
        for (const output of missing(image)) {
          expect(answer(script(), image, output, 1), output).toMatchObject({
            status: 0,
            tagged: true,
          });
        }
      });

      it("refuses to replace a version tag that exists", () => {
        const result = answer(script(), image, `Name: ${image}:${VERSION_TAG}`, 0);
        expect(result.status).not.toBe(0);
        expect(result.tagged).toBe(false);
      });

      // The package exists by this step, so "denied" no longer means "nothing published yet".
      it("refuses on a denied answer, and on any other answer it does not know", () => {
        for (const output of [...DENIED, ...unknown(image)]) {
          const result = answer(script(), image, output, 1);
          expect(result.status, output).not.toBe(0);
          expect(result.tagged, output).toBe(false);
        }
      });
    });
  });
});
