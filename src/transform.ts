import type * as Ccda from "@cosyte/ccda";
import type * as Fhir from "@cosyte/fhir";
import type * as Hl7 from "@cosyte/hl7";
import type * as X12 from "@cosyte/x12";

import type { Format } from "./config/schema.js";

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

/**
 * Any JSON value, as a `json` channel's transform receives it from `JSON.parse`.
 *
 * @example
 * ```ts
 * const value: JsonValue = { status: "ok", tries: [1, 2] };
 * ```
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The message each format hands a transform, by the `format` a channel declares.
 *
 * @example
 * ```ts
 * type Claim = MessageTypes["x12"]; // X12Interchange
 * ```
 */
export interface MessageTypes {
  /** HL7 v2, parsed with `@cosyte/hl7`. */
  hl7v2: Hl7Message;
  /** FHIR R4 JSON, parsed with `@cosyte/fhir`. */
  fhir: FhirResource;
  /** An X12 interchange, parsed with `@cosyte/x12`. */
  x12: X12Interchange;
  /** A C-CDA document, parsed with `@cosyte/ccda`. */
  ccda: CcdaDocument;
  /** Any JSON value. A string a `json` transform returns is sent as it is, not JSON-quoted. */
  json: JsonValue;
  /** The body as a string. */
  text: string;
}

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
 * What a transform may return: a message or a string to send on, several of them, or `null` (or
 * nothing) to filter the message out.
 *
 * @example
 * ```ts
 * const filtered: TransformOutput<string> = null;
 * ```
 */
export type TransformOutput<M> = M | string | readonly (M | string)[] | null | undefined;

/**
 * A channel's transform: the default export of its `transform.ts`. It receives the parsed message
 * (an `Hl7Message` from `@cosyte/hl7` unless you name another type) and returns what to send. It
 * may be async.
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
