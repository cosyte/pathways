// The metadata the engine sets for each message: `ctx.meta`, stored with the message when it is
// received, read by a transform and filled into an HTTP destination's URL or an email's subject. It
// is worked out from the message's own bytes, so the same message always gives the same metadata:
// at receipt, before its transform, on a replay and under `pathways test`. Only the MSH segment and
// the first PID segment are parsed, never the whole message, since receipt waits on it.

import { parseHL7 } from "@cosyte/hl7";

import type { Format } from "../config/schema.js";
import type { MessageMeta } from "../encryption/blind-index.js";

/**
 * The keys the engine sets in `ctx.meta`, in the order they are listed in the documentation. Each
 * is set only when the message's own field holds a value; a key the message lacks is left out.
 */
export const MESSAGE_META_KEYS = [
  "messageType",
  "messageCode",
  "triggerEvent",
  "controlId",
  "version",
  "processingId",
  "sendingApp",
  "sendingFacility",
  "receivingApp",
  "receivingFacility",
  "mrn",
] as const;

/** A key the engine sets in `ctx.meta`. */
export type MessageMetaKey = (typeof MESSAGE_META_KEYS)[number];

/**
 * The longest value the engine sets, in characters. A field longer than this is left out, as an
 * empty one is, so a sender cannot make every stored message carry a large copy of a field.
 */
export const MESSAGE_META_MAX_LENGTH = 200;

const CR = 0x0d;
const LF = 0x0a;

/**
 * The metadata the engine sets for a message of `format`: for an `hl7v2` message, the fields of
 * its MSH segment and the medical record number of its first PID segment, each only when it holds
 * a value of at most {@link MESSAGE_META_MAX_LENGTH} characters; for any other format, none. A
 * message whose MSH segment cannot be read has none, and one whose PID segment cannot be read has
 * no `mrn`. Never throws.
 *
 * @example
 * ```ts
 * const body = new TextEncoder().encode(
 *   "MSH|^~\\&|SYNTHAPP|SYNTHFAC|LAB|LABFAC|20260101000000||ADT^A01|SYN-0001|P|2.5\rPID|1||SYN-12345^^^SYN^MR",
 * );
 * messageMetaOf("hl7v2", body).mrn; // "SYN-12345"
 * ```
 */
export function messageMetaOf(format: Format, body: Uint8Array): MessageMeta {
  if (format !== "hl7v2") return {};
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const segments = firstSegments(bytes);
  if (segments === undefined) return {};
  const meta: Record<string, string> = {};
  let header;
  try {
    header = parseHL7(segments.msh).meta;
  } catch {
    return {};
  }
  set(meta, "messageType", header.type);
  set(meta, "messageCode", header.messageCode);
  set(meta, "triggerEvent", header.triggerEvent);
  set(meta, "controlId", header.controlId);
  set(meta, "version", header.version);
  set(meta, "processingId", header.processingId);
  set(meta, "sendingApp", header.sendingApp);
  set(meta, "sendingFacility", header.sendingFacility);
  set(meta, "receivingApp", header.receivingApp);
  set(meta, "receivingFacility", header.receivingFacility);
  if (segments.pid !== undefined) {
    try {
      const pair = Buffer.concat([segments.msh, Buffer.of(CR), segments.pid]);
      set(meta, "mrn", parseHL7(pair).patient?.mrn);
    } catch {
      // A PID segment that cannot be read leaves `mrn` out; the header's fields stand.
    }
  }
  return meta;
}

/** Sets `key` to `value` when it holds text, trimmed, within the length bound. */
function set(meta: Record<string, string>, key: MessageMetaKey, value: string | undefined): void {
  const text = value?.trim();
  if (text === undefined || text === "" || text.length > MESSAGE_META_MAX_LENGTH) return;
  meta[key] = text;
}

/**
 * The message's first segment, when it is an MSH, and its first PID segment, read by their first
 * bytes only: undefined when the message does not open with an MSH.
 */
function firstSegments(bytes: Buffer): { msh: Buffer; pid: Buffer | undefined } | undefined {
  let start = 0;
  while (start < bytes.length && isBreak(bytes[start])) start += 1;
  const end = lineEnd(bytes, start);
  const msh = bytes.subarray(start, end);
  if (msh.length < 4 || msh.toString("latin1", 0, 3) !== "MSH") return undefined;
  // MSH-1, the field separator, is the byte after "MSH".
  const separator = msh[3] as number;
  for (let at = end; at < bytes.length; at = lineEnd(bytes, at + 1)) {
    const from = at + 1;
    if (
      bytes[from] === 0x50 && // P
      bytes[from + 1] === 0x49 && // I
      bytes[from + 2] === 0x44 && // D
      bytes[from + 3] === separator
    ) {
      return { msh, pid: bytes.subarray(from, lineEnd(bytes, from)) };
    }
  }
  return { msh, pid: undefined };
}

/** Where the line starting at `from` ends: at its CR or LF, or at the end of the bytes. */
function lineEnd(bytes: Buffer, from: number): number {
  let at = from;
  while (at < bytes.length && !isBreak(bytes[at])) at += 1;
  return at;
}

function isBreak(byte: number | undefined): boolean {
  return byte === CR || byte === LF;
}
