import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { encodeFrame, type Framing } from "../src/connectors/tcp-framing.js";
import {
  DEFAULT_TCP_MAX_CONNECTIONS,
  TcpSource,
  type TcpEvent,
  type TcpSourceOptions,
} from "../src/connectors/tcp.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { OPENSSL, TLS_TESTS } from "./mllp-helpers.js";
import { makeCertificates, removeCertificates, type Certificates } from "./net-helpers.js";

const sources: TcpSource[] = [];

afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop()));
});

const hex = (text: string): Buffer => Buffer.from(text, "hex");
const text = (value: string): Buffer => Buffer.from(value, "latin1");

/** Synthetic order lines: no real patient, no real identifier. */
const ORDER = (n: number): string => `ORDER|SYNTH-${String(n).padStart(4, "0")}|TEST PANEL`;

interface Received {
  readonly body: string;
  readonly options: ReceiveOptions | undefined;
}

/** A sink that records what it is given; `behave` can delay or fail each call. */
function recordingSink(behave?: (index: number) => Promise<void>): {
  sink: MessageSink;
  received: Received[];
  calls: () => number;
} {
  const received: Received[] = [];
  let calls = 0;
  return {
    received,
    calls: () => calls,
    sink: {
      receive: async (body, options) => {
        const index = calls;
        calls += 1;
        await behave?.(index);
        received.push({ body: Buffer.from(body).toString("latin1"), options });
        return 100 + received.length;
      },
    },
  };
}

const LINES: Framing = { kind: "delimiter", delimiter: hex("0a") };

async function startSource(
  sink: MessageSink,
  options: Partial<TcpSourceOptions> = {},
): Promise<{ source: TcpSource; port: number; events: TcpEvent[] }> {
  const events: TcpEvent[] = [];
  const source = new TcpSource({
    host: "127.0.0.1",
    port: 0,
    tls: undefined,
    framing: LINES,
    maxMessageSize: 1_024,
    idleTimeoutMs: 5_000,
    stallTimeoutMs: 5_000,
    onEvent: (event) => events.push(event),
    ...options,
  });
  sources.push(source);
  await source.start(sink);
  return { source, port: source.port ?? 0, events };
}

/** What a sender saw on one connection. */
interface Talk {
  readonly received: Buffer;
  /** Whether the source closed the connection before the sender gave up. */
  readonly closed: boolean;
}

/** A pause between writes, in milliseconds. */
type Step = Buffer | number;

interface TalkOptions {
  /** Close the write side after the last step. */
  readonly end?: boolean;
  /** Reset the connection after the last step, as a sender that crashed. */
  readonly reset?: boolean;
  /** Stop once this much has come back. */
  readonly until?: (received: Buffer) => boolean;
  readonly waitMs?: number;
  readonly tls?: { readonly ca: Buffer; readonly cert?: Buffer; readonly key?: Buffer };
}

/** Opens one connection, writes each step in turn, and collects what comes back. */
function talk(port: number, steps: readonly Step[], options: TalkOptions = {}): Promise<Talk> {
  const { end = false, reset = false, until, waitMs = 3_000, tls } = options;
  const socket: Socket =
    tls === undefined
      ? netConnect({ host: "127.0.0.1", port, allowHalfOpen: true })
      : tlsConnect({ host: "127.0.0.1", port, servername: "localhost", ...tls });
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    let closed = false;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ received: Buffer.concat(chunks), closed });
    };
    const timer = setTimeout(finish, waitMs);
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (until?.(Buffer.concat(chunks)) === true) finish();
    });
    socket.on("error", () => undefined);
    // Half-open, the source's end of its side is the close a sender sees.
    for (const event of ["end", "close"]) {
      socket.on(event, () => {
        closed = true;
        finish();
      });
    }
    socket.once(tls === undefined ? "connect" : "secureConnect", () => {
      void (async () => {
        for (const step of steps) {
          if (typeof step === "number") await sleep(step);
          else if (!socket.destroyed) socket.write(step);
        }
        if (reset) socket.resetAndDestroy();
        else if (end) socket.end();
      })();
    });
  });
}

