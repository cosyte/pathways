// The transform worker: one per channel, in its own thread, so a stuck or runaway transform can be
// stopped without stopping the engine.
//
// SELF-CONTAINED ON PURPOSE. The engine starts this file as a worker: from `dist/` when installed,
// and straight from `src/` under the tests, where Node runs it through its own type stripping. So it
// imports only Node built-ins and packages, never a relative module, and uses only syntax that type
// stripping can erase (no enums, no namespaces, no parameter properties).
//
// THE PARSERS LOAD ON FIRST USE. Each `@cosyte/*` library costs a worker time and memory to load, and
// a channel reads one format, so a worker loads the parser for its own format when it starts and any
// other library only when a transform hands back that library's model.
import { realpathSync } from "node:fs";
import { normalize } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";

import type * as Ccda from "@cosyte/ccda";
import type * as Fhir from "@cosyte/fhir";
import type * as Hl7 from "@cosyte/hl7";
import type * as X12 from "@cosyte/x12";

/**
 * A user's transform, as loaded from its module's default export: the message, then the context.
 * The context is optional, so a transform written with one parameter fits.
 */
export type TransformFunction = (message: unknown, ctx?: unknown) => unknown;

/** What stage a failure happened in. */
export type FailureKind =
  "load" | "parse" | "transform" | "output" | "timeout" | "memory" | "crash";

/**
 * A failure, described without the message's content: an error name, a stable code where there is
 * one, and where in the transform it was thrown. `detail` is the error's own text, which can quote
 * message content, so callers store it and never print or log it.
 */
export interface FailureSummary {
  readonly kind: FailureKind;
  readonly name: string;
  readonly code?: string;
  readonly where?: string;
  readonly detail: string;
}

/**
 * What the transform's context is built from for one message, as plain data: the stored message's
 * id, which run this is, what its source knew (undefined when that is not known) and its per-message
 * map. `src/transform.ts` holds the public shape the worker builds from it.
 */
export interface MessageContext {
  readonly messageId: number;
  readonly attempt: number;
  readonly source: object | undefined;
  readonly meta: Readonly<Record<string, string | number | boolean>>;
}

/** The context of a message that is not stored: one run under `pathways test`, or a direct call. */
export const UNSTORED: MessageContext = Object.freeze({
  messageId: 0,
  attempt: 1,
  source: undefined,
  meta: Object.freeze({}),
});

/** The engine's request: transform one message, with what its context is built from beside it. */
export interface TransformRequest extends MessageContext {
  readonly id: number;
  readonly body: Uint8Array;
}

/** The worker's reply to one request. */
export type TransformReply =
  | { readonly id: number; readonly ok: true; readonly outputs: readonly Uint8Array[] }
  | { readonly id: number; readonly ok: false; readonly failure: FailureSummary };

/** The worker's first message: ready, or the transform could not be loaded. */
export type WorkerHello =
  { readonly hello: "ready" } | { readonly hello: "load-failed"; readonly failure: FailureSummary };

/** What the engine hands a new worker. */
export interface WorkerSetup {
  /** Always true: marks a thread the engine started, as opposed to a test runner's own thread. */
  readonly pathwaysWorker: true;
  readonly transformFile: string | undefined;
  readonly format: WorkerFormat;
  /**
   * The channel's configuration, resolved in the engine's process when it started: plain JSON
   * values, frozen once here and shared by every message's context.
   */
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Whether a thread's `workerData` is a setup the engine sent, so the entry starts only in a worker
 * the engine started.
 *
 * @example
 * ```ts
 * isWorkerSetup({ pathwaysWorker: true, transformFile: undefined, format: "text", config: {} }); // true
 * ```
 */
export function isWorkerSetup(data: unknown): data is WorkerSetup {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { pathwaysWorker?: unknown }).pathwaysWorker === true
  );
}

class StageError extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind, cause: unknown) {
    super("stage failed", { cause });
    this.kind = kind;
  }
}

