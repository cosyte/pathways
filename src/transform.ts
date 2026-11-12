import type * as Ccda from "@cosyte/ccda";
import type * as Fhir from "@cosyte/fhir";
import type * as Hl7 from "@cosyte/hl7";
import type * as X12 from "@cosyte/x12";

import type { Format } from "./config/schema.js";
import type { FormatModel, JsonValue } from "./engine/worker-entry.js";

/**
 * An HL7 v2 message as an `hl7v2` channel's transform receives it: `@cosyte/hl7`'s `Hl7Message`.
 * Pathways exports the type only; import the class from `@cosyte/hl7` to build one.
 *
 * @example
 * ```ts
 * import type { Hl7Message, Transform } from "@cosyte/pathways";
 *
 * export default ((msg) => (msg.is("ORU^R01") ? msg : null)) satisfies Transform<Hl7Message>;
 * ```
 */
export type Hl7Message = Hl7.Hl7Message;

/**
 * A FHIR R4 resource as a `fhir` channel's transform receives it: `@cosyte/fhir`'s `FhirComplex`, an
 * immutable model that keeps every decimal exactly as written. Read it with `@cosyte/fhir`'s
 * helpers (`getProperty`, `resourceType`, `readSafety`), and return it, a new model, or a string.
 *
 * @example
 * ```ts
 * import type { FhirResource, Transform } from "@cosyte/pathways";
 *
 * export default ((resource) => resource) satisfies Transform<FhirResource>;
 * ```
 */
export type FhirResource = Fhir.FhirComplex;

/**
 * An X12 interchange as an `x12` channel's transform receives it: `@cosyte/x12`'s
 * `X12Interchange`, whose typed readers (`get835`, `get837Claims` and the rest) take it from there.
 *
 * @example
 * ```ts
 * import type { Transform, X12Interchange } from "@cosyte/pathways";
 *
 * export default ((interchange) => interchange) satisfies Transform<X12Interchange>;
 * ```
 */
export type X12Interchange = X12.X12Interchange;

/**
 * A C-CDA document as a `ccda` channel's transform receives it: `@cosyte/ccda`'s `CcdaDocument`.
 * Pathways exports the type only; import the class from `@cosyte/ccda` to build one.
 *
 * @example
 * ```ts
 * import type { CcdaDocument, Transform } from "@cosyte/pathways";
 *
 * export default ((document) => (document.getPatient() ? document : null)) satisfies Transform<CcdaDocument>;
 * ```
 */
export type CcdaDocument = Ccda.CcdaDocument;

// Declared beside the format registry, in the worker, which imports nothing of the package's own.
export type {
  CsvColumn,
  CsvRecord,
  CsvSettings,
  CsvTable,
  Hl7v2Settings,
  JsonValue,
} from "./engine/worker-entry.js";

/**
 * The message each format hands a transform, by the `format` a channel declares, read from the
 * format registry: `hl7v2` an {@link Hl7Message}, `fhir` a {@link FhirResource}, `x12` an
 * {@link X12Interchange}, `ccda` a {@link CcdaDocument}, `json` a {@link JsonValue} (a string a
 * `json` transform returns is sent as it is, not JSON-quoted), `text` the body as a string, and
 * `csv` a `CsvTable`.
 *
 * @example
 * ```ts
 * type Claim = MessageTypes["x12"]; // X12Interchange
 * ```
 */
export type MessageTypes = { [F in Format]: FormatModel<F> };

/**
 * The message a channel of format `F` hands its transform.
 *
 * @example
 * ```ts
 * type Document = MessageFor<"ccda">; // CcdaDocument
 * ```
 */
export type MessageFor<F extends Format> = MessageTypes[F];

/**
 * What a transform may return: a message, a string or bytes to send on, several of them, or `null`
 * (or nothing) to filter the message out. A string is sent as UTF-8; bytes (a `Uint8Array`, which a
 * `Buffer` is) are sent as they are, so a body in another charset keeps its bytes.
 *
 * @example
 * ```ts
 * const filtered: TransformOutput<string> = null;
 * const bytes: TransformOutput<string> = Buffer.from("MSH|^~\\&|LAB", "latin1");
 * ```
 */
export type TransformOutput<M> =
  M | string | Uint8Array | readonly (M | string | Uint8Array)[] | null | undefined;

