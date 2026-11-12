import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ChannelConfig, HealthConfig } from "../src/config/schema.js";
import { MllpSource } from "../src/connectors/mllp.js";
import { TcpSource } from "../src/connectors/tcp.js";
import type { DestinationConnector } from "../src/connectors/types.js";
import { connectorsFor, Engine, type ChannelConnectors } from "../src/engine/engine.js";
import {
  HealthEndpoint,
  healthEndpointFor,
  metricsMode,
  type HealthReport,
} from "../src/engine/health.js";
import {
  DELIVERY_DURATION_BUCKETS,
  EngineMetrics,
  escapeLabel,
  METRIC_FAMILIES,
  METRICS_STORE_CACHE_MS,
  METRICS_STORE_TIMEOUT_MS,
  OPENMETRICS_CONTENT_TYPE,
  type MetricsSnapshot,
} from "../src/engine/metrics.js";
import type { LifecycleEvent } from "../src/extensions/events.js";
import type { Store } from "../src/storage/store.js";
import { available, closeAdmins, dropDatabases, TEST_DATABASES, testStorage } from "./databases.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
} from "./helpers.js";
import { MemoryStore } from "./memory-store.js";
import { send } from "./net-helpers.js";
import { parseOpenMetrics } from "./openmetrics.js";

/** 2026-11-10T12:00:00.000Z: every series in the golden text was made then. */
const MADE_AT = Date.UTC(2026, 10, 10, 12, 0, 0);
const AT = new Date(MADE_AT).toISOString();
const GOLDEN_FILE = join(import.meta.dirname, "golden", "metrics.txt");
const GOLDEN = existsSync(GOLDEN_FILE) ? readFileSync(GOLDEN_FILE, "utf8") : "";
const TOKEN = "synthetic-health-token-0123456789";
const IDENTITY = {
  version: "0.0.1",
  schemaGeneration: 6,
  node: "0000000000000000",
  role: "single",
  leaseEpoch: null,
  draining: false,
} as const;

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
  - file: { dir: ../../data/unused }