/**
 * A JSON body that cannot be read, or cannot be read exactly. Its text is fixed, because the
 * `SyntaxError` from `JSON.parse` quotes the body it choked on.
 */
class JsonBodyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JsonBodyError";
    this.code = code;
  }
}

const encoder = new TextEncoder();
/** `text` keeps its first-slice behaviour: bytes that are not UTF-8 become U+FFFD. */
const lenientUtf8 = new TextDecoder();
/**
 * FHIR, X12, C-CDA and JSON are read as UTF-8, and a body that is not UTF-8 fails to parse with
 * `ERR_ENCODING_INVALID_ENCODED_DATA` rather than being changed in silence.
 */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

let hl7: Promise<typeof Hl7> | undefined;
let fhir: Promise<typeof Fhir> | undefined;
let x12: Promise<typeof X12> | undefined;
let ccda: Promise<typeof Ccda> | undefined;

/** Each `@cosyte/*` library, imported once, on first use. */
const libraries = {
  hl7: (): Promise<typeof Hl7> => (hl7 ??= import("@cosyte/hl7")),
  fhir: (): Promise<typeof Fhir> => (fhir ??= import("@cosyte/fhir")),
  x12: (): Promise<typeof X12> => (x12 ??= import("@cosyte/x12")),
  ccda: (): Promise<typeof Ccda> => (ccda ??= import("@cosyte/ccda")),
};

/**
 * Any JSON value, as a `json` channel's transform receives it from `JSON.parse`.
 *
 * @example
 * ```ts
 * const value: JsonValue = { status: "ok", tries: [1, 2] };
 * ```
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * What a format's writer hands back: text, sent as UTF-8, or bytes, sent as they are. A format whose
 * library writes another charset (Latin-1, with its own separators) or binary returns bytes, so
 * nothing is encoded as UTF-8 on its way out.
 */
export type Written = string | Uint8Array;

/** How a format writes its own library's model, on a channel of any format. */
export interface ModelWriter {
  /**
   * Whether the model is told by its shape, which costs nothing, rather than by its class, which
   * needs the library loaded. Shape writers are asked first, and class writers only for a value that
   * is not plain JSON, the channel's own format first.
   */
  readonly byShape: boolean;
  /** The model as the library writes it, or `undefined` when `value` is not one. */
  readonly write: (value: object) => Promise<Written | undefined>;
}

/**
 * One message format: how a body is read and written, and what the engine calls it outside the
 * worker. {@link FORMAT_REGISTRY} holds one per format, and the rest is read from it: the formats a
 * channel may declare, their file extensions and content types, the parser a worker loads, and the
 * type a transform receives.
 */
export interface FormatEntry<Message> {
  /** The file extension a file destination writes, without its dot. */
  readonly extension: string;
  /** The `Content-Type` an HTTP destination sends, unless its headers set one. */
  readonly contentType: string;
  /** Loads the library the format reads with, so the first message does not wait. Absent for none. */
  readonly load?: () => Promise<unknown>;
  /** Parses a stored body into what the transform receives; a throw is a parse failure. */
  readonly decode: (body: Uint8Array) => Message | Promise<Message>;
  /** Writes this format's model, on a channel of any format. */
  readonly model?: ModelWriter;
  /**
   * Writes any other value a transform returns on a channel of this format, or gives `undefined` to
   * refuse it. Asked after every model writer.
   */
  readonly value?: (output: unknown) => Written | undefined;
}

/** An entry, frozen, with the type its `decode` gives kept for {@link FormatModel}. */
function defineFormat<Message>(entry: FormatEntry<Message>): FormatEntry<Message> {
  return Object.freeze(entry);
}

/**
 * Every message format, in the order the configuration lists them. A format is added here, as one
 * entry, and nowhere else.
 *
 * - `hl7v2`: an `Hl7Message` from `@cosyte/hl7`;
 * - `fhir`: a resource from `@cosyte/fhir`'s JSON reader (its `FhirComplex` model);
 * - `x12`: an `X12Interchange` from `@cosyte/x12`;
 * - `ccda`: a `CcdaDocument` from `@cosyte/ccda`;
 * - `json`: the value `JSON.parse` returns;
 * - `text`: the body as a string.
 *
 * @example
 * ```ts
 * FORMAT_REGISTRY.fhir.contentType; // "application/fhir+json"
 * ```
 */
