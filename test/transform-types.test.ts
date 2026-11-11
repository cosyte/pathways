// The transform types a user writes against. `pnpm typecheck` checks this file, so a type that stops
// fitting the model a format hands over fails the gate; the tests then run each transform for real.
import { complex, getProperty, primitive, resourceType, serializeResource } from "@cosyte/fhir";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { Format } from "../src/config/schema.js";
import { runTransform, type TransformFunction } from "../src/engine/worker-entry.js";
import type {
  CcdaDocument,
  FhirResource,
  Hl7Message,
  JsonValue,
  MessageFor,
  MessageTypes,
  Transform,
  TransformFor,
  TransformOutput,
  X12Interchange,
} from "../src/index.js";
import { ADT_A01, ADT_A08, CCDA_DOCUMENT, FHIR_PATIENT, X12_270 } from "./helpers.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body);

/** Runs a typed transform the way the worker does: it loads one as an untyped default export. */
async function run<In, Out>(
  transform: Transform<In, Out>,
  format: Format,
  body: string,
): Promise<string[]> {
  return (await runTransform(transform as TransformFunction, format, bytes(body))).map(text);
}

// --- The transforms, written as a user would write them in transform.ts ---------------------------

/** The plan's own example, unchanged: `Transform` still means HL7 v2. */
const routeA01 = ((msg) => {
  if (!msg.is("ADT^A01")) return null;
  msg.setField("MSH.5", "LAB");
  return msg;
}) satisfies Transform;

/** A FHIR transform, typed from the format name. The model is immutable, so it returns a new one. */
const markActive = ((resource) => {
  if (resourceType(resource) !== "Patient") return null;
  return complex([
    ...resource.properties.filter((property) => property.name !== "active"),
    { name: "active", value: primitive(true) },
  ]);
}) satisfies TransformFor<"fhir">;

/** The same, typed with the model's own name. */
const keepPatients = ((resource) =>
  getProperty(resource, "birthDate") === undefined
    ? null
    : resource) satisfies Transform<FhirResource>;

/** An X12 transform that keeps eligibility inquiries. */
const inquiriesOnly = ((interchange) =>
  interchange.groups.some((group) => group.transactions.some((tx) => tx.st.elements[1] === "270"))
    ? interchange
    : null) satisfies TransformFor<"x12">;

/** A C-CDA transform that sends the document on and a line about it. */
const documentAndNote = ((document) => [
  document,
  `sections=${String(document.sections.length)}`,
]) satisfies TransformFor<"ccda">;

/** A JSON transform: the value is any JSON, so it narrows before reading a field. */
const tagEvents = ((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return { ...value, routed: true };
}) satisfies TransformFor<"json">;

/** A transform from one format to another: HL7 v2 in, a FHIR resource out. */
const toPatient = ((msg) =>
  complex([
    { name: "resourceType", value: primitive("Patient") },
    { name: "id", value: primitive(msg.get("PID.3.1") ?? "unknown") },
  ])) satisfies TransformFor<"hl7v2", "fhir">;

/** An async text transform. */
const shout = (async (line) => Promise.resolve(line.toUpperCase())) satisfies TransformFor<"text">;

describe("the transform types", () => {
  it("map each format name to the model its library hands over", () => {
    expectTypeOf<keyof MessageTypes>().toEqualTypeOf<Format>();
    expectTypeOf<MessageFor<"hl7v2">>().toEqualTypeOf<Hl7Message>();
    expectTypeOf<MessageFor<"fhir">>().toEqualTypeOf<FhirResource>();
    expectTypeOf<MessageFor<"x12">>().toEqualTypeOf<X12Interchange>();
    expectTypeOf<MessageFor<"ccda">>().toEqualTypeOf<CcdaDocument>();
    expectTypeOf<MessageFor<"json">>().toEqualTypeOf<JsonValue>();
    expectTypeOf<MessageFor<"text">>().toEqualTypeOf<string>();
    expectTypeOf<Transform>().toEqualTypeOf<Transform<Hl7Message, Hl7Message>>();
    expectTypeOf<TransformFor<"fhir">>().toEqualTypeOf<Transform<FhirResource>>();
    expectTypeOf<TransformFor<"hl7v2", "fhir">>().parameter(0).toEqualTypeOf<Hl7Message>();
    expectTypeOf<ReturnType<TransformFor<"hl7v2", "fhir">>>().toEqualTypeOf<
      TransformOutput<FhirResource> | Promise<TransformOutput<FhirResource>>
    >();
    // Bytes go out as they are, on a channel of any format.
    const asBytes = ((msg) =>
      Buffer.from(msg.toString(), "latin1")) satisfies TransformFor<"hl7v2">;
    expectTypeOf<Uint8Array>().toExtend<TransformOutput<Hl7Message>>();
    expect(asBytes).toBeTypeOf("function");
  });

  it("refuse a transform that returns what its format cannot send, or reads what is not there", () => {
    // @ts-expect-error: a number is neither an X12 interchange nor a string.
    const numbered = ((_interchange) => 42) satisfies TransformFor<"x12">;
    // @ts-expect-error: a FHIR transform receives the model, not the JSON text it was read from.
    const unread = ((json: string) => json) satisfies TransformFor<"fhir">;
    expect([numbered, unread]).toHaveLength(2);
  });

  it("run as typed, in the worker's own transform runner", async () => {
    expect(await run(routeA01, "hl7v2", ADT_A01)).toEqual([ADT_A01]);
    expect(await run(routeA01, "hl7v2", ADT_A08)).toEqual([]);

    const [active] = await run(markActive, "fhir", FHIR_PATIENT);
    expect(JSON.parse(active ?? "")).toMatchObject({ resourceType: "Patient", active: true });
    expect(await run(keepPatients, "fhir", FHIR_PATIENT)).toEqual([FHIR_PATIENT]);

    expect(await run(inquiriesOnly, "x12", X12_270)).toEqual([X12_270]);

    const [xml, note] = await run(documentAndNote, "ccda", CCDA_DOCUMENT);
    expect(xml).toContain("<ClinicalDocument");
    expect(note).toBe("sections=0");

    expect(await run(tagEvents, "json", '{"status": "ok"}')).toEqual([
      '{"status":"ok","routed":true}',
    ]);
    expect(await run(tagEvents, "json", "[1, 2]")).toEqual([]);

    const [patient] = await run(toPatient, "hl7v2", ADT_A01);
    expect(patient).toBe(
      serializeResource(
        complex([
          { name: "resourceType", value: primitive("Patient") },
          { name: "id", value: primitive("TEST000001") },
        ]),
      ),
    );

    expect(await run(shout, "text", "quiet")).toEqual(["QUIET"]);
  });
});
