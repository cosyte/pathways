import { join } from "node:path";

import { CcdaDocument, parseCcda, serializeCcda } from "@cosyte/ccda";
import { isComplex, parseResource, resourceType, serializeResource } from "@cosyte/fhir";
import { Hl7Message, parseHL7 } from "@cosyte/hl7";
import { generateCcd, generateReferralNote } from "@cosyte/synth/ccda";
import { generatePatient } from "@cosyte/synth/fhir";
import { generateAdt, generateOru } from "@cosyte/synth/hl7";
import { generate271, generate835, generate837P } from "@cosyte/synth/x12";
import { parseX12, serializeX12 } from "@cosyte/x12";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import { FORMATS, type Format } from "../src/config/schema.js";
import {
  bytesOf,
  decode,
  encode,
  FORMAT_REGISTRY,
  formatTable,
  type FormatModel,
  isWorkerSetup,
  loadFormat,
  loadTransform,
  runTransform,
  summarize,
  transferable,
  type TransformFunction,
  type WorkerFormat,
} from "../src/engine/worker-entry.js";
import { ADT_A01, CCDA_DOCUMENT, cleanUp, FHIR_PATIENT, makeProject, X12_270 } from "./helpers.js";

afterEach(cleanUp);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body);
const NOT_UTF8 = new Uint8Array([0x7b, 0xff, 0x7d]);

/** One synthetic body per format. `Record<Format, ...>` makes a new format add its own sample. */
const SAMPLES: Record<Format, string> = {
  hl7v2: ADT_A01,
  fhir: FHIR_PATIENT,
  x12: X12_270,
  ccda: CCDA_DOCUMENT,
  json: '{ "status": "ok", "tries": [1, 2] }',
  text: "plain",
  csv: "code,name\r\nTEST-001,Example\r\n",
};

async function failureOf(promise: Promise<unknown>, transformFile?: string) {
  try {
    await promise;
  } catch (error) {
    return summarize(error, transformFile);
  }
  throw new Error("expected a failure");
}

const identity: TransformFunction = (message) => message;

async function roundTrip(format: WorkerFormat, body: string): Promise<string> {
  return text(await encode(format, await decode(format, bytes(body))));
}

describe("the format registry", () => {
  it("is where the formats, their extensions and their content types are read from", () => {
    expect(FORMATS).toEqual(["hl7v2", "fhir", "x12", "ccda", "json", "text", "csv"]);
    expect(FORMATS).toEqual(Object.keys(FORMAT_REGISTRY));
    expect(formatTable("extension")).toEqual(
      Object.fromEntries(FORMATS.map((format) => [format, FORMAT_REGISTRY[format].extension])),
    );
    expect(formatTable("contentType")).toEqual(
      Object.fromEntries(FORMATS.map((format) => [format, FORMAT_REGISTRY[format].contentType])),
    );
    expect(Object.isFrozen(FORMAT_REGISTRY) && Object.isFrozen(FORMAT_REGISTRY.hl7v2)).toBe(true);
    // The configuration's format is the registry's key: one list, held by the type system.
    expectTypeOf<Format>().toEqualTypeOf<keyof typeof FORMAT_REGISTRY>();
    expectTypeOf<FormatModel<"text">>().toEqualTypeOf<string>();
  });
});

