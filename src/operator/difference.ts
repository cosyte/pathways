import type { Format } from "../config/schema.js";

/**
 * How one transform's outputs compare with the outputs recorded for the same input: the same, or
 * where they first part ways. `where` names a position (an HL7 v2 field path, a JSON pointer or a
 * byte offset) and never a value.
 *
 * @example
 * ```ts
 * const result: OutputComparison = { same: false, output: 1, where: "PID[1]-5.1" };
 * ```
 */
export type OutputComparison =
  | { readonly same: true }
  | {
      readonly same: false;
      /** The output that differs, from 1; absent when the number of outputs differs. */
      readonly output?: number | undefined;
      /** Where it differs; for a different number of outputs, the two counts. */
      readonly where: string;
    };

/**
 * Compares a transform's outputs with the recorded ones. Two outputs are the same only when they
 * are the same bytes; when they are not, the first difference is named by position: an HL7 v2 field
 * path (`PID[1]-5.1`, the segment's occurrence in brackets) for `hl7v2`, a JSON pointer
 * (`/name/0/family`) for `fhir` and `json`, and otherwise, or when neither side reads as that
 * format, a byte offset from 0. Nothing in the result is taken from either output but the names
 * of HL7 v2 segments and of JSON keys.
 *
 * @example
 * ```ts
 * compareOutputs("hl7v2", [candidate], [recorded]); // { same: false, output: 1, where: "PID[1]-5.1" }
 * ```
 */
export function compareOutputs(
  format: Format,
  actual: readonly Uint8Array[],
  recorded: readonly Uint8Array[],
): OutputComparison {
  if (actual.length !== recorded.length) {
    return {
      same: false,
      where: `${count(actual.length)} from the transform, ${count(recorded.length)} recorded`,
    };
  }
  for (const [index, output] of actual.entries()) {
    /* v8 ignore next -- the lengths are equal, so recorded[index] exists */
    const before = recorded[index] ?? new Uint8Array();
    if (Buffer.from(output).equals(Buffer.from(before))) continue;
    return { same: false, output: index + 1, where: locate(format, output, before) };
  }
  return { same: true };
}

function count(n: number): string {
  return `${n} output${n === 1 ? "" : "s"}`;
}

/**
 * Where two outputs that are not the same bytes first part ways, named by position.
 *
 * @example
 * ```ts
 * locate("json", encode('{"a":1}'), encode('{"a":2}')); // "/a"
 * ```
 */
export function locate(format: Format, actual: Uint8Array, recorded: Uint8Array): string {
  const a = Buffer.from(actual).toString("utf8");
  const b = Buffer.from(recorded).toString("utf8");
  let where: string | undefined;
  if (format === "hl7v2") where = hl7Path(a, b);
  else if (format === "fhir" || format === "json") where = jsonDifference(a, b);
  return where ?? `byte offset ${byteOffset(actual, recorded)}`;
}

/**
 * The first byte at which two byte strings differ, or the shorter one's length.
 *
 * @example
 * ```ts
 * byteOffset(new Uint8Array([1, 2]), new Uint8Array([1, 3])); // 1
 * ```
 */
export function byteOffset(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) if (a[index] !== b[index]) return index;
  return shared;
}

const SEGMENT_ID = /^[A-Z][A-Z0-9]{2}$/;

interface Delimiters {
  readonly field: string;
  readonly component: string;
  readonly repetition: string;
  readonly subcomponent: string;
}

/** The delimiters an MSH segment declares, or the standard ones. */
function delimiters(segment: string | undefined): Delimiters {
  if (segment?.startsWith("MSH") === true && segment.length >= 8) {
    return {
      field: segment.charAt(3),
      component: segment.charAt(4),
      repetition: segment.charAt(5),
      subcomponent: segment.charAt(7),
    };
  }
  return { field: "|", component: "^", repetition: "~", subcomponent: "&" };
}

function segmentsOf(text: string): string[] {
  const segments = text.split(/\r\n|\r|\n/);
  if (segments.at(-1) === "") segments.pop();
  return segments;
}

