import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { serializeCcda } from "@cosyte/ccda";
import { complex, parseResource, serializeResource } from "@cosyte/fhir";
import { generateCcd } from "@cosyte/synth/ccda";
import { generatePatient } from "@cosyte/synth/fhir";
import { generate835, generate837P } from "@cosyte/synth/x12";
import { serializeX12 } from "@cosyte/x12";
import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ChannelConfig } from "../src/config/schema.js";
import type { FailureSummary } from "../src/engine/worker-entry.js";
import {
  describeFailure,
  expectedName,
  firstDifference,
  runChannelTests,
} from "../src/testing/run-tests.js";
import {
  ADT_A01,
  ADT_A08,
  cleanUp,
  FHIR_PATIENT,
  LAB_TRANSFORM,
  makeProject,
  X12_270,
} from "./helpers.js";

afterEach(cleanUp);

const CHANNEL =
  "source:\n  file: { dir: in }\ntransform: ./transform.ts\ndestinations:\n  - file: { dir: out }\n";
const LABBED = ADT_A01.replace("|LAB|", "|LAB2|");

async function runIn(files: Record<string, string>, update = false) {
  const root = await makeProject(files);
  const project = await loadProject(root);
  const lines: string[] = [];
  const summary = await runChannelTests(project.channels, {
    update,
    out: (line) => lines.push(line),
  });
  return { root, summary, lines };
}

describe("runChannelTests", () => {
  it("passes outputs that match, including a filtered message's empty file", async () => {
    const { summary, lines } = await runIn({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
      "channels/adt/tests/a01.hl7": ADT_A01,
      "channels/adt/tests/a01.expected.hl7": LABBED,
      "channels/adt/tests/a08.hl7": ADT_A08,
      "channels/adt/tests/a08.expected.hl7": "",
    });
    expect(summary).toEqual({ passed: 2, failed: 0, updated: 0 });
    expect(lines).toEqual(["PASS adt/tests/a01.hl7", "PASS adt/tests/a08.hl7"]);
  });

  it("fails an output that differs, naming the line but not quoting it", async () => {
    const { summary, lines } = await runIn({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
      "channels/adt/tests/a01.hl7": ADT_A01,
      "channels/adt/tests/a01.expected.hl7": ADT_A01,
    });
    expect(summary.failed).toBe(1);
    expect(lines).toEqual([
      "FAIL adt/tests/a01.hl7: output differs from the expected at line 1, column 27 (a01.expected.hl7)",
    ]);
  });

  it("fails an input with no expected file, and --update saves every current output", async () => {
    const files = {
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": "export default (m: unknown) => [m, m];\n",
      "channels/adt/tests/a01.hl7": ADT_A01,
    };
    const missing = await runIn(files);
    expect(missing.lines).toEqual([
      'FAIL adt/tests/a01.hl7: no a01.expected.hl7; run "pathways test --update" to save the current output',
    ]);
    const updated = await runIn(files, true);
    expect(updated.summary).toEqual({ passed: 0, failed: 0, updated: 1 });
    expect(updated.lines).toEqual(["UPDATED adt/tests/a01.hl7 -> a01.expected.hl7"]);
    expect(await readFile(join(updated.root, "channels/adt/tests/a01.expected.hl7"), "utf8")).toBe(
      `${ADT_A01}\n${ADT_A01}`,
    );
  });

  it("reports a transform that throws, an input it cannot parse, and a channel with no tests", async () => {
    const { summary, lines } = await runIn({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts":
        "export default (m: { is(t: string): boolean }) => {\n  if (m.is('ADT^A08')) throw new TypeError('x');\n  return m;\n};\n",
      "channels/adt/tests/a.hl7": "not hl7",
      "channels/adt/tests/b.hl7": ADT_A08,
      "channels/quiet/channel.yaml":
        "source:\n  file: { dir: in }\ndestinations:\n  - file: { dir: out }\n",
    });
    expect(summary).toEqual({ passed: 0, failed: 2, updated: 0 });
    expect(lines[0]).toBe(
      "FAIL adt/tests/a.hl7: the input could not be parsed as hl7v2 (NO_MSH_SEGMENT)",
    );
    expect(lines[1]).toMatch(
      /^FAIL adt\/tests\/b\.hl7: the transform threw TypeError at transform\.ts:2:\d+$/,
    );
    expect(lines[2]).toBe("SKIP quiet: no inputs in tests/");
  });

  it("fails every input of a channel whose transform will not load", async () => {
    const { summary, lines } = await runIn({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": "export const nothing = 1;\n",
      "channels/adt/tests/a.hl7": ADT_A01,
      "channels/adt/tests/b.hl7": ADT_A01,
    });
    expect(summary.failed).toBe(2);
    expect(lines).toEqual(["FAIL adt: the transform could not be loaded (TypeError)"]);
  });
});

