import { createHash } from "node:crypto";

import { readMessages } from "@cosyte/hl7";

import { copiesBodies, release } from "../storage/ownership.js";
import type { JsonValue } from "../transform.js";
import type { MessageSink, ReceiveOptions } from "./types.js";

/**
 * Batch reading: one file or request body cut into pieces, each stored as a message of its own.
 * Every cut is made on bytes, never on decoded text, and each piece is the exact bytes it held in
 * the input: nothing is re-serialised. The input is read as it arrives, so only about one piece is
 * held at a time.
 */

/**
 * How a batch is cut:
 *
 * - `hl7`: into HL7 v2 messages, by `@cosyte/hl7`'s `readMessages`, which reads batch envelopes
 *   (FHS, BHS, BTS, FTS), bare messages one after another, and MLLP frames;
 * - `lines`: at each LF, a CR before it dropped, so one message per line;
 * - `delimiter`: at each run of the `delimiter` bytes.
 *
 * Empty pieces are passed over.
 */
export type BatchSplit = "hl7" | "lines" | "delimiter";

/**
 * What a file source does with an HL7 batch that lacks a trailer (BTS or FTS) or whose trailer's
 * count does not match: `hold` it for `holdForMs` from its claim, as one still being written, and
 * fail it after; `accept` it as it is; or `fail` it at once.
 */
export type BatchIncomplete = "hold" | "accept" | "fail";

/** A source's `batch:` setting, resolved. */
export interface BatchOptions {
  readonly split: BatchSplit;
  /** The bytes a `delimiter` batch is cut at; empty for the other kinds. */
  readonly delimiter?: Uint8Array | undefined;
  /** The largest file a file source reads as a batch, in bytes. Default: no limit. */
  readonly maxFileSize?: number | undefined;
  /** What an incomplete HL7 batch gets. Default `hold` for a file, `fail` for a request. */
  readonly onIncomplete?: BatchIncomplete | undefined;
  /** How long a file source holds an incomplete HL7 batch, from its claim. Default 5 minutes. */
  readonly holdForMs?: number | undefined;
}

export { DEFAULT_BATCH_HOLD_MS } from "../config/schema.js";

/**
 * The codes a batch is failed or held with, and a failed piece is stored with. Each is stable, and
 * none carries message text.
 *
 * - `BATCH_FILE_TOO_LARGE`: the file is larger than `maxFileSize`.
 * - `BATCH_EMPTY`: the file or body held no piece.
 * - `BATCH_INCOMPLETE`: an HL7 batch lacks a trailer, or a trailer's count does not match.
 * - `BATCH_KEY_REUSED`: a request's `Idempotency-Key` was used before for another body.
 */
export const BATCH_CODES = {
  tooLarge: "BATCH_FILE_TOO_LARGE",
  empty: "BATCH_EMPTY",
  incomplete: "BATCH_INCOMPLETE",
  keyReused: "BATCH_KEY_REUSED",
} as const;

/**
 * One piece of a batch: its place in the batch, from 0, and its bytes, in a buffer of its own. A
 * piece that could not be read (an HL7 message `@cosyte/hl7` fails to parse) carries no bytes and
 * the code it failed with, such as `NO_MSH_SEGMENT`.
 */
export interface Piece {
  readonly index: number;
  readonly body: Uint8Array;
  readonly failure?: string | undefined;
}

/**
 * What a whole batch came to, which a source hands to the sink's `batchDone`, and the engine
 * records in the audit log. Counts and codes only: never a file's name or message text.
 */
export interface BatchResult {
  /** The kind of source that read it. */
  readonly source: "file" | "http";
  /** `stored` once every piece is stored, or `failed` when the batch was set aside whole. */
  readonly outcome: "stored" | "failed";
  /** Why it was failed: one of {@link BATCH_CODES}. */
  readonly code?: string | undefined;
  /** The pieces handed to the sink. */
  readonly pieces: number;
  /** The pieces stored as new messages that are not failed. */
  readonly stored: number;
  /** The pieces stored as failed, with no content. */
  readonly failed: number;
  /** The pieces the store held already, from an earlier run or an earlier request with the key. */
  readonly duplicates: number;
  /** The envelope's warning codes, such as `BATCH_COUNT_MISMATCH`, each once. */
  readonly warnings: readonly string[];
}

