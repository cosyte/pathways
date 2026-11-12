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

/** The first child element of `parent` whose local name is `name`, in any namespace. */
function first(library: typeof Ccda, parent: unknown, name: string): Node | undefined {
  const elements = library.childElements(parent as Parameters<typeof Ccda.childElements>[0]);
  return (elements as readonly Node[]).find((element) => element.localName === name);
}

/** The trimmed text of `node`, or undefined when it has none. */
function textOf(node: Node | undefined): string | undefined {
  const value = node?.textContent?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Reads `<segment>` and its `<segment.field>` children under the root of an HL7 v2 XML message, by
 * local name, so the HL7 namespace (`urn:hl7-org:v2xml`) and no namespace read the same. Undefined
 * when the bytes are not well-formed XML, break a limit, or are not UTF-8.
 */
async function fields(
  body: Uint8Array,
  segment: string,
  wanted: readonly string[],
): Promise<(string | undefined)[] | undefined> {
  if (body.byteLength > MAX_XML_ACK_BYTES) return undefined;
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
    const document = reader.parseSecureXml(text, reader.resolveLimits(LIMITS), ignore, ignore);
    root = document.documentElement;
  } catch {
    return undefined;
  }
  /* v8 ignore next: a well-formed document always has a root element */
  if (root === null || root === undefined) return undefined;
  const found = first(reader, root, segment);
  if (found === undefined) return wanted.map(() => undefined);
  return wanted.map((field) => textOf(first(reader, found, `${segment}.${field}`)));
}

/**
 * Reads an HL7 v2 XML acknowledgement: its `MSA.1` code and its `MSA.2` control ID. Undefined when
 * the answer cannot be read as XML at all.
 *
 * @example
 * ```ts
 * await readXmlAck(Buffer.from("<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>SYN-1</MSA.2></MSA></ACK>"));
 * // { code: "AA", controlId: "SYN-1" }
 * ```
 */
export async function readXmlAck(body: Uint8Array): Promise<XmlAck | undefined> {
  const read = await fields(body, "MSA", ["1", "2"]);
  if (read === undefined) return undefined;
  const [code, controlId] = read;
  return { code, controlId };
}

/**
 * The control ID (`MSH.10`) of an HL7 v2 XML message, or undefined when the body is not v2 XML or
 * carries none, so its acknowledgement can be matched to it.
 *
 * @example
 * ```ts
 * await xmlControlId(Buffer.from("<ORU_R01><MSH><MSH.10>SYN-1</MSH.10></MSH></ORU_R01>")); // "SYN-1"
 * ```
 */
export async function xmlControlId(body: Uint8Array): Promise<string | undefined> {
  return (await fields(body, "MSH", ["10"]))?.[0];
}

/**
 * Settles a delivery by its XML acknowledgement, the way an MLLP destination settles one by its ACK:
 *
 * - `AA` or `CA`: delivered (returns);
 * - `AE` or `CE`: a {@link DeliveryRejected} naming the code, so the delivery is marked failed;
 * - `AR` or `CR`: a retryable error coded `ACK_AR` or `ACK_CR`;
 * - an answer that is not an acknowledgement, has no code we know, or answers another control ID
 *   than `sent`: a retryable error coded `ACK_UNREADABLE` or `ACK_CONTROL_ID_MISMATCH`.
 *
 * `sent` is the control ID of the message sent, or undefined when it has none to match.
 *
 * @example
 * ```ts
 * settleXmlAck({ code: "AE", controlId: "SYN-1" }, "SYN-1"); // throws DeliveryRejected("AE")
 * ```
 */
export function settleXmlAck(ack: XmlAck | undefined, sent: string | undefined): void {
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
      throw new DeliveryRejected(code);
    case "AR":
    case "CR":
      throw transientError(`ACK_${code}`);
    case undefined:
    default:
      throw transientError("ACK_UNREADABLE");
  }
}