export const FORMAT_REGISTRY = Object.freeze({
  hl7v2: defineFormat<Hl7.Hl7Message>({
    extension: "hl7",
    contentType: "application/hl7-v2",
    load: libraries.hl7,
    // The library reads the bytes itself, in the charset the message declares.
    decode: async (body) =>
      (await libraries.hl7()).parseHL7(Buffer.from(body.buffer, body.byteOffset, body.byteLength)),
    model: {
      byShape: false,
      write: async (value) =>
        value instanceof (await libraries.hl7()).Hl7Message ? value.toString() : undefined,
    },
  }),
  fhir: defineFormat<Fhir.FhirComplex>({
    extension: "json",
    contentType: "application/fhir+json",
    load: libraries.fhir,
    decode: async (body) =>
      (await libraries.fhir()).parseResource(strictUtf8.decode(body)).resource,
    model: {
      byShape: true,
      write: async (value) =>
        isFhirModel(value) ? (await libraries.fhir()).serializeResource(value) : undefined,
    },
  }),
  x12: defineFormat<X12.X12Interchange>({
    extension: "x12",
    contentType: "application/edi-x12",
    load: libraries.x12,
    decode: async (body) => (await libraries.x12()).parseX12(strictUtf8.decode(body)),
    model: {
      byShape: true,
      write: async (value) =>
        isX12Model(value) ? (await libraries.x12()).serializeX12(value) : undefined,
    },
  }),
  ccda: defineFormat<Ccda.CcdaDocument>({
    extension: "xml",
    contentType: "application/xml",
    load: libraries.ccda,
    decode: async (body) => (await libraries.ccda()).parseCcda(strictUtf8.decode(body)),
    model: {
      byShape: false,
      write: async (value) => {
        const library = await libraries.ccda();
        return value instanceof library.CcdaDocument ? library.serializeCcda(value) : undefined;
      },
    },
  }),
  json: defineFormat<JsonValue>({
    extension: "json",
    contentType: "application/json",
    decode: (body) => parseJson(strictUtf8.decode(body)) as JsonValue,
    value: jsonValue,
  }),
  text: defineFormat<string>({
    extension: "txt",
    contentType: "text/plain",
    decode: (body) => lenientUtf8.decode(body),
  }),
});

/**
 * A message format a channel can declare, and so a worker can parse: a key of
 * {@link FORMAT_REGISTRY}.
 */
export type WorkerFormat = keyof typeof FORMAT_REGISTRY;

/**
 * What a transform receives on a channel of format `F`: the type its registry entry decodes to.
 *
 * @example
 * ```ts
 * type Claim = FormatModel<"x12">; // X12Interchange
 * ```
 */
export type FormatModel<F extends WorkerFormat> =
  (typeof FORMAT_REGISTRY)[F] extends FormatEntry<infer Message> ? Message : never;

/**
 * The formats, in the registry's order.
 *
 * @example
 * ```ts
 * FORMATS.includes("fhir"); // true
 * ```
 */
export const FORMATS: readonly WorkerFormat[] = Object.freeze(
  Object.keys(FORMAT_REGISTRY) as WorkerFormat[],
);

/**
 * One field of every entry, by format: the file extensions, or the content types.
 *
 * @example
 * ```ts
 * formatTable("extension").ccda; // "xml"
 * ```
 */
export function formatTable(
  field: "extension" | "contentType",
): Readonly<Record<WorkerFormat, string>> {
  const table: Partial<Record<WorkerFormat, string>> = {};
  for (const format of FORMATS) table[format] = FORMAT_REGISTRY[format][field];
  return Object.freeze(table as Record<WorkerFormat, string>);
}

/**
 * Loads the parser a format reads with, so a channel's first message does not wait for it.
 * `json` and `text` need none.
 *
 * @example
 * ```ts
 * await loadFormat("fhir"); // @cosyte/fhir is now loaded in this thread
 * ```
 */
