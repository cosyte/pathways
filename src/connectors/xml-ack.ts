// Reading an HL7 v2 acknowledgement written in the HL7 v2 XML encoding, the answer a web service
// that takes v2 XML sends back on the same HTTPS connection. Internal: the package entry exports none
// of it.
//
// The XML is read by @cosyte/ccda's hardened reader: no DOCTYPE, no entities, and caps on size,
// depth and element count. Only the acknowledgement code and the control ID it answers are taken;
// nothing of the answer's text reaches a log or an error.

import type * as Ccda from "@cosyte/ccda";

import { transientError } from "./http-core.js";
import { DeliveryRejected } from "./types.js";

/** The largest acknowledgement read, in bytes. A larger answer is unreadable, and retried. */
export const MAX_XML_ACK_BYTES = 1_048_576;

/** Caps on the acknowledgement's XML, well above any `ACK` and far below anything hostile. */
const LIMITS = {
  maxInputBytes: MAX_XML_ACK_BYTES,
  maxDepth: 32,
  maxNodeCount: 20_000,
  maxEntityExpansions: 0,
} as const;

/**
 * Caps on the message sent, sized to it: it is our own outbound body, so a cap must never hide its
 * control ID. An element takes at least four bytes and a text node one, so neither bound can be met
 * by a message of `bytes` bytes. Entities stay refused.
 */
function sentLimits(bytes: number): Record<keyof typeof LIMITS, number> {
  const bound = Math.max(bytes, 1) + 1;
  return { maxInputBytes: bound, maxDepth: bound, maxNodeCount: bound, maxEntityExpansions: 0 };
}

/**
 * What {@link xmlControlId} gives for a message sent that is XML but cannot be read: not
 * well-formed, not UTF-8, or with a document type declaration. Its acknowledgement cannot be matched
 * to it, so the delivery is retried, never settled unchecked.
 */
export const UNREADABLE = Symbol("unreadable");

let library: Promise<typeof Ccda> | undefined;

/** The XML reader, loaded on the first acknowledgement so start does not wait for it. */
const ccda = (): Promise<typeof Ccda> => (library ??= import("@cosyte/ccda"));

/** What an XML acknowledgement says: its `MSA.1` code and the `MSA.2` control ID it answers. */
export interface XmlAck {
  /** `MSA.1`, such as `AA`, or undefined when there is none. */
  readonly code: string | undefined;
  /** `MSA.2`, the control ID of the message it answers, or undefined when there is none. */
  readonly controlId: string | undefined;
}

/** Drops the reader's warnings: an acknowledgement is read for two fields, never judged. */
const ignore = (): void => undefined;

/** A DOM node as far as this reader uses one. */
interface Node {
  readonly localName: string | null;
  readonly textContent: string | null;
}

/** The child elements of `parent` whose local name is `name`, in any namespace. */
function all(library: typeof Ccda, parent: unknown, name: string): readonly Node[] {
  const elements = library.childElements(parent as Parameters<typeof Ccda.childElements>[0]);
  return (elements as readonly Node[]).filter((element) => element.localName === name);
}

/** The first child element of `parent` whose local name is `name`, in any namespace. */
function first(library: typeof Ccda, parent: unknown, name: string): Node | undefined {
  return all(library, parent, name)[0];
}

