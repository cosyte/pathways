import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { HookConfig } from "../src/config/schema.js";
import { Engine } from "../src/engine/engine.js";
import type { LifecycleEvent } from "../src/extensions/events.js";
import { HookSet, MAX_QUEUED_EVENTS } from "../src/extensions/hooks.js";
import { ExtensionLoadError } from "../src/extensions/load.js";
import { Store, type MessageStore } from "../src/storage/store.js";
import {
  eventually,
  freshBench,
  LIST_DESTINATION,
  LISTEN_SOURCE,
  POLL_SOURCE,
  RECORD_HOOK,
} from "./extension-helpers.js";
import { captureLogger, cleanUp, makeProject, type LogEvent } from "./helpers.js";
import { receiver, status, type Receiver } from "./net-helpers.js";

const engines: Engine[] = [];
const stores: MessageStore[] = [];
const sets: HookSet[] = [];
const receivers: Receiver[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(sets.splice(0).map((set) => set.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(receivers.splice(0).map((r) => r.close()));
  await cleanUp();
});

interface Running {
  readonly engine: Engine;
  readonly store: MessageStore;
  readonly events: LogEvent[];
  readonly lines: string[];
  readonly clock: { now: number };
}

const AT = Date.UTC(2026, 10, 7, 12, 0, 0);

async function startEngine(
  files: Record<string, string>,
  wrap?: (store: Store) => MessageStore,
): Promise<Running> {
  const root = await makeProject({ "hooks/record.ts": RECORD_HOOK, ...files });
  const project = await loadProject(root);
  const store = await Store.open(":memory:");
  stores.push(store);
  const { logger, events, lines } = captureLogger();
  const clock = { now: AT };
  const engine = new Engine({
    project,
    store: wrap?.(store) ?? store,
    logger,
    env: {},
    now: () => clock.now,
  });
  engines.push(engine);
  await engine.start();
  return { engine, store, events, lines, clock };
}

/** A text channel from the polling source to the scripted destination, with `extra` lines. */
const textChannel = (extra = ""): string => `
format: text
source:
  module: ./source.ts
  options: { key: in }
transform: ./transform.ts
destinations:
  - module: ./destination.ts
    options: { key: out }
${extra}`;

/** Fails a message that says so, filters one that says so, and passes the rest on. */
const SORTING_TRANSFORM = `
export default (text: string): string | null => {
  if (text.includes("fail")) throw new TypeError("synthetic transform failure");
  if (text.includes("drop")) return null;
  return text;
};
`;

const channelFiles = (extra = ""): Record<string, string> => ({
  "channels/text/channel.yaml": textChannel(extra),
  "channels/text/source.ts": POLL_SOURCE,
  "channels/text/destination.ts": LIST_DESTINATION,
  "channels/text/transform.ts": SORTING_TRANSFORM,
});

describe("lifecycle hooks in the engine", () => {
  it("tell each hook of every message, transform and delivery event, with ids and codes only", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic keep", "synthetic drop", "synthetic fail", "synthetic reject"];
    bench.script["out"] = ["retry", "ok", "reject"];
    const { engine, clock, lines } = await startEngine({
      "pathways.yaml": "hooks:\n  - module: ./hooks/record.ts\n    options: { key: all }\n",
      ...channelFiles(
        "hooks:\n  - module: ../../hooks/record.ts\n    options: { key: delivered }\n    events: [delivered]\n",
      ),
    });
    await engine.tick();
    clock.now += 1_000;
    await engine.tick();
    await engine.stop();

    const at = new Date(AT).toISOString();
    const later = new Date(AT + 1_000).toISOString();
    const base = { channel: "text" };
    const delivery = { ...base, messageId: 1, destination: 0, deliveryId: 1 };
    const settledAs = (state: string): unknown => [{ index: 0, name: "module", state }];
    expect(bench.events["all"]).toEqual([
      ...[14, 14, 14, 16].map((bytes, index) => ({
        type: "received",
        at,
        ...base,
        messageId: index + 1,
        bytes,
        failed: false,
        duplicateOf: undefined,
      })),
      { type: "transformed", at, ...base, messageId: 1, outputs: 1 },
      { type: "filtered", at, ...base, messageId: 2 },
      { type: "settled", at, ...base, messageId: 2, destinations: settledAs("filtered") },
      {
        type: "transform-failed",
        at,
        ...base,
        messageId: 3,
        kind: "transform",
        name: "TypeError",
        code: undefined,
        where: expect.stringMatching(/^transform\.ts:3:\d+$/) as unknown,
      },
      { type: "settled", at, ...base, messageId: 3, destinations: settledAs("failed") },
      { type: "transformed", at, ...base, messageId: 4, outputs: 1 },
      {
        type: "delivery-retry",
        at,
        ...delivery,
        attempt: 1,
        retryInMs: 1_000,
        retryAt: later,
        name: "Error",
        code: "ECONNRESET",
      },
      { type: "delivered", at: later, ...delivery, attempt: 2 },
      {
        type: "delivery-rejected",
        at: later,
        ...base,
        messageId: 4,
        destination: 0,
        deliveryId: 2,
        attempt: 1,
        reason: "NOPE",
      },
      // Each message settles once its last delivery ends: after the pass that ended it.
      { type: "settled", at: later, ...base, messageId: 1, destinations: settledAs("delivered") },
      { type: "settled", at: later, ...base, messageId: 4, destinations: settledAs("failed") },
    ]);
    // The channel's own hook asked for deliveries only.
    expect(bench.events["delivered"]).toEqual([
      { type: "delivered", at: later, ...delivery, attempt: 2 },
    ]);
    // Each hook was built once, with its scope, and stopped once.
    expect(bench.notes["hook"]).toEqual([
      { key: "all", channel: undefined, dir: expect.any(String) as unknown },
      {
        key: "delivered",
        channel: "text",
        // The channel's folder, with the system's own separator.
        dir: expect.stringMatching(/channels[\\/]text$/) as unknown,
      },
    ]);
    expect(bench.notes["all:stop"]).toEqual([true]);
    expect(bench.notes["all:signal"]?.every((seen) => seen === true)).toBe(true);
    // Events reach hooks frozen, and never hold content.
    expect(bench.events["all"]?.every((event) => Object.isFrozen(event))).toBe(true);
    expect(JSON.stringify(bench.events["all"])).not.toContain("synthetic");
    expect(lines.join("")).not.toContain("synthetic");
  });

  it("tell hooks a source went down and came back, and a message storage refused", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic refused"];
    bench.script["in"] = ["fail"];
    const failing = (store: Store): MessageStore =>
      Object.assign(Object.create(store) as MessageStore, {
        receive: () =>
          Promise.reject(Object.assign(new Error("synthetic"), { code: "SQLITE_FULL" })),
      });
    const { engine, clock } = await startEngine(
      {
        "pathways.yaml": "hooks: [{ module: ./hooks/record.ts, options: { key: all } }]\n",
        "channels/text/channel.yaml": `format: text\nsource:\n  module: ./source.ts\n  options: { key: in }\ndestinations:\n  - file: { dir: ./out }\n`,
        "channels/text/source.ts": LISTEN_SOURCE,
      },
      failing,
    );
    clock.now += 1_000;
    await engine.tick();
    await engine.stop();
    expect(bench.events["all"]).toEqual([
      {
        type: "source-down",
        at: new Date(AT).toISOString(),
        channel: "text",
        attempt: 1,
        retryInMs: 1_000,
        retryAt: new Date(AT + 1_000).toISOString(),
        name: "Error",
        code: "EADDRINUSE",
      },
      {
        type: "receive-failed",
        at: new Date(AT + 1_000).toISOString(),
        channel: "text",
        name: "Error",
        code: "SQLITE_FULL",
      },
      { type: "source-up", at: new Date(AT + 1_000).toISOString(), channel: "text" },
    ]);
    expect(bench.notes["listen"]).toEqual(["started", "receive-refused", "stopped"]);
  });

  it("deliver every message when a hook throws, rejects or hangs, and log each failure", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one", "synthetic two"];
    const started = Date.now();
    const { engine, store, events } = await startEngine({
      "pathways.yaml": [
        "hooks:",
        "  - { module: ./hooks/record.ts, options: { key: sync, fail: sync } }",
        "  - { module: ./hooks/record.ts, options: { key: async, fail: async }, events: [delivered] }",
        "  - { module: ./hooks/record.ts, options: { key: hang, hang: true }, events: [delivered], timeout: 30ms }",
        "  - { module: ./hooks/record.ts, options: { key: fine } }",
        "  - { module: ./hooks/record.ts, options: { key: string, fail: string }, events: [received] }",
        "",
      ].join("\n"),
      ...channelFiles(),
    });
    await engine.tick();
    // Every delivery was done while the hanging hook still had both its calls ahead of it.
    expect(bench.outbox["out"]).toEqual(["synthetic one", "synthetic two"]);
    expect(await store.deliveryCounts("text")).toEqual({
      pending: 0,
      delivered: 2,
      failed: 0,
      cleared: 0,
    });
    expect(events.filter((e) => e.event === "hook-timeout")).toEqual([]);
    await eventually(() => events.filter((e) => e.event === "hook-timeout").length === 2);
    await engine.stop();
    expect(Date.now() - started).toBeLessThan(2_000);

    // Each message's received, transformed, delivered and settled.
    expect(bench.events["fine"]).toHaveLength(8);
    const failed = events.filter((e) => e.event === "hook-failed");
    expect(failed).toContainEqual(
      expect.objectContaining({
        hook: "pathways.yaml: hooks.0",
        on: "received",
        channel: "text",
        name: "TypeError",
      }),
    );
    expect(failed).toContainEqual(
      expect.objectContaining({ hook: "pathways.yaml: hooks.1", on: "delivered", code: "EHOOK" }),
    );
    expect(failed.filter((e) => e["hook"] === "pathways.yaml: hooks.0")).toHaveLength(8);
    expect(failed).toContainEqual(
      expect.objectContaining({ hook: "pathways.yaml: hooks.4", on: "received", name: "string" }),
    );
    expect(events.filter((e) => e.event === "hook-timeout")).toEqual([
      expect.objectContaining({ hook: "pathways.yaml: hooks.2", on: "delivered", timeoutMs: 30 }),
      expect.objectContaining({ hook: "pathways.yaml: hooks.2", on: "delivered", timeoutMs: 30 }),
    ]);
    // A failure is described by name and code: its text never reaches the log.
    expect(JSON.stringify(events)).not.toContain("synthetic hook failure");
  });

  it("refuses to start on a bad hook module, by file and key", async () => {
    const root = await makeProject({
      "hooks/record.ts": RECORD_HOOK,
      "hooks/bad.ts": "export default () => ({ handle: () => undefined });\n",
      "pathways.yaml": "hooks: [{ module: ./hooks/record.ts, options: { key: first } }]\n",
      ...channelFiles("hooks: [../../hooks/bad.ts]\n"),
    });
    freshBench();
    const project = await loadProject(root);
    const store = await Store.open(":memory:");
    stores.push(store);
    const engine = new Engine({ project, store, logger: captureLogger().logger, env: {} });
    const error = (await engine.start().catch((e: unknown) => e)) as ExtensionLoadError;
    expect(error).toBeInstanceOf(ExtensionLoadError);
    expect(error.message).toBe(
      "channels/text/channel.yaml: hooks.0: the factory did not return a lifecycle hook: onEvent must be a method",
    );
  });
});