export async function loadFormat(format: WorkerFormat): Promise<void> {
  const entry: FormatEntry<unknown> = FORMAT_REGISTRY[format];
  await entry.load?.();
}

/**
 * Parses a stored body into what the transform receives for `format`, with its registry entry (see
 * {@link FORMAT_REGISTRY} for what each gives).
 *
 * A library's parse failure keeps its stable `code` (`NO_MSH_SEGMENT`, `MALFORMED_JSON`,
 * `X12_NO_ISA_HEADER`, `NOT_WELL_FORMED_XML` and the rest). `json` refuses a body that is not JSON
 * (`MALFORMED_JSON`) and a number it cannot hold exactly (`INEXACT_JSON_NUMBER`), so a large id is
 * never rounded on its way through.
 *
 * @example
 * ```ts
 * const message = await decode("hl7v2", body); // an Hl7Message
 * const resource = await decode("fhir", body); // a FHIR resource model
 * ```
 */
export async function decode<F extends WorkerFormat>(
  format: F,
  body: Uint8Array,
): Promise<FormatModel<F>> {
  const entry = FORMAT_REGISTRY[format] as FormatEntry<FormatModel<F>>;
  // Called inside this async function, so a parser that throws as it is called rejects like one that
  // rejects. Only a parser's promise is awaited: a parser that returns its value at once (json,
  // text) leaves nothing waiting, so a run of calls that never yields piles up no continuations.
  const message = entry.decode(body);
  return message instanceof Promise ? await message : message;
}

/**
 * `JSON.parse`, refusing a number whose value differs from what the body wrote.
 *
 * The body is parsed once without a reviver, then its text is read once for its number literals,
 * each checked by {@link exactNumber}. A reviver would be called for every value and costs far more
 * than the parse. Two cases go on to the parse with a reviver, which decides them as it always did:
 * a body with a number that is not exact, since a later duplicate key may have replaced the value it
 * wrote and the reviver sees only the values the parse kept; and a body nested deeper than
 * {@link SCAN_DEPTH}, which a reviver's walk may not reach the bottom of (it then fails as
 * malformed, as it did).
 */
function parseJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new JsonBodyError("MALFORMED_JSON", "the body is not valid JSON");
  }
  return numbersExact(text) ? value : parseJsonRevived(text);
}

/** How deep a body may nest and still be read without a reviver. */
const SCAN_DEPTH = 256;

/**
 * Whether every number literal in `text`, which `JSON.parse` has accepted, is exact, in one pass over
 * the text. `false` also for a body nested deeper than {@link SCAN_DEPTH}.
 */
function numbersExact(text: string): boolean {
  const length = text.length;
  let depth = 0;
  for (let at = 0; at < length; at++) {
    const code = text.charCodeAt(at);
    if (code === 0x22) {
      // A string: skip to its closing quote, past every escaped character.
      for (at++; at < length; at++) {
        const inner = text.charCodeAt(at);
        if (inner === 0x5c) at++;
        else if (inner === 0x22) break;
      }
    } else if (code === 0x5b || code === 0x7b) {
      if (++depth > SCAN_DEPTH) return false;
    } else if (code === 0x5d || code === 0x7d) {
      depth--;
    } else if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      const start = at;
      while (at + 1 < length && isNumberCharacter(text.charCodeAt(at + 1))) at++;
      const literal = text.slice(start, at + 1);
      if (!exactNumber(literal, Number(literal))) return false;
    }
  }
  return true;
}

/** A character a JSON number literal can hold after its first. */
function isNumberCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2e ||
    code === 0x65 ||
    code === 0x45 ||
    code === 0x2b ||
    code === 0x2d
  );
}

