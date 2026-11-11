// Writes test/equivalence/corpus.json: the inputs of the output-equivalence test, generated once
// and kept, so a change to a library that @cosyte/synth builds through cannot change the inputs the
// test compares outputs on. Every input is synthetic: from @cosyte/synth, from the bench's own
// builders (bench/shapes.mjs), or written here by hand.
//
//   pnpm exec tsx test/equivalence/make-corpus.ts
//
// Run it only to add inputs; the digests in test/equivalence/digests.json are then written again
// from the base commit's outputs (see test/output-equivalence.test.ts).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeCcda } from "@cosyte/ccda";
import { generateCcd, generateReferralNote } from "@cosyte/synth/ccda";
import { fhirCorpus } from "@cosyte/synth/fhir";
import { generateHl7, generateHl7Quirk } from "@cosyte/synth/hl7";
import { x12Corpus } from "@cosyte/synth/x12";

import * as S from "../../bench/shapes.mjs";
import type { WorkerFormat } from "../../src/engine/worker-entry.js";

/** One input: its format, a name that says where it came from, and its bytes in base64. */
export interface CorpusEntry {
  readonly id: string;
  readonly format: WorkerFormat;
  readonly body: string;
}

const entries: CorpusEntry[] = [];
const add = (id: string, format: WorkerFormat, body: string | Uint8Array): void => {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  entries.push({ id, format, body: bytes.toString("base64") });
};

