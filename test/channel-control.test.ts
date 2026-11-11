import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "pino";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ChannelConfig, ProjectConfig } from "../src/config/schema.js";
import type {
  DestinationConnector,
  MessageSink,
  OutgoingMessage,
  SourceConnector,
} from "../src/connectors/types.js";
import { Engine } from "../src/engine/engine.js";
import type { ChannelRunState, Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
} from "./databases.js";
import { ADT_A01, captureLogger, cleanUp, LAB_TRANSFORM, makeProject } from "./helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
`;

/** A transform that marks each output with `tag` in MSH.5. */
const tagging = (tag: string): string => `
interface Msg { setField(path: string, value: string): void }
export default (msg: Msg): Msg => {
  msg.setField("MSH.5", "${tag}");
  return msg;
};
`;

/** A transform that writes its configuration's `facility` and `site` into MSH.5. */
const CONFIGURED = `
interface Msg { setField(path: string, value: string): void }
export default (msg: Msg, ctx: { config: Record<string, unknown> }): Msg => {
  msg.setField("MSH.5", String(ctx.config["facility"]) + "-" + String(ctx.config["site"]));
  return msg;
};
`;

/** A channel whose one destination takes its token from a secret reference. */
const WITH_SECRET = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - http:
      url: http://127.0.0.1:9/in
      plaintext: true
      headers: { Authorization: { secret: { provider: env, name: SYNTHETIC_CONTROL_TOKEN } } }
`;

/** A source that listens: the test hands messages in through the sink it was started with. */
class TestSource implements SourceConnector {
  sink: MessageSink | undefined;
  starts = 0;
  stops = 0;
  polls = 0;

  start(sink: MessageSink): Promise<void> {
    this.starts += 1;
    this.sink = sink;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stops += 1;
    this.sink = undefined;
    return Promise.resolve();
  }

  poll(): Promise<void> {
    this.polls += 1;
    return Promise.resolve();
  }
}

/**
 * A destination that answers each send as `next` says: `ok`, `fail` (a retryable error), or `hold`
 * (no answer until the send's signal aborts, as a destination that honours a halt does).
 */
class TestDestination implements DestinationConnector {
  readonly delivered: OutgoingMessage[] = [];
  readonly plan: ("ok" | "fail" | "hold" | "wait")[] = [];
  sends = 0;
  private onSend: (() => void) | undefined;
  /** Ends a `wait` send, delivered. */
  release: () => void = () => undefined;

