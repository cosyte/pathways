import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
import { ADT_A01, ADT_A08, cleanUp, LAB_TRANSFORM, makeProject } from "./helpers.js";

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
      "FAIL adt/tests/a01.hl7: output differs from the expected at line 1 (a01.expected.hl7)",
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

describe("expectedName, firstDifference and describeFailure", () => {
  it("names the expected file beside each input", () => {
    expect(expectedName("a01.hl7")).toBe("a01.expected.hl7");
    expect(expectedName("orders.v2.hl7")).toBe("orders.v2.expected.hl7");
    expect(expectedName("raw")).toBe("raw.expected");
    expect(expectedName(".dotfile")).toBe(".dotfile.expected");
  });

  it("says where outputs part ways, by line count or line ending", () => {
    const b = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(firstDifference(b("a\nb"), b("a\nc"))).toBe(
      "output differs from the expected at line 2",
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
    expect(describe_({ ...base, kind: "timeout" })).toBe("the transform ran longer than 5000 ms");
    expect(describe_({ ...base, kind: "memory" })).toBe(
      "the transform worker ran out of memory (cap 256 MB)",
    );
    expect(describe_({ ...base, kind: "crash" })).toBe("the transform worker stopped unexpectedly");
  });
});
