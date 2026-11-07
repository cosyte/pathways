import { connect } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { HttpSource, type HttpSourceOptions } from "../src/connectors/http.js";
import type { MessageSink } from "../src/connectors/types.js";
import { ADT_A01 } from "./helpers.js";
import { makeCertificates, removeCertificates, send, type Certificates } from "./net-helpers.js";

const TOKEN = "synthetic-token-0123456789abcdef";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let certs: Certificates;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

const sources: HttpSource[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop()));
});

/** A sink that keeps what it is given, or fails when told to. */
function memorySink(): MessageSink & { bodies: string[]; failing: boolean } {
  const sink = {
    bodies: [] as string[],
    failing: false,
    receive(body: Uint8Array): Promise<number> {
      if (sink.failing) return Promise.reject(new Error("synthetic storage failure"));
      sink.bodies.push(Buffer.from(body).toString("utf8"));
      return Promise.resolve(sink.bodies.length);
    },
  };
  return sink;
}

async function started(
  options: Partial<HttpSourceOptions> = {},
  sink: MessageSink = memorySink(),
): Promise<{ source: HttpSource; port: number; refused: number[] }> {
  const refused: number[] = [];
  const source = new HttpSource({
    host: "127.0.0.1",
    port: 0,
    path: "/messages",
    maxBytes: 1_024,
    tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
    token: TOKEN,
    onRefused: (status) => refused.push(status),
    ...options,
  });
  sources.push(source);
  await source.start(sink);
  return { source, port: source.port ?? 0, refused };
}

describe("HttpSource", () => {
  it("stores a POSTed body and answers 202 with its id, never echoing the body", async () => {
    const sink = memorySink();
    const { port } = await started({}, sink);
    const answer = await send(port, {
      path: "/messages",
      headers: AUTH,
      body: ADT_A01,
      ca: certs.ca,
    });
    expect(answer.status).toBe(202);
    expect(answer.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(answer.body)).toEqual({ id: 1 });
    expect(answer.body).not.toContain("MSH");
    expect(sink.bodies).toEqual([ADT_A01]);

    // A query string does not change the path.
    const second = await send(port, {
      path: "/messages?from=synth",
      headers: { ...AUTH, "Content-Encoding": "identity" },
      body: ADT_A01,
      ca: certs.ca,
    });
    expect(JSON.parse(second.body)).toEqual({ id: 2 });
  });

  it("refuses a request without the bearer token with 401, storing nothing", async () => {
    const sink = memorySink();
    const { port, refused } = await started({}, sink);
    for (const headers of [{}, { Authorization: "Bearer synthetic-wrong-token-0000" }]) {
      const answer = await send(port, { path: "/messages", headers, body: ADT_A01, ca: certs.ca });
      expect(answer.status).toBe(401);
      expect(answer.body).not.toContain("MSH");
    }
    expect(sink.bodies).toEqual([]);
    expect(refused).toEqual([401, 401]);
  });

  it("answers 404 on another path, 405 for another method, 415 for a compressed body, 400 for an empty one", async () => {
    const sink = memorySink();
    const { port, refused } = await started({}, sink);
    const base = { headers: AUTH, ca: certs.ca };
    expect((await send(port, { ...base, path: "/other", body: ADT_A01 })).status).toBe(404);
    const get = await send(port, { ...base, path: "/messages", method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
    const gzip = await send(port, {
      ...base,
      path: "/messages",
      headers: { ...AUTH, "Content-Encoding": "gzip" },
      body: "synthetic",
    });
    expect(gzip.status).toBe(415);
    expect((await send(port, { ...base, path: "/messages", body: "" })).status).toBe(400);
    expect(sink.bodies).toEqual([]);
    expect(refused).toEqual([404, 405, 415, 400]);
  });

  it("answers 413 for a body over maxBytes, declared or streamed", async () => {
    const sink = memorySink();
    const { port, refused } = await started({ maxBytes: 16 }, sink);
    const big = "x".repeat(64);
    const declared = await send(port, {
      path: "/messages",
      headers: AUTH,
      body: big,
      ca: certs.ca,
    });
    expect(declared.status).toBe(413);
    const streamed = await send(port, {
      path: "/messages",
      headers: { ...AUTH, "Transfer-Encoding": "chunked" },
      body: big,
      ca: certs.ca,
    });
    expect(streamed.status).toBe(413);
    const fits = await send(port, {
      path: "/messages",
      headers: AUTH,
      body: "x".repeat(16),
      ca: certs.ca,
    });
    expect(fits.status).toBe(202);
    expect(refused).toEqual([413, 413]);
    expect(sink.bodies).toEqual(["x".repeat(16)]);
  });

  it("answers 503 when the message cannot be stored, so the sender sends it again", async () => {
    const sink = memorySink();
    sink.failing = true;
    const { port } = await started({}, sink);
    const answer = await send(port, {
      path: "/messages",
      headers: AUTH,
      body: ADT_A01,
      ca: certs.ca,
    });
    expect(answer.status).toBe(503);
    expect(answer.body).not.toContain("synthetic storage failure");
    expect(answer.body).not.toContain("MSH");
  });

  it("stores nothing from a sender that goes away mid-body", async () => {
    const sink = memorySink();
    const { port } = await started({ tls: undefined }, sink);
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /messages HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 100\r\n\r\npartial`,
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 20);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sink.bodies).toEqual([]);
    // Still serving.
    const answer = await send(port, { path: "/messages", headers: AUTH, body: "synthetic" });
    expect(answer.status).toBe(202);
  });

  it("takes messages without a token when none is required, over plaintext when allowed", async () => {
    const sink = memorySink();
    const { port } = await started({ tls: undefined, token: undefined }, sink);
    expect((await send(port, { path: "/messages", body: "synthetic" })).status).toBe(202);
  });

  it("with mutual TLS takes messages only from clients holding a certificate the CA signed", async () => {
    const sink = memorySink();
    const { port } = await started(
      { tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca }, token: undefined },
      sink,
    );
    const trusted = await send(port, {
      path: "/messages",
      body: "synthetic",
      ca: certs.ca,
      cert: certs.clientCert,
      key: certs.clientKey,
    });
    expect(trusted.status).toBe(202);
    await expect(
      send(port, { path: "/messages", body: "synthetic", ca: certs.ca }),
    ).rejects.toThrow();
    await expect(
      send(port, {
        path: "/messages",
        body: "synthetic",
        ca: certs.ca,
        cert: certs.otherClientCert,
        key: certs.otherClientKey,
      }),
    ).rejects.toThrow();
    expect(sink.bodies).toEqual(["synthetic"]);
  });

  it("can require both a client certificate and the token", async () => {
    const { port } = await started({
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca },
    });
    const tls = { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey };
    expect((await send(port, { path: "/messages", body: "x", ...tls })).status).toBe(401);
    expect((await send(port, { path: "/messages", body: "x", headers: AUTH, ...tls })).status).toBe(
      202,
    );
  });

  it("reports no port before start or after stop, and stops twice safely", async () => {
    const { source } = await started();
    expect(source.port).toBeGreaterThan(0);
    await source.stop();
    expect(source.port).toBeUndefined();
    await source.stop();
    const unstarted = new HttpSource({
      host: "127.0.0.1",
      port: 0,
      path: "/",
      maxBytes: 1,
      tls: undefined,
      token: undefined,
    });
    expect(unstarted.port).toBeUndefined();
    await unstarted.start(memorySink());
    expect(unstarted.port).toBeGreaterThan(0);
    await unstarted.stop();
  });
});
