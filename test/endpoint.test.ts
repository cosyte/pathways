import type * as crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../src/config/load.js";
import type { ListenerConfig } from "../src/config/schema.js";
import {
  bearerMatches,
  Endpoint,
  listenerSecurity,
  listenerWarnings,
  readEnv,
  reply,
} from "../src/connectors/endpoint.js";
import { loadClientTls, loadServerTls, serverTlsOptions } from "../src/connectors/tls.js";
import { makeCertificates, removeCertificates, send, type Certificates } from "./net-helpers.js";

// Wraps the real timingSafeEqual so a test can see that token checks go through it.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const TOKEN = "synthetic-token-0123456789abcdef";

let certs: Certificates;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

const endpoints: Endpoint[] = [];
afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  vi.mocked(timingSafeEqual).mockClear();
});

async function listening(
  options: Partial<ConstructorParameters<typeof Endpoint>[0]>,
  handler: ConstructorParameters<typeof Endpoint>[1] = (_request, response) => {
    reply(response, 200, { ok: true });
    return Promise.resolve();
  },
): Promise<Endpoint & { port: number }> {
  const endpoint = new Endpoint(
    { host: "127.0.0.1", port: 0, tls: undefined, token: undefined, ...options },
    handler,
  );
  endpoints.push(endpoint);
  await endpoint.listen();
  return endpoint as Endpoint & { port: number };
}

function listener(overrides: Partial<ListenerConfig> = {}): ListenerConfig {
  return {
    host: "127.0.0.1",
    port: 9_999,
    tls: { cert: certs.files.serverCert, key: certs.files.serverKey, ca: undefined },
    plaintext: false,
    auth: { kind: "bearer", env: "SYNTH_TOKEN" },
    ...overrides,
  };
}

function problemOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems.join("\n");
    throw error;
  }
  return undefined;
}

describe("bearerMatches", () => {
  it("accepts the token under a Bearer scheme in any case, and nothing else", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer  ${TOKEN} `, TOKEN)).toBe(true);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches("", TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
  });

  it("compares in constant time: equal-length digests through timingSafeEqual, every time", () => {
    const compare = vi.mocked(timingSafeEqual);
    for (const header of [
      undefined,
      "Bearer short",
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}${TOKEN}`,
    ]) {
      compare.mockClear();
      bearerMatches(header, TOKEN);
      expect(compare).toHaveBeenCalledTimes(1);
      const [a, b] = compare.mock.calls[0] as unknown as [Buffer, Buffer];
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });
});

describe("readEnv and listenerSecurity", () => {
  it("reads a set variable and refuses an unset or empty one, naming the key and variable", () => {
    expect(readEnv({ A: "x" }, "A", "f: k")).toBe("x");
    expect(problemOf(() => readEnv({}, "A", "f: k"))).toBe(
      "f: k: the environment variable A is not set",
    );
    expect(problemOf(() => readEnv({ A: "" }, "A", "f: k"))).toBe(
      "f: k: the environment variable A is not set",
    );
  });

  it("loads TLS and the token, or neither", () => {
    const secured = listenerSecurity(listener(), { SYNTH_TOKEN: TOKEN }, "f: source.http");
    expect(secured.token).toBe(TOKEN);
    expect(secured.tls?.cert).toEqual(certs.serverCert);
    const open = listenerSecurity(
      listener({ tls: undefined, plaintext: true, auth: { kind: "none" } }),
      {},
      "f: source.http",
    );
    expect(open).toEqual({ tls: undefined, token: undefined });
  });

  it("refuses a missing, short or malformed token without printing it", () => {
    expect(problemOf(() => listenerSecurity(listener(), {}, "f: source.http"))).toBe(
      "f: source.http.auth: the environment variable SYNTH_TOKEN is not set",
    );
    for (const weak of ["short-token", "synthetic token with spaces"]) {
      const problem = problemOf(() =>
        listenerSecurity(listener(), { SYNTH_TOKEN: weak }, "f: source.http"),
      );
      expect(problem).toBe(
        "f: source.http.auth: the token in SYNTH_TOKEN must be at least 16 characters of letters, digits and -._~+/",
      );
      expect(problem).not.toContain(weak);
    }
  });

  it("refuses TLS files that cannot be read or do not load together, naming the key only", () => {
    const missing = listener({
      tls: { cert: join(certs.dir, "TESTPATIENT.crt"), key: certs.files.serverKey, ca: undefined },
    });
    const problem = problemOf(() => listenerSecurity(missing, { SYNTH_TOKEN: TOKEN }, "f: s"));
    expect(problem).toBe("f: s.tls.cert: could not be read (ENOENT)");
    const mismatched = listener({
      tls: { cert: certs.files.serverCert, key: certs.files.clientKey, ca: undefined },
    });
    expect(problemOf(() => listenerSecurity(mismatched, { SYNTH_TOKEN: TOKEN }, "f: s"))).toMatch(
      /^f: s\.tls: the certificate, key and CA do not load together \(\w+\)$/,
    );
  });

  it("reads the client CA for mutual TLS, and asks clients for certificates only then", () => {
    const material = loadServerTls(
      { cert: certs.files.serverCert, key: certs.files.serverKey, ca: certs.files.ca },
      "f: s.tls",
    );
    expect(serverTlsOptions(material)).toMatchObject({
      requestCert: true,
      rejectUnauthorized: true,
    });
    const plain = loadServerTls(
      { cert: certs.files.serverCert, key: certs.files.serverKey, ca: undefined },
      "f: s.tls",
    );
    expect(serverTlsOptions(plain)).toMatchObject({ requestCert: false, rejectUnauthorized: true });
    expect(() =>
      loadServerTls(
        { cert: certs.files.serverCert, key: certs.files.serverKey, ca: join(certs.dir, "x") },
        "f: s.tls",
      ),
    ).toThrow("f: s.tls.ca: could not be read (ENOENT)");
  });

  it("reads a destination's CA and client certificate, any of them optional", () => {
    expect(loadClientTls({ ca: undefined, cert: undefined, key: undefined }, "f: d")).toEqual({
      ca: undefined,
      cert: undefined,
      key: undefined,
    });
    const full = loadClientTls(
      { ca: certs.files.ca, cert: certs.files.clientCert, key: certs.files.clientKey },
      "f: d",
    );
    expect(full.cert).toEqual(certs.clientCert);
    const garbage = join(certs.dir, "garbage.crt");
    writeFileSync(garbage, "not a certificate");
    expect(
      problemOf(() => loadClientTls({ ca: garbage, cert: undefined, key: undefined }, "f: d")),
    ).toMatch(/^f: d: the certificate, key and CA do not load together/);
    expect(
      problemOf(() =>
        loadClientTls({ ca: undefined, cert: certs.files.clientCert, key: garbage }, "f: d"),
      ),
    ).toMatch(/^f: d: the certificate, key and CA do not load together/);
  });
});