`;

/** Events whose every field but the channel, destination and type must stay out of the text. */
const EVENTS: readonly LifecycleEvent[] = [
  {
    type: "received",
    at: AT,
    channel: "adt-to-lab",
    messageId: 90_417,
    bytes: 812,
    failed: false,
    duplicateOf: 90_301,
  },
  {
    type: "received",
    at: AT,
    channel: "adt-to-lab",
    messageId: 90_418,
    bytes: 9,
    failed: true,
    duplicateOf: undefined,
  },
  {
    type: "receive-failed",
    at: AT,
    channel: "adt-to-lab",
    name: "SqliteError",
    code: "SQLITE_FULL",
  },
  { type: "transformed", at: AT, channel: "adt-to-lab", messageId: 90_417, outputs: 2 },
  { type: "filtered", at: AT, channel: "adt-to-lab", messageId: 90_419 },
  {
    type: "transform-failed",
    at: AT,
    channel: "adt-to-lab",
    messageId: 90_420,
    kind: "transform",
    name: "TypeError",
    code: undefined,
    where: "transform.ts:12:3",
  },
  {
    type: "delivery-redirected",
    at: AT,
    channel: "adt-to-lab",
    messageId: 90_417,
    destination: 1,
    deliveryId: 77_001,
    attempt: 1,
    retryInMs: 300_000,
    retryAt: AT,
    status: 302,
    locationHost: "elsewhere.example.test",
  },
  {
    type: "settled",
    at: AT,
    channel: "adt-to-lab",
    messageId: 90_417,
    destinations: [
      { index: 0, name: "file", state: "delivered" },
      { index: 1, name: "http", state: "dry-run" },
    ],
  },
  {
    type: "source-down",
    at: AT,
    channel: "adt-to-lab",
    attempt: 1,
    retryInMs: 1000,
    retryAt: AT,
    name: "Error",
    code: "EADDRINUSE",
  },
];

/**
 * The text the golden file holds: two channels, the first with a named destination and an unnamed
 * one, counters, a histogram and every gauge.
 */
function goldenText(): string {
  const metrics = new EngineMetrics(
    [
      { name: "adt-to-lab", destinations: ["lab", undefined] },
      { name: "orders", destinations: 1 },
    ],
    () => MADE_AT,
  );
  for (const event of EVENTS) metrics.observe(event);
  metrics.handedIn("orders");
  metrics.sourceRefused("orders", 415);
  metrics.deliveryAttempt("adt-to-lab", 0, "delivered", 0.004);
  metrics.deliveryAttempt("adt-to-lab", 0, "delivered", 0.25);
  metrics.deliveryAttempt("adt-to-lab", 1, "retry", 75);
  metrics.deliveryAttempt("orders", 0, "dry_run");
  const snapshot: MetricsSnapshot = {
    store: { up: true, latencySeconds: 0.0125 },
    channels: [
      {
        channel: "adt-to-lab",
        sourceUp: true,
        openConnections: 3,
        messagesFailed: 1,
        destinations: [
          { destination: 0, queueDepth: 0, oldestPendingAgeSeconds: 0, retrying: 0, failed: 0 },
          { destination: 1, queueDepth: 4, oldestPendingAgeSeconds: 81.5, retrying: 1, failed: 2 },
        ],
      },
      { channel: "orders", sourceUp: false, messagesFailed: 0 },
    ],
  };
  return metrics.render(snapshot);
}

describe("the OpenMetrics text", () => {
  it("matches the golden text", () => {
    // WRITE_GOLDEN=1 rewrites the file after a deliberate change, for review in the diff.
    if (process.env["WRITE_GOLDEN"] === "1") writeFileSync(GOLDEN_FILE, goldenText());
    expect(goldenText()).toBe(GOLDEN);
  });

  it("is valid OpenMetrics: every family, counters with _created, histograms with +Inf", () => {
    const families = parseOpenMetrics(goldenText());
    expect(families.map((family) => family.name)).toEqual(
      METRIC_FAMILIES.map((family) => family.name),
    );
    for (const family of families) {
      const declared = METRIC_FAMILIES.find((f) => f.name === family.name);
      expect(family.type).toBe(declared?.type);
      expect(family.name.startsWith("pathways_")).toBe(true);
      if (declared?.unit !== undefined) expect(family.unit).toBe(declared.unit);
      for (const sample of family.samples) {
        const labels = Object.keys(sample.labels).filter((label) => label !== "le");
        expect(labels).toEqual(declared?.labels.filter((label) => labels.includes(label)));
        for (const label of labels) expect(declared?.labels).toContain(label);
      }
      if (family.type === "counter") {
        const totals = family.samples.filter((s) => s.name.endsWith("_total"));
        const created = family.samples.filter((s) => s.name.endsWith("_created"));
        expect(totals.length).toBeGreaterThan(0);
        expect(created).toHaveLength(totals.length);
        for (const sample of created) expect(sample.value).toBe(MADE_AT / 1000);
      }
    }
    const histogram = families.find((f) => f.name === "pathways_delivery_duration_seconds");
    const infinite = histogram?.samples.filter((s) => s.labels["le"] === "+Inf") ?? [];
    expect(infinite).toHaveLength(3);
    expect(
      histogram?.samples.filter(
        (s) => s.name.endsWith("_bucket") && s.labels["channel"] === "orders",
      ),
    ).toHaveLength(DELIVERY_DURATION_BUCKETS.length + 1);
  });

  it("ends with # EOF and declares its families before their samples", () => {
    const text = goldenText();
    expect(text.endsWith("\n# EOF\n")).toBe(true);
    expect(text.indexOf("# TYPE pathways_queue_depth gauge")).toBeLessThan(
      text.indexOf("pathways_queue_depth{"),
    );
  });

  it("carries no message id, error text, error name, code, host or path from an event", () => {
    const text = goldenText();
    for (const leak of [
      "90417",
      "90418",
      "90301",
      "77001",
      "SqliteError",
      "SQLITE_FULL",
      "TypeError",
      "transform.ts",
      "elsewhere.example.test",
      "EADDRINUSE",
      "302",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it("reads the same before anything is counted: every series at 0", () => {
    const metrics = new EngineMetrics([{ name: "adt", destinations: 1 }], () => MADE_AT);
    const text = metrics.render({ channels: [] });
    expect(text).toContain('pathways_messages_received_total{channel="adt",outcome="stored"} 0\n');
    expect(text).toContain(
      'pathways_deliveries_total{channel="adt",destination="0",outcome="exhausted"} 0\n',
    );
    expect(text).toContain(
      'pathways_delivery_duration_seconds_bucket{channel="adt",destination="0",le="+Inf"} 0\n',
    );
    expect(text).not.toMatch(/^pathways_store_up /m);
    parseOpenMetrics(text);
  });

  it("writes +Inf, -Inf and NaN by name, and a duration past the last bound in +Inf alone", () => {
    const metrics = new EngineMetrics([{ name: "adt", destinations: 1 }], () => MADE_AT);
    metrics.deliveryAttempt("adt", 0, "retry", 600);
    const text = metrics.render({
      store: { up: false, latencySeconds: Number.NaN },
      channels: [
        {
          channel: "adt",
          sourceUp: true,
          destinations: [
            {
              destination: 0,
              queueDepth: 0,
              oldestPendingAgeSeconds: Number.POSITIVE_INFINITY,
              retrying: Number.NEGATIVE_INFINITY,
              failed: 0,
            },
          ],
        },
      ],
    });
    expect(text).toContain("pathways_store_latency_seconds NaN\n");
    expect(text).toContain(
      'pathways_oldest_pending_age_seconds{channel="adt",destination="0"} +Inf\n',
    );
    expect(text).toContain('pathways_deliveries_retrying{channel="adt",destination="0"} -Inf\n');
    expect(text).toContain(
      'pathways_delivery_duration_seconds_bucket{channel="adt",destination="0",le="60.0"} 0\n',
    );
    expect(text).toContain(
      'pathways_delivery_duration_seconds_bucket{channel="adt",destination="0",le="+Inf"} 1\n',
    );
    parseOpenMetrics(text);
  });

  it("the reader refuses what breaks the format, so its pass means something", () => {
    const good = "# TYPE x gauge\nx 1\n# EOF\n";
    expect(() => parseOpenMetrics(good)).not.toThrow();
    expect(() => parseOpenMetrics("# TYPE x gauge\nx 1\n")).toThrow("# EOF");
    expect(() => parseOpenMetrics('# TYPE x gauge\nx{c="a"b"} 1\n# EOF\n')).toThrow();
    expect(() => parseOpenMetrics('# TYPE x gauge\nx{c="a\nb"} 1\n# EOF\n')).toThrow();
    expect(() => parseOpenMetrics("# TYPE x counter\nx 1\n# EOF\n")).toThrow("not of the counter");
    expect(() =>
      parseOpenMetrics('# TYPE h histogram\nh_bucket{le="1.0"} 1\nh_count 1\n# EOF\n'),
    ).toThrow("+Inf");
    expect(() =>
      parseOpenMetrics('# TYPE x gauge\nx{c="a"} 1\nx{c="b"} 1\nx{c="a"} 1\n# EOF\n'),
    ).toThrow();
    expect(() =>
      parseOpenMetrics("# TYPE x_seconds gauge\n# UNIT x_seconds bytes\n# EOF\n"),
    ).toThrow("unit");
  });
});

describe("a channel name that would break the text", () => {
  it("is escaped: a quote, a backslash and a line feed stay inside its label value", () => {
    const name = 'adt"} 1\npathways_store_up 0\n\\';
    const metrics = new EngineMetrics([{ name, destinations: 1 }], () => MADE_AT);
    const text = metrics.render({
      store: { up: true, latencySeconds: 0.01 },
      channels: [{ channel: name, sourceUp: true, messagesFailed: 0 }],
    });
    expect(escapeLabel(name)).toBe('adt\\"} 1\\npathways_store_up 0\\n\\\\');
    const families = parseOpenMetrics(text);
    const up = families.find((family) => family.name === "pathways_store_up");
    expect(up?.samples).toEqual([{ name: "pathways_store_up", labels: {}, value: 1 }]);
    const source = families.find((family) => family.name === "pathways_source_up");
    expect(source?.samples[0]?.labels["channel"]).toBe(name);
  });

  it("whatever its characters, the text stays valid and the name reads back whole", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (name) => {
        const metrics = new EngineMetrics([{ name, destinations: 1 }], () => MADE_AT);
        metrics.deliveryAttempt(name, 0, "delivered", 0.02);
        const families = parseOpenMetrics(
          metrics.render({ channels: [{ channel: name, sourceUp: true, messagesFailed: 1 }] }),
        );
        for (const family of families) {
          for (const sample of family.samples) {
            if ("channel" in sample.labels) expect(sample.labels["channel"]).toBe(name);
          }
        }
      }),
    );
  });
});

describe("GET /metrics on the health endpoint", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });
  const report = (): Promise<HealthReport> =>
    Promise.resolve({ ...IDENTITY, status: "ok", storage: "ok", channels: {} });

  async function endpoint(
    metrics: (() => Promise<string>) | "refused" | undefined,
    token: string | null = TOKEN,
  ): Promise<number> {
    const health = new HealthEndpoint({
      host: "127.0.0.1",
      port: 0,
      tls: undefined,
      token: token ?? undefined,
      report,
      ...(metrics === undefined ? {} : { metrics }),
    });
    await health.start();
    closers.push(() => health.stop());
    return health.port ?? 0;
  }

  it("serves the OpenMetrics text behind the endpoint's token", async () => {
    const port = await endpoint(() => Promise.resolve(goldenText()));
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const ok = await send(port, { method: "GET", path: "/metrics", headers: auth });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe(OPENMETRICS_CONTENT_TYPE);
    expect(ok.headers["content-type"]).toContain("application/openmetrics-text; version=1.0.0");
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.body).toBe(GOLDEN);
    const query = await send(port, { method: "GET", path: "/metrics?x=1", headers: auth });
    expect(query.body).toBe(GOLDEN);
    const head = await send(port, { method: "HEAD", path: "/metrics", headers: auth });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect((await send(port, { method: "GET", path: "/metrics" })).status).toBe(401);
    // Every other path still answers with the health body.
    const body = await send(port, { method: "GET", path: "/", headers: auth });
    expect(JSON.parse(body.body)).toMatchObject({ status: "ok" });
  });

  it("answers 403 when refused, and the health body when there are no metrics", async () => {
    const refused = await endpoint("refused", null);
    const answer = await send(refused, { method: "GET", path: "/metrics" });
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("health.metrics.allowUnauthenticated");
    const none = await endpoint(undefined, null);
    const health = await send(none, { method: "GET", path: "/metrics" });
    expect(health.status).toBe(200);
    expect(health.headers["content-type"]).toBe("application/json");
  });
});

describe("metricsMode and healthEndpointFor", () => {
  const listener = (
    overrides: Partial<HealthConfig> & Pick<HealthConfig, "metrics">,
  ): HealthConfig => ({
    host: "127.0.0.1",
    port: 0,
    tls: undefined,
    plaintext: true,
    auth: { kind: "bearer", env: "PATHWAYS_HEALTH_TOKEN" },
    ...overrides,
  });
  const on = { enabled: true, allowUnauthenticated: false };

  it("serves behind a token, refuses a listener without one unless it opts in", () => {
    expect(metricsMode(listener({ metrics: on }))).toBe("serve");
    expect(metricsMode(listener({ metrics: on, auth: { kind: "none" } }))).toBe("refuse");
    expect(
      metricsMode(
        listener({
          metrics: { enabled: true, allowUnauthenticated: true },
          auth: { kind: "none" },
        }),
      ),
    ).toBe("serve");
    expect(
      metricsMode(
        listener({
          metrics: on,
          plaintext: false,
          auth: { kind: "none" },
          tls: { cert: "c.pem", key: "k.pem", ca: undefined },
        }),
      ),
    ).toBe("refuse");
    expect(metricsMode(listener({ metrics: { enabled: false, allowUnauthenticated: true } }))).toBe(
      "off",
    );
  });

  it("refuses a TLS listener with auth: none and no client CA, as a plaintext one, unless it opts in", () => {
    const tls = { cert: "c.pem", key: "k.pem", ca: undefined };
    const open = { plaintext: false, auth: { kind: "none" } as const, tls };
    expect(metricsMode(listener({ metrics: on, ...open }))).toBe("refuse");
    expect(
      metricsMode(listener({ metrics: { enabled: true, allowUnauthenticated: true }, ...open })),
    ).toBe("serve");
    // Mutual TLS checks who connects, so it serves without a token.
    expect(metricsMode(listener({ metrics: on, ...open, tls: { ...tls, ca: "ca.pem" } }))).toBe(
      "serve",
    );
    // A token on TLS serves.
    expect(metricsMode(listener({ metrics: on, plaintext: false, tls }))).toBe("serve");
  });

  it("answers /metrics with the health body when metrics are off", async () => {
    const { logger } = captureLogger();
    const health = healthEndpointFor(
      listener({
        metrics: { enabled: false, allowUnauthenticated: false },
        auth: { kind: "none" },
      }),
      () => Promise.resolve({ ...IDENTITY, status: "ok", storage: "ok", channels: {} }),
      {},
      logger,
      undefined,
      () => Promise.resolve("# EOF\n"),
    );
    await health.start();
    try {
      const answer = await send(health.port ?? 0, { method: "GET", path: "/metrics" });
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toMatchObject({ status: "ok" });
    } finally {
      await health.stop();
    }
  });

  it("logs metrics-refused once, and answers /metrics 403, on a listener open to anyone", async () => {
    const { logger, events } = captureLogger();
    const health = healthEndpointFor(
      listener({ metrics: on, auth: { kind: "none" } }),
      () => Promise.resolve({ ...IDENTITY, status: "ok", storage: "ok", channels: {} }),
      {},
      logger,
      undefined,
      () => Promise.resolve("# EOF\n"),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ level: 40, event: "metrics-refused", endpoint: "health" }),
    );
    await health.start();
    try {
      const answer = await send(health.port ?? 0, { method: "GET", path: "/metrics" });
      expect(answer.status).toBe(403);
    } finally {
      await health.stop();
    }
  });
});

describe("the health block's metrics settings", () => {
  afterEach(cleanUp);

  const channel = {
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": LAB_TRANSFORM,
  };

  it("default to served and not open, and read what the block sets", async () => {
    const plain = await loadProject(
      await makeProject({
        ...channel,
        "pathways.yaml": "health:\n  port: 9090\n  plaintext: true\n",
      }),
    );
    expect(plain.health?.metrics).toEqual({ enabled: true, allowUnauthenticated: false });
    const open = await loadProject(
      await makeProject({
        ...channel,
        "pathways.yaml":
          "health:\n  port: 9090\n  plaintext: true\n  auth: none\n  metrics: { allowUnauthenticated: true }\n",
      }),
    );
    expect(open.health?.metrics).toEqual({ enabled: true, allowUnauthenticated: true });
    const off = await loadProject(
      await makeProject({
        ...channel,
        "pathways.yaml":
          "health:\n  port: 9090\n  plaintext: true\n  metrics: { enabled: false }\n",
      }),
    );
    expect(off.health && metricsMode(off.health)).toBe("off");
  });
});

/** A destination that fails every attempt without a code, so each is retried. */
const failing: DestinationConnector = {
  deliver: () => Promise.reject(new Error("synthetic refusal")),
};

const engines: Engine[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`the engine's metrics on ${database.label}`, () => {
    it("counts what happens, and reads the queue gauges from the store", async () => {
      const root = await makeProject({
        "channels/adt/channel.yaml": CHANNEL,
        "channels/adt/transform.ts": LAB_TRANSFORM,
      });
      const project = await loadProject(root);
      const store = await (await testStorage(database, project.databaseFile)).open();
      stores.push(store);
      const { logger } = captureLogger();
      const clock = { now: Date.now() };
      const metrics = new EngineMetrics(
        project.channels.map((c) => ({ name: c.name, destinations: c.destinations.length })),
      );
      const engine = new Engine({
        project,
        store,
        logger,
        now: () => clock.now,
        monotonic: () => clock.now,
        metrics,
        connectors: async (channel: ChannelConfig): Promise<ChannelConnectors> => {
          const built = await connectorsFor(channel, { now: () => clock.now, logger, env: {} });
          return {
            source: built.source,
            destinations: [built.destinations[0] ?? failing, failing],
          };
        },
      });
      engines.push(engine);
      await engine.start();
      await dropFile(join(root, "data", "inbox", "TESTPATIENT-a01.hl7"), ADT_A01);
      await dropFile(join(root, "data", "inbox", "TESTPATIENT-a08.hl7"), ADT_A08);
      await engine.tick();
      clock.now += 30_000;

      const snapshot = await engine.metricsSnapshot();
      expect(snapshot.store?.up).toBe(true);
      expect(snapshot.store?.latencySeconds).toBeGreaterThanOrEqual(0);
      expect(snapshot.channels).toEqual([
        {
          channel: "adt",
          sourceUp: true,
          messagesFailed: 0,
          destinations: [
            { destination: 0, queueDepth: 0, oldestPendingAgeSeconds: 0, retrying: 0, failed: 0 },
            {
              destination: 1,
              queueDepth: 1,
              oldestPendingAgeSeconds: expect.any(Number) as number,
              retrying: 1,
              failed: 0,
            },
          ],
        },
      ]);
      expect(
        snapshot.channels[0]?.destinations?.[1]?.oldestPendingAgeSeconds,
      ).toBeGreaterThanOrEqual(29);

      const families = parseOpenMetrics(metrics.render(snapshot));
      const value = (name: string, labels: Record<string, string>): number | undefined =>
        families
          .flatMap((family) => family.samples)
          .find(
            (sample) =>
              sample.name === name &&
              Object.entries(labels).every(([key, text]) => sample.labels[key] === text),
          )?.value;
      expect(value("pathways_messages_received_total", { outcome: "stored" })).toBe(2);
      expect(value("pathways_transforms_total", { outcome: "transformed" })).toBe(1);
      expect(value("pathways_transforms_total", { outcome: "filtered" })).toBe(1);
      expect(value("pathways_deliveries_total", { destination: "0", outcome: "delivered" })).toBe(
        1,
      );
      expect(value("pathways_deliveries_total", { destination: "1", outcome: "retry" })).toBe(1);
      expect(
        value("pathways_delivery_duration_seconds_count", { channel: "adt", destination: "1" }),
      ).toBe(1);
      expect(value("pathways_queue_depth", { destination: "1" })).toBe(1);
      expect(value("pathways_source_up", { channel: "adt" })).toBe(1);

      // Destination 0 has nothing pending or failed, so the store leaves it out.
      expect(await store.destinationQueues("adt")).toEqual([
        {
          destination: 1,
          destinationKey: expect.any(String) as string,
          pending: 1,
          retrying: 1,
          failed: 0,
          oldestPendingSince: expect.any(String) as string,
        },
      ]);

      // Failed for good, it leaves the queue and counts as failed.
      const [retrying] = await store.listRetrying("adt", 10);
      await store.failDelivery(retrying?.id ?? 0, "synthetic: exhausted");
      expect(await store.destinationQueues("adt")).toEqual([
        {
          destination: 1,
          destinationKey: expect.any(String) as string,
          pending: 0,
          retrying: 0,
          failed: 1,
          oldestPendingSince: undefined,
        },
      ]);

      await store.close();
      stores.splice(0);
      clock.now += METRICS_STORE_CACHE_MS;
      const down = await engine.metricsSnapshot();
      expect(down.store?.up).toBe(false);
      expect(down.channels).toEqual([{ channel: "adt", sourceUp: true }]);
    });
  });
}

