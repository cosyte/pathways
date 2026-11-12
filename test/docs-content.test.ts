import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { parseHL7 } from "@cosyte/hl7";
import { docSnippetSuite } from "@cosyte/vitest-config/snippets";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  channelSchema,
  configJsonSchemas,
  DEFAULT_SETTINGS,
  parseDuration,
  projectSchema,
} from "../src/config/schema.js";
import { ChannelWorker } from "../src/engine/channel-worker.js";
import { METRIC_FAMILIES } from "../src/engine/metrics.js";
import type { CsvSettings, XmlSettings } from "../src/engine/worker-entry.js";
import { generateKey } from "../src/encryption/keys.js";
import {
  age,
  anchors,
  cli,
  cliAsync,
  DOCS_DIR,
  fences,
  outputs,
  page,
  pagePaths,
  put,
  putTitled,
  removeProjects,
  ROOT,
  SAMPLE_LANGS,
  starterProject,
  startEngine,
  titled,
} from "./docs-helpers.js";
import { ADT_A01, ADT_A08, FHIR_PATIENT, X12_270 } from "./helpers.js";
import { onPickedPorts, orTaken } from "./net-helpers.js";

/**
 * The docs.cosyte.com pages in `docs-content/`, held to the code they describe.
 *
 * - Every TypeScript and JavaScript sample runs, through the shared sample runner, against the built
 *   package, and compiles against the package's types.
 * - Every YAML sample is a `pathways.yaml` or a `channel.yaml` the configuration schema accepts.
 * - Every link to another page resolves, anchor and all.
 * - The flows the pages walk through (the quickstart, the tutorial, the transforms, hooks and
 *   connectors they show, rotation, replay, retention, the health endpoint and the errors on the
 *   troubleshooting page) run through the built `pathways` command, and what the pages show it
 *   printing is what it prints.
 *
 * The generated `api/` pages are not part of this: their `@example` blocks are fragments written for
 * an editor's tooltip, and `cosyte-docs-reference --check` holds them to the source.
 */

const distEntry = join(ROOT, "dist", "index.mjs");
// A file URL, not a path: the sample imports it as written, and on Windows Node's loader reads a
// bare `D:\...` as a URL whose scheme is the drive.
const resolve = (specifier: string): string | undefined =>
  specifier === "@cosyte/pathways" ? pathToFileURL(distEntry).href : undefined;

