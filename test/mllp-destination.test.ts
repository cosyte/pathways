import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  MllpDeliveryError,
  MllpDestination,
  type MllpDestinationOptions,
} from "../src/connectors/mllp.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import { ADT_A01 } from "./helpers.js";
import { ackText, controlIdOf, OPENSSL, startPeer, TLS_TESTS, type Peer } from "./mllp-helpers.js";
import {
  freePort,
  makeCertificates,
  removeCertificates,
  type Certificates,
} from "./net-helpers.js";

const peers: Peer[] = [];
const destinations: MllpDestination[] = [];

afterEach(async () => {
  await Promise.all(destinations.splice(0).map((destination) => destination.stop()));
  await Promise.all(peers.splice(0).map((peer) => peer.server.close({ drainTimeoutMs: 100 })));
});

async function peer(...args: Parameters<typeof startPeer>): Promise<Peer> {
  const started = await startPeer(...args);
  peers.push(started);
  return started;
}

function destination(port: number, options: Partial<MllpDestinationOptions> = {}): MllpDestination {
  const made = new MllpDestination({
    host: "127.0.0.1",
    port,
    tls: undefined,
    ackTimeoutMs: 2_000,
    ...options,
  });
  destinations.push(made);
  return made;
}

const body = (text: string): Uint8Array => new TextEncoder().encode(text);
const message = (n: number, text = ADT_A01.replace("MSG00001", `MSG0000${n}`)) => ({
  messageId: n,
  seq: 0,
  body: body(text),
});

/** TLS with nothing set: verify the server against Node's built-in roots. */
const NO_FILES = { ca: undefined, cert: undefined, key: undefined };

/** What a delivery threw, or `undefined` if it was delivered. */
async function outcome(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("MllpDestination", () => {
  it("delivers on AA and on CA, reusing one connection", async () => {
    const codes = ["AA", "CA"];
    const receiver = await peer((text, index) => ackText(codes[index] ?? "AA", controlIdOf(text)));
    const sender = destination(receiver.port);
    await sender.deliver(message(1));
    await sender.deliver(message(2));
    expect(receiver.received).toEqual([ADT_A01, ADT_A01.replace("MSG00001", "MSG00002")]);
    expect(receiver.connections()).toBe(1);
  });

  it.each(["AE", "CE"])("rejects the delivery for good on %s", async (code) => {
    const receiver = await peer((text) => ackText(code, controlIdOf(text)));
    const error = await outcome(destination(receiver.port).deliver(message(1)));
    expect(error).toBeInstanceOf(DeliveryRejected);
    expect(error).toMatchObject({ reason: code });
  });

  it.each(["AR", "CR"])("asks for a retry on %s, keeping the connection", async (code) => {
    const receiver = await peer((text, index) =>
      ackText(index === 0 ? code : "AA", controlIdOf(text)),
    );
    const sender = destination(receiver.port);
    const error = await outcome(sender.deliver(message(1)));
    expect(error).toBeInstanceOf(MllpDeliveryError);
    expect(error).toMatchObject({ code: `ACK_${code}` });
    await sender.deliver(message(1));
    expect(receiver.connections()).toBe(1);
  });

  it("asks for a retry when no ACK comes in time, and reconnects for the next attempt", async () => {
    const receiver = await peer((text, index) =>
      index === 0 ? undefined : ackText("AA", controlIdOf(text)),
    );
    const sender = destination(receiver.port, { ackTimeoutMs: 200 });
    const error = await outcome(sender.deliver(message(1)));
    expect(error).toMatchObject({ name: "MllpDeliveryError", code: "ACK_TIMEOUT" });
    await sender.deliver(message(1));
    expect(receiver.connections()).toBe(2);
  });

  it.each([
    ["an ACK it cannot read", "not an ACK", "ACK_UNREADABLE"],
    ["an ACK with no MSA", "MSH|^~\\&|LAB|TESTFAC||||||ACK|X|P|2.5.1\r", "ACK_UNREADABLE"],
    ["an ACK for another message", ackText("AA", "MSG99999"), "ACK_CONTROL_ID_MISMATCH"],
  ])("asks for a retry on %s, and reconnects", async (_what, reply, code) => {
    const receiver = await peer((text, index) =>
      index === 0 ? reply : ackText("AA", controlIdOf(text)),
    );
    const sender = destination(receiver.port);
    expect(await outcome(sender.deliver(message(1)))).toMatchObject({ code });
    await sender.deliver(message(1));
    expect(receiver.connections()).toBe(2);
  });

  it("delivers an output with no HL7 header on any positive ACK, with nothing to match", async () => {
    const receiver = await peer(() => ackText("AA", ""));
    await destination(receiver.port).deliver(message(1, "plain text, not HL7"));
    expect(receiver.received).toEqual(["plain text, not HL7"]);
  });

  it("asks for a retry when the receiver hangs up before answering", async () => {
    const receiver = await peer(() => null);
    const error = await outcome(destination(receiver.port).deliver(message(1)));
    expect(error).toMatchObject({ name: "MllpDeliveryError", code: "MLLP_CONNECTION" });
  });

  it("asks for a retry when nothing listens", async () => {
    const error = await outcome(destination(await freePort()).deliver(message(1)));
    expect(error).toMatchObject({ name: "MllpDeliveryError", code: "ECONNREFUSED" });
  });

  it("rejects for good an output holding an MLLP framing byte, which can never be sent", async () => {
    const receiver = await peer(() => ackText("AA", "MSG00001"));
    const error = await outcome(destination(receiver.port).deliver(message(1, `${ADT_A01}\u000b`)));
    expect(error).toBeInstanceOf(DeliveryRejected);
    expect(error).toMatchObject({ reason: "MLLP_PAYLOAD_CONTAINS_VT" });
  });

  it("closes its connection when stopped", async () => {
    const receiver = await peer((text) => ackText("AA", controlIdOf(text)));
    const sender = destination(receiver.port);
    await sender.deliver(message(1));
    await sender.stop();
    for (let i = 0; i < 50 && receiver.server.getStats().connections > 0; i += 1) await sleep(10);
    expect(receiver.server.getStats().connections).toBe(0);
  });
});

describe("MllpDestination connecting", () => {
  let silent: Server;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    // Accepts connections and never says a word, so a TLS handshake never completes.
    silent = createNetServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  });

  it("gives up connecting after the timeout, and asks for a retry", async () => {
    const address = silent.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const sender = destination(port, { tls: NO_FILES, ackTimeoutMs: 200 });
    const error = await outcome(sender.deliver(message(1)));
    expect(error).toMatchObject({ name: "MllpDeliveryError", code: "CONNECT_TIMEOUT" });
  });
});

