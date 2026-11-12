// The settled event: one per message, once its last delivery is delivered or failed for good, or it
// was filtered, or its transform failed. Recorded on the message's row by one conditional update, so
// a restart sends what a crash left and nothing twice.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type SourceConnector,
} from "../src/connectors/types.js";
import { destinationKeys } from "../src/engine/destination-key.js";
import { Engine } from "../src/engine/engine.js";
import type { LifecycleEvent, SettledEvent } from "../src/extensions/events.js";
import type { MessageStore, Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
} from "./databases.js";
import { captureLogger, cleanUp, makeProject, type LogEvent } from "./helpers.js";

const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An engine-wide hook that appends each event to `options.file` as a JSON line. */
const RECORDING_HOOK = `
import { appendFileSync } from "node:fs";
export default (options: { file: string }) => ({
  onEvent(event: unknown): void {
    appendFileSync(options.file, JSON.stringify(event) + "\\n");
  },
});
`;

/** An engine-wide hook that holds each event until its time limit, so its queue fills. */
const STUCK_HOOK = `
export default () => ({
  onEvent(_event: unknown, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
  },
});
`;

/**
 * Bodies starting `null` are filtered, `throw` fail their transform, `many` give 600 outputs; any
 * other passes through.
 */
const TRANSFORM = `
export default (m: string): string | string[] | null => {
  if (m.startsWith("null")) return null;
  if (m.startsWith("throw")) throw new RangeError("synthetic");
  if (m.startsWith("many")) return Array.from({ length: 600 }, () => m);
  return m;
};
`;

interface Setup {
  readonly root: string;
  readonly hookFile: string;
  readonly inbox: string[];
  readonly store: Store;
  /** Starts an engine on the project and the store, as a fresh start of `pathways start` would. */
  readonly engine: (options?: { store?: MessageStore }) => Promise<Engine>;
  readonly settled: () => Promise<SettledEvent[]>;
  /** What every engine started here logged. */
  readonly logs: LogEvent[];
}

