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

/**
 * What one destination's transform gave for one message: its outputs (none filters the destination
 * for that message), or why it failed. A failure here fails that destination's delivery only.
 */
export type DestinationReply =
  | { readonly ok: true; readonly outputs: readonly Uint8Array[] }
  | { readonly ok: false; readonly failure: FailureSummary };

/** One message a transform handed to another channel with `ctx.route`, serialized. */
export interface RoutedMessage {
  /** The channel it goes to, as the transform named it. */
  readonly channel: string;
  readonly body: Uint8Array;
}

/**
 * What one message's run came to: its outputs, what it handed to other channels, and, on a channel
 * with destination transforms, each destination's reply as {@link runDestinations} gives them.
 */
export interface TransformResult {
  readonly outputs: Uint8Array[];
  readonly routes: RoutedMessage[];
  readonly destinations?: (DestinationReply | null)[];
}

/**
 * The worker's reply to one request. On a channel with destination transforms, `destinations`
 * holds one entry per destination, in order: its reply, or `null` for a destination without a
 * transform, which sends the channel's `outputs` as they are.
 */
export type TransformReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly outputs: readonly Uint8Array[];
      readonly destinations?: readonly (DestinationReply | null)[];
      readonly routes?: readonly RoutedMessage[];
    }
  | { readonly id: number; readonly ok: false; readonly failure: FailureSummary };

/** What `ctx.route` does with one call: given a channel's name and a message. */
export type RouteFunction = (channel: string, message: unknown) => void;

/** A `ctx.route` that keeps nothing: the context of a run whose hand-offs go nowhere. */
const DISCARD_ROUTE: RouteFunction = () => undefined;

/**
 * The worker's first messages: `starting` once the module is loaded and its `onStart` is about to
 * run (so the engine times `onStart` alone), then ready, or a transform could not be loaded.
 * `destination` is the index of the destination whose transform failed to load, absent for the
 * channel's own.
 */
export type WorkerHello =
  | { readonly hello: "starting" }
  | { readonly hello: "ready" }
  | {
      readonly hello: "load-failed";
      readonly failure: FailureSummary;
      readonly destination?: number;
    };

/**
 * One destination as its transform sees it: where it is in the channel's list, its `name:` when the
 * block sets one, its kind, the format it sends (what its transform's return is written in), and its
 * transform module.
 */
export interface DestinationSetup {
  readonly index: number;
  readonly name: string | undefined;
  readonly kind: string;
  readonly format: WorkerFormat;
  /** The destination's transform module, or `undefined` for none: it sends the channel's outputs. */
  readonly transformFile: string | undefined;
}

/** The engine's request before it ends the worker: run the module's `onStop`, if it has one. */
export interface StopRequest {
  readonly stop: true;
}

/** The worker's reply to a {@link StopRequest}: done, with what went wrong if `onStop` threw. */
export interface StopReply {
  readonly stopped: true;
  readonly failure?: FailureSummary;
}

/** One line a channel script logs: a level, a fixed code and numbers only. */
export interface ScriptLogLine {
  readonly level: "info" | "warn" | "error";
  readonly code: string;
  readonly ids: Readonly<Record<string, number>>;
}

/** How a {@link ScriptLogLine} crosses to the engine. */
export interface ScriptLogMessage {
  readonly scriptLog: ScriptLogLine;
}

/**
 * A channel's module as the worker runs it: the transform, and the `onStart` and `onStop` it may
 * export beside it.
 */