/**
 * The HL7 v2 path of the first difference: the segment and its occurrence, then the field, and the
 * repetition, component and subcomponent where either side has more than one. Undefined when the
 * segments read the same, as when only line endings differ.
 *
 * @example
 * ```ts
 * hl7Path("MSH|^~\\&|A\rPID|1||X^Y", "MSH|^~\\&|A\rPID|1||X^Z"); // "PID[1]-3.2"
 * ```
 */
export function hl7Path(actual: string, recorded: string): string | undefined {
  const a = segmentsOf(actual);
  const b = segmentsOf(recorded);
  const delimiter = delimiters(b[0] ?? a[0]);
  const seen = new Map<string, number>();
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    const leftId = left?.slice(0, 3);
    const rightId = right?.slice(0, 3);
    const id = leftId ?? rightId;
    /* v8 ignore next -- the loop runs only while one side has a segment here */
    if (id === undefined) return undefined;
    const occurrence = (seen.get(id) ?? 0) + 1;
    seen.set(id, occurrence);
    if (left === right) continue;
    if (
      !SEGMENT_ID.test(id) ||
      (leftId !== undefined && rightId !== undefined && leftId !== rightId)
    ) {
      return `segment ${index + 1}`;
    }
    const segment = `${id}[${occurrence}]`;
    if (left === undefined) return `${segment}, only in the recorded output`;
    if (right === undefined) return `${segment}, only in the transform's output`;
    return `${segment}-${fieldPath(id, left, right, delimiter)}`;
  }
  return undefined;
}

/** The field, and below it the repetition, component and subcomponent, where two segments differ. */
function fieldPath(id: string, left: string, right: string, d: Delimiters): string {
  const a = left.split(d.field);
  const b = right.split(d.field);
  // MSH-1 is the field separator itself, so MSH's pieces are numbered one higher.
  const shift = id === "MSH" ? 1 : 0;
  let index = 1;
  while (index < Math.max(a.length, b.length) && a[index] === b[index]) index += 1;
  const number = index + shift;
  // MSH-2 holds the encoding characters: it has no components to split.
  if (id === "MSH" && number <= 2) return String(number);
  return `${number}${within(a[index] ?? "", b[index] ?? "", [d.repetition, d.component, d.subcomponent])}`;
}

/** The repetition (`[n]`), component (`.n`) and subcomponent (`.n`) at which two fields differ. */
function within(left: string, right: string, separators: readonly string[]): string {
  const [separator, ...rest] = separators;
  if (separator === undefined) return "";
  const a = left.split(separator);
  const b = right.split(separator);
  let index = 0;
  while (index < Math.max(a.length, b.length) && a[index] === b[index]) index += 1;
  const here = Math.max(a.length, b.length) > 1;
  const step = here ? (rest.length === 2 ? `[${index + 1}]` : `.${index + 1}`) : "";
  return `${step}${within(a[index] ?? "", b[index] ?? "", rest)}`;
}

/**
 * The JSON pointer of the first difference between two JSON texts. Undefined when either does not
 * parse, or when they parse to equal values written differently (spacing, key order): a byte offset
 * names those.
 *
 * @example
 * ```ts
 * jsonDifference('{"name":[{"family":"A"}]}', '{"name":[{"family":"B"}]}'); // "/name/0/family"
 * ```
 */
export function jsonDifference(actual: string, recorded: string): string | undefined {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(actual);
    b = JSON.parse(recorded);
  } catch {
    return undefined;
  }
  const pointer = jsonPointer(a, b, "");
  if (pointer === undefined) return undefined;
  return pointer === "" ? "the whole document (/)" : pointer;
}

function jsonPointer(a: unknown, b: unknown, at: string): string | undefined {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if (index >= a.length || index >= b.length) return `${at}/${index}`;
      const inner = jsonPointer(a[index], b[index], `${at}/${index}`);
      if (inner !== undefined) return inner;
    }
    return undefined;
  }
  if (isObject(a) && isObject(b)) {
    const keys = [...Object.keys(a), ...Object.keys(b).filter((key) => !(key in a))];
    for (const key of keys) {
      const here = `${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (!(key in a) || !(key in b)) return here;
      const inner = jsonPointer(a[key], b[key], here);
      if (inner !== undefined) return inner;
    }
    return undefined;
  }
  return Object.is(a, b) ? undefined : at;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
