import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type * as Hl7 from "@cosyte/hl7";
import type { AckErrorDetail, Hl7Message } from "@cosyte/hl7";

// The ACK an MLLP source sends, and the seam for building a different one. Kept apart from the MLLP
// connectors so the package entry point, which exports it, does not load the transport.
//
// `@cosyte/hl7` LOADS ON THE FIRST ACK. The package entry exports `defaultAckBuilder`, and nothing
// else in it needs the library, so importing `@cosyte/pathways` does not load it (about 700 KiB of
// code). It is loaded synchronously, since the builder is, and as the very module an `import` of
// `@cosyte/hl7` gives, so the `Hl7Message` a caller parsed is an instance of the class `buildAck`
// checks it against. ES modules resolve the library's `import` entry with `import.meta.resolve` and
// load it with `require`, which for an ES module returns the instance already loaded; the CommonJS
// build, which has no `import.meta.resolve`, requires the library's CommonJS entry, as a static
// import compiled to CommonJS did before.

/**
 * The ACK codes an MLLP source answers with.
 *
 * @example
 * ```ts
 * const positive = (code: SourceAckCode): boolean => code === "AA";
 * ```
 */
export type SourceAckCode = "AA" | "AE" | "AR";

/**
 * Why an MLLP source answers as it does: `stored` (the message is durable), `store-failed` (it
 * could not be stored, and `onStoreFailure` asked for an ACK), or `unreadable` (it was stored,
 * marked failed, because it has no usable header or arrived damaged).
 *
 * @example
 * ```ts
 * if (request.reason === "unreadable") console.warn(request.problem);
 * ```
 */
export type AckReason = "stored" | "store-failed" | "unreadable";

/**
 * What an {@link AckBuilder} is asked to acknowledge.
 *
 * @example
 * ```ts
 * const controlId = (request: AckRequest): string => request.header?.get("MSH.10") ?? "";
 * ```
 */
export interface AckRequest {
  /** The code Pathways decided on. */
  readonly code: SourceAckCode;
  readonly reason: AckReason;
  /**
   * For an `unreadable` message, what was wrong, as a stable code: one of `@cosyte/hl7`'s parse
   * codes (such as `NO_MSH_SEGMENT`), `NO_CONTROL_ID`, `MULTIPLE_MESSAGES` or
   * `MLLP_TRAILING_BYTES`.
   */
  readonly problem: string | undefined;
  /**
   * The inbound message's MSH segment, parsed, or `undefined` when it has none that parses. Only
   * the header is parsed: never the segments after it.
   */
  readonly header: Hl7Message | undefined;
  /** The stored message's id, or `undefined` when it could not be stored. */
  readonly messageId: number | undefined;
}

/**
 * Builds the ACK an MLLP source sends, as the bytes of an HL7 v2 message (the source adds the MLLP
 * framing). The default is {@link defaultAckBuilder}; a custom one is the seam for a source whose
 * sender wants a different ACK, named in the channel's YAML as
 * `source: { mllp: { ..., ackBuilder: ./ack.ts } }` and exported as the module's default. If it
 * throws, or runs past the channel's transform time limit, the source logs the error's name and
 * sends the default ACK instead. It runs in the engine's own thread, once per message.
 *
 * @example
 * ```ts
 * // channels/adt/ack.ts: the default ACK, with MSH-3 set to what this sender expects.
 * import { defaultAckBuilder, type AckBuilder } from "@cosyte/pathways";
 * import { parseHL7 } from "@cosyte/hl7";
 *
 * export default ((request) => {
 *   const ack = parseHL7(Buffer.from(defaultAckBuilder(request)));
 *   ack.setField("MSH.3", "PATHWAYS");
 *   return Buffer.from(ack.toString());
 * }) satisfies AckBuilder;
 * ```
 */
export type AckBuilder = (request: AckRequest) => Uint8Array | Promise<Uint8Array>;

/** Stands in for the header of a message that has none, so the ACK builder still has one to answer. */
const PLACEHOLDER_HEADER = "MSH|^~\\&|||||||ACK||P|2.5.1\r";

/**
 * Builds an MLLP source's ACK with `@cosyte/hl7`'s `buildAck`: sender and receiver swapped, MSA-2
 * echoing the inbound MSH-10, and, for a negative ACK, one ERR segment with an HL7 table 0357
 * condition code (207 when storing failed, 101 for a missing MSH-10, 100 otherwise). It never puts
 * message content in the ERR segment. An inbound header that declares an ISO 8859 character set in
 * MSH-18 is answered in Latin-1, so MSA-2 echoes the control ID byte for byte; anything else is
 * answered in UTF-8.
 *
 * @example
 * ```ts
 * const ack = defaultAckBuilder({
 *   code: "AA",
 *   reason: "stored",
 *   problem: undefined,
 *   header: parseHL7(mshSegment),
 *   messageId: 1,
 * });
 * ```
 */
export function defaultAckBuilder(request: AckRequest): Uint8Array {
  const header = request.header;
  const { buildAck, parseHL7 } = hl7();
  const inbound = header ?? parseHL7(PLACEHOLDER_HEADER);
  const error = errorDetail(request);
  const ack = buildAck(
    inbound,
    error === undefined ? { code: request.code } : { code: request.code, error },
  );
  return Buffer.from(ack.toString(), ackCharset(request) === "iso-8859-1" ? "latin1" : "utf8");
}

/**
 * The character set {@link defaultAckBuilder} writes an ACK in: ISO 8859-1 when the inbound header
 * declares an ISO 8859 character set in MSH-18, so MSA-2 echoes the control ID byte for byte, and
 * UTF-8 otherwise. An HTTP source names it in the ACK's `Content-Type`.
 *
 * @example
 * ```ts
 * ackCharset({ code: "AA", reason: "stored", problem: undefined, header: undefined, messageId: 1 }); // "utf-8"
 * ```
 */
export function ackCharset(request: AckRequest): "utf-8" | "iso-8859-1" {
  return request.header?.get("MSH.18")?.startsWith("8859") === true ? "iso-8859-1" : "utf-8";
}

let library: typeof Hl7 | undefined;

/** `@cosyte/hl7`, loaded on first use, as the module an `import` of it gives. */
function hl7(): typeof Hl7 {
  if (library !== undefined) return library;
  const require = createRequire(import.meta.url);
  const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
  /* v8 ignore next 3 -- the CommonJS build's branch: the tests run the ES module source */
  library = (
    resolve === undefined ? require("@cosyte/hl7") : require(fileURLToPath(resolve("@cosyte/hl7")))
  ) as typeof Hl7;
  return library;
}

function errorDetail(request: AckRequest): AckErrorDetail | undefined {
  if (request.code === "AA") return undefined;
  if (request.reason === "store-failed") return { conditionCode: "207" };
  if (request.problem === "NO_CONTROL_ID") return { conditionCode: "101", location: "MSH^1^10" };
  return { conditionCode: "100" };
}
