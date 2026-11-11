// The format equivalence test: every input of the output-equivalence corpus
// (test/equivalence/corpus.json), run through `pathways test` in one channel a format, and on two
// channels with a transform of their own, against the outputs and the report the base commit gave
// (test/equivalence/pathways-test.json). It holds each format's decode and encode to the same bytes
// through the command a user runs, so a change to how formats are declared changes no output.
//
// The recorded outputs are written only from the base commit, or for an output a change sets out
// to change and names: PATHWAYS_EQUIVALENCE_WRITE=1 pnpm test test/format-equivalence.test.ts. No
// CI job sets that variable.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import { expectedName } from "../src/testing/run-tests.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

interface CorpusEntry {
  readonly id: string;
  readonly format: string;
  readonly body: string;
}

/** What the base commit gave: each expected file (`=` when it is the input's own bytes), and the report. */
interface Recorded {
  readonly expected: Record<string, string>;
  readonly report: string[];
  readonly code: number;
}

const HERE = fileURLToPath(new URL("equivalence/", import.meta.url));
const CORPUS = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")) as CorpusEntry[];
const RECORDED_FILE = join(HERE, "pathways-test.json");
const WRITE = process.env["PATHWAYS_EQUIVALENCE_WRITE"] === "1";
const RECORDED = (
  existsSync(RECORDED_FILE)
    ? JSON.parse(readFileSync(RECORDED_FILE, "utf8"))
    : { expected: {}, report: [], code: 0 }
) as Recorded;

afterAll(cleanUp);

/** The starter's kind of edit, on HL7 v2: address the message to another facility. */
const EDIT_HL7 = [
  "export default (msg: { setField(path: string, value: string): void }) => {",
  '  msg.setField("MSH.5", "LAB");',
  "  return msg;",
  "};",
  "",
].join("\n");

/** On JSON: the value, the value in an array, a number, a boolean and a string, as five outputs. */
const MANY_JSON = "export default (msg: unknown) => [msg, [msg], 0, false, 'plain'];\n";

/** Each channel: its format, and its transform, if it has one. */
const CHANNELS: Record<string, { format: string; transform?: string }> = {
  "eq-hl7v2": { format: "hl7v2" },
  "eq-hl7v2-edit": { format: "hl7v2", transform: EDIT_HL7 },
  "eq-fhir": { format: "fhir" },
  "eq-x12": { format: "x12" },
  "eq-ccda": { format: "ccda" },
  "eq-json": { format: "json" },
  "eq-json-many": { format: "json", transform: MANY_JSON },
  "eq-text": { format: "text" },
};

/** The project: each channel with every input of its format in `tests/`. */
async function corpusProject(): Promise<{ root: string; inputs: Map<string, Uint8Array> }> {
  const files: Record<string, string | Uint8Array> = { "pathways.yaml": "" };
  const inputs = new Map<string, Uint8Array>();
  for (const [name, channel] of Object.entries(CHANNELS)) {
    files[`channels/${name}/channel.yaml`] = [
      `format: ${channel.format}`,
      "source:",
      "  file: { dir: ../../data/in }",
      ...(channel.transform === undefined ? [] : ["transform: ./transform.ts"]),
      "destinations:",
      "  - file: { dir: ../../data/out }",
      "",
    ].join("\n");
    if (channel.transform !== undefined) {
      files[`channels/${name}/transform.ts`] = channel.transform;
    }
    CORPUS.filter((entry) => entry.format === channel.format).forEach((entry, n) => {
      const input = `${name}/tests/${String(n).padStart(4, "0")}.msg`;
      const body = new Uint8Array(Buffer.from(entry.body, "base64"));
      inputs.set(input, body);
      files[`channels/${input}`] = body;
    });
  }
  return { root: await makeProject(files), inputs };
}

async function pathwaysTest(argv: readonly string[]): Promise<{ code: number; lines: string[] }> {
  let out = "";
  const { logger } = captureLogger();
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      out += text;
    },
    logger,
    env: {},
  });
  return { code, lines: out.split("\n").filter((line) => line !== "") };
}

describe("format equivalence through pathways test", () => {
  it(
    "gives every corpus input the output and report line the base commit gave",
    { timeout: 240_000 },
    async () => {
      const { root, inputs } = await corpusProject();
      if (WRITE) {
        // Inputs that do not parse fail here too; every other one has its output saved.
        await pathwaysTest(["test", "--update", "-C", root]);
        const expected: Record<string, string> = {};
        for (const [input, body] of inputs) {
          const [channel, , file] = input.split("/") as [string, string, string];
          const dir = join(root, "channels", channel, "tests");
          const name = expectedName(file);
          if (!(await readdir(dir)).includes(name)) continue;
          const output = await readFile(join(dir, name));
          expected[input] = output.equals(Buffer.from(body)) ? "=" : output.toString("base64");
        }
        const { code, lines } = await pathwaysTest(["test", "-C", root]);
        writeFileSync(
          RECORDED_FILE,
          `${JSON.stringify({ expected, report: lines, code } satisfies Recorded, null, 2)}\n`,
        );
        return;
      }

      // Every input of every format is in the corpus run, and most of them pass.
      expect(inputs.size).toBeGreaterThan(500);
      const passes = RECORDED.report.filter((line) => line.startsWith("PASS "));
      expect(passes.length).toBeGreaterThan(inputs.size / 2);

      const files: Record<string, string | Uint8Array> = {};
      for (const [input, output] of Object.entries(RECORDED.expected)) {
        const [channel, , file] = input.split("/") as [string, string, string];
        /* v8 ignore next -- every recorded input is in the corpus */
        const body = inputs.get(input) ?? new Uint8Array();
        files[join(root, "channels", channel, "tests", expectedName(file))] =
          output === "=" ? body : new Uint8Array(Buffer.from(output, "base64"));
      }
      for (const [path, contents] of Object.entries(files)) writeFileSync(path, contents);

      const { code, lines } = await pathwaysTest(["test", "-C", root]);
      expect(lines).toEqual(RECORDED.report);
      expect(code).toBe(RECORDED.code);
    },
  );
});
