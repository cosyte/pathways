// Reading an HL7 v2 acknowledgement written in the HL7 v2 XML encoding, the answer a web service
// that takes v2 XML sends back on the same HTTPS connection. Internal: the package entry exports none
// of it.
//
// The XML is read by @cosyte/ccda's hardened reader: no DOCTYPE, no entities, and caps on size,
// depth and element count. Only the acknowledgement code and the control ID it answers are taken;
// nothing of the answer's text reaches a log or an error.
//
// Each reader accepts one exact shape and nothing near it. An answer that also holds a second MSA, a
// second MSA.1 or MSA.2, a code with anything around it, or an element where text belongs, could say
// two things at once, so it is unreadable and retried, never settled by the first thing found.

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
 * What {@link xmlControlId} gives for a message sent that is XML the hardened reader refuses: not
 * well-formed, not UTF-8, or holding a document type declaration (even inside a CDATA section) or an
 * entity. Sending it again cannot change that, so the delivery fails at once.
 */
export const REFUSED = Symbol("refused");

/**
 * What {@link xmlControlId} gives for a message sent that is readable XML but not one HL7 v2 message
 * with one control ID: no `MSH` or more than one anywhere, or an `MSH` without exactly one `MSH.10`
 * holding text alone. No acknowledgement can be matched to it, and the same body goes on every
 * attempt, so a retry could only post it again: the delivery fails at once, never settled unchecked.
 */
export const MISFIT = Symbol("misfit");

/** The reason a delivery fails with when the message sent is XML the reader refuses. */
export const SENT_XML_UNREADABLE = "SENT_XML_UNREADABLE";

/**
 * The reason a delivery fails with when the message sent is readable XML but not one `MSH` with one
 * `MSH.10` ({@link MISFIT}): no `MSH`, a batch with several, or no control ID in its `MSH`.
 */
export const SENT_XML_NO_CONTROL_ID = "SENT_XML_NO_CONTROL_ID";

let library: Promise<typeof Ccda> | undefined;

/** The XML reader, loaded on the first acknowledgement so start does not wait for it. */
const ccda = (): Promise<typeof Ccda> => (library ??= import("@cosyte/ccda"));

/** An acknowledgement code: `MSA.1` as HL7 v2 defines it, original or enhanced mode. */
export type XmlAckCode = "AA" | "AE" | "AR" | "CA" | "CE" | "CR";

/** The codes an `MSA.1` may hold, written exactly so: no whitespace around, upper case. */
const CODES: ReadonlySet<string> = new Set<XmlAckCode>(["AA", "AE", "AR", "CA", "CE", "CR"]);

/** What an XML acknowledgement says: its `MSA.1` code and the `MSA.2` control ID it answers. */
export interface XmlAck {
  /** `MSA.1`, such as `AA`. */
  readonly code: XmlAckCode;
  /** `MSA.2`, the control ID of the message it answers, as written; undefined when there is none. */
  readonly controlId: string | undefined;
}

/** Drops the reader's warnings: an acknowledgement is read for two fields, never judged. */
const ignore = (): void => undefined;

/** A DOM node as far as this reader uses one. */
interface Node {
  readonly nodeType: number;
  readonly localName: string | null;
  readonly nodeValue: string | null;
  readonly parentNode: Node | null;
  readonly firstChild: Node | null;
  readonly nextSibling: Node | null;
}

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;

/**
 * The root element of `body` read as XML under `limits`, or undefined when the reader refuses it:
 * over a limit, not UTF-8, not well-formed, or with a document type declaration or an entity.
 */
async function rootOf(
  body: Uint8Array,
  limits: Record<keyof typeof LIMITS, number>,
): Promise<Node | undefined> {
  if (body.byteLength > limits.maxInputBytes) return undefined;
  let text: string;
  try {
    // The reader strips a byte order mark itself, and says so through `ignore`.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return undefined;
  }
  const reader = await ccda();
  try {
    const document = reader.parseSecureXml(text, reader.resolveLimits(limits), ignore, ignore);
    /* v8 ignore next: a well-formed document always has a root element */
    return (document.documentElement as Node | null) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every element under `root`, `root` too, whose local name is one of `names`, by name. Every depth
 * and every prefix or namespace counts alike. The walk keeps its own stack, never the call stack, so
 * a message nested as deep as its size allows is walked like a flat one.
 */
function elementsNamed(root: Node, names: readonly string[]): ReadonlyMap<string, readonly Node[]> {
  const found = new Map<string, Node[]>(names.map((name) => [name, []]));
  const stack: Node[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    // An element always has a local name.
    found.get(node.localName as string)?.push(node);
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === ELEMENT) stack.push(child);
    }
  }
  return found;
}

/** The elements named `name` in `found`, which holds every name it was asked for. */
const named = (found: ReadonlyMap<string, readonly Node[]>, name: string): readonly Node[] =>
  found.get(name) as readonly Node[];

/**
 * The one element in `elements` when there is exactly one and its parent is `parent`; undefined
 * for none, more than one, or one elsewhere.
 */
function onlyChild(elements: readonly Node[], parent: Node): Node | undefined {
  const [only] = elements;
  return elements.length === 1 && only?.parentNode === parent ? only : undefined;
}

/** The text of `element` when it holds text alone (text and CDATA, nothing else), as written. */
function textOnly(element: Node): string | undefined {
  let value = "";
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType !== TEXT && child.nodeType !== CDATA) return undefined;
    // A text or CDATA node always has a value.
    value += child.nodeValue as string;
  }
  return value;
}