describe("decode and encode", () => {
  it("has a parser for every format the configuration accepts", async () => {
    for (const format of FORMATS) {
      await loadFormat(format);
      await expect(roundTrip(format, SAMPLES[format])).resolves.toBeTypeOf("string");
    }
  });

  it("parses each format into its own library's model", async () => {
    expect(await decode("hl7v2", bytes(ADT_A01))).toBeInstanceOf(Hl7Message);

    const resource = await decode("fhir", bytes(FHIR_PATIENT));
    expect(isComplex(resource as never)).toBe(true);
    expect(resourceType(resource as never)).toBe("Patient");

    const interchange = await decode("x12", bytes(X12_270));
    expect(interchange.groups[0]?.transactions[0]?.st.elements[1]).toBe("270");

    const document = await decode("ccda", bytes(CCDA_DOCUMENT));
    expect(document).toBeInstanceOf(CcdaDocument);
    expect(document.getPatient()?.name?.family).toBe("TESTPATIENT");

    expect(await decode("json", bytes(SAMPLES.json))).toEqual({ status: "ok", tries: [1, 2] });
    expect(await decode("text", bytes("plain"))).toBe("plain");
  });

  it("writes each format back as it was read", async () => {
    expect(await roundTrip("hl7v2", ADT_A01)).toBe(ADT_A01);
    expect(await roundTrip("fhir", FHIR_PATIENT)).toBe(FHIR_PATIENT);
    expect(await roundTrip("x12", X12_270)).toBe(X12_270);
    expect(await roundTrip("text", "plain")).toBe("plain");
    // JSON comes back compact, and C-CDA as its library writes it: a fixed point from then on.
    expect(await roundTrip("json", SAMPLES.json)).toBe('{"status":"ok","tries":[1,2]}');
    const once = await roundTrip("ccda", CCDA_DOCUMENT);
    expect(once).toContain("<family>TESTPATIENT</family>");
    expect(await roundTrip("ccda", once)).toBe(once);
  });

  it("round-trips messages generated with @cosyte/synth byte for byte", async () => {
    const generated: [WorkerFormat, string][] = [
      ["hl7v2", generateAdt({ seed: 11, trigger: "A01" }).toString()],
      ["hl7v2", generateOru({ seed: 12 }).toString()],
      ["fhir", serializeResource(generatePatient({ seed: 13, profile: "us-core" }))],
      ["x12", serializeX12(generate837P({ seed: 14 }))],
      ["x12", serializeX12(generate835({ seed: 15 }))],
      ["x12", serializeX12(generate271({ seed: 16 }))],
      ["ccda", serializeCcda(generateCcd({ seed: 17 }))],
      ["ccda", serializeCcda(generateReferralNote({ seed: 18 }))],
    ];
    for (const [format, body] of generated) expect(await roundTrip(format, body)).toBe(body);
  });

  it("keeps each library's error code when a body will not parse", async () => {
    const cases: [WorkerFormat, string, string][] = [
      ["hl7v2", "not hl7", "NO_MSH_SEGMENT"],
      ["fhir", "[]", "MALFORMED_JSON"],
      ["fhir", "{", "MALFORMED_JSON"],
      ["x12", "", "X12_EMPTY_INPUT"],
      ["x12", "ISA*", "X12_ISA_TOO_SHORT"],
      [
        "x12",
        "not x12, but long enough to be read as one if the parser only counted bytes",
        "X12_NO_ISA_HEADER",
      ],
      ["ccda", "<ClinicalDocument", "NOT_WELL_FORMED_XML"],
      ["ccda", "<html/>", "NOT_A_CLINICAL_DOCUMENT"],
      ["json", "{", "MALFORMED_JSON"],
      ["json", "", "MALFORMED_JSON"],
    ];
    for (const [format, body, code] of cases) {
      expect(await failureOf(runTransform(identity, format, bytes(body)))).toMatchObject({
        kind: "parse",
        code,
      });
    }
  });

  it("keeps a JSON body out of its own parse error", async () => {
    const failure = await failureOf(runTransform(identity, "json", bytes('{"note": "SECRET"')));
    expect(failure).toEqual({
      kind: "parse",
      name: "JsonBodyError",
      code: "MALFORMED_JSON",
      detail: "the body is not valid JSON",
    });
  });

  it("refuses a body that is not UTF-8 in the formats read as UTF-8, and keeps text lenient", async () => {
    for (const format of ["fhir", "x12", "ccda", "json"] as const) {
      expect(await failureOf(runTransform(identity, format, NOT_UTF8))).toMatchObject({
        kind: "parse",
        code: "ERR_ENCODING_INVALID_ENCODED_DATA",
      });
    }
    expect(await decode("text", NOT_UTF8)).toBe("{\uFFFD}");
  });

  it("refuses a JSON number it cannot hold exactly, and keeps every one it can", async () => {
    for (const body of [
      '{"id": 12345678901234567890}',
      "[9007199254740993]",
      "[1e400]",
      "[1e-400]",
    ]) {
      expect(await failureOf(runTransform(identity, "json", bytes(body)))).toMatchObject({
        kind: "parse",
        code: "INEXACT_JSON_NUMBER",
      });
    }
    const exact = "[1.50, 15e-1, 100, 1E+2, -0, 0.000, 0.1, 9007199254740991, -2.5e-3]";
    expect(await roundTrip("json", exact)).toBe(
      "[1.5,1.5,100,100,0,0,0.1,9007199254740991,-0.0025]",
    );
  });

  it("serializes strings, and on a json channel any JSON value, and refuses anything else", async () => {
    expect(text(await encode("hl7v2", "out"))).toBe("out");
    expect(text(await encode("json", true))).toBe("true");
    expect(text(await encode("json", 3))).toBe("3");
    expect(text(await encode("json", [1, { a: 2 }]))).toBe('[1,{"a":2}]');
    expect(text(await encode("json", Object.create(null) as object))).toBe("{}");
    // A plain object whose toJSON gives nothing goes out as an empty body, as it always has.
    expect(text(await encode("json", { toJSON: () => undefined }))).toBe("");
    for (const [format, output] of [
      ["hl7v2", { not: "a message" }],
      ["text", 42],
      ["fhir", ["an", "array"]],
      ["json", Number.NaN],
      ["json", new Date(0)],
      ["json", undefined],
      ["x12", { isa: { raw: 1 } }],
    ] as const) {
      await expect(encode(format, output)).rejects.toThrow(TypeError);
    }
  });

  it("writes another format's model whatever the channel's format", async () => {
    const message = parseHL7(ADT_A01);
    const resource = parseResource(FHIR_PATIENT).resource;
    const interchange = parseX12(X12_270);
    const document = parseCcda(CCDA_DOCUMENT);
    expect(text(await encode("hl7v2", resource))).toBe(FHIR_PATIENT);
    expect(text(await encode("text", interchange))).toBe(X12_270);
    expect(text(await encode("json", message))).toBe(ADT_A01);
    expect(text(await encode("ccda", message))).toBe(ADT_A01);
    expect(text(await encode("hl7v2", document))).toBe(serializeCcda(document));
  });

  it("sends the bytes a transform returns as they are, in a copy of their own", async () => {
    // Latin-1 bytes that are not UTF-8 (0xe9 is a lone e-acute), in the middle of a larger buffer.
    const backing = new Uint8Array([0x00, 0x4d, 0x53, 0x48, 0xe9, 0x0d, 0x00]);
    const returned = backing.subarray(1, 6);
    for (const format of FORMATS) {
      const sent = await encode(format, returned);
      expect([...sent]).toEqual([0x4d, 0x53, 0x48, 0xe9, 0x0d]);
      // A copy: moving it to the engine leaves the transform's own buffer as it was.
      expect(sent.buffer).not.toBe(backing.buffer);
      expect(transferable([sent])).toEqual([sent.buffer]);
    }
    const outputs = await runTransform(
      () => [returned, Buffer.from(returned)],
      "hl7v2",
      bytes(ADT_A01),
    );
    expect(outputs.map((output) => [...output])).toEqual([
      [0x4d, 0x53, 0x48, 0xe9, 0x0d],
      [0x4d, 0x53, 0x48, 0xe9, 0x0d],
    ]);
  });

  it("keeps the bytes a format's own writer returns, in whatever charset it wrote them", () => {
    const latin1 = new Uint8Array([0x4d, 0xe9, 0x1c]);
    const written = bytesOf(latin1);
    expect([...written]).toEqual([0x4d, 0xe9, 0x1c]);
    expect(written.buffer).not.toBe(latin1.buffer);
    expect([...bytesOf("Mé")]).toEqual([0x4d, 0xc3, 0xa9]);
  });

  it("keeps a serializer's own refusal code", async () => {
    // A repeated property: @cosyte/fhir reads the first and refuses to write either.
    const shadowed = '{"resourceType":"Patient","active":true,"active":false}';
    expect(await failureOf(runTransform(identity, "fhir", bytes(shadowed)))).toMatchObject({
      kind: "output",
      code: "UNSERIALIZABLE_SHADOWED_PROPERTY",
    });
  });
});

