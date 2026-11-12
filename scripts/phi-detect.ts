/**
 * The field-level half of `scripts/phi-scan.ts`: the identifying fields of the four formats Pathways
 * parses, found in any tracked file and checked against the reviewed synthetic declarations in
 * `scripts/phi-allow-list.txt`.
 *
 * It lives in its own module so the suite can drive it in-process; `scripts/phi-scan.ts` calls
 * `detectFields` as the shared engine's `detect` hook, after the engine's own SSN and email floor.
 *
 * WHAT IT READS, BY FORMAT. Each format is read whether the file is a whole message (a `.hl7`, a
 * FHIR `.json`, an X12 interchange, a C-CDA `.xml`) or a fixture written inline in TypeScript, which
 * is where most of this repository's fixtures live.
 *
 *   - HL7 v2: the person-name fields (PID-5, PID-6, PID-9, NK1-2, GT1-3, IN1-16, MRG-7, and the
 *     provider names in PV1-7/8/9/17), the birth dates (PID-7, NK1-16), the identifier lists
 *     (PID-3, PID-18, MRG-1), the SSN (PID-19) and the phones (PID-13, PID-14, NK1-5).
 *   - FHIR: `name` (HumanName `family`, `given`, `text`), `birthDate`, `identifier.value` and
 *     `telecom.value`, at any depth of a JSON document; in source text, `family`, `given` and
 *     `birthDate` written as key and string literal; in FHIR XML, the same elements' `value`.
 *   - X12: NM1 person names (NM103 to NM105 when NM102 is 1), NM109 when NM108 says it is a member
 *     id or an SSN, DMG02 (the date of birth), and the PER contact name and numbers.
 *   - C-CDA: `given` and `family` anywhere, a `name` written as plain text in a document,
 *     `birthTime`, the `id` of a `patientRole`, and `tel:` telecoms.
 *   - CSV: a header line, split on a comma, tab, pipe or semicolon, that names an identifying
 *     column (`last_name`, `DOB`, `MRN`, `phone` and the rest in `CSV_COLUMNS`), then the cells of
 *     that column on each line after it with as many cells.
 *
 * WHAT COUNTS AS A HIT. A name token, a birth date or an identifier that the allow-list does not
 * declare synthetic:
 *
 *   - a name token is a run of two or more letters (a single Latin letter is an initial), compared
 *     upper-cased with the `NAME` lines; honorifics and degrees are skipped;
 *   - a date of birth is compared as its digits (`YYYYMMDD`, or `YYYYMM` / `YYYY` when partial), so
 *     one `DOB` line covers every format's spelling of it;
 *   - an identifier is flagged when it is all digits (six or more, ignoring spaces and dashes): the
 *     shape of a real MRN, member id or SSN. Synthetic ones carry a prefix (`TEST000001`). An `ID`
 *     line clears one, as written or as its digits;
 *   - a phone is flagged when it has ten or more digits and no `555`, the fictional exchange; an
 *     `ID` line clears it too.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody reads a clean run as more than it is: addresses, a name
 * in a field this file does not map (an HL7 `Z` segment, a free-text note, a FHIR model built in
 * code as `{ name: "family", value: ... }`), a value reached only through a template-literal
 * interpolation, an alphanumeric identifier, and an identifier in a C-CDA `id` outside a
 * `patientRole`.
 *
 * A HIT IS A POSITION AND A RULE. It names a field (`PID-5`, `NM103`, `birthTime`) and a reason,
 * never the value, and every label below is fixed text rather than something the document supplied.
 * Nothing here throws: a throw would refuse the whole scan and print its message.
 */

import type { AllowList, Hit } from "@cosyte/script-utils/phi-scan";

