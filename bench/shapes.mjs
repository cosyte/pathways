// The inputs of the Pathways bench, the profile and the scaling gates, built in code from an index.
// Every value is synthetic: patient names are TESTPATIENT, identifiers are made from the index, and
// the X12 claim and the C-CDA document come from @cosyte/synth. Nothing here reads a file.
//
// Each builder returns the bytes a sender would hand Pathways for one message, as a string, at about
// the size it is asked for. The shapes are the ones real traffic has:
// - the small message a feed sends all day (an HL7 v2 ADT^A01, a FHIR Patient, one 837P claim, a
//   C-CDA CCD, a small JSON record);
// - a dense large one, many small parts (an ORU^R01 with thousands of OBX results, a collection
//   Bundle of Observations, a JSON array of lab records full of numbers);
// - a large opaque payload, one part that is almost all of the bytes (an ORU^R01 carrying a base64
//   PDF in one OBX, a text body).

import { serializeCcda } from "@cosyte/ccda";
import { generateCcd } from "@cosyte/synth/ccda";
import { generate837P } from "@cosyte/synth/x12";
import { serializeX12 } from "@cosyte/x12";

export const KIB = 1024;
export const MIB = 1024 * KIB;

const pad = (n, width) => String(n).padStart(width, "0");

/** A deterministic pseudo-random byte source, so an opaque payload does not compress to nothing. */
function bytesOf(seed, length) {
  const out = Buffer.allocUnsafe(length);
  let x = (seed * 2654435761 + 1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function msh(i, type) {
  return `MSH|^~\\&|SYNTH|TESTFAC|PATHWAYS|TESTFAC|20261107120000||${type}|MSG${pad(i, 10)}|P|2.5.1`;
}

function pid(i) {
  return `PID|1||TEST${pad(i, 7)}^^^TESTFAC^MR||TESTPATIENT^ALPHA^Q||19700101|U|||1 TEST ST^^TESTVILLE^ZZ^00000`;
}

/** An HL7 v2 ADT^A01, about 300 bytes: the message an admissions feed sends all day. */
export function adtMessage(i) {
  return (
    [
      msh(i, "ADT^A01^ADT_A01"),
      "EVN|A01|20261107120000",
      pid(i),
      "PV1|1|I|WARD1^101^A||||||||MED||||1|||||IN||||||||||||||||||||||||20261107120000",
    ].join("\r") + "\r"
  );
}

/**
 * An HL7 v2 ORU^R01 of about `bytes`: one order with as many numeric OBX results as fit. The dense
 * shape: thousands of segments, each a few dozen bytes.
 */
export function oruMessage(i, bytes) {
  const head = [
    msh(i, "ORU^R01^ORU_R01"),
    pid(i),
    `OBR|1|ORD${pad(i, 8)}|FIL${pad(i, 8)}|24323-8^COMPREHENSIVE METABOLIC PANEL^LN|||20261107120000`,
  ];
  const parts = [...head];
  let size = head.join("\r").length + 1;
  for (let n = 1; size < bytes; n++) {
    const obx = `OBX|${String(n)}|NM|2345-7^GLUCOSE^LN||${String(70 + (n % 60))}|mg/dL|70-99|N|||F|||20261107120000`;
    parts.push(obx);
    size += obx.length + 1;
  }
  return parts.join("\r") + "\r";
}

/**
 * An HL7 v2 ORU^R01 of about `bytes` carrying one base64 document in an OBX ED field: the opaque
 * shape, a report PDF sent inside the message.
 */
export function oruDocument(i, bytes) {
  const head = [
    msh(i, "ORU^R01^ORU_R01"),
    pid(i),
    `OBR|1|ORD${pad(i, 8)}|FIL${pad(i, 8)}|11502-2^LABORATORY REPORT^LN|||20261107120000`,
  ].join("\r");
  const prefix = "OBX|1|ED|11502-2^LABORATORY REPORT^LN||^AP^PDF^Base64^";
  const room = Math.max(4, bytes - head.length - prefix.length - 16);
  const payload = bytesOf(i + 1, Math.floor((room * 3) / 4)).toString("base64");
  return `${head}\r${prefix}${payload}||||||F\r`;
}

/** A text body of about `bytes`: an opaque payload Pathways stores, passes and writes as it is. */
export function textPayload(i, bytes) {
  return bytesOf(i + 7, Math.floor((bytes * 3) / 4)).toString("base64");
}

/** A FHIR R4 Patient, about 600 bytes, as JSON. */
export function patientResource(i) {
  return JSON.stringify({
    resourceType: "Patient",
    id: `test-${pad(i, 7)}`,
    meta: { lastUpdated: "2026-11-07T12:00:00Z" },
    identifier: [{ system: "urn:oid:2.16.840.1.113883.19.5", value: `TEST${pad(i, 7)}` }],
    active: true,
    name: [{ use: "official", family: "TESTPATIENT", given: ["ALPHA", "Q"] }],
    telecom: [{ system: "phone", value: "555-0100", use: "home" }],
    gender: "unknown",
    birthDate: "1970-01-01",
    address: [
      { line: ["1 TEST ST"], city: "TESTVILLE", state: "ZZ", postalCode: "00000", country: "ZZ" },
    ],
  });
}

function observation(i, n) {
  return {
    fullUrl: `urn:uuid:00000000-0000-4000-8000-${pad(i * 100_000 + n, 12)}`,
    resource: {
      resourceType: "Observation",
      id: `obs-${pad(n, 7)}`,
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "laboratory",
            },
          ],
        },
      ],
      code: { coding: [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }] },
      subject: { reference: `Patient/test-${pad(i, 7)}` },
      effectiveDateTime: "2026-11-07T12:00:00Z",
      valueQuantity: {
        value: 70 + (n % 60) + 0.5,
        unit: "mg/dL",
        system: "http://unitsofmeasure.org",
        code: "mg/dL",
      },
    },
  };
}

