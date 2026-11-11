// The marker written before a send: a delivery's attempt number and start time, set before the
// destination is handed the message and cleared by the outcome write. A delivery found marked was
// cut off between the two, so the receiver may have it already: it is sent again, flagged as a
// possible duplicate, never dropped and never sent again without the flag.
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ProjectConfig } from "../src/config/schema.js";
import type {
  DestinationConnector,
  OutgoingMessage,
  SourceConnector,
} from "../src/connectors/types.js";
import { Engine } from "../src/engine/engine.js";
import { AuditLog } from "../src/operator/audit.js";
import { showCommand } from "../src/operator/commands.js";
import { Store, type MessageStore } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  freshDatabase,
  TEST_DATABASES,
  type TestDatabase,
} from "./databases.js";
import { freshBench, RECORD_HOOK } from "./extension-helpers.js";
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
const text = (body: Uint8Array): string => new TextDecoder().decode(body);
const AT = Date.UTC(2026, 10, 11, 12, 0, 0);

/** A store on `database`, and a way to open the same database again, as a restart does. */
async function opener(database: TestDatabase): Promise<() => Promise<Store>> {
  let open: () => Promise<Store>;
  if (database.kind === "sqlite") {
    const file = join(await makeProject({}), "pathways.db");
    open = () => Store.open(file);
  } else {
    const { storage, env } = await freshDatabase(database);
    open = () => Store.open(storage, { env });
  }
  return async () => {
    const store = await open();
    stores.push(store);
    return store;
  };
}

/** One text channel, passed straight through, with the recording hook on every event. */
async function textProject(extra = ""): Promise<ProjectConfig> {
  const root = await makeProject({
    "hooks/record.ts": RECORD_HOOK,
    "pathways.yaml": "hooks:\n  - module: ./hooks/record.ts\n    options: { key: all }\n",
    "channels/notes/channel.yaml":
      "format: text\nsource:\n  file: { dir: ../../data/inbox }\ntransform: ./transform.ts\n" +
      "destinations:\n  - file: { dir: ../../data/out }\n" +
      extra,
    "channels/notes/transform.ts": "export default (text: string): string => text;\n",
  });
  return loadProject(root);
}

/** What a destination was handed: each message's id, and its resend flag when it had one. */
interface Sent {
  readonly messageId: number;
  readonly body: string;
  readonly resend: OutgoingMessage["resend"];
}

/** A source that takes in what the test queues, and a destination that records what it is sent. */
function scripted(): {
  readonly inbox: string[];
  readonly sent: Sent[];
  readonly source: SourceConnector;
  readonly destination: DestinationConnector;
} {
  const inbox: string[] = [];
  const sent: Sent[] = [];
  return {
    inbox,
    sent,
    source: {
      async poll(sink) {
        while (inbox.length > 0) await sink.receive(bytes(inbox.shift() as string));
      },
    },
    destination: {
      deliver(message) {
        sent.push({
          messageId: message.messageId,
          body: text(message.body),
          resend: message.resend,
        });
        return Promise.resolve();
      },
    },
  };
}