/** Waits until `check` holds, or fails after a while. */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const by = Date.now() + ms;
  while (!check()) {
    if (Date.now() > by) throw new Error("timed out waiting");
    await sleep(10);
  }
}

const named = (events: readonly TcpEvent[], name: string): TcpEvent[] =>
  events.filter((event) => event.event === name);

/** Each framing but raw, with what one of its frames looks like. */
const FRAMED: readonly { readonly name: string; readonly framing: Framing }[] = [
  { name: "delimiter", framing: { kind: "delimiter", delimiter: hex("0d0a") } },
  { name: "start and end", framing: { kind: "startEnd", start: hex("0b"), end: hex("1c0d") } },
  {
    name: "length prefix",
    framing: { kind: "lengthPrefix", size: 2, endian: "little", inclusive: true },
  },
];

describe.each(FRAMED)("TcpSource with $name framing, over real sockets", ({ framing }) => {
  const frame = (body: string): Buffer => encodeFrame(framing, text(body));
  // Seven bytes of a frame, as the source counts them: start bytes open a frame and are not held.
  const cut = framing.kind === "startEnd" ? 7 - framing.start.length : 7;

  it("stores one message split over many segments once it is whole", async () => {
    const { sink, received } = recordingSink();
    const { port } = await startSource(sink, { framing });
    const whole = frame(ORDER(1));
    const steps: Step[] = [];
    for (let at = 0; at < whole.length; at += 5) steps.push(whole.subarray(at, at + 5), 5);
    await talk(port, steps, { waitMs: 200 + whole.length * 5 });
    expect(received).toEqual([
      { body: ORDER(1), options: { source: { remoteAddress: "127.0.0.1" } } },
    ]);
  });

  it("stores each of many messages that come in one segment, in order", async () => {
    const { sink, received } = recordingSink();
    const { port } = await startSource(sink, { framing });
    await talk(port, [Buffer.concat([1, 2, 3].map((n) => frame(ORDER(n))))], { waitMs: 300 });
    expect(received.map((r) => r.body)).toEqual([ORDER(1), ORDER(2), ORDER(3)]);
  });

  it("closes on a frame past maxMessageSize, after storing the ones before it, and stores nothing of it", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing, maxMessageSize: ORDER(1).length });
    const result = await talk(port, [Buffer.concat([frame(ORDER(1)), frame(`${ORDER(2)}X`)])]);
    expect(result.closed).toBe(true);
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(named(events, "tcp-oversize")).toEqual([
      { level: "warn", event: "tcp-oversize", maxMessageSize: ORDER(1).length },
    ]);
  });

  it("closes a connection whose frame stalls, and stores nothing of it", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing, stallTimeoutMs: 150 });
    const half = frame(ORDER(2));
    const result = await talk(port, [frame(ORDER(1)), half.subarray(0, 6)]);
    expect(result.closed).toBe(true);
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(named(events, "tcp-stalled")).toEqual([{ level: "warn", event: "tcp-stalled" }]);
    expect(named(events, "tcp-idle")).toEqual([]);
    // The part frame is the stall's to report, not a second time when the connection closes.
    expect(named(events, "tcp-partial-frame")).toEqual([]);
  });

  it("skips an empty frame, storing nothing for it, and goes on", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing });
    await talk(port, [Buffer.concat([frame(""), frame(ORDER(1))])], { waitMs: 300 });
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(named(events, "tcp-empty-frame")).toEqual([{ level: "info", event: "tcp-empty-frame" }]);
  });

  it("drops a frame cut off when the sender closes mid-frame, counting its bytes", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing });
    const result = await talk(port, [frame(ORDER(1)), frame(ORDER(2)).subarray(0, 7)], {
      end: true,
    });
    expect(result.closed).toBe(true);
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(named(events, "tcp-partial-frame")).toEqual([
      { level: "warn", event: "tcp-partial-frame", bytes: cut },
    ]);
  });

  it("drops a frame cut off when the connection resets mid-frame, counting its bytes", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing });
    await talk(port, [frame(ORDER(1)), frame(ORDER(2)).subarray(0, 7), 100], { reset: true });
    await until(() => named(events, "tcp-partial-frame").length > 0);
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(named(events, "tcp-partial-frame")).toEqual([
      { level: "warn", event: "tcp-partial-frame", bytes: cut },
    ]);
    expect(named(events, "tcp-connection-error")).toEqual([
      { level: "info", event: "tcp-connection-error", code: "ECONNRESET" },
    ]);
  });

  it("stores every whole frame that came before the sender reset, however slow the store", async () => {
    const { sink, received } = recordingSink(() => sleep(200));
    const { port, events } = await startSource(sink, { framing });
    await talk(port, [Buffer.concat([1, 2, 3].map((n) => frame(ORDER(n)))), 50], { reset: true });
    await until(() => received.length === 3, 5_000);
    expect(received.map((r) => r.body)).toEqual([ORDER(1), ORDER(2), ORDER(3)]);
    expect(named(events, "tcp-connection-error")).toEqual([
      { level: "info", event: "tcp-connection-error", code: "ECONNRESET" },
    ]);
    expect(named(events, "tcp-frames-dropped")).toEqual([]);
    expect(named(events, "tcp-partial-frame")).toEqual([]);
  });

  it("answers each stored message with the reply, framed as messages are", async () => {
    const { sink, received } = recordingSink();
    const { port } = await startSource(sink, { framing, reply: text("ACK") });
    const reply = frame("ACK");
    const result = await talk(port, [Buffer.concat([frame(ORDER(1)), frame(ORDER(2))])], {
      until: (got) => got.length >= 2 * reply.length,
    });
    expect(result.received).toEqual(Buffer.concat([reply, reply]));
    expect(received).toHaveLength(2);
  });
});