/** Bytes as Node's `Buffer`, without a copy. */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A copy of `bytes` in a buffer of its own, so a stored piece holds nothing else of the input. */
function own(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

const LF = 0x0a;
const CR = 0x0d;
const VT = 0x0b;

/**
 * Cuts `chunks` at each `separator`, on bytes, and yields each piece between, in a buffer of its
 * own. With `dropCr`, a CR that ends a piece is dropped (a line's CR LF). Empty pieces are passed
 * over. Only the piece being read is held.
 */
async function* cutAt(
  chunks: AsyncIterable<Uint8Array>,
  separator: Uint8Array,
  dropCr: boolean,
): AsyncGenerator<Uint8Array> {
  const sep = asBuffer(separator);
  let carry: Buffer = Buffer.alloc(0);
  const finish = (piece: Buffer): Uint8Array | undefined => {
    let end = piece.byteLength;
    if (dropCr && end > 0 && piece[end - 1] === CR) end -= 1;
    return end === 0 ? undefined : own(piece.subarray(0, end));
  };
  for await (const chunk of chunks) {
    const buffer = carry.byteLength === 0 ? asBuffer(chunk) : Buffer.concat([carry, chunk]);
    // A separator that spans two chunks starts in the last bytes of the carry.
    let from = Math.max(0, carry.byteLength - (sep.byteLength - 1));
    let start = 0;
    for (;;) {
      const at = buffer.indexOf(sep, from);
      if (at === -1) break;
      const piece = finish(buffer.subarray(start, at));
      if (piece !== undefined) yield piece;
      start = at + sep.byteLength;
      from = start;
    }
    carry = Buffer.from(buffer.subarray(start));
  }
  const last = finish(carry);
  if (last !== undefined) yield last;
}

/**
 * The bytes of a stream from a moving start: what has passed through and not been taken yet. The
 * HL7 cut reads each message's place from `@cosyte/hl7` and takes its exact bytes from here.
 */
class ByteWindow {
  private parts: Buffer[] = [];
  /** The offset in the stream of the first byte held. */
  private base = 0;

  /** Holds the next chunk. */
  push(chunk: Uint8Array): void {
    this.parts.push(asBuffer(chunk));
  }

  /**
   * The `length` bytes at `offset` in the stream, in a buffer of their own; everything before their
   * end is let go.
   */
  take(offset: number, length: number): Uint8Array {
    this.drop(offset);
    const out = new Uint8Array(length);
    let filled = 0;
    for (const part of this.parts) {
      if (filled >= length) break;
      const piece = part.subarray(0, length - filled);
      out.set(piece, filled);
      filled += piece.byteLength;
    }
    this.drop(offset + length);
    return out;
  }

  /** Lets go of every byte before `offset`. */
  private drop(offset: number): void {
    while (this.base < offset && this.parts.length > 0) {
      const first = this.parts[0] as Buffer;
      const gap = offset - this.base;
      if (gap >= first.byteLength) {
        this.parts.shift();
        this.base += first.byteLength;
      } else {
        this.parts[0] = first.subarray(gap);
        this.base = offset;
      }
    }
  }
}

/** Each chunk of `chunks` as bytes, also pushed into `window` before it is handed on. */
async function* through(
  chunks: AsyncIterable<Uint8Array>,
  window: ByteWindow,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    window.push(chunk);
    yield chunk;
  }
}

