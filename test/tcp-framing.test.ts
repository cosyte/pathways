import { describe, expect, it } from "vitest";

import {
  encodeFrame,
  FrameDecoder,
  framingOf,
  TcpFramingError,
  type FrameEvent,
  type Framing,
} from "../src/connectors/tcp-framing.js";

const hex = (text: string): Buffer => Buffer.from(text, "hex");
const text = (value: string): Buffer => Buffer.from(value, "latin1");

const LINES: Framing = { kind: "delimiter", delimiter: hex("0d0a") };
const STX_ETX: Framing = { kind: "startEnd", start: hex("02"), end: hex("03") };
const DOUBLE: Framing = { kind: "startEnd", start: hex("0b0b"), end: hex("1c0d") };
const PREFIX4: Framing = { kind: "lengthPrefix", size: 4, endian: "big", inclusive: false };
const RAW: Framing = { kind: "raw" };

/** The frames' bodies as text, and the other events as they are. */
function shown(events: readonly FrameEvent[]): unknown[] {
  return events.map((event) =>
    event.type === "frame" ? event.body.toString("latin1") : { ...event },
  );
}

/** Pushes `bytes` one at a time and returns every event, in order. */
function byteByByte(decoder: FrameDecoder, bytes: Buffer): FrameEvent[] {
  const events: FrameEvent[] = [];
  for (const byte of bytes) events.push(...decoder.push(Buffer.from([byte])));
  return events;
}

describe("framingOf", () => {
  it("reads the hex of a delimiter and of start and end bytes, and passes the rest as they are", () => {
    expect(framingOf({ kind: "delimiter", delimiter: "0d0a" })).toEqual(LINES);
    expect(framingOf({ kind: "startEnd", start: "0b0b", end: "1c0d" })).toEqual(DOUBLE);
    expect(framingOf({ kind: "raw" })).toEqual(RAW);
    const prefix = { kind: "lengthPrefix", size: 2, endian: "little", inclusive: true } as const;
    expect(framingOf(prefix)).toBe(prefix);
  });
});

describe("encodeFrame", () => {
  it("frames a body for each framing", () => {
    expect(encodeFrame(RAW, text("A|1"))).toEqual(text("A|1"));
    expect(encodeFrame(LINES, text("A|1"))).toEqual(text("A|1\r\n"));
    expect(encodeFrame(STX_ETX, text("A|1"))).toEqual(text("\x02A|1\x03"));
    expect(encodeFrame(PREFIX4, text("A|1"))).toEqual(Buffer.from([0, 0, 0, 3, 0x41, 0x7c, 0x31]));
    expect(
      encodeFrame({ kind: "lengthPrefix", size: 2, endian: "little", inclusive: true }, text("A")),
    ).toEqual(Buffer.from([3, 0, 0x41]));
    expect(
      encodeFrame({ kind: "lengthPrefix", size: 1, endian: "big", inclusive: false }, text("")),
    ).toEqual(Buffer.from([0]));
  });

  it("frames a view into a larger buffer by its own bytes only", () => {
    const whole = text("xxA|1yy");
    expect(encodeFrame(LINES, whole.subarray(2, 5))).toEqual(text("A|1\r\n"));
  });

  it("refuses a body that holds the delimiter or the end bytes", () => {
    const delimited = (): Buffer => encodeFrame(LINES, text("A\r\nB"));
    expect(delimited).toThrow(TcpFramingError);
    expect(delimited).toThrow(expect.objectContaining({ code: "TCP_PAYLOAD_CONTAINS_DELIMITER" }));
    // Only the whole delimiter counts: a lone CR is fine.
    expect(encodeFrame(LINES, text("A\rB"))).toEqual(text("A\rB\r\n"));
    expect(() => encodeFrame(STX_ETX, text("A\x03B"))).toThrow(
      expect.objectContaining({ code: "TCP_PAYLOAD_CONTAINS_END", name: "TcpFramingError" }),
    );
    // A start byte inside a body is sent as it is.
    expect(encodeFrame(STX_ETX, text("A\x02B"))).toEqual(text("\x02A\x02B\x03"));
  });

  it("refuses a body longer than the prefix can say, and takes one exactly as long", () => {
    const one = (inclusive: boolean): Framing => ({
      kind: "lengthPrefix",
      size: 1,
      endian: "big",
      inclusive,
    });
    expect(encodeFrame(one(false), Buffer.alloc(255))[0]).toBe(255);
    expect(() => encodeFrame(one(false), Buffer.alloc(256))).toThrow(
      expect.objectContaining({ code: "TCP_PAYLOAD_TOO_LONG" }),
    );
    expect(encodeFrame(one(true), Buffer.alloc(254))[0]).toBe(255);
    expect(() => encodeFrame(one(true), Buffer.alloc(255))).toThrow(
      expect.objectContaining({ code: "TCP_PAYLOAD_TOO_LONG" }),
    );
    const two: Framing = { kind: "lengthPrefix", size: 2, endian: "big", inclusive: false };
    expect(encodeFrame(two, Buffer.alloc(65_535)).subarray(0, 2)).toEqual(Buffer.from([255, 255]));
    expect(() => encodeFrame(two, Buffer.alloc(65_536))).toThrow(TcpFramingError);
  });

  it("says what is wrong in its message by code alone", () => {
    expect(new TcpFramingError("TCP_PAYLOAD_TOO_LONG").message).toBe(
      "the body cannot be framed (TCP_PAYLOAD_TOO_LONG)",
    );
  });
});

