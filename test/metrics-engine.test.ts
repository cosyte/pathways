// The engine's metrics against what main does with a message: named destinations and their keys,
// hand-offs between channels, batches, refused bodies and the settled event. Every series a scrape
// serves is scanned: its labels come from fixed sets and configured names only.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ChannelConfig, ProjectConfig } from "../src/config/schema.js";
import { DeliveryRejected, type DestinationConnector } from "../src/connectors/types.js";
import { connectorsFor, Engine, type ChannelConnectors } from "../src/engine/engine.js";
import {
  DELIVERY_DURATION_BUCKETS,
  destinationLabels,
  EngineMetrics,
  METRIC_FAMILIES,
  METRIC_OUTCOMES,
} from "../src/engine/metrics.js";
import type { LifecycleEvent } from "../src/extensions/events.js";
import type { Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
  type TestStorage,
} from "./databases.js";
import { ADT_A01, ADT_A08, captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";
import { onPickedPorts, send, sourceListening } from "./net-helpers.js";
import { parseOpenMetrics } from "./openmetrics.js";

const TOKEN = "synthetic-token-0123456789abcdef";

/** What a synthetic message carries that no label may: its control id, patient id and name. */
const MESSAGE_VALUES = ["MSG00001", "MSG00002", "TEST000001", "TESTPATIENT", "ALPHA", "SYNTH"];

const engines: Engine[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

/** A destination that fails every attempt without a code, so each is retried. */
const failing: DestinationConnector = {
  deliver: () => Promise.reject(new Error("synthetic refusal TESTPATIENT")),
};

/** Metrics that keep every event they count, to hold the counters to the events. */
class Watched extends EngineMetrics {
  readonly events: LifecycleEvent[] = [];
  override observe(event: LifecycleEvent): void {
    this.events.push(event);
    super.observe(event);
  }
}

function metricsFor(project: ProjectConfig): Watched {
  return new Watched(
    project.channels.map(({ name, destinations }) => ({
      name,
      destinations: destinations.map((destination) => destination.name),
    })),
  );
}

interface Started {
  readonly root: string;
  readonly project: ProjectConfig;
  readonly engine: Engine;
  readonly store: Store;
  readonly storage: TestStorage;
  readonly metrics: Watched;
}

/**
 * Starts an engine with metrics on a new project of `files`, or, given `again`, on that project
 * with `files` written over it and the same database.
 */
async function start(
  database: TestDatabase,
  files: Record<string, string>,
  connectors?: (channel: ChannelConfig) => Promise<ChannelConnectors>,
  again?: { readonly root: string; readonly storage?: TestStorage | undefined },
): Promise<Started> {
  const dir = again?.root ?? (await makeProject(files));
  if (again !== undefined) {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), text);
    }
  }
  const project = await loadProject(dir);
  const storage = again?.storage ?? (await testStorage(database, project.databaseFile));
  const store = await storage.open();
  stores.push(store);
  const metrics = metricsFor(project);
  const engine = new Engine({
    project,
    store,
    logger: captureLogger().logger,
    env: { PATHWAYS_HTTP_TOKEN: TOKEN },
    metrics,
    ...(connectors === undefined ? {} : { connectors }),
  });
  engines.push(engine);
  await engine.start();
  return { root: dir, project, engine, store, storage, metrics };
}

/** The text a scrape serves now. */
async function scrape(started: Started): Promise<string> {
  return started.metrics.render(await started.engine.metricsSnapshot());
}

/** One sample's value, by its name and some of its labels; undefined when there is none. */
function value(text: string, name: string, labels: Record<string, string>): number | undefined {
  return parseOpenMetrics(text)
    .flatMap((family) => family.samples)
    .find(
      (sample) =>
        sample.name === name &&
        Object.entries(labels).every(([key, text]) => sample.labels[key] === text),
    )?.value;
}

/**
 * Scans every series in `text`: each label is one a family declares (or a histogram's `le`), each
 * channel a configured channel's name, each destination a label its configured names give, each
 * outcome one of the fixed outcomes, each `le` a bucket bound; and no message value appears
 * anywhere in the text.
 */