/** A deterministic pseudo-random source, so every run writes the same corpus. */
function random(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

/* HL7 v2 ----------------------------------------------------------------------------------------- */

const KINDS = [
  "ADT^A01",
  "ADT^A04",
  "ADT^A08",
  "ORU^R01",
  "ORM^O01",
  "SIU^S12",
  "VXU^V04",
] as const;
for (const kind of KINDS) {
  for (let seed = 1; seed <= 12; seed++) {
    add(`hl7v2 synth ${kind} ${String(seed)}`, "hl7v2", generateHl7(kind, seed).toString());
  }
}
for (const quirk of ["unknown-zsegment", "unknown-escape"] as const) {
  for (let seed = 1; seed <= 4; seed++) {
    add(
      `hl7v2 synth quirk ${quirk} ${String(seed)}`,
      "hl7v2",
      generateHl7Quirk({ seed, quirk }).content,
    );
  }
}
for (let i = 0; i < 6; i++) add(`hl7v2 bench adt ${String(i)}`, "hl7v2", S.adtMessage(i));
add("hl7v2 bench oru 8 KiB", "hl7v2", S.oruMessage(1, 8 * S.KIB));
add("hl7v2 bench oru 64 KiB", "hl7v2", S.oruMessage(2, 64 * S.KIB));
add("hl7v2 bench oru document 8 KiB", "hl7v2", S.oruDocument(1, 8 * S.KIB));

/** A byte order mark, which a sender may put before a body. */
const BOM = String.fromCharCode(0xfeff);

const ADT = S.adtMessage(42);
const HAND_HL7: Record<string, string | Uint8Array> = {
  empty: "",
  "no MSH": "PID|1||TEST0000001\r",
  "MSH only": "MSH|^~\\&|SYNTH|TESTFAC|LAB|TESTFAC|20261107120000||ADT^A01|MSG1|P|2.5.1\r",
  "no control id": "MSH|^~\\&|SYNTH|TESTFAC|LAB|TESTFAC|20261107120000||ADT^A01||P|2.5.1\r",
  "LF endings": ADT.replaceAll("\r", "\n"),
  "CRLF endings": ADT.replaceAll("\r", "\r\n"),
  "no final CR": ADT.slice(0, -1),
  "blank lines": ADT.replaceAll("\r", "\r\r"),
  "other delimiters": ADT.replaceAll("|", "#").replace("MSH#^~\\&", "MSH#^~\\&"),
  escapes: ADT.replace("TESTPATIENT^ALPHA^Q", "TEST\\F\\PATIENT^AL\\S\\PHA^Q\\T\\R\\E\\"),
  repetitions: ADT.replace("TEST0000042^^^TESTFAC^MR", "A1^^^TESTFAC^MR~A2^^^TESTFAC^MR~~A3"),
  "trailing garbage": `${ADT}garbage after the message`,
  "two messages": ADT + S.adtMessage(43),
  "short MSH": "MSH|\r",
  "bad encoding characters": "MSH|ab\rPID|1\r",
  "control id with components": ADT.replace("MSG0000000042", "ID^X^Y"),
  "hex escape in control id": ADT.replace("MSG0000000042", "ID\\X41\\Q"),
  "UTF-8 name": ADT.replace("ALPHA", "ÅLPHÄ"),
  "Latin-1 name, MSH-18 8859/1": Buffer.from(
    ADT.replace("P|2.5.1", "P|2.5.1||||||8859/1").replace("ALPHA", "ÅLPHÄ"),
    "latin1",
  ),
  "Latin-1 bytes, no MSH-18": Buffer.from(ADT.replace("ALPHA", "ÅLPHÄ"), "latin1"),
  "invalid UTF-8": Buffer.concat([Buffer.from(ADT.slice(0, 40)), Buffer.from([0xff, 0xfe, 0xc3])]),
  "segment of one field": `${ADT}ZZZ\r`,
  "Z segment": `${ADT}ZPI|1|SYNTHETIC^VALUE\r`,
  subcomponents: ADT.replace("WARD1^101^A", "WARD1&X&Y^101^A"),
  "very long field": ADT.replace("1 TEST ST", "X".repeat(40_000)),
  "version 2.3": ADT.replace("2.5.1", "2.3"),
  "MSH-9 one component": ADT.replace("ADT^A01^ADT_A01", "ADT"),
  "NUL byte": `${ADT.slice(0, 50)}\u0000${ADT.slice(50)}`,
};
for (const [name, body] of Object.entries(HAND_HL7)) add(`hl7v2 hand ${name}`, "hl7v2", body);

/* FHIR ------------------------------------------------------------------------------------------- */

for (const artifact of fhirCorpus({ seed: 7, count: 40 }).artifacts) {
  add(`fhir synth ${artifact.kind} ${String(entries.length)}`, "fhir", artifact.content);
}
for (let i = 0; i < 4; i++) add(`fhir bench patient ${String(i)}`, "fhir", S.patientResource(i));
add("fhir bench bundle 16 KiB", "fhir", S.bundleResource(1, 16 * S.KIB));
const PATIENT = S.patientResource(9);
const HAND_FHIR: Record<string, string | Uint8Array> = {
  empty: "",
  "not JSON": "{",
  array: "[]",
  "no resourceType": '{"id":"x"}',
  "unknown resourceType": '{"resourceType":"NotAThing","id":"x"}',
  "large integer": PATIENT.replace(
    '"active":true',
    '"active":true,"multipleBirthInteger":12345678901234567890',
  ),
  "decimal precision":
    '{"resourceType":"Observation","status":"final","code":{"text":"x"},"valueQuantity":{"value":1.50}}',
  exponent:
    '{"resourceType":"Observation","status":"final","code":{"text":"x"},"valueQuantity":{"value":1.5e3}}',
  "pretty printed": JSON.stringify(JSON.parse(PATIENT), null, 2),
  BOM: `${BOM}${PATIENT}`,
  "invalid UTF-8": Buffer.concat([Buffer.from(PATIENT.slice(0, 30)), Buffer.from([0xff])]),
  "duplicate key": '{"resourceType":"Patient","id":"a","id":"b"}',
  "unknown property": PATIENT.replace('"active":true', '"active":true,"notAField":1'),
  "wrong type": PATIENT.replace('"active":true', '"active":"yes"'),
  "null value": PATIENT.replace('"active":true', '"active":null'),
  "primitive extension":
    '{"resourceType":"Patient","birthDate":"1970-01-01","_birthDate":{"extension":[{"url":"http://example.org/x","valueString":"y"}]}}',
  contained:
    '{"resourceType":"Patient","contained":[{"resourceType":"Organization","id":"o1","name":"TESTORG"}],"managingOrganization":{"reference":"#o1"}}',
};
for (const [name, body] of Object.entries(HAND_FHIR)) add(`fhir hand ${name}`, "fhir", body);

/* X12 -------------------------------------------------------------------------------------------- */

for (const artifact of x12Corpus({ seed: 11, count: 30 }).artifacts) {
  add(`x12 synth ${artifact.kind} ${String(entries.length)}`, "x12", artifact.content);
}
for (let i = 0; i < 3; i++) add(`x12 bench claim ${String(i)}`, "x12", S.claimMessage(i));
const CLAIM = S.claimMessage(5);
const HAND_X12: Record<string, string | Uint8Array> = {
  empty: "",
  "no ISA": "GS*HC*A*B~",
  "short ISA": "ISA*00*",
  "newlines between segments": CLAIM.replaceAll("~", "~\n"),
  "CRLF between segments": CLAIM.replaceAll("~", "~\r\n"),
  "trailing garbage": `${CLAIM}garbage`,
  "missing IEA": CLAIM.slice(0, CLAIM.lastIndexOf("IEA")),
  "invalid UTF-8": Buffer.concat([Buffer.from(CLAIM.slice(0, 120)), Buffer.from([0xff])]),
};
for (const [name, body] of Object.entries(HAND_X12)) add(`x12 hand ${name}`, "x12", body);

/* C-CDA ------------------------------------------------------------------------------------------ */

for (let seed = 1; seed <= 4; seed++) {
  add(`ccda synth ccd ${String(seed)}`, "ccda", serializeCcda(generateCcd({ seed })));
  add(`ccda synth referral ${String(seed)}`, "ccda", serializeCcda(generateReferralNote({ seed })));
}
const HAND_CCDA: Record<string, string | Uint8Array> = {
  empty: "",
  "not XML": "<ClinicalDocument",
  "not a document": '<?xml version="1.0"?><root/>',
  "wrong namespace": '<ClinicalDocument xmlns="urn:example"/>',
  "invalid UTF-8": Buffer.from([0x3c, 0x61, 0xff, 0x3e]),
};
for (const [name, body] of Object.entries(HAND_CCDA)) add(`ccda hand ${name}`, "ccda", body);

/* JSON ------------------------------------------------------------------------------------------- */

/** Number literals: what JSON allows, at the edges of what a double holds. */
const LITERALS = [
  "0",
  "-0",
  "0.0",
  "-0.0",
  "0e0",
  "0E+5",
  "0e-5",
  "1",
  "-1",
  "10",
  "100",
  "1.0",
  "1.50",
  "15e-1",
  "0.1",
  "0.10",
  "1e0",
  "1e1",
  "1E1",
  "1e+1",
  "1e-1",
  "1.5e3",
  "1500",
  "1500.000",
  "123456789",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "-9007199254740993",
  "12345678901234567890",
  "1.7976931348623157e308",
  "1.7976931348623159e308",
  "1e308",
  "1e309",
  "-1e309",
  "5e-324",
  "2e-324",
  "1e-400",
  "4.9e-324",
  "0.30000000000000004",
  "0.3",
  "0.1000000000000000055511151231257827",
  "3.141592653589793",
  "3.1415926535897932384626",
  "100000000000000000000",
  "1e20",
  "1e21",
  "123e-20",
  "0.000001",
  "1e-7",
  "0.0000001",
  "00",
  "01",
  "-01",
  "1.",
  ".1",
  "+1",
  "1e",
  "1e+",
  "--1",
  "0x10",
  "1_000",
  "NaN",
  "Infinity",
  "000000000000000000001",
  "1.0000000000000000000000001",
  "18446744073709551616",
  "18446744073709551615",
  "0.5",
  "2.5e-5",
  "25e-6",
  "250e-7",
  "1234.5678e10",
  "-0.000e10",
];
for (const literal of LITERALS) {
  add(`json literal ${literal}`, "json", literal);
  add(`json literal in array ${literal}`, "json", `[${literal}]`);
  add(`json literal in object ${literal}`, "json", `{"value":${literal},"next":[${literal},1]}`);
}
const next = random(1234);
const digits = (n: number): string =>
  Array.from({ length: n }, () => String(Math.floor(next() * 10))).join("");
for (let i = 0; i < 200; i++) {
  const sign = next() < 0.3 ? "-" : "";
  const whole =
    next() < 0.2 ? "0" : `${String(1 + Math.floor(next() * 9))}${digits(Math.floor(next() * 22))}`;
  const fraction = next() < 0.5 ? `.${digits(1 + Math.floor(next() * 20))}` : "";
  const exponent =
    next() < 0.4
      ? `${next() < 0.5 ? "e" : "E"}${["", "+", "-"][Math.floor(next() * 3)] ?? ""}${String(Math.floor(next() * 330))}`
      : "";
  add(`json random number ${String(i)}`, "json", `{"n":${sign}${whole}${fraction}${exponent}}`);
}
for (let i = 0; i < 6; i++) add(`json bench record ${String(i)}`, "json", S.jsonRecord(i));
add("json bench records 16 KiB", "json", S.jsonRecords(1, 16 * S.KIB));
const HAND_JSON: Record<string, string | Uint8Array> = {
  empty: "",
  whitespace: "  ",
  "not JSON": "{",
  "trailing comma": "[1,]",
  true: "true",
  null: "null",
  string: '"text"',
  nested: '{"a":{"b":[{"c":[1,2.50,{"d":-0}]}]},"e":"\\u00e9","f":null,"g":false}',
  "duplicate key": '{"a":1,"a":2}',
  "proto key": '{"__proto__":{"x":1},"constructor":2}',
  BOM: `${BOM}{"a":1}`,
  "invalid UTF-8": Buffer.from([0x7b, 0xff, 0x7d]),
  "lone surrogate escape": '{"a":"\\ud800"}',
  deep: `${"[".repeat(500)}1${"]".repeat(500)}`,
  "number in string": '{"a":"12345678901234567890"}',
  "keys in order": '{"b":1,"a":2,"10":3,"2":4}',
};
for (const [name, body] of Object.entries(HAND_JSON)) add(`json hand ${name}`, "json", body);

/* text ------------------------------------------------------------------------------------------- */

add("text empty", "text", "");
add("text plain", "text", "plain text\nwith lines\r\nand more");
add("text bench 4 KiB", "text", S.textPayload(1, 4 * S.KIB));
add("text invalid UTF-8", "text", Buffer.from([0x61, 0xff, 0xfe, 0x62, 0xc3]));
add("text BOM", "text", `${BOM}with a byte order mark`);
add("text NUL", "text", "a\u0000b");
add("text astral", "text", "\u{1f600} and \u{10ffff}");
const bytes = random(99);
for (let i = 0; i < 8; i++) {
  add(
    `text random bytes ${String(i)}`,
    "text",
    Uint8Array.from({ length: 64 + i * 37 }, () => Math.floor(bytes() * 256)),
  );
}

const out = join(fileURLToPath(new URL(".", import.meta.url)), "corpus.json");
writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
process.stdout.write(`wrote ${String(entries.length)} inputs to ${out}\n`);
