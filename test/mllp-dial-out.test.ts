import {
  createConnection,
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer as createTlsServer } from "node:tls";

import { encodeFrame, FrameReader } from "@cosyte/mllp";
import { Ajv } from "ajv";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { ConfigError, loadProject } from "../src/config/load.js";
import { channelSchema, configJsonSchemas } from "../src/config/schema.js";

import {
  MllpSource,
  redialWait,
  type MllpEvent,
  type MllpSourceOptions,
} from "../src/connectors/mllp.js";
import { sendOnce, type MllpDialError } from "../src/connectors/mllp-dial.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { ADT_A01, captureLogger, cleanUp, LAB_TRANSFORM, makeProject } from "./helpers.js";
import { exchange, msaOf, OPENSSL, TLS_TESTS } from "./mllp-helpers.js";
import {
  CLOSED_PORT,
  makeCertificates,
  removeCertificates,
  type Certificates,
} from "./net-helpers.js";

/*
 * Two ways an MLLP source reaches beyond the connection a sender opened: replyTo sends each ACK on a
 * new connection to an address the channel names, and connect dials out to the sender and reads from
 * that connection. Every test runs over real sockets on 127.0.0.1.
 */

const sources: MllpSource[] = [];
const servers: Server[] = [];
/** Every connection a test's servers took, closed after each test so the servers can close. */
const taken: Socket[] = [];

afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop()));
  for (const socket of taken.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const MSG = (n: number): string => ADT_A01.replace("MSG00001", `MSG0000${n}`);
const frame = (text: string): Buffer => encodeFrame(Buffer.from(text, "latin1"));

/** A sink that keeps each body and its options, and records what the source says of its link. */
interface Recorder {
  readonly sink: MessageSink;
  readonly stored: string[];
  readonly options: (ReceiveOptions | undefined)[];
  /** The code of each `sourceDown`, with when it came. */
  readonly downs: { code: string; at: number }[];
  /** When each `sourceUp` came. */
  readonly ups: number[];
}

function recorder(wait = 50, fail = false): Recorder {
  const stored: string[] = [];
  const options: (ReceiveOptions | undefined)[] = [];
  const downs: { code: string; at: number }[] = [];
  const ups: number[] = [];
  return {
    stored,
    options,
    downs,
    ups,
    sink: {
      receive: (body, given) => {
        if (fail) return Promise.reject(new Error("storage unreachable"));
        stored.push(Buffer.from(body).toString("latin1"));
        options.push(given);
        return Promise.resolve(stored.length);
      },
      sourceDown: (code) => {
        downs.push({ code, at: Date.now() });
        return wait;
      },
      sourceUp: () => {
        ups.push(Date.now());
      },
    },
  };
}

async function startSource(
  sink: MessageSink,
  options: Partial<MllpSourceOptions>,
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

/** One connection a {@link Peer} took: the frames that came on it, and whether it has closed. */
interface PeerConnection {
  readonly socket: Socket;
  readonly frames: string[];
  readonly closed: Promise<void>;
  readonly openedAt: number;
}

/** A listening peer on 127.0.0.1 that keeps every connection it takes and the frames on each. */
interface Peer {
  readonly port: number;
  readonly connections: PeerConnection[];
}

/**
 * Starts a {@link Peer}: plain TCP, or TLS with `tls`. `onConnection` runs as each connection opens,
 * with its index, to send what the test wants. `silent` takes TCP connections and never speaks, so a
 * TLS client's handshake stalls.
 */
async function startPeer(
  options: {
    readonly tls?: { readonly cert: Buffer; readonly key: Buffer; readonly ca?: Buffer };
    readonly onConnection?: (connection: PeerConnection, index: number) => void;
  } = {},
): Promise<Peer> {
  const connections: PeerConnection[] = [];
  const take = (socket: Socket): void => {
    taken.push(socket);
    const frames: string[] = [];
    const reader = new FrameReader({ onFrame: (bytes) => frames.push(bytes.toString("latin1")) });
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const connection = { socket, frames, closed, openedAt: Date.now() };
    connections.push(connection);
    options.onConnection?.(connection, connections.length - 1);
  };
  const server =
    options.tls === undefined
      ? createNetServer(take)
      : createTlsServer(
          {
            cert: options.tls.cert,
            key: options.tls.key,
            // With a ca, a client must present a certificate it signed.
            ...(options.tls.ca === undefined
              ? {}
              : { ca: options.tls.ca, requestCert: true, rejectUnauthorized: true }),
          },
          take,
        );
  server.on("tlsClientError", () => undefined);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0, connections };
}

/** A TCP server that takes connections and never sends a byte: a TLS handshake to it stalls. */
async function startSilent(): Promise<number> {
  const server = createNetServer((socket) => {
    taken.push(socket);
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

/** Waits until `check` holds, for at most `ms`. */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await sleep(5);
}

/** Opens a plain connection to `port` and writes `writes` framed, keeping what comes back. */
async function sendOn(
  port: number,
  writes: readonly string[],
): Promise<{ socket: Socket; replies: string[]; closed: Promise<void> }> {
  const socket = createConnection({ host: "127.0.0.1", port });
  const replies: string[] = [];
  const reader = new FrameReader({ onFrame: (bytes) => replies.push(bytes.toString("latin1")) });
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  for (const write of writes) socket.write(frame(write));
  return { socket, replies, closed };
}

describe("an MLLP source with replyTo", () => {
  it("sends each ACK on a new connection to replyTo, and none on the connection the message came on", async () => {
    const replies = await startPeer();
    const { sink, stored } = recorder();
    const { port } = await startSource(sink, {
      replyTo: { host: "127.0.0.1", port: replies.port },
    });
    const sender = await sendOn(port, [MSG(1), MSG(2)]);
    await until(() => replies.connections.filter((c) => c.frames.length > 0).length === 2);
    expect(stored).toEqual([MSG(1), MSG(2)]);
    // One new connection per ACK, in the order the messages came, each closed once it is written.
    expect(replies.connections).toHaveLength(2);
    expect(replies.connections.map((c) => c.frames.map((ack) => msaOf(ack)))).toEqual([
      [["AA", "MSG00001"]],
      [["AA", "MSG00002"]],
    ]);
    await Promise.all(replies.connections.map((c) => c.closed));
    await sleep(100);
    expect(sender.replies).toEqual([]);
    expect(sender.socket.destroyed).toBe(false);
    sender.socket.destroy();
  });

  it("sends a negative ACK for a message it cannot store to replyTo too", async () => {
    const replies = await startPeer();
    const { sink } = recorder(50, true);
    const { port } = await startSource(sink, {
      replyTo: { host: "127.0.0.1", port: replies.port },
      onStoreFailure: "AE",
    });
    const sender = await sendOn(port, [MSG(3)]);
    await until(() => replies.connections[0]?.frames.length === 1);
    expect(msaOf(replies.connections[0]?.frames[0] ?? "")).toEqual(["AE", "MSG00003"]);
    expect(sender.replies).toEqual([]);
    sender.socket.destroy();
  });

  it("keeps a message it stored when the reply address refuses, and logs the id and the code only", async () => {
    const { sink, stored } = recorder();
    const { port, events } = await startSource(sink, {
      replyTo: { host: "127.0.0.1", port: CLOSED_PORT },
    });
    const sender = await sendOn(port, [MSG(1), MSG(2)]);
    await until(() => events.filter((e) => e.event === "mllp-reply-failed").length === 2);
    expect(stored).toEqual([MSG(1), MSG(2)]);
    expect(events.filter((e) => e.event === "mllp-reply-failed")).toEqual([
      { level: "warn", event: "mllp-reply-failed", message: 1, code: "ECONNREFUSED" },
      { level: "warn", event: "mllp-reply-failed", message: 2, code: "ECONNREFUSED" },
    ]);
    // No ACK goes back on the sender's own connection, so it sends again; the connection stays up.
    expect(sender.replies).toEqual([]);
    expect(sender.socket.destroyed).toBe(false);
    expect(JSON.stringify(events)).not.toContain("TESTPATIENT");
    sender.socket.destroy();
  });

  it("logs a negative ACK it could not send to replyTo with no message id, since none was stored", async () => {
    const { sink } = recorder(50, true);
    const { port, events } = await startSource(sink, {
      replyTo: { host: "127.0.0.1", port: CLOSED_PORT },
      onStoreFailure: "AR",
    });
    const sender = await sendOn(port, [MSG(5)]);
    await until(() => events.some((e) => e.event === "mllp-reply-failed"));
    expect(events.filter((e) => e.event === "mllp-reply-failed")).toEqual([
      { level: "warn", event: "mllp-reply-failed", message: null, code: "ECONNREFUSED" },
    ]);
    sender.socket.destroy();
  });

  it("takes replyTo from its options only, never from the message's MSH", async () => {
    const replies = await startPeer();
    const { sink } = recorder();
    const { port } = await startSource(sink, {
      replyTo: { host: "127.0.0.1", port: replies.port },
    });
    // MSH-3 and MSH-4 name another host; the ACK still goes where the channel says.
    const elsewhere = MSG(4).replace("SYNTH|TESTFAC", "elsewhere.invalid|9");
    const sender = await sendOn(port, [elsewhere]);
    await until(() => replies.connections[0]?.frames.length === 1);
    expect(msaOf(replies.connections[0]?.frames[0] ?? "")).toEqual(["AA", "MSG00004"]);
    sender.socket.destroy();
  });
});

describe("sendOnce", () => {
  // Windows takes the whole write into its own buffers on loopback, so a peer that never reads
  // cannot hold it up there; Linux and macOS stop the write once the peer's window is full.
  it.skipIf(process.platform === "win32")(
    "gives up on a reply address that takes the connection but never reads, once its time is up",
    async () => {
      // A peer that never reads: a frame larger than the kernel's buffers cannot be written out.
      const silent = await startSilent();
      const started = Date.now();
      const sending = sendOnce(
        { host: "127.0.0.1", port: silent },
        undefined,
        200,
        Buffer.alloc(64 * 1024 * 1024, 0x41),
      );
      const outcome = await Promise.race([
        sending.then(
          () => "sent",
          (error: unknown) => (error as MllpDialError).code,
        ),
        sleep(3_000).then(() => "still waiting"),
      ]);
      expect(outcome).toBe("SEND_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(2_000);
    },
  );
});

describe("an MLLP source that connects", () => {
  it("dials the sender, stores each message it sends and answers on that connection", async () => {
    const sender = await startPeer({
      onConnection: (connection) => {
        connection.socket.write(Buffer.concat([frame(MSG(1)), frame(MSG(2))]));
      },
    });
    const { sink, stored, options, ups } = recorder();
    const { source, events } = await startSource(sink, {
      connect: { host: "127.0.0.1", port: sender.port },
    });
    // A source that dials out listens on no port.
    expect(source.port).toBeUndefined();
    await until(() => sender.connections[0]?.frames.length === 2);
    expect(stored).toEqual([MSG(1), MSG(2)]);
    expect(sender.connections[0]?.frames.map((ack) => msaOf(ack))).toEqual([
      ["AA", "MSG00001"],
      ["AA", "MSG00002"],
    ]);
    expect(options[0]?.source).toEqual({ remoteAddress: "127.0.0.1" });
    expect(ups).toHaveLength(1);
    expect(events).toContainEqual({ level: "info", event: "mllp-connected", tls: false });
    expect(sender.connections).toHaveLength(1);
  });

  it("redials a connection that drops, after the wait the sink gives, and says so each time", async () => {
    const sender = await startPeer({
      onConnection: (connection, index) => {
        connection.socket.write(frame(MSG(index + 1)));
        // The first connection drops once its message is answered.
        if (index === 0) {
          const check = setInterval(() => {
            if (connection.frames.length === 0) return;
            clearInterval(check);
            connection.socket.destroy();
          }, 5);
        }
      },
    });
    const { sink, stored, downs, ups } = recorder(150);
    await startSource(sink, { connect: { host: "127.0.0.1", port: sender.port } });
    await until(() => sender.connections[1]?.frames.length === 1);
    expect(stored).toEqual([MSG(1), MSG(2)]);
    expect(msaOf(sender.connections[1]?.frames[0] ?? "")).toEqual(["AA", "MSG00002"]);
    expect(downs.map((down) => down.code)).toEqual(["MLLP_CONNECTION_CLOSED"]);
    // The redial waited what sourceDown said, and no longer than a bounded margin past it.
    const waited = (sender.connections[1]?.openedAt ?? 0) - (downs[0]?.at ?? 0);
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(1_500);
    expect(ups).toHaveLength(2);
  });

  it("keeps dialling a sender that refuses, reporting each failure by code", async () => {
    const { sink, downs, ups } = recorder(20);
    await startSource(sink, { connect: { host: "127.0.0.1", port: CLOSED_PORT } });
    await until(() => downs.length >= 3);
    expect(downs.slice(0, 3).map((down) => down.code)).toEqual([
      "ECONNREFUSED",
      "ECONNREFUSED",
      "ECONNREFUSED",
    ]);
    expect(ups).toEqual([]);
  });

  it("closes the dialled connection when it goes receiveTimeout without a message, and redials", async () => {
    const sender = await startPeer();
    const { sink, downs } = recorder(20);
    await startSource(sink, {
      connect: { host: "127.0.0.1", port: sender.port },
      receiveTimeoutMs: 150,
    });
    await until(() => sender.connections.length === 2);
    expect(downs[0]?.code).toBe("MLLP_RECEIVE_TIMEOUT");
    const first = sender.connections[0];
    await first?.closed;
    expect(sender.connections).toHaveLength(2);
  });

  it("drops a dialled connection that sends a frame over maxMessageSize, storing nothing of it", async () => {
    const big = `${MSG(1)}NTE|1||${"x".repeat(2_000)}\r`;
    const sender = await startPeer({
      onConnection: (connection, index) => {
        connection.socket.write(frame(index === 0 ? big : MSG(2)));
      },
    });
    const { sink, stored, downs } = recorder(20);
    await startSource(sink, {
      connect: { host: "127.0.0.1", port: sender.port },
      maxMessageSize: 1_024,
    });
    await until(() => stored.length === 1);
    expect(stored).toEqual([MSG(2)]);
    expect(downs[0]?.code).toBe("MLLP_FRAME_TOO_LARGE");
  });

  it("stops while connected: closes the dialled connection and dials no more", async () => {
    const sender = await startPeer();
    const { sink } = recorder(20);
    const { source } = await startSource(sink, {
      connect: { host: "127.0.0.1", port: sender.port },
    });
    await until(() => sender.connections.length === 1);
    // The connection it dialled counts as one it holds open, for /metrics.
    await until(() => source.openConnections === 1);
    expect(source.openConnections).toBe(1);
    await source.stop();
    await sender.connections[0]?.closed;
    expect(source.openConnections).toBe(0);
    await sleep(150);
    expect(sender.connections).toHaveLength(1);
  });

  it("stops while a message is being stored: answers it on the dialled connection, then closes", async () => {
    const sender = await startPeer({
      onConnection: (connection) => {
        connection.socket.write(frame(MSG(6)));
      },
    });
    const stored: string[] = [];
    let storing = false;
    const sink: MessageSink = {
      receive: async (body) => {
        storing = true;
        await sleep(100);
        stored.push(Buffer.from(body).toString("latin1"));
        return stored.length;
      },
      sourceDown: () => 20,
    };
    const { source } = await startSource(sink, {
      connect: { host: "127.0.0.1", port: sender.port },
    });
    await until(() => storing);
    await sleep(10);
    await source.stop();
    await sender.connections[0]?.closed;
    expect(stored).toEqual([MSG(6)]);
    expect(sender.connections[0]?.frames.map((ack) => msaOf(ack))).toEqual([["AA", "MSG00006"]]);
  });

  it("stops while it waits to redial, and while a dial is under way", async () => {
    const { sink, downs } = recorder(60_000);
    const { source } = await startSource(sink, {
      connect: { host: "127.0.0.1", port: CLOSED_PORT },
    });
    await until(() => downs.length === 1);
    const started = Date.now();
    await source.stop();
    expect(Date.now() - started).toBeLessThan(1_000);

    const silent = await startSilent();
    const stalled = await startSource(recorder().sink, {
      connect: { host: "127.0.0.1", port: silent },
      tls: { ca: Buffer.from("unused"), cert: undefined, key: undefined },
      connectTimeoutMs: 60_000,
    });
    await sleep(50);
    const stopping = Date.now();
    await stalled.source.stop();
    expect(Date.now() - stopping).toBeLessThan(1_000);
  });

  it("without sourceDown on the sink waits 1 second, doubling to 5 minutes, and starts over after a connection", () => {
    expect([1, 2, 3, 4].map((failures) => redialWait(failures))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    expect(redialWait(9)).toBe(256_000);
    expect(redialWait(10)).toBe(300_000);
    expect(redialWait(60)).toBe(300_000);
  });

  it("redials on its own waits when the sink has no sourceDown", async () => {
    const sender = await startPeer({
      onConnection: (connection, index) => {
        if (index === 0) connection.socket.destroy();
        else connection.socket.write(frame(MSG(index)));
      },
    });
    const stored: string[] = [];
    await startSource(
      {
        receive: (body) => {
          stored.push(Buffer.from(body).toString("latin1"));
          return Promise.resolve(stored.length);
        },
      },
      { connect: { host: "127.0.0.1", port: sender.port } },
    );
    await until(() => stored.length === 1, 4_000);
    expect(stored).toEqual([MSG(1)]);
    const gap = (sender.connections[1]?.openedAt ?? 0) - (sender.connections[0]?.openedAt ?? 0);
    expect(gap).toBeGreaterThanOrEqual(900);
    expect(gap).toBeLessThan(3_000);
  });
});

describe.skipIf(!OPENSSL)(`an MLLP source's dial-out and replyTo ${TLS_TESTS}`, () => {
  let certs: Certificates;

  beforeAll(() => {
    certs = makeCertificates();
  });

  afterAll(() => {
    removeCertificates(certs);
  });

  it("dials a TLS sender by name, verifying it against the source's ca", async () => {
    const sender = await startPeer({
      tls: { cert: certs.serverCert, key: certs.serverKey },
      onConnection: (connection) => connection.socket.write(frame(MSG(1))),
    });
    const { sink, stored } = recorder();
    const { events } = await startSource(sink, {
      // A name, so it is sent for SNI and the certificate is checked against it.
      connect: { host: "localhost", port: sender.port },
      tls: { ca: certs.ca, cert: undefined, key: undefined },
    });
    await until(() => sender.connections[0]?.frames.length === 1);
    expect(stored).toEqual([MSG(1)]);
    expect(msaOf(sender.connections[0]?.frames[0] ?? "")).toEqual(["AA", "MSG00001"]);
    expect(events).toContainEqual({ level: "info", event: "mllp-connected", tls: true });
  });

  it("presents the source's certificate to a sender that requires one, and is refused without it", async () => {
    const sender = await startPeer({
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca },
      onConnection: (connection) => connection.socket.write(frame(MSG(1))),
    });
    const { sink, stored } = recorder();
    await startSource(sink, {
      connect: { host: "127.0.0.1", port: sender.port },
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
    });
    await until(() => sender.connections.some((c) => c.frames.length === 1));
    expect(stored).toEqual([MSG(1)]);

    const bare = recorder(20);
    await startSource(bare.sink, {
      connect: { host: "127.0.0.1", port: sender.port },
      tls: { ca: certs.ca, cert: undefined, key: undefined },
    });
    await until(() => bare.downs.length >= 1);
    // Under TLS 1.3 the sender refuses after the handshake, so the dial may open and then drop.
    expect(bare.stored).toEqual([]);
  });

  it("refuses a TLS sender whose certificate does not name the address it dials", async () => {
    const sender = await startPeer({ tls: { cert: certs.elsewhereCert, key: certs.elsewhereKey } });
    const { sink, stored, downs } = recorder(20);
    await startSource(sink, {
      connect: { host: "127.0.0.1", port: sender.port },
      tls: { ca: certs.ca, cert: undefined, key: undefined },
    });
    await until(() => downs.length >= 1);
    expect(downs[0]?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(stored).toEqual([]);
  });

  it("gives up a dial whose TLS handshake stalls after connectTimeout", async () => {
    const silent = await startSilent();
    const { sink, downs } = recorder(20);
    const started = Date.now();
    await startSource(sink, {
      connect: { host: "127.0.0.1", port: silent },
      tls: { ca: certs.ca, cert: undefined, key: undefined },
      connectTimeoutMs: 200,
    });
    await until(() => downs.length >= 1);
    expect(downs[0]?.code).toBe("CONNECT_TIMEOUT");
    expect(downs[0]?.at ?? 0).toBeGreaterThanOrEqual(started + 180);
  });

  it("sends the ACK to replyTo over TLS, verifying the reply host against the source's ca", async () => {
    const replies = await startPeer({ tls: { cert: certs.serverCert, key: certs.serverKey } });
    const { sink, stored } = recorder();
    const { port } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca },
      replyTo: { host: "127.0.0.1", port: replies.port },
    });
    const sent = await exchange(port, [MSG(1)], {
      replies: 1,
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
      timeoutMs: 500,
    });
    await until(() => replies.connections[0]?.frames.length === 1);
    expect(stored).toEqual([MSG(1)]);
    expect(sent.replies).toEqual([]);
    expect(msaOf(replies.connections[0]?.frames[0] ?? "")).toEqual(["AA", "MSG00001"]);
  });

  it("logs a reply host whose TLS handshake stalls past connectTimeout, by id and code", async () => {
    const silent = await startSilent();
    const { sink, stored } = recorder();
    const { port, events } = await startSource(sink, {
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca },
      replyTo: { host: "127.0.0.1", port: silent },
      connectTimeoutMs: 200,
    });
    await exchange(port, [MSG(1)], {
      replies: 1,
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
      timeoutMs: 600,
    });
    await until(() => events.some((e) => e.event === "mllp-reply-failed"));
    expect(stored).toEqual([MSG(1)]);
    expect(events.filter((e) => e.event === "mllp-reply-failed")).toEqual([
      { level: "warn", event: "mllp-reply-failed", message: 1, code: "CONNECT_TIMEOUT" },
    ]);
  });
});

describe("connect and replyTo in channel.yaml", () => {
  afterEach(cleanUp);

  const validate = new Ajv({ strict: true, strictRequired: false, allErrors: true }).compile(
    configJsonSchemas().channel,
  );

  const channel = (source: string): string =>
    `format: hl7v2\nsource:\n  mllp: ${source}\ndestinations:\n  - file: { dir: ./out }\n`;

  /** Whether Zod accepts `yaml`; whatever it accepts, the editor's JSON Schema accepts too. */
  function accepted(yaml: string): boolean {
    const value = parseYaml(yaml) as unknown;
    const zod = channelSchema.safeParse(value).success;
    if (zod) expect(validate(value), yaml).toBe(true);
    return zod;
  }

  const jsonAccepts = (yaml: string): boolean => validate(parseYaml(yaml) as unknown);

  async function problemsOf(yaml: string): Promise<readonly string[]> {
    const root = await makeProject({ "channels/a/channel.yaml": yaml });
    try {
      await loadProject(root);
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
    throw new Error("expected a ConfigError");
  }

  it("resolves connect, replyTo and connectTimeout, and leaves them out when unset", async () => {
    const root = await makeProject({
      "channels/a/channel.yaml": channel(
        "{ connect: { host: ehr.example.test, port: 2575 }, connectTimeout: 5s, tls: { ca: ./ca.pem } }",
      ),
      "channels/b/channel.yaml": channel(
        "{ port: 2575, plaintext: true, replyTo: { host: ehr.example.test, port: 2576 } }",
      ),
      "channels/c/channel.yaml": channel("{ port: 2577, plaintext: true }"),
    });
    const [a, b, c] = (await loadProject(root)).channels;
    expect(a?.source).toMatchObject({
      kind: "mllp",
      port: 0,
      connect: { host: "ehr.example.test", port: 2575 },
      connectTimeoutMs: 5_000,
      tls: { ca: join(root, "channels/a/ca.pem"), cert: undefined, key: undefined },
    });
    expect(a?.source).not.toHaveProperty("replyTo");
    expect(b?.source).toMatchObject({
      port: 2575,
      replyTo: { host: "ehr.example.test", port: 2576 },
    });
    expect(b?.source).not.toHaveProperty("connect");
    expect(c?.source).not.toHaveProperty("connect");
    expect(c?.source).not.toHaveProperty("replyTo");
    expect(c?.source).not.toHaveProperty("connectTimeoutMs");
  });

  it("takes a dial-out source's TLS as a client's: tls: {}, a ca alone, or a client certificate", () => {
    for (const tls of ["{}", "{ ca: ./ca.pem }", "{ cert: c.pem, key: k.pem }", "{ pfx: c.p12 }"]) {
      expect(
        accepted(channel(`{ connect: { host: h.example.test, port: 1 }, tls: ${tls} }`)),
        tls,
      ).toBe(true);
    }
    expect(
      accepted(channel("{ connect: { host: h.example.test, port: 1 }, plaintext: true }")),
    ).toBe(true);
    expect(
      accepted(
        channel(
          "{ port: 2575, plaintext: true, replyTo: { host: h.example.test, port: 1 }, connectTimeout: 2s }",
        ),
      ),
    ).toBe(true);
  });

  it("refuses connect with the keys of a listening source, a source with neither, and a listener's TLS without a certificate", async () => {
    const cases: [string, string][] = [
      [
        "{ port: 2575, connect: { host: h.example.test, port: 1 }, plaintext: true }",
        "source.mllp.port: cannot be set with connect: a source that dials out listens on no port, and answers on the connection it dialled",
      ],
      [
        "{ connect: { host: h.example.test, port: 1 }, replyTo: { host: h.example.test, port: 2 }, plaintext: true }",
        "source.mllp.replyTo: cannot be set with connect: a source that dials out listens on no port, and answers on the connection it dialled",
      ],
      [
        "{ connect: { host: h.example.test, port: 1 }, maxConnections: 2, plaintext: true }",
        "source.mllp.maxConnections: cannot be set with connect: a source that dials out listens on no port, and answers on the connection it dialled",
      ],
      [
        "{ connect: { host: h.example.test, port: 1 }, keepOpen: false, plaintext: true }",
        "source.mllp.keepOpen: cannot be set with connect: a source that dials out listens on no port, and answers on the connection it dialled",
      ],
      [
        "{ connect: { host: h.example.test, port: 1 }, host: 0.0.0.0, plaintext: true }",
        "source.mllp.host: cannot be set with connect: a source that dials out listens on no port, and answers on the connection it dialled",
      ],
      [
        "{ plaintext: true }",
        "source.mllp.port: required: set port to listen on, or connect to dial out to the sender",
      ],
      [
        "{ port: 2575, tls: { ca: ca.pem } }",
        "source.mllp.tls.cert: required: set cert and key, or pfx",
      ],
    ];
    for (const [source, problem] of cases) {
      expect(accepted(channel(source)), source).toBe(false);
      expect(jsonAccepts(channel(source)), source).toBe(false);
      expect(await problemsOf(channel(source))).toContain(`channels/a/channel.yaml: ${problem}`);
    }
    // Rules start holds that the editor's schema leaves to it.
    const lone = channel("{ port: 2575, plaintext: true, connectTimeout: 2s }");
    expect(accepted(lone)).toBe(false);
    expect(await problemsOf(lone)).toContain(
      "channels/a/channel.yaml: source.mllp.connectTimeout: goes with connect or replyTo, the connections the source opens itself",
    );
    const bare = channel("{ connect: { host: h.example.test, port: 1 } }");
    expect(accepted(bare)).toBe(false);
    expect((await problemsOf(bare)).join("\n")).toContain(
      "source.mllp.tls: required: set tls: {} to verify the sender",
    );
    for (const bad of ["connectTimeout: 0", "connectTimeout: 25d"]) {
      expect(
        accepted(
          channel(`{ connect: { host: h.example.test, port: 1 }, plaintext: true, ${bad} }`),
        ),
        bad,
      ).toBe(false);
    }
    expect(
      accepted(
        channel("{ connect: { host: h.example.test, port: 1, path: /x }, plaintext: true }"),
      ),
    ).toBe(false);
  });
});

describe("an MLLP source that connects, in the engine", () => {
  const engines: Engine[] = [];
  const stores: Store[] = [];

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.stop()));
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await cleanUp();
  });

  it("stores what the sender sends, shows the source down when the sender goes, and up when it is back", async () => {
    const sender = await startPeer({
      onConnection: (connection, index) => {
        connection.socket.write(frame(MSG(index + 1)));
        if (index === 0) {
          const check = setInterval(() => {
            if (connection.frames.length === 0) return;
            clearInterval(check);
            connection.socket.destroy();
          }, 5);
        }
      },
    });
    const root = await makeProject({
      "channels/adt/transform.ts": LAB_TRANSFORM,
      "channels/adt/channel.yaml": `
source:
  mllp: { connect: { host: 127.0.0.1, port: ${String(sender.port)} }, plaintext: true }
transform: ./transform.ts
destinations:
  - file: { dir: ./out }
`,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const { logger, events } = captureLogger();
    const engine = new Engine({ project, store, logger });
    engines.push(engine);
    await engine.start();

    await until(() => sender.connections[0]?.frames.length === 1);
    expect(msaOf(sender.connections[0]?.frames[0] ?? "")).toEqual(["AA", "MSG00001"]);
    await until(() => events.some((event) => event.event === "source-lost"));
    expect(events.find((event) => event.event === "source-lost")).toMatchObject({
      channel: "adt",
      attempt: 1,
      retryInMs: 1_000,
      code: "MLLP_CONNECTION_CLOSED",
    });
    expect((await engine.health()).channels["adt"]?.source).toBe("down");

    // The engine's first wait is 1 second; the second connection brings the next message.
    await until(() => sender.connections[1]?.frames.length === 1, 4_000);
    expect(msaOf(sender.connections[1]?.frames[0] ?? "")).toEqual(["AA", "MSG00002"]);
    expect(events.some((event) => event.event === "source-regained")).toBe(true);
    expect((await engine.health()).channels["adt"]?.source).toBe("up");
    expect(JSON.stringify(events)).not.toContain("TESTPATIENT");
  });
});