function scan(text: string, project: ProjectConfig): void {
  const channels = new Set(project.channels.map((channel) => channel.name));
  const destinations = new Map(
    project.channels.map((channel) => [
      channel.name,
      new Set(destinationLabels(channel.destinations.map((destination) => destination.name))),
    ]),
  );
  const bounds = new Set([...DELIVERY_DURATION_BUCKETS.map((b) => b.toFixed(1)), "+Inf"]);
  for (const bound of DELIVERY_DURATION_BUCKETS) {
    bounds.add(Number.isInteger(bound) ? `${String(bound)}.0` : String(bound));
  }
  for (const family of parseOpenMetrics(text)) {
    const declared = METRIC_FAMILIES.find((f) => f.name === family.name);
    expect(declared, family.name).toBeDefined();
    for (const sample of family.samples) {
      for (const [label, text] of Object.entries(sample.labels)) {
        if (label === "le") {
          expect(family.type).toBe("histogram");
          expect(bounds.has(text), `le=${text}`).toBe(true);
          continue;
        }
        expect(declared?.labels as readonly string[]).toContain(label);
        if (label === "channel") expect(channels.has(text), `channel=${text}`).toBe(true);
        if (label === "outcome") expect(METRIC_OUTCOMES).toContain(text);
        if (label === "destination") {
          const channel = sample.labels["channel"] ?? "";
          expect(destinations.get(channel)?.has(text), `destination=${text}`).toBe(true);
        }
      }
    }
  }
  for (const leak of MESSAGE_VALUES) expect(text).not.toContain(leak);
}