/** What a detector needs from the engine's `DetectContext`. */
export interface FieldContext {
  readonly text: string;
  readonly allow: AllowList;
  readonly hit: (hit: Omit<Hit, "path">) => void;
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/** Honorifics, degrees and suffixes that sit in name fields and identify nobody. */
const NAME_NOISE = new Set([
  "MR",
  "MRS",
  "MS",
  "MISS",
  "DR",
  "PROF",
  "JR",
  "SR",
  "II",
  "III",
  "IV",
  "MD",
  "DO",
  "RN",
  "NP",
  "PA",
  "PHD",
  "DDS",
  "DMD",
  "ESQ",
  "FNP",
  "APRN",
]);

/** A CJK ideograph, kana or hangul: a single one is a whole surname, not an initial. */
const CJK = /[぀-ヿ㐀-鿿가-힯]/u;

function nameTokens(value: string): string[] {
  return value
    .split(/[^\p{L}]+/u)
    .filter((token) => token.length >= 2 || (token.length === 1 && CJK.test(token)))
    .filter((token) => !NAME_NOISE.has(token.toUpperCase()));
}

function checkName(ctx: FieldContext, segment: string, value: string): void {
  for (const token of nameTokens(value)) {
    if (!ctx.allow.names.has(token.toUpperCase())) {
      ctx.hit({ segment, reason: "person-name token not in the synthetic allow-list" });
    }
  }
}

/** A date of birth as its digits: `YYYYMMDD`, or `YYYYMM` or `YYYY` when partial. */
function normalizeDob(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (digits.length >= 8) {
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? digits.slice(0, 8) : undefined;
  }
  if (digits.length === 6) return month >= 1 && month <= 12 ? digits : undefined;
  return digits.length === 4 ? digits : undefined;
}

function checkDob(ctx: FieldContext, segment: string, value: string): void {
  const dob = normalizeDob(value);
  if (dob !== undefined && !ctx.allow.dobs.has(dob)) {
    ctx.hit({ segment, reason: "date of birth not in the synthetic allow-list" });
  }
}

function isDeclaredId(ctx: FieldContext, value: string): boolean {
  return ctx.allow.ids.has(value.toUpperCase()) || ctx.allow.ids.has(value.replace(/\D/g, ""));
}

function checkId(ctx: FieldContext, segment: string, value: string): void {
  const trimmed = value.trim();
  if (!/^\d[\d -]{4,}\d$/.test(trimmed) || trimmed.replace(/\D/g, "").length < 6) return;
  if (!isDeclaredId(ctx, trimmed)) {
    ctx.hit({ segment, reason: "all-digit identifier (MRN, member id or SSN shape) not declared" });
  }
}

function checkPhone(ctx: FieldContext, segment: string, value: string): void {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 10 && !digits.includes("555") && !isDeclaredId(ctx, value)) {
    ctx.hit({ segment, reason: "phone number without the 555 fictional exchange" });
  }
}

// ---------------------------------------------------------------------------
// HL7 v2
// ---------------------------------------------------------------------------

/** Person names whose family name is component 1 (XPN). */
const HL7_XPN: Readonly<Record<string, readonly number[]>> = {
  PID: [5, 6, 9],
  NK1: [2],
  GT1: [3],
  IN1: [16],
  MRG: [7],
};
/** Person names whose family name is component 2, after an id (XCN): providers. */
const HL7_XCN: Readonly<Record<string, readonly number[]>> = { PV1: [7, 8, 9, 17] };
const HL7_DOB: Readonly<Record<string, readonly number[]>> = { PID: [7], NK1: [16] };
/** Identifier lists (CX): the id is component 1. */
const HL7_CX: Readonly<Record<string, readonly number[]>> = { PID: [3, 18], MRG: [1] };
/** A bare SSN. */
const HL7_SSN: Readonly<Record<string, readonly number[]>> = { PID: [19] };
const HL7_PHONE: Readonly<Record<string, readonly number[]>> = { PID: [13, 14], NK1: [5] };

const HL7_SEGMENTS = [
  ...new Set([
    ...Object.keys(HL7_XPN),
    ...Object.keys(HL7_XCN),
    ...Object.keys(HL7_DOB),
    ...Object.keys(HL7_CX),
    ...Object.keys(HL7_SSN),
    ...Object.keys(HL7_PHONE),
  ]),
];

interface Hl7Delimiters {
  readonly field: string;
  readonly component: string;
  readonly repetition: string;
}

const HL7_DEFAULTS: Hl7Delimiters = { field: "|", component: "^", repetition: "~" };

function checkHl7Segment(ctx: FieldContext, fields: readonly string[], d: Hl7Delimiters): void {
  const id = (fields[0] ?? "").toUpperCase();
  const each = (
    map: Readonly<Record<string, readonly number[]>>,
    check: (label: string, repetition: readonly string[]) => void,
  ): void => {
    for (const position of map[id] ?? []) {
      for (const repetition of (fields[position] ?? "").split(d.repetition)) {
        check(`${id}-${String(position)}`, repetition.split(d.component));
      }
    }
  };
  each(HL7_XPN, (label, parts) => {
    for (const part of parts.slice(0, 3)) checkName(ctx, label, part);
  });
  each(HL7_XCN, (label, parts) => {
    for (const part of parts.slice(1, 4)) checkName(ctx, label, part);
  });
  each(HL7_DOB, (label, parts) => checkDob(ctx, label, parts[0] ?? ""));
  each(HL7_CX, (label, parts) => checkId(ctx, label, parts[0] ?? ""));
  each(HL7_SSN, (label, parts) => checkId(ctx, label, parts[0] ?? ""));
  each(HL7_PHONE, (label, parts) => checkPhone(ctx, label, parts[0] ?? ""));
}