/**
 * Cuts an HL7 v2 batch, file or feed into its messages with `@cosyte/hl7`'s `readMessages`, and
 * yields each message's own bytes, sliced from the input by the item's `byteOffset` and
 * `byteLength`. A message that fails to parse is yielded with its code and no bytes. Each item's
 * stream warnings (a last message cut off) go to `warnings` by code.
 */
async function* cutHl7(
  chunks: AsyncIterable<Uint8Array>,
  warnings: Set<string>,
): AsyncGenerator<{ readonly body: Uint8Array; readonly failure?: string }> {
  const window = new ByteWindow();
  for await (const item of readMessages(through(chunks, window))) {
    const body = window.take(item.byteOffset, item.byteLength);
    for (const warning of item.streamWarnings) warnings.add(warning.code);
    if (item.ok) yield { body };
    else yield { body: new Uint8Array(0), failure: item.error.code };
  }
}

/**
 * Cuts `chunks` into pieces as `options.split` says, numbering them from 0. Each piece is the bytes
 * it held in the input, in a buffer of its own. `warnings` collects the codes of what the cut found
 * wrong with the input as a whole, such as an HL7 message cut off at the end.
 *
 * @example
 * ```ts
 * for await (const piece of splitPieces(chunks, { split: "lines" })) await store(piece.body);
 * ```
 */
export async function* splitPieces(
  chunks: AsyncIterable<Uint8Array>,
  options: Pick<BatchOptions, "split" | "delimiter">,
  warnings: Set<string> = new Set(),
): AsyncGenerator<Piece> {
  let index = 0;
  if (options.split === "hl7") {
    for await (const piece of cutHl7(chunks, warnings)) {
      yield { index: index++, ...piece };
    }
    return;
  }
  const separator = options.split === "lines" ? Uint8Array.of(LF) : options.delimiter;
  /* v8 ignore next 3 -- the configuration refuses a delimiter cut without a delimiter */
  if (separator === undefined || separator.byteLength === 0) {
    throw new TypeError("a delimiter batch needs a delimiter of at least one byte");
  }
  for await (const body of cutAt(chunks, separator, options.split === "lines")) {
    yield { index: index++, body };
  }
}

/** The longest start of an envelope line kept, enough for its name and its first field. */
const ENVELOPE_HEAD = 256;

/**
 * Checks an HL7 batch's envelope as it streams by, as `@cosyte/hl7`'s `splitBatch` reconciles it:
 * a batch opened by BHS needs its BTS, a file opened by FHS its FTS, BTS-1 must count the messages
 * of its batch, and FTS-1 the batches of its file. Only the start of each envelope line is kept.
 * A file with no envelope is complete.
 *
 * @example
 * ```ts
 * const check = new EnvelopeCheck();
 * for await (const chunk of chunks) check.push(chunk);
 * check.end(); // [] when complete, or codes such as ["BATCH_MISSING_TRAILER"]
 * ```
 */
export class EnvelopeCheck {
  private readonly codes = new Set<string>();
  /** The start of the line being read, while it may be an envelope line. */
  private head: number[] = [];
  /** Whether the line being read has any byte yet, and whether it is all blank so far. */
  private started = false;
  private blank = true;
  private afterCr = false;
  private inMessage = false;
  private batchOpen = false;
  private pending = 0;
  private fileOpen = false;
  private batches = 0;