export interface ChannelScripts {
  readonly transform: TransformFunction;
  readonly onStart: ((ctx: unknown) => unknown) | undefined;
  readonly onStop: (() => unknown) | undefined;
}

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
  /**
   * The channel's destinations, set only when one of them has a transform: each destination's
   * transform then runs after the channel's, once per channel output, in the same request.
   */
  readonly destinations?: readonly DestinationSetup[] | undefined;
  /** How the channel's format reads and writes its bodies, from the channel's own block. */
  readonly formatSettings?: FormatSettings;
  /** The channel's name, which `onStart` receives. Defaults to an empty name. */
  readonly channel?: string;
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
  /** The code a failure carries when its error has none of its own. */
  readonly fallbackCode: string | undefined;

  constructor(kind: FailureKind, cause: unknown, fallbackCode?: string) {
    super("stage failed", { cause });
    this.kind = kind;
    this.fallbackCode = fallbackCode;
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
/** `csv` reads strict UTF-8 too, keeping a byte order mark so it is written back. */
const strictUtf8Keep = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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

/**
 * One column of a fixed-width `csv` channel: its name, the position of its first character counting
 * from 1, and how many characters it holds, all counted in decoded characters (code points).
 *
 * @example
 * ```ts
 * const column: CsvColumn = { name: "code", start: 1, length: 8 };
 * ```
 */
export interface CsvColumn {
  readonly name: string;
  readonly start: number;
  readonly length: number;
}

/**
 * How a `csv` channel reads and writes its bodies, from the channel's `csv:` block. Every key is
 * optional; see {@link CSV_DEFAULTS} for what an unset key means. With `columns`, the channel reads
 * fixed-width lines rather than delimited ones, and `delimiter`, `quote`, `escape`, `header` and
 * `escapeFormulas` do not apply.
 *
 * @example
 * ```ts
 * const settings: CsvSettings = { delimiter: "|", header: true, newline: "lf" };
 * ```
 */
export interface CsvSettings {
  /** The one character between cells. Default `,`. */
  readonly delimiter?: string | undefined;
  /** The one character a cell is quoted with. Default `"`. */
  readonly quote?: string | undefined;
  /** The one character that escapes a quote inside a quoted cell. Default: the quote, doubled. */
  readonly escape?: string | undefined;
  /** Whether the first line names the columns. Default `true`. */
  readonly header?: boolean | undefined;
  /** How the body's bytes are read and written: `utf-8` (strict, the default) or `latin1`. */
  readonly encoding?: "utf-8" | "latin1" | undefined;
  /**
   * The line ending written after a line a transform changed or added. Default: the first one the
   * body used, or `crlf` when it has none. Lines are read on CRLF, LF and a bare CR alike.
   */
  readonly newline?: "crlf" | "lf" | "cr" | undefined;
  /** Whether a short line is padded (with empty cells, or spaces) rather than refused. Default `false`. */
  readonly pad?: boolean | undefined;
  /**
   * Whether a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a
   * leading `'`, quoted, so a spreadsheet does not run it as a formula. Default `false`.
   */
  readonly escapeFormulas?: boolean | undefined;
  /** The longest line read, in decoded characters. Default 1,048,576. */
  readonly maxRowLength?: number | undefined;
  /** The columns of a fixed-width body. Unset for a delimited one. */
  readonly columns?: readonly CsvColumn[] | undefined;
}

/**
 * What each unset key of {@link CsvSettings} means.
 *
 * @example
 * ```ts
 * CSV_DEFAULTS.delimiter; // ","
 * ```
 */
export const CSV_DEFAULTS = Object.freeze({
  delimiter: ",",
  quote: '"',
  header: true,
  encoding: "utf-8",
  pad: false,
  escapeFormulas: false,
  maxRowLength: 1_048_576,
} as const);

/**
 * How an `hl7v2` channel reads and writes its bodies, from the channel's `hl7v2:` block.
 *
 * @example
 * ```ts
 * const settings: Hl7v2Settings = { assumeCharset: "8859/1" };
 * ```
 */
export interface Hl7v2Settings {
  /**
   * The character set to read and write a message in when its MSH-18 is blank or absent: `8859/1`
   * to `8859/8`, `8859/10`, `8859/13` to `8859/16`, or `WINDOWS-1252`. A message that declares
   * MSH-18 is read and written in the set it declares. Unset, a blank MSH-18 means ASCII, read as its UTF-8 superset: bytes that are not
   * UTF-8 are kept as they arrived, and a segment a transform edits must then be ASCII.
   */
  readonly assumeCharset?: string | undefined;
}

/**
 * The character sets `hl7v2.assumeCharset` takes: the single-byte sets `@cosyte/hl7` reads into
 * text and writes back, by the labels MSH-18 uses for them.
 *
 * @example
 * ```ts
 * ASSUMABLE_CHARSETS.includes("8859/1"); // true
 * ```
 */
export const ASSUMABLE_CHARSETS = Object.freeze([
  "8859/1",
  "8859/2",
  "8859/3",
  "8859/4",
  "8859/5",
  "8859/6",
  "8859/7",
  "8859/8",
  "8859/10",
  "8859/13",
  "8859/14",
  "8859/15",
  "8859/16",
  "WINDOWS-1252",
] as const);

/**
 * The settings a format reads a channel's bodies with, beside its name: a `csv` channel's `csv:`
 * block, or an `hl7v2` channel's `hl7v2:` block. Plain data, sent to the worker as it starts.
 *
 * @example
 * ```ts
 * const settings: FormatSettings = { csv: { delimiter: ";" } };
 * ```
 */
export interface FormatSettings {
  readonly csv?: CsvSettings | undefined;
  readonly hl7v2?: Hl7v2Settings | undefined;
}

/**
 * One row of a `csv` table read with a header, or of a fixed-width one: its cells by column name, on
 * an object with no prototype, so a column named `__proto__` or `constructor` is a cell like any
 * other.
 *
 * @example
 * ```ts
 * const row: CsvRecord = Object.assign(Object.create(null), { code: "TEST-001" });
 * ```
 */
export type CsvRecord = Record<string, string>;

/**
 * What a `csv` channel's transform receives, and may return: the header and the rows. With a header
 * (and in fixed-width mode, where the header is the column names), each row is a {@link CsvRecord};
 * without one, `header` is `null` and each row is an array of cells. A transform may change it in
 * place or build a new one; rows it leaves untouched are written back byte for byte.
 *
 * @example
 * ```ts
 * const table: CsvTable = { header: null, rows: [["TEST-001", "Example"]] };
 * ```
 */
export type CsvTable = { header: string[]; rows: CsvRecord[] } | { header: null; rows: string[][] };

/** How a format writes its own library's model, on a channel of any format. */
export interface ModelWriter {
  /**
   * Whether the model is told by its shape, which costs nothing, rather than by its class, which
   * needs the library loaded. Shape writers are asked first, and class writers only for a value that
   * is not plain JSON, the channel's own format first.
   */
  readonly byShape: boolean;
  /**
   * The model as the library writes it, or `undefined` when `value` is not one. `settings` are the
   * channel's.
   */
  readonly write: (value: object, settings: FormatSettings) => Promise<Written | undefined>;
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
  /**
   * Parses a stored body into what the transform receives, with the channel's format settings; a
   * throw is a parse failure.
   */
  readonly decode: (body: Uint8Array, settings: FormatSettings) => Message | Promise<Message>;
  /** Writes this format's model, on a channel of any format. */
  readonly model?: ModelWriter;
  /**
   * Writes any other value a transform returns on a channel of this format, or gives `undefined` to
   * refuse it. Asked after every model writer.
   */
  readonly value?: (output: unknown, settings: FormatSettings) => Written | undefined;
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
 * - `text`: the body as a string;
 * - `csv`: a {@link CsvTable}, read by the reader below with the channel's `csv:` settings.
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
    // The library reads the bytes itself, in the charset the message declares, or the channel's
    // assumed one when MSH-18 is blank.
    decode: async (body, settings) =>
      readHl7(
        await libraries.hl7(),
        Buffer.from(body.buffer, body.byteOffset, body.byteLength),
        settings.hl7v2?.assumeCharset,
      ),
    model: {
      byShape: false,
      // Written in the charset MSH-18 declares, or the channel's assumed one when it is blank, so a
      // message nothing changed leaves as the bytes it arrived as. A character that set cannot hold
      // is refused (`UNENCODABLE_CHARACTER`, naming the segment and field, never their text), never
      // replaced.
      write: async (value, settings) => {
        const library = await libraries.hl7();
        return value instanceof library.Hl7Message
          ? writeHl7(library, value, settings.hl7v2?.assumeCharset)
          : undefined;
      },
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
  csv: defineFormat<CsvTable>({
    extension: "csv",
    contentType: "text/csv",
    decode: (body, settings) => readCsv(body, settings.csv ?? {}),
    value: (output, settings) =>
      isCsvTable(output) ? writeCsv(output, settings.csv ?? {}) : undefined,
  }),
});

/** Whether a message's MSH-18 is blank or absent, so the ASCII default or an assumed set applies. */
function msh18Blank(message: Hl7.Hl7Message): boolean {
  return (message.get("MSH.18") ?? "").trim() === "";
}

/**
 * An `hl7v2` body read in the set its MSH-18 declares; with MSH-18 blank and `assumeCharset` set,
 * read again in that set. Never a set guessed from the bytes.
 */
function readHl7(
  library: typeof Hl7,
  body: Buffer,
  assumeCharset: string | undefined,
): Hl7.Hl7Message {
  const message = library.parseHL7(body);
  if (assumeCharset === undefined || !msh18Blank(message)) return message;
  return library.parseHL7(body, { charset: assumeCharset });
}

/**
 * An `Hl7Message` written with `toBytes`: in the set MSH-18 declares, or in `assumeCharset` when
 * MSH-18 is blank. A refusal on a blank MSH-18 with no assumed set adds what a channel can do to the
 * library's text, which names a segment, a field and a set, never content; its code stays.
 */
function writeHl7(
  library: typeof Hl7,
  message: Hl7.Hl7Message,
  assumeCharset: string | undefined,
): Buffer {
  const blank = msh18Blank(message);
  try {
    return blank && assumeCharset !== undefined
      ? message.toBytes({ charset: assumeCharset })
      : message.toBytes();
  } catch (error) {
    if (
      blank &&
      assumeCharset === undefined &&
      error instanceof library.Hl7EncodeError &&
      error.code === "UNENCODABLE_CHARACTER"
    ) {
      error.message +=
        " MSH-18 is blank, so a segment the transform changed is written as ASCII: have the sender declare MSH-18, or set the channel's hl7v2.assumeCharset.";
    }
    throw error;
  }
}

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
  settings: FormatSettings = {},
): Promise<FormatModel<F>> {
  const entry = FORMAT_REGISTRY[format] as FormatEntry<FormatModel<F>>;
  // Called inside this async function, so a parser that throws as it is called rejects like one that
  // rejects. Only a parser's promise is awaited: a parser that returns its value at once (json,
  // text) leaves nothing waiting, so a run of calls that never yields piles up no continuations.
  const message = entry.decode(body, settings);
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

/**
 * A `csv` body that cannot be read, or a table that cannot be written. Its text names a line or a
 * column position and never a cell, since a cell can carry a patient's details.
 *
 * Codes: `CSV_UNTERMINATED_QUOTE`, `CSV_INVALID_QUOTE` (a quote inside an unquoted cell, or text
 * after a closing quote), `CSV_RAGGED_ROW`, `CSV_DUPLICATE_HEADER`, `CSV_ROW_TOO_LONG`,
 * `CSV_SHORT_LINE`, `CSV_VALUE_TOO_WIDE`, `CSV_UNKNOWN_COLUMN`, `CSV_INVALID_CELL` and
 * `CSV_NOT_ENCODABLE`.
 */
class CsvError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CsvError";
    this.code = code;
  }
}