describe("the engine's metrics on a store without destinationQueues", () => {
  it("serves no queue gauges, counts the connections an MLLP and a tcp source hold, and a source down", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
      "channels/orders/channel.yaml": CHANNEL,
      "channels/orders/transform.ts": LAB_TRANSFORM,
      "channels/results/channel.yaml": CHANNEL,
      "channels/results/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const { logger } = captureLogger();
    const mllp = new MllpSource({ host: "127.0.0.1", port: 0, tls: undefined });
    const tcp = new TcpSource({
      host: "127.0.0.1",
      port: 0,
      tls: undefined,
      framing: { kind: "delimiter", delimiter: Buffer.from("\n") },
      maxMessageSize: 1_024,
      idleTimeoutMs: 5_000,
      stallTimeoutMs: 5_000,
    });
    const engine = new Engine({
      project,
      store: new MemoryStore(),
      logger,
      metrics: new EngineMetrics(),
      connectors: (channel: ChannelConfig): ChannelConnectors => ({
        source:
          channel.name === "adt"
            ? mllp
            : channel.name === "orders"
              ? tcp
              : { start: () => Promise.reject(new Error("synthetic: cannot listen")) },
        destinations: [failing, failing],
      }),
    });
    engines.push(engine);
    await engine.start();
    const snapshot = await engine.metricsSnapshot();
    expect(snapshot.store?.up).toBe(true);
    expect(snapshot.channels).toEqual([
      { channel: "adt", sourceUp: true, openConnections: 0, messagesFailed: 0 },
      { channel: "orders", sourceUp: true, openConnections: 0, messagesFailed: 0 },
      { channel: "results", sourceUp: false, messagesFailed: 0 },
    ]);
  });
});