  /** Reads the next chunk. */
  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (byte === LF && this.afterCr) {
        // The LF of a CR LF: that line ended at its CR.
        this.afterCr = false;
        continue;
      }
      this.afterCr = byte === CR;
      if (byte === CR || byte === LF) {
        this.endLine();
        continue;
      }
      this.started = true;
      if (byte !== 0x20 && byte !== 0x09) this.blank = false;
      if (this.head.length < ENVELOPE_HEAD && !(byte === VT && this.head.length === 0)) {
        this.head.push(byte);
      }
    }
  }

  /** The input has ended: the warning codes found, each once. Empty when the batch is complete. */
  end(): readonly string[] {
    if (this.started) this.endLine();
    this.closeFile(undefined);
    return [...this.codes];
  }

  private endLine(): void {
    const head = this.head;
    const blank = !this.started || this.blank;
    this.head = [];
    this.started = false;
    this.blank = true;
    if (blank && !this.inMessage) return;
    const name = String.fromCharCode(...head.slice(0, 3));
    switch (name) {
      case "FHS":
        this.closeFile(undefined);
        this.fileOpen = true;
        return;
      case "FTS":
        this.closeFile(declared(head));
        return;
      case "BHS":
        this.finishBatch(undefined);
        this.batchOpen = true;
        return;
      case "BTS":
        this.finishBatch(declared(head));
        return;
      case "MSH":
        this.flushMessage();
        this.inMessage = true;
        return;
      default:
        // A segment of the message, or text before any MSH, which is a piece of its own.
        this.inMessage = true;
    }
  }

  private flushMessage(): void {
    if (!this.inMessage) return;
    this.inMessage = false;
    this.pending += 1;
  }

  /** Closes the run of messages since the last boundary; `count` is BTS-1 when a BTS closes it. */
  private finishBatch(count: number | "none" | undefined): void {
    this.flushMessage();
    if (count !== undefined) {
      if (this.pending > 0 || this.batchOpen) {
        if (typeof count === "number" && count !== this.pending) {
          this.codes.add("BATCH_COUNT_MISMATCH");
        }
        this.batches += 1;
      }
    } else if (this.batchOpen) {
      this.codes.add("BATCH_MISSING_TRAILER");
      this.batches += 1;
    }
    this.pending = 0;
    this.batchOpen = false;
  }

  /** Closes the file opened by FHS; `count` is FTS-1 when an FTS closes it. */
  private closeFile(count: number | "none" | undefined): void {
    this.finishBatch(undefined);
    if (count !== undefined) {
      if (typeof count === "number" && count !== this.batches) {
        this.codes.add("BATCH_COUNT_MISMATCH");
      }
    } else if (this.fileOpen) {
      this.codes.add("BATCH_MISSING_TRAILER");
    }
    this.fileOpen = false;
    this.batches = 0;
  }
}

/**
 * A trailer's first field as a count: a whole number, or `"none"` when the field is absent, blank or
 * not a number, which, as in `@cosyte/hl7`, checks nothing.
 */
function declared(head: readonly number[]): number | "none" {
  if (head.length < 4) return "none";
  const separator = head[3];
  let end = 4;
  while (end < head.length && head[end] !== separator) end += 1;
  const text = String.fromCharCode(...head.slice(4, end)).trim();
  if (!/^\d+$/.test(text)) return "none";
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : "none";
}

/** What a read of a whole batch found before any piece is stored. */
export interface BatchScan {
  /** The input's size in bytes, or how far it was read before it passed `maxFileSize`. */
  readonly size: number;
  /** The first 16 hexadecimal digits of the SHA-256 of its bytes. */
  readonly hash: string;
  /** Whether it is larger than `maxFileSize`; then `hash` is of the bytes read. */
  readonly tooLarge: boolean;
  /** For an HL7 batch, its envelope's warning codes; empty when it is complete. */
  readonly envelope: readonly string[];
}

/**
 * Reads a whole batch once, before any piece is stored: its size, the short hash its pieces' keys
 * carry, and, for an HL7 batch, whether its envelope is whole. Stops once it passes `maxFileSize`.
 * Holds one chunk at a time.
 *
 * @example
 * ```ts
 * const { hash, envelope } = await scanBatch(chunks, { split: "hl7" });
 * ```
 */
export async function scanBatch(
  chunks: AsyncIterable<Uint8Array>,
  options: Pick<BatchOptions, "split" | "maxFileSize">,
): Promise<BatchScan> {
  const hash = createHash("sha256");
  const check = options.split === "hl7" ? new EnvelopeCheck() : undefined;
  const max = options.maxFileSize ?? Infinity;
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > max) {
      return { size, hash: hash.digest("hex").slice(0, 16), tooLarge: true, envelope: [] };
    }
    hash.update(chunk);
    check?.push(chunk);
  }
  return {
    size,
    hash: hash.digest("hex").slice(0, 16),
    tooLarge: false,
    envelope: check?.end() ?? [],
  };
}