/** A whole HL7 v2 message: its first line is the MSH header, after any MLLP start byte. */
function scanHl7Message(ctx: FieldContext, text: string): boolean {
  const body = text.replace(/^[\uFEFF\u000b\s]+/, "");
  if (!body.startsWith("MSH") || body.length < 8) return false;
  const field = body.charAt(3);
  const d: Hl7Delimiters = {
    field,
    component: body.charAt(4) || HL7_DEFAULTS.component,
    repetition: body.charAt(5) || HL7_DEFAULTS.repetition,
  };
  for (const line of body.split(/\r\n|\r|\n/)) checkHl7Segment(ctx, line.split(field), d);
  return true;
}

const EMBEDDED_HL7 = new RegExp(`(?<![A-Za-z0-9_])(?:${HL7_SEGMENTS.join("|")})\\|`, "g");

/**
 * HL7 segments written inline in source text. A source-level `\r` or `\n` escape separates
 * segments, a `${...}` interpolation is erased (its name is program text, not a field), and a run
 * ends at the first quote, after which the line is code again.
 */
function scanEmbeddedHl7(ctx: FieldContext, text: string): void {
  const lines = text
    .replace(/\$\{[^{}]*\}/g, "")
    .replace(/\\r\\n|\\r|\\n/g, "\n")
    .split(/\r\n|\r|\n/);
  for (const line of lines) {
    for (const match of line.matchAll(EMBEDDED_HL7)) {
      const rest = line.slice(match.index);
      const quote = rest.search(/["'`]/);
      const run = quote < 0 ? rest : rest.slice(0, quote);
      checkHl7Segment(ctx, run.split(HL7_DEFAULTS.field), HL7_DEFAULTS);
    }
  }
}

// ---------------------------------------------------------------------------
// FHIR
// ---------------------------------------------------------------------------

/** Deeper than any resource nests; a document deeper than this is read no further. */
const MAX_DEPTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function records(value: unknown): Record<string, unknown>[] {
  if (isRecord(value)) return [value];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Walks parsed JSON, checking the FHIR elements that identify a person wherever they sit. */
function walkFhir(ctx: FieldContext, node: unknown, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) walkFhir(ctx, item, depth + 1);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case "name":
        // A string `name` labels a thing (an Organization, a code); a HumanName is an object.
        for (const name of records(value)) {
          for (const part of ["family", "given", "text"]) {
            for (const written of strings(name[part])) checkName(ctx, `name.${part}`, written);
          }
        }
        break;
      case "birthDate":
        for (const written of strings(value)) checkDob(ctx, "birthDate", written);
        break;
      case "identifier":
        for (const identifier of records(value)) {
          for (const written of strings(identifier["value"])) {
            checkId(ctx, "identifier.value", written);
          }
        }
        break;
      case "telecom":
        for (const telecom of records(value)) {
          for (const written of strings(telecom["value"]))
            checkPhone(ctx, "telecom.value", written);
        }
        break;
      default:
        break;
    }
    walkFhir(ctx, value, depth + 1);
  }
}

/** A quoted string literal, in either quote, without escapes that matter here. */
const LITERAL = String.raw`(?:"[^"\n]*"|'[^'\n]*')`;
const SOURCE_FHIR = new RegExp(
  String.raw`["']?\b(family|given|birthDate)["']?[ \t]*:[ \t]*(${LITERAL}|\[\s*${LITERAL}(?:\s*,\s*${LITERAL})*\s*,?\s*\])`,
  "g",
);

/** `family`, `given` and `birthDate` written as a key and a string literal, in JSON or in code. */
function scanFhirLiterals(ctx: FieldContext, text: string): void {
  for (const match of text.matchAll(SOURCE_FHIR)) {
    const key = match[1] ?? "";
    for (const literal of (match[2] ?? "").matchAll(new RegExp(LITERAL, "g"))) {
      const value = literal[0].slice(1, -1).replace(/\$\{[^{}]*\}/g, "");
      if (key === "birthDate") checkDob(ctx, "birthDate", value);
      else checkName(ctx, `name.${key}`, value);
    }
  }
}

