import { createServer, type AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import type { ChannelConfig } from "../src/config/schema.js";
import { HttpDestination, HttpSource } from "../src/connectors/http.js";
import { connectorsFor, Engine } from "../src/engine/engine.js";
import {
  channelStatus,
  healthEndpointFor,
  HealthEndpoint,
  type HealthReport,
} from "../src/engine/health.js";
import { Store } from "../src/storage/store.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  LAB_TRANSFORM,
  makeProject,
  SECOND_HEADER_BEHIND,
  SECOND_HEADER_JOINED,
  type LogEvent,
} from "./helpers.js";
import {
  CLOSED_PORT,
  makeCertificates,
  onPickedPorts,
  pickPorts,
  receiver,
  removeCertificates,
  send,
  sourceListening,
  status,
  type Certificates,
  type PickOptions,
  type Receiver,
} from "./net-helpers.js";

const TOKEN = "synthetic-token-0123456789abcdef";
const HEALTH_TOKEN = "synthetic-health-token-0123456789";
const LAB_AUTH = "Bearer synthetic-lab-token-0123456789";
/** Who answers, in a health report a test makes up. */
const IDENTITY = {
  version: "0.0.1",
  schemaGeneration: 6,
  node: "0000000000000000",
  role: "single",
  leaseEpoch: null,
  draining: false,
} as const;

/** The health block's metrics as `pathways.yaml` leaves them by default. */
const METRICS_ON = { enabled: true, allowUnauthenticated: false } as const;

let certs: Certificates;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