describe("the engine's metrics store reads", () => {
  it("serve concurrent and rapid scrapes from one set of reads, for a short fixed time", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
      "channels/orders/channel.yaml": CHANNEL,
      "channels/orders/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const { logger } = captureLogger();
    const store = new MemoryStore();
    let reads = 0;
    const clock = { now: Date.UTC(2026, 10, 10, 12, 0, 0), monotonic: 1_000 };
    const mllp = new MllpSource({ host: "127.0.0.1", port: 0, tls: undefined });
    const engine = new Engine({
      project,
      store,
      logger,
      now: () => clock.now,
      monotonic: () => clock.monotonic,
      metrics: new EngineMetrics(),
      connectors: (channel: ChannelConfig): ChannelConnectors => ({
        source:
          channel.name === "adt"
            ? mllp
            : { start: () => Promise.reject(new Error("synthetic: cannot listen")) },
        destinations: [failing, failing],
      }),
    });
    engines.push(engine);
    await engine.start();
    const counts = store.messageCounts.bind(store);
    store.messageCounts = (channel: string) => {
      reads += 1;
      return counts(channel);
    };

    // Two channels: one set of reads is two.
    const [first, second] = await Promise.all([engine.metricsSnapshot(), engine.metricsSnapshot()]);
    expect(reads).toBe(2);
    expect(second).toEqual(first);
    clock.monotonic += METRICS_STORE_CACHE_MS - 1;
    const rapid = await engine.metricsSnapshot();
    expect(reads).toBe(2);
    // The gauges that cost no read are still read at each scrape.
    expect(rapid.channels.map((c) => c.sourceUp)).toEqual([true, false]);

    clock.monotonic += 1;
    await engine.metricsSnapshot();
    expect(reads).toBe(4);
  });

  it("keeps the store reading down for the same time, so a down store is not read on every scrape", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const { logger } = captureLogger();
    const store = new MemoryStore();
    let reads = 0;
    const clock = { monotonic: 1_000 };
    const engine = new Engine({
      project,
      store,
      logger,
      monotonic: () => clock.monotonic,
      metrics: new EngineMetrics(),
      connectors: (): ChannelConnectors => ({
        source: { start: () => Promise.resolve() },
        destinations: [failing, failing],
      }),
    });
    engines.push(engine);
    await engine.start();
    store.messageCounts = () => {
      reads += 1;
      return Promise.reject(new Error("synthetic: store down"));
    };
    expect((await engine.metricsSnapshot()).store?.up).toBe(false);
    expect((await engine.metricsSnapshot()).store?.up).toBe(false);
    expect(reads).toBe(1);
    clock.monotonic += METRICS_STORE_CACHE_MS;
    await engine.metricsSnapshot();
    expect(reads).toBe(2);
  });

  it("reads a store that never answers as down within the timeout, starts no new reads while they hang, and reads it up once they answer", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const { logger } = captureLogger();
    const store = new MemoryStore();
    const clock = { monotonic: 1_000 };
    const metrics = new EngineMetrics();
    const engine = new Engine({
      project,
      store,
      logger,
      monotonic: () => clock.monotonic,
      metrics,
      connectors: (): ChannelConnectors => ({
        source: { start: () => Promise.resolve() },
        destinations: [failing, failing],
      }),
    });
    engines.push(engine);
    await engine.start();
    const counts = store.messageCounts.bind(store);
    const answer = await counts("adt");
    // A database that hangs: the read neither answers nor fails until it is let go.
    let reads = 0;
    let letGo: () => void = () => undefined;
    const hung = new Promise<typeof answer>((resolve) => {
      letGo = () => {
        resolve(answer);
      };
    });
    store.messageCounts = () => {
      reads += 1;
      return hung;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answered = false;
      const scrape = engine.metricsSnapshot().finally(() => {
        answered = true;
      });
      await vi.advanceTimersByTimeAsync(METRICS_STORE_TIMEOUT_MS - 1);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const down = await scrape;
      expect(down.store).toEqual({ up: false, latencySeconds: METRICS_STORE_TIMEOUT_MS / 1000 });
      expect(down.channels).toEqual([{ channel: "adt", sourceUp: true }]);
      expect(metrics.render(down)).toMatch(/^pathways_store_up 0$/m);
      expect(reads).toBe(1);

      // The second and third scrapes after the cache, while the reads still hang: down at once,
      // latency counted from when the hung reads began, and no new reads.
      for (const seconds of [5, 10]) {
        clock.monotonic += METRICS_STORE_CACHE_MS;
        let now = false;
        const later = engine.metricsSnapshot().finally(() => {
          now = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(1);
        expect(now).toBe(true);
        expect((await later).store).toEqual({ up: false, latencySeconds: seconds });
      }

      // It answers: the next scrape after the cache reads afresh and finds it up.
      letGo();
      await vi.advanceTimersByTimeAsync(0);
      store.messageCounts = (channel: string) => {
        reads += 1;
        return counts(channel);
      };
      clock.monotonic += METRICS_STORE_CACHE_MS;
      expect((await engine.metricsSnapshot()).store?.up).toBe(true);
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares a set of reads that hangs with a scrape at the cache's edge, before its timer fires, and starts no second set", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const { logger } = captureLogger();
    const store = new MemoryStore();
    const clock = { monotonic: 1_000 };
    const engine = new Engine({
      project,
      store,
      logger,
      monotonic: () => clock.monotonic,
      metrics: new EngineMetrics(),
      connectors: (): ChannelConnectors => ({
        source: { start: () => Promise.resolve() },
        destinations: [failing, failing],
      }),
    });
    engines.push(engine);
    await engine.start();
    let reads = 0;
    store.messageCounts = () => {
      reads += 1;
      return new Promise(() => undefined);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = engine.metricsSnapshot();
      await vi.advanceTimersByTimeAsync(METRICS_STORE_TIMEOUT_MS - 1);
      // The cache has run out by the engine's clock, but the first set's timer has not fired.
      clock.monotonic += METRICS_STORE_CACHE_MS;
      const edge = engine.metricsSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await first).store).toEqual({
        up: false,
        latencySeconds: METRICS_STORE_TIMEOUT_MS / 1000,
      });
      expect((await edge).store?.up).toBe(false);
      // Later scrapes while it hangs: down at once, and still one set.
      clock.monotonic += METRICS_STORE_CACHE_MS;
      expect((await engine.metricsSnapshot()).store).toEqual({ up: false, latencySeconds: 10 });
      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