function scanFhir(ctx: FieldContext, text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    scanFhirLiterals(ctx, text);
    return;
  }
  walkFhir(ctx, parsed, 0);
}

// ---------------------------------------------------------------------------
// X12
// ---------------------------------------------------------------------------

interface X12Delimiters {
  readonly element: string;
  readonly component: string;
}

function checkX12Segment(ctx: FieldContext, elements: readonly string[], d: X12Delimiters): void {
  const at = (position: number): string => (elements[position] ?? "").split(d.component)[0] ?? "";
  switch ((elements[0] ?? "").trim()) {
    case "NM1": {
      if (at(2) === "1") {
        for (const position of [3, 4, 5]) checkName(ctx, `NM10${String(position)}`, at(position));
      }
      if (["34", "MI", "II"].includes(at(8))) checkId(ctx, "NM109", at(9));
      break;
    }
    case "DMG":
      checkDob(ctx, "DMG02", at(2));
      break;
    case "PER":
      checkName(ctx, "PER02", at(2));
      for (const position of [4, 6, 8]) checkPhone(ctx, `PER0${String(position)}`, at(position));
      break;
    default:
      break;
  }
}

/** A whole interchange: the ISA header fixes the element, component and segment delimiters. */
function scanX12Interchange(ctx: FieldContext, text: string): boolean {
  const body = text.replace(/^[\uFEFF\s]+/, "");
  if (!body.startsWith("ISA") || body.length < 106) return false;
  const d: X12Delimiters = { element: body.charAt(3), component: body.charAt(104) };
  for (const segment of body.split(body.charAt(105))) {
    checkX12Segment(ctx, segment.replace(/[\r\n]/g, "").split(d.element), d);
  }
  return true;
}

const EMBEDDED_X12 = /(?<![A-Za-z0-9_])(?:NM1|DMG|PER)\*/g;

/** X12 segments written inline in source text, with the common delimiters `*`, `:` and `~`. */
function scanEmbeddedX12(ctx: FieldContext, text: string): void {
  for (const match of text.matchAll(EMBEDDED_X12)) {
    const rest = text.slice(match.index);
    const end = rest.search(/[~"'`\\\r\n]/);
    const run = end < 0 ? rest : rest.slice(0, end);
    checkX12Segment(ctx, run.split("*"), { element: "*", component: ":" });
  }
}

// ---------------------------------------------------------------------------
// C-CDA (and FHIR XML)
// ---------------------------------------------------------------------------

/** The US Social Security Administration's OID: an `id` under it is an SSN. */
const SSN_OID = "2.16.840.1.113883.4.1";

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => codePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

/** The text of every `<tag>text</tag>` with no child element, any namespace prefix. */
function leafTexts(text: string, tag: string): string[] {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([^<]*)</(?:[\\w.-]+:)?${tag}\\s*>`,
    "g",
  );
  return [...text.matchAll(pattern)].map((match) => decodeXml(match[1] ?? ""));
}

/** The attributes of every `<tag ...>` start tag, names without a prefix. */
function tagAttributes(text: string, tag: string): Record<string, string>[] {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*?)/?>`, "g");
  return [...text.matchAll(pattern)].map((match) => {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[1] ?? "").matchAll(
      /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      const name = (attribute[1] ?? "").replace(/^[\w.-]+:/, "");
      attributes[name] = decodeXml(attribute[2] ?? attribute[3] ?? "");
    }
    return attributes;
  });
}

function scanXml(ctx: FieldContext, text: string): void {
  if (!text.includes("<")) return;
  for (const tag of ["given", "family"]) {
    for (const written of leafTexts(text, tag)) checkName(ctx, tag, written);
    // FHIR XML writes a primitive as `value="..."`.
    for (const { value } of tagAttributes(text, tag)) {
      if (value !== undefined) checkName(ctx, tag, value);
    }
  }
  for (const tag of ["birthTime", "birthDate"]) {
    for (const { value } of tagAttributes(text, tag)) {
      if (value !== undefined) checkDob(ctx, tag, value);
    }
  }
  for (const { value } of tagAttributes(text, "telecom")) {
    if (value?.startsWith("tel:") === true) checkPhone(ctx, "telecom", value);
  }
  if (!/ClinicalDocument|urn:hl7-org:v3/.test(text)) return;
  // In a C-CDA document, a `name` written as plain text is a person's or an organization's.
  for (const written of leafTexts(text, "name")) checkName(ctx, "name", written);
  for (const role of text.matchAll(
    /<(?:[\w.-]+:)?patientRole\b[\s\S]*?<\/(?:[\w.-]+:)?patientRole\s*>/g,
  )) {
    for (const { root, extension } of tagAttributes(role[0], "id")) {
      if (extension !== undefined) checkId(ctx, root === SSN_OID ? "id (SSN)" : "id", extension);
    }
  }
}