beforeAll(() => {
  // pnpm is a .cmd shim on Windows, which only a shell can start.
  execFileSync("pnpm", ["build"], {
    cwd: ROOT,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}, 180_000);

afterEach(removeProjects);

const pages = pagePaths();

/**
 * The TypeScript compiler `pnpm typecheck` runs: `@cosyte/process` owns the toolchain's versions, so
 * this repository does not install its own.
 */
const tsc = createRequire(
  createRequire(import.meta.url).resolve("@cosyte/process/package.json"),
).resolve("typescript/bin/tsc");
const SLOW = 120_000;

/**
 * `every` runs each sample whether or not it is tagged `runnable`, and lists a `no-run` sample as
 * skipped with its reason. It reaches the runner through a variable so the line compiles against a
 * `@cosyte/vitest-config` that predates the option; such a runner ignores it and runs the `runnable`
 * blocks, which is every sample here, as the next test holds.
 */
const suiteOptions = { files: pages, every: true, resolve };
docSnippetSuite(suiteOptions);

describe("every sample on the pages", () => {
  it("runs, or names in its fence why it cannot", () => {
    const unaccounted: string[] = [];
    for (const path of pages) {
      for (const fence of fences(readFileSync(path, "utf8"))) {
        if (!SAMPLE_LANGS.has(fence.lang)) continue;
        const noRun = fence.tags.indexOf("no-run");
        const reason = noRun === -1 ? "" : fence.tags.slice(noRun + 1).join(" ");
        if (fence.tags.includes("runnable") ? noRun !== -1 : reason === "") {
          unaccounted.push(`${path.slice(DOCS_DIR.length + 1)}:${fence.line}`);
        }
      }
    }
    expect(unaccounted).toEqual([]);
  });

  it(
    "compiles against the package's types",
    () => {
      const dir = join(ROOT, ".docs-typecheck");
      const files: string[] = [];
      try {
        mkdirSync(dir, { recursive: true });
        for (const path of pages) {
          for (const fence of fences(readFileSync(path, "utf8"))) {
            if (!SAMPLE_LANGS.has(fence.lang) || fence.tags.includes("no-run")) continue;
            const file = join(dir, `${path.slice(DOCS_DIR.length + 1, -3)}-${fence.line}.ts`);
            writeFileSync(file, `${fence.body}\nexport {};\n`);
            files.push(file);
          }
        }
        // The repository's own compiler settings, with the samples as the only inputs.
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({ extends: "../tsconfig.json", include: ["./*.ts"] }),
        );
        const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", dir], {
          cwd: ROOT,
          encoding: "utf8",
        });
        const errors = `${result.stdout}${result.stderr}`
          .split("\n")
          .filter((line) => line.trim() !== "");
        expect(files.length).toBeGreaterThan(10);
        expect(errors).toEqual([]);
        expect(result.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});

describe("every YAML sample", () => {
  it("is a pathways.yaml or channel.yaml the configuration schema accepts, or says why not", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const path of pages) {
      for (const fence of fences(readFileSync(path, "utf8"))) {
        if (fence.lang !== "yaml") continue;
        const at = `${path.slice(DOCS_DIR.length + 1)}:${fence.line}`;
        const noCheck = fence.tags.indexOf("no-check");
        if (noCheck !== -1) {
          if (fence.tags.slice(noCheck + 1).length === 0)
            problems.push(`${at}: no-check names no reason`);
          continue;
        }
        const channel = /^channels\/([a-z0-9][a-z0-9-]*)\/channel\.yaml$/.exec(fence.title ?? "");
        const schema =
          fence.title === "pathways.yaml"
            ? projectSchema
            : channel === null
              ? undefined
              : channelSchema;
        if (schema === undefined) {
          problems.push(`${at}: titled neither pathways.yaml nor channels/<name>/channel.yaml`);
          continue;
        }
        const result = schema.safeParse(parseYaml(fence.body) ?? {});
        checked += 1;
        if (!result.success) {
          problems.push(
            `${at}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          );
          continue;
        }
        const name = (result.data as { name?: string }).name;
        if (channel !== null && name !== undefined && name !== channel[1]) {
          problems.push(`${at}: name does not match the folder`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });
});

describe("every link between pages", () => {
  it("names a page that exists, and a heading on it", () => {
    const broken: string[] = [];
    for (const path of pages) {
      const text = readFileSync(path, "utf8");
      for (const [, target = ""] of text.matchAll(/\]\((\.\/[^)\s]+)\)/g)) {
        const [file = "", anchor] = target.split("#");
        const linked = join(DOCS_DIR, file);
        if (!existsSync(linked)) {
          broken.push(`${path.slice(DOCS_DIR.length + 1)}: ${target}`);
        } else if (anchor !== undefined && !anchors(readFileSync(linked, "utf8")).has(anchor)) {
          broken.push(`${path.slice(DOCS_DIR.length + 1)}: ${target} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("the settings tables", () => {
  it("give the defaults the engine uses", () => {
    const engine: Record<string, string | number> = {
      timeout: DEFAULT_SETTINGS.timeoutMs,
      memory: DEFAULT_SETTINGS.memoryMb,
      onStoreFailure: DEFAULT_SETTINGS.onStoreFailure,
      ackTimeout: DEFAULT_SETTINGS.ackTimeoutMs,
      retention: DEFAULT_SETTINGS.retentionMs,
      resendFlag: String(DEFAULT_SETTINGS.resendFlag),
      pollInterval: DEFAULT_SETTINGS.pollIntervalMs,
      retentionInterval: DEFAULT_SETTINGS.retentionIntervalMs,
    };
    for (const [name, column] of [
      ["configure-a-channel.md", 2],
      ["configuration-reference.md", 3],
    ] as const) {
      const shown: Record<string, string | number> = {};
      for (const line of page(name).split("\n")) {
        const cells = line.split("|").map((cell) => cell.trim());
        const key = /^`(\w+)`$/.exec(cells[1] ?? "")?.[1];
        const value = /^`([^`]+)`$/.exec(cells[column] ?? "")?.[1];
        // The first table that names a setting is the settings table; a later `timeout` is a connector's.
        if (key === undefined || value === undefined || !(key in engine) || key in shown) continue;
        shown[key] = /MB$/.test(value)
          ? Number(value.slice(0, -2))
          : (parseDuration(value) ?? value);
      }
      expect(shown, name).toEqual(engine);
    }
  });
});

describe("the metrics table of the configuration reference", () => {
  it("names every family /metrics serves, in order, with its type and labels", () => {
    const rows = page("configuration-reference.md")
      .split("\n")
      .filter((line) => line.startsWith("| `pathways_"))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    expect(
      rows.map(([, name = "", type = "", labels = ""]) => [
        name.replaceAll("`", ""),
        type,
        labels === "none" ? "" : labels.replaceAll(" ", ""),
      ]),
    ).toEqual(
      METRIC_FAMILIES.map((family) => [
        family.type === "counter" ? `${family.name}_total` : family.name,
        family.type,
        family.labels.join(","),
      ]),
    );
  });
});

describe("the dryRun row of the configuration reference", () => {
  it("says a dryRun read from the environment is turned off, unaudited, by setting it to false", () => {
    const row = page("configuration-reference.md")
      .split("\n")
      .find((line) => line.startsWith("| `dryRun` |"));
    expect(row).toMatch(/setting that variable to `false` makes the destination send for real/);
    expect(row).toMatch(/the audit log does not record that change/);
  });
});

describe("the quickstart", () => {
  it("shows the starter's transform as init writes it", () => {
    expect(`${titled("quickstart.md", "channels/adt-to-lab/transform.ts")}\n`).toBe(
      readFileSync(join(ROOT, "templates/starter/channels/adt-to-lab/transform.ts"), "utf8"),
    );
  });

  it(
    "runs as written: init, test, start, status",
    async () => {
      const shown = outputs("quickstart.md");
      const dir = await starterProject();
      const written = (await readdir(dir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.parentPath.includes("node_modules"))
        // With "/" between folders on every system, as the page shows them.
        .map((entry) =>
          join(entry.parentPath, entry.name)
            .slice(dir.length + 1)
            .split(sep)
            .join("/"),
        )
        .sort();
      expect(written.join("\n")).toBe(shown[0]);

      const test = cli(["test"], dir);
      expect(test.code).toBe(0);
      expect(test.out.trimEnd()).toBe(shown[1]);

      const inbox = join(dir, "data/adt-to-lab/in");
      await mkdir(inbox, { recursive: true });
      for (const name of ["a01.hl7", "a08.hl7"]) {
        await writeFile(
          join(inbox, name),
          await readFile(join(dir, "channels/adt-to-lab/tests", name)),
        );
        await age(join(inbox, name));
      }
      expect(cli(["start", "--once"], dir).code).toBe(0);
      expect(await readFile(join(dir, "data/adt-to-lab/out/1-1.hl7"), "utf8")).toBe(
        await readFile(join(dir, "channels/adt-to-lab/tests/a01.expected.hl7"), "utf8"),
      );
      expect((await readdir(inbox, { withFileTypes: true })).filter((e) => e.isFile())).toEqual([]);

      const status = cli(["status"], dir);
      expect(status.out.trimEnd()).toBe(shown[2]);
      const messages = cli(["messages"], dir).out;
      expect(messages).toMatch(/^2\s+adt-to-lab\s+filtered/m);
      expect(messages).toMatch(/^1\s+adt-to-lab\s+delivered/m);
    },
    SLOW,
  );
});

describe("the tutorial: write a channel", () => {
  it(
    "runs step by step, printing what the page shows",
    async () => {
      const name = "write-a-channel.md";
      const shown = outputs(name);
      const dir = await starterProject();
      for (const title of [
        "channels/results-to-ehr/channel.yaml",
        "channels/results-to-ehr/transform.ts",
        "channels/results-to-ehr/tests/final.hl7",
        "channels/results-to-ehr/tests/preliminary.hl7",
      ]) {
        await putTitled(dir, name, title);
      }

      const first = cli(["test", "results-to-ehr"], dir);
      expect(first.code).toBe(1);
      expect(first.out.trimEnd()).toBe(shown[0]);

      const update = cli(["test", "results-to-ehr", "--update"], dir);
      expect(update.code).toBe(0);
      expect(update.out.trimEnd()).toBe(shown[1]);
      const tests = join(dir, "channels/results-to-ehr/tests");
      const expected = await readFile(join(tests, "final.expected.hl7"));
      expect(parseHL7(expected).get("MSH.5")).toBe("EHR");
      expect(expected.includes(0x0d)).toBe(true);
      expect(await readFile(join(tests, "preliminary.expected.hl7"), "utf8")).toBe("");

      const all = cli(["test"], dir);
      expect(all.code).toBe(0);
      expect(all.out.trimEnd()).toBe(shown[2]);

      const transform = join(dir, "channels/results-to-ehr/transform.ts");
      const source = await readFile(transform, "utf8");
      await writeFile(transform, source.replace('"EHR"', '"EHR2"'));
      const broken = cli(["test", "results-to-ehr"], dir);
      expect(broken.code).toBe(1);
      expect(broken.out.trimEnd()).toBe(shown[3]);
      await writeFile(transform, source);

      const inbox = join(dir, "data/results-to-ehr/in");
      await mkdir(inbox, { recursive: true });
      for (const input of ["final.hl7", "preliminary.hl7"]) {
        await writeFile(join(inbox, input), await readFile(join(tests, input)));
        await age(join(inbox, input));
      }
      expect(cli(["start", "--once"], dir).code).toBe(0);
      const out = join(dir, "data/results-to-ehr/out");
      expect(await readdir(out)).toEqual(["1-1.hl7"]);
      expect(await readFile(join(out, "1-1.hl7"))).toEqual(expected);
      expect(cli(["messages", "--channel", "results-to-ehr"], dir).out).toMatch(
        /^2\s+results-to-ehr\s+filtered/m,
      );
    },
    SLOW,
  );
});

describe("make sample messages with @cosyte/synth", () => {
  const name = "make-sample-messages.md";

  it("pins the minor of the synth package this repository installs", () => {
    const pinned = /npm install --save-dev @cosyte\/synth@~(\d+)\.(\d+)\.(\d+)\n/.exec(page(name));
    expect(pinned, "the page installs @cosyte/synth at a ~ range").not.toBeNull();
    const installed = (
      JSON.parse(readFileSync(join(ROOT, "node_modules/@cosyte/synth/package.json"), "utf8")) as {
        version: string;
      }
    ).version.split(".");
    const [, major, minor, patch] = pinned ?? [];
    expect([major, minor]).toEqual(installed.slice(0, 2));
    expect(Number(patch)).toBeLessThanOrEqual(Number(installed[2]));
  });

  it(
    "runs as written against the installed synth package: generate, update once, then pass",
    async () => {
      const shown = outputs(name);
      const dir = await starterProject();
      // The package from this repository's own install, never a checkout beside it.
      const synth = realpathSync(join(ROOT, "node_modules", "@cosyte", "synth"));
      expect(synth.startsWith(join(ROOT, "node_modules"))).toBe(true);
      await symlink(synth, join(dir, "node_modules", "@cosyte", "synth"), "dir");
      await putTitled(dir, name, "scripts/make-samples.mjs");

      const tests = join(dir, "channels/adt-to-lab/tests");
      const generate = (): void => {
        const run = spawnSync(process.execPath, ["scripts/make-samples.mjs"], {
          cwd: dir,
          encoding: "utf8",
        });
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
      };
      generate();
      const first = await Promise.all(
        ["synth-a01.hl7", "synth-a08.hl7"].map((file) => readFile(join(tests, file))),
      );
      generate();
      for (const [index, file] of ["synth-a01.hl7", "synth-a08.hl7"].entries()) {
        expect(await readFile(join(tests, file))).toEqual(first[index]);
      }
      expect(parseHL7(first[0] ?? Buffer.alloc(0)).is("ADT^A01")).toBe(true);
      expect(parseHL7(first[1] ?? Buffer.alloc(0)).is("ADT^A08")).toBe(true);

      const starterExpected = await readFile(join(tests, "a01.expected.hl7"));
      const update = cli(["test", "adt-to-lab", "--update"], dir);
      expect(update.code).toBe(0);
      expect(update.out.trimEnd()).toBe(shown[0]);
      expect(await readFile(join(tests, "a01.expected.hl7"))).toEqual(starterExpected);
      const admission = await readFile(join(tests, "synth-a01.expected.hl7"));
      expect(parseHL7(admission).get("MSH.5")).toBe("LAB");
      expect(await readFile(join(tests, "synth-a08.expected.hl7"), "utf8")).toBe("");

      const check = cli(["test", "adt-to-lab"], dir);
      expect(check.code).toBe(0);
      expect(check.out.trimEnd()).toBe(shown[1]);
    },
    SLOW,
  );
});

/** Runs a transform from a page in a channel worker, as the engine does, on each input in turn. */
async function transformWith(
  dir: string,
  transformFile: string,
  format: "hl7v2" | "fhir" | "x12" | "json" | "csv" | "xml",
  inputs: readonly string[],
  csv?: CsvSettings,
  xml?: XmlSettings,
): Promise<(readonly string[] | string)[]> {
  const worker = new ChannelWorker({
    channel: "docs",
    transformFile: join(dir, transformFile),
    format,
    csv,
    xml,
    timeoutMs: 10_000,
    memoryMb: 256,
  });
  await worker.start();
  try {
    const results: (readonly string[] | string)[] = [];
    for (const input of inputs) {
      const outcome = await worker.run(new TextEncoder().encode(input));
      results.push(
        outcome.ok
          ? outcome.outputs.map((output) => new TextDecoder().decode(output))
          : `${outcome.failure.kind}: ${outcome.failure.name}`,
      );
    }
    return results;
  } finally {
    await worker.stop();
  }
}

describe("transform and filter messages", () => {
  const name = "transform-and-filter-messages.md";

  it(
    "edits admissions and registrations and filters the rest",
    async () => {
      const dir = await starterProject();
      await putTitled(dir, name, "channels/adt-to-lab/transform.ts");
      const a04 = ADT_A01.replace("ADT^A01^ADT_A01", "ADT^A04^ADT_A01");
      const [a01, registered, a08] = await transformWith(
        dir,
        "channels/adt-to-lab/transform.ts",
        "hl7v2",
        [ADT_A01, a04, ADT_A08],
      );
      const sent = parseHL7(String((a01 as string[])[0]));
      expect([sent.get("MSH.5"), sent.get("MSH.6")]).toEqual(["LAB", "SYNTHHOSP"]);
      expect(registered).toHaveLength(1);
      expect(a08).toEqual([]);
    },
    SLOW,
  );

  it(
    "splits an export into one message per record",
    async () => {
      const dir = await starterProject();
      await putTitled(dir, name, "channels/export-to-records/transform.ts");
      const results = await transformWith(dir, "channels/export-to-records/transform.ts", "json", [
        '[{"id":"TEST0001"},{"id":"TEST0002"}]',
        '{"id":"TEST0003"}',
      ]);
      expect(results).toEqual([['{"id":"TEST0001"}', '{"id":"TEST0002"}'], ['{"id":"TEST0003"}']]);
    },
    SLOW,
  );

  it(
    "maps local codes to LOINC from codes.json, and fails a message with an unknown code",
    async () => {
      const dir = await starterProject();
      await putTitled(dir, name, "channels/results-to-ehr/transform.ts");
      await putTitled(dir, name, "channels/results-to-ehr/codes.json");
      const oru = [
        "MSH|^~\\&|SYNTHLAB|SYNTHHOSP|EHR|SYNTHHOSP|20261107130000||ORU^R01^ORU_R01|SYNTH00101|P|2.5.1",
        "OBR|1||SYNTHORD0001",
        "OBX|1|NM|GLU^Glucose^L||5.4|mmol/L",
        "OBX|2|NM|K^Potassium^L||4.1|mmol/L",
      ].join("\r");
      const [mapped, unknown] = await transformWith(
        dir,
        "channels/results-to-ehr/transform.ts",
        "hl7v2",
        [oru, oru.replace("K^Potassium", "NA^Sodium")],
      );
      const sent = parseHL7(String((mapped as string[])[0]));
      expect([sent.get("OBX[0].3.1"), sent.get("OBX[0].3.3"), sent.get("OBX[1].3.1")]).toEqual([
        "2345-7",
        "LN",
        "2823-3",
      ]);
      expect(unknown).toBe("transform: Error");
    },
    SLOW,
  );
});

describe("handle FHIR, X12, C-CDA, JSON, CSV, XML and text", () => {
  const name = "work-with-formats.md";

  it(
    "keeps FHIR patients, X12 claim groups, and turns an admission into a FHIR Patient",
    async () => {
      const dir = await starterProject();
      for (const title of [
        "channels/patients-in/transform.ts",
        "channels/claims-in/transform.ts",
        "channels/adt-to-fhir/transform.ts",
      ]) {
        await putTitled(dir, name, title);
      }
      const observation = JSON.stringify({
        resourceType: "Observation",
        status: "final",
        code: { text: "test" },
      });
      expect(
        await transformWith(dir, "channels/patients-in/transform.ts", "fhir", [
          FHIR_PATIENT,
          observation,
        ]),
      ).toEqual([[FHIR_PATIENT], []]);

      const claims = X12_270.replace("GS*HS", "GS*HC");
      const [eligibility, claim] = await transformWith(
        dir,
        "channels/claims-in/transform.ts",
        "x12",
        [X12_270, claims],
      );
      expect(eligibility).toEqual([]);
      expect(claim).toHaveLength(1);

      const [patient, update] = await transformWith(
        dir,
        "channels/adt-to-fhir/transform.ts",
        "hl7v2",
        [ADT_A01, ADT_A08],
      );
      expect(JSON.parse(String((patient as string[])[0]))).toEqual({
        resourceType: "Patient",
        identifier: [{ value: "TEST000001" }],
        name: [{ family: "TESTPATIENT", given: ["ALPHA"] }],
      });
      expect(update).toEqual([]);
    },
    SLOW,
  );

  it(
    "drops inactive rows and upper-cases codes with the page's csv settings",
    async () => {
      const dir = await starterProject();
      await putTitled(dir, name, "channels/codes-in/transform.ts");
      const settings = (
        parseYaml(titled(name, "channels/codes-in/channel.yaml")) as { csv: CsvSettings }
      ).csv;
      expect(
        await transformWith(
          dir,
          "channels/codes-in/transform.ts",
          "csv",
          ["code;status;note\ntest-001;active;=1+2\ntest-002;inactive;x\ntest-003;active;y\n"],
          settings,
        ),
      ).toEqual([['code;status;note\nTEST-001;active;"\'=1+2"\nTEST-003;active;y\n']]);
    },
    SLOW,
  );

  it(
    "sends new orders on as sent, with the page's xml settings",
    async () => {
      const dir = await starterProject();
      await putTitled(dir, name, "channels/orders-in/transform.ts");
      const settings = (
        parseYaml(titled(name, "channels/orders-in/channel.yaml")) as { xml: XmlSettings }
      ).xml;
      expect(settings).toEqual({ maxBytes: 1_048_576, maxDepth: 64 });
      const deep = `<order status='new'>${"<a>".repeat(64)}${"</a>".repeat(64)}</order>`;
      expect(
        await transformWith(
          dir,
          "channels/orders-in/transform.ts",
          "xml",
          [
            "<order id='TEST-ORDER-001' status='new'/>",
            "<order id='TEST-ORDER-002' status='held'/>",
            deep,
          ],
          undefined,
          settings,
        ),
      ).toEqual([['<order id="TEST-ORDER-001" status="sent"/>'], [], "parse: CcdaParseError"]);
    },
    SLOW,
  );
});

/** A table row's words, whatever its padding: column widths follow the values in them. */
function words(line: string | undefined): string[] {
  return (line ?? "").trim().split(/\s+/);
}

/** The starter's `pathways.yaml` with a page's block added at the end. */
async function addToProjectYaml(dir: string, block: string): Promise<void> {
  const file = join(dir, "pathways.yaml");
  await writeFile(file, `${await readFile(file, "utf8")}\n${block}\n`);
}

describe("read and forward the audit log", () => {
  it(
    "forwards each audit entry to a file through the hook on the page",
    async () => {
      const name = "read-the-audit-log.md";
      const dir = await starterProject();
      await putTitled(dir, name, "hooks/audit-to-file.ts");
      await addToProjectYaml(dir, titled(name, "pathways.yaml"));
      expect(cli(["messages"], dir).code).toBe(0);
      const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        type: "audit",
        action: "search",
        outcome: "ok",
      });
      const audit = cli(["audit"], dir).out.split("\n")[0];
      expect(words(audit)).toEqual(words(outputs(name)[0]?.split("\n")[0]));
    },
    SLOW,
  );
});

/** A local HTTP server that keeps each request's headers and body. */
async function recorder(): Promise<{
  url: string;
  requests: { headers: IncomingMessage["headers"]; body: string }[];
  close: () => Promise<void>;
}> {
  const requests: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      requests.push({ headers: request.headers, body });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/alerts`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

describe("lifecycle hooks", () => {
  it(
    "pages on a failed transform through the hook on the page",
    async () => {
      const name = "add-lifecycle-hooks.md";
      const pager = await recorder();
      try {
        const dir = await starterProject();
        await putTitled(dir, name, "hooks/pager.ts");
        await addToProjectYaml(
          dir,
          titled(name, "pathways.yaml").replace("https://pager.example.com/alerts", pager.url),
        );
        await put(
          dir,
          "channels/adt-to-lab/transform.ts",
          'export default () => { throw new Error("broken"); };\n',
        );
        const inbox = join(dir, "data/adt-to-lab/in");
        await put(dir, "data/adt-to-lab/in/a01.hl7", ADT_A01);
        await age(join(inbox, "a01.hl7"));
        expect(
          (await cliAsync(["start", "--once"], dir, { PAGER_TOKEN: "synthetic-pager-token" })).code,
        ).toBe(0);
        expect(pager.requests).toHaveLength(1);
        expect(pager.requests[0]?.headers.authorization).toBe("Bearer synthetic-pager-token");
        expect(JSON.parse(pager.requests[0]?.body ?? "")).toMatchObject({
          summary: "adt-to-lab: transform-failed",
        });
      } finally {
        await pager.close();
      }
    },
    SLOW,
  );
});

describe("custom connectors", () => {
  const name = "write-custom-connectors.md";

  it(
    "takes newline-delimited JSON in, stores a part-done file once, and appends each record",
    async () => {
      const dir = await starterProject();
      for (const title of [
        "channels/export-in/channel.yaml",
        "channels/export-in/ndjson-source.ts",
        "channels/export-in/ndjson-destination.ts",
      ]) {
        await putTitled(dir, name, title);
      }
      const records = '{"id":"TEST0001"}\n{"id":"TEST0002"}\n';
      await put(dir, "data/export-in/in/export.ndjson", records);
      // A file an earlier run took and stopped part way through: its lines are stored as resumed.
      await put(dir, "data/export-in/in/.taken/1000-earlier.ndjson", '{"id":"TEST0003"}\n');
      expect(cli(["start", "--once"], dir).code).toBe(0);
      const out = join(dir, "data/export-in/records.ndjson");
      expect((await readFile(out, "utf8")).split("\n").filter(Boolean).sort()).toEqual([
        '{"id":"TEST0001"}',
        '{"id":"TEST0002"}',
        '{"id":"TEST0003"}',
      ]);
      expect(await readdir(join(dir, "data/export-in/in/.taken"))).toEqual([]);

      // The same part-done file handed in again is stored once: nothing new to deliver.
      await put(dir, "data/export-in/in/.taken/1000-earlier.ndjson", '{"id":"TEST0003"}\n');
      expect(cli(["start", "--once"], dir).code).toBe(0);
      expect((await readFile(out, "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
    },
    SLOW,
  );

  it(
    "builds the default ACK with MSH-3 set",
    async () => {
      const dir = await starterProject();
      await putTitled(dir, name, "channels/adt-in/ack.ts");
      const module = (await import(pathToFileURL(join(dir, "channels/adt-in/ack.ts")).href)) as {
        default: (request: unknown) => Uint8Array;
      };
      const header = parseHL7(Buffer.from(ADT_A01.split("\r")[0] ?? ""));
      const ack = parseHL7(
        Buffer.from(
          module.default({
            code: "AA",
            reason: "stored",
            problem: undefined,
            header,
            messageId: 1,
          }),
        ),
      );
      expect([ack.get("MSH.3"), ack.get("MSA.1"), ack.get("MSA.2")]).toEqual([
        "PATHWAYS",
        "AA",
        "MSG00001",
      ]);
    },
    SLOW,
  );
});

describe("inspect, replay and clear messages", () => {
  it(
    "replays a failed message once its transform is fixed, refuses a clear, and exits 4 for none",
    async () => {
      const name = "inspect-replay-and-clear-messages.md";
      const dir = await starterProject();
      const transform = join(dir, "channels/adt-to-lab/transform.ts");
      const fixed = await readFile(transform, "utf8");
      await writeFile(transform, 'export default () => { throw new Error("broken"); };\n');
      await put(dir, "data/adt-to-lab/in/a01.hl7", ADT_A01);
      await age(join(dir, "data/adt-to-lab/in/a01.hl7"));
      expect(cli(["start", "--once"], dir).code).toBe(0);
      expect(cli(["messages", "--status", "failed"], dir).out).toMatch(/^1\s+adt-to-lab\s+failed/m);
      expect(words(cli(["messages"], dir).out.split("\n")[0])).toEqual(
        words(outputs(name)[0]?.split("\n")[0]),
      );

      await writeFile(transform, fixed);
      const replay = cli(["replay", "1"], dir);
      expect(replay.code).toBe(0);
      // The page replays message 17; this project's failed message is message 1.
      expect(replay.out.trimEnd()).toBe(outputs(name)[1]?.replace("message 17", "message 1"));
      expect(cli(["start", "--once"], dir).code).toBe(0);
      expect(await readdir(join(dir, "data/adt-to-lab/out"))).toEqual(["1-1.hl7"]);

      expect(cli(["clear", "1"], dir).code).toBe(1);
      expect(cli(["messages", "show", "99"], dir).code).toBe(4);
    },
    SLOW,
  );
});

describe("encrypt stored messages and rotate keys", () => {
  const name = "encrypt-stored-messages.md";

  it(
    "rotates to a new key with rekey, and reads every value once the old key is gone",
    async () => {
      const dir = await starterProject();
      const env = { PATHWAYS_KEY_2026_11: generateKey(), PATHWAYS_KEY_2027_05: generateKey() };
      await put(dir, "pathways.yaml", `${titled(name, "pathways.yaml", 0)}\n`);
      await put(dir, "data/adt-to-lab/in/a01.hl7", ADT_A01);
      await age(join(dir, "data/adt-to-lab/in/a01.hl7"));
      expect(cli(["start", "--once"], dir, env).code).toBe(0);

      await put(dir, "pathways.yaml", `${titled(name, "pathways.yaml", 2)}\n`);
      const rekey = cli(["rekey"], dir, env);
      expect(rekey.code).toBe(0);
      expect(rekey.out).toMatch(/^re-encrypted under the current key: [1-9]/m);
      expect(rekey.out).toMatch(/^already under the current key: 0$/m);

      await put(
        dir,
        "pathways.yaml",
        "encryption:\n  keys:\n    - id: prod-2027-05\n      env: PATHWAYS_KEY_2027_05\n  current: prod-2027-05\n",
      );
      const show = cli(["messages", "show", "1", "--content"], dir, env);
      expect(show.code).toBe(0);
      expect(show.out).toContain("TESTPATIENT^ALPHA");
    },
    SLOW,
  );

  it(
    "encrypts what was stored while encryption was none, with --encrypt-plaintext",
    async () => {
      const dir = await starterProject();
      await put(dir, "pathways.yaml", `${titled(name, "pathways.yaml", 3)}\n`);
      await put(dir, "data/adt-to-lab/in/a01.hl7", ADT_A01);
      await age(join(dir, "data/adt-to-lab/in/a01.hl7"));
      expect(cli(["start", "--once"], dir).code).toBe(0);

      const env = { PATHWAYS_KEY_2026_11: generateKey() };
      await put(dir, "pathways.yaml", `${titled(name, "pathways.yaml", 0)}\n`);
      const plain = cli(["rekey"], dir, env);
      expect(plain.code).toBe(1);
      expect(plain.out).toMatch(/^left unencrypted: [1-9]/m);
      expect(cli(["rekey", "--encrypt-plaintext"], dir, env).code).toBe(0);
      expect(cli(["rekey"], dir, env).code).toBe(0);
    },
    SLOW,
  );
});

describe("set message retention", () => {
  it(
    "prints a dry run as the page shows",
    async () => {
      const dir = await starterProject();
      const dry = cli(["retention", "--dry-run"], dir);
      expect(dry.code).toBe(0);
      expect(dry.out.split("\n")[0]).toBe(outputs("set-message-retention.md")[0]?.split("\n")[0]);
      expect(cli(["audit"], dir).out).not.toMatch(/retention/);
    },
    SLOW,
  );
});

describe("check configuration in an editor and in CI", () => {
  const name = "check-configuration.md";

  it("names the schema files the build writes, and they are the schemas the code makes", () => {
    const made = configJsonSchemas();
    for (const [kind, subpath] of [
      ["project", "@cosyte/pathways/schema/project.json"],
      ["channel", "@cosyte/pathways/schema/channel.json"],
    ] as const) {
      const installedPath = `node_modules/@cosyte/pathways/schema/${kind}.json`;
      expect(page(name)).toContain(`| \`${subpath}\` | \`${installedPath}\` |`);
      const built = join(ROOT, "schema", `${kind}.json`);
      expect(JSON.parse(readFileSync(built, "utf8"))).toEqual(made[kind]);
      // The modelines on the page name the same files the starter's do.
      expect(page(name)).toContain(
        `$schema=${kind === "project" ? "./" : "../../"}${installedPath}`,
      );
    }
  });

  it(
    "prints what the page shows for the starter, and for it with the transform missing",
    async () => {
      const dir = await starterProject();
      const [valid, invalid] = outputs(name);
      expect(cli(["validate"], dir)).toEqual({ code: 0, out: `${valid ?? ""}\n`, err: "" });
      await rm(join(dir, "channels", "adt-to-lab", "transform.ts"));
      expect(cli(["validate"], dir)).toEqual({ code: 3, out: "", err: `${invalid ?? ""}\n` });
    },
    SLOW,
  );
});

describe("check status and health", () => {
  it(
    "serves the health body the page shows, and stops cleanly on SIGTERM where there is one",
    async () => {
      const { body, ready } = await onPickedPorts(2, async ([port = 0, probePort = 0]) => {
        const dir = await starterProject();
        await addToProjectYaml(
          dir,
          `health:\n  port: ${port}\n  plaintext: true\n  auth: none\nprobes:\n  port: ${probePort}\n  plaintext: true\n`,
        );
        const engine = startEngine(dir);
        let body: unknown;
        let ready = "";
        await orTaken(
          async () => {
            try {
              for (let tries = 0; tries < 100 && body === undefined; tries += 1) {
                try {
                  const response = await fetch(`http://127.0.0.1:${port}/`);
                  if (response.status === 200) body = await response.json();
                } catch {
                  await new Promise((done) => setTimeout(done, 100));
                }
              }
              // The probe listener the page shows, asked as the page says: one word, no token.
              for (let tries = 0; tries < 100 && ready !== "ready\n"; tries += 1) {
                ready = await (await fetch(`http://127.0.0.1:${probePort}/readyz`)).text();
                if (ready !== "ready\n") await new Promise((done) => setTimeout(done, 100));
              }
              expect(await (await fetch(`http://127.0.0.1:${probePort}/livez`)).text()).toBe(
                "live\n",
              );
              expect(cli(["probe", "--ready"], dir)).toMatchObject({ code: 0, out: "ready\n" });
              // Plaintext with auth: none, as here, refuses /metrics, as the metrics page says.
              const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
              expect(metrics.status).toBe(403);
              expect(await metrics.text()).toContain("allowUnauthenticated");
            } finally {
              const code = await engine.stop();
              // Windows: ended at once, so its exit code says nothing (test/engine-stop.test.ts).
              if (process.platform !== "win32") expect(code).toBe(0);
            }
          },
          async () => {
            await engine.stop();
            return engine.err();
          },
        );
        return { body, ready };
      });
      const shown = JSON.parse(
        fences(page("check-status-and-health.md")).find((fence) => fence.lang === "json")?.body ??
          "",
      ) as { channels: Record<string, Record<string, Record<string, number>>> };
      expect(body).toMatchObject({ status: "ok", storage: "ok" });
      expect(ready).toBe("ready\n");
      expect(Object.keys(body as object)).toEqual(Object.keys(shown));
      const channel = (body as typeof shown).channels["adt-to-lab"];
      const pictured = shown.channels["adt-to-lab"];
      expect(Object.keys(channel ?? {}).sort()).toEqual(Object.keys(pictured ?? {}).sort());
      expect(Object.keys(channel?.["messages"] ?? {}).sort()).toEqual(
        Object.keys(pictured?.["messages"] ?? {}).sort(),
      );
      expect(Object.keys(channel?.["deliveries"] ?? {}).sort()).toEqual(
        Object.keys(pictured?.["deliveries"] ?? {}).sort(),
      );
    },
    SLOW,
  );
});

describe("the configuration page and the troubleshooting page", () => {
  /** Every line of the page's `text` blocks that the command printed, as the page shows it. */
  const shownLine = (name: string, start: string): string => {
    const line = outputs(name)
      .flatMap((block) => block.split("\n"))
      .map((l) => l.trim())
      .find((l) => l.startsWith(start));
    if (line === undefined) throw new Error(`${name} shows no line starting ${start}`);
    return line;
  };

  it(
    "prints each configuration error the pages show",
    async () => {
      const dir = await starterProject();
      const starterYaml = await readFile(join(dir, "pathways.yaml"), "utf8");
      const errorOf = (args: readonly string[], env: Record<string, string> = {}): string => {
        const result = cli(args, dir, env);
        expect(result.code).not.toBe(0);
        return result.err;
      };

      await put(dir, "pathways.yaml", "defaults:\n  timeout: 5s\n");
      expect(errorOf(["start", "--once"])).toContain(
        shownLine("troubleshooting.md", "pathways.yaml: encryption: required"),
      );
      await put(dir, "pathways.yaml", titled("encrypt-stored-messages.md", "pathways.yaml", 0));
      expect(errorOf(["start", "--once"])).toContain(
        shownLine("troubleshooting.md", "pathways.yaml: encryption.keys.0"),
      );
      await put(dir, "pathways.yaml", starterYaml);

      await put(
        dir,
        "channels/adt-in/channel.yaml",
        "source:\n  mllp:\n    port: 2575\ndestinations:\n  - file: { dir: out }\n",
      );
      expect(errorOf(["test"])).toContain(
        shownLine("troubleshooting.md", "channels/adt-in/channel.yaml"),
      );
      expect(errorOf(["test"])).toContain(
        shownLine("configure-a-channel.md", "channels/adt-to-lab/channel.yaml").replace(
          "adt-to-lab",
          "adt-in",
        ),
      );
      await rm(join(dir, "channels/adt-in"), { recursive: true });

      await put(
        dir,
        "channels/claims/channel.yaml",
        "format: x12\nsource:\n  mllp: { port: 2575, plaintext: true }\ndestinations:\n  - file: { dir: out }\n",
      );
      expect(errorOf(["test"])).toContain(
        shownLine("troubleshooting.md", "channels/claims/channel.yaml"),
      );
      await rm(join(dir, "channels/claims"), { recursive: true });

      await put(
        dir,
        "channels/results-in/channel.yaml",
        "source:\n  http: { port: 18443, plaintext: true }\ndestinations:\n  - file: { dir: out }\n",
      );
      expect(errorOf(["start", "--once"])).toContain(
        shownLine("troubleshooting.md", "channels/results-in/channel.yaml"),
      );
      await rm(join(dir, "channels/results-in"), { recursive: true });

      const transform = join(dir, "channels/adt-to-lab/transform.ts");
      const fixed = await readFile(transform, "utf8");
      await writeFile(transform, "enum Kind { A }\nexport default (m: unknown) => m;\n");
      expect(errorOf(["start", "--once"])).toContain(
        shownLine("troubleshooting.md", "pathways: channel adt-to-lab"),
      );
      await writeFile(transform, fixed);

      const expected = join(dir, "channels/adt-to-lab/tests/a01.expected.hl7");
      await writeFile(expected, (await readFile(expected, "utf8")).replaceAll("\r", "\n"));
      expect(cli(["test"], dir).out).toContain(
        shownLine("troubleshooting.md", "FAIL adt-to-lab/tests/a01.hl7"),
      );
    },
    SLOW,
  );

  it(
    "stops the engine on a value under a key that is no longer configured",
    async () => {
      const dir = await starterProject();
      const keys = { PATHWAYS_KEY_2026_05: generateKey(), PATHWAYS_KEY_2026_11: generateKey() };
      await put(
        dir,
        "pathways.yaml",
        "encryption:\n  keys:\n    - id: prod-2026-05\n      env: PATHWAYS_KEY_2026_05\n  current: prod-2026-05\n",
      );
      // A destination nobody listens on, so the output stays queued under the old key.
      await put(
        dir,
        "channels/adt-to-lab/channel.yaml",
        "source:\n  file: { dir: ../../data/in }\ndestinations:\n  - mllp: { host: 127.0.0.1, port: 9, plaintext: true, ackTimeout: 1s }\n",
      );
      await put(dir, "data/in/a01.hl7", ADT_A01);
      await age(join(dir, "data/in/a01.hl7"));
      expect(cli(["start", "--once"], dir, keys).code).toBe(0);
      await put(
        dir,
        "pathways.yaml",
        `${titled("encrypt-stored-messages.md", "pathways.yaml", 0)}\n`,
      );
      const stopped = cli(["start", "--once"], dir, keys);
      expect(stopped.code).toBe(1);
      expect(stopped.err).toContain(
        shownLine("troubleshooting.md", "pathways: the engine stopped"),
      );
    },
    SLOW,
  );
});

afterAll(removeProjects);