describe("HookSet", () => {
  /** A module hook's configuration, the module at `module`. */
  const hookConfig = (
    options: Record<string, unknown>,
    module = "",
    timeoutMs = 1_000,
  ): HookConfig => ({ kind: "module", module, options, events: undefined, timeoutMs });

  /** Opens one recording hook per entry: its options, and its time limit. */
  async function open(
    entries: readonly (readonly [options: Record<string, unknown>, timeoutMs?: number])[],
  ): Promise<{ hooks: HookSet; events: LogEvent[] }> {
    const root = await makeProject({ "record.ts": RECORD_HOOK });
    const { logger, events } = captureLogger();
    const hooks = await HookSet.open(
      entries.map(([options, timeoutMs]) =>
        hookConfig(options, join(root, "record.ts"), timeoutMs),
      ),
      { file: "pathways.yaml", channel: undefined, dir: root, env: {}, logger },
    );
    sets.push(hooks);
    return { hooks, events };
  }

  const event = (messageId: number): LifecycleEvent => ({
    type: "filtered",
    at: new Date(AT).toISOString(),
    channel: "text",
    messageId,
  });

  it("drops what does not fit in a hook's queue, and says so", async () => {
    const bench = freshBench();
    const { hooks, events } = await open([[{ key: "slow", delayMs: 1 }]]);
    // The first event goes straight to the hook; the queue then holds the next MAX_QUEUED_EVENTS.
    for (let id = 0; id < MAX_QUEUED_EVENTS + 2; id += 1) hooks.emit(event(id));
    expect(events.filter((e) => e.event === "hook-dropped")).toEqual([
      expect.objectContaining({
        hook: "pathways.yaml: hooks.0",
        on: "filtered",
        queued: MAX_QUEUED_EVENTS,
      }),
    ]);
    await hooks.stop();
    expect(bench.events["slow"]?.length).toBeGreaterThan(0);
  });

  it("gives a hook its time limit to finish its queue on stop, then drops the rest and stops it", async () => {
    const bench = freshBench();
    const { hooks, events } = await open([[{ key: "slow", delayMs: 20, stopFails: true }, 50]]);
    for (let id = 1; id <= 10; id += 1) hooks.emit(event(id));
    await hooks.stop();
    const handled = bench.events["slow"]?.length ?? 0;
    expect(handled).toBeGreaterThan(0);
    expect(handled).toBeLessThan(10);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "hook-dropped", stopping: true, count: 10 - handled }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "hook-stop-failed", name: "RangeError" }),
    );
    // Once stopped, a hook takes nothing more.
    hooks.emit(event(11));
    expect(bench.events["slow"]).toHaveLength(handled);
  });

  it("stops the hooks it built when a later one cannot be built", async () => {
    const bench = freshBench();
    const root = await makeProject({ "record.ts": RECORD_HOOK, "bad.ts": "export default 1;\n" });
    const error: unknown = await HookSet.open(
      [hookConfig({ key: "first" }, join(root, "record.ts")), hookConfig({}, join(root, "bad.ts"))],
      {
        file: "pathways.yaml",
        channel: undefined,
        dir: root,
        env: {},
        logger: captureLogger().logger,
      },
    ).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      "pathways.yaml: hooks.1: the module's default export is a number, not a function; export default a hook factory",
    );
    expect(bench.notes["first:stop"]).toEqual([true]);
  });

  it("reads a webhook's headers from the environment when given no resolved secrets", async () => {
    const ops = await receiver(status(204));
    receivers.push(ops);
    const root = await makeProject({
      "pathways.yaml": [
        "encryption: none",
        "hooks:",
        "  - webhook:",
        `      url: "${ops.url}"`,
        "      plaintext: true",
        "      headers:",
        "        Authorization: { env: OPS_TOKEN }",
        "",
      ].join("\n"),
      "channels/text/channel.yaml": textChannel(),
      "channels/text/source.ts": POLL_SOURCE,
      "channels/text/destination.ts": LIST_DESTINATION,
      "channels/text/transform.ts": SORTING_TRANSFORM,
    });
    const project = await loadProject(root);
    const { logger } = captureLogger();
    const hooks = await HookSet.open(project.hooks, {
      file: "pathways.yaml",
      channel: undefined,
      dir: root,
      env: { OPS_TOKEN: "synthetic-ops-token-0002" },
      logger,
    });
    hooks.emit(event(1));
    await hooks.stop();
    expect(ops.received.map((request) => request.headers.authorization)).toEqual([
      "synthetic-ops-token-0002",
    ]);
  });

  it("does nothing with no hooks, and stops a hook that has no stop of its own", async () => {
    const { hooks } = await open([]);
    hooks.emit(event(1));
    await hooks.stop();

    const root = await makeProject({ "plain.ts": "export default () => ({ onEvent() {} });\n" });
    const { logger, events } = captureLogger();
    const plain = await HookSet.open([hookConfig({}, join(root, "plain.ts"))], {
      file: "pathways.yaml",
      channel: undefined,
      dir: root,
      env: {},
      logger,
    });
    plain.emit(event(1));
    await plain.stop();
    expect(events).toEqual([]);
  });
});