/** `store` with `method` throwing once, as a process ends there, before it writes anything. */
function stoppingAt(store: MessageStore, method: keyof MessageStore): MessageStore {
  let armed = true;
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== method || typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (armed) {
          armed = false;
          return Promise.reject(new Error("the process stopped"));
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

async function engineOn(
  project: ProjectConfig,
  store: MessageStore,
  connectors: ReturnType<typeof scripted>,
): Promise<{ engine: Engine; events: LogEvent[] }> {
  const { logger, events } = captureLogger();
  const engine = new Engine({
    project,
    store,
    logger,
    env: {},
    now: () => AT,
    connectors: () => ({ source: connectors.source, destinations: [connectors.destination] }),
  });
  engines.push(engine);
  await engine.start();
  return { engine, events };
}

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`The send marker on ${database.label}`, () => {
    it("is written before a send, read back with the delivery, and cleared by each outcome", async () => {
      const store = await (await opener(database))();
      for (const body of ["one", "two", "three"]) {
        const { id } = await store.receive("a", bytes(body));
        await store.completeTransform(id, [bytes(body)], 1);
      }
      const first = await store.nextDelivery("a", 0);
      expect(first?.sending).toBeUndefined();
      await store.markSending(first?.id ?? -1, { attempt: 1, at: AT });
      expect((await store.nextDelivery("a", 0))?.sending).toEqual({ attempt: 1, at: AT });
      await store.scheduleRetry(first?.id ?? -1, 1, 0, "delivery: ECONNRESET");
      expect((await store.nextDelivery("a", 0))?.sending).toBeUndefined();
      await store.markSending(first?.id ?? -1, { attempt: 2, at: AT + 1 });
      await store.markDelivered(first?.id ?? -1);

      const second = await store.nextDelivery("a", 0);
      await store.markSending(second?.id ?? -1, { attempt: 1, at: AT });
      // Found marked: sent again with the marker of the new attempt and the one cut off noted.
      await store.markSending(second?.id ?? -1, { attempt: 2, at: AT + 5, interruptedAttempt: 1 });
      expect(await store.nextDelivery("a", 0)).toMatchObject({
        sending: { attempt: 2, at: AT + 5 },
        interruptedAttempt: 1,
      });
      await store.failDelivery(second?.id ?? -1, "rejected: AE");

      const third = await store.nextDelivery("a", 0);
      await store.markSending(third?.id ?? -1, { attempt: 1, at: AT });
      await store.markDelivered(third?.id ?? -1);

      const rows = (await Promise.all([1, 2, 3].map((id) => store.deliveries(id)))).flat();
      expect(rows.map((row) => row.interruptedAttempt)).toEqual([undefined, 1, undefined]);
    });

    it("sends a delivery cut off after its send once more, flagged, and never again after a clean restart", async () => {
      freshBench();
      const project = await textProject();
      const open = await opener(database);
      const io = scripted();
      io.inbox.push("first", "second");

      // The first run sends "first" and stops before it records the outcome.
      const crashed = await engineOn(project, stoppingAt(await open(), "markDelivered"), io);
      await expect(crashed.engine.tick()).rejects.toThrow("the process stopped");
      await crashed.engine.stop();
      expect(io.sent).toEqual([{ messageId: 1, body: "first", resend: undefined }]);

      // The restart sends it again, flagged, then carries on with "second", not flagged.
      const store = await open();
      const restarted = await engineOn(project, store, io);
      await restarted.engine.tick();
      await restarted.engine.stop();
      expect(io.sent.slice(1)).toEqual([
        { messageId: 1, body: "first", resend: { previousAttempts: 1 } },
        { messageId: 2, body: "second", resend: undefined },
      ]);
      expect(restarted.events.filter((e) => e.event === "possible-duplicate")).toEqual([
        expect.objectContaining({
          level: 40,
          channel: "notes",
          message: 1,
          delivery: 1,
          destination: 0,
          reason: "send-interrupted",
          interruptedAttempt: 1,
        }),
      ]);
      expect(
        restarted.events.find((e) => e.event === "delivered" && e.delivery === 1),
      ).toMatchObject({
        resend: { previousAttempts: 1 },
      });
      const hooked = freshBenchEvents().filter((e) => e.type === "delivered" && e.messageId === 1);
      expect(hooked.at(-1)).toMatchObject({ attempt: 2, resend: { previousAttempts: 1 } });
      expect(await store.deliveries(1)).toEqual([
        expect.objectContaining({ status: "delivered", interruptedAttempt: 1 }),
      ]);
      expect((await store.deliveries(2))[0]?.interruptedAttempt).toBeUndefined();

      // `pathways messages show` names the delivery sent again.
      const shown: string[] = [];
      const context = {
        project,
        store,
        audit: new AuditLog(store),
        json: false,
        out: (line: string) => shown.push(line),
        err: (line: string) => shown.push(line),
        now: () => AT,
      };
      await showCommand(context, 1, false);
      expect(shown.join("")).toMatch(/ RESENT\n.* after attempt 1 cut off\n/s);
      await showCommand(context, 2, false);
      expect(shown.join("")).not.toMatch(/Message 2.*cut off/s);

      // A clean restart finds nothing marked and sends nothing again.
      const again = await engineOn(project, await open(), io);
      await again.engine.tick();
      expect(io.sent).toHaveLength(3);
      expect(again.events.filter((e) => e.event === "possible-duplicate")).toEqual([]);
    });
  });
}

/** The events the recording hook was handed, once they have been. */
function freshBenchEvents(): { type?: string; messageId?: number }[] {
  const holder = globalThis as unknown as { pathwaysTest: { events: Record<string, unknown[]> } };
  return (holder.pathwaysTest.events["all"] ?? []) as { type?: string; messageId?: number }[];
}

