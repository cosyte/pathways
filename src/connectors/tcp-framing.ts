import type { TcpFraming } from "../config/schema.js";

// How a tcp source or destination cuts a byte stream into messages, kept apart from the sockets so
// each framing can be tested byte by byte. Every framing is bounded: no frame grows past the size
// cap, and a length prefix that declares more is refused before a byte of the body is read.

/**
 * A framing with its bytes read from hex: what {@link FrameDecoder} and {@link encodeFrame} work
 * on.
 *
 * @example
 * ```ts
 * const lines = framingOf({ kind: "delimiter", delimiter: "0a" });
 * ```
 */
export type Framing =
  | { readonly kind: "raw" }
  | { readonly kind: "delimiter"; readonly delimiter: Buffer }
  | {
      readonly kind: "lengthPrefix";
      readonly size: 1 | 2 | 4;
      readonly endian: "big" | "little";
      readonly inclusive: boolean;
    }
  | { readonly kind: "startEnd"; readonly start: Buffer; readonly end: Buffer };

/**
 * A framing as the configuration resolves it, its bytes read from their hex.
 *
 * @example
 * ```ts
 * framingOf({ kind: "startEnd", start: "02", end: "03" }); // { kind: "startEnd", start: <02>, end: <03> }
 * ```
 */
export function framingOf(config: TcpFraming): Framing {
  switch (config.kind) {
    case "delimiter":
      return { kind: "delimiter", delimiter: Buffer.from(config.delimiter, "hex") };
    case "startEnd":
      return {
        kind: "startEnd",
        start: Buffer.from(config.start, "hex"),
        end: Buffer.from(config.end, "hex"),
      };
    case "raw":
    case "lengthPrefix":
      return config;
  }
}

/**
 * A body that cannot be framed: it holds the delimiter or the end bytes, so the receiver would cut
 * it short, or it is longer than the length prefix can say. `code` is stable and holds no content.
 *
 * @example
 * ```ts
 * throw new TcpFramingError("TCP_PAYLOAD_CONTAINS_DELIMITER");
 * ```
 */
export class TcpFramingError extends Error {
  /** `TCP_PAYLOAD_CONTAINS_DELIMITER`, `TCP_PAYLOAD_CONTAINS_END` or `TCP_PAYLOAD_TOO_LONG`. */
  readonly code: string;

  /** @param code A stable code. Never message content. */
  constructor(code: string) {
    super(`the body cannot be framed (${code})`);
    this.name = "TcpFramingError";
    this.code = code;
  }
}

/** The largest length each prefix size can hold. */
const PREFIX_MAX = { 1: 0xff, 2: 0xffff, 4: 0xffff_ffff } as const;

/**
 * `body` framed for the wire: followed by the delimiter, after its length, or between the start
 * and end bytes. Raw framing sends the body as it is, its end marked by closing the write side.
 *
 * @throws {TcpFramingError} when the body holds the delimiter or the end bytes, or is longer than
 *   the length prefix can say.
 * @example
 * ```ts
 * encodeFrame({ kind: "delimiter", delimiter: Buffer.from("0a", "hex") }, Buffer.from("A|B"));
 * ```
 */
export function encodeFrame(framing: Framing, body: Uint8Array): Buffer {
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  switch (framing.kind) {
    case "raw":
      return Buffer.from(bytes);
    case "delimiter":
      if (bytes.includes(framing.delimiter)) {
        throw new TcpFramingError("TCP_PAYLOAD_CONTAINS_DELIMITER");
      }
      return Buffer.concat([bytes, framing.delimiter]);
    case "startEnd":
      if (bytes.includes(framing.end)) throw new TcpFramingError("TCP_PAYLOAD_CONTAINS_END");
      return Buffer.concat([framing.start, bytes, framing.end]);
    case "lengthPrefix": {
      const { size, endian, inclusive } = framing;
      const length = bytes.length + (inclusive ? size : 0);
      if (length > PREFIX_MAX[size]) throw new TcpFramingError("TCP_PAYLOAD_TOO_LONG");
      const prefix = Buffer.alloc(size);
      prefix.writeUIntBE(length, 0, size);
      if (endian === "little") prefix.reverse();
      return Buffer.concat([prefix, bytes]);
    }
  }
}

/**
 * What a {@link FrameDecoder} found in the bytes it was given:
 *
 * - `frame`: one whole message, never empty;
 * - `empty`: a frame with nothing in it, which a source skips;
 * - `discarded`: bytes outside any frame (before a start sequence), dropped;
 * - `oversize`: a frame longer than the cap; the stream cannot be trusted past it;
 * - `bad-length`: an inclusive length prefix smaller than the prefix itself; as `oversize`.
 *
 * After `oversize` or `bad-length` the decoder takes nothing more.
 */
export type FrameEvent =
  | { readonly type: "frame"; readonly body: Buffer }
  | { readonly type: "empty" }
  | { readonly type: "discarded"; readonly bytes: number }
  | { readonly type: "oversize" }
  | { readonly type: "bad-length" };

/**
 * Cuts a byte stream into frames, however the bytes are split across reads: a frame split over
 * many reads comes out once whole, and many frames in one read come out one by one, in order. No
 * frame's body grows past `maxSize` bytes, and the bytes held while a frame is incomplete stay
 * within that, plus the framing's own few bytes.
 *
 * @example
 * ```ts
 * const decoder = new FrameDecoder({ kind: "delimiter", delimiter: Buffer.from("0a", "hex") }, 1_024);
 * decoder.push(Buffer.from("A|1\nA|")); // [{ type: "frame", body: <A|1> }]
 * decoder.push(Buffer.from("2\n")); // [{ type: "frame", body: <A|2> }]
 * ```
 */