/** A {@link CsvSettings} with every default filled in, read once per settings object. */
interface CsvPlan {
  readonly delimiter: string;
  readonly quote: string;
  readonly escape: string;
  readonly header: boolean;
  readonly latin1: boolean;
  readonly newline: string | undefined;
  readonly pad: boolean;
  readonly escapeFormulas: boolean;
  readonly maxRowLength: number;
  readonly columns: readonly CsvColumn[] | undefined;
  /** In fixed-width mode, the end of the last column: the width every line is read at. */
  readonly width: number;
}

const NEWLINES = { crlf: "\r\n", lf: "\n", cr: "\r" } as const;

const plans = new WeakMap<CsvSettings, CsvPlan>();

function planOf(settings: CsvSettings): CsvPlan {
  let plan = plans.get(settings);
  if (plan === undefined) {
    const quote = settings.quote ?? CSV_DEFAULTS.quote;
    const columns = settings.columns;
    plan = {
      delimiter: settings.delimiter ?? CSV_DEFAULTS.delimiter,
      quote,
      escape: settings.escape ?? quote,
      header: settings.header ?? CSV_DEFAULTS.header,
      latin1: settings.encoding === "latin1",
      newline: settings.newline === undefined ? undefined : NEWLINES[settings.newline],
      pad: settings.pad ?? CSV_DEFAULTS.pad,
      escapeFormulas: settings.escapeFormulas ?? CSV_DEFAULTS.escapeFormulas,
      maxRowLength: settings.maxRowLength ?? CSV_DEFAULTS.maxRowLength,
      columns,
      width: Math.max(0, ...(columns ?? []).map(({ start, length }) => start - 1 + length)),
    };
    plans.set(settings, plan);
  }
  return plan;
}

/** One line as it was read: its text without its ending, the ending, and its cells. */
interface CsvLine {
  readonly raw: string;
  readonly end: string;
  readonly cells: readonly string[];
}

/** What a table was read from, so what a transform leaves untouched is written back as it was. */
interface CsvOrigin {
  readonly bom: boolean;
  /** Whether the body's last line ended with a line ending (true for an empty body). */
  readonly trailing: boolean;
  /** The first line ending the body used, if any. */
  readonly newline: string | undefined;
  /** The header line, when the table has one read from the body. */
  readonly header: CsvLine | undefined;
}

/** Each table read in this worker, to where it came from. */
const origins = new WeakMap<object, CsvOrigin>();
/** Each row read in this worker, to its line. */
const rowLines = new WeakMap<object, CsvLine>();

/**
 * Reads a `csv` body into a {@link CsvTable}: delimited cells, or fixed-width columns when the
 * settings name `columns`. Lines end at CRLF, LF or a bare CR; a quoted cell may hold any of them.
 * A UTF-8 byte order mark is dropped, and written back.
 *
 * @example
 * ```ts
 * readCsv(new TextEncoder().encode("code,name\r\nTEST-001,Example\r\n"), {}).rows[0]?.["code"]; // "TEST-001"
 * ```
 */