/** A channel of `format`, reading `tests/` through `transform.ts`. */
const channelOf = (format: string): string =>
  `format: ${format}\nsource:\n  file: { dir: in }\ntransform: ./transform.ts\ndestinations:\n  - file: { dir: out }\n`;

describe("runChannelTests, for every format", () => {
  it("runs FHIR resources through a transform that edits the model", async () => {
    // Transforms in a test project import nothing, so they name the model's shape themselves.
    const transform = `
interface Resource { kind: "complex"; properties: readonly { name: string }[] }
export default (resource: Resource): Resource => ({
  ...resource,
  properties: resource.properties.filter((property) => property.name !== "text"),
});
`;
    const generated = serializeResource(generatePatient({ seed: 21, profile: "us-core" }));
    const read = parseResource(generated).resource;
    const withoutText = serializeResource(
      complex(read.properties.filter((property) => property.name !== "text")),
    );
    expect(withoutText).not.toBe(generated);
    const { summary, lines } = await runIn({
      "channels/fhir/channel.yaml": channelOf("fhir"),
      "channels/fhir/transform.ts": transform,
      "channels/fhir/tests/a.json": FHIR_PATIENT,
      "channels/fhir/tests/a.expected.json": FHIR_PATIENT,
      "channels/fhir/tests/b.json": generated,
      "channels/fhir/tests/b.expected.json": withoutText,
      "channels/fhir/tests/c.json": "[]",
    });
    expect(lines).toEqual([
      "PASS fhir/tests/a.json",
      "PASS fhir/tests/b.json",
      "FAIL fhir/tests/c.json: the input could not be parsed as fhir (MALFORMED_JSON)",
    ]);
    expect(summary).toEqual({ passed: 2, failed: 1, updated: 0 });
  });

  it("runs X12 interchanges through a transform that keeps claims and filters the rest", async () => {
    const transform = `
interface Interchange { groups: readonly { transactions: readonly { st: { elements: readonly string[] } }[] }[] }
export default (interchange: Interchange): Interchange | null =>
  interchange.groups.some((group) => group.transactions.some((tx) => tx.st.elements[1] === "837"))
    ? interchange
    : null;
`;
    const claim = serializeX12(generate837P({ seed: 22 }));
    const files = {
      "channels/x12/channel.yaml": channelOf("x12"),
      "channels/x12/transform.ts": transform,
      "channels/x12/tests/claim.x12": claim,
      "channels/x12/tests/inquiry.x12": X12_270,
      "channels/x12/tests/remittance.x12": serializeX12(generate835({ seed: 23 })),
      "channels/x12/tests/truncated.x12": "ISA*00",
    };
    const updated = await runIn(files, true);
    expect(updated.lines.at(-1)).toBe(
      "FAIL x12/tests/truncated.x12: the input could not be parsed as x12 (X12_ISA_TOO_SHORT)",
    );
    const saved = (name: string): Promise<string> =>
      readFile(join(updated.root, "channels/x12/tests", name), "utf8");
    expect(await saved("claim.expected.x12")).toBe(claim);
    expect(await saved("inquiry.expected.x12")).toBe("");
    expect(await saved("remittance.expected.x12")).toBe("");

    const { summary, lines } = await runIn({
      ...files,
      "channels/x12/tests/claim.expected.x12": claim,
      "channels/x12/tests/inquiry.expected.x12": "",
      "channels/x12/tests/remittance.expected.x12": X12_270,
    });
    expect(lines).toEqual([
      "PASS x12/tests/claim.x12",
      "PASS x12/tests/inquiry.x12",
      "FAIL x12/tests/remittance.x12: output differs from the expected at line 1, column 1 (remittance.expected.x12)",
      "FAIL x12/tests/truncated.x12: the input could not be parsed as x12 (X12_ISA_TOO_SHORT)",
    ]);
    expect(summary).toEqual({ passed: 2, failed: 2, updated: 0 });
  });

  it("runs C-CDA documents through a transform that sends the document and a count", async () => {
    const transform = `
export default (document: { sections: readonly unknown[] }) => [document, String(document.sections.length)];
`;
    const ccd = generateCcd({ seed: 24 });
    const body = serializeCcda(ccd);
    const { summary, lines } = await runIn({
      "channels/ccda/channel.yaml": channelOf("ccda"),
      "channels/ccda/transform.ts": transform,
      "channels/ccda/tests/ccd.xml": body,
      "channels/ccda/tests/ccd.expected.xml": `${body}\n${String(ccd.sections.length)}`,
      "channels/ccda/tests/html.xml": "<html/>",
    });
    expect(lines).toEqual([
      "PASS ccda/tests/ccd.xml",
      "FAIL ccda/tests/html.xml: the input could not be parsed as ccda (NOT_A_CLINICAL_DOCUMENT)",
    ]);
    expect(summary).toEqual({ passed: 1, failed: 1, updated: 0 });
  });

  it("runs JSON through a transform that adds a field, and names the column a snapshot differs at", async () => {
    const transform = "export default (m: Record<string, unknown>) => ({ ...m, routed: true });\n";
    const { summary, lines } = await runIn({
      "channels/events/channel.yaml": channelOf("json"),
      "channels/events/transform.ts": transform,
      "channels/events/tests/a.json": '{\n  "status": "ok",\n  "tries": [1, 2]\n}\n',
      "channels/events/tests/a.expected.json": '{"status":"ok","tries":[1,2],"routed":true}',
      "channels/events/tests/b.json": '{"status": "late"}',
      "channels/events/tests/b.expected.json": '{"status":"late","routed":false}',
      "channels/events/tests/c.json": '{"id": 12345678901234567890}',
    });
    expect(lines).toEqual([
      "PASS events/tests/a.json",
      "FAIL events/tests/b.json: output differs from the expected at line 1, column 27 (b.expected.json)",
      "FAIL events/tests/c.json: the input could not be parsed as json (INEXACT_JSON_NUMBER)",
    ]);
    expect(summary).toEqual({ passed: 1, failed: 2, updated: 0 });
  });

  it("reports a transform's unserializable output by its code", async () => {
    const { lines } = await runIn({
      "channels/fhir/channel.yaml": channelOf("fhir"),
      "channels/fhir/transform.ts": "export default (r: unknown) => r;\n",
      "channels/fhir/tests/a.json": '{"resourceType":"Patient","active":true,"active":false}',
    });
    expect(lines).toEqual([
      "FAIL fhir/tests/a.json: the transform's output could not be serialized (UNSERIALIZABLE_SHADOWED_PROPERTY)",
    ]);
  });
});