describe.skipIf(!OPENSSL)(`MllpDestination ${TLS_TESTS}`, () => {
  let certs: Certificates;
  beforeAll(() => {
    certs = makeCertificates();
  });
  afterAll(() => {
    removeCertificates(certs);
  });
  const trusting = (ca: Buffer) => ({ ca, cert: undefined, key: undefined });
  const answering = (text: string) => ackText("AA", controlIdOf(text));

  it("delivers to a server its ca vouches for", async () => {
    const receiver = await peer(answering, { cert: certs.serverCert, key: certs.serverKey });
    await destination(receiver.port, { tls: trusting(certs.ca) }).deliver(message(1));
    expect(receiver.received).toHaveLength(1);
  });

  it("refuses a server its ca does not vouch for, and asks for a retry", async () => {
    const receiver = await peer(answering, { cert: certs.serverCert, key: certs.serverKey });
    const error = await outcome(
      destination(receiver.port, { tls: trusting(certs.otherCa) }).deliver(message(1)),
    );
    expect(error).toBeInstanceOf(MllpDeliveryError);
    expect(error).toMatchObject({ code: expect.stringMatching(/^[A-Z_]+$/) as unknown });
    expect(receiver.received).toEqual([]);
  });

  it("refuses a server whose certificate names another host, though its ca signed it", async () => {
    const receiver = await peer(answering, { cert: certs.elsewhereCert, key: certs.elsewhereKey });
    const error = await outcome(
      destination(receiver.port, { tls: trusting(certs.ca) }).deliver(message(1)),
    );
    expect(error).toMatchObject({
      name: "MllpDeliveryError",
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    expect(receiver.received).toEqual([]);
  });

  it("checks the certificate against a host name, sent as the TLS server name", async () => {
    const receiver = await peer(answering, { cert: certs.serverCert, key: certs.serverKey });
    const sender = destination(receiver.port, { host: "localhost", tls: trusting(certs.ca) });
    await sender.deliver(message(1));
    expect(receiver.received).toHaveLength(1);
  });

  it("presents its client certificate to a server that requires one", async () => {
    const receiver = await peer(answering, {
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    const tls = { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey };
    await destination(receiver.port, { tls }).deliver(message(1));
    expect(receiver.received).toHaveLength(1);
  });

  it("without a client certificate, is refused by a server that requires one, and asks for a retry", async () => {
    const receiver = await peer(answering, {
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    const error = await outcome(
      destination(receiver.port, { tls: trusting(certs.ca) }).deliver(message(1)),
    );
    expect(error).toBeInstanceOf(MllpDeliveryError);
    expect(receiver.received).toEqual([]);
  });
});