describe("FrameDecoder, delimiter framing", () => {
  it("cuts frames split across reads and frames that come together", () => {
    const decoder = new FrameDecoder(LINES, 64);
    expect(shown(decoder.push(text("A|1\r")))).toEqual([]);
    expect(decoder.midFrame).toBe(true);
    expect(decoder.pending).toBe(4);
    expect(shown(decoder.push(text("\nA|2\r\nA|")))).toEqual(["A|1", "A|2"]);
    expect(shown(decoder.push(text("3\r\n")))).toEqual(["A|3"]);
    expect(decoder.midFrame).toBe(false);
    expect(decoder.pending).toBe(0);
  });

  it("finds a delimiter split byte by byte", () => {
    const decoder = new FrameDecoder(LINES, 64);
    expect(shown(byteByByte(decoder, text("A|1\r\nB|22\r\n\r\n")))).toEqual([
      "A|1",
      "B|22",
      { type: "empty" },
    ]);
  });

  it("takes a frame of exactly the cap, and refuses one byte more", () => {
    expect(shown(new FrameDecoder(LINES, 3).push(text("abc\r\n")))).toEqual(["abc"]);
    expect(shown(byteByByte(new FrameDecoder(LINES, 3), text("abc\r\n")))).toEqual(["abc"]);
    // The last byte held may be the first byte of the delimiter, so it waits for the next.
    const waiting = new FrameDecoder(LINES, 3);
    expect(shown(waiting.push(text("abc\r")))).toEqual([]);
    expect(shown(waiting.push(text("\n")))).toEqual(["abc"]);
    expect(shown(new FrameDecoder(LINES, 3).push(text("abcd\r\n")))).toEqual([
      { type: "oversize" },
    ]);
    expect(shown(new FrameDecoder(LINES, 3).push(text("abcd")))).toEqual([]);
    expect(shown(new FrameDecoder(LINES, 3).push(text("abcde")))).toEqual([{ type: "oversize" }]);
  });

  it("takes nothing more after an oversize frame, and holds nothing", () => {
    const decoder = new FrameDecoder(LINES, 3);
    expect(shown(decoder.push(text("A|1\r\nabcdefg")))).toEqual(["A|1", { type: "oversize" }]);
    expect(decoder.midFrame).toBe(false);
    expect(decoder.push(text("\r\nB|2\r\n"))).toEqual([]);
    expect(decoder.end()).toEqual({ events: [], cut: 0 });
  });

  it("counts what a stream that ends mid-frame cut off", () => {
    const decoder = new FrameDecoder(LINES, 64);
    decoder.push(text("A|1\r\nA|2"));
    expect(decoder.end()).toEqual({ events: [], cut: 3 });
    // Ended: it takes nothing more.
    expect(decoder.push(text("\r\n"))).toEqual([]);
    expect(decoder.end()).toEqual({ events: [], cut: 0 });
  });

  it("ends cleanly between frames", () => {
    const decoder = new FrameDecoder(LINES, 64);
    decoder.push(text("A|1\r\n"));
    expect(decoder.end()).toEqual({ events: [], cut: 0 });
  });
});

