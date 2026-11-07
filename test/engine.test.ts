import { chmod, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ChannelConfig } from "../src/config/schema.js";
import { FileDestination, FileSource } from "../src/connectors/file.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
} from "../src/connectors/types.js";
import { TransformLoadError } from "../src/engine/channel-worker.js";
import {
  Engine,
  connectorsFor,
  CONTENT_TYPES,
  EXTENSIONS,
  retryDelay,
  storedFailure,
  type ChannelConnectors,
} from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  dropFile,
  FHIR_PATIENT,
  LAB_TRANSFORM,
  makeProject,
  X12_270,
  type LogEvent,
} from "./helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out-a }
  - file: { dir: ../../data/out-b }
`;

interface Setup {
  readonly root: string;
  readonly engine: Engine;
  readonly store: Store;
  readonly events: LogEvent[];
  readonly lines: string[];
  readonly clock: { now: number };
}

async function setUp(
  transform = LAB_TRANSFORM,
  connectors?: (channel: ChannelConfig) => ChannelConnectors,
): Promise<Setup> {
  const root = await makeProject({
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": transform,
  });
  const project = await loadProject(root);
  const clock = { now: Date.now() };
  const store = await Store.open(project.databaseFile);
  stores.push(store);
  const { logger, events, lines } = captureLogger();
  const engine = new Engine({
    project,
    store,
    logger,
    now: () => clock.now,
    ...(connectors ? { connectors } : {}),
  });
  engines.push(engine);
  await engine.start();
  return { root, engine, store, events, lines, clock };
}

const data = (root: string, ...parts: string[]): string => join(root, "data", ...parts);

describe("Engine", () => {
  it("takes files in, transforms them, and delivers each output to every destination", async () => {
    const { root, engine, store, lines } = await setUp();
    await dropFile(data(root, "inbox", "TESTPATIENT-a01.hl7"), ADT_A01);
    await dropFile(data(root, "inbox", "TESTPATIENT-a08.hl7"), ADT_A08);
    await engine.tick();

    expect((await readdir(data(root, "inbox"))).sort()).toEqual(["processed"]);
    expect((await readdir(data(root, "inbox", "processed"))).sort()).toEqual([
      "1-TESTPATIENT-a01.hl7",
      "2-TESTPATIENT-a08.hl7",
    ]);
    for (const out of ["out-a", "out-b"]) {
      expect(await readdir(data(root, out))).toEqual(["1-1.hl7"]);
      const written = await readFile(data(root, out, "1-1.hl7"), "utf8");
      expect(written).toBe(ADT_A01.replace("|LAB|", "|LAB2|"));
    }
    expect(await store.messageCounts("adt")).toEqual({
      received: 0,
      transformed: 1,
      filtered: 1,
      failed: 0,
      cleared: 0,
    });
    expect(await store.deliveryCounts("adt")).toEqual({
      pending: 0,
      delivered: 2,
      failed: 0,
      cleared: 0,
    });

    // Logs carry ids and counts, never content or file names.
    const log = lines.join("");
    expect(log).not.toContain("TESTPATIENT");
    expect(log).not.toContain("MSH");
  });

  it("fails a message whose transform throws, and moves on to the next", async () => {
    const { root, engine, store, events } = await setUp(
      "export default (m: { is(t: string): boolean }) => { if (m.is('ADT^A08')) throw new TypeError('synthetic'); return m; };\n",
    );
    await dropFile(data(root, "inbox", "1.hl7"), ADT_A08);
    await dropFile(data(root, "inbox", "2.hl7"), ADT_A01);
    await engine.tick();
    expect(await store.messageCounts("adt")).toEqual({
      received: 0,
      transformed: 1,
      filtered: 0,
      failed: 1,
      cleared: 0,
    });
    const failed = events.find((e) => e.event === "transform-failed");
    expect(failed).toMatchObject({
      kind: "transform",
      name: "TypeError",
      where: expect.stringMatching(/^transform\.ts:1:\d+$/) as unknown,
    });
    expect(failed).not.toHaveProperty("detail");
  });

  it("retries a destination that fails, holding its later messages, while the other destination carries on", async () => {
    const { root, engine, store, events, clock } = await setUp();
    await dropFile(data(root, "out-a"), "a file where a folder should be");
    await dropFile(data(root, "inbox", "1.hl7"), ADT_A01);
    await dropFile(data(root, "inbox", "2.hl7"), ADT_A01.replace("MSG00001", "MSG00003"));
    await engine.tick();

    expect(await readdir(data(root, "out-b"))).toEqual(["1-1.hl7", "2-1.hl7"]);
    expect(await store.deliveryCounts("adt")).toEqual({
      pending: 2,
      delivered: 2,
      failed: 0,
      cleared: 0,
    });
    expect(events.filter((e) => e.event === "delivery-retry")).toEqual([
      expect.objectContaining({ destination: 0, attempt: 1, retryInMs: 1_000 }),
    ]);

    // Not yet due: nothing is tried.
    await engine.tick();
    expect(events.filter((e) => e.event === "delivery-retry")).toHaveLength(1);

    // Due, still failing: the wait doubles.
    clock.now += 1_000;
    await engine.tick();
    expect(events.filter((e) => e.event === "delivery-retry").at(-1)).toMatchObject({
      attempt: 2,
      retryInMs: 2_000,
    });

    // Fixed: both arrive, in order.
    await rm(data(root, "out-a"));
    clock.now += 2_000;
    await engine.tick();
    expect(await readdir(data(root, "out-a"))).toEqual(["1-1.hl7", "2-1.hl7"]);
    expect(await store.deliveryCounts("adt")).toEqual({
      pending: 0,
      delivered: 4,
      failed: 0,
      cleared: 0,
    });
    const delivered = events
      .filter((e) => e.event === "delivered" && e.destination === 0)
      .map((e) => e.delivery);
    expect(delivered).toEqual([1, 3]);
  });

  it("marks a rejected delivery failed and moves on to the next", async () => {
    const rejecting: DestinationConnector = {
      deliver: (message) =>
        message.messageId === 1 ? Promise.reject(new DeliveryRejected("AE")) : Promise.resolve(),
    };
    const { root, engine, store, events } = await setUp(LAB_TRANSFORM, (channel) => ({
      source: new FileSource({ dir: join(channel.dir, "../../data/inbox"), minAgeMs: 0 }),
      destinations: [
        rejecting,
        new FileDestination({ dir: join(channel.dir, "../../data/out-b"), extension: "hl7" }),
      ],
    }));
    await dropFile(data(root, "inbox", "1.hl7"), ADT_A01);
    await dropFile(data(root, "inbox", "2.hl7"), ADT_A01);
    await engine.tick();
    expect(await store.deliveryCounts("adt")).toEqual({
      pending: 0,
      delivered: 3,
      failed: 1,
      cleared: 0,
    });
    expect(events.find((e) => e.event === "delivery-rejected")).toMatchObject({
      reason: "AE",
      destination: 0,
    });
  });

  it("runs a source that listens, started and stopped with the engine", async () => {
    let sink: MessageSink | undefined;
    let stopped = false;
    const { engine, store } = await setUp(LAB_TRANSFORM, () => ({
      source: {
        start: (given) => {
          sink = given;
          return Promise.resolve();
        },
        stop: () => {
          stopped = true;
          return Promise.resolve();
        },
      },
      destinations: [{ deliver: () => Promise.resolve() }, { deliver: () => Promise.resolve() }],
    }));
    expect(await sink?.receive(new TextEncoder().encode(ADT_A01))).toBe(1);
    await engine.tick();
    expect(await store.deliveryCounts("adt")).toEqual({
      pending: 0,
      delivered: 2,
      failed: 0,
      cleared: 0,
    });
    await engine.stop();
    expect(stopped).toBe(true);
  });

  it("leaves a file it cannot read where it is, and says so without naming it", async () => {
    const { root, engine, events } = await setUp();
    const file = data(root, "inbox", "TESTPATIENT.hl7");
    await dropFile(file, ADT_A01);
    await chmod(file, 0o000);
    await engine.tick();
    await chmod(file, 0o644);
    expect(await readdir(data(root, "inbox"))).toContain("TESTPATIENT.hl7");
    const warning = events.find((e) => e.event === "source-read-failed");
    expect(warning).toMatchObject({ channel: "adt", code: "EACCES" });
    expect(JSON.stringify(warning)).not.toContain("TESTPATIENT");
  });

  it("refuses to start a channel whose transform will not load, and stops the rest", async () => {
    await expect(setUp("export const nothing = 1;\n")).rejects.toBeInstanceOf(TransformLoadError);
  });

  it("runs passes until told to stop", async () => {
    const { root, engine } = await setUp();
    await dropFile(data(root, "inbox", "1.hl7"), ADT_A01);
    const stop = new AbortController();
    const running = engine.run(stop.signal);
    for (let i = 0; i < 50 && !(await exists(data(root, "out-a", "1-1.hl7"))); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stop.abort();
    await running;
    expect(await exists(data(root, "out-a", "1-1.hl7"))).toBe(true);
  });

  it("passes every format through a channel with no transform, under its own extension", async () => {
    const formats = { hl7v2: ADT_A01, fhir: FHIR_PATIENT, x12: X12_270, json: '{"a": [1]}' };
    const files: Record<string, string> = {};
    for (const format of Object.keys(formats)) {
      files[`channels/${format}/channel.yaml`] =
        `format: ${format}\nsource:\n  file: { dir: ../../data/${format}-in, minAge: 0 }\n` +
        `destinations:\n  - file: { dir: ../../data/${format}-out }\n`;
    }
    const root = await makeProject(files);
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    engines.push(engine);
    await engine.start();
    for (const [format, body] of Object.entries(formats)) {
      await dropFile(data(root, `${format}-in`, "message"), body);
    }
    await engine.tick();

    const written = async (format: string): Promise<[string, string]> => {
      const [name = ""] = await readdir(data(root, `${format}-out`));
      return [
        name.slice(name.indexOf(".")),
        await readFile(data(root, `${format}-out`, name), "utf8"),
      ];
    };
    expect(await written("hl7v2")).toEqual([".hl7", ADT_A01]);
    expect(await written("fhir")).toEqual([".json", FHIR_PATIENT]);
    expect(await written("x12")).toEqual([".x12", X12_270]);
    expect(await written("json")).toEqual([".json", '{"a":[1]}']);
    expect(EXTENSIONS).toEqual({
      hl7v2: "hl7",
      fhir: "json",
      x12: "x12",
      ccda: "xml",
      json: "json",
      text: "txt",
    });
    expect(CONTENT_TYPES).toEqual({
      hl7v2: "application/hl7-v2",
      fhir: "application/fhir+json",
      x12: "application/edi-x12",
      ccda: "application/xml",
      json: "application/json",
      text: "text/plain",
    });
  });

  it("builds file connectors from a channel's configuration", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const [channel] = (await loadProject(root)).channels;
    const { logger } = captureLogger();
    const built = await connectorsFor(channel as ChannelConfig, { now: Date.now, logger, env: {} });
    expect(built.source).toBeInstanceOf(FileSource);
    expect(built.destinations).toHaveLength(2);
  });
});

describe("retryDelay and storedFailure", () => {
  it("doubles from one second up to five minutes", () => {
    expect([0, 1, 2, 3, 4, 9, 10, 50].map(retryDelay)).toEqual([
      1_000, 1_000, 2_000, 4_000, 8_000, 256_000, 300_000, 300_000,
    ]);
  });

  it("keeps stage, name, code and location ahead of the error's own text", () => {
    expect(
      storedFailure({ kind: "parse", name: "Hl7ParseError", code: "NO_MSH_SEGMENT", detail: "x" }),
    ).toBe("parse: Hl7ParseError NO_MSH_SEGMENT: x");
    expect(
      storedFailure({
        kind: "transform",
        name: "TypeError",
        where: "transform.ts:2:9",
        detail: "y",
      }),
    ).toBe("transform: TypeError at transform.ts:2:9: y");
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