/**
 * Reads an HL7 v2 XML acknowledgement: its `MSA.1` code and its `MSA.2` control ID. Every element is
 * matched by local name, so the HL7 namespace (`urn:hl7-org:v2xml`), a prefix and no namespace read
 * the same. One shape is read, and anything else is undefined (unreadable):
 *
 * - well-formed UTF-8 XML within the caps, with no document type declaration or entity;
 * - exactly one `MSA` in the whole document, a child of its root element;
 * - exactly one `MSA.1` in the whole document, a child of that `MSA`, holding text alone, and that
 *   text exactly one of `AA`, `AE`, `AR`, `CA`, `CE` or `CR` (no whitespace, upper case);
 * - at most one `MSA.2` in the whole document, a child of that `MSA`, holding text alone;
 * - at most one `MSH` in the whole document.
 *
 * @example
 * ```ts
 * await readXmlAck(Buffer.from("<ACK><MSA><MSA.1>AA</MSA.1><MSA.2>SYN-1</MSA.2></MSA></ACK>"));
 * // { code: "AA", controlId: "SYN-1" }
 * ```
 */
export async function readXmlAck(body: Uint8Array): Promise<XmlAck | undefined> {
  const root = await rootOf(body, LIMITS);
  if (root === undefined) return undefined;
  const found = elementsNamed(root, ["MSA", "MSA.1", "MSA.2", "MSH"]);
  if (named(found, "MSH").length > 1) return undefined;
  const msa = onlyChild(named(found, "MSA"), root);
  if (msa === undefined) return undefined;
  const codeElement = onlyChild(named(found, "MSA.1"), msa);
  const code = codeElement === undefined ? undefined : textOnly(codeElement);
  if (code === undefined || !CODES.has(code)) return undefined;
  const answers = named(found, "MSA.2");
  if (answers.length === 0) return { code: code as XmlAckCode, controlId: undefined };
  const answerElement = onlyChild(answers, msa);
  const controlId = answerElement === undefined ? undefined : textOnly(answerElement);
  if (controlId === undefined) return undefined;
  return { code: code as XmlAckCode, controlId };
}

/**
 * Whether `body` is meant as XML: after any XML whitespace (space, tab, line feed, carriage return)
 * or UTF-8 byte order mark, it opens with `<`, or it opens with a UTF-16 byte order mark.
 */
function looksLikeXml(body: Uint8Array): boolean {
  if ((body[0] === 0xfe && body[1] === 0xff) || (body[0] === 0xff && body[1] === 0xfe)) return true;
  let at = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  while (at < body.byteLength && [0x20, 0x09, 0x0a, 0x0d].includes(body[at] as number)) at += 1;
  return body[at] === 0x3c;
}

/**
 * The control ID (`MSH.10`) of an HL7 v2 XML message, so its acknowledgement can be matched to it.
 * Undefined only when the body is not XML at all (it does not open with `<`), {@link REFUSED} when it
 * is XML the hardened reader refuses, and {@link MISFIT} when it is readable XML that does not hold
 * exactly one `MSH`, anywhere, with exactly one non-empty `MSH.10` child holding text alone. The
 * message is read under caps sized to it, never the acknowledgement's, so a large result is checked
 * like a small one.
 *
 * @example
 * ```ts
 * await xmlControlId(Buffer.from("<ORU_R01><MSH><MSH.10>SYN-1</MSH.10></MSH></ORU_R01>")); // "SYN-1"
 * ```
 */
export async function xmlControlId(
  body: Uint8Array,
): Promise<string | typeof REFUSED | typeof MISFIT | undefined> {
  if (!looksLikeXml(body)) return undefined;
  const root = await rootOf(body, sentLimits(body.byteLength));
  if (root === undefined) return REFUSED;
  const found = elementsNamed(root, ["MSH", "MSH.10"]);
  const [msh] = named(found, "MSH");
  if (msh === undefined || named(found, "MSH").length > 1) return MISFIT;
  const field = onlyChild(named(found, "MSH.10"), msh);
  const controlId = field === undefined ? undefined : textOnly(field);
  return controlId === undefined || controlId === "" ? MISFIT : controlId;
}

/**
 * Settles a delivery by its XML acknowledgement, following the public guide of the network this
 * mode was written for, which differs from an MLLP destination:
 *
 * - `AA` or `CA`: delivered (returns);
 * - `AE` or `CE`: a retryable error coded `ACK_AE` or `ACK_CE`, bounded by the destination's retry
 *   settings;
 * - `AR` or `CR`: a {@link DeliveryRejected} naming the code, so the delivery is marked failed;
 * - an answer {@link readXmlAck} could not read (undefined): a retryable error coded
 *   `ACK_UNREADABLE`;
 * - an acknowledgement that answers another control ID than `sent`: a retryable error coded
 *   `ACK_CONTROL_ID_MISMATCH`.
 *
 * `sent` is what {@link xmlControlId} read of the message sent: undefined when it is not XML at all,
 * the only case the check is skipped. A message sent that is {@link REFUSED} or {@link MISFIT} is
 * never posted, so it never comes here.
 *
 * @example
 * ```ts
 * settleXmlAck({ code: "AR", controlId: "SYN-1" }, "SYN-1"); // throws DeliveryRejected("AR")
 * ```
 */
export function settleXmlAck(ack: XmlAck | undefined, sent: string | undefined): void {
  if (ack === undefined) throw transientError("ACK_UNREADABLE");
  if (sent !== undefined && ack.controlId !== sent) {
    throw transientError("ACK_CONTROL_ID_MISMATCH");
  }
  switch (ack.code) {
    case "AA":
    case "CA":
      return;
    case "AE":
    case "CE":
      throw transientError(`ACK_${ack.code}`);
    case "AR":
    case "CR":
      throw new DeliveryRejected(ack.code);
  }
}
