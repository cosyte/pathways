import type { Socket } from "node:net";
import { createServer, type AddressInfo, type Server } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { HttpDestination, type HttpDestinationOptions } from "../src/connectors/http.js";
import { RedirectHeld, RetryableError } from "../src/connectors/http-core.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import { ADT_A01 } from "./helpers.js";
import {
  CLOSED_PORT,
  makeCertificates,
  receiver,
  removeCertificates,
  status,
  type Certificates,
  type Receiver,
} from "./net-helpers.js";

let certs: Certificates;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

const receivers: Receiver[] = [];
const destinations: HttpDestination[] = [];
afterEach(async () => {
  await Promise.all(destinations.splice(0).map((destination) => destination.stop()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
});

const BODY = new TextEncoder().encode(ADT_A01);

async function plainReceiver(code: number): Promise<Receiver> {
  const r = await receiver(status(code));
  receivers.push(r);
  return r;
}

function destination(options: Partial<HttpDestinationOptions> & { url: string }): HttpDestination {
  const built = new HttpDestination({ headers: {}, timeoutMs: 2_000, ...options });
  destinations.push(built);
  return built;
}

async function outcomeOf(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
    return "delivered";
  } catch (error) {
    return error;
  }
}

describe("HttpDestination", () => {
  it("names a possible duplicate in its resend header, and sends the header on no other request", async () => {
    const r = await plainReceiver(200);
    const target = destination({ url: r.url, resendHeader: "X-Synthetic-Resend" });
    const resent = { messageId: 1, seq: 0, body: BODY, resend: { previousAttempts: 2 } };
    expect(await outcomeOf(target.deliver(resent))).toBe("delivered");
    expect(await outcomeOf(target.deliver({ messageId: 2, seq: 0, body: BODY }))).toBe("delivered");
    expect(r.received.map((request) => request.headers["x-synthetic-resend"])).toEqual([
      "2",
      undefined,
    ]);
    // The message itself is sent unchanged.
    expect(r.received.map((request) => request.body.toString())).toEqual([ADT_A01, ADT_A01]);

    // Without the setting, a resend goes out exactly as the first send did.
    const plain = destination({ url: r.url });
    expect(await outcomeOf(plain.deliver(resent))).toBe("delivered");
    expect(r.received[2]?.headers["x-synthetic-resend"]).toBeUndefined();
  });

  it("delivers on a 2xx whose body breaks off, and the broken body does not stop the next delivery", async () => {
    let answered = 0;
    const r = await receiver((_request, response) => {
      answered += 1;
      if (answered > 1) {
        status(200)(_request, response);
        return;
      }
      response.writeHead(200, { "Content-Length": "100" });
      response.write("synthetic");
      setTimeout(() => response.socket?.destroy(), 20);
    });
    receivers.push(r);
    const target = destination({ url: r.url });
    expect(await outcomeOf(target.deliver({ messageId: 1, seq: 0, body: BODY }))).toBe("delivered");
    // Long enough for the body to break off and its error to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await outcomeOf(target.deliver({ messageId: 2, seq: 0, body: BODY }))).toBe("delivered");
    expect(r.received).toHaveLength(2);
  });

  it("POSTs the body with its headers and Content-Length, and resolves on 2xx", async () => {
    const r = await plainReceiver(204);
    const sent = destination({
      url: r.url,
      headers: { "Content-Type": "application/hl7-v2", "X-Synthetic": "yes" },
    });
    expect(await outcomeOf(sent.deliver({ messageId: 1, seq: 0, body: BODY }))).toBe("delivered");
    expect(r.received).toHaveLength(1);
    const [request] = r.received;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/in");
    expect(request?.headers["content-type"]).toBe("application/hl7-v2");
    expect(request?.headers["x-synthetic"]).toBe("yes");
    expect(request?.headers["content-length"]).toBe(String(BODY.byteLength));
    expect(request?.body.toString("utf8")).toBe(ADT_A01);

    // The kept-alive connection carries the next delivery too.
    await sent.deliver({ messageId: 2, seq: 0, body: BODY });
    expect(r.received).toHaveLength(2);
  });

  it.each([408, 425, 429, 500, 502, 503])(
    "retries %i with a plain error coded HTTP_%i",
    async (code) => {
      const r = await plainReceiver(code);
      const error = await outcomeOf(
        destination({ url: r.url }).deliver({ messageId: 1, seq: 0, body: BODY }),
      );
      expect(error).not.toBeInstanceOf(DeliveryRejected);
      expect(error).toBeInstanceOf(RetryableError);
      expect(error).not.toBeInstanceOf(RedirectHeld);
      expect(error).toMatchObject({ code: `HTTP_${code}`, retryAfterMs: undefined });
      expect((error as Error).message).not.toContain("synthetic answer");
    },
  );

  it.each([400, 401, 404, 409, 422])(
    "rejects %i for good, with the status as its reason",
    async (code) => {
      const r = await plainReceiver(code);
      const error = await outcomeOf(
        destination({ url: r.url }).deliver({ messageId: 1, seq: 0, body: BODY }),
      );
      expect(error).toBeInstanceOf(DeliveryRejected);
      expect((error as DeliveryRejected).reason).toBe(`HTTP ${code}`);
    },
  );

  it("retries a refused connection with the network's code", async () => {
    const error = await outcomeOf(
      destination({ url: `http://127.0.0.1:${CLOSED_PORT}/in` }).deliver({
        messageId: 1,
        seq: 0,
        body: BODY,
      }),
    );
    expect(error).toMatchObject({ code: "ECONNREFUSED", retryAfterMs: undefined });
    expect(error).toBeInstanceOf(RetryableError);
  });

  it("gives up an attempt that takes longer than its timeout, as a retry coded ETIMEDOUT", async () => {
    const r = await receiver(() => undefined);
    receivers.push(r);
    const started = Date.now();
    const error = await outcomeOf(
      destination({ url: r.url, timeoutMs: 100 }).deliver({ messageId: 1, seq: 0, body: BODY }),
    );
    expect(error).toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("verifies the server's certificate: an untrusted one is a retry, never a delivery", async () => {
    const r = await receiver(status(200), { cert: certs.serverCert, key: certs.serverKey });
    receivers.push(r);
    const untrusted = await outcomeOf(
      destination({ url: r.url }).deliver({ messageId: 1, seq: 0, body: BODY }),
    );
    expect(untrusted).toMatchObject({ code: expect.stringMatching(/CERT|SIGNATURE/) as unknown });
    expect(r.received).toHaveLength(0);

    const trusted = destination({
      url: r.url,
      tls: { ca: certs.ca, cert: undefined, key: undefined },
    });
    expect(await outcomeOf(trusted.deliver({ messageId: 1, seq: 0, body: BODY }))).toBe(
      "delivered",
    );
    expect(r.received).toHaveLength(1);
  });

  it("presents a client certificate to a server that requires one (mutual TLS)", async () => {
    const r = await receiver(status(200), {
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: certs.ca,
    });
    receivers.push(r);
    const without = await outcomeOf(
      destination({ url: r.url, tls: { ca: certs.ca, cert: undefined, key: undefined } }).deliver({
        messageId: 1,
        seq: 0,
        body: BODY,
      }),
    );
    expect(without).toMatchObject({ code: expect.any(String) as unknown });
    const withCert = destination({
      url: r.url,
      tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey },
    });
    expect(await outcomeOf(withCert.deliver({ messageId: 1, seq: 0, body: BODY }))).toBe(
      "delivered",
    );
    expect(r.received.map((request) => request.authorized)).toEqual([true]);
  });

  it("reads Retry-After on a 429 and a 503, by the clock it was given", async () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 0);
    const seconds = await answering(429, { "Retry-After": "120" });
    expect(await outcomeOf(destination({ url: seconds.url }).deliver(ONE))).toMatchObject({
      code: "HTTP_429",
      retryAfterMs: 120_000,
    });
    const date = await answering(503, { "Retry-After": "Tue, 10 Nov 2026 12:00:30 GMT" });
    expect(
      await outcomeOf(destination({ url: date.url, now: () => now }).deliver(ONE)),
    ).toMatchObject({ code: "HTTP_503", retryAfterMs: 30_000 });
  });

  it("ignores Retry-After on any other status, and a repeated one", async () => {
    for (const code of [408, 500, 502]) {
      const r = await answering(code, { "Retry-After": "120" });
      expect(await outcomeOf(destination({ url: r.url }).deliver(ONE))).toMatchObject({
        code: `HTTP_${code}`,
        retryAfterMs: undefined,
      });
    }
    const ok = await answering(200, { "Retry-After": "120" });
    expect(await outcomeOf(destination({ url: ok.url }).deliver(ONE))).toBe("delivered");
    const twice = await answering(429, { "Retry-After": ["120", "120"] });
    expect(await outcomeOf(destination({ url: twice.url }).deliver(ONE))).toMatchObject({
      code: "HTTP_429",
      retryAfterMs: undefined,
    });
  });

  it("drains a 429's body and sends the next attempt on the same kept-alive connection", async () => {
    const sockets = new Set<unknown>();
    let answered = 0;
    const r = await receiver((request, response) => {
      sockets.add(request.socket);
      answered += 1;
      if (answered === 1) {
        response.writeHead(429, { "Retry-After": "1", "Content-Type": "text/plain" });
        response.end("synthetic slow down ".repeat(1_000));
      } else status(200)(request, response);
    });
    receivers.push(r);
    const target = destination({ url: r.url });
    expect(await outcomeOf(target.deliver(ONE))).toMatchObject({ retryAfterMs: 1_000 });
    expect(await outcomeOf(target.deliver(ONE))).toBe("delivered");
    expect(r.received).toHaveLength(2);
    expect(sockets.size).toBe(1);
  });

  it("holds a 301 without following it, naming only the Location's host", async () => {
    const elsewhere = await counting();
    const location = `http://127.0.0.1:${elsewhere.port}/TESTPATIENT/records?mrn=SYNTH0001`;
    const r = await answering(301, { Location: location });
    const error = await outcomeOf(destination({ url: r.url }).deliver(ONE));
    expect(error).toBeInstanceOf(RedirectHeld);
    expect(error).toMatchObject({
      code: "HTTP_301",
      status: 301,
      locationHost: `127.0.0.1:${elsewhere.port}`,
    });
    expect(JSON.stringify(error)).not.toContain("TESTPATIENT");
    expect((error as Error).message).not.toContain("SYNTH0001");
    // Long enough for a followed redirect to have connected.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(elsewhere.connections()).toBe(0);
    expect(r.received).toHaveLength(1);
  });

  it("names the destination's own host for a relative Location, and none for a missing or unusable one", async () => {
    const relative = await answering(302, { Location: "/elsewhere?mrn=SYNTH0001" });
    expect(await outcomeOf(destination({ url: relative.url }).deliver(ONE))).toMatchObject({
      status: 302,
      locationHost: `127.0.0.1:${relative.port}`,
    });
    for (const headers of [
      {},
      { Location: "http://[not-a-host" },
      { Location: "mailto:x@example.test" },
    ]) {
      const r = await answering(307, headers);
      const error = await outcomeOf(destination({ url: r.url }).deliver(ONE));
      expect(error).toBeInstanceOf(RedirectHeld);
      expect(error).toMatchObject({ status: 307, locationHost: undefined });
    }
  });
});