describe("expectedName, firstDifference and describeFailure", () => {
  it("names the expected file beside each input", () => {
    expect(expectedName("a01.hl7")).toBe("a01.expected.hl7");
    expect(expectedName("orders.v2.hl7")).toBe("orders.v2.expected.hl7");
    expect(expectedName("raw")).toBe("raw.expected");
    expect(expectedName(".dotfile")).toBe(".dotfile.expected");
  });

  it("says where outputs part ways, by line and column, line count or line ending", () => {
    const b = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(firstDifference(b("a\nb"), b("a\nc"))).toBe(
      "output differs from the expected at line 2, column 1",
    );
    expect(firstDifference(b('{"a":1,"b":2}'), b('{"a":1,"b":3}'))).toBe(
      "output differs from the expected at line 1, column 12",
    );
    expect(firstDifference(b("ab"), b("abc"))).toBe(
      "output differs from the expected at line 1, column 3",
    );
    expect(firstDifference(b("a\nb\nc"), b("a\nb"))).toBe("output has 3 lines; the expected has 2");
    expect(firstDifference(b("a\rb"), b("a\nb"))).toBe(
      "output differs from the expected in its line endings",
    );
  });

  it("puts every kind of failure into words without the error's text", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const [channel] = (await loadProject(root)).channels;
    const describe_ = (failure: FailureSummary): string =>
      describeFailure(failure, channel as ChannelConfig);
    const base = { name: "Error", detail: "SECRET" };
    expect(describe_({ ...base, kind: "load", where: "transform.ts:1:1" })).toBe(
      "the transform could not be loaded (Error at transform.ts:1:1)",
    );
    expect(describe_({ ...base, kind: "parse" })).toBe(
      "the input could not be parsed as hl7v2 (Error)",
    );
    expect(describe_({ ...base, kind: "transform" })).toBe("the transform threw Error");
    expect(describe_({ ...base, kind: "output" })).toBe(
      "the transform returned something that is neither a message nor a string",
    );
    expect(describe_({ ...base, kind: "output", code: "UNSERIALIZABLE_SHADOWED_PROPERTY" })).toBe(
      "the transform's output could not be serialized (UNSERIALIZABLE_SHADOWED_PROPERTY)",
    );
    expect(describe_({ ...base, kind: "timeout" })).toBe("the transform ran longer than 5000 ms");
    expect(describe_({ ...base, kind: "memory" })).toBe(
      "the transform worker ran out of memory (cap 256 MB)",
    );
    expect(describe_({ ...base, kind: "crash" })).toBe("the transform worker stopped unexpectedly");
  });
});