  deliver(message: OutgoingMessage): Promise<void> {
    this.sends += 1;
    const step = this.plan.shift() ?? "ok";
    this.onSend?.();
    if (step === "fail") return Promise.reject(new Error("refused"));
    if (step === "wait") {
      return new Promise((resolve) => {
        this.release = () => {
          this.delivered.push(message);
          resolve();
        };
      });
    }
    if (step === "hold") {
      return new Promise((_resolve, reject) => {
        message.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }
    this.delivered.push(message);
    return Promise.resolve();
  }

  /** Resolves at the next send. */
  sent(): Promise<void> {
    return new Promise((resolve) => {
      this.onSend = () => {
        this.onSend = undefined;
        resolve();
      };
    });
  }
}

/**
 * Holds every channel state write on `store` until `open` is called, as a slow database server
 * would, then lets each through.
 */
function gatedStateWrites(store: Store): { open: () => void } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const write = store.setChannelState.bind(store);
  vi.spyOn(store, "setChannelState").mockImplementation(async (channel, state) => {
    await gate;
    await write(channel, state);
  });
  return { open: () => open() };
}

interface Setup {
  readonly root: string;
  readonly project: ProjectConfig;
  readonly store: Store;
  readonly destination: TestDestination;
  readonly clock: { now: number };
  readonly open: () => Promise<Store>;
  readonly engineOn: (
    store: Store,
    logger?: Logger,
    extra?: { readonly dryRun?: boolean },
  ) => Promise<{ engine: Engine; source: TestSource }>;
}

async function setUp(
  database: TestDatabase,
  transform = LAB_TRANSFORM,
  channelYaml = CHANNEL,
): Promise<Setup> {
  const root = await makeProject({
    "channels/adt/channel.yaml": channelYaml,
    "channels/adt/transform.ts": transform,
  });
  const project = await loadProject(root);
  const storage = await testStorage(database, project.databaseFile);
  const open = async (): Promise<Store> => {
    const opened = await storage.open();
    stores.push(opened);
    return opened;
  };
  const store = await open();
  const clock = { now: Date.now() };
  const destination = new TestDestination();
  const engineOn = async (
    on: Store,
    logger: Logger = captureLogger().logger,
    extra: { readonly dryRun?: boolean } = {},
  ): Promise<{ engine: Engine; source: TestSource }> => {
    const source = new TestSource();
    const engine = new Engine({
      project,
      store: on,
      logger,
      now: () => clock.now,
      connectors: () => ({ source, destinations: [destination] }),
      ...extra,
    });
    engines.push(engine);
    await engine.start();
    return { engine, source };
  };
  return { root, project, store, destination, clock, open, engineOn };
}

const actor = { actor: "test-operator" };
const body = (): Uint8Array => new TextEncoder().encode(ADT_A01);

/** The channel `adt` as the project folder now reads. */
async function channelNow(root: string): Promise<ChannelConfig> {
  const [channel] = (await loadProject(root)).channels;
  if (channel === undefined) throw new Error("no channel");
  return channel;
}

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`Channel control on ${database.label}`, () => {
    it("keeps each channel's state in storage: running removes its row", async () => {
      const { store } = await setUp(database);
      expect(await store.channelStates()).toEqual({});
      await store.setChannelState("adt", "paused");
      await store.setChannelState("lab", "stopped");
      expect(await store.channelStates()).toEqual({ adt: "paused", lab: "stopped" });
      await store.setChannelState("adt", "stopped");
      await store.setChannelState("lab", "running");
      expect(await store.channelStates()).toEqual({ adt: "stopped" });
      // A state this version does not know, written by a later one, reads as running.
      await store.setChannelState("adt", "draining" as ChannelRunState);
      expect(await store.channelStates()).toEqual({});
    });

    it("pauses the source while stored messages go on to delivery, and resumes it", async () => {
      const { store, destination, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      expect(source.starts).toBe(1);
      await source.sink?.receive(body());

      const paused = await engine.command("pause", "adt", actor);
      expect(paused).toEqual({ channel: "adt", state: "paused" });
      expect(source.stops).toBe(1);
      await engine.tick();
      // Taken in before the pause, so transformed and delivered; the source is not polled.
      expect(destination.delivered).toHaveLength(1);
      expect(source.polls).toBe(0);
      expect((await engine.health()).channels["adt"]).toMatchObject({ state: "paused" });
      expect((await engine.health()).status).toBe("ok");

      expect(await engine.command("resume", "adt", actor)).toEqual({
        channel: "adt",
        state: "running",
      });
      expect(source.starts).toBe(2);
      await engine.tick();
      expect(source.polls).toBe(1);

      const entries = await store.auditEntries({ limit: 10 });
      expect(entries.items.map((entry) => [entry.action, entry.actor, entry.channel])).toEqual([
        ["channel-resume", "test-operator", "adt"],
        ["channel-pause", "test-operator", "adt"],
      ]);
      expect(entries.items[1]?.detail).toEqual({ state: "paused" });
    });

    it("stays paused across a restart: the new engine does not open the source", async () => {
      const { store, open, engineOn } = await setUp(database);
      const first = await engineOn(store);
      await first.engine.command("pause", "adt", actor);
      await first.engine.stop();

      const second = await engineOn(await open());
      expect(second.source.starts).toBe(0);
      await second.engine.tick();
      expect(second.source.polls).toBe(0);
      expect(second.engine.channelStates()).toEqual({ adt: "paused" });
      await second.engine.command("resume", "adt", actor);
      expect(second.source.starts).toBe(1);
    });

    it("carries a pause given to one engine to another on the same database within one pass", async () => {
      const { store, open, engineOn } = await setUp(database);
      const one = await engineOn(store);
      const two = await engineOn(await open());
      expect(two.source.starts).toBe(1);
      await one.engine.command("pause", "adt", actor);
      await two.engine.tick();
      expect(two.engine.channelStates()).toEqual({ adt: "paused" });
      expect(two.source.stops).toBe(1);
      expect(two.source.polls).toBe(0);
      await one.engine.command("resume", "adt", actor);
      await two.engine.tick();
      expect(two.source.starts).toBe(2);
      expect(two.source.polls).toBe(1);
    });

    it("delivers a message waiting for a retry while the channel is paused", async () => {
      const { store, destination, clock, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      destination.plan.push("fail");
      await source.sink?.receive(body());
      await engine.tick();
      expect(destination.sends).toBe(1);
      expect(await store.retryingDeliveries("adt")).toBe(1);

      await engine.command("pause", "adt", actor);
      clock.now += 60_000;
      await engine.tick();
      expect(destination.delivered).toHaveLength(1);
      expect(await store.deliveryCounts("adt")).toMatchObject({ pending: 0, delivered: 1 });
    });

    it("halts a delivery in flight, leaves it pending, and sends it once after a resume", async () => {
      const { store, destination, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      destination.plan.push("hold");
      await source.sink?.receive(body());
      const sent = destination.sent();
      const pass = engine.tick();
      await sent;

      const halted = await engine.command("halt", "adt", { ...actor, deadlineMs: 5_000 });
      await pass;
      expect(halted).toEqual({
        channel: "adt",
        state: "stopped",
        drained: true,
        left: { toTransform: 0, toDeliver: 1 },
      });
      expect(destination.delivered).toHaveLength(0);
      await engine.tick();
      expect(destination.sends).toBe(1);

      await engine.command("resume", "adt", actor);
      await engine.tick();
      await engine.tick();
      expect(destination.sends).toBe(2);
      expect(destination.delivered).toHaveLength(1);
      // The halted send may have reached the receiver, so the one after it is flagged.
      expect(destination.delivered[0]?.resend).toEqual({ previousAttempts: 1 });
      expect(await store.deliveryCounts("adt")).toMatchObject({ pending: 0, delivered: 1 });
    });

    it("stops after the work in hand and reports what it left, or that the deadline passed", async () => {
      const { store, destination, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      destination.plan.push("hold");
      await source.sink?.receive(body());
      await source.sink?.receive(body());
      const sent = destination.sent();
      const pass = engine.tick();
      await sent;

      const stopped = await engine.command("stop", "adt", { ...actor, deadlineMs: 50 });
      expect(stopped).toMatchObject({ channel: "adt", state: "stopped", drained: false });
      expect(source.stops).toBe(1);
      // A halt cuts the held send off; the pass ends, and nothing is sent while stopped.
      await engine.command("halt", "adt", actor);
      await pass;
      expect(destination.delivered).toHaveLength(0);
      expect(await store.deliveryCounts("adt")).toMatchObject({ pending: 2 });
      expect((await engine.health()).channels["adt"]).toMatchObject({ state: "stopped" });
    });

    it("reloads the transform between messages, in a fresh worker", async () => {
      const { root, store, destination, engineOn } = await setUp(database, tagging("FIRST"));
      const { engine, source } = await engineOn(store);
      await source.sink?.receive(body());
      await engine.tick();
      await writeFile(join(root, "channels/adt/transform.ts"), tagging("SECOND"));

      const reloaded = await engine.command("reload", "adt", {
        ...actor,
        config: await channelNow(root),
      });
      expect(reloaded).toEqual({ channel: "adt", state: "running" });
      await source.sink?.receive(body());
      await engine.tick();
      const tags = destination.delivered.map((m) => new TextDecoder().decode(m.body).split("|")[4]);
      expect(tags).toEqual(["FIRST", "SECOND"]);
    });

    it("refuses a reload whose transform will not load, or whose configuration is invalid, keeping the old one", async () => {
      const { root, store, destination, engineOn } = await setUp(database, tagging("FIRST"));
      const { engine, source } = await engineOn(store);
      await writeFile(
        join(root, "channels/adt/transform.ts"),
        'throw new Error("TESTPATIENT");\nexport default () => null;\n',
      );
      const failed = await engine.command("reload", "adt", {
        ...actor,
        config: await channelNow(root),
      });
      expect(failed).toEqual({
        channel: "adt",
        refused: "transform-load-failed",
        failure: "Error",
      });
      expect(await engine.command("reload", "adt", { ...actor, config: "invalid-config" })).toEqual(
        { channel: "adt", refused: "invalid-config" },
      );
      expect(await engine.command("reload", "adt", { ...actor, config: "not-configured" })).toEqual(
        { channel: "adt", refused: "not-configured" },
      );
      await source.sink?.receive(body());
      await engine.tick();
      expect(new TextDecoder().decode(destination.delivered[0]?.body).split("|")[4]).toBe("FIRST");
      const refusals = await store.auditEntries({ action: "channel-reload", limit: 10 });
      expect(refusals.items.map((entry) => entry.outcome)).toEqual([
        "refused",
        "refused",
        "refused",
      ]);
      // Never the error's text, which can carry content.
      expect(JSON.stringify(refusals.items)).not.toContain("TESTPATIENT");
    });

    it("names the settings a reload cannot change, which need a restart", async () => {
      const { root, store, engineOn } = await setUp(database);
      const { engine } = await engineOn(store);
      await writeFile(
        join(root, "channels/adt/channel.yaml"),
        CHANNEL.replace("data/out", "data/elsewhere").replace("data/inbox", "data/inbox2"),
      );
      expect(
        await engine.command("reload", "adt", { ...actor, config: await channelNow(root) }),
      ).toEqual({ channel: "adt", refused: "needs-restart", changed: ["source", "destinations"] });
    });

    it("reloads the transform's configuration, the project's under the channel's, read anew", async () => {
      const { root, store, destination, engineOn } = await setUp(
        database,
        CONFIGURED,
        `${CHANNEL}config: { facility: FIRST }\n`,
      );
      const { engine, source } = await engineOn(store);
      const tags = (): (string | undefined)[] =>
        destination.delivered.map((m) => new TextDecoder().decode(m.body).split("|")[4]);
      await source.sink?.receive(body());
      await engine.tick();

      await writeFile(
        join(root, "channels/adt/channel.yaml"),
        `${CHANNEL}config: { facility: SECOND }\n`,
      );
      expect(
        await engine.command("reload", "adt", {
          ...actor,
          config: await channelNow(root),
          transformConfig: { facility: "PROJECT", site: "NORTH" },
        }),
      ).toEqual({ channel: "adt", state: "running" });
      await source.sink?.receive(body());
      await engine.tick();

      // Given no project block, the one the engine started with stands.
      expect(
        await engine.command("reload", "adt", { ...actor, config: await channelNow(root) }),
      ).toEqual({ channel: "adt", state: "running" });
      await source.sink?.receive(body());
      await engine.tick();
      expect(tags()).toEqual(["FIRST-undefined", "SECOND-NORTH", "SECOND-undefined"]);
    });

    it("refuses a reload whose configuration names a variable that is not set, keeping the old one", async () => {
      const { root, store, destination, engineOn } = await setUp(
        database,
        CONFIGURED,
        `${CHANNEL}config: { facility: FIRST }\n`,
      );
      const { engine, source } = await engineOn(store);
      await writeFile(
        join(root, "channels/adt/channel.yaml"),
        `${CHANNEL}config: { facility: { env: SYNTHETIC_UNSET_FACILITY } }\n`,
      );
      expect(
        await engine.command("reload", "adt", { ...actor, config: await channelNow(root) }),
      ).toEqual({ channel: "adt", refused: "invalid-config" });
      await source.sink?.receive(body());
      await engine.tick();
      expect(new TextDecoder().decode(destination.delivered[0]?.body).split("|")[4]).toBe(
        "FIRST-undefined",
      );
    });

    it("keeps a paused channel paused across a restart with a secret reference, and reloads it unchanged", async () => {
      const { root, store, open, engineOn } = await setUp(database, LAB_TRANSFORM, WITH_SECRET);
      const first = await engineOn(store);
      await first.engine.command("pause", "adt", actor);
      // The same reference read again is the same destination: no restart is asked for.
      expect(
        await first.engine.command("reload", "adt", { ...actor, config: await channelNow(root) }),
      ).toEqual({ channel: "adt", state: "paused" });
      await first.engine.stop();

      const second = await engineOn(await open());
      expect(second.source.starts).toBe(0);
      expect(second.engine.channelStates()).toEqual({ adt: "paused" });
      await second.engine.command("resume", "adt", actor);
      expect(second.source.starts).toBe(1);
    });

    it("under start --dry-run, says which destinations run dry and keeps a paused or stopped channel so", async () => {
      const { store, destination, clock, open, engineOn } = await setUp(database);
      const first = await engineOn(store);
      destination.plan.push("fail");
      await first.source.sink?.receive(body());
      await first.engine.tick();
      expect(await store.retryingDeliveries("adt")).toBe(1);
      await first.engine.command("halt", "adt", actor);
      await first.engine.stop();

      const log = captureLogger();
      const second = await engineOn(await open(), log.logger, { dryRun: true });
      expect(second.source.starts).toBe(0);
      expect(log.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "dry-run-destinations", channels: { adt: [0] } }),
          expect.objectContaining({
            event: "dry-run-pending",
            channel: "adt",
            destinations: [0],
            pending: 1,
          }),
          expect.objectContaining({ event: "channel-state", channel: "adt", state: "stopped" }),
        ]),
      );
      // Stopped: the pending delivery is neither sent nor marked.
      clock.now += 60_000;
      await second.engine.tick();
      expect(await store.deliveryCounts("adt")).toMatchObject({ pending: 1 });

      // Paused: stored work goes on, so the delivery is marked dry-run, still not sent.
      await second.engine.command("pause", "adt", actor);
      await second.engine.tick();
      expect(second.source.starts).toBe(0);
      expect(await store.deliveryCounts("adt")).toMatchObject({ pending: 0, "dry-run": 1 });
      expect(destination.sends).toBe(1);
    });

    it("refuses a reload during a stop's drain, and runs two reloads one after the other", async () => {
      const { root, store, destination, engineOn } = await setUp(database, tagging("FIRST"));
      const { engine, source } = await engineOn(store);
      destination.plan.push("hold");
      await source.sink?.receive(body());
      const sent = destination.sent();
      const pass = engine.tick();
      await sent;
      const config = await channelNow(root);
      const stopping = engine.command("stop", "adt", { ...actor, deadlineMs: 5_000 });
      expect(await engine.command("reload", "adt", { ...actor, config })).toEqual({
        channel: "adt",
        refused: "draining",
      });
      await engine.command("halt", "adt", actor);
      await pass;
      await stopping;

      await writeFile(join(root, "channels/adt/transform.ts"), tagging("SECOND"));
      const second = await channelNow(root);
      const both = await Promise.all([
        engine.command("reload", "adt", { ...actor, config }),
        engine.command("reload", "adt", { ...actor, config: second }),
      ]);
      expect(both).toEqual([
        { channel: "adt", state: "stopped" },
        { channel: "adt", state: "stopped" },
      ]);
      await engine.command("resume", "adt", actor);
      await source.sink?.receive(body());
      await engine.tick();
      const tags = destination.delivered.map((m) => new TextDecoder().decode(m.body).split("|")[4]);
      // The halted delivery, transformed before the reloads, then the new message, through the
      // transform the reloads loaded.
      expect(tags).toEqual(["FIRST", "SECOND"]);
    });

    it("keeps the states it has when they cannot be read, and logs the code", async () => {
      const { store, engineOn } = await setUp(database);
      const { logger, events } = captureLogger();
      const { engine, source } = await engineOn(store, logger);
      await engine.command("pause", "adt", actor);
      const failing = vi
        .spyOn(store, "channelStates")
        .mockRejectedValueOnce(Object.assign(new Error("TESTPATIENT"), { code: "ETEST" }));
      await engine.tick();
      expect(failing).toHaveBeenCalled();
      expect(engine.channelStates()).toEqual({ adt: "paused" });
      expect(source.polls).toBe(0);
      expect(events.find((e) => e.event === "channel-states-unread")).toMatchObject({
        code: "ETEST",
      });
      expect(JSON.stringify(events)).not.toContain("TESTPATIENT");
    });

    it("stops an idle channel at once, and ends a pass between deliveries and between transforms", async () => {
      const { store, destination, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      expect(await engine.command("stop", "adt", actor)).toEqual({
        channel: "adt",
        state: "stopped",
        drained: true,
        left: { toTransform: 0, toDeliver: 0 },
      });
      await engine.command("resume", "adt", actor);

      // A delivery in flight finishes; the next waits for a resume.
      destination.plan.push("wait");
      await source.sink?.receive(body());
      await source.sink?.receive(body());
      const sent = destination.sent();
      const pass = engine.tick();
      await sent;
      const stopping = engine.command("stop", "adt", { ...actor, deadlineMs: 5_000 });
      destination.release();
      expect(await stopping).toEqual({
        channel: "adt",
        state: "stopped",
        drained: true,
        left: { toTransform: 0, toDeliver: 1 },
      });
      await pass;
      expect(destination.delivered).toHaveLength(1);
    });

    it("takes a stop in hand before storing it, so no delivery starts while the write runs", async () => {
      const { store, destination, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      const stored = gatedStateWrites(store);
      destination.plan.push("wait");
      await source.sink?.receive(body());
      await source.sink?.receive(body());
      const sent = destination.sent();
      const pass = engine.tick();
      await sent;
      const stopping = engine.command("stop", "adt", { ...actor, deadlineMs: 5_000 });
      expect(engine.channelStates()).toEqual({ adt: "stopped" });
      destination.release();
      await pass;
      // The pass ended after the delivery in hand, while the stop was still being stored.
      expect(destination.sends).toBe(1);
      stored.open();
      expect(await stopping).toEqual({
        channel: "adt",
        state: "stopped",
        drained: true,
        left: { toTransform: 0, toDeliver: 1 },
      });
      expect(await store.channelStates()).toEqual({ adt: "stopped" });
    });

    it("does not let a pass put back a state that is still being stored", async () => {
      const { store, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      const stored = gatedStateWrites(store);
      const pausing = engine.command("pause", "adt", actor);
      // The pass reads no row for the channel yet, and must not take that as running.
      await engine.tick();
      expect(engine.channelStates()).toEqual({ adt: "paused" });
      expect(source.polls).toBe(0);
      expect(source.starts).toBe(1);
      stored.open();
      expect(await pausing).toEqual({ channel: "adt", state: "paused" });
      await engine.tick();
      expect(engine.channelStates()).toEqual({ adt: "paused" });
      expect(source.polls).toBe(0);
    });

    it("puts the state back and says so when it cannot be stored", async () => {
      const { store, engineOn } = await setUp(database);
      const { logger, events } = captureLogger();
      const { engine, source } = await engineOn(store, logger);
      const failing = (): Error => Object.assign(new Error("TESTPATIENT"), { code: "ETEST" });
      vi.spyOn(store, "setChannelState")
        .mockRejectedValueOnce(failing())
        .mockRejectedValueOnce(failing());

      expect(await engine.command("pause", "adt", actor)).toEqual({
        channel: "adt",
        state: "running",
        refused: "state-not-stored",
      });
      // Closed at once, then opened again when the write failed.
      expect(source.stops).toBe(1);
      expect(source.starts).toBe(2);
      expect(await engine.command("stop", "adt", actor)).toEqual({
        channel: "adt",
        state: "running",
        refused: "state-not-stored",
      });
      expect(engine.channelStates()).toEqual({ adt: "running" });
      await engine.tick();
      expect(source.polls).toBe(1);
      expect(await store.channelStates()).toEqual({});

      expect(events.filter((e) => e.event === "channel-state-unstored")).toEqual([
        expect.objectContaining({ channel: "adt", state: "paused", code: "ETEST" }),
        expect.objectContaining({ channel: "adt", state: "stopped", code: "ETEST" }),
      ]);
      expect(JSON.stringify(events)).not.toContain("TESTPATIENT");
      const entries = await store.auditEntries({ limit: 10 });
      expect(entries.items.map((entry) => [entry.action, entry.outcome])).toEqual([
        ["channel-stop", "refused"],
        ["channel-pause", "refused"],
      ]);
      expect(entries.items[1]?.detail).toEqual({ state: "running", reason: "state-not-stored" });
    });

    it.each([
      ["neither method", ["channelStates", "setChannelState"]],
      ["only one of the two methods", ["setChannelState"]],
    ])(
      "keeps the state in the engine alone on a store with %s for states",
      async (_label, hidden) => {
        const { store, engineOn } = await setUp(database);
        // A custom store that keeps no states: an engine needs both methods to use them.
        const plain = new Proxy(store, {
          get(target, key): unknown {
            if (typeof key === "string" && hidden.includes(key)) return undefined;
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? (value as () => unknown).bind(target) : value;
          },
        });
        const { engine, source } = await engineOn(plain);
        expect(await engine.command("pause", "adt", actor)).toEqual({
          channel: "adt",
          state: "paused",
        });
        await engine.tick();
        expect(engine.channelStates()).toEqual({ adt: "paused" });
        expect(source.polls).toBe(0);
        expect(await store.channelStates()).toEqual({});
      },
    );

    it("keeps a later command's state when an earlier one's write fails", async () => {
      const { store, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const write = store.setChannelState.bind(store);
      vi.spyOn(store, "setChannelState")
        .mockImplementationOnce(async () => {
          await gate;
          throw Object.assign(new Error("TESTPATIENT"), { code: "ETEST" });
        })
        .mockImplementation(write);
      const pausing = engine.command("pause", "adt", actor);
      const resuming = engine.command("resume", "adt", actor);
      open();
      expect(await pausing).toEqual({
        channel: "adt",
        state: "running",
        refused: "state-not-stored",
      });
      expect(await resuming).toEqual({ channel: "adt", state: "running" });
      expect(engine.channelStates()).toEqual({ adt: "running" });
      expect(source.starts).toBe(2);
      expect(await store.channelStates()).toEqual({});
    });

    it("stores the state even when the source will not close, and says the source failed", async () => {
      const { store, engineOn } = await setUp(database);
      const { engine, source } = await engineOn(store);
      vi.spyOn(source, "stop").mockRejectedValueOnce(new Error("TESTPATIENT"));
      await expect(engine.command("pause", "adt", actor)).rejects.toThrow("TESTPATIENT");
      expect(engine.channelStates()).toEqual({ adt: "paused" });
      expect(await store.channelStates()).toEqual({ adt: "paused" });
    });

    it("ends a pass between transforms when stopped", async () => {
      const slow = `
export default (msg: unknown): unknown => {
  const until = Date.now() + 300;
  while (Date.now() < until) { /* a slow transform */ }
  return msg;
};
`;
      const { store, destination, engineOn } = await setUp(database, slow);
      const { engine, source } = await engineOn(store);
      await source.sink?.receive(body());
      await source.sink?.receive(body());
      const pass = engine.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const stopped = await engine.command("stop", "adt", { ...actor, deadlineMs: 5_000 });
      await pass;
      expect(stopped).toEqual({
        channel: "adt",
        state: "stopped",
        drained: true,
        left: { toTransform: 1, toDeliver: 1 },
      });
      expect(destination.sends).toBe(0);
    });

    it("refuses a reload given no configuration", async () => {
      const { store, engineOn } = await setUp(database);
      const { engine } = await engineOn(store);
      expect(await engine.command("reload", "adt", actor)).toEqual({
        channel: "adt",
        refused: "not-configured",
      });
    });

    it("answers a command for a channel it does not run", async () => {
      const { store, engineOn } = await setUp(database);
      const { engine } = await engineOn(store);
      expect(await engine.command("pause", "nope", actor)).toEqual({
        channel: "nope",
        refused: "no-such-channel",
      });
    });
  });
}