export function readCsv(body: Uint8Array, settings: CsvSettings): CsvTable {
  const plan = planOf(settings);
  let text = plan.latin1
    ? Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("latin1")
    : strictUtf8Keep.decode(body);
  const bom = !plan.latin1 && text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const lines =
    plan.columns === undefined ? delimitedLines(text, plan) : fixedLines(text, plan, plan.columns);
  const last = lines.at(-1);
  const origin: CsvOrigin = {
    bom,
    trailing: last === undefined || last.end !== "",
    newline: lines.find(({ end }) => end !== "")?.end,
    header: plan.columns === undefined && plan.header ? lines[0] : undefined,
  };
  let table: CsvTable;
  if (plan.columns !== undefined) {
    const names = plan.columns.map(({ name }) => name);
    table = { header: names, rows: lines.map((line) => recordOf(names, line)) };
  } else if (plan.header) {
    const names = [...(lines[0]?.cells ?? [])];
    const seen = new Set<string>();
    for (const [at, name] of names.entries()) {
      if (seen.has(name)) {
        throw new CsvError("CSV_DUPLICATE_HEADER", `header column ${at + 1} repeats a name`);
      }
      seen.add(name);
    }
    table = {
      header: names,
      rows: lines
        .slice(1)
        .map((line, at) => recordOf(names, fitted(line, names.length, at + 2, plan))),
    };
  } else {
    const width = lines[0]?.cells.length ?? 0;
    table = {
      header: null,
      rows: lines.map((line, at) => {
        const fit = fitted(line, width, at + 1, plan);
        const row = [...fit.cells];
        rowLines.set(row, fit);
        return row;
      }),
    };
  }
  origins.set(table, origin);
  return table;
}

/** A line held to `width` cells: padded with empty ones when the settings say so, else refused. */
function fitted(line: CsvLine, width: number, number: number, plan: CsvPlan): CsvLine {
  const count = line.cells.length;
  if (count === width) return line;
  if (count < width && plan.pad) {
    return { ...line, cells: [...line.cells, ...Array<string>(width - count).fill("")] };
  }
  throw new CsvError(
    "CSV_RAGGED_ROW",
    `line ${number} has ${count} cells where the first has ${width}; set pad: true to pad a short one`,
  );
}

/** A row on an object with no prototype, its cells by column name, remembered against its line. */
function recordOf(names: readonly string[], line: CsvLine): CsvRecord {
  const row = Object.create(null) as CsvRecord;
  // The line holds one cell per name: fitted to the header, or cut into the columns.
  for (const [at, cell] of line.cells.entries()) row[names[at] as string] = cell;
  rowLines.set(row, line);
  return row;
}

/** The line ending at `at` in `text`: CRLF, LF, a bare CR, or none. */
function endingAt(text: string, at: number): string {
  const code = text.charCodeAt(at);
  if (code === 0x0d) return text.charCodeAt(at + 1) === 0x0a ? "\r\n" : "\r";
  return code === 0x0a ? "\n" : "";
}

function tooLong(number: number, plan: CsvPlan): CsvError {
  return new CsvError(
    "CSV_ROW_TOO_LONG",
    `line ${number} is longer than maxRowLength (${plan.maxRowLength} characters)`,
  );
}

/** Splits delimited text into lines of cells, as RFC 4180 reads them, with the settings' characters. */
function delimitedLines(text: string, plan: CsvPlan): CsvLine[] {
  const { delimiter, quote, escape, maxRowLength } = plan;
  const length = text.length;
  const lines: CsvLine[] = [];
  let at = 0;
  while (at < length) {
    const start = at;
    const number = lines.length + 1;
    const cells: string[] = [];
    for (;;) {
      let cell = "";
      if (text[at] === quote) {
        at++;
        let run = at;
        for (;;) {
          if (at >= length) {
            throw new CsvError(
              "CSV_UNTERMINATED_QUOTE",
              `line ${number} opens a quote it never closes`,
            );
          }
          if (at - start > maxRowLength) throw tooLong(number, plan);
          const char = text[at];
          if (
            char === escape &&
            escape !== quote &&
            (text[at + 1] === quote || text[at + 1] === escape)
          ) {
            cell += text.slice(run, at) + text[at + 1];
            at += 2;
            run = at;
          } else if (char === quote) {
            if (escape === quote && text[at + 1] === quote) {
              cell += text.slice(run, at + 1);
              at += 2;
              run = at;
            } else {
              cell += text.slice(run, at);
              at++;
              break;
            }
          } else {
            at++;
          }
        }
        if (at < length && text[at] !== delimiter && endingAt(text, at) === "") {
          throw new CsvError("CSV_INVALID_QUOTE", `line ${number} has text after a closing quote`);
        }
      } else {
        const run = at;
        while (at < length && text[at] !== delimiter) {
          const code = text.charCodeAt(at);
          if (code === 0x0d || code === 0x0a) break;
          if (text[at] === quote) {
            throw new CsvError(
              "CSV_INVALID_QUOTE",
              `line ${number} has a quote inside an unquoted cell`,
            );
          }
          at++;
        }
        cell = text.slice(run, at);
      }
      if (at - start > maxRowLength) throw tooLong(number, plan);
      cells.push(cell);
      if (at < length && text[at] === delimiter) {
        at++;
        continue;
      }
      break;
    }
    const end = endingAt(text, at);
    lines.push({ raw: text.slice(start, at), end, cells });
    at += end.length;
  }
  return lines;
}