describe("destinationLabels", () => {
  it("names a destination by its name, else its place, and never gives two the same label", () => {
    expect(destinationLabels(["billing", undefined, undefined])).toEqual(["billing", "1", "2"]);
    expect(destinationLabels([undefined, "0"])).toEqual(["#0", "0"]);
    expect(destinationLabels([undefined, undefined, "1"])).toEqual(["0", "#1", "1"]);
    const labels = destinationLabels([undefined, "2", "1", undefined, "0", undefined]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("labels a counter series of an unknown channel by its place", () => {
    const metrics = new EngineMetrics([{ name: "adt", destinations: ["billing"] }]);
    metrics.deliveryAttempt("adt", 0, "delivered", 0.01);
    metrics.deliveryAttempt("other", 1, "retry");
    const text = metrics.render({ channels: [] });
    expect(
      value(text, "pathways_deliveries_total", {
        channel: "adt",
        destination: "billing",
        outcome: "delivered",
      }),
    ).toBe(1);
    expect(
      value(text, "pathways_deliveries_total", {
        channel: "other",
        destination: "1",
        outcome: "retry",
      }),
    ).toBe(1);
    expect(text).not.toContain('channel="adt",destination="0"');
  });

  it("counts a rejected body by its status only for 400, 413, 415 and 422", () => {
    const metrics = new EngineMetrics([{ name: "adt", destinations: 1 }]);
    for (const status of [400, 401, 404, 405, 413, 415, 422]) metrics.sourceRefused("adt", status);
    const text = metrics.render({ channels: [] });
    expect(value(text, "pathways_messages_refused_total", { outcome: "rejected" })).toBe(4);
  });
});

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`the engine's metrics, on ${database.label}`, () => {
    it("label each destination by its name, so two of one kind keep their own series", async () => {
      const started = await start(
        database,
        {
          "channels/adt/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
destinations:
  - name: billing
    file: { dir: ../../data/billing }
  - file: { dir: ../../data/out-a }
  - file: { dir: ../../data/out-b }
`,
        },
        async (channel) => {
          const built = await connectorsFor(channel, {
            now: Date.now,
            logger: captureLogger().logger,
            env: {},
          });
          return {
            source: built.source,
            destinations: [
              built.destinations[0] ?? failing,
              failing,
              built.destinations[2] ?? failing,
            ],
          };
        },
      );
      await dropFile(join(started.root, "data/inbox/TESTPATIENT-a.txt"), ADT_A01);
      await started.engine.tick();
      const text = await scrape(started);
      scan(text, started.project);
      const deliveries = (destination: string, outcome: string): number | undefined =>
        value(text, "pathways_deliveries_total", { channel: "adt", destination, outcome });
      expect(deliveries("billing", "delivered")).toBe(1);
      expect(deliveries("1", "retry")).toBe(1);
      expect(deliveries("1", "delivered")).toBe(0);
      expect(deliveries("2", "delivered")).toBe(1);
      expect(deliveries("2", "retry")).toBe(0);
      expect(value(text, "pathways_queue_depth", { destination: "1" })).toBe(1);
      expect(value(text, "pathways_queue_depth", { destination: "2" })).toBe(0);
      expect(text).not.toContain('destination="0"');
    });

    it("read a destination's queue by its key, after the list was reordered", async () => {
      const yaml = (first: string, second: string): Record<string, string> => ({
        "channels/adt/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
destinations:
  - ${first}
  - ${second}
`,
      });
      const slow = "name: slow\n    file: { dir: ../../data/slow }";
      const quick = "name: quick\n    file: { dir: ../../data/quick }";
      const before = await start(database, yaml(slow, quick), async (channel) => {
        const built = await connectorsFor(channel, {
          now: Date.now,
          logger: captureLogger().logger,
          env: {},
        });
        return {
          source: built.source,
          destinations: built.destinations.map((d, index) =>
            channel.destinations[index]?.name === "slow" ? failing : d,
          ),
        };
      });
      await dropFile(join(before.root, "data/inbox/TESTPATIENT-a.txt"), ADT_A01);
      await before.engine.tick();
      expect(value(await scrape(before), "pathways_queue_depth", { destination: "slow" })).toBe(1);
      await before.engine.stop();
      await before.store.close();
      engines.splice(0);
      stores.splice(0);

      // The same database, with the slow destination moved to the end of the list.
      const after = await start(
        database,
        yaml(quick, slow),
        () =>
          Promise.resolve({
            source: { start: () => Promise.resolve() },
            destinations: [failing, failing],
          }),
        { root: before.root, storage: before.storage },
      );
      const text = await scrape(after);
      scan(text, after.project);
      expect(value(text, "pathways_queue_depth", { destination: "slow" })).toBe(1);
      expect(value(text, "pathways_deliveries_retrying", { destination: "slow" })).toBe(1);
      expect(value(text, "pathways_queue_depth", { destination: "quick" })).toBe(0);
      expect(
        value(text, "pathways_oldest_pending_age_seconds", { destination: "slow" }),
      ).toBeGreaterThanOrEqual(0);
    });

    it("read deliveries made before destinations had keys by their place", async () => {
      const root = await makeProject({
        "channels/adt/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
destinations:
  - name: first
    file: { dir: ../../data/first }
  - file: { dir: ../../data/second }
`,
      });
      const storage = await testStorage(database, (await loadProject(root)).databaseFile);
      const early = await storage.open();
      const { id } = await early.receive("adt", new TextEncoder().encode("synthetic body"));
      // No keys: the deliveries are recorded as a release before keys recorded them.
      await early.completeTransform(id, [new TextEncoder().encode("synthetic output")], 2);
      expect((await early.destinationQueues("adt")).map((q) => q.destinationKey)).toEqual([
        undefined,
        undefined,
      ]);
      await early.close();
      const started = await start(
        database,
        {},
        () =>
          Promise.resolve({
            source: { start: () => Promise.resolve() },
            destinations: [failing, failing],
          }),
        { root, storage },
      );
      const text = await scrape(started);
      scan(text, started.project);
      expect(value(text, "pathways_queue_depth", { destination: "first" })).toBe(1);
      expect(value(text, "pathways_queue_depth", { destination: "1" })).toBe(1);
    });

    it("count a message handed between channels once on each channel, and the hand-off as a delivery", async () => {
      const started = await start(database, {
        "channels/a/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - name: out
    file: { dir: ../../data/a-out }
  - name: to-c
    channel: { name: c }
`,
        "channels/a/transform.ts": `
export default (msg: string, ctx: { route(name: string, message: string): void }) => {
  ctx.route("b", msg + "-routed");
  return msg;
};
`,
        "channels/b/channel.yaml": `
format: text
source:
  channel: { routed: true }
destinations:
  - file: { dir: ../../data/b-out }
`,
        "channels/c/channel.yaml": `
format: text
source:
  channel: {}
destinations:
  - file: { dir: ../../data/c-out }
`,
      });
      await dropFile(join(started.root, "data/inbox/TESTPATIENT-a.txt"), ADT_A01);
      for (let pass = 0; pass < 3; pass += 1) await started.engine.tick();
      const text = await scrape(started);
      scan(text, started.project);
      const received = (channel: string): number | undefined =>
        value(text, "pathways_messages_received_total", { channel, outcome: "stored" });
      expect([received("a"), received("b"), received("c")]).toEqual([1, 1, 1]);
      expect(
        value(text, "pathways_deliveries_total", {
          channel: "a",
          destination: "to-c",
          outcome: "delivered",
        }),
      ).toBe(1);
      expect(
        value(text, "pathways_deliveries_total", {
          channel: "a",
          destination: "out",
          outcome: "delivered",
        }),
      ).toBe(1);
      for (const channel of ["a", "b", "c"]) {
        expect(value(text, "pathways_messages_settled_total", { channel }), channel).toBe(1);
      }
    });

    it("count a batch's pieces, and a piece that cannot be read as refused, never as received", async () => {
      const started = await start(database, {
        "channels/adt/channel.yaml": `
format: hl7v2
source:
  file:
    dir: ../../data/inbox
    minAge: 0
    batch: { split: hl7 }
destinations:
  - file: { dir: ../../data/out }
`,
      });
      await dropFile(
        join(started.root, "data/inbox/a.hl7"),
        `PID|1||TEST000009\r${ADT_A01}${ADT_A08}`,
      );
      await started.engine.tick();
      const text = await scrape(started);
      scan(text, started.project);
      expect(value(text, "pathways_messages_received_total", { outcome: "stored" })).toBe(2);
      expect(value(text, "pathways_messages_refused_total", { outcome: "unreadable" })).toBe(1);
      expect(text).not.toMatch(/pathways_messages_received_total\{[^}]*outcome="failed"/);
    });

    it("count a body with a second message header as refused, never as received", async () => {
      const started = await start(database, {
        "channels/adt/channel.yaml": `
format: hl7v2
source:
  file: { dir: ../../data/inbox, minAge: 0 }
destinations:
  - file: { dir: ../../data/out }
`,
      });
      await dropFile(
        join(started.root, "data/inbox/TESTPATIENT-two.hl7"),
        ADT_A01 + ADT_A08.toLowerCase(),
      );
      await dropFile(join(started.root, "data/inbox/TESTPATIENT-one.hl7"), ADT_A01);
      await started.engine.tick();
      const text = await scrape(started);
      scan(text, started.project);
      expect(value(text, "pathways_messages_received_total", { outcome: "stored" })).toBe(1);
      expect(value(text, "pathways_messages_refused_total", { outcome: "unreadable" })).toBe(1);
      expect(value(text, "pathways_messages_failed", { channel: "adt" })).toBe(1);
    });

    it("count the settled events, each destination's state as the event gives it", async () => {
      const started = await start(
        database,
        {
          "channels/adt/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - name: lab
    file: { dir: ../../data/lab }
  - file: { dir: ../../data/out }
`,
          "channels/adt/transform.ts": `
export default (msg: string) => (msg.includes("A08") ? null : msg);
`,
        },
        async (channel) => {
          const built = await connectorsFor(channel, {
            now: Date.now,
            logger: captureLogger().logger,
            env: {},
          });
          const exhausted: DestinationConnector = {
            deliver: () => Promise.reject(new DeliveryRejected("AR")),
          };
          return {
            source: built.source,
            destinations: [built.destinations[0] ?? failing, exhausted],
          };
        },
      );
      await dropFile(join(started.root, "data/inbox/TESTPATIENT-a.txt"), ADT_A01);
      await dropFile(join(started.root, "data/inbox/TESTPATIENT-b.txt"), ADT_A08);
      for (let pass = 0; pass < 3; pass += 1) await started.engine.tick();
      const text = await scrape(started);
      scan(text, started.project);
      const settled = started.metrics.events.filter((event) => event.type === "settled");
      expect(value(text, "pathways_messages_settled_total", { channel: "adt" })).toBe(
        settled.length,
      );
      for (const [index, label] of [
        [0, "lab"],
        [1, "1"],
      ] as const) {
        for (const state of ["delivered", "failed", "filtered", "cleared", "dry-run"] as const) {
          const expected = settled.filter((event) =>
            event.destinations.some((d) => d.index === index && d.state === state),
          ).length;
          expect(
            value(text, "pathways_settled_destinations_total", {
              channel: "adt",
              destination: label,
              outcome: state === "dry-run" ? "dry_run" : state,
            }),
            `${label} ${state}`,
          ).toBe(expected);
        }
      }
      expect(settled.length).toBeGreaterThan(0);
    });
  });
}

describe("the engine's metrics on an HTTP source", () => {
  it("count a compressed or empty body the source refused as rejected, never as received", async () => {
    const root = await makeProject({});
    const started = await onPickedPorts(1, async ([port = 0]) => {
      const setup = await start(
        TEST_DATABASES[0] as TestDatabase,
        {
          "channels/adt/channel.yaml": `
format: text
source:
  http: { port: ${String(port)}, path: /adt, plaintext: true }
destinations:
  - file: { dir: ../../data/out }
`,
        },
        undefined,
        { root },
      );
      await sourceListening(setup.engine, "adt");
      return { ...setup, port };
    });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const gzip = await send(started.port, {
      path: "/adt",
      headers: { ...auth, "Content-Encoding": "gzip" },
      body: ADT_A01,
    });
    expect(gzip.status).toBe(415);
    const empty = await send(started.port, { path: "/adt", headers: auth, body: "" });
    expect(empty.status).toBe(400);
    const missing = await send(started.port, { path: "/nowhere", headers: auth, body: ADT_A01 });
    expect(missing.status).toBe(404);
    const stored = await send(started.port, { path: "/adt", headers: auth, body: ADT_A01 });
    expect(stored.status).toBe(202);
    const text = await scrape(started);
    scan(text, started.project);
    expect(value(text, "pathways_messages_refused_total", { outcome: "rejected" })).toBe(2);
    expect(value(text, "pathways_messages_received_total", { outcome: "stored" })).toBe(1);
  });
});