describe("TcpSource with raw framing, over real sockets", () => {
  const RAW: Framing = { kind: "raw" };

  it("stores every byte up to the sender's close as one message, however it was split", async () => {
    const { sink, received } = recordingSink();
    const { port } = await startSource(sink, { framing: RAW });
    const body = `${ORDER(1)}\n${ORDER(2)}\n`;
    const result = await talk(port, [text(body.slice(0, 9)), 20, text(body.slice(9)), 20], {
      end: true,
    });
    expect(result.closed).toBe(true);
    expect(received).toEqual([{ body, options: { source: { remoteAddress: "127.0.0.1" } } }]);
  });

  it("sends the reply on its own side after the sender closed its side, then closes", async () => {
    const order: string[] = [];
    const { sink } = recordingSink(async () => {
      await sleep(50);
      order.push("stored");
    });
    const { port } = await startSource(sink, {
      framing: RAW,
      reply: ({ messageId }) => {
        order.push("built");
        return `OK ${String(messageId)}`;
      },
    });
    const result = await talk(port, [text(ORDER(1))], { end: true });
    expect(result).toEqual({ received: text("OK 101"), closed: true });
    expect(order).toEqual(["stored", "built"]);
  });

  it("closes past maxMessageSize, storing nothing", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing: RAW, maxMessageSize: 8 });
    const result = await talk(port, [text("ORDER|SY"), 20, text("N")]);
    expect(result.closed).toBe(true);
    expect(received).toEqual([]);
    expect(named(events, "tcp-oversize")).toHaveLength(1);
  });

  it("closes a connection that stops sending before it closes its side, storing nothing", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing: RAW, stallTimeoutMs: 150 });
    const result = await talk(port, [text(ORDER(1))]);
    expect(result.closed).toBe(true);
    expect(received).toEqual([]);
    expect(named(events, "tcp-stalled")).toHaveLength(1);
  });

  it("stores nothing for a connection that sends nothing before it closes", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing: RAW });
    const result = await talk(port, [], { end: true });
    expect(result.closed).toBe(true);
    expect(received).toEqual([]);
    expect(events.map((event) => event.event)).toEqual(["tcp-listening"]);
  });

  it("drops what came on a connection that resets before it closes its side", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing: RAW });
    await talk(port, [text(ORDER(1)), 100], { reset: true });
    await until(() => named(events, "tcp-partial-frame").length > 0);
    expect(received).toEqual([]);
    expect(named(events, "tcp-partial-frame")).toEqual([
      { level: "warn", event: "tcp-partial-frame", bytes: ORDER(1).length },
    ]);
  });
});