/** Splits fixed-width text into lines, each cut into the settings' columns by code point. */
function fixedLines(text: string, plan: CsvPlan, columns: readonly CsvColumn[]): CsvLine[] {
  const length = text.length;
  const lines: CsvLine[] = [];
  let at = 0;
  while (at < length) {
    const number = lines.length + 1;
    let stop = at;
    while (stop < length && endingAt(text, stop) === "") stop++;
    const raw = text.slice(at, stop);
    const end = endingAt(text, stop);
    at = stop + end.length;
    const chars = Array.from(raw);
    if (chars.length > plan.maxRowLength) throw tooLong(number, plan);
    if (chars.length < plan.width) {
      if (!plan.pad) {
        throw new CsvError(
          "CSV_SHORT_LINE",
          `line ${number} has ${chars.length} characters where the columns need ${plan.width}; set pad: true to pad it with spaces`,
        );
      }
      while (chars.length < plan.width) chars.push(" ");
    }
    const cells = columns.map(({ start, length: size }) =>
      chars.slice(start - 1, start - 1 + size).join(""),
    );
    lines.push({ raw, end, cells });
  }
  return lines;
}

/** Whether a transform's output is a {@link CsvTable}: an object with `rows` and a `header`. */
function isCsvTable(output: unknown): output is CsvTable {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return false;
  const { header, rows } = output as { header?: unknown; rows?: unknown };
  return Array.isArray(rows) && (header === null || Array.isArray(header));
}

/** A cell's text: a string as it is, a number, boolean or bigint as written, nothing as empty. */
function cellText(value: unknown, number: number): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  throw new CsvError(
    "CSV_INVALID_CELL",
    `row ${number} holds a cell that is not a string, a finite number or a boolean`,
  );
}

/** A cell a spreadsheet would run as a formula. */
const FORMULA = /^[=+\-@\t\r]/;

/** Whether `cells` equal what `line` was read as, so the line can be written as it was. */
function untouched(cells: readonly string[], line: CsvLine | undefined, plan: CsvPlan): boolean {
  if (line?.cells.length !== cells.length) return false;
  for (const [at, cell] of cells.entries()) {
    if (cell !== line.cells[at]) return false;
    if (plan.escapeFormulas && plan.columns === undefined && FORMULA.test(cell)) return false;
  }
  return true;
}

/**
 * Writes a {@link CsvTable} back to a body. A line whose cells are as they were read is written as
 * it was, ending and all; a changed or new line is written with the settings' quoting and newline.
 * So a table no transform touched comes back byte for byte.
 *
 * @example
 * ```ts
 * writeCsv({ header: null, rows: [["TEST-001", "a,b"]] }, {}); // 'TEST-001,"a,b"\r\n'
 * ```
 */
export function writeCsv(table: CsvTable, settings: CsvSettings): Written {
  const plan = planOf(settings);
  const origin = origins.get(table);
  const newline = plan.newline ?? origin?.newline ?? "\r\n";
  const lines: { readonly text: string; readonly end: string | undefined }[] = [];
  const header = table.header;
  if (plan.columns !== undefined) {
    const columns = plan.columns;
    const names = columns.map(({ name }) => name);
    for (const [at, row] of (table.rows as unknown[]).entries()) {
      const cells = cellsByName(row, names, at + 1);
      // cellsByName refused anything but an object.
      const line = rowLines.get(row as object);
      lines.push(
        untouched(cells, line, plan) && line !== undefined
          ? { text: line.raw, end: line.end }
          : { text: fixedText(cells, plan.width, columns, at + 1), end: undefined },
      );
    }
  } else if (header !== null) {
    const names = header.map((name, at) => cellText(name, at + 1));
    if (names.length > 0) {
      const line = origin?.header;
      lines.push(
        untouched(names, line, plan) && line !== undefined
          ? { text: line.raw, end: line.end }
          : { text: delimitedText(names, plan), end: undefined },
      );
    }
    for (const [at, row] of (table.rows as unknown[]).entries()) {
      const cells = cellsByName(row, names, at + 1);
      // cellsByName refused anything but an object.
      const line = rowLines.get(row as object);
      lines.push(
        untouched(cells, line, plan) && line !== undefined
          ? { text: line.raw, end: line.end }
          : { text: delimitedText(cells, plan), end: undefined },
      );
    }
  } else {
    for (const [at, row] of (table.rows as unknown[]).entries()) {
      if (!Array.isArray(row)) {
        throw new CsvError(
          "CSV_INVALID_CELL",
          `row ${at + 1} is not an array, and the table has no header`,
        );
      }
      const cells = row.map((value) => cellText(value, at + 1));
      const line = rowLines.get(row);
      lines.push(
        untouched(cells, line, plan) && line !== undefined
          ? { text: line.raw, end: line.end }
          : { text: delimitedText(cells, plan), end: undefined },
      );
    }
  }
  let text = origin?.bom === true ? "﻿" : "";
  const trailing = origin?.trailing ?? true;
  for (const [at, { text: line, end }] of lines.entries()) {
    const last = at === lines.length - 1;
    // A line keeps its own ending; the last keeps the body's choice of ending with one or not.
    text += line + (last && !trailing ? "" : end === undefined || end === "" ? newline : end);
  }
  if (!plan.latin1) return text;
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) > 0xff) {
      throw new CsvError("CSV_NOT_ENCODABLE", "the table holds a character Latin-1 cannot write");
    }
  }
  return new Uint8Array(Buffer.from(text, "latin1"));
}

/** A row's cells in the order of `names`, refusing a key that names no column. */
function cellsByName(row: unknown, names: readonly string[], number: number): string[] {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new CsvError(
      "CSV_INVALID_CELL",
      `row ${number} is not an object of cells by column name`,
    );
  }
  const known = new Set(names);
  for (const key of Object.keys(row)) {
    if (!known.has(key)) {
      throw new CsvError(
        "CSV_UNKNOWN_COLUMN",
        `row ${number} has a cell under a name the header does not hold`,
      );
    }
  }
  const cells = row as Record<string, unknown>;
  return names.map((name) =>
    cellText(Object.hasOwn(cells, name) ? cells[name] : undefined, number),
  );
}

/** One delimited line: each cell quoted when it must be, and guarded when it reads as a formula. */
function delimitedText(cells: readonly string[], plan: CsvPlan): string {
  const { delimiter, quote, escape } = plan;
  return cells
    .map((cell) => {
      let value = cell;
      let quoted = false;
      if (plan.escapeFormulas && FORMULA.test(value)) {
        value = `'${value}`;
        quoted = true;
      }
      if (
        quoted ||
        value.includes(delimiter) ||
        value.includes(quote) ||
        value.includes(escape) ||
        value.includes("\r") ||
        value.includes("\n")
      ) {
        let inner = "";
        for (const char of value) {
          inner += char === quote || (char === escape && escape !== quote) ? escape + char : char;
        }
        return quote + inner + quote;
      }
      return value;
    })
    .join(delimiter);
}