// ---------------------------------------------------------------------------
// Delimited text (CSV)
// ---------------------------------------------------------------------------

/** The delimiters a CSV file is tried with, in order. */
const CSV_DELIMITERS = [",", "\t", "|", ";"] as const;

/** A header cell, folded: lower case with every character but a letter or digit dropped. */
function foldHeader(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Header names, folded, that carry a person's name, a birth date, an identifier or a phone. */
const CSV_COLUMNS: Readonly<Record<string, "name" | "dob" | "id" | "phone">> = {
  name: "name",
  patientname: "name",
  fullname: "name",
  lastname: "name",
  firstname: "name",
  middlename: "name",
  familyname: "name",
  givenname: "name",
  surname: "name",
  patientlastname: "name",
  patientfirstname: "name",
  dob: "dob",
  dateofbirth: "dob",
  birthdate: "dob",
  birthdt: "dob",
  patientdob: "dob",
  mrn: "id",
  medicalrecordnumber: "id",
  patientid: "id",
  memberid: "id",
  subscriberid: "id",
  ssn: "id",
  phone: "phone",
  phonenumber: "phone",
  telephone: "phone",
  homephone: "phone",
  mobilephone: "phone",
  cellphone: "phone",
};

/** One line's cells, a quoted cell unquoted; a quote left open keeps the rest of the line. */
function csvCells(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < line.length; at++) {
    const char = line.charAt(at);
    if (quoted) {
      if (char === '"' && line.charAt(at + 1) === '"') {
        cell += '"';
        at++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/** A header line: two or more cells, each a column name, at least one an identifying column. */
function csvHeader(line: string, delimiter: string): string[] | undefined {
  if (!line.includes(delimiter)) return undefined;
  const cells = csvCells(line, delimiter).map((cell) => cell.trim());
  if (cells.length < 2 || !cells.every((cell) => /^[A-Za-z][\w .#-]{0,63}$/.test(cell))) {
    return undefined;
  }
  return cells.some((cell) => CSV_COLUMNS[foldHeader(cell)] !== undefined) ? cells : undefined;
}

/**
 * A CSV table in the file's own lines: a header that names an identifying column, then each line
 * after it with as many cells, until one has a different count. Each identifying column's cells are
 * checked as the field they name. A table written inside one string literal, its lines joined by
 * escape sequences, is not read.
 */
function scanCsv(ctx: FieldContext, text: string): void {
  const lines = text.split(/\r\n|\n|\r/);
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    for (const delimiter of CSV_DELIMITERS) {
      const header = csvHeader(line, delimiter);
      if (header === undefined) continue;
      const kinds = header.map((cell) => CSV_COLUMNS[foldHeader(cell)]);
      let row = at + 1;
      for (; row < lines.length; row++) {
        const cells = csvCells(lines[row] ?? "", delimiter);
        if (cells.length !== header.length) break;
        for (const [index, kind] of kinds.entries()) {
          const value = cells[index] ?? "";
          const label = `csv ${header[index] ?? ""}`;
          if (kind === "name") checkName(ctx, label, value);
          else if (kind === "dob") checkDob(ctx, label, value);
          else if (kind === "id") checkId(ctx, label, value);
          else if (kind === "phone") checkPhone(ctx, label, value);
        }
      }
      at = row - 1;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/**
 * Checks one file's text for the identifying fields of HL7 v2, FHIR, X12 and C-CDA, raising a hit
 * through `ctx.hit` for each value the allow-list does not declare synthetic.
 *
 * @param ctx The file's text, the parsed allow-list, and the engine's `hit`.
 */
export function detectFields(ctx: FieldContext): void {
  const { text } = ctx;
  if (!scanHl7Message(ctx, text)) scanEmbeddedHl7(ctx, text);
  if (!scanX12Interchange(ctx, text)) scanEmbeddedX12(ctx, text);
  scanFhir(ctx, text);
  scanXml(ctx, text);
  scanCsv(ctx, text);
}