/** `JSON.parse` with a reviver that checks each number against the literal that wrote it. */
function parseJsonRevived(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
    if (
      typeof value === "number" &&
      context?.source !== undefined &&
      !exactNumber(context.source, value)
    ) {
      throw new JsonBodyError(
        "INEXACT_JSON_NUMBER",
        "a number in the body cannot be held exactly; use format text to pass it through",
      );
    }
    return value;
  };
  try {
    return JSON.parse(text, reviver) as unknown;
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    throw new JsonBodyError("MALFORMED_JSON", "the body is not valid JSON");
  }
}

/**
 * Whether `value`, read from the JSON number literal `literal`, holds exactly what it wrote: whether
 * the two are the same sign, significant digits and exponent, so `1.50`, `15e-1` and `1.5` are the
 * same and `12345678901234567890` is not the double it rounds to. Most literals are written the way
 * JavaScript writes their value, and those need no more than one comparison.
 *
 * @example
 * ```ts
 * exactNumber("1.50", 1.5); // true
 * exactNumber("12345678901234567890", 12345678901234567890); // false
 * ```
 */
export function exactNumber(literal: string, value: number): boolean {
  const written = String(value);
  return written === literal || canonicalNumber(literal) === canonicalNumber(written);
}

/**
 * A JSON number literal as sign, significant digits and exponent (`-15e-1` for `-1.50`), read in one
 * pass; a text that is not a JSON number literal (`Infinity`) is returned as it is.
 */