/** One fixed-width line: each cell at its column, padded with spaces, refused when it is too wide. */
function fixedText(
  cells: readonly string[],
  width: number,
  columns: readonly CsvColumn[],
  number: number,
): string {
  const chars = Array<string>(width).fill(" ");
  for (const [at, column] of columns.entries()) {
    // One cell per column: cellsByName read them by the columns' names.
    const value = Array.from(cells[at] as string);
    if (value.length > column.length) {
      throw new CsvError(
        "CSV_VALUE_TOO_WIDE",
        `row ${number}: the value for column ${at + 1} is ${value.length} characters, wider than its ${column.length}`,
      );
    }
    if (value.some((char) => char === "\r" || char === "\n")) {
      throw new CsvError(
        "CSV_INVALID_CELL",
        `row ${number}: the value for column ${at + 1} holds a line ending`,
      );
    }
    for (const [offset, char] of value.entries()) chars[column.start - 1 + offset] = char;
  }
  return chars.join("");
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
async function writeModel(
  format: WorkerFormat,
  value: object,
  settings: FormatSettings,
): Promise<Written | undefined> {
  for (const writer of shapeWriters) {
    const written = await writer.write(value, settings);
    if (written !== undefined) return written;
  }
  // A JSON object is never a message or a document; only a class instance can be one, and checking
  // costs nothing for a channel whose own library made it, so its own format is asked first.
  if (isPlain(value)) return undefined;
  const own = classWriters.filter(([owner]) => owner === format);
  for (const [, writer] of [...own, ...classWriters.filter(([owner]) => owner !== format)]) {
    const written = await writer.write(value, settings);
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
 * const bytes = await encode("hl7v2", message); // message.toBytes(), in its MSH-18 charset
 * const json = await encode("json", { status: "ok" }); // {"status":"ok"}
 * ```
 */
export async function encode(
  format: WorkerFormat,
  output: unknown,
  settings: FormatSettings = {},
): Promise<Uint8Array> {
  if (typeof output === "string" || output instanceof Uint8Array) return bytesOf(output);
  if (typeof output === "object" && output !== null) {
    const written = await writeModel(format, output, settings);
    if (written !== undefined) return bytesOf(written);
  }
  const entry: FormatEntry<unknown> = FORMAT_REGISTRY[format];
  const written = entry.value?.(output, settings);
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
  route: RouteFunction = DISCARD_ROUTE,
): Readonly<
  MessageContext & {
    readonly config: Readonly<Record<string, unknown>>;
    readonly route: RouteFunction;
  }
> {
  return freezeDeep({
    messageId: message.messageId,
    attempt: message.attempt,
    source: message.source,
    meta: message.meta,
    config: freezeDeep(config),
    route,
  });
}

/**
 * Runs one message through `transform` as {@link runTransform} does, with a `ctx.route` that keeps
 * each message handed to another channel, and serializes those as it does the outputs, in the order
 * they were routed. `ctx.route` takes a channel's name and a message (anything a transform may
 * return but `null` and `undefined`), returns nothing, and throws a `TypeError` for anything else,
 * or once the transform has settled. Given `destinations`, each destination's transform then runs
 * on the outputs as {@link runDestinations} runs it; the channel's transform has settled by then,
 * so a destination transform that calls `ctx.route` fails that destination.
 *
 * @example
 * ```ts
 * const { outputs, routes } = await transformMessage((msg, ctx) => {
 *   ctx.route("audit-copy", msg);
 *   return msg;
 * }, "text", body, UNSTORED, {});
 * ```
 */
export async function transformMessage(
  transform: TransformFunction,
  format: WorkerFormat,
  body: Uint8Array,
  message: MessageContext,
  config: Readonly<Record<string, unknown>>,
  settings: FormatSettings = {},
  destinations?: readonly LoadedDestination[],
): Promise<TransformResult> {
  const routed: { readonly channel: string; readonly output: unknown }[] = [];
  let settled = false;
  const route: RouteFunction = (channel, output) => {
    if (settled) throw new TypeError("ctx.route was called after the transform settled");
    if (typeof channel !== "string" || channel === "") {
      throw new TypeError("ctx.route takes a channel's name first");
    }
    if (output === null || output === undefined) {
      throw new TypeError("ctx.route takes a message to hand over second");
    }
    routed.push({ channel, output });
  };
  const ctx = buildContext(message, config, route);
  let outputs: Uint8Array[];
  try {
    outputs = await runTransform(transform, format, body, ctx, settings);
  } finally {
    settled = true;
  }
  let routes: RoutedMessage[];
  try {
    routes = await Promise.all(
      routed.map(async ({ channel, output }) => ({
        channel,
        body: await encode(format, output, settings),
      })),
    );
  } catch (error) {
    throw new StageError("output", error);
  }
  if (destinations === undefined) return { outputs, routes };
  return {
    outputs,
    routes,
    destinations: await destinationReplies(outputs, format, ctx, destinations, settings),
  };
}

/**
 * Runs one message through `transform`: parse, call with its context, serialize. `null` or
 * `undefined` filters the message out; an array sends several. Without a context, the transform
 * gets that of a message that is not stored, with no configuration. `settings` is how the channel's
 * own block reads and writes its format's bodies (a `csv` channel's `csv:`). The outputs are
 * written in `outFormat`, the format read by default: a destination's transform reads the channel's
 * format and writes its destination's.
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
  settings: FormatSettings = {},
  outFormat: WorkerFormat = format,
): Promise<Uint8Array[]> {
  let message: unknown;
  try {
    message = await decode(format, body, settings);
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
    return await Promise.all(outputs.map((output) => encode(outFormat, output, settings)));
  } catch (error) {
    throw new StageError("output", error);
  }
}

/**
 * The context a destination's transform receives: the channel's, with `destination` beside it.
 *
 * @example
 * ```ts
 * const ctx = destinationContext(buildContext(UNSTORED, {}), { index: 0, name: "lab", kind: "file", format: "hl7v2", transformFile: undefined });
 * ctx.destination; // { index: 0, name: "lab", kind: "file" }
 * ```
 */
export function destinationContext(
  ctx: object,
  destination: DestinationSetup,
): Readonly<Record<string, unknown>> {
  return freezeDeep({
    ...ctx,
    destination: { index: destination.index, name: destination.name, kind: destination.kind },
  });
}

/** A destination's setup with its transform loaded. */
export interface LoadedDestination {
  readonly setup: DestinationSetup;
  readonly transform: TransformFunction | undefined;
}

/**
 * Runs one message through the channel's transform and then each destination's transform, once per
 * channel output, in order: a destination's outputs are what its transform returned for each
 * channel output, joined in order, and none filters that destination for the message. Each
 * destination transform reads the channel output parsed in the channel's format, and what it returns
 * is written in its destination's format. A destination transform that throws, or whose output cannot be read or written, fails that
 * destination only: the others go on. A destination without a transform sends the channel's
 * outputs, and its entry is `null`. A failure of the channel's own transform rejects, as
 * {@link runTransform} does. `settings` is the channel's, as {@link runTransform} takes it.
 *
 * @example
 * ```ts
 * const { outputs, destinations } = await runDestinations(transform, "text", body, ctx, loaded);
 * ```
 */
export async function runDestinations(
  transform: TransformFunction,
  format: WorkerFormat,
  body: Uint8Array,
  ctx: object,
  destinations: readonly LoadedDestination[],
  settings: FormatSettings = {},
): Promise<{ outputs: Uint8Array[]; destinations: (DestinationReply | null)[] }> {
  const outputs = await runTransform(transform, format, body, ctx, settings);
  return {
    outputs,
    destinations: await destinationReplies(outputs, format, ctx, destinations, settings),
  };
}

/**
 * Each destination's reply for a message's channel `outputs`, as {@link runDestinations} gives
 * them: its transform run once per output, or `null` for a destination without one.
 */
async function destinationReplies(
  outputs: readonly Uint8Array[],
  format: WorkerFormat,
  ctx: object,
  destinations: readonly LoadedDestination[],
  settings: FormatSettings,
): Promise<(DestinationReply | null)[]> {
  const replies: (DestinationReply | null)[] = [];
  for (const { setup, transform: own } of destinations) {
    if (own === undefined) {
      replies.push(null);
      continue;
    }
    const context = destinationContext(ctx, setup);
    try {
      const sent: Uint8Array[] = [];
      for (const output of outputs) {
        sent.push(...(await runTransform(own, format, output, context, settings, setup.format)));
      }
      replies.push({ ok: true, outputs: sent });
    } catch (error) {
      replies.push({ ok: false, failure: summarize(error, setup.transformFile) });
    }
  }
  return replies;
}

/**
 * Loads each destination's transform, in order. A module that fails to load rejects with a
 * {@link DestinationLoadError} naming the destination.
 *
 * @example
 * ```ts
 * const loaded = await loadDestinations(setup.destinations ?? []);
 * ```
 */
export async function loadDestinations(
  destinations: readonly DestinationSetup[],
): Promise<LoadedDestination[]> {
  const loaded: LoadedDestination[] = [];
  for (const setup of destinations) {
    if (setup.transformFile === undefined) {
      loaded.push({ setup, transform: undefined });
      continue;
    }
    try {
      loaded.push({ setup, transform: await loadTransform(setup.transformFile) });
    } catch (error) {
      throw new DestinationLoadError(setup, error);
    }
  }
  return loaded;
}

/**
 * A destination's transform could not be loaded: which one, and why.
 *
 * @example
 * ```ts
 * if (error instanceof DestinationLoadError) console.error(error.destination.index);
 * ```
 */
export class DestinationLoadError extends Error {
  readonly destination: DestinationSetup;

  /**
   * @param destination The destination whose transform it was.
   * @param cause What {@link loadTransform} threw: a load failure.
   */
  constructor(destination: DestinationSetup, cause: unknown) {
    super("a destination transform failed to load", { cause });
    this.name = "DestinationLoadError";
    this.destination = destination;
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
  return (await loadScripts(transformFile)).transform;
}

/**
 * Loads the transform module: its default export, and the `onStart` and `onStop` it may export.
 * An `onStart` or `onStop` that is exported and is not a function will not load. With no
 * transform, each message passes through as it was parsed, and there are no scripts.
 *
 * @example
 * ```ts
 * const { transform, onStart } = await loadScripts("/project/channels/adt-to-lab/transform.ts");
 * ```
 */
export async function loadScripts(transformFile: string | undefined): Promise<ChannelScripts> {
  // Wrapped, so a message that is itself an array (a JSON array) passes through as one message.
  if (transformFile === undefined) {
    return { transform: (message) => [message], onStart: undefined, onStop: undefined };
  }
  let module: { default?: unknown; onStart?: unknown; onStop?: unknown };
  try {
    module = (await import(pathToFileURL(transformFile).href)) as typeof module;
  } catch (error) {
    throw new StageError("load", error);
  }
  if (typeof module.default !== "function") {
    throw new StageError(
      "load",
      new TypeError("the transform module has no default export function"),
    );
  }
  for (const name of ["onStart", "onStop"] as const) {
    if (module[name] !== undefined && typeof module[name] !== "function") {
      throw new StageError(
        "load",
        new TypeError(`the transform module's ${name} is not a function`),
      );
    }
  }
  return {
    transform: module.default as TransformFunction,
    onStart: module.onStart as ChannelScripts["onStart"],
    onStop: module.onStop as ChannelScripts["onStop"],
  };
}

