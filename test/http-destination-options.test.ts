import type { LookupAddress, lookup as dnsLookup } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";

import { ADDRESS_REFUSED, AddressGuard, parseNetwork } from "../src/connectors/address-guard.js";
import { HttpDestination, type HttpDestinationOptions } from "../src/connectors/http.js";
import { RetryableError } from "../src/connectors/http-core.js";
import {
  queryValueProblem,
  templateProblem,
  UrlTemplate,
} from "../src/connectors/http-template.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import { Engine } from "../src/engine/engine.js";
import { Store, type MessageStore } from "../src/storage/store.js";
import { ADT_A01, captureLogger, cleanUp, LAB_TRANSFORM, makeProject } from "./helpers.js";
import { MemoryStore } from "./memory-store.js";
import {
  makeCertificates,
  receiver,
  removeCertificates,
  status,
  type Certificates,
  type Receiver,
} from "./net-helpers.js";

const receivers: Receiver[] = [];
const destinations: HttpDestination[] = [];
const engines: Engine[] = [];
const stores: MessageStore[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(destinations.splice(0).map((destination) => destination.stop()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

let certs: Certificates;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

// Synthetic only: a made-up order, never a real message.
const BODY = new TextEncoder().encode('{"resourceType":"Basic","id":"synthetic-1"}');

async function lab(
  answer: (request: IncomingMessage, response: ServerResponse) => void = status(200),
): Promise<Receiver> {
  const r = await receiver(answer);
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

/** The receiver's URL with its path swapped for `path`. */
function at(r: Receiver, path: string): string {
  return `http://127.0.0.1:${r.port}${path}`;
}

describe("an HTTP destination's method", () => {
  it.each(["PUT", "PATCH"] as const)("sends %s with the body and its length", async (method) => {
    const r = await lab();
    const target = destination({
      url: r.url,
      method,
      headers: { "Content-Type": "application/fhir+json" },
    });
    expect(await outcomeOf(target.deliver({ messageId: 1, seq: 0, body: BODY }))).toBe("delivered");
    expect(r.received[0]).toMatchObject({ method, url: "/in" });
    expect(r.received[0]?.headers["content-length"]).toBe(String(BODY.byteLength));
    expect(r.received[0]?.headers["content-type"]).toBe("application/fhir+json");
    expect(r.received[0]?.body).toEqual(Buffer.from(BODY));
  });

  it.each(["GET", "DELETE"] as const)(
    "sends %s with no body, no length and no content type",
    async (method) => {
      const r = await lab();
      const target = destination({
        url: r.url,
        method,
        headers: { "content-type": "application/fhir+json", "X-Synthetic": "yes" },
      });
      expect(await outcomeOf(target.deliver({ messageId: 1, seq: 0, body: BODY }))).toBe(
        "delivered",
      );
      const [request] = r.received;
      expect(request?.method).toBe(method);
      expect(request?.body.byteLength).toBe(0);
      expect(request?.headers["content-length"]).toBeUndefined();
      expect(request?.headers["transfer-encoding"]).toBeUndefined();
      expect(request?.headers["content-type"]).toBeUndefined();
      expect(request?.headers["x-synthetic"]).toBe("yes");
    },
  );

  it("POSTs by default", async () => {
    const r = await lab();
    await destination({ url: r.url }).deliver({ messageId: 1, seq: 0, body: BODY });
    expect(r.received[0]?.method).toBe("POST");
  });
});

describe("an HTTP destination's idempotency header", () => {
  it("carries the message id and seq, the same on every attempt of one output", async () => {
    const r = await lab();
    const target = destination({ url: r.url, idempotencyHeader: "Idempotency-Key" });
    await target.deliver({ messageId: 7, seq: 2, body: BODY });
    await target.deliver({ messageId: 7, seq: 2, body: BODY, resend: { previousAttempts: 1 } });
    await target.deliver({ messageId: 7, seq: 3, body: BODY });
    expect(r.received.map((request) => request.headers["idempotency-key"])).toEqual([
      "7-2",
      "7-2",
      "7-3",
    ]);
    // None without the setting.
    await destination({ url: r.url }).deliver({ messageId: 8, seq: 0, body: BODY });
    expect(r.received[3]?.headers["idempotency-key"]).toBeUndefined();
  });
});

describe("an HTTP destination's URL template", () => {
  // Each value lands percent-encoded in its one segment, and the request stays on the host.
  it.each([
    ["/", "%2F"],
    ["%2f", "%252f"],
    ["@", "%40"],
    ["#", "%23"],
    ["?", "%3F"],
    ["\r\nX-Injected: yes", "%0D%0AX-Injected%3A%20yes"],
    ["\\", "%5C"],
    ["[::1]", "%5B%3A%3A1%5D"],
    ["lab.example.test:8443", "lab.example.test%3A8443"],
    ["...", "..."],
    ["a..b", "a..b"],
    ["SYN-0001", "SYN-0001"],
  ])("fills %j into its segment as %s", async (value, encoded) => {
    const r = await lab();
    const target = destination({ url: at(r, "/patients/{mrn}/orders") });
    expect(
      await outcomeOf(target.deliver({ messageId: 1, seq: 0, body: BODY, meta: { mrn: value } })),
    ).toBe("delivered");
    expect(r.received[0]?.url).toBe(`/patients/${encoded}/orders`);
    expect(r.received[0]?.headers["x-injected"]).toBeUndefined();
    expect(r.received[0]?.headers.host).toBe(`127.0.0.1:${r.port}`);
  });

  it.each([".", ".."])(
    "refuses %j, which would move the path, and sends nothing",
    async (value) => {
      const r = await lab();
      const target = destination({ url: at(r, "/patients/{mrn}") });
      const error = await outcomeOf(
        target.deliver({ messageId: 1, seq: 0, body: BODY, meta: { mrn: value } }),
      );
      expect(error).toBeInstanceOf(DeliveryRejected);
      expect((error as DeliveryRejected).reason).toBe("URL_TEMPLATE_REFUSED");
      expect(r.received).toHaveLength(0);
    },
  );

  it("fails a delivery whose metadata lacks a key, or holds it empty, naming the key alone", async () => {
    const r = await lab();
    const target = destination({ url: at(r, "/patients/{mrn}/visits/{visit}") });
    const missing = await outcomeOf(
      target.deliver({ messageId: 1, seq: 0, body: BODY, meta: { mrn: "SYN-0001" } }),
    );
    expect(missing).toBeInstanceOf(DeliveryRejected);
    expect((missing as DeliveryRejected).reason).toBe("URL_TEMPLATE_MISSING visit");
    const none = await outcomeOf(target.deliver({ messageId: 1, seq: 0, body: BODY }));
    expect((none as DeliveryRejected).reason).toBe("URL_TEMPLATE_MISSING mrn");
    // A key inherited from Object.prototype is no key of the metadata.
    const inherited = await outcomeOf(
      destination({ url: at(r, "/{constructor}") }).deliver({
        messageId: 1,
        seq: 0,
        body: BODY,
        meta: {},
      }),
    );
    expect((inherited as DeliveryRejected).reason).toBe("URL_TEMPLATE_MISSING constructor");
    const empty = await outcomeOf(
      target.deliver({ messageId: 1, seq: 0, body: BODY, meta: { mrn: "", visit: 1 } }),
    );
    expect((empty as DeliveryRejected).reason).toBe("URL_TEMPLATE_EMPTY mrn");
    const unpaired = await outcomeOf(
      target.deliver({ messageId: 1, seq: 0, body: BODY, meta: { mrn: "\ud800", visit: 1 } }),
    );
    expect((unpaired as DeliveryRejected).reason).toBe("URL_TEMPLATE_ENCODING mrn");
    expect(String((unpaired as Error).message)).not.toContain("\ud800");
    expect(r.received).toHaveLength(0);
  });

  it("fills numbers and booleans as text, and keeps the URL's own query first", async () => {
    const r = await lab();
    const target = destination({
      url: at(r, "/visits/{visit}?source=pathways"),
      query: { active: "{active}", site: "LAB 1&2", note: "v-{visit}" },
    });
    await target.deliver({ messageId: 1, seq: 0, body: BODY, meta: { visit: 12, active: true } });
    expect(r.received[0]?.url).toBe(
      "/visits/12?source=pathways&active=true&site=LAB%201%262&note=v-12",
    );
  });

  it("fills query values from the metadata, percent-encoded, and empty ones are kept", async () => {
    const r = await lab();
    const target = destination({ url: r.url, query: { "patient id": "{mrn}", visit: "{visit}" } });
    await target.deliver({
      messageId: 1,
      seq: 0,
      body: BODY,
      meta: { mrn: "SYN-1&x=#?/", visit: "" },
    });
    expect(r.received[0]?.url).toBe("/in?patient%20id=SYN-1%26x%3D%23%3F%2F&visit=");
    const missing = await outcomeOf(
      target.deliver({ messageId: 2, seq: 0, body: BODY, meta: { mrn: "SYN-2" } }),
    );
    expect((missing as DeliveryRejected).reason).toBe("URL_TEMPLATE_MISSING visit");
    const unpaired = await outcomeOf(
      target.deliver({ messageId: 2, seq: 0, body: BODY, meta: { mrn: "\udc00", visit: 1 } }),
    );
    expect((unpaired as DeliveryRejected).reason).toBe("URL_TEMPLATE_ENCODING mrn");
  });

  it("says whether it reads the metadata", () => {
    expect(destination({ url: "https://lab.example.test/in" }).usesMeta).toBe(false);
    expect(destination({ url: "https://lab.example.test/{mrn}" }).usesMeta).toBe(true);
    expect(
      destination({ url: "https://lab.example.test/in", query: { site: "LAB" } }).usesMeta,
    ).toBe(false);
    expect(
      destination({ url: "https://lab.example.test/in", query: { mrn: "{mrn}" } }).usesMeta,
    ).toBe(true);
  });

  it("sends a fixed URL as written, and a query of fixed values after a URL with none", async () => {
    const r = await lab();
    await destination({ url: r.url, query: { site: "LAB" } }).deliver({
      messageId: 1,
      seq: 0,
      body: BODY,
    });
    await destination({ url: at(r, "/in?a=1") }).deliver({ messageId: 1, seq: 0, body: BODY });
    expect(r.received.map((request) => request.url)).toEqual(["/in?site=LAB", "/in?a=1"]);
  });
});

describe("templateProblem", () => {
  it.each([
    ["https://lab.example.test/patients/{mrn}", undefined],
    ["https://lab.example.test/p/{mrn}/v-{visit}?a=1", undefined],
    ["https://lab.example.test/in", undefined],
    ["https://{host}.example.test/", "a placeholder may fill only the path"],
    ["https://lab.example.test:{port}/", "a placeholder may fill only the path"],
    ["https://{user}@lab.example.test/", "a placeholder may fill only the path"],
    ["{scheme}://lab.example.test/", "a placeholder may fill only the path"],
    ["https://lab.example.test{path}", "a placeholder may fill only the path"],
    [
      "https://lab.example.test/in?mrn={mrn}",
      "a placeholder may fill only the path; fill a query value with query:",
    ],
    [
      "https://lab.example.test/in#{mrn}",
      "a placeholder may fill only the path; fill a query value with query:",
    ],
    ["https://lab.example.test/{mrn", "a placeholder is a metadata key in braces, such as {mrn}"],
    ["https://lab.example.test/{1x}", "a placeholder is a metadata key in braces, such as {mrn}"],
    ["https://lab.example.test/{}", "a placeholder is a metadata key in braces, such as {mrn}"],
    [
      "https://lab.example.test/pathwaysslot0z",
      "pathwaysslot is kept for placeholders and may not be written",
    ],
  ])("reads %s", (url, problem) => {
    expect(templateProblem(url)).toBe(problem);
  });

  it("checks a query value's braces", () => {
    expect(queryValueProblem("{visit}-{site}")).toBeUndefined();
    expect(queryValueProblem("plain")).toBeUndefined();
    expect(queryValueProblem("{visit")).toBe(
      "a placeholder is a metadata key in braces, such as {mrn}",
    );
  });

  it("is checked when a template is built", () => {
    expect(() => new UrlTemplate("https://{host}/")).toThrow(
      "the URL template cannot be used: a placeholder may fill only the path",
    );
    expect(new UrlTemplate("https://lab.example.test/{mrn}").origin).toBe(
      "https://lab.example.test",
    );
  });
});

describe("AddressGuard", () => {
  it.each([
    ["127.0.0.1", false],
    ["127.255.0.9", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["172.32.0.1", true],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["fd00:ec2::254", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:169.254.169.254", false],
    ["203.0.113.10", true],
    ["2001:db8::1", true],
  ])("permits %s: %s", (address, permitted) => {
    expect(new AddressGuard([]).permits(address)).toBe(permitted);
  });

  it("permits a refused range's networks that allow names, and no more", () => {
    const guard = new AddressGuard(["10.20.0.0/16", "127.0.0.1", "fd00::/8"]);
    expect(guard.permits("10.20.9.9")).toBe(true);
    expect(guard.permits("10.21.0.1")).toBe(false);
    expect(guard.permits("127.0.0.1")).toBe(true);
    expect(guard.permits("127.0.0.2")).toBe(false);
    expect(guard.permits("fd12::1")).toBe(true);
    expect(guard.permits("169.254.169.254")).toBe(false);
  });

  it("refuses an allow entry that is not a network", () => {
    expect(() => new AddressGuard(["lab.example.test"])).toThrow(RangeError);
  });

  it.each([
    ["10.20.0.0/16", { address: "10.20.0.0", prefix: 16, type: "ipv4" }],
    ["10.20.0.1", { address: "10.20.0.1", prefix: 32, type: "ipv4" }],
    ["10.0.0.0/0", { address: "10.0.0.0", prefix: 0, type: "ipv4" }],
    ["fd00::/8", { address: "fd00::", prefix: 8, type: "ipv6" }],
    ["::1", { address: "::1", prefix: 128, type: "ipv6" }],
    ["::/128", { address: "::", prefix: 128, type: "ipv6" }],
    ["10.0.0.0/33", undefined],
    ["::/129", undefined],
    ["10.0.0.0/", undefined],
    ["10.0.0.0/1/2", undefined],
    ["lab.example.test/8", undefined],
    ["", undefined],
  ])("reads the network %j", (entry, network) => {
    expect(parseNetwork(entry)).toEqual(network);
  });

  /** A resolver answering each lookup with the next of `answers`, recording what it was asked. */
  function resolver(...answers: (LookupAddress[] | NodeJS.ErrnoException)[]): {
    resolve: typeof dnsLookup;
    asked: string[];
  } {
    const asked: string[] = [];
    let next = 0;
    const resolve = ((
      hostname: string,
      _options: unknown,
      callback: (error: NodeJS.ErrnoException | null, found: LookupAddress[]) => void,
    ) => {
      asked.push(hostname);
      const answer = answers[Math.min(next, answers.length - 1)] as
        LookupAddress[] | NodeJS.ErrnoException;
      next += 1;
      if (answer instanceof Error) callback(answer, []);
      else callback(null, answer);
    }) as unknown as typeof dnsLookup;
    return { resolve, asked };
  }

  it("answers a lookup for one address with the first permitted one, and an error when none is", () => {
    const { resolve } = resolver(
      [
        { address: "169.254.169.254", family: 4 },
        { address: "203.0.113.10", family: 4 },
      ],
      [{ address: "10.0.0.1", family: 4 }],
      Object.assign(new Error("synthetic"), { code: "ENOTFOUND" }),
    );
    const guard = new AddressGuard([], resolve);
    const one: unknown[] = [];
    guard.lookup("lab.example.test", { family: 0 }, (...args) => one.push(args));
    expect(one).toEqual([[null, "203.0.113.10", 4]]);
    const none: [NodeJS.ErrnoException | null][] = [];
    guard.lookup("lab.example.test", { all: true }, (error) => none.push([error]));
    expect(none[0]?.[0]?.code).toBe(ADDRESS_REFUSED);
    expect(none[0]?.[0]?.message).not.toContain("10.0.0.1");
    const failed: [NodeJS.ErrnoException | null][] = [];
    guard.lookup("lab.example.test", {}, (error) => failed.push([error]));
    expect(failed[0]?.[0]?.code).toBe("ENOTFOUND");
  });

  it("checks the address at every connect, so a name that rebinds to a refused one is refused", async () => {
    const r = await lab((_request, response) => {
      // Each answer closes its connection, so the next delivery connects, and looks up, again.
      response.writeHead(200, { Connection: "close" });
      response.end();
    });
    const { resolve, asked } = resolver(
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [
        { address: "169.254.169.254", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    );
    const target = destination({
      url: `http://lab.example.test:${r.port}/in`,
      addressGuard: new AddressGuard(["127.0.0.1/32"], resolve),
    });
    expect(await outcomeOf(target.deliver({ messageId: 1, seq: 0, body: BODY }))).toBe("delivered");
    const rebound = await outcomeOf(target.deliver({ messageId: 2, seq: 0, body: BODY }));
    expect(rebound).toBeInstanceOf(RetryableError);
    expect(rebound).toMatchObject({ code: ADDRESS_REFUSED });
    // A mixed answer connects to the permitted address alone.
    expect(await outcomeOf(target.deliver({ messageId: 3, seq: 0, body: BODY }))).toBe("delivered");
    expect(asked).toEqual(["lab.example.test", "lab.example.test", "lab.example.test"]);
    expect(r.received).toHaveLength(2);
    expect(r.received[0]?.headers.host).toBe(`lab.example.test:${r.port}`);
  });

  it("refuses a loopback name through the system resolver unless allowed", async () => {
    const r = await lab();
    const refused = await outcomeOf(
      destination({
        url: `http://localhost:${r.port}/in`,
        addressGuard: new AddressGuard([]),
      }).deliver({ messageId: 1, seq: 0, body: BODY }),
    );
    expect(refused).toMatchObject({ code: ADDRESS_REFUSED });
    expect(r.received).toHaveLength(0);
  });

  it("checks a host written as an address, which is never looked up", async () => {
    const r = await lab();
    const refused = await outcomeOf(
      destination({ url: r.url, addressGuard: new AddressGuard([]) }).deliver({
        messageId: 1,
        seq: 0,
        body: BODY,
      }),
    );
    expect(refused).toBeInstanceOf(RetryableError);
    expect(refused).toMatchObject({ code: ADDRESS_REFUSED });
    expect(r.received).toHaveLength(0);
    const v6 = await outcomeOf(
      destination({
        url: `http://[::1]:${r.port}/in`,
        addressGuard: new AddressGuard([]),
      }).deliver({ messageId: 1, seq: 0, body: BODY }),
    );
    expect(v6).toMatchObject({ code: ADDRESS_REFUSED });
    expect(
      await outcomeOf(
        destination({ url: r.url, addressGuard: new AddressGuard(["127.0.0.0/8"]) }).deliver({
          messageId: 1,
          seq: 0,
          body: BODY,
        }),
      ),
    ).toBe("delivered");
  });

  it("guards an https:// destination's connections too, and verifies the certificate by name", async () => {
    const r = await receiver(status(200), { cert: certs.serverCert, key: certs.serverKey });
    receivers.push(r);
    const { resolve } = resolver([{ address: "127.0.0.1", family: 4 }]);
    const tls = { ca: certs.ca, cert: undefined, key: undefined };
    const refused = await outcomeOf(
      destination({
        url: `https://localhost:${r.port}/in`,
        tls,
        addressGuard: new AddressGuard([], resolve),
      }).deliver({ messageId: 1, seq: 0, body: BODY }),
    );
    expect(refused).toMatchObject({ code: ADDRESS_REFUSED });
    expect(
      await outcomeOf(
        destination({
          url: `https://localhost:${r.port}/in`,
          tls,
          addressGuard: new AddressGuard(["127.0.0.1"], resolve),
        }).deliver({ messageId: 1, seq: 0, body: BODY }),
      ),
    ).toBe("delivered");
  });
});

describe("the HTTP destination's options in the engine", () => {
  /**
   * Runs one pass of a channel whose HTTP destination is `http` (a flow mapping's inside), over
   * messages stored first, each with its metadata.
   */
  async function pass(
    http: (r: Receiver) => string,
    metas: readonly (Readonly<Record<string, string | number | boolean>> | undefined)[],
    memory = false,
  ): Promise<{
    r: Receiver;
    store: MessageStore;
    events: ReturnType<typeof captureLogger>["events"];
  }> {
    const r = await lab();
    const root = await makeProject({
      "channels/adt/channel.yaml": `source:
  file: { dir: ../../data/inbox }
transform: ./transform.ts
destinations:
  - http: { ${http(r)} }
`,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const store: MessageStore = memory ? new MemoryStore() : await Store.open(project.databaseFile);
    stores.push(store);
    for (const meta of metas) {
      await store.receive("adt", Buffer.from(ADT_A01), meta === undefined ? {} : { meta });
    }
    const { logger, events } = captureLogger();
    const engine = new Engine({ project, store, logger, env: {} });
    engines.push(engine);
    await engine.start();
    await engine.tick();
    return { r, store, events };
  }

  it("fills the URL from each message's metadata, by the method and with the key configured", async () => {
    const { r, store, events } = await pass(
      (lab) =>
        `url: "http://127.0.0.1:${lab.port}/patients/{mrn}", method: PUT, query: { visit: "{visit}" }, idempotencyHeader: Idempotency-Key, plaintext: true, allowNetworks: [127.0.0.0/8]`,
      [{ mrn: "SYN-0001", visit: 3 }, { mrn: "SYN/0002" }, undefined],
    );
    expect(r.received.map((request) => [request.method, request.url])).toEqual([
      ["PUT", "/patients/SYN-0001?visit=3"],
    ]);
    expect(r.received[0]?.headers["idempotency-key"]).toBe("1-0");
    expect(r.received[0]?.headers["content-type"]).toBe("application/hl7-v2");
    // A key the metadata lacks fails that delivery alone, naming the key, never a value.
    expect((await store.deliveries(2))[0]).toMatchObject({
      status: "failed",
      error: "rejected: URL_TEMPLATE_MISSING visit",
    });
    expect((await store.deliveries(3))[0]).toMatchObject({
      status: "failed",
      error: "rejected: URL_TEMPLATE_MISSING mrn",
    });
    expect(JSON.stringify(events)).not.toContain("SYN/0002");
  });

  it("hands no metadata over from a store that keeps none, so a placeholder fails the delivery", async () => {
    const { r, store } = await pass(
      (lab) =>
        `url: "http://127.0.0.1:${lab.port}/patients/{mrn}", plaintext: true, allowNetworks: [127.0.0.1]`,
      [{ mrn: "SYN-0001" }],
      true,
    );
    expect(r.received).toHaveLength(0);
    expect((await store.deliveries(1))[0]).toMatchObject({
      status: "failed",
      error: "rejected: URL_TEMPLATE_MISSING mrn",
    });
  });

  it("refuses a loopback destination the channel does not allow, and holds it for a retry", async () => {
    const { r, store, events } = await pass(
      (lab) => `url: "${lab.url}", plaintext: true`,
      [undefined],
    );
    expect(r.received).toHaveLength(0);
    expect(events.find((e) => e.event === "delivery-retry")).toMatchObject({
      code: ADDRESS_REFUSED,
    });
    expect((await store.deliveries(1))[0]).toMatchObject({
      status: "pending",
      error: `delivery: ${ADDRESS_REFUSED}`,
    });
  });
});
