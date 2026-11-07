import { join } from "node:path";

import { Hl7Message } from "@cosyte/hl7";
import { afterEach, describe, expect, it } from "vitest";

import { FORMATS } from "../src/config/schema.js";
import {
  decode,
  encode,
  loadTransform,
  runTransform,
  summarize,
  type TransformFunction,
} from "../src/engine/worker-entry.js";
import { ADT_A01, cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body);

async function failureOf(promise: Promise<unknown>, transformFile?: string) {
  try {
    await promise;
  } catch (error) {
    return summarize(error, transformFile);
  }
  throw new Error("expected a failure");
}

describe("decode and encode", () => {
  it("can decode every format the configuration accepts", () => {
    for (const format of FORMATS) expect(() => decode(format, bytes(ADT_A01))).not.toThrow();
  });

  it("parses hl7v2 into an Hl7Message and passes text through as a string", () => {
    expect(decode("hl7v2", bytes(ADT_A01))).toBeInstanceOf(Hl7Message);
    expect(decode("text", bytes("plain"))).toBe("plain");
  });

  it("serializes strings and messages, and refuses anything else", () => {
    expect(text(encode("out"))).toBe("out");
    expect(text(encode(decode("hl7v2", bytes(ADT_A01))))).toBe(ADT_A01);
    expect(() => encode({ not: "a message" })).toThrow(TypeError);
  });
});

describe("runTransform", () => {
  const identity: TransformFunction = (message) => message;

  it("runs a message through and serializes what comes back", async () => {
    const edit: TransformFunction = (message) => {
      (message as Hl7Message).setField("MSH.5", "LAB2");
      return message;
    };
    const [out] = await runTransform(edit, "hl7v2", bytes(ADT_A01));
    expect(text(out)).toContain("|LAB2|");
  });

  it("filters on null or undefined, sends several from an array, and awaits an async transform", async () => {
    expect(await runTransform(() => null, "text", bytes("x"))).toEqual([]);
    expect(await runTransform(() => undefined, "text", bytes("x"))).toEqual([]);
    const outputs = await runTransform((m) => [m, `${String(m)}!`], "text", bytes("x"));
    expect(outputs.map(text)).toEqual(["x", "x!"]);
    expect(
      (await runTransform(async (m) => Promise.resolve(m), "text", bytes("y"))).map(text),
    ).toEqual(["y"]);
    expect((await runTransform(identity, "text", bytes("z"))).map(text)).toEqual(["z"]);
  });

  it("names the stage that failed", async () => {
    expect(await failureOf(runTransform(identity, "hl7v2", bytes("not hl7")))).toMatchObject({
      kind: "parse",
      code: "NO_MSH_SEGMENT",
    });
    const thrown = await failureOf(
      runTransform(
        () => {
          throw new RangeError("synthetic");
        },
        "text",
        bytes("x"),
      ),
    );
    expect(thrown).toMatchObject({ kind: "transform", name: "RangeError", detail: "synthetic" });
    expect(await failureOf(runTransform(() => 42, "text", bytes("x")))).toMatchObject({
      kind: "output",
      name: "TypeError",
    });
  });
});

describe("loadTransform and summarize", () => {
  it("passes messages through unchanged when a channel has no transform", async () => {
    const transform = await loadTransform(undefined);
    expect(transform("same")).toBe("same");
  });

  it("loads a TypeScript module's default export", async () => {
    const root = await makeProject({
      "t.ts": "export default (m: string): string => m.toUpperCase();\n",
    });
    const transform = await loadTransform(join(root, "t.ts"));
    expect(transform("abc")).toBe("ABC");
  });

  it("refuses a module with no default function, or one that will not load", async () => {
    const root = await makeProject({
      "none.ts": "export const x = 1;\n",
      "broken.ts": "export default (\n",
    });
    expect(await failureOf(loadTransform(join(root, "none.ts")))).toMatchObject({
      kind: "load",
      name: "TypeError",
    });
    expect(await failureOf(loadTransform(join(root, "broken.ts")))).toMatchObject({ kind: "load" });
  });

  it("locates an error thrown inside the transform module", async () => {
    const root = await makeProject({
      "transform.ts":
        "export default (m: string): string => {\n  throw new TypeError('synthetic ' + m);\n};\n",
    });
    const file = join(root, "transform.ts");
    const transform = await loadTransform(file);
    const failure = await failureOf(runTransform(transform, "text", bytes("x")), file);
    expect(failure).toMatchObject({
      kind: "transform",
      name: "TypeError",
      where: expect.stringMatching(/^transform\.ts:2:\d+$/) as unknown,
    });
  });

  it("describes a thrown value that is not an Error, and an error outside the transform file", () => {
    expect(summarize("a string")).toEqual({
      kind: "transform",
      name: "string",
      detail: "a string",
    });
    expect(summarize(new Error("elsewhere"), "/nowhere/transform.ts")).not.toHaveProperty("where");
    const noStack = new Error("x");
    delete noStack.stack;
    expect(summarize(noStack, "/nowhere/transform.ts")).not.toHaveProperty("where");
  });
});
