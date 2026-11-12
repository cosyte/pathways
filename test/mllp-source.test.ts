import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  MllpDestination,
  MllpSource,
  readHeader,
  type MllpEvent,
  type MllpSourceOptions,
} from "../src/connectors/mllp.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import {
  ADT_A01,
  ADT_A08,
  joinedResults,
  SECOND_HEADER_BEHIND,
  SECOND_HEADER_JOINED,
} from "./helpers.js";
import { errOf, exchange, msaOf, OPENSSL, TLS_TESTS } from "./mllp-helpers.js";
import { makeCertificates, removeCertificates, type Certificates } from "./net-helpers.js";

const sources: MllpSource[] = [];

afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop()));
});

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
        return received.length;
      },
    },
  };
}

async function startSource(
  sink: MessageSink,
  options: Partial<MllpSourceOptions> = {},
): Promise<{ source: MllpSource; port: number; events: MllpEvent[] }> {
  const events: MllpEvent[] = [];
  const source = new MllpSource({
    host: "127.0.0.1",
    port: 0,
    tls: undefined,
    onEvent: (event) => events.push(event),
    ...options,
  });
  sources.push(source);
  await source.start(sink);
  return { source, port: source.port ?? 0, events };
}

const MSG = (n: number): string => ADT_A01.replace("MSG00001", `MSG0000${n}`);

/** Whether a body holds an MLLP start or end byte, which the frame reader acts on. */
function framed(body: string): boolean {
  return body.includes("\u000b") || body.includes("\u001c");
}