/** A FHIR R4 collection Bundle of about `bytes`, as JSON: the dense shape, many Observations. */
export function bundleResource(i, bytes) {
  const one = JSON.stringify(observation(i, 0)).length + 1;
  const count = Math.max(1, Math.round((bytes - 120) / one));
  return JSON.stringify({
    resourceType: "Bundle",
    id: `bundle-${pad(i, 7)}`,
    type: "collection",
    entry: Array.from({ length: count }, (_v, n) => observation(i, n)),
  });
}

function labRecord(i, n) {
  return {
    id: 10_000_000_000 + i * 1_000_000 + n,
    patient: `TEST${pad(i, 7)}`,
    code: "2345-7",
    value: 70 + (n % 60) + 0.25,
    low: 70,
    high: 99,
    taken: 1_794_000_000 + n,
    flags: [0, 1, n % 3],
  };
}

/** A small JSON record, about 150 bytes: one lab result. */
export function jsonRecord(i) {
  return JSON.stringify(labRecord(i, 0));
}

/**
 * A JSON array of about `bytes` of lab records: the dense shape for a json channel, eight numbers a
 * record, each one checked by Pathways for a value it cannot hold exactly.
 */
export function jsonRecords(i, bytes) {
  const one = JSON.stringify(labRecord(i, 0)).length + 1;
  const count = Math.max(1, Math.round(bytes / one));
  return JSON.stringify(Array.from({ length: count }, (_v, n) => labRecord(i, n)));
}

/** One X12 837P professional claim from @cosyte/synth, about 1 KiB. */
export function claimMessage(i) {
  return serializeX12(generate837P({ seed: 1_000 + i }));
}

/** A C-CDA Continuity of Care Document from @cosyte/synth. */
export function ccdDocument(i) {
  return serializeCcda(generateCcd({ seed: 2_000 + i }));
}