/**
 * The first `limit` bytes of `chunks`, so a file that grows after it was scanned is read as scanned.
 *
 * @example
 * ```ts
 * const pieces = splitPieces(upTo(chunks, scan.size), { split: "lines" });
 * ```
 */
export async function* upTo(
  chunks: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncGenerator<Uint8Array> {
  let left = limit;
  for await (const chunk of chunks) {
    if (left <= 0) return;
    const piece = chunk.byteLength > left ? chunk.subarray(0, left) : chunk;
    left -= piece.byteLength;
    yield piece;
  }
}

/**
 * One chunk, as an async iterable.
 *
 * @example
 * ```ts
 * const scan = await scanBatch(once(body), { split: "hl7" });
 * ```
 */
export async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield bytes;
}

/** What {@link receivePieces} counted, and the id of each piece in order. */
export interface PiecesReceived {
  readonly pieces: number;
  readonly stored: number;
  readonly failed: number;
  readonly duplicates: number;
  readonly ids: readonly number[];
}

/** How {@link receivePieces} hands each piece to the sink. */
export interface PieceHandOver {
  /** The idempotency key of the piece at `index`: the same each time the batch is read. */
  readonly key: (index: number) => string;
  /** Whether the batch may have been read before, so every piece is looked up first. */
  readonly resumed: boolean;
  /**
   * What names every batch sent under one name, such as a request's `Idempotency-Key`: handed in
   * as the first piece's `duplicateKey`, so {@link MessageSink.heldOrigin} finds which batch holds
   * it.
   */
  readonly origin?: string | undefined;
  /** What the transform reads in `ctx.source` for the piece at `index`. */
  readonly facts: (index: number) => Readonly<Record<string, JsonValue>>;
  /** Told of each piece's id once it is stored, in order. */
  readonly onStored?: (id: number) => void;
}

/**
 * Hands each piece to `sink`, in order, under its own idempotency key, and counts what came of
 * them. A piece that could not be read is stored as failed, with `batch: <code>` and no content,
 * and the pieces after it go on. Rejects, and stores nothing more, when the sink rejects: the
 * source keeps the batch, and the next read hands every piece in again with `resumed`.
 *
 * @example
 * ```ts
 * const counts = await receivePieces(splitPieces(chunks, { split: "lines" }), sink, handOver);
 * ```
 */
export async function receivePieces(
  pieces: AsyncIterable<Piece>,
  sink: MessageSink,
  handOver: PieceHandOver,
): Promise<PiecesReceived> {
  let stored = 0;
  let failed = 0;
  let duplicates = 0;
  const ids: number[] = [];
  for await (const piece of pieces) {
    const options: ReceiveOptions = {
      idempotencyKey: handOver.key(piece.index),
      resumed: handOver.resumed,
      ...(piece.index === 0 && handOver.origin !== undefined
        ? { duplicateKey: handOver.origin }
        : {}),
      ...(piece.failure === undefined
        ? { source: handOver.facts(piece.index) }
        : { failure: `batch: ${piece.failure}` }),
    };
    let id: number;
    let already = false;
    if (sink.receivePiece === undefined) {
      id = await sink.receive(piece.body, options);
    } else {
      ({ id, alreadyStored: already } = await sink.receivePiece(piece.body, options));
    }
    if (copiesBodies(sink)) release(piece.body);
    ids.push(id);
    handOver.onStored?.(id);
    if (already) duplicates += 1;
    else if (piece.failure === undefined) stored += 1;
    else failed += 1;
  }
  return { pieces: ids.length, stored, failed, duplicates, ids };
}