describe("A delivery cut off by a stop", () => {
  it("goes unflagged on a channel with resendFlag: false, which writes no marker", async () => {
    freshBench();
    const project = await textProject("resendFlag: false\n");
    expect(project.channels[0]?.settings.resendFlag).toBe(false);
    const open = await opener(TEST_DATABASES[0] as TestDatabase);
    const io = scripted();
    io.inbox.push("only");
    const crashed = await engineOn(project, stoppingAt(await open(), "markDelivered"), io);
    await expect(crashed.engine.tick()).rejects.toThrow("the process stopped");
    await crashed.engine.stop();
    const restarted = await engineOn(project, await open(), io);
    await restarted.engine.tick();
    expect(io.sent.map((s) => s.resend)).toEqual([undefined, undefined]);
    expect(restarted.events.filter((e) => e.event === "possible-duplicate")).toEqual([]);
  });

  it("keeps its flag on every later attempt, and counts the one cut off among them", async () => {
    freshBench();
    const project = await textProject();
    const open = await opener(TEST_DATABASES[0] as TestDatabase);
    const io = scripted();
    io.inbox.push("only");
    const crashed = await engineOn(project, stoppingAt(await open(), "markDelivered"), io);
    await expect(crashed.engine.tick()).rejects.toThrow("the process stopped");
    await crashed.engine.stop();

    // The resend fails, and the retry after it is still a possible duplicate.
    let fail = true;
    const flaky: DestinationConnector = {
      deliver(message) {
        if (fail) {
          fail = false;
          io.sent.push({ messageId: message.messageId, body: "refused", resend: message.resend });
          return Promise.reject(
            Object.assign(new Error("synthetic outage"), { code: "ECONNRESET" }),
          );
        }
        return io.destination.deliver(message);
      },
    };
    const store = await open();
    const { logger, events } = captureLogger();
    let now = AT;
    const engine = new Engine({
      project,
      store,
      logger,
      env: {},
      now: () => now,
      connectors: () => ({ source: io.source, destinations: [flaky] }),
    });
    engines.push(engine);
    await engine.start();
    await engine.tick();
    now += 60_000;
    await engine.tick();
    expect(io.sent.map((s) => s.resend)).toEqual([
      undefined,
      { previousAttempts: 1 },
      { previousAttempts: 2 },
    ]);
    expect(events.filter((e) => e.event === "delivery-retry")).toEqual([
      expect.objectContaining({ attempt: 2 }),
    ]);
    expect(events.filter((e) => e.event === "possible-duplicate")).toHaveLength(1);
  });

  it("delivers every stored message, wherever the process stops, and sends none twice unflagged", async () => {
    // Each delivery has four points a stop can fall on: before its marker is written, after it and
    // before the send, after the send and before the outcome is written, and after the outcome.
    // `killAt` counts them across every delivery of the run; past the last, nothing stops. A stop
    // is an error thrown around the store's write, which no part of the engine catches.
    const project = await textProject();
    await fc.assert(
      fc
        .asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          fc.nat({ max: 15 }),
          async (count, killAt) => {
            freshBench();
            const store = await Store.open(":memory:");
            stores.push(store);
            const io = scripted();
            for (let i = 0; i < count; i += 1) io.inbox.push(`note ${String(i)}`);
            let step = 0;
            const stop = (): void => {
              if (step === killAt) {
                step += 1;
                throw new Error("the process stopped");
              }
              step += 1;
            };
            const killing = new Proxy(store, {
              get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver) as unknown;
                if (typeof value !== "function") return value;
                if (property !== "markSending" && property !== "markDelivered") {
                  return (value as (...a: unknown[]) => unknown).bind(target);
                }
                return async (...args: unknown[]): Promise<unknown> => {
                  stop();
                  const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(
                    target,
                    args,
                  );
                  stop();
                  return result;
                };
              },
            }) as MessageStore;
            const first = await engineOn(project, killing, io);
            await first.engine.tick().catch(() => undefined);
            await first.engine.stop();
            const second = await engineOn(project, store, io);
            await second.engine.tick();
            await second.engine.stop();

            const stored = Array.from({ length: count }, (_, i) => i + 1);
            expect([...new Set(io.sent.map((s) => s.messageId))].sort()).toEqual(stored);
            for (const id of stored) {
              const copies = io.sent.filter((s) => s.messageId === id);
              expect(copies.filter((s) => s.resend === undefined).length).toBeLessThanOrEqual(1);
              expect(copies.length).toBeLessThanOrEqual(2);
            }
            expect(await store.deliveryCounts("notes")).toMatchObject({
              pending: 0,
              delivered: count,
            });
          },
        )
        .afterEach(async () => {
          // Each run's engines and store are let go as it ends, inside the test's own time limit,
          // so nothing piles up for the file's afterEach on a slow runner.
          await Promise.all(engines.splice(0).map((engine) => engine.stop()));
          await Promise.all(stores.splice(0).map((store) => store.close()));
        }),
      { numRuns: 20 },
    );
  }, 120_000);
});