describe("FrameDecoder, start and end framing", () => {
  it("cuts frames split across reads and frames that come together", () => {
    const decoder = new FrameDecoder(STX_ETX, 64);
    expect(shown(decoder.push(text("\x02A|1")))).toEqual([]);
    expect(decoder.midFrame).toBe(true);
    expect(shown(decoder.push(text("\x03\x02A|2\x03\x02")))).toEqual(["A|1", "A|2"]);
    expect(decoder.midFrame).toBe(true);
    expect(shown(decoder.push(text("A|3\x03")))).toEqual(["A|3"]);
    expect(decoder.midFrame).toBe(false);
  });

  it("finds start and end sequences of two bytes split byte by byte", () => {
    const decoder = new FrameDecoder(DOUBLE, 64);
    expect(shown(byteByByte(decoder, text("\x0b\x0bA|1\x1c\r\x0b\x0b\x1c\r")))).toEqual([
      "A|1",
      { type: "empty" },
    ]);
  });

  it("drops the bytes between frames, and keeps one that may begin a start sequence", () => {
    const decoder = new FrameDecoder(DOUBLE, 64);
    expect(shown(decoder.push(text("\r\nxy\x0b")))).toEqual([{ type: "discarded", bytes: 4 }]);
    expect(decoder.midFrame).toBe(false);
    expect(decoder.pending).toBe(0);
    expect(shown(decoder.push(text("\x0bA|1\x1c\r")))).toEqual(["A|1"]);
    expect(shown(decoder.push(text("zz\x0b\x0bB|2\x1c\r")))).toEqual([
      { type: "discarded", bytes: 2 },
      "B|2",
    ]);
    const single = new FrameDecoder(STX_ETX, 64);
    expect(shown(single.push(text("q")))).toEqual([{ type: "discarded", bytes: 1 }]);
    expect(shown(single.push(text("\x02")))).toEqual([]);
    expect(single.midFrame).toBe(true);
  });

  it("holds nothing while waiting for a start sequence that has not begun", () => {
    const decoder = new FrameDecoder(DOUBLE, 64);
    expect(decoder.push(text("\x0b"))).toEqual([]);
    expect(decoder.midFrame).toBe(false);
  });

  it("takes a frame of exactly the cap, and refuses one byte more", () => {
    expect(shown(new FrameDecoder(DOUBLE, 3).push(text("\x0b\x0babc\x1c\r")))).toEqual(["abc"]);
    expect(shown(new FrameDecoder(DOUBLE, 3).push(text("\x0b\x0babcd\x1c\r")))).toEqual([
      { type: "oversize" },
    ]);
    // The last byte held may be the first byte of the end sequence, so it waits for the next.
    expect(shown(new FrameDecoder(DOUBLE, 3).push(text("\x0b\x0babc\x1c")))).toEqual([]);
    expect(shown(new FrameDecoder(DOUBLE, 3).push(text("\x0b\x0babcde")))).toEqual([
      { type: "oversize" },
    ]);
  });

  it("counts a frame cut off at the end, and drops what came outside one", () => {
    const inside = new FrameDecoder(STX_ETX, 64);
    inside.push(text("\x02A|"));
    expect(inside.pending).toBe(2);
    expect(inside.end()).toEqual({ events: [], cut: 2 });
    const outside = new FrameDecoder(DOUBLE, 64);
    outside.push(text("\x0b"));
    expect(outside.end()).toEqual({ events: [{ type: "discarded", bytes: 1 }], cut: 0 });
    const nothing = new FrameDecoder(DOUBLE, 64);
    expect(nothing.end()).toEqual({ events: [], cut: 0 });
  });
});