describe("MllpSource", () => {
  it("stores each message before it answers AA, echoing the message's control ID", async () => {
    const order: string[] = [];
    const { sink, received } = recordingSink(async () => {
      order.push("storing");
      await sleep(100);
      order.push("stored");
    });
    const { port, events } = await startSource(sink);
    const { replies } = await exchange(port, [ADT_A01], { replies: 1 });
    order.push("acknowledged");

    expect(order).toEqual(["storing", "stored", "acknowledged"]);
    expect(received).toEqual([
      {
        body: ADT_A01,
        options: {
          duplicateKey: "SYNTH|TESTFAC\u0000MSG00001",
          // Over plain TCP there is no certificate, so no TLS peer.
          source: { remoteAddress: "127.0.0.1" },
        },
      },
    ]);
    const [ack = ""] = replies;
    expect(msaOf(ack)).toEqual(["AA", "MSG00001"]);
    // Sender and receiver swap sides; no ERR segment on a positive ACK.
    expect(ack).toMatch(/^MSH\|\^~\\&\|LAB\|TESTFAC\|SYNTH\|TESTFAC\|/);
    expect(errOf(ack)).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ event: "mllp-listening", port, tls: false }),
    );
  });

  it("by default sends no ACK when storing fails, and closes the connection", async () => {
    const { sink, calls } = recordingSink(() => Promise.reject(new Error("synthetic disk full")));
    const { port, events } = await startSource(sink);
    // Two messages at once: the second is never stored, so it cannot overtake the first.
    const result = await exchange(port, [MSG(1), MSG(2)], { replies: 1 });

    expect(result).toEqual({ replies: [], closed: true });
    expect(calls()).toBe(1);
    const failed = events.find((e) => e.event === "mllp-store-failed");
    expect(failed).toEqual({
      level: "warn",
      event: "mllp-store-failed",
      name: "Error",
      code: undefined,
      onStoreFailure: "close",
    });
    expect(JSON.stringify(events)).not.toContain("synthetic");
  });

  it("sends no ACK and closes the connection when handling a message fails past storing it", async () => {
    const { sink, received } = recordingSink();
    const events: MllpEvent[] = [];
    const { port } = await startSource(sink, {
      onEvent: (event) => {
        events.push(event);
        // The report of an unreadable message fails, once: the next report is the failure's own.
        if (event.event === "mllp-unreadable") throw new TypeError("synthetic report failure");
      },
    });
    const result = await exchange(port, ["not an HL7 message"], { replies: 1 });
    expect(result).toEqual({ replies: [], closed: true });
    expect(received).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      level: "warn",
      event: "mllp-source-failed",
      name: "TypeError",
      code: undefined,
    });
  });

  it("warns when it listens on every interface", async () => {
    const { sink } = recordingSink();
    const { events } = await startSource(sink, { host: "0.0.0.0" });
    expect(events).toContainEqual({
      level: "warn",
      event: "mllp-security-warning",
      code: "MLLP_BIND_ALL_INTERFACES",
    });
  });

  it.each(["AE", "AR"] as const)(
    "answers %s when storing fails and onStoreFailure says so",
    async (code) => {
      const { sink } = recordingSink(() => Promise.reject(new Error("synthetic")));
      const { port } = await startSource(sink, { onStoreFailure: code });
      const { replies, closed } = await exchange(port, [ADT_A01, "not a message"], {
        replies: 2,
      });
      expect(closed).toBe(false);
      // Correlated when the header could be read; otherwise MSA-2 is left empty.
      expect(replies.map(msaOf)).toEqual([
        [code, "MSG00001"],
        [code, ""],
      ]);
      expect(replies.map(errOf)).toEqual(["207", "207"]);
    },
  );

  it.each([
    ["not an HL7 message", "NO_MSH_SEGMENT", "", "100"],
    [
      "MSH|^~\\&|SYNTH|TESTFAC|LAB|TESTFAC|20261107120000||ADT^A01||P|2.5.1\rPID|1\r",
      "NO_CONTROL_ID",
      "",
      "101",
    ],
    [ADT_A01 + ADT_A08, "MULTIPLE_MESSAGES", "MSG00001", "100"],
    [`FHS|^~\\&\rBHS|^~\\&\r${ADT_A01}`, "NO_MSH_SEGMENT", "", "100"],
  ])(
    "stores a message with no usable header as failed and answers AR (%#: %s)",
    async (message, problem, controlId, condition) => {
      const { sink, received } = recordingSink();
      const { port, events } = await startSource(sink);
      const { replies } = await exchange(port, [message], { replies: 1 });

      expect(received).toEqual([{ body: message, options: { failure: `inbound: ${problem}` } }]);
      const [ack = ""] = replies;
      expect(msaOf(ack)).toEqual(["AR", controlId]);
      expect(errOf(ack)).toBe(condition);
      expect(events).toContainEqual({
        level: "warn",
        event: "mllp-unreadable",
        message: 1,
        problem,
      });
    },
  );

  it.each([
    ["msh", ADT_A01 + "msh" + ADT_A08.slice(3)],
    ["Msh", ADT_A01 + "Msh" + ADT_A08.slice(3)],
    [
      "mixed line endings",
      ADT_A01.replaceAll("\r", "\r\n") + "mSh" + ADT_A08.slice(3).replaceAll("\r", "\n"),
    ],
    ["a blank line", `${ADT_A01}\r\nmsh${ADT_A08.slice(3)}`],
  ])(
    "refuses a frame holding a second message whose header is %s, answering AR",
    async (_, message) => {
      const { sink, received } = recordingSink();
      const { port, events } = await startSource(sink);
      const { replies } = await exchange(port, [message], { replies: 1 });

      // Kept as failed, for the operator, and never handed on as a message.
      expect(received).toEqual([
        { body: message, options: { failure: "inbound: MULTIPLE_MESSAGES" } },
      ]);
      const [ack = ""] = replies;
      expect(msaOf(ack)).toEqual(["AR", "MSG00001"]);
      expect(errOf(ack)).toBe("100");
      expect(events).toContainEqual({
        level: "warn",
        event: "mllp-unreadable",
        message: 1,
        problem: "MULTIPLE_MESSAGES",
      });
    },
  );

  it.each([...SECOND_HEADER_BEHIND, ...SECOND_HEADER_JOINED.filter(([, body]) => !framed(body))])(
    "refuses a frame holding a second message whose header stands behind %s, answering AR",
    async (_, message) => {
      const { sink, received } = recordingSink();
      const { port, events } = await startSource(sink);
      const { replies } = await exchange(port, [message], { replies: 1 });

      expect(received).toEqual([
        { body: message, options: { failure: "inbound: MULTIPLE_MESSAGES" } },
      ]);
      const [ack = ""] = replies;
      expect(msaOf(ack)).toEqual(["AR", "MSG00001"]);
      expect(errOf(ack)).toBe("100");
      expect(events).toContainEqual({
        level: "warn",
        event: "mllp-unreadable",
        message: 1,
        problem: "MULTIPLE_MESSAGES",
      });
    },
  );

  // A VT or an FS inside a frame never reaches the parser here: the frame reader ends the frame at
  // an FS and starts a new one at a VT. So two results joined by them with no line break reach the
  // sink apart, or not at all, and never as one body holding both patients.
  it.each([
    ["an FS", "\u001c", [["MSG00001", undefined]], []],
    ["a VT", "\u000b", [["MSG00002", "inbound: MLLP_TRAILING_BYTES"]], ["AE"]],
    [
      "an FS and a VT",
      "\u001c\u000b",
      [
        ["MSG00001", undefined],
        ["MSG00002", undefined],
      ],
      ["AA", "AA"],
    ],
  ] as const)(
    "never stores two results joined by %s with no line break as one body",
    async (_, joiner, stored, codes) => {
      const { sink, received } = recordingSink();
      const { port } = await startSource(sink);
      // Framed by hand: the client refuses to frame a body holding VT or FS, and a sender need not.
      const frame = Buffer.concat([
        Buffer.from([0x0b]),
        Buffer.from(joinedResults(joiner), "latin1"),
        Buffer.from([0x1c, 0x0d]),
      ]);
      const { replies } = await exchange(port, [frame], { replies: codes.length });

      expect(
        received.map(({ body, options }) => [
          body.includes("MSG00002") ? "MSG00002" : "MSG00001",
          options?.failure,
        ]),
      ).toEqual(stored);
      for (const { body } of received) {
        expect(body.includes("TEST000001") && body.includes("TEST000002")).toBe(false);
      }
      expect(replies.map((reply) => msaOf(reply)[0])).toEqual(codes);
    },
  );

  it("stores a message whose framing lost bytes as failed, and answers AE so it is sent again", async () => {
    const { sink, received } = recordingSink();
    const { port } = await startSource(sink);
    // A frame that starts, is abandoned, and a whole one after it: the decoder drops the first part.
    const damaged = Buffer.concat([
      Buffer.from([0x0b]),
      Buffer.from("MSH|^~\\&|SYNTH|TESTFAC", "latin1"),
      Buffer.from([0x0b]),
      Buffer.from(ADT_A01, "latin1"),
      Buffer.from([0x1c, 0x0d]),
    ]);
    const { replies } = await exchange(port, [damaged], { replies: 1 });

    expect(received.map((r) => r.options)).toEqual([{ failure: "inbound: MLLP_TRAILING_BYTES" }]);
    expect(msaOf(replies[0] ?? "")).toEqual(["AE", "MSG00001"]);
  });

  it("answers in Latin-1 a message that declares it in MSH-18, so MSA-2 echoes the control ID byte for byte", async () => {
    const { sink } = recordingSink();
    const { port } = await startSource(sink);
    const latin1 = ADT_A01.replace("MSG00001", "MSG\u00e901").replace(
      "|P|2.5.1",
      "|P|2.5.1||||||8859/1",
    );
    const { replies } = await exchange(port, [latin1], { replies: 1 });
    expect(msaOf(replies[0] ?? "")).toEqual(["AA", "MSG\u00e901"]);
  });

  it("passes one duplicate key for a repeated sender and control ID, and another for anything else", async () => {
    const { sink, received } = recordingSink();
    const { port } = await startSource(sink);
    const otherSender = ADT_A01.replace("|SYNTH|", "|OTHER|");
    await exchange(port, [ADT_A01, ADT_A01, ADT_A08, otherSender], { replies: 4 });

    const keys = received.map((r) => r.options?.duplicateKey);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });

  it("handles one connection's messages one at a time, in order", async () => {
    let active = 0;
    let most = 0;
    const { sink, received } = recordingSink(async (index) => {
      active += 1;
      most = Math.max(most, active);
      await sleep(index === 0 ? 100 : 0);
      active -= 1;
    });
    const { port } = await startSource(sink);
    const { replies } = await exchange(port, [MSG(1), MSG(2), MSG(3)], { replies: 3 });

    expect(most).toBe(1);
    expect(received.map((r) => r.options?.duplicateKey?.split("\u0000")[1])).toEqual([
      "MSG00001",
      "MSG00002",
      "MSG00003",
    ]);
    expect(replies.map((reply) => msaOf(reply)[1])).toEqual(["MSG00001", "MSG00002", "MSG00003"]);
  });

  it("sends what a custom ACK builder builds, and the default ACK if the builder throws", async () => {
    const { sink } = recordingSink();
    const custom = await startSource(sink, {
      ackBuilder: (request) =>
        Buffer.from(`MSH|^~\\&|CUSTOM\rMSA|${request.code}|${String(request.messageId)}\r`),
    });
    const { replies: built } = await exchange(custom.port, [ADT_A01], { replies: 1 });
    expect(msaOf(built[0] ?? "")).toEqual(["AA", "1"]);

    const failing = await startSource(sink, {
      ackBuilder: () => {
        throw new TypeError("synthetic builder bug");
      },
    });
    const { replies: fallback } = await exchange(failing.port, [ADT_A01], { replies: 1 });
    expect(msaOf(fallback[0] ?? "")).toEqual(["AA", "MSG00001"]);
    expect(failing.events).toContainEqual({
      level: "warn",
      event: "mllp-ack-builder-failed",
      name: "TypeError",
    });
  });

  it("closes the connection when the ACK cannot be framed", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, {
      ackBuilder: () => Promise.resolve(Uint8Array.from([0x4d, 0x0b, 0x41])),
    });
    const result = await exchange(port, [ADT_A01], { replies: 1 });
    expect(result).toEqual({ replies: [], closed: true });
    expect(received).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "mllp-ack-unsendable", code: "MLLP_PAYLOAD_CONTAINS_VT" }),
    );
  });

  it("finishes storing and answering what it has before it stops, and ignores what arrives meanwhile", async () => {
    const { sink, received, calls } = recordingSink((index) => sleep(index === 0 ? 200 : 0));
    const { source, port } = await startSource(sink);
    const first = exchange(port, [MSG(1)], { replies: 1 });
    while (calls() === 0) await sleep(5);
    const stopping = source.stop();
    const late = await exchange(port, [MSG(2)], { replies: 1, timeoutMs: 150 });
    await stopping;

    expect(msaOf((await first).replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
    expect(late.replies).toEqual([]);
    expect(received).toHaveLength(1);
    expect(source.port).toBeUndefined();
  });

  it("reports a peer that does not speak MLLP, by code only", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink);
    await exchange(port, [Buffer.from("GET / HTTP/1.0\r\n\r\n")], { replies: 1, timeoutMs: 500 });
    expect(received).toEqual([]);
    expect(events.find((e) => e.event === "mllp-source-error")).toMatchObject({
      level: "warn",
      code: expect.stringMatching(/^MLLP_[A-Z_]+$/) as unknown,
    });
  });
});

