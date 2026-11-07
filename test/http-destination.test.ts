import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  classifyStatus,
  HttpDestination,
  transientError,
  type HttpDestinationOptions,
} from "../src/connectors/http.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import { ADT_A01 } from "./helpers.js";
import {
  freePort,
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

describe("classifyStatus", () => {
  it("delivers 2xx, retries 408, 429, 5xx, 1xx and 3xx, and rejects any other 4xx", () => {
    expect([200, 201, 202, 204, 299].map(classifyStatus)).toEqual(Array(5).fill("delivered"));
    expect([408, 429, 500, 502, 503, 504, 599, 101, 301, 302, 304].map(classifyStatus)).toEqual(
      Array(11).fill("retry"),
    );
    expect([400, 401, 403, 404, 409, 413, 415, 422, 499].map(classifyStatus)).toEqual(
      Array(9).fill("rejected"),
    );
  });

  it("makes plain errors with a code and no other text", () => {
    const error = transientError("HTTP_503");
    expect(error.code).toBe("HTTP_503");
    expect(error.message).toBe("the HTTP delivery did not complete (HTTP_503)");
  });
});

describe("HttpDestination", () => {
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

  it.each([408, 429, 500, 502, 503, 301])(
    "retries %i with a plain error coded HTTP_%i",
    async (code) => {
      const r = await plainReceiver(code);
      const error = await outcomeOf(
        destination({ url: r.url }).deliver({ messageId: 1, seq: 0, body: BODY }),
      );
      expect(error).not.toBeInstanceOf(DeliveryRejected);
      expect(error).toMatchObject({ code: `HTTP_${code}` });
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
    const port = await freePort();
    const error = await outcomeOf(
      destination({ url: `http://127.0.0.1:${port}/in` }).deliver({
        messageId: 1,
        seq: 0,
        body: BODY,
      }),
    );
    expect(error).toMatchObject({ code: "ECONNREFUSED" });
    expect(error).not.toBeInstanceOf(DeliveryRejected);
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
});