describe("TcpSource", () => {
  it("reports where it listens, and forgets the port once stopped", async () => {
    const { sink } = recordingSink();
    const { source, port, events } = await startSource(sink);
    expect(port).toBeGreaterThan(0);
    expect(events).toEqual([{ level: "info", event: "tcp-listening", port, tls: false }]);
    await source.stop();
    expect(source.port).toBeUndefined();
    // Stopping again does nothing.
    await source.stop();
  });

  it("rejects start when the port is taken", async () => {
    const taken = createNetServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const address = taken.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const source = new TcpSource({
        host: "127.0.0.1",
        port,
        tls: undefined,
        framing: LINES,
        maxMessageSize: 64,
        idleTimeoutMs: 1_000,
        stallTimeoutMs: 1_000,
      });
      await expect(source.start(recordingSink().sink)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      expect(source.port).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });

  it("stores before it replies, and answers in order on one connection", async () => {
    const order: string[] = [];
    const { sink } = recordingSink(async (index) => {
      order.push(`storing ${String(index)}`);
      await sleep(index === 0 ? 80 : 0);
      order.push(`stored ${String(index)}`);
    });
    const { port } = await startSource(sink, {
      reply: async ({ messageId }) => {
        order.push(`reply ${String(messageId)}`);
        await Promise.resolve();
        return text(`OK ${String(messageId)}`);
      },
    });
    const result = await talk(port, [text(`${ORDER(1)}\n${ORDER(2)}\n`)], {
      until: (got) => got.toString("latin1").split("\n").length > 2,
    });
    expect(result.received.toString("latin1")).toBe("OK 101\nOK 102\n");
    expect(order).toEqual([
      "storing 0",
      "stored 0",
      "reply 101",
      "storing 1",
      "stored 1",
      "reply 102",
    ]);
  });

  it("sends no reply when none is set", async () => {
    const { sink, received } = recordingSink();
    const { port } = await startSource(sink);
    const result = await talk(port, [text(`${ORDER(1)}\n`)], { waitMs: 300 });
    expect(result).toEqual({ received: Buffer.alloc(0), closed: false });
    expect(received).toHaveLength(1);
  });

  it("closes without a reply when a message cannot be stored, and stores nothing queued behind it", async () => {
    const { sink, calls } = recordingSink(() => Promise.reject(new Error("synthetic disk full")));
    const { port, events } = await startSource(sink, { reply: text("ACK") });
    const result = await talk(port, [text(`${ORDER(1)}\n${ORDER(2)}\n`)]);
    expect(result).toEqual({ received: Buffer.alloc(0), closed: true });
    expect(calls()).toBe(1);
    expect(named(events, "tcp-store-failed")).toEqual([
      { level: "warn", event: "tcp-store-failed", name: "Error", code: undefined },
    ]);
    // The second message was whole but never stored: the log counts it, so the loss is seen.
    expect(named(events, "tcp-frames-dropped")).toEqual([
      { level: "warn", event: "tcp-frames-dropped", count: 1 },
    ]);
    expect(JSON.stringify(events)).not.toContain("synthetic");
  });

  it("closes without a reply when the builder throws, the message already stored", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, {
      reply: () => {
        throw new RangeError("synthetic builder fault");
      },
    });
    const result = await talk(port, [text(`${ORDER(1)}\n`)]);
    expect(result).toEqual({ received: Buffer.alloc(0), closed: true });
    expect(received).toHaveLength(1);
    expect(named(events, "tcp-reply-failed")).toEqual([
      { level: "warn", event: "tcp-reply-failed", message: 101, name: "RangeError" },
    ]);
    expect(JSON.stringify(events)).not.toContain("synthetic");
  });

  it("refuses a reply that is neither bytes nor a string", async () => {
    const { sink } = recordingSink();
    const { port, events } = await startSource(sink, {
      reply: (() => 42) as unknown as () => string,
    });
    const result = await talk(port, [text(`${ORDER(1)}\n`)]);
    expect(result.closed).toBe(true);
    expect(named(events, "tcp-reply-failed")).toEqual([
      { level: "warn", event: "tcp-reply-failed", message: 101, name: "TypeError" },
    ]);
  });

  it("closes without a reply when the reply cannot be framed", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { reply: () => "OK\nmore" });
    const result = await talk(port, [text(`${ORDER(1)}\n`)]);
    expect(result).toEqual({ received: Buffer.alloc(0), closed: true });
    expect(received).toHaveLength(1);
    expect(named(events, "tcp-reply-unsendable")).toEqual([
      {
        level: "warn",
        event: "tcp-reply-unsendable",
        message: 101,
        code: "TCP_PAYLOAD_CONTAINS_DELIMITER",
      },
    ]);
  });

  it("closes a connection idle past idleTimeout", async () => {
    const { sink } = recordingSink();
    const { port, events } = await startSource(sink, { idleTimeoutMs: 100 });
    const started = Date.now();
    const result = await talk(port, []);
    expect(result.closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(named(events, "tcp-idle")).toEqual([{ level: "info", event: "tcp-idle" }]);
  });

  it("counts a connection busy storing as not idle, and idles it out once it is done", async () => {
    const { sink, received } = recordingSink(() => sleep(300));
    const { port, events } = await startSource(sink, { idleTimeoutMs: 100, reply: text("ACK") });
    const result = await talk(port, [text(`${ORDER(1)}\n`)]);
    expect(result).toEqual({ received: text("ACK\n"), closed: true });
    expect(received).toHaveLength(1);
    expect(named(events, "tcp-idle")).toHaveLength(1);
  });

  it("on stop, lets a message being stored finish and be answered, and takes no more", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink, received, calls } = recordingSink(() => held);
    const { source, port } = await startSource(sink, { reply: text("ACK") });
    const talking = talk(port, [text(`${ORDER(1)}\n`), 100, text(`${ORDER(2)}\n`)]);
    await until(() => calls() === 1);
    const stopping = source.stop();
    await sleep(150);
    release();
    await stopping;
    const result = await talking;
    expect(result).toEqual({ received: text("ACK\n"), closed: true });
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(calls()).toBe(1);
    expect(source.port).toBeUndefined();
  });

  it("refuses a connection opened before it stops once the stop has begun", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink, calls } = recordingSink(() => held);
    const { source, port } = await startSource(sink);
    const first = talk(port, [text(`${ORDER(1)}\n`)]);
    await until(() => calls() === 1);
    const stopping = source.stop();
    // The listener is closed: a new connection is refused, and stores nothing.
    const late = await talk(port, [text(`${ORDER(2)}\n`)], { waitMs: 500 });
    release();
    await stopping;
    await first;
    expect(late.received).toEqual(Buffer.alloc(0));
    expect(calls()).toBe(1);
  });

  it("drops the bytes between start and end frames, counting them", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, {
      framing: { kind: "startEnd", start: hex("02"), end: hex("03") },
    });
    await talk(port, [text(`\x02${ORDER(1)}\x03\r\n\x02${ORDER(2)}\x03`)], { waitMs: 300 });
    expect(received.map((r) => r.body)).toEqual([ORDER(1), ORDER(2)]);
    expect(named(events, "tcp-discarded-bytes")).toEqual([
      { level: "warn", event: "tcp-discarded-bytes", bytes: 2 },
    ]);
  });

  it("closes on an inclusive length prefix smaller than the prefix, storing what came before", async () => {
    const framing: Framing = { kind: "lengthPrefix", size: 2, endian: "big", inclusive: true };
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, { framing });
    const result = await talk(port, [
      Buffer.concat([encodeFrame(framing, text(ORDER(1))), Buffer.from([0, 1, 0x41])]),
    ]);
    expect(result.closed).toBe(true);
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(named(events, "tcp-bad-length")).toEqual([{ level: "warn", event: "tcp-bad-length" }]);
  });

  it("stores and answers nothing more once the reply builder fails, counting what it dropped", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, {
      reply: () => {
        throw new Error("synthetic builder failure");
      },
    });
    await talk(port, [text(`${ORDER(1)}\n${ORDER(2)}\n${ORDER(3)}\n`)]);
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(named(events, "tcp-frames-dropped")).toEqual([
      { level: "warn", event: "tcp-frames-dropped", count: 2 },
    ]);
  });

  it("stores and answers nothing more after a peer reset, sending no reply, the store finished", async () => {
    const { sink, received } = recordingSink(() => sleep(150));
    let built = 0;
    const { port, events } = await startSource(sink, {
      reply: () => {
        built += 1;
        return "ACK";
      },
    });
    const result = await talk(port, [text(`${ORDER(1)}\n${ORDER(2)}\n`), 50], { reset: true });
    await until(() => received.length === 2 && built === 2, 5_000);
    expect(result.received).toEqual(Buffer.alloc(0));
    expect(named(events, "tcp-frames-dropped")).toEqual([]);
  });

  it("closes a connection over maxConnections at accept, counts it, and takes one again once there is room", async () => {
    const { sink, received } = recordingSink();
    const { source, port, events } = await startSource(sink, { maxConnections: 2 });
    expect(source.refusedConnections).toBe(0);
    const held = [netConnect({ host: "127.0.0.1", port }), netConnect({ host: "127.0.0.1", port })];
    for (const socket of held) socket.on("error", () => undefined);
    await Promise.all(
      held.map((socket) => new Promise((resolve) => socket.once("connect", resolve))),
    );
    await sleep(50);
    // A count only, for /metrics: the two it holds.
    expect(source.openConnections).toBe(2);
    const refused = await talk(port, [text(`${ORDER(1)}\n`)]);
    expect(refused.closed).toBe(true);
    expect(received).toEqual([]);
    expect(source.refusedConnections).toBe(1);
    expect(named(events, "tcp-connection-refused")).toEqual([
      { level: "warn", event: "tcp-connection-refused", maxConnections: 2 },
    ]);
    const first = held[0] as Socket;
    first.destroy();
    // The source sees the close a moment later, and frees the slot.
    await sleep(200);
    await talk(port, [text(`${ORDER(2)}\n`)], { waitMs: 300 });
    expect(received.map((r) => r.body)).toEqual([ORDER(2)]);
    for (const socket of held) socket.destroy();
  });

  it("holds 100 connections at most when maxConnections is not set", () => {
    expect(DEFAULT_TCP_MAX_CONNECTIONS).toBe(100);
  });

  it("writes no reply on a connection the sender reset while the message was stored", async () => {
    const { sink, received } = recordingSink(() => sleep(200));
    let built = 0;
    const { port, events } = await startSource(sink, {
      reply: () => {
        built += 1;
        return "ACK";
      },
    });
    await talk(port, [text(`${ORDER(1)}\n`), 50], { reset: true });
    await until(() => received.length === 1 && built === 1);
    expect(named(events, "tcp-connection-error")).toHaveLength(1);
  });

  it("takes nothing more from a sender that closes its side after the connection began to close", async () => {
    const { sink, received } = recordingSink(() => sleep(300));
    const { port, events } = await startSource(sink, { stallTimeoutMs: 80 });
    const result = await talk(port, [text(`${ORDER(1)}\n${ORDER(2)}`), 150], { end: true });
    expect(result.closed).toBe(true);
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
    expect(named(events, "tcp-stalled")).toHaveLength(1);
    // The stall dropped the part; the sender's close after it reports nothing more.
    expect(named(events, "tcp-partial-frame")).toEqual([]);
  });

  it("reports an error its listener raises once listening, by name and code", async () => {
    const { sink } = recordingSink();
    const { source, events } = await startSource(sink);
    const listening = (
      source as unknown as { server: { emit(event: string, error: unknown): void } }
    ).server;
    listening.emit(
      "error",
      Object.assign(new Error("synthetic listener fault"), { code: "EMFILE" }),
    );
    expect(named(events, "tcp-source-error")).toEqual([
      { level: "warn", event: "tcp-source-error", name: "Error", code: "EMFILE" },
    ]);
  });
});