export class FrameDecoder {
  private readonly framing: Framing;
  private readonly maxSize: number;
  private held: Buffer = Buffer.alloc(0);
  /** How far into `held` a search for the delimiter or end bytes has already looked. */
  private searched = 0;
  /** Start-end framing: whether the start bytes were seen, so `held` is a body. */
  private inside = false;
  private failed = false;

  /**
   * @param framing How frames are marked.
   * @param maxSize The most bytes a frame's body may hold.
   */
  constructor(framing: Framing, maxSize: number) {
    this.framing = framing;
    this.maxSize = maxSize;
  }

  /**
   * Whether part of a frame is held: bytes have come that no whole frame used yet. Start-end
   * framing holds bytes that may begin a start sequence without being inside a frame; those do not
   * count.
   */
  get midFrame(): boolean {
    if (this.framing.kind === "startEnd") return this.inside;
    return this.held.length > 0;
  }

  /** How many bytes of a part frame are held: 0 unless {@link midFrame}. */
  get pending(): number {
    return this.midFrame ? this.held.length : 0;
  }

  /** Takes the next bytes of the stream, and returns what they complete, in order. */
  push(chunk: Uint8Array): FrameEvent[] {
    if (this.failed) return [];
    this.held = this.held.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.held, chunk]);
    const events: FrameEvent[] = [];
    for (;;) {
      const event = this.next();
      if (event === undefined) break;
      events.push(event);
      if (event.type === "oversize" || event.type === "bad-length") {
        this.failed = true;
        this.held = Buffer.alloc(0);
        break;
      }
    }
    return events;
  }

  /**
   * The stream ended. Raw framing hands over what it holds as the one frame, unless it holds
   * nothing; any other framing
   * holds no frame at the end, so what it holds is a frame cut off, which `cut` counts.
   */
  end(): { readonly events: FrameEvent[]; readonly cut: number } {
    if (this.failed) return { events: [], cut: 0 };
    this.failed = true;
    const held = this.held;
    this.held = Buffer.alloc(0);
    if (this.framing.kind === "raw") {
      // A connection that sent nothing at all sent no message: a port check, say.
      return { events: held.length === 0 ? [] : [{ type: "frame", body: held }], cut: 0 };
    }
    if (this.framing.kind === "startEnd" && !this.inside) {
      return {
        events: held.length === 0 ? [] : [{ type: "discarded", bytes: held.length }],
        cut: 0,
      };
    }
    return { events: [], cut: held.length };
  }

  private next(): FrameEvent | undefined {
    switch (this.framing.kind) {
      case "raw":
        return this.held.length > this.maxSize ? { type: "oversize" } : undefined;
      case "delimiter":
        return this.untilMark(this.framing.delimiter);
      case "lengthPrefix":
        return this.prefixed(this.framing);
      case "startEnd":
        return this.inside ? this.untilMark(this.framing.end) : this.toStart(this.framing.start);
    }
  }

  /** A frame that ends at `mark`, or `undefined` while the mark has not come. */
  private untilMark(mark: Buffer): FrameEvent | undefined {
    // A mark split across reads starts at most mark.length - 1 bytes before what was searched.
    const from = Math.max(0, this.searched - mark.length + 1);
    const at = this.held.indexOf(mark, from);
    if (at === -1) {
      this.searched = this.held.length;
      // Bytes past the cap that cannot be the start of the mark make the frame too long already.
      return this.held.length - (mark.length - 1) > this.maxSize ? { type: "oversize" } : undefined;
    }
    if (at > this.maxSize) return { type: "oversize" };
    const body = this.held.subarray(0, at);
    this.take(at + mark.length);
    this.inside = false;
    return body.length === 0 ? { type: "empty" } : { type: "frame", body: Buffer.from(body) };
  }

  /** Start-end framing between frames: drops what comes before the start bytes. */
  private toStart(start: Buffer): FrameEvent | undefined {
    const at = this.held.indexOf(start);
    if (at === -1) {
      // Keep the bytes that may be the first part of a start sequence split across reads.
      const keep = Math.min(this.held.length, start.length - 1);
      const dropped = this.held.length - keep;
      if (dropped === 0) return undefined;
      this.take(dropped);
      return { type: "discarded", bytes: dropped };
    }
    if (at > 0) {
      this.take(at);
      return { type: "discarded", bytes: at };
    }
    this.take(start.length);
    this.inside = true;
    return this.next();
  }

  private prefixed(framing: Extract<Framing, { kind: "lengthPrefix" }>): FrameEvent | undefined {
    const { size, endian, inclusive } = framing;
    if (this.held.length < size) return undefined;
    const length = endian === "big" ? this.held.readUIntBE(0, size) : this.held.readUIntLE(0, size);
    if (inclusive && length < size) return { type: "bad-length" };
    const bodyLength = inclusive ? length - size : length;
    if (bodyLength > this.maxSize) return { type: "oversize" };
    if (this.held.length < size + bodyLength) return undefined;
    const body = Buffer.from(this.held.subarray(size, size + bodyLength));
    this.take(size + bodyLength);
    return body.length === 0 ? { type: "empty" } : { type: "frame", body };
  }

  /** Drops the first `count` bytes held. */
  private take(count: number): void {
    this.held = this.held.subarray(count);
    this.searched = 0;
  }
}