/** A script log line's code: lower-case words joined by hyphens, as the engine's own events are. */
const SCRIPT_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A script log line's id names: a letter, then letters and digits. */
const SCRIPT_ID = /^[A-Za-z][A-Za-z0-9]*$/;
/** At most this many ids on one line, and this long a code or an id's name. */
const SCRIPT_IDS = 16;
const SCRIPT_NAME_LENGTH = 64;

/**
 * One line a channel script logs, kept to what is safe in the engine's log: a code of lower-case
 * words joined by hyphens (anything else becomes `script-log`), and ids that are finite numbers,
 * named by a letter and then letters and digits, at most 16 of them. Strings, and anything else
 * that could carry a message's content, are dropped.
 *
 * @example
 * ```ts
 * scriptLogLine("info", "cache-warmed", { entries: 12, name: "dropped" });
 * // { level: "info", code: "cache-warmed", ids: { entries: 12 } }
 * ```
 */
export function scriptLogLine(
  level: ScriptLogLine["level"],
  code: unknown,
  ids: unknown,
): ScriptLogLine {
  const safeCode =
    typeof code === "string" && code.length <= SCRIPT_NAME_LENGTH && SCRIPT_CODE.test(code)
      ? code
      : "script-log";
  const kept: Record<string, number> = {};
  if (typeof ids === "object" && ids !== null) {
    for (const [name, value] of Object.entries(ids)) {
      if (Object.keys(kept).length >= SCRIPT_IDS) break;
      if (name.length > SCRIPT_NAME_LENGTH || !SCRIPT_ID.test(name)) continue;
      if (typeof value === "number" && Number.isFinite(value)) kept[name] = value;
    }
  }
  return { level, code: safeCode, ids: kept };
}