/**
 * The configuration a transform reads as `ctx.config`: the `config:` block of `pathways.yaml`, with
 * the channel's own `config:` block over it key by key, and each `{ env: NAME }` read from the
 * engine's environment when it starts. It is empty here: name your keys and their types by
 * declaration merging, once per project, and `ctx.config` is typed by them.
 *
 * @example
 * ```ts
 * declare module "@cosyte/pathways" {
 *   interface TransformConfig {
 *     readonly facility: string;
 *     readonly labCodes: readonly string[];
 *   }
 * }
 * ```
 */
// Empty on purpose: a project adds its keys by declaration merging, so an unnamed key does not type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TransformConfig {}

/**
 * What a file source knows about a message: the file's name as it was dropped, its size in bytes,
 * and when it was stored.
 *
 * @example
 * ```ts
 * const name = (source: FileSourceFacts): string => source.name;
 * ```
 */
export interface FileSourceFacts {
  readonly kind: "file";
  /** The file's name as it was dropped in the folder. It can carry a patient's name: never log it. */
  readonly name: string;
  /** The body's size in bytes. */
  readonly size: number;
  /** When the message was stored, as an ISO 8601 time. */
  readonly receivedAt: string;
}

/**
 * What an HTTP source knows about a message: the request's method, its path as the source matched
 * it, the sender's address, and the headers the channel's `contextHeaders` names, by lower-case
 * name. `Authorization`, `Proxy-Authorization` and `Cookie` are never among them.
 *
 * @example
 * ```ts
 * const requestId = (source: HttpSourceFacts): string | undefined => source.headers["x-request-id"];
 * ```
 */
export interface HttpSourceFacts {
  readonly kind: "http";
  /** `POST` or `PUT`. */
  readonly method: string;
  /** The path the request was sent to, as the source matched it, without a query. */
  readonly path: string;
  /** The sender's IP address, when the connection still had one. */
  readonly remoteAddress: string | undefined;
  /** The listed headers the request carried, by lower-case name; several values joined by `, `. */
  readonly headers: Readonly<Record<string, string>>;
  /** When the message was stored, as an ISO 8601 time. */
  readonly receivedAt: string;
}

/**
 * What an MLLP source knows about a message: the sender's address and, over mutual TLS, the common
 * name in the subject of the certificate the sender presented.
 *
 * @example
 * ```ts
 * const peer = (source: MllpSourceFacts): string => source.tlsPeerSubject ?? "unknown";
 * ```
 */
export interface MllpSourceFacts {
  readonly kind: "mllp";
  /** The sender's IP address, when the connection had one. */
  readonly remoteAddress: string | undefined;
  /** The common name (CN) in the subject of the sender's TLS certificate, when it presented one. */
  readonly tlsPeerSubject: string | undefined;
  /** When the message was stored, as an ISO 8601 time. */
  readonly receivedAt: string;
}

/**
 * What a tcp source knows about a message: the sender's address and, over mutual TLS, the common
 * name in the subject of the certificate the sender presented.
 *
 * @example
 * ```ts
 * const peer = (source: TcpSourceFacts): string => source.tlsPeerSubject ?? "unknown";
 * ```
 */
export interface TcpSourceFacts {
  readonly kind: "tcp";
  /** The sender's IP address, when the connection had one. */
  readonly remoteAddress: string | undefined;
  /** The common name (CN) in the subject of the sender's TLS certificate, when it presented one. */
  readonly tlsPeerSubject: string | undefined;
  /** When the message was stored, as an ISO 8601 time. */
  readonly receivedAt: string;
}

/**
 * What a custom source knows about a message: whatever it passed as `source` to `sink.receive`.
 *
 * @example
 * ```ts
 * const queue = (source: ModuleSourceFacts): JsonValue | undefined => source.facts["queue"];
 * ```
 */
export interface ModuleSourceFacts {
  readonly kind: "module";
  /** What the source passed, or `{}` when it passed nothing. */
  readonly facts: Readonly<Record<string, JsonValue>>;
  /** When the message was stored, as an ISO 8601 time. */
  readonly receivedAt: string;
}

/**
 * What the source knew about a message when it took it in, by the kind of source.
 *
 * @example
 * ```ts
 * const from = (source: SourceFacts): string | undefined =>
 *   source.kind === "http" || source.kind === "mllp" ? source.remoteAddress : undefined;
 * ```
 */