const engines: Engine[] = [];
const stores: Store[] = [];
const receivers: Receiver[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

interface Setup {
  readonly engine: Engine;
  readonly store: Store;
  readonly events: LogEvent[];
  readonly lines: string[];
  readonly clock: { now: number };
  readonly port: number;
  readonly lab: Receiver;
}

/** A channel taking HTTPS with a bearer token and sending to a lab over HTTPS. */
async function setUp(
  labAnswer: number,
  options: {
    env?: Record<string, string>;
    /** The source's block, or how to write it for the port picked for it. */
    source?: string | ((port: number) => string);
    destination?: string;
    /** Picks the source's port: {@link pickPorts} unless a test says otherwise. */
    pick?: PickOptions["pick"];
  } = {},
): Promise<Setup> {
  const lab = await receiver(status(labAnswer), { cert: certs.serverCert, key: certs.serverKey });
  receivers.push(lab);
  const write =
    options.source ??
    ((port: number) =>
      `http: { port: ${String(port)}, path: /adt, tls: { cert: ${certs.files.serverCert}, key: ${certs.files.serverKey} } }`);
  const destination =
    options.destination ??
    `http: { url: "${lab.url}", allowNetworks: [127.0.0.1], headers: { Authorization: { env: LAB_AUTH } }, tls: { ca: ${certs.files.ca} } }`;
  const start = async (source: string, port: number): Promise<Setup> => {
    const root = await makeProject({
      "channels/adt/channel.yaml": `source:\n  ${source}\ntransform: ./transform.ts\ndestinations:\n  - ${destination}\n`,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const { logger, events, lines } = captureLogger();
    const clock = { now: Date.now() };
    const engine = new Engine({
      project,
      store,
      logger,
      now: () => clock.now,
      env: options.env ?? { PATHWAYS_HTTP_TOKEN: TOKEN, LAB_AUTH },
    });
    engines.push(engine);
    await engine.start();
    return { engine, store, events, lines, clock, port, lab };
  };
  // A block a test wrote itself is kept as it is, its port included.
  if (typeof write === "string") return start(write, CLOSED_PORT);
  return onPickedPorts(
    1,
    async ([port = 0]) => {
      const setup = await start(write(port), port);
      await sourceListening(setup.engine, "adt");
      return setup;
    },
    options.pick === undefined ? {} : { pick: options.pick },
  );
}

function post(
  port: number,
  body: string | Uint8Array = ADT_A01,
  token = TOKEN,
): ReturnType<typeof send> {
  return send(port, {
    path: "/adt",
    headers: { Authorization: `Bearer ${token}` },
    body,
    ca: certs.ca,
  });
}

describe("an HTTP channel in the engine", () => {
  it("is set up on another port when the one picked is taken before the source listens", async () => {
    // A listener in another test file's worker, which drops every connection, takes the port
    // between its picking and the source binding it.
    const taken = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => taken.close(() => resolve())));
    const { port: held } = taken.address() as AddressInfo;
    const picks = [[held]];
    const { port } = await setUp(200, {
      pick: (count) => Promise.resolve(picks.shift() ?? pickPorts(count)),
    });
    expect(port).not.toBe(held);
    expect((await post(port)).status).toBe(202);
  });

  it("takes a message over HTTPS, transforms it, and POSTs the output over HTTPS", async () => {
    const { engine, store, lab, port, lines, events } = await setUp(200);
    const answer = await post(port);
    expect(answer.status).toBe(202);
    expect(JSON.parse(answer.body)).toEqual({ id: 1 });
    await engine.tick();

    expect(lab.received).toHaveLength(1);
    const [request] = lab.received;
    expect(request?.body.toString("utf8")).toBe(ADT_A01.replace("|LAB|", "|LAB2|"));
    expect(request?.headers.authorization).toBe(LAB_AUTH);
    expect(request?.headers["content-type"]).toBe("application/hl7-v2");
    expect(await store.deliveryCounts("adt")).toEqual({
      pending: 0,
      delivered: 1,
      failed: 0,
      cleared: 0,
    });

    expect(events.map((e) => e.event)).toEqual(["received", "transformed", "delivered"]);
    const log = lines.join("");
    for (const secret of ["MSH", "TESTPATIENT", TOKEN, "synthetic-lab-token"]) {
      expect(log).not.toContain(secret);
    }
  });

  it("in ack mode stores the message, then answers with its ACK, and logs an unreadable one", async () => {
    const tls = `tls: { cert: ${certs.files.serverCert}, key: ${certs.files.serverKey} }`;
    const { store, events, lines, port } = await setUp(200, {
      source: (port) =>
        `http: { port: ${String(port)}, paths: [/adt, /hl7], response: ack, ${tls} }`,
    });
    const hl7 = (path: string, body: string): ReturnType<typeof send> =>
      send(port, {
        path,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/hl7-v2" },
        body,
        ca: certs.ca,
      });
    const stored = await hl7("/hl7/", ADT_A01);
    expect(stored.status).toBe(200);
    expect(stored.headers["content-type"]).toBe("application/hl7-v2; charset=utf-8");
    expect(stored.body).toContain("MSA|AA|MSG00001");
    expect(await store.message(1)).toMatchObject({ status: "received" });

    const unreadable = await hl7("/adt", "PID|1||TEST000001\r");
    expect(unreadable.status).toBe(200);
    expect(unreadable.body).toContain("MSA|AE|");
    expect(await store.message(2)).toMatchObject({ status: "failed" });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "http-unreadable",
        channel: "adt",
        message: 2,
        problem: "NO_MSH_SEGMENT",
      }),
    );
    expect(lines.join("")).not.toContain("TEST000001");
  });

  it("answers with the configured response, its secret header read from the environment", async () => {
    const tls = `tls: { cert: ${certs.files.serverCert}, key: ${certs.files.serverKey} }`;
    const response =
      "response: { status: 200, contentType: text/plain, headers: { X-Receiver-Key: { env: RECEIVER_KEY } }, body: OK }";
    const { lab, port } = await setUp(200, {
      source: (port) =>
        `http: { port: ${String(port)}, path: /adt, methods: [PUT], ${response}, ${tls} }`,
      env: { PATHWAYS_HTTP_TOKEN: TOKEN, LAB_AUTH, RECEIVER_KEY: "synthetic-receiver-key" },
    });
    const answer = await send(port, {
      method: "PUT",
      path: "/adt",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: ADT_A01,
      ca: certs.ca,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers["x-receiver-key"]).toBe("synthetic-receiver-key");
    expect(answer.body).toBe("OK");
    expect(lab.received).toEqual([]);
    await expect(
      setUp(200, {
        source: `http: { port: ${CLOSED_PORT}, ${response}, ${tls} }`,
        env: { PATHWAYS_HTTP_TOKEN: TOKEN, LAB_AUTH },
      }),
    ).rejects.toThrow(
      "channels/adt/channel.yaml: source.http.response.headers.X-Receiver-Key: the environment variable RECEIVER_KEY is not set",
    );
  });

  it.each([...SECOND_HEADER_BEHIND, ...SECOND_HEADER_JOINED])(
    "answers 422 to a body whose second header stands behind %s, storing it as failed",
    async (_, text) => {
      const { engine, store, lab, port, events, lines } = await setUp(200);
      const body = Buffer.from(text, "latin1");
      const answer = await post(port, body);
      expect(answer.status).toBe(422);
      expect(answer.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(answer.body)).toEqual({
        error: "the message was refused; sending it again will not help",
        code: "MULTIPLE_MESSAGES",
        id: 1,
      });
      expect(await store.message(1)).toMatchObject({
        status: "failed",
        error: "inbound: MULTIPLE_MESSAGES",
      });
      await engine.tick();
      expect(lab.received).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "http-unreadable",
          channel: "adt",
          message: 1,
          problem: "MULTIPLE_MESSAGES",
        }),
      );
      expect(lines.join("")).not.toContain("TEST000001");
    },
  );

  it("answers 422 to a refused body whatever its response, and 2xx to one message", async () => {
    const tls = `tls: { cert: ${certs.files.serverCert}, key: ${certs.files.serverKey} }`;
    const { port, store } = await setUp(200, {
      source: (port) =>
        `http: { port: ${String(port)}, path: /adt, response: { status: 200, body: OK }, ${tls} }`,
    });
    const refused = await post(port, `${ADT_A01}msh${ADT_A01.slice(3)}`);
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toMatchObject({ code: "MULTIPLE_MESSAGES", id: 1 });
    expect(await store.message(1)).toMatchObject({ status: "failed" });
    const taken = await post(port);
    expect(taken.status).toBe(200);
    expect(taken.body).toBe("OK");
  });

  it("logs a refused request with its status only", async () => {
    const { port, events, lines } = await setUp(200);
    expect((await post(port, ADT_A01, "synthetic-wrong-token-000000")).status).toBe(401);
    expect(events).toEqual([
      expect.objectContaining({ event: "http-refused", channel: "adt", status: 401 }),
    ]);
    expect(lines.join("")).not.toContain("synthetic-wrong-token");
  });

  it("answers 503 and logs the code when the message cannot be stored", async () => {
    const { port, store, events } = await setUp(200);
    await store.close();
    stores.splice(0);
    expect((await post(port)).status).toBe(503);
    expect(events.find((e) => e.event === "receive-failed")).toMatchObject({ channel: "adt" });
  });

  it("retries a destination answering 503, and fails a delivery answered 400", async () => {
    const retrying = await setUp(503);
    await post(retrying.port);
    await retrying.engine.tick();
    expect(retrying.events.find((e) => e.event === "delivery-retry")).toMatchObject({
      code: "HTTP_503",
      attempt: 1,
    });
    expect(await retrying.store.retryingDeliveries("adt")).toBe(1);

    const rejecting = await setUp(400);
    await post(rejecting.port);
    await rejecting.engine.tick();
    expect(rejecting.events.find((e) => e.event === "delivery-rejected")).toMatchObject({
      reason: "HTTP 400",
    });
    expect(await rejecting.store.deliveryCounts("adt")).toEqual({
      pending: 0,
      delivered: 0,
      failed: 1,
      cleared: 0,
    });
  });

  it("warns once at startup of a plaintext or unauthenticated endpoint, naming the channel", async () => {
    const lab = await receiver(status(200));
    receivers.push(lab);
    const { events, port } = await setUp(200, {
      source: (port) => `http: { port: ${String(port)}, plaintext: true, auth: none }`,
      destination: `http: { url: "${lab.url}", allowNetworks: [127.0.0.1], plaintext: true }`,
      env: {},
    });
    expect(events).toEqual([
      expect.objectContaining({
        level: 40,
        event: "plaintext",
        channel: "adt",
        endpoint: "source",
      }),
      expect.objectContaining({ event: "unauthenticated", channel: "adt", endpoint: "source" }),
      expect.objectContaining({
        event: "plaintext",
        channel: "adt",
        endpoint: "destination",
        destination: 0,
      }),
    ]);
    expect((await send(port, { body: ADT_A01 })).status).toBe(202);
  });

  it("refuses to start without the token, a secret header or a TLS file, naming file and key", async () => {
    await expect(setUp(200, { env: { LAB_AUTH } })).rejects.toThrow(
      new ConfigError([
        "channels/adt/channel.yaml: source.http.auth: the environment variable PATHWAYS_HTTP_TOKEN is not set",
      ]),
    );
    await expect(setUp(200, { env: { PATHWAYS_HTTP_TOKEN: TOKEN } })).rejects.toThrow(
      "channels/adt/channel.yaml: destinations.0.http.headers.Authorization: the environment variable LAB_AUTH is not set",
    );
    await expect(
      setUp(200, { env: { PATHWAYS_HTTP_TOKEN: TOKEN, LAB_AUTH: "synthetic\nsecret" } }),
    ).rejects.toThrow(
      "channels/adt/channel.yaml: destinations.0.http.headers.Authorization: the environment variable LAB_AUTH holds characters a header cannot carry",
    );
    await expect(
      setUp(200, {
        destination: `http: { url: "https://127.0.0.1:1/", tls: { ca: ./missing-ca.crt } }`,
      }),
    ).rejects.toThrow(
      "channels/adt/channel.yaml: destinations.0.http.tls.ca: could not be read (ENOENT)",
    );
  });

  it("keeps running when a source cannot listen, retrying it, with health at 503 meanwhile", async () => {
    const holder = await receiver(status(200));
    const { engine, events, clock } = await setUp(200, {
      source: `http: { port: ${holder.port}, path: /adt, plaintext: true }`,
    });
    expect(events.find((e) => e.event === "source-start-failed")).toMatchObject({
      channel: "adt",
      code: "EADDRINUSE",
      attempt: 1,
      retryInMs: 1_000,
    });
    let report = await engine.health();
    expect(report.status).toBe("unavailable");
    expect(report.channels["adt"]?.source).toBe("down");

    // Not yet due: no new attempt.
    await engine.tick();
    expect(events.filter((e) => e.event === "source-start-failed")).toHaveLength(1);
    clock.now += 1_000;
    await engine.tick();
    expect(events.filter((e) => e.event === "source-start-failed").at(-1)).toMatchObject({
      attempt: 2,
      retryInMs: 2_000,
    });

    await holder.close();
    clock.now += 2_000;
    await engine.tick();
    expect(events.at(-1)).toMatchObject({ event: "source-started", channel: "adt" });
    report = await engine.health();
    expect(report.status).toBe("ok");
    expect(report.channels["adt"]?.source).toBe("up");
  });

  it("builds HTTP connectors from a channel's configuration", async () => {
    // Built, never started: nothing listens on the port.
    const port = CLOSED_PORT;
    const root = await makeProject({
      "channels/adt/channel.yaml": `source:\n  http: { port: ${port}, plaintext: true, auth: none }\ndestinations:\n  - http: { url: "https://lab.example.test/", headers: { content-type: text/plain } }\n`,
    });
    const [channel] = (await loadProject(root)).channels;
    const { logger } = captureLogger();
    const built = await connectorsFor(channel as ChannelConfig, { now: Date.now, logger, env: {} });
    expect(built.source).toBeInstanceOf(HttpSource);
    expect(built.destinations[0]).toBeInstanceOf(HttpDestination);
    await built.destinations[0]?.stop?.();
  });

  it("lets a channel's headers replace the default Content-Type, whatever their case", async () => {
    const lab = await receiver(status(200));
    receivers.push(lab);
    const { engine, port } = await setUp(200, {
      destination: `http: { url: "${lab.url}", allowNetworks: [127.0.0.1], plaintext: true, headers: { content-type: "x-application/hl7-v2+er7" } }`,
    });
    await post(port);
    await engine.tick();
    expect(lab.received[0]?.headers["content-type"]).toBe("x-application/hl7-v2+er7");
  });
});

