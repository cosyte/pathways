// The bench's inputs (bench/shapes.mjs) are what the benchmarks, the profile and the scaling gates
// measure, so each must be a message its channel reads cleanly, at about the size it is labelled.
// A shape that failed to parse would time an error path instead of the work it names.

import { describe, expect, it } from "vitest";

import * as S from "../bench/shapes.mjs";
import { decode, encode, type WorkerFormat } from "../src/engine/worker-entry.js";

const KIB = S.KIB;

/** Each builder at a small size, with the format its channel reads it as. */
const shapes: [string, WorkerFormat, string, number | undefined][] = [
  ["ADT^A01", "hl7v2", S.adtMessage(3), undefined],
  ["ORU^R01, 64 KiB", "hl7v2", S.oruMessage(3, 64 * KIB), 64 * KIB],
  ["ORU^R01 with a document, 64 KiB", "hl7v2", S.oruDocument(3, 64 * KIB), 64 * KIB],
  ["FHIR Patient", "fhir", S.patientResource(3), undefined],
  ["FHIR Bundle, 64 KiB", "fhir", S.bundleResource(3, 64 * KIB), 64 * KIB],
  ["X12 837P", "x12", S.claimMessage(3), undefined],
  ["C-CDA CCD", "ccda", S.ccdDocument(3), undefined],
  ["JSON record", "json", S.jsonRecord(3), undefined],
  ["JSON records, 64 KiB", "json", S.jsonRecords(3, 64 * KIB), 64 * KIB],
  ["text, 64 KiB", "text", S.textPayload(3, 64 * KIB), 64 * KIB],
];

describe("the bench's inputs", () => {
  it.each(shapes)("reads %s cleanly, at about its size", async (_name, format, text, bytes) => {
    const body = new TextEncoder().encode(text);
    const message = await decode(format, body);
    expect(message).toBeDefined();
    const out = await encode(format, message);
    expect(out.byteLength).toBeGreaterThan(0);
    if (bytes !== undefined) {
      expect(body.byteLength).toBeGreaterThan(bytes * 0.95);
      expect(body.byteLength).toBeLessThan(bytes * 1.05);
    }
  });

  it("builds the same input for the same index, and inputs of one length on the count axis", () => {
    expect(S.adtMessage(5)).toBe(S.adtMessage(5));
    expect(S.adtMessage(1).length).toBe(S.adtMessage(1_234).length);
    expect(S.jsonRecord(1).length).toBe(S.jsonRecord(1_234).length);
    expect(S.oruMessage(1, 8 * KIB).length).toBe(S.oruMessage(1_234, 8 * KIB).length);
  });
});