describe("FrameDecoder, length-prefix framing", () => {
  it("cuts frames split across reads and frames that come together", () => {
    const decoder = new FrameDecoder(PREFIX4, 64);
    const one = encodeFrame(PREFIX4, text("A|1"));
    const two = encodeFrame(PREFIX4, text("B|22"));
    expect(shown(decoder.push(one.subarray(0, 2)))).toEqual([]);
    expect(decoder.midFrame).toBe(true);
    expect(shown(decoder.push(one.subarray(2, 5)))).toEqual([]);
    expect(shown(decoder.push(Buffer.concat([one.subarray(5), two, two.subarray(0, 1)])))).toEqual([
      "A|1",
      "B|22",
    ]);
    expect(shown(decoder.push(two.subarray(1)))).toEqual(["B|22"]);
    expect(shown(byteByByte(decoder, Buffer.concat([one, two])))).toEqual(["A|1", "B|22"]);
  });

  it("reads little-endian and inclusive lengths", () => {
    const little: Framing = { kind: "lengthPrefix", size: 2, endian: "little", inclusive: false };
    expect(shown(new FrameDecoder(little, 64).push(Buffer.from([2, 0, 0x41, 0x42])))).toEqual([
      "AB",
    ]);
    const inclusive: Framing = { kind: "lengthPrefix", size: 4, endian: "big", inclusive: true };
    expect(
      shown(new FrameDecoder(inclusive, 64).push(Buffer.from([0, 0, 0, 6, 0x41, 0x42]))),
    ).toEqual(["AB"]);
    const both: Framing = { kind: "lengthPrefix", size: 4, endian: "little", inclusive: true };
    expect(shown(new FrameDecoder(both, 64).push(Buffer.from([5, 0, 0, 0, 0x41])))).toEqual(["A"]);
  });

  it("reads a length of zero as an empty frame", () => {
    expect(shown(new FrameDecoder(PREFIX4, 64).push(Buffer.alloc(4)))).toEqual([{ type: "empty" }]);
    const inclusive: Framing = { kind: "lengthPrefix", size: 2, endian: "big", inclusive: true };
    expect(shown(new FrameDecoder(inclusive, 64).push(Buffer.from([0, 2])))).toEqual([
      { type: "empty" },
    ]);
  });

  it("refuses an inclusive length smaller than the prefix", () => {
    const inclusive: Framing = { kind: "lengthPrefix", size: 2, endian: "big", inclusive: true };
    const decoder = new FrameDecoder(inclusive, 64);
    expect(shown(decoder.push(Buffer.from([0, 1, 0x41])))).toEqual([{ type: "bad-length" }]);
    expect(decoder.push(Buffer.from([0, 3, 0x41]))).toEqual([]);
  });

  it("refuses a declared length past the cap before a byte of the body comes", () => {
    expect(shown(new FrameDecoder(PREFIX4, 3).push(Buffer.from([0, 0, 0, 3])))).toEqual([]);
    expect(shown(new FrameDecoder(PREFIX4, 3).push(Buffer.from([0, 0, 0, 4])))).toEqual([
      { type: "oversize" },
    ]);
    // The largest a 4-byte prefix can declare, refused at once rather than waited for.
    expect(shown(new FrameDecoder(PREFIX4, 3).push(Buffer.from([255, 255, 255, 255])))).toEqual([
      { type: "oversize" },
    ]);
  });

  it("counts a prefix or a body cut off at the end", () => {
    const prefix = new FrameDecoder(PREFIX4, 64);
    prefix.push(Buffer.from([0, 0]));
    expect(prefix.end()).toEqual({ events: [], cut: 2 });
    const body = new FrameDecoder(PREFIX4, 64);
    body.push(Buffer.from([0, 0, 0, 5, 0x41]));
    expect(body.end()).toEqual({ events: [], cut: 5 });
  });
});

describe("FrameDecoder, raw framing", () => {
  it("hands over everything up to the end as one frame, however it was split", () => {
    const decoder = new FrameDecoder(RAW, 64);
    expect(decoder.push(text("A|1\r\n"))).toEqual([]);
    expect(decoder.midFrame).toBe(true);
    expect(decoder.push(text("A|2"))).toEqual([]);
    expect(shown(decoder.end().events)).toEqual(["A|1\r\nA|2"]);
  });

  it("hands over nothing for a stream that sent nothing", () => {
    expect(new FrameDecoder(RAW, 64).end()).toEqual({ events: [], cut: 0 });
  });

  it("takes exactly the cap, and refuses one byte more", () => {
    const full = new FrameDecoder(RAW, 3);
    expect(full.push(text("abc"))).toEqual([]);
    expect(shown(full.end().events)).toEqual(["abc"]);
    const over = new FrameDecoder(RAW, 3);
    expect(over.push(text("ab"))).toEqual([]);
    expect(shown(over.push(text("cd")))).toEqual([{ type: "oversize" }]);
    expect(over.end()).toEqual({ events: [], cut: 0 });
  });
});