export type SourceFacts =
  FileSourceFacts | HttpSourceFacts | MllpSourceFacts | TcpSourceFacts | ModuleSourceFacts;

/**
 * The second argument a transform receives: a frozen plain object, built for each message.
 *
 * Nothing in it is logged, sent to a hook or shown on the health endpoint. A transform reads it; to
 * change what is sent, it changes what it returns.
 *
 * @example
 * ```ts
 * import type { Transform } from "@cosyte/pathways";
 *
 * export default ((msg, ctx) => {
 *   if (ctx?.source?.kind === "mllp" && ctx.source.tlsPeerSubject !== "lab.example.test") return null;
 *   return msg;
 * }) satisfies Transform;
 * ```
 */
export interface TransformContext {
  /** The stored message's id. 0 under `pathways test`, which stores nothing. */
  readonly messageId: number;
  /**
   * Which run of the transform this is for the message: 1 the first time, and one more for each
   * replay or resend before this one.
   */
  readonly attempt: number;
  /**
   * What the source knew about the message when it took it in. Undefined when that is not known:
   * under `pathways test`, on a replay, and for a message taken in before the engine last started,
   * since the facts are kept in memory until the message is transformed and not stored; and for the
   * oldest of a channel's messages past the 4,096 whose facts the engine holds while they wait.
   */
  readonly source: SourceFacts | undefined;
  /** A per-message map of flat values. Always empty in this release: nothing sets it yet. */
  readonly meta: Readonly<Record<string, string | number | boolean>>;
  /** The channel's configuration, resolved when the engine (or the command) started. */
  readonly config: Readonly<TransformConfig>;
  /**
   * The destination whose own transform this is: set only for a destination's `transform:`, never
   * for the channel's.
   */
  readonly destination?: DestinationFacts | undefined;
}

/**
 * Which destination a destination transform runs for: its place in the channel's `destinations:`
 * list, from 0, its `name:` when the block sets one, and its kind.
 * @example
 * ```ts
 * import type { Transform } from "@cosyte/pathways";
 * export default ((msg, ctx) => (ctx?.destination?.name === "billing" ? msg : null)) satisfies Transform;
 * ```
 */
export interface DestinationFacts {
  readonly index: number;
  readonly name: string | undefined;
  /** `file`, `http`, `mllp`, `tcp`, `smtp` or `module`. */
  readonly kind: string;
}

/**
 * A channel's transform: the default export of its `transform.ts`. It receives the parsed message
 * (an `Hl7Message` from `@cosyte/hl7` unless you name another type) and returns what to send. It
 * may be async.
 *
 * Its second argument, `ctx`, is a {@link TransformContext}: the message's id, which run this is,
 * what its source knew, and the channel's configuration. The engine always passes it; it is optional
 * in the type, so a transform that takes one argument is a `Transform` too, and a test can call one
 * with the message alone.
 *
 * `Out` is what it returns, when that differs from what it receives: a transform from HL7 v2 to FHIR
 * is a `Transform<Hl7Message, FhirResource>`. A model from any of the four libraries is written by
 * its own library, and a string is sent as it is.
 *
 * @example
 * ```ts
 * import type { Transform } from "@cosyte/pathways";
 *
 * export default ((msg) => {
 *   if (!msg.is("ADT^A01")) return null;
 *   msg.setField("MSH.5", "LAB");
 *   return msg;
 * }) satisfies Transform;
 * ```
 */
export type Transform<In = Hl7Message, Out = In> = (
  message: In,
  ctx?: TransformContext,
) => TransformOutput<Out> | Promise<TransformOutput<Out>>;

/**
 * A transform for a channel of format `F`, typed from the format name in `channel.yaml`. Name a
 * second format, `To`, when the transform returns another format's model.
 *
 * @example
 * ```ts
 * import type { TransformFor } from "@cosyte/pathways";
 *
 * // channel.yaml: format: x12
 * export default ((interchange) =>
 *   interchange.groups.some((group) => group.gs.elements[1] === "HC") ? interchange : null
 * ) satisfies TransformFor<"x12">;
 * ```
 */
export type TransformFor<F extends Format, To extends Format = F> = Transform<
  MessageFor<F>,
  MessageFor<To>
>;