/**
 * The context `onStart` receives: the channel's name, its configuration (frozen, as each message's
 * context holds it), and a logger that takes a code and numbers only, each line posted to the
 * engine through `post`.
 *
 * @example
 * ```ts
 * const ctx = scriptContext("adt-to-lab", freezeDeep({}), (line) => lines.push(line));
 * ```
 */
export function scriptContext(
  channel: string,
  config: Readonly<Record<string, unknown>>,
  post: (line: ScriptLogLine) => void,
): unknown {
  const at =
    (level: ScriptLogLine["level"]) =>
    (code: unknown, ids?: unknown): void => {
      post(scriptLogLine(level, code, ids));
    };
  return Object.freeze({
    channel,
    config: freezeDeep(config),
    logger: Object.freeze({ info: at("info"), warn: at("warn"), error: at("error") }),
  });
}

/**
 * Runs the module's `onStart`, when it has one: a throw is a load failure, coded `ON_START_FAILED`
 * unless the error has a code of its own.
 *
 * @example
 * ```ts
 * await runOnStart(scripts.onStart, ctx);
 * ```
 */
export async function runOnStart(onStart: ChannelScripts["onStart"], ctx: unknown): Promise<void> {
  if (onStart === undefined) return;
  try {
    await onStart(ctx);
  } catch (error) {
    throw new StageError("load", error, "ON_START_FAILED");
  }
}

/**
 * Runs the module's `onStop`, when it has one, and says how it went: a throw is described, never
 * passed on, since the worker ends either way.
 *
 * @example
 * ```ts
 * port.postMessage(await runOnStop(scripts.onStop, transformFile));
 * ```
 */
export async function runOnStop(
  onStop: ChannelScripts["onStop"],
  transformFile?: string,
): Promise<StopReply> {
  if (onStop === undefined) return { stopped: true };
  try {
    await onStop();
    return { stopped: true };
  } catch (error) {
    const failure = summarize(new StageError("load", error, "ON_STOP_FAILED"), transformFile);
    return { stopped: true, failure };
  }
}

/**
 * Whether a message from the engine is a {@link StopRequest}.
 *
 * @example
 * ```ts
 * isStopRequest({ stop: true }); // true
 * ```
 */
export function isStopRequest(message: unknown): message is StopRequest {
  return typeof message === "object" && message !== null && (message as StopRequest).stop === true;
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
  const code =
    typeof rawCode === "string"
      ? rawCode
      : error instanceof StageError
        ? error.fallbackCode
        : undefined;
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
  // The channel's format, and each destination's, loaded before the first message.
  const formats = new Set([setup.format, ...(setup.destinations ?? []).map((d) => d.format)]);
  const parser = Promise.all([...formats].map(loadFormat)).catch((error: unknown) => {
    throw new StageError("load", error);
  });
  // Frozen once: every message's context shares it.
  const config = freezeDeep(setup.config);
  const formatSettings = freezeDeep(setup.formatSettings ?? {});
  const post = (line: ScriptLogLine): void => {
    port.postMessage({ scriptLog: line } satisfies ScriptLogMessage);
  };
  Promise.all([loadScripts(setup.transformFile), parser])
    .then(async ([scripts]) => {
      const destinations =
        setup.destinations === undefined ? undefined : await loadDestinations(setup.destinations);
      if (scripts.onStart !== undefined) {
        // Told first, so the engine times onStart alone, not the modules' load.
        port.postMessage({ hello: "starting" } satisfies WorkerHello);
        await runOnStart(scripts.onStart, scriptContext(setup.channel ?? "", config, post));
      }
      return { ...scripts, destinations };
    })
    .then(
      ({ transform, onStop, destinations }) => {
        port.on("message", (request: TransformRequest | StopRequest) => {
          if (isStopRequest(request)) {
            void runOnStop(onStop, setup.transformFile).then((reply) => {
              port.postMessage(reply);
            });
            return;
          }
          transformMessage(
            transform,
            setup.format,
            request.body,
            request,
            config,
            formatSettings,
            destinations,
          ).then(
            (result) =>
              port.postMessage(
                { id: request.id, ok: true, ...result } satisfies TransformReply,
                transferable([
                  ...result.outputs,
                  ...result.routes.map((routed) => routed.body),
                  ...(result.destinations ?? []).flatMap((reply) =>
                    reply?.ok === true ? reply.outputs : [],
                  ),
                ]),
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
        port.postMessage(
          (error instanceof DestinationLoadError
            ? {
                hello: "load-failed",
                failure: summarize(error.cause, error.destination.transformFile),
                destination: error.destination.index,
              }
            : {
                hello: "load-failed",
                failure: summarize(error, setup.transformFile),
              }) satisfies WorkerHello,
        );
      },
    );
}
/* v8 ignore stop */
