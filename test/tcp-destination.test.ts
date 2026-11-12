import {
  createServer as createNetServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { encodeFrame, type Framing } from "../src/connectors/tcp-framing.js";
import {
  TcpDeliveryError,
  TcpDestination,
  type TcpDestinationOptions,
  type TcpReply,
} from "../src/connectors/tcp.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import { OPENSSL, TLS_TESTS } from "./mllp-helpers.js";
import {
  CLOSED_PORT,
  makeCertificates,
  removeCertificates,
  type Certificates,
} from "./net-helpers.js";

const hex = (text: string): Buffer => Buffer.from(text, "hex");
const text = (value: string): Buffer => Buffer.from(value, "latin1");

/** A synthetic result line: no real patient, no real identifier. */
const RESULT = "RESULT|SYNTH-0001|GLUCOSE|5.4";

/** One connection a {@link Peer} took: what it read, and whether the sender closed its side. */
interface Taken {
  readonly socket: Socket;
  read: Buffer;
  ended: boolean;
  readonly authorized: boolean | undefined;
}

interface Peer {
  readonly port: number;
  readonly taken: Taken[];
  close(): Promise<void>;
}

const peers: Peer[] = [];

afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
});

/**
 * A receiver on a free port. `answer` is called on each read with the connection, so it can write
 * a reply, close, or do nothing.
 */
async function peer(
  answer: (taken: Taken) => void,
  tls?: { cert: Buffer; key: Buffer; ca?: Buffer },
): Promise<Peer> {
  const taken: Taken[] = [];
  const onSocket = (socket: Socket): void => {
    const entry: Taken = {
      socket,
      read: Buffer.alloc(0),
      ended: false,
      authorized: (socket as Partial<TLSSocket>).authorized,
    };
    taken.push(entry);
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      entry.read = Buffer.concat([entry.read, chunk]);
      answer(entry);
    });
    socket.on("end", () => {
      entry.ended = true;
      answer(entry);
    });
  };
  const server: Server =
    tls === undefined
      ? createNetServer({ allowHalfOpen: true }, onSocket)
      : createTlsServer(
          {
            ...tls,
            requestCert: tls.ca !== undefined,
            rejectUnauthorized: true,
            allowHalfOpen: true,
          },
          onSocket,
        );
  // Every connection, a TLS one that failed its handshake too, so close need not wait on any.
  const open = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const started: Peer = {
    port: (server.address() as AddressInfo).port,
    taken,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
  peers.push(started);
  return started;
}

const LINES: Framing = { kind: "delimiter", delimiter: hex("0a") };

function destination(port: number, options: Partial<TcpDestinationOptions> = {}): TcpDestination {
  return new TcpDestination({
    host: "127.0.0.1",
    port,
    tls: undefined,
    framing: LINES,
    maxMessageSize: 1_024,
    timeoutMs: 2_000,
    expectReply: true,
    ...options,
  });
}

const message = (body = RESULT, signal?: AbortSignal) => ({
  messageId: 7,
  seq: 1,
  body: text(body),
  ...(signal === undefined ? {} : { signal }),
});

/** Answers each whole frame `framing` would make of what was read with `reply`, written as it is. */
function replyOnce(framing: Framing, reply: Buffer | ((taken: Taken) => void)) {
  return (taken: Taken): void => {
    const whole =
      framing.kind === "raw"
        ? taken.ended
        : taken.read.length >= encodeFrame(framing, text(RESULT)).length;
    if (!whole || taken.socket.writableEnded) return;
    if (typeof reply === "function") reply(taken);
    else taken.socket.write(reply);
  };
}

const FRAMINGS: readonly { readonly name: string; readonly framing: Framing }[] = [
  { name: "delimiter", framing: { kind: "delimiter", delimiter: hex("0d0a") } },
  { name: "start and end", framing: { kind: "startEnd", start: hex("02"), end: hex("03") } },
  {
    name: "length prefix",
    framing: { kind: "lengthPrefix", size: 4, endian: "big", inclusive: false },
  },
  { name: "raw", framing: { kind: "raw" } },
];