describe.skipIf(!OPENSSL)(`TcpSource ${TLS_TESTS}`, () => {
  let certs: Certificates;
  beforeAll(() => {
    certs = makeCertificates();
  });
  afterAll(() => {
    removeCertificates(certs);
  });

  it("answers a client that verifies it, with no TLS peer when no ca is set", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
      reply: text("ACK"),
    });
    const result = await talk(port, [text(`${ORDER(1)}\n`)], {
      tls: { ca: certs.ca },
      until: (got) => got.length >= 4,
    });
    expect(result.received).toEqual(text("ACK\n"));
    expect(received[0]?.options?.source).toEqual({ remoteAddress: "127.0.0.1" });
    expect(events[0]).toMatchObject({ event: "tcp-listening", tls: true });
  });

  it("with a ca, passes the client certificate's name, and refuses a client without one", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca },
      reply: text("ACK"),
    });
    const result = await talk(port, [text(`${ORDER(1)}\n`)], {
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
      until: (got) => got.length >= 4,
    });
    expect(result.received).toEqual(text("ACK\n"));
    expect(received[0]?.options?.source).toEqual({
      remoteAddress: "127.0.0.1",
      tlsPeerSubject: "localhost",
    });

    const refused = await talk(port, [text(`${ORDER(2)}\n`)], { tls: { ca: certs.ca } });
    expect(refused.received).toEqual(Buffer.alloc(0));
    expect(received).toHaveLength(1);
    await until(() => named(events, "tcp-tls-refused").length > 0);
    expect(named(events, "tcp-tls-refused")[0]).toMatchObject({ level: "warn" });
    expect(typeof named(events, "tcp-tls-refused")[0]?.["code"]).toBe("string");
  });

  it("with raw framing, sends the reply after the client closes its side", async () => {
    const { sink, received } = recordingSink();
    const { port } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
      framing: { kind: "raw" },
      reply: text("ACK"),
    });
    const result = await talk(port, [text(ORDER(1))], { tls: { ca: certs.ca }, end: true });
    expect(result.received).toEqual(text("ACK"));
    expect(received.map((r) => r.body)).toEqual([ORDER(1)]);
  });

  it("stops without waiting on a client that never finishes its TLS handshake", async () => {
    const { sink } = recordingSink();
    const { source, port } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
    });
    const silent = netConnect({ host: "127.0.0.1", port });
    silent.on("error", () => undefined);
    await new Promise<void>((resolve) => silent.once("connect", () => resolve()));
    await sleep(50);
    const closed = new Promise<void>((resolve) => silent.once("close", () => resolve()));
    await source.stop();
    await closed;
  });

  it("drops a client whose handshake finishes after the stop began", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink, calls } = recordingSink(() => held);
    const { source, port } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
    });
    const first = talk(port, [text(`${ORDER(1)}\n`)], { tls: { ca: certs.ca } });
    // Accepted before the stop, its handshake begun only after.
    const raw = netConnect({ host: "127.0.0.1", port });
    raw.on("error", () => undefined);
    await new Promise<void>((resolve) => raw.once("connect", () => resolve()));
    await until(() => calls() === 1);
    const stopping = source.stop();
    const late = tlsConnect({ socket: raw, servername: "localhost", ca: certs.ca });
    late.on("error", () => undefined);
    const lateClosed = new Promise<void>((resolve) => late.once("close", () => resolve()));
    late.once("secureConnect", () => late.write(`${ORDER(2)}\n`));
    await lateClosed;
    release();
    await stopping;
    await first;
    expect(calls()).toBe(1);
  });
});