describe("runTransform", () => {
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

  it("passes a JSON array through as one message when a channel has no transform", async () => {
    const passThrough = await loadTransform(undefined);
    expect((await runTransform(passThrough, "json", bytes("[1, 2]"))).map(text)).toEqual(["[1,2]"]);
    expect((await runTransform(identity, "json", bytes("[1, 2]"))).map(text)).toEqual(["1", "2"]);
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
    expect(transform("same")).toEqual(["same"]);
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
    // A frame in a file URL no path can be made of is no match: one naming another host, which
    // Linux and macOS refuse, and one with no drive, which Windows refuses.
    const remote = new Error("x");
    remote.stack =
      "Error: x\n    at file://remote-host/share/transform.ts:2:3\n    at file:///share/transform.ts:2:3";
    expect(summarize(remote, "/nowhere/transform.ts")).not.toHaveProperty("where");
  });
});

describe("isWorkerSetup", () => {
  it("accepts only the setup the engine sends, so the entry stays idle in any other thread", () => {
    expect(isWorkerSetup({ pathwaysWorker: true, transformFile: undefined, format: "text" })).toBe(
      true,
    );
    expect(isWorkerSetup({ pathwaysWorker: "true", format: "text" })).toBe(false);
    expect(isWorkerSetup({ format: "text" })).toBe(false);
    expect(isWorkerSetup(null)).toBe(false);
    expect(isWorkerSetup(undefined)).toBe(false);
    expect(isWorkerSetup("pathwaysWorker")).toBe(false);
  });
});