function canonicalNumber(literal: string): string {
  const length = literal.length;
  let at = 0;
  const sign = literal.charCodeAt(0) === 0x2d ? "-" : "";
  if (sign !== "") at = 1;
  const wholeStart = at;
  while (at < length && isDigit(literal.charCodeAt(at))) at++;
  const wholeEnd = at;
  if (wholeEnd === wholeStart) return literal;
  let fractionStart = at;
  let fractionEnd = at;
  if (at < length && literal.charCodeAt(at) === 0x2e) {
    fractionStart = ++at;
    while (at < length && isDigit(literal.charCodeAt(at))) at++;
    fractionEnd = at;
    if (fractionEnd === fractionStart) return literal;
  }
  let exponent = "0";
  if (at < length && (literal.charCodeAt(at) === 0x65 || literal.charCodeAt(at) === 0x45)) {
    const exponentStart = ++at;
    if (at < length && (literal.charCodeAt(at) === 0x2b || literal.charCodeAt(at) === 0x2d)) at++;
    const digitsStart = at;
    while (at < length && isDigit(literal.charCodeAt(at))) at++;
    if (at === digitsStart) return literal;
    exponent = literal.slice(exponentStart, at);
  }
  if (at !== length) return literal;
  // The digits of the whole part and the fraction, read as one run: the first and last that are not
  // zero bound the significant digits.
  const wholeLength = wholeEnd - wholeStart;
  const fractionLength = fractionEnd - fractionStart;
  const total = wholeLength + fractionLength;
  const digit = (k: number): number =>
    literal.charCodeAt(k < wholeLength ? wholeStart + k : fractionStart + k - wholeLength);
  let first = 0;
  while (first < total && digit(first) === 0x30) first++;
  if (first === total) return "0";
  let last = total - 1;
  while (digit(last) === 0x30) last--;
  const run = (from: number, to: number): string =>
    to <= wholeLength
      ? literal.slice(wholeStart + from, wholeStart + to)
      : from >= wholeLength
        ? literal.slice(fractionStart + from - wholeLength, fractionStart + to - wholeLength)
        : literal.slice(wholeStart + from, wholeEnd) +
          literal.slice(fractionStart, fractionStart + to - wholeLength);
  const significant = run(first, last + 1);
  const scale = Number(exponent) - fractionLength + (total - first - significant.length);
  return `${sign}${significant}e${scale}`;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** A plain JSON object or array, as `JSON.parse` builds them, as opposed to an instance of a class. */
function isPlain(value: object): boolean {
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFhirModel(value: object): value is Fhir.FhirComplex {
  const node = value as { kind?: unknown; properties?: unknown };
  return node.kind === "complex" && Array.isArray(node.properties);
}

function isX12Model(value: object): value is X12.X12Interchange {
  const model = value as { isa?: { raw?: unknown }; groups?: unknown; delimiters?: unknown };
  return (
    typeof model.isa?.raw === "string" &&
    Array.isArray(model.groups) &&
    typeof model.delimiters === "object"
  );
}

/**
 * What a `json` channel writes for a value that is no library's model: a plain object or array, a
 * finite number or a boolean, with `JSON.stringify`.
 */
function jsonValue(output: unknown): Written | undefined {
  const plain = typeof output === "object" && output !== null && isPlain(output);
  if (
    plain ||
    typeof output === "boolean" ||
    (typeof output === "number" && Number.isFinite(output))
  ) {
    // An object whose `toJSON` gives `undefined` has always gone out as an empty body.
    const text = JSON.stringify(output) as unknown;
    return typeof text === "string" ? text : "";
  }
  return undefined;
}

/** The model writers told by shape, in the registry's order. */
const shapeWriters: ModelWriter[] = [];
/** The model writers told by class, with their formats, in the registry's order. */
const classWriters: (readonly [WorkerFormat, ModelWriter])[] = [];
for (const format of FORMATS) {
  const entry: FormatEntry<unknown> = FORMAT_REGISTRY[format];
  if (entry.model === undefined) continue;
  if (entry.model.byShape) shapeWriters.push(entry.model);
  else classWriters.push([format, entry.model]);
}

/**
 * A model from one of the `@cosyte/*` libraries as its library writes it, or `undefined` when
 * `value` is not one. A model is written whatever the channel's format, so a transform can turn one
 * format into another.
 */
async function writeModel(format: WorkerFormat, value: object): Promise<Written | undefined> {
  for (const writer of shapeWriters) {
    const written = await writer.write(value);
    if (written !== undefined) return written;
  }
  // A JSON object is never a message or a document; only a class instance can be one, and checking
  // costs nothing for a channel whose own library made it, so its own format is asked first.
  if (isPlain(value)) return undefined;
  const own = classWriters.filter(([owner]) => owner === format);
  for (const [, writer] of [...own, ...classWriters.filter(([owner]) => owner !== format)]) {
    const written = await writer.write(value);
    if (written !== undefined) return written;
  }
  return undefined;
}

/**
 * What a writer or a transform handed back, as bytes of its own: a string as UTF-8, and bytes copied
 * as they are, in whatever charset they were written. A copy, because the outputs move to the engine
 * with `postMessage`, which takes their buffers from whoever held them.
 *
 * @example
 * ```ts
 * bytesOf(new Uint8Array([0x4d, 0x41])); // the same two bytes, in a new buffer
 * bytesOf("MA"); // 4d 41
 * ```
 */
export function bytesOf(written: Written): Uint8Array {
  return typeof written === "string" ? encoder.encode(written) : new Uint8Array(written);
}

/**
 * Serializes one transform output back to bytes:
 *
 * - a string is sent as UTF-8, whatever the format;
 * - a `Uint8Array` (a `Buffer` is one) is sent as its bytes, copied, whatever the format, so a
 *   transform can send a body in any charset, or binary;
 * - a model from `@cosyte/hl7`, `@cosyte/fhir`, `@cosyte/x12` or `@cosyte/ccda` is written by its
 *   own library, whatever the channel's format, so a transform can return another format's model;
 *   a library that writes bytes keeps them, and one that writes text is sent as UTF-8;
 * - on a `json` channel, any other JSON value (a plain object, an array, a finite number or a
 *   boolean) is written with `JSON.stringify`. A transform's own array still means several
 *   messages, so one JSON array goes out as `[list]`.
 *
 * Anything else is refused with a `TypeError`. A serializer's own refusal keeps its code.
 *
 * @example
 * ```ts
 * const bytes = await encode("hl7v2", message); // message.toString(), as UTF-8
 * const json = await encode("json", { status: "ok" }); // {"status":"ok"}
 * ```
 */
export async function encode(format: WorkerFormat, output: unknown): Promise<Uint8Array> {
  if (typeof output === "string" || output instanceof Uint8Array) return bytesOf(output);
  if (typeof output === "object" && output !== null) {
    const written = await writeModel(format, output);
    if (written !== undefined) return bytesOf(written);
  }
  const entry: FormatEntry<unknown> = FORMAT_REGISTRY[format];
  const written = entry.value?.(output);
  if (written !== undefined) return bytesOf(written);
  throw new TypeError("the transform returned something that is neither a message nor a string");
}

/**
 * Freezes `value` and every object and array inside it, and returns it. Only plain data reaches it:
 * what the engine sent through `postMessage`, which copies, so nothing outside the worker is frozen.
 *
 * @example
 * ```ts
 * Object.isFrozen(freezeDeep({ a: { b: 1 } }).a); // true
 * ```
 */
export function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) freezeDeep(inner);
  }
  return value;
}