/** The trimmed text of `node`, or undefined when it has none. */
function textOf(node: Node | undefined): string | undefined {
  const value = node?.textContent?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Reads the one `<segment>` and its `<segment.field>` children under the root of an HL7 v2 XML
 * message, by local name, so the HL7 namespace (`urn:hl7-org:v2xml`) and no namespace read the same.
 * Undefined when the bytes are not well-formed XML, break a limit, are not UTF-8, or hold more than
 * one `<segment>` under the root, which cannot be read as one answer.
 */
async function fields(
  body: Uint8Array,
  segment: string,
  wanted: readonly string[],
  limits: Record<keyof typeof LIMITS, number>,
): Promise<(string | undefined)[] | undefined> {
  if (body.byteLength > limits.maxInputBytes) return undefined;
  let text: string;
  try {
    // The reader strips a byte order mark itself, and says so through `ignore`.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return undefined;
  }
  const reader = await ccda();
  let root: unknown;
  try {
    const document = reader.parseSecureXml(text, reader.resolveLimits(limits), ignore, ignore);
    root = document.documentElement;
  } catch {
    return undefined;
  }
  /* v8 ignore next: a well-formed document always has a root element */
  if (root === null || root === undefined) return undefined;
  const found = all(reader, root, segment);
  if (found.length > 1) return undefined;
  const [only] = found;
  if (only === undefined) return wanted.map(() => undefined);
  return wanted.map((field) => textOf(first(reader, only, `${segment}.${field}`)));
}

/**
 * Reads an HL7 v2 XML acknowledgement: its `MSA.1` code and its `MSA.2` control ID. Undefined when
 * the answer cannot be read as XML at all, or holds more than one `MSA` under its root.
 *
 * @example
 * ```ts
 * await readXmlAck(Buffer.from("<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>SYN-1</MSA.2></MSA></ACK>"));
 * // { code: "AA", controlId: "SYN-1" }
 * ```
 */
export async function readXmlAck(body: Uint8Array): Promise<XmlAck | undefined> {
  const read = await fields(body, "MSA", ["1", "2"], LIMITS);
  if (read === undefined) return undefined;
  const [code, controlId] = read;
  return { code, controlId };
}

/**
 * Whether `body` is meant as XML: after any whitespace or UTF-8 byte order mark, it opens with `<`,
 * or it opens with a UTF-16 byte order mark.
 */
function looksLikeXml(body: Uint8Array): boolean {
  if ((body[0] === 0xfe && body[1] === 0xff) || (body[0] === 0xff && body[1] === 0xfe)) return true;
  let at = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  while (at < body.byteLength && [0x20, 0x09, 0x0a, 0x0d].includes(body[at] as number)) at += 1;
  return body[at] === 0x3c;
}

/**
 * The control ID (`MSH.10`) of an HL7 v2 XML message, so its acknowledgement can be matched to it:
 * undefined when the body is not XML or is XML with no `MSH.10`, and {@link UNREADABLE} when it is
 * XML that cannot be read. The message is read under caps sized to it, never the acknowledgement's,
 * so a large result is checked like a small one.
 *
 * @example
 * ```ts
 * await xmlControlId(Buffer.from("<ORU_R01><MSH><MSH.10>SYN-1</MSH.10></MSH></ORU_R01>")); // "SYN-1"
 * ```
 */
export async function xmlControlId(
  body: Uint8Array,
): Promise<string | typeof UNREADABLE | undefined> {
  if (!looksLikeXml(body)) return undefined;
  const read = await fields(body, "MSH", ["10"], sentLimits(body.byteLength));
  return read === undefined ? UNREADABLE : read[0];
}

/**
 * Settles a delivery by its XML acknowledgement, following the public guide of the network this
 * mode was written for, which differs from an MLLP destination:
 *
 * - `AA` or `CA`: delivered (returns);
 * - `AE` or `CE`: a retryable error coded `ACK_AE` or `ACK_CE`, bounded by the destination's retry
 *   settings;
 * - `AR` or `CR`: a {@link DeliveryRejected} naming the code, so the delivery is marked failed;
 * - an answer that is not one acknowledgement or has no code we know: a retryable error coded
 *   `ACK_UNREADABLE`;
 * - an acknowledgement that answers another control ID than `sent`, or a `sent` of
 *   {@link UNREADABLE}: a retryable error coded `ACK_CONTROL_ID_MISMATCH`.
 *
 * `sent` is what {@link xmlControlId} read of the message sent: undefined when it has no control ID
 * to match, the only case the check is skipped.
 *
 * @example
 * ```ts
 * settleXmlAck({ code: "AR", controlId: "SYN-1" }, "SYN-1"); // throws DeliveryRejected("AR")
 * ```
 */
export function settleXmlAck(
  ack: XmlAck | undefined,
  sent: string | typeof UNREADABLE | undefined,
): void {
  const code = ack?.code;
  if (sent !== undefined && code !== undefined && ack?.controlId !== sent) {
    throw transientError("ACK_CONTROL_ID_MISMATCH");
  }
  switch (code) {
    case "AA":
    case "CA":
      return;
    case "AE":
    case "CE":
      throw transientError(`ACK_${code}`);
    case "AR":
    case "CR":
      throw new DeliveryRejected(code);
    case undefined:
    default:
      throw transientError("ACK_UNREADABLE");
  }
}