describe("health", () => {
  it("names a channel's status from its counts", () => {
    expect(channelStatus({ failed: 0 }, { retrying: 0, failed: 0 })).toBe("ok");
    expect(channelStatus({ failed: 1 }, { retrying: 0, failed: 0 })).toBe("failed");
    expect(channelStatus({ failed: 0 }, { retrying: 0, failed: 1 })).toBe("failed");
    expect(channelStatus({ failed: 1 }, { retrying: 1, failed: 1 })).toBe("retrying");
  });

  it("reports ok, retrying and failed with counts, at 200, never content", async () => {
    const ok = await setUp(200);
    await post(ok.port);
    await ok.engine.tick();
    expect(await ok.engine.health()).toEqual({
      status: "ok",
      storage: "ok",
      channels: {
        adt: {
          status: "ok",
          source: "up",
          state: "running",
          messages: { received: 0, transformed: 1, filtered: 0, failed: 0, cleared: 0 },
          deliveries: { pending: 0, delivered: 1, failed: 0, cleared: 0, retrying: 0 },
        },
      },
    });

    const retrying = await setUp(503);
    await post(retrying.port);
    await retrying.engine.tick();
    const retryingReport = await retrying.engine.health();
    expect(retryingReport.status).toBe("ok");
    expect(retryingReport.channels["adt"]).toMatchObject({
      status: "retrying",
      deliveries: { pending: 1, retrying: 1 },
    });

    const failed = await setUp(422);
    await post(failed.port);
    await failed.engine.tick();
    const failedReport = await failed.engine.health();
    expect(failedReport.status).toBe("ok");
    expect(failedReport.channels["adt"]).toMatchObject({
      status: "failed",
      deliveries: { failed: 1 },
    });
    expect(JSON.stringify(failedReport)).not.toContain("MSH");
  });

  it("reports 503 when storage cannot be read", async () => {
    const { engine, store } = await setUp(200);
    await store.close();
    stores.splice(0);
    expect(await engine.health()).toEqual({
      status: "unavailable",
      storage: "unreachable",
      channels: { adt: { status: "unknown", source: "up", state: "running" } },
    });
  });

  it("serves the report over HTTPS with a bearer token: 200, 503, 401 and 405", async () => {
    let report: HealthReport = { ...IDENTITY, status: "ok", storage: "ok", channels: {} };
    const refused: number[] = [];
    const health = new HealthEndpoint({
      host: "127.0.0.1",
      port: 0,
      tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
      token: HEALTH_TOKEN,
      report: () => Promise.resolve(report),
      onRefused: (code) => refused.push(code),
    });
    expect(health.port).toBeUndefined();
    await health.start();
    closers.push(() => health.stop());
    const port = health.port ?? 0;
    const auth = { Authorization: `Bearer ${HEALTH_TOKEN}` };
    const get = (method = "GET", headers: Record<string, string> = auth): ReturnType<typeof send> =>
      send(port, { method, path: "/health", headers, ca: certs.ca });

    const ok = await get();
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(ok.body)).toEqual(report);
    const head = await get("HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");

    report = { ...IDENTITY, status: "unavailable", storage: "unreachable", channels: {} };
    expect((await get()).status).toBe(503);

    expect((await get("GET", {})).status).toBe(401);
    const post = await get("POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expect(refused).toEqual([401, 405]);
  });

  it("refuses with 401 and 405 when no one is told of refusals", async () => {
    const health = new HealthEndpoint({
      host: "127.0.0.1",
      port: 0,
      tls: undefined,
      token: HEALTH_TOKEN,
      report: () => Promise.resolve({ ...IDENTITY, status: "ok", storage: "ok", channels: {} }),
    });
    await health.start();
    closers.push(() => health.stop());
    const port = health.port ?? 0;
    const auth = { Authorization: `Bearer ${HEALTH_TOKEN}` };
    expect((await send(port, { method: "GET", path: "/health" })).status).toBe(401);
    expect((await send(port, { method: "POST", path: "/health", headers: auth })).status).toBe(405);
    expect((await send(port, { method: "GET", path: "/health", headers: auth })).status).toBe(200);
  });

  it("builds the configured endpoint, warning once when it runs without TLS or a token", async () => {
    const { logger, events } = captureLogger();
    const report = (): Promise<HealthReport> =>
      Promise.resolve({ ...IDENTITY, status: "ok", storage: "ok", channels: {} });
    const open = healthEndpointFor(
      {
        host: "127.0.0.1",
        port: 1,
        tls: undefined,
        plaintext: true,
        auth: { kind: "none" },
        metrics: METRICS_ON,
      },
      report,
      {},
      logger,
    );
    expect(open).toBeInstanceOf(HealthEndpoint);
    expect(events).toEqual([
      expect.objectContaining({ level: 40, event: "plaintext", endpoint: "health" }),
      expect.objectContaining({ level: 40, event: "unauthenticated", endpoint: "health" }),
      expect.objectContaining({ level: 40, event: "metrics-refused", endpoint: "health" }),
    ]);
    expect(() =>
      healthEndpointFor(
        {
          host: "127.0.0.1",
          port: 1,
          tls: { cert: certs.files.serverCert, key: certs.files.serverKey, ca: undefined },
          plaintext: false,
          auth: { kind: "bearer", env: "PATHWAYS_HEALTH_TOKEN" },
          metrics: METRICS_ON,
        },
        report,
        {},
        logger,
      ),
    ).toThrow(
      "pathways.yaml: health.auth: the environment variable PATHWAYS_HEALTH_TOKEN is not set",
    );

    const secured = healthEndpointFor(
      {
        host: "127.0.0.1",
        port: 0,
        tls: { cert: certs.files.serverCert, key: certs.files.serverKey, ca: undefined },
        plaintext: false,
        auth: { kind: "bearer", env: "PATHWAYS_HEALTH_TOKEN" },
        metrics: METRICS_ON,
      },
      report,
      { PATHWAYS_HEALTH_TOKEN: HEALTH_TOKEN },
      logger,
    );
    await secured.start();
    closers.push(() => secured.stop());
    const port = secured.port ?? 0;
    expect((await send(port, { method: "GET", ca: certs.ca })).status).toBe(401);
    expect(events.at(-1)).toMatchObject({ event: "http-refused", endpoint: "health", status: 401 });
  });

  it("answers /metrics 403 on a TLS listener with auth: none and no client CA, unless it opts in", async () => {
    const { logger, events } = captureLogger();
    const report = (): Promise<HealthReport> =>
      Promise.resolve({ ...IDENTITY, status: "ok", storage: "ok", channels: {} });
    const scrape = (): Promise<string> => Promise.resolve("# EOF\n");
    const listener = (allowUnauthenticated: boolean) =>
      healthEndpointFor(
        {
          host: "127.0.0.1",
          port: 0,
          tls: { cert: certs.files.serverCert, key: certs.files.serverKey, ca: undefined },
          plaintext: false,
          auth: { kind: "none" },
          metrics: { enabled: true, allowUnauthenticated },
        },
        report,
        {},
        logger,
        undefined,
        scrape,
      );
    const refusing = listener(false);
    await refusing.start();
    closers.push(() => refusing.stop());
    expect(events).toContainEqual(
      expect.objectContaining({ level: 40, event: "metrics-refused", endpoint: "health" }),
    );
    const refused = await send(refusing.port ?? 0, {
      method: "GET",
      path: "/metrics",
      ca: certs.ca,
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("health.metrics.allowUnauthenticated");

    const opted = listener(true);
    await opted.start();
    closers.push(() => opted.stop());
    const served = await send(opted.port ?? 0, { method: "GET", path: "/metrics", ca: certs.ca });
    expect(served.status).toBe(200);
    expect(served.body).toBe("# EOF\n");
  });
});

describe("an HTTP channel that reads batches", () => {
  /** A synthetic ADT^A01 whose control ID is `MSG<n>`: every value is made up. */
  const adt = (n: number): string =>
    ADT_A01.replace("MSG00001", `MSG${String(n).padStart(5, "0")}`);

  it("refuses a changed body under a key the store holds for another, and stores either at once once", async () => {
    const tls = `tls: { cert: ${certs.files.serverCert}, key: ${certs.files.serverKey} }`;
    const { store, port } = await setUp(200, {
      source: (port) =>
        `http: { port: ${String(port)}, path: /adt, batch: { split: hl7 }, ${tls} }`,
    });
    const batch = (key: string, body: string): ReturnType<typeof send> =>
      send(port, {
        path: "/adt",
        headers: { Authorization: `Bearer ${TOKEN}`, "Idempotency-Key": `"${key}"` },
        body,
        ca: certs.ca,
      });
    const count = async (): Promise<number> =>
      (await store.listMessages({ channel: "adt", limit: 100 })).items.length;

    const first = await batch("synthetic-key-0001", `${adt(1)}${adt(2)}`);
    expect([first.status, first.body]).toEqual([202, JSON.stringify({ ids: [1, 2] })]);
    const changed = await batch("synthetic-key-0001", `${adt(1)}${adt(2)}${adt(3)}`);
    expect([changed.status, changed.body]).toEqual([
      422,
      JSON.stringify({ error: "BATCH_KEY_REUSED" }),
    ]);
    const again = await batch("synthetic-key-0001", `${adt(1)}${adt(2)}`);
    expect([again.status, again.body]).toEqual([202, JSON.stringify({ ids: [1, 2] })]);
    expect(await count()).toBe(2);

    // Sent at once under one new key: one body is stored whole, the other refused. A piece found
    // stored already takes up an id it gives back, so ids are not counted on here.
    const raced = await Promise.all([
      batch("synthetic-key-0002", `${adt(4)}`),
      batch("synthetic-key-0002", `${adt(4)}${adt(5)}`),
    ]);
    expect(raced.map((answer) => answer.status).sort()).toEqual([202, 422]);
    const stored = raced[0]?.status === 202 ? 1 : 2;
    expect(await count()).toBe(2 + stored);
    // The same body at once twice under a third key: stored once, both told the same ids.
    const twice = await Promise.all(
      [1, 2].map(() => batch("synthetic-key-0003", `${adt(6)}${adt(7)}`)),
    );
    expect(twice.map((answer) => answer.status)).toEqual([202, 202]);
    expect(twice[1]?.body).toBe(twice[0]?.body);
    expect(await count()).toBe(4 + stored);
  });
});