/**
 * The context a transform receives as its second argument for one message: a new frozen plain
 * object, holding the message's id, its run, its source facts, its per-message map and the
 * channel's configuration (frozen already, and shared by every message).
 *
 * @example
 * ```ts
 * const ctx = buildContext(UNSTORED, freezeDeep({ facility: "LAB" }));
 * Object.isFrozen(ctx); // true
 * ```
 */
export function buildContext(
  message: MessageContext,
  config: Readonly<Record<string, unknown>>,
): Readonly<MessageContext & { readonly config: Readonly<Record<string, unknown>> }> {
  return freezeDeep({
    messageId: message.messageId,
    attempt: message.attempt,
    source: message.source,
    meta: message.meta,
    config: freezeDeep(config),
  });
}

/**
 * Runs one message through `transform`: parse, call with its context, serialize. `null` or
 * `undefined` filters the message out; an array sends several. Without a context, the transform
 * gets that of a message that is not stored, with no configuration.
 *
 * @example
 * ```ts
 * const outputs = await runTransform((msg) => msg, "text", new TextEncoder().encode("hello"));
 * ```
 */
export async function runTransform(
  transform: TransformFunction,
  format: WorkerFormat,
  body: Uint8Array,
  ctx: unknown = buildContext(UNSTORED, {}),
): Promise<Uint8Array[]> {
  let message: unknown;
  try {
    message = await decode(format, body);
  } catch (error) {
    throw new StageError("parse", error);
  }
  let result: unknown;
  try {
    result = await transform(message, ctx);
  } catch (error) {
    throw new StageError("transform", error);
  }
  if (result === null || result === undefined) return [];
  const outputs: unknown[] = Array.isArray(result) ? result : [result];
  try {
    return await Promise.all(outputs.map((output) => encode(format, output)));
  } catch (error) {
    throw new StageError("output", error);
  }
}

/**
 * Loads the transform module's default export. With no transform, each message passes through as
 * it was parsed.
 *
 * @example
 * ```ts
 * const transform = await loadTransform("/project/channels/adt-to-lab/transform.ts");
 * ```
 */
export async function loadTransform(transformFile: string | undefined): Promise<TransformFunction> {
  // Wrapped, so a message that is itself an array (a JSON array) passes through as one message.
  if (transformFile === undefined) return (message) => [message];
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(transformFile).href)) as { default?: unknown };
  } catch (error) {
    throw new StageError("load", error);
  }
  if (typeof module.default !== "function") {
    throw new StageError(
      "load",
      new TypeError("the transform module has no default export function"),
    );
  }
  return module.default as TransformFunction;
}

/**
 * Describes a failure by name, code and location, keeping the error's text in `detail` only.
 *
 * @example
 * ```ts
 * summarize(new TypeError("..."), "/project/channels/adt-to-lab/transform.ts").name; // "TypeError"
 * ```
 */