describe.each(FRAMINGS)("TcpDestination with $name framing, over real sockets", ({ framing }) => {
  it("sends one frame and reads one framed reply that comes in pieces, for the check", async () => {
    const reply = encodeFrame(framing, text("ACK|SYNTH-0001"));
    const receiver = await peer(
      replyOnce(framing, (taken) => {
        void (async () => {
          for (let at = 0; at < reply.length; at += 3) {
            taken.socket.write(reply.subarray(at, at + 3));
            await sleep(5);
          }
          if (framing.kind === "raw") taken.socket.end();
        })();
      }),
    );
    const checked: TcpReply[] = [];
    await destination(receiver.port, {
      framing,
      replyCheck: (got) => {
        checked.push(got);
        return "delivered";
      },
    }).deliver(message());
    expect(receiver.taken).toHaveLength(1);
    expect(receiver.taken[0]?.read).toEqual(encodeFrame(framing, text(RESULT)));
    expect(checked).toEqual([{ body: text("ACK|SYNTH-0001"), messageId: 7, seq: 1 }]);
  });

  it("without expectReply, is delivered once the frame is written", async () => {
    const receiver = await peer(() => undefined);
    await destination(receiver.port, { framing, expectReply: false }).deliver(message());
    await until(() => receiver.taken[0]?.ended === true);
    expect(receiver.taken[0]?.read).toEqual(encodeFrame(framing, text(RESULT)));
  });

  it("retries a reply past maxMessageSize", async () => {
    const reply = encodeFrame(framing, text("ACK|SYNTH-0001-TOO-LONG"));
    const receiver = await peer(
      replyOnce(framing, (taken) => {
        taken.socket.write(reply);
        if (framing.kind === "raw") taken.socket.end();
      }),
    );
    await expect(
      destination(receiver.port, { framing, maxMessageSize: 8 }).deliver(message()),
    ).rejects.toMatchObject({ name: "TcpDeliveryError", code: "REPLY_OVERSIZE" });
  });

  it("retries when the receiver closes before a whole reply", async () => {
    const receiver = await peer(
      replyOnce(framing, (taken) => {
        if (framing.kind === "raw") taken.socket.end();
        else taken.socket.end(encodeFrame(framing, text("ACK")).subarray(0, 2));
      }),
    );
    await expect(destination(receiver.port, { framing }).deliver(message())).rejects.toMatchObject({
      code: "CONNECTION_CLOSED",
    });
  });

  it("retries when no reply comes in time", async () => {
    const receiver = await peer(() => undefined);
    await expect(
      destination(receiver.port, { framing, timeoutMs: 150 }).deliver(message()),
    ).rejects.toMatchObject({ code: "REPLY_TIMEOUT" });
  });
});

/** Waits until `check` holds, or fails after a while. */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const by = Date.now() + ms;
  while (!check()) {
    if (Date.now() > by) throw new Error("timed out waiting");
    await sleep(10);
  }
}