describe("listenerWarnings", () => {
  it("warns of plaintext, and of no authentication unless mutual TLS stands in", () => {
    expect(listenerWarnings(listener())).toEqual([]);
    expect(
      listenerWarnings(listener({ tls: undefined, plaintext: true, auth: { kind: "none" } })),
    ).toEqual(["plaintext", "unauthenticated"]);
    expect(listenerWarnings(listener({ auth: { kind: "none" } }))).toEqual(["unauthenticated"]);
    expect(
      listenerWarnings(
        listener({
          tls: { cert: "c", key: "k", ca: "ca" },
          auth: { kind: "none" },
        }),
      ),
    ).toEqual([]);
  });
});

describe("Endpoint", () => {
  it("refuses a request without the token with 401 before the handler runs", async () => {
    const refused: number[] = [];
    let handled = 0;
    const endpoint = await listening(
      { token: TOKEN, onRefused: (status) => refused.push(status) },
      (_request, response) => {
        handled += 1;
        reply(response, 200, {});
        return Promise.resolve();
      },
    );
    const denied = await send(endpoint.port, { method: "GET" });
    expect(denied.status).toBe(401);
    expect(denied.headers["www-authenticate"]).toBe("Bearer");
    expect(JSON.parse(denied.body)).toEqual({ error: "Unauthorized" });
    const wrong = await send(endpoint.port, {
      method: "GET",
      headers: { Authorization: "Bearer synthetic-wrong-token-000000" },
    });
    expect(wrong.status).toBe(401);
    expect(handled).toBe(0);
    const allowed = await send(endpoint.port, {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(200);
    expect(handled).toBe(1);
    expect(refused).toEqual([401, 401]);
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(3);
  });

  it("answers 500 when a handler fails before answering, and drops the connection after", async () => {
    const before = await listening({}, () => Promise.reject(new Error("synthetic")));
    expect((await send(before.port)).status).toBe(500);
    const after = await listening({}, (_request, response) => {
      response.writeHead(200);
      response.write("partial");
      return Promise.reject(new Error("synthetic"));
    });
    await expect(send(after.port)).rejects.toThrow();
  });

  it("reports its port only while listening, and listens once", async () => {
    const endpoint = new Endpoint(
      { host: "127.0.0.1", port: 0, tls: undefined, token: undefined },
      () => Promise.resolve(),
    );
    expect(endpoint.port).toBeUndefined();
    await endpoint.listen();
    const port = endpoint.port;
    await endpoint.listen();
    expect(endpoint.port).toBe(port);
    await endpoint.close();
    expect(endpoint.port).toBeUndefined();
    await endpoint.close();
  });

  it("rejects when its port is taken, and can listen later", async () => {
    const holder = await listening({});
    const port = holder.port;
    const second = new Endpoint({ host: "127.0.0.1", port, tls: undefined, token: undefined }, () =>
      Promise.resolve(),
    );
    await expect(second.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(second.port).toBeUndefined();
    await holder.close();
    await second.listen();
    expect(second.port).toBe(port);
    await second.close();
  });

  it("lets a request in flight finish when closing, then cuts what is left after the grace", async () => {
    let release: (() => void) | undefined;
    const slow = await listening({ closeGraceMs: 5_000 }, async (_request, response) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      reply(response, 200, {});
    });
    const answer = send(slow.port);
    await vi.waitFor(() => expect(release).toBeDefined());
    const closing = slow.close();
    release?.();
    expect((await answer).status).toBe(200);
    await closing;

    const stuck = await listening({ closeGraceMs: 20 }, () => new Promise<void>(() => undefined));
    const cut = send(stuck.port);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stuck.close();
    await expect(cut).rejects.toThrow();
  });

  it("serves HTTPS, and with a client CA refuses a client without a trusted certificate", async () => {
    const tls = loadServerTls(
      { cert: certs.files.serverCert, key: certs.files.serverKey, ca: certs.files.ca },
      "f: s",
    );
    const endpoint = await listening({ tls });
    expect(
      (await send(endpoint.port, { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey }))
        .status,
    ).toBe(200);
    await expect(send(endpoint.port, { ca: certs.ca })).rejects.toThrow();
    await expect(
      send(endpoint.port, { ca: certs.ca, cert: certs.otherClientCert, key: certs.otherClientKey }),
    ).rejects.toThrow();
    await expect(send(endpoint.port)).rejects.toThrow();
  });
});