async function setUp(database: TestDatabase, hook = RECORDING_HOOK): Promise<Setup> {
  const root = await makeProject({
    "hooks/hook.ts": hook,
    "channels/adt/channel.yaml":
      "format: text\nsource:\n  file: { dir: ../../data/inbox }\ntransform: ./transform.ts\n" +
      "destinations:\n  - file: { dir: ../../data/out }\n  - module: ../../destination.ts\n",
    "channels/adt/transform.ts": TRANSFORM,
    "destination.ts": "export default () => ({ deliver: () => Promise.resolve() });\n",
  });
  const hookFile = join(root, "events.jsonl");
  await writeFile(
    join(root, "pathways.yaml"),
    `hooks:\n  - module: ./hooks/hook.ts\n    options: { file: ${JSON.stringify(hookFile)} }\n    timeout: 1s\n`,
  );
  const project = await loadProject(root);
  const store = await (await testStorage(database, project.databaseFile)).open();
  stores.push(store);
  const inbox: string[] = [];
  const source: SourceConnector = {
    async poll(sink) {
      for (const body of inbox.splice(0)) await sink.receive(bytes(body));
    },
  };
  // The second destination rejects each body starting `reject`.
  const rejecting: DestinationConnector = {
    deliver(message) {
      if (new TextDecoder().decode(message.body).startsWith("reject")) {
        return Promise.reject(new DeliveryRejected("AE"));
      }
      return Promise.resolve();
    },
  };
  const accepting: DestinationConnector = { deliver: () => Promise.resolve() };
  const { logger, events: logs } = captureLogger();
  const engine = async (options: { store?: MessageStore } = {}): Promise<Engine> => {
    const started = new Engine({
      project,
      store: options.store ?? store,
      logger,
      connectors: () => ({ source, destinations: [accepting, rejecting] }),
    });
    engines.push(started);
    await started.start();
    return started;
  };
  const settled = async (): Promise<SettledEvent[]> =>
    (await readFile(hookFile, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LifecycleEvent)
      .filter((event): event is SettledEvent => event.type === "settled");
  return { root, hookFile, inbox, store, engine, settled, logs };
}

/** Stops `engine`, so its hooks finish what is queued, and forgets it. */
async function stop(engine: Engine): Promise<void> {
  engines.splice(engines.indexOf(engine), 1);
  await engine.stop();
}

const shape = (event: SettledEvent): unknown => ({
  channel: event.channel,
  messageId: event.messageId,
  destinations: event.destinations,
});

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`the settled event on ${database.label}`, () => {
    it("is sent once a message's last delivery ends, with each destination's state", async () => {
      const { inbox, engine, settled } = await setUp(database);
      const running = await engine();
      inbox.push("delivered", "rejected");
      await running.tick();
      await stop(running);
      expect((await settled()).map(shape)).toEqual([
        {
          channel: "adt",
          messageId: 1,
          destinations: [
            { index: 0, name: "file", state: "delivered" },
            { index: 1, name: "module", state: "delivered" },
          ],
        },
        {
          channel: "adt",
          messageId: 2,
          destinations: [
            { index: 0, name: "file", state: "delivered" },
            { index: 1, name: "module", state: "failed" },
          ],
        },
      ]);
    });

    it("is sent for a message that was filtered, and for one whose transform failed", async () => {
      const { inbox, engine, settled } = await setUp(database);
      const running = await engine();
      inbox.push("null please", "throw please");
      await running.tick();
      await stop(running);
      expect((await settled()).map(shape)).toEqual([
        {
          channel: "adt",
          messageId: 1,
          destinations: [
            { index: 0, name: "file", state: "filtered" },
            { index: 1, name: "module", state: "filtered" },
          ],
        },
        {
          channel: "adt",
          messageId: 2,
          destinations: [
            { index: 0, name: "file", state: "failed" },
            { index: 1, name: "module", state: "failed" },
          ],
        },
      ]);
    });

    it("is sent exactly once across a restart that finds one the last run did not record", async () => {
      const { inbox, store, engine, settled } = await setUp(database);
      // The first run ends each message, and stops before it records one as settled: as a crash
      // between the last delivery and the settle would.
      const forgetful = Object.create(store, { settle: { value: undefined } }) as Store;
      const first = await engine({ store: forgetful });
      inbox.push("one", "null two");
      await first.tick();
      await stop(first);
      expect(await settled()).toEqual([]);
      expect(await store.unsettled("adt", 0, 10)).toEqual([1, 2]);

      // The next start settles both; the one after finds nothing left.
      await stop(await engine());
      await stop(await engine());
      expect((await settled()).map((event) => event.messageId)).toEqual([1, 2]);
      expect(await store.unsettled("adt", 0, 10)).toEqual([]);
    });

    it("is recorded by one of two engines settling the same message at once", async () => {
      const { inbox, store, engine } = await setUp(database);
      const forgetful = Object.create(store, { settle: { value: undefined } }) as Store;
      const running = await engine({ store: forgetful });
      inbox.push("one");
      await running.tick();
      const answers = await Promise.all([store.settle(1), store.settle(1), store.settle(1)]);
      expect(answers.filter((answer) => answer !== undefined)).toEqual([
        {
          messageId: 1,
          channel: "adt",
          status: "transformed",
          deliveries: [
            { destination: 0, status: "delivered" },
            { destination: 1, status: "delivered" },
          ],
        },
      ]);
    });

    it("is sent again, once, for a replay, after the replay's deliveries end", async () => {
      const { root, inbox, store, engine, settled } = await setUp(database);
      const running = await engine();
      inbox.push("one");
      await running.tick();
      expect(await store.settle(1)).toBeUndefined();
      const replayed = await store.requeue(
        1,
        {
          mode: "replay",
          expected: "transformed",
          outputs: [bytes("again")],
          destinations: 2,
          // As `pathways replay` records it: each delivery with the key of its destination.
          keys: destinationKeys(root, (await loadProject(root)).channels[0]?.destinations ?? []),
        },
        "tester",
      );
      expect(replayed.done).toBe(true);
      // The replay's deliveries are pending: it is not settled until they end.
      expect(await store.settle(1)).toBeUndefined();
      await running.tick();
      await stop(running);
      expect((await settled()).map((event) => event.messageId)).toEqual([1, 1]);
    });

    it("is sent while the engine runs for a replay from another process that filters", async () => {
      const { inbox, store, engine, settled } = await setUp(database);
      const running = await engine();
      inbox.push("one");
      await running.tick();
      // As `pathways replay` records it from its own process after a transform that returns null:
      // the message is filtered for its new generation, and no delivery is queued.
      const replayed = await store.requeue(
        1,
        { mode: "replay", expected: "transformed", outputs: [], destinations: 2 },
        "tester",
      );
      expect(replayed.done).toBe(true);
      await running.tick();
      expect(await store.unsettled("adt", 0, 10)).toEqual([]);
      await running.tick();
      await stop(running);
      expect((await settled()).map(shape)).toEqual([
        {
          channel: "adt",
          messageId: 1,
          destinations: [
            { index: 0, name: "file", state: "delivered" },
            { index: 1, name: "module", state: "delivered" },
          ],
        },
        {
          channel: "adt",
          messageId: 1,
          destinations: [
            { index: 0, name: "file", state: "filtered" },
            { index: 1, name: "module", state: "filtered" },
          ],
        },
      ]);
    });

    it("is sent while the engine runs for a replay from another process that fails", async () => {
      const { inbox, store, engine, settled } = await setUp(database);
      const running = await engine();
      inbox.push("throw please");
      await running.tick();
      const replayed = await store.requeue(
        1,
        {
          mode: "replay",
          expected: "failed",
          outputs: [],
          failure: "transform: RangeError: synthetic",
          destinations: 2,
        },
        "tester",
      );
      expect(replayed.done).toBe(true);
      await running.tick();
      expect(await store.unsettled("adt", 0, 10)).toEqual([]);
      await stop(running);
      const failed = {
        channel: "adt",
        messageId: 1,
        destinations: [
          { index: 0, name: "file", state: "failed" },
          { index: 1, name: "module", state: "failed" },
        ],
      };
      expect((await settled()).map(shape)).toEqual([failed, failed]);
    });

    it("is recorded while a hook's queue is full: the event is dropped, the record stands", async () => {
      const { inbox, store, engine, logs } = await setUp(database, STUCK_HOOK);
      const running = await engine();
      inbox.push("many outputs");
      await running.tick();
      // 1,200 delivered events wait behind the stuck hook's first: the settled event was dropped,
      // and logged as such, and the message is recorded as settled all the same.
      expect(logs).toContainEqual(
        expect.objectContaining({ event: "hook-dropped", on: "settled" }),
      );
      expect(await store.unsettled("adt", 0, 10)).toEqual([]);
      expect(await store.settle(1)).toBeUndefined();
    }, 60_000);
  });
}