describe("TcpDestination", () => {
  it("takes the first reply when more comes with it, and an empty frame as a reply", async () => {
    const receiver = await peer(replyOnce(LINES, text("\nACK\nmore\n")));
    const bodies: string[] = [];
    await destination(receiver.port, {
      replyCheck: ({ body }) => {
        bodies.push(Buffer.from(body).toString("latin1"));
        return "delivered";
      },
    }).deliver(message());
    expect(bodies).toEqual([""]);
  });

  it("is delivered on any reply when no check is set", async () => {
    const receiver = await peer(replyOnce(LINES, text("NAK\n")));
    await expect(destination(receiver.port).deliver(message())).resolves.toBeUndefined();
  });

  it("skips bytes before a start sequence in the reply", async () => {
    const framing: Framing = { kind: "startEnd", start: hex("02"), end: hex("03") };
    const receiver = await peer(replyOnce(framing, text("\r\n\x02ACK\x03")));
    const bodies: string[] = [];
    await destination(receiver.port, {
      framing,
      replyCheck: ({ body }) => {
        bodies.push(Buffer.from(body).toString("latin1"));
        return "delivered";
      },
    }).deliver(message());
    expect(bodies).toEqual(["ACK"]);
  });

  it("retries a reply whose inclusive length is smaller than its prefix", async () => {
    const framing: Framing = { kind: "lengthPrefix", size: 2, endian: "big", inclusive: true };
    const receiver = await peer(replyOnce(framing, Buffer.from([0, 1])));
    await expect(destination(receiver.port, { framing }).deliver(message())).rejects.toMatchObject({
      code: "REPLY_BAD_LENGTH",
    });
  });

  it("does what the check says: rejected fails for good, retry and a throw or a stray answer retry", async () => {
    const receiver = await peer(replyOnce(LINES, text("ACK\n")));
    const verdict = async (check: TcpDestinationOptions["replyCheck"]): Promise<unknown> =>
      destination(receiver.port, { replyCheck: check })
        .deliver(message())
        .then(
          () => "delivered",
          (error: unknown) => error,
        );
    expect(await verdict(() => Promise.resolve("delivered" as const))).toBe("delivered");
    const rejected = await verdict(() => "rejected");
    expect(rejected).toBeInstanceOf(DeliveryRejected);
    expect(rejected).toMatchObject({ reason: "REPLY_REJECTED" });
    expect(await verdict(() => "retry")).toMatchObject({ code: "REPLY_RETRY" });
    const thrown = await verdict(() => {
      throw new Error("synthetic check fault");
    });
    expect(thrown).toBeInstanceOf(TcpDeliveryError);
    expect(thrown).toMatchObject({ code: "REPLY_CHECK_FAILED" });
    expect(String((thrown as Error).message)).not.toContain("synthetic");
    expect(await verdict((() => "maybe") as unknown as () => "delivered")).toMatchObject({
      code: "REPLY_CHECK_FAILED",
    });
  });

  it("rejects for good an output its framing cannot carry, without connecting", async () => {
    const receiver = await peer(() => undefined);
    const sent = destination(receiver.port).deliver(message("A\nB"));
    await expect(sent).rejects.toBeInstanceOf(DeliveryRejected);
    await expect(sent).rejects.toMatchObject({ reason: "TCP_PAYLOAD_CONTAINS_DELIMITER" });
    const tooLong = destination(receiver.port, {
      framing: { kind: "lengthPrefix", size: 1, endian: "big", inclusive: false },
    }).deliver(message("x".repeat(256)));
    await expect(tooLong).rejects.toMatchObject({ reason: "TCP_PAYLOAD_TOO_LONG" });
    await sleep(50);
    expect(receiver.taken).toEqual([]);
  });

  it("retries a refused connection with the system's code", async () => {
    await expect(destination(CLOSED_PORT).deliver(message())).rejects.toMatchObject({
      name: "TcpDeliveryError",
      code: "ECONNREFUSED",
      message: "the tcp delivery did not complete (ECONNREFUSED)",
    });
  });

  it("retries a connection the receiver resets while it waits for the reply", async () => {
    const receiver = await peer(replyOnce(LINES, (taken) => taken.socket.resetAndDestroy()));
    await expect(destination(receiver.port).deliver(message())).rejects.toMatchObject({
      code: "ECONNRESET",
    });
  });

  // Skipped on Windows: there a write is done once the system holds it, however large, so a send
  // the receiver never reads still finishes, and only a POSIX system's full buffers hold it back.
  it.skipIf(process.platform === "win32")(
    `retries a send that is not taken in time without expectReply${process.platform === "win32" ? " (skipped on Windows: a write finishes once the system holds it)" : ""}`,
    async () => {
      // The receiver reads nothing, so a body larger than the system's buffers never finishes.
      const receiver = await peer(() => undefined);
      const pausing = createNetServer((socket) => {
        socket.pause();
        socket.on("error", () => undefined);
        receiver.taken.push({ socket, read: Buffer.alloc(0), ended: false, authorized: undefined });
      });
      await new Promise<void>((resolve) => pausing.listen(0, "127.0.0.1", resolve));
      const port = (pausing.address() as AddressInfo).port;
      try {
        await expect(
          destination(port, { expectReply: false, timeoutMs: 200 }).deliver(
            message("x".repeat(64 * 1_048_576)),
          ),
        ).rejects.toMatchObject({ code: "WRITE_TIMEOUT" });
      } finally {
        for (const { socket } of receiver.taken) socket.destroy();
        await new Promise<void>((resolve) => pausing.close(() => resolve()));
      }
    },
  );

  it("gives up when the halt signal aborts, before or while it waits", async () => {
    const receiver = await peer(() => undefined);
    const controller = new AbortController();
    const sent = destination(receiver.port).deliver(message(RESULT, controller.signal));
    await until(
      () => receiver.taken[0]?.read.length !== undefined && receiver.taken[0].read.length > 0,
    );
    controller.abort();
    await expect(sent).rejects.toMatchObject({ code: "ABORTED" });
    await expect(
      destination(receiver.port).deliver(message(RESULT, AbortSignal.abort())),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("keeps nothing open between deliveries", async () => {
    await expect(destination(CLOSED_PORT).stop()).resolves.toBeUndefined();
  });
});

describe(`TcpDestination ${TLS_TESTS}`, () => {
  it("retries a connection whose TLS handshake does not finish in time", async () => {
    // A plain listener that never answers the handshake.
    const silent = await peer(() => undefined);
    await expect(
      destination(silent.port, {
        tls: { ca: undefined, cert: undefined, key: undefined },
        timeoutMs: 150,
      }).deliver(message()),
    ).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
  });
});

describe.skipIf(!OPENSSL)(`TcpDestination ${TLS_TESTS}, with certificates`, () => {
  let certs: Certificates;
  beforeAll(() => {
    certs = makeCertificates();
  });
  afterAll(() => {
    removeCertificates(certs);
  });

  it("verifies the receiver against the ca, presents its certificate, and reads the reply", async () => {
    const receiver = await peer(replyOnce(LINES, text("ACK\n")), {
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    await destination(receiver.port, {
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
    }).deliver(message());
    expect(receiver.taken[0]?.authorized).toBe(true);
  });

  it("retries a receiver whose certificate it cannot verify, with the TLS code", async () => {
    const receiver = await peer(replyOnce(LINES, text("ACK\n")), {
      cert: certs.serverCert,
      key: certs.serverKey,
    });
    const failed = await destination(receiver.port, {
      tls: { ca: certs.otherCa, cert: undefined, key: undefined },
    })
      .deliver(message())
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(TcpDeliveryError);
    expect((failed as TcpDeliveryError).code).toMatch(/^[A-Z_]+$/);
    expect((failed as TcpDeliveryError).code).not.toBe("TCP_CONNECTION");
  });

  it("with raw framing, ends its side over TLS and still reads the reply", async () => {
    const framing: Framing = { kind: "raw" };
    const receiver = await peer(
      replyOnce(framing, (taken) => taken.socket.end(text("ACK"))),
      { cert: certs.serverCert, key: certs.serverKey },
    );
    const bodies: string[] = [];
    await destination(receiver.port, {
      framing,
      tls: { ca: certs.ca, cert: undefined, key: undefined },
      replyCheck: ({ body }) => {
        bodies.push(Buffer.from(body).toString("latin1"));
        return "delivered";
      },
    }).deliver(message());
    expect(receiver.taken[0]?.read).toEqual(text(RESULT));
    expect(bodies).toEqual(["ACK"]);
  });
});