export function summarize(error: unknown, transformFile?: string): FailureSummary {
  const kind = error instanceof StageError ? error.kind : "transform";
  const cause = error instanceof StageError ? error.cause : error;
  const name = cause instanceof Error ? cause.name : typeof cause;
  const rawCode = cause instanceof Error ? (cause as Error & { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  const detail = cause instanceof Error ? cause.message : String(cause);
  const where = transformFile === undefined ? undefined : locate(cause, transformFile);
  return {
    kind,
    name,
    detail,
    ...(code === undefined ? {} : { code }),
    ...(where === undefined ? {} : { where }),
  };
}

/**
 * `file:line:column` of the first stack frame inside the transform module, if there is one. A frame
 * names its file as a path or a file URL, and Node loads a module from its real path, so a frame
 * names that path when the configured one runs through a link: macOS's temporary folder (`/var` is
 * `/private/var`), or a project reached through a link. So each frame's file is read as a path, with
 * the system's own separators, and matched against the configured path and the real one.
 * `src/extensions/load.ts` holds the same rule for extension modules: this file imports nothing of
 * the package's own.
 */
function locate(error: unknown, transformFile: string): string | undefined {
  if (!(error instanceof Error) || error.stack === undefined) return undefined;
  const names = new Set([normalize(transformFile)]);
  try {
    // Both: the native one also expands a Windows short name (RUNNER~1) that the other keeps.
    names.add(realpathSync(transformFile)).add(realpathSync.native(transformFile));
  } catch {
    // The file is gone since it loaded: the configured path is all there is to match.
  }
  for (const line of error.stack.split("\n")) {
    const match = /\(?((?:file:\/\/)?[^\s()]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (match === null) continue;
    const [, file, row, column] = match;
    if (names.has(framePath(String(file)))) {
      /* v8 ignore next -- split returns at least one piece, so pop() always finds one */
      const name = transformFile.split(/[\\/]/).pop() ?? transformFile;
      return `${name}:${row}:${column}`;
    }
  }
  return undefined;
}

/** A stack frame's file as a path with the system's separators: a file URL is turned into one. */
function framePath(file: string): string {
  if (!file.startsWith("file:")) return normalize(file);
  try {
    return fileURLToPath(file);
  } catch {
    // A file URL no path can be made of here, such as one naming another host: matches nothing.
    return file;
  }
}

/**
 * The buffers of `outputs` that can move to the engine rather than be copied: each a view over the
 * whole of its own buffer (as `encode` makes them), each buffer once. The worker keeps none of them.
 *
 * @example
 * ```ts
 * transferable([new TextEncoder().encode("a")]).length; // 1
 * ```
 */
export function transferable(outputs: readonly Uint8Array[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const output of outputs) {
    const { buffer } = output;
    if (
      buffer instanceof ArrayBuffer &&
      output.byteOffset === 0 &&
      output.byteLength === buffer.byteLength &&
      buffer.byteLength > 0
    ) {
      buffers.add(buffer);
    }
  }
  return [...buffers];
}

/* v8 ignore start: runs only inside a worker thread, which the coverage of the test process does not
   reach. The functions above carry the logic and are tested directly. */
// No top-level await: the shared build also emits this entry as CommonJS.
if (!isMainThread && parentPort !== null && isWorkerSetup(workerData)) {
  const port = parentPort;
  const setup = workerData;
  const parser = loadFormat(setup.format).catch((error: unknown) => {
    throw new StageError("load", error);
  });
  // Frozen once: every message's context shares it.
  const config = freezeDeep(setup.config);
  Promise.all([loadTransform(setup.transformFile), parser]).then(
    ([transform]) => {
      port.on("message", (request: TransformRequest) => {
        runTransform(transform, setup.format, request.body, buildContext(request, config)).then(
          (outputs) =>
            port.postMessage(
              { id: request.id, ok: true, outputs } satisfies TransformReply,
              transferable(outputs),
            ),
          (error: unknown) =>
            port.postMessage({
              id: request.id,
              ok: false,
              failure: summarize(error, setup.transformFile),
            } satisfies TransformReply),
        );
      });
      port.postMessage({ hello: "ready" } satisfies WorkerHello);
    },
    (error: unknown) => {
      port.postMessage({
        hello: "load-failed",
        failure: summarize(error, setup.transformFile),
      } satisfies WorkerHello);
    },
  );
}
/* v8 ignore stop */