describe.skipIf(!OPENSSL)(`MllpSource ${TLS_TESTS}`, () => {
  let certs: Certificates;
  beforeAll(() => {
    certs = makeCertificates();
  });
  afterAll(() => {
    removeCertificates(certs);
  });

  it("answers a client that verifies it", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
    });
    const { replies } = await exchange(port, [ADT_A01], { replies: 1, tls: { ca: certs.ca } });
    expect(msaOf(replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
    expect(received).toHaveLength(1);
    // No ca, so no client certificate is asked for, and the transform is told of no TLS peer.
    expect(received[0]?.options?.source).toEqual({ remoteAddress: "127.0.0.1" });
    expect(events).toContainEqual(expect.objectContaining({ event: "mllp-listening", tls: true }));
  });

  it("with a ca, takes a client certificate it signed, and refuses others at the handshake", async () => {
    const { sink, received } = recordingSink();
    const { port, events } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca },
    });

    const accepted = await exchange(port, [MSG(1)], {
      replies: 1,
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
    });
    expect(msaOf(accepted.replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
    // The transform reads the common name of the certificate the client presented.
    expect(received[0]?.options?.source).toEqual({
      remoteAddress: "127.0.0.1",
      tlsPeerSubject: "localhost",
    });

    const without = await exchange(port, [MSG(2)], { replies: 1, tls: { ca: certs.ca } });
    expect(without).toEqual({ replies: [], closed: true });
    const otherCa = await exchange(port, [MSG(3)], {
      replies: 1,
      tls: { ca: certs.ca, cert: certs.otherClientCert, key: certs.otherClientKey },
    });
    expect(otherCa).toEqual({ replies: [], closed: true });

    expect(received).toHaveLength(1);
    for (
      let i = 0;
      i < 50 && events.filter((e) => e.event === "mllp-tls-refused").length < 2;
      i += 1
    ) {
      await sleep(10);
    }
    expect(events.filter((e) => e.event === "mllp-tls-refused")).toHaveLength(2);
  });

  // Pathways to Pathways, natively on each system CI runs: an MLLP destination sends to an MLLP
  // source over mutual TLS. Every listen names its host and asks for port 0, and the port the
  // system gave is read back, so the test never guesses at a free port another process can take
  // first.
  it("carries a message from a destination to a source and its ACK back, over mutual TLS", async () => {
    const { sink, received } = recordingSink();
    const { source, port } = await startSource(sink, {
      host: "127.0.0.1",
      port: 0,
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca },
    });
    expect(port).toBeGreaterThan(0);
    expect(source.port).toBe(port);
    const sender = new MllpDestination({
      host: "127.0.0.1",
      port,
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
      ackTimeoutMs: 5_000,
    });
    try {
      await sender.deliver({ messageId: 1, seq: 0, body: Buffer.from(ADT_A01, "latin1") });
      await sender.deliver({ messageId: 2, seq: 0, body: Buffer.from(ADT_A08, "latin1") });
    } finally {
      await sender.stop();
    }
    expect(received.map((r) => r.body)).toEqual([ADT_A01, ADT_A08]);
  });
});

describe("readHeader", () => {
  it("finds no control ID in an MSH that stops short of MSH-10", () => {
    expect(readHeader(Buffer.from("MSH|^~\\&|SYNTH|TESTFAC\r"))).toMatchObject({
      problem: "NO_CONTROL_ID",
      controlId: undefined,
      duplicateKey: undefined,
    });
  });

  it("skips blank lines before the header and reads MSH-10 whole", () => {
    const reading = readHeader(Buffer.from(`\r\n${ADT_A01.replace("MSG00001", "A^B")}`));
    expect(reading).toMatchObject({ problem: undefined, controlId: "A^B" });
    expect(reading.duplicateKey).toBe("SYNTH|TESTFAC\u0000A^B");
  });
});