const ONE = { messageId: 1, seq: 0, body: BODY };

/** A receiver answering every request with `code` and `headers`, closed after the test. */
async function answering(
  code: number,
  headers: Readonly<Record<string, string | string[]>>,
): Promise<Receiver> {
  const r = await receiver((_request, response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    status(code)(_request, response);
  });
  receivers.push(r);
  return r;
}

/** A TCP server that only counts the connections made to it, closed after the test. */
async function counting(): Promise<{ port: number; connections: () => number }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receivers.push({
    port: 0,
    url: "",
    received: [],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
  return { port: (server.address() as AddressInfo).port, connections: () => sockets.length };
}

/** A TCP server that writes `raw` once a request arrives, then ends the socket when `end` says. */
async function rawAnswer(raw: string, end: boolean): Promise<string> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => {
      socket.write(raw);
      if (end) socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receivers.push({
    port: 0,
    url: "",
    received: [],
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
}

// What Node does with a 1xx, so the docs can say it: an interim answer (100, 102, 103) never
// reaches the status table. Node waits for the final answer after it, so the attempt is retried
// when none comes. A 101 Switching Protocols, which a destination never asks for, is rejected.
describe("HttpDestination and 1xx answers", () => {
  it("waits past an interim 1xx for the final answer", async () => {
    const url = await rawAnswer(
      "HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
      false,
    );
    expect(await outcomeOf(destination({ url }).deliver(ONE))).toBe("delivered");
  });

  it("retries when no final answer follows a 1xx: the time limit, or the closed connection", async () => {
    const silent = await rawAnswer("HTTP/1.1 102 Processing\r\n\r\n", false);
    const timedOut = await outcomeOf(destination({ url: silent, timeoutMs: 200 }).deliver(ONE));
    expect(timedOut).toBeInstanceOf(RetryableError);
    expect(timedOut).toMatchObject({ code: "ETIMEDOUT" });

    const closed = await rawAnswer("HTTP/1.1 100 Continue\r\n\r\n", true);
    const reset = await outcomeOf(destination({ url: closed }).deliver(ONE));
    expect(reset).toBeInstanceOf(RetryableError);
  });

  // Node hands a 101 that names an upgrade to an `upgrade` listener, never to `response`, and with
  // no listener it leaves the attempt unsettled past its time limit: the destination stalled.
  it("rejects an unasked 101 that names an upgrade for good, within the time limit", async () => {
    const upgraded = await rawAnswer(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: synthetic\r\n\r\n",
      false,
    );
    const started = Date.now();
    const error = await outcomeOf(destination({ url: upgraded, timeoutMs: 2_000 }).deliver(ONE));
    expect(error).toBeInstanceOf(DeliveryRejected);
    expect((error as DeliveryRejected).reason).toBe("HTTP 101");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects a 101 with no Upgrade header for good, which Node hands over as an answer", async () => {
    const url = await rawAnswer("HTTP/1.1 101 Switching Protocols\r\n\r\n", false);
    const error = await outcomeOf(destination({ url }).deliver(ONE));
    expect(error).toBeInstanceOf(DeliveryRejected);
    expect((error as DeliveryRejected).reason).toBe("HTTP 101");
  });
});
