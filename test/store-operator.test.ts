import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import SqliteDatabase from "better-sqlite3";

import {
  MESSAGE_STATES,
  messageState,
  Store,
  type MessageState,
  type RequeueRequest,
} from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  freshDatabase,
  TEST_DATABASES,
  type TestDatabase,
} from "./databases.js";
import { cleanUp, makeProject } from "./helpers.js";

const stores: Store[] = [];

afterEach(async () => {
  // Closing twice is harmless, so a test that closes its own store is fine.
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array): string => new TextDecoder().decode(body);
const DAY = 86_400_000;

interface Clock {
  now: number;
}

const SQLITE = TEST_DATABASES[0] as TestDatabase;

/** A fresh store on `database`, with a clock a test can move, and its file on SQLite. */
async function openStore(
  database: TestDatabase = SQLITE,
): Promise<{ store: Store; file: string | undefined; clock: Clock }> {
  const clock = { now: Date.parse("2026-11-07T12:00:00.000Z") };
  const now = (): Date => new Date(clock.now);
  let store: Store;
  let file: string | undefined;
  if (database.kind === "sqlite") {
    file = join(await makeProject({}), "pathways.db");
    store = await Store.open(file, { now });
  } else {
    const { storage, env } = await freshDatabase(database);
    store = await Store.open(storage, { env, now });
  }
  stores.push(store);
  return { store, file, clock };
}

/** One message of channel `a` in each state, by the state's name. */
async function seed(store: Store): Promise<Record<MessageState, number[]>> {
  const receive = async (): Promise<number> => (await store.receive("a", bytes("in"))).id;
  const deliveryIds = async (id: number): Promise<number[]> =>
    (await store.deliveries(id)).map((d) => d.id);

  const received = await receive();
  const filtered = await receive();
  await store.completeTransform(filtered, [], 2);
  const failed = await receive();
  await store.failTransform(failed, "transform: TypeError at transform.ts:1:1: MSH quoted");
  const queued = await receive();
  await store.completeTransform(queued, [bytes("q")], 2);
  const retrying = await receive();
  await store.completeTransform(retrying, [bytes("r")], 2);
  const [retry] = await deliveryIds(retrying);
  await store.scheduleRetry(retry ?? -1, 1, 5_000, "delivery: ECONNREFUSED");
  const delivered = await receive();
  await store.completeTransform(delivered, [bytes("d")], 2);
  for (const id of await deliveryIds(delivered)) await store.markDelivered(id);
  const deliveryFailed = await receive();
  await store.completeTransform(deliveryFailed, [bytes("x")], 2);
  const [ok, rejected] = await deliveryIds(deliveryFailed);
  await store.markDelivered(ok ?? -1);
  await store.failDelivery(rejected ?? -1, "rejected: AE");
  const cleared = await receive();
  await store.failTransform(cleared, "transform: Timeout");
  await store.clear(cleared, "tester");
  const deliveryCleared = await receive();
  await store.completeTransform(deliveryCleared, [bytes("y")], 2);
  const [fine, bad] = await deliveryIds(deliveryCleared);
  await store.markDelivered(fine ?? -1);
  await store.failDelivery(bad ?? -1, "rejected: AE");
  await store.clear(deliveryCleared, "tester");
  return {
    received: [received],
    queued: [queued],
    retrying: [retrying],
    delivered: [delivered],
    filtered: [filtered],
    failed: [failed, deliveryFailed],
    cleared: [cleared, deliveryCleared],
  };
}

function resend(outputs: readonly string[], extra: Partial<RequeueRequest> = {}): RequeueRequest {
  return {
    mode: "replay",
    expected: "transformed",
    outputs: outputs.map(bytes),
    destinations: 2,
    ...extra,
  };
}

// The same suite on every database: SQLite always, each server whose URL is in the environment.
for (const database of TEST_DATABASES) {
  // A server commits more slowly than a SQLite file, and the suites share it with others in CI.
  const timeout = database.kind === "sqlite" ? 10_000 : 30_000;
  describe.skipIf(!available(database))(`on ${database.label}`, { timeout }, () => {
    describe("a message's state", () => {
      it("is worked out the same way in storage's filter and in messageState", async () => {
        const { store } = await openStore(database);
        const expected = await seed(store);
        const all = await store.listMessages({ limit: 100 });
        for (const summary of all.items) {
          expect(messageState(summary.status, summary.deliveries)).toBe(summary.state);
        }
        for (const state of MESSAGE_STATES) {
          const page = await store.listMessages({ channel: "a", state, limit: 100 });
          expect(page.items.map((m) => m.id).sort((x, y) => x - y)).toEqual(expected[state]);
          for (const message of page.items) expect(message.state).toBe(state);
        }
        await store.close();
      });

      it("follows the current generation only", async () => {
        const { store } = await openStore(database);
        const { id } = await store.receive("a", bytes("in"));
        await store.completeTransform(id, [bytes("out")], 1);
        const [first] = await store.deliveries(id);
        await store.failDelivery(first?.id ?? -1, "rejected: AE");
        expect((await store.message(id))?.state).toBe("failed");
        await store.requeue(id, resend(["again"], { destinations: 1 }), "tester");
        const replayed = await store.message(id);
        expect(replayed).toMatchObject({ state: "queued", generation: 1 });
        expect(replayed?.deliveries).toEqual({
          pending: 1,
          retrying: 0,
          delivered: 0,
          failed: 0,
          cleared: 0,
        });
        await store.close();
      });
    });

    describe("listing messages", () => {
      it("pages newest first, by channel and by time, without bodies or errors", async () => {
        const { store, clock } = await openStore(database);
        const ids: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          clock.now += 60_000;
          ids.push((await store.receive(i % 2 === 0 ? "a" : "b", bytes("x".repeat(i + 1)))).id);
        }
        const first = await store.listMessages({ limit: 2 });
        expect(first.items.map((m) => m.id)).toEqual([5, 4]);
        expect(first.next).toBe(4);
        const second = await store.listMessages({ limit: 2, before: first.next });
        expect(second.items.map((m) => m.id)).toEqual([3, 2]);
        const last = await store.listMessages({ limit: 2, before: second.next });
        expect(last).toMatchObject({ next: undefined });
        expect(last.items.map((m) => m.id)).toEqual([1]);

        expect(
          (await store.listMessages({ channel: "b", limit: 10 })).items.map((m) => m.id),
        ).toEqual([4, 2]);
        const window = await store.listMessages({
          since: "2026-11-07T12:02:00.000Z",
          until: "2026-11-07T12:04:00.000Z",
          limit: 10,
        });
        expect(window.items.map((m) => m.id)).toEqual([3, 2]);

        const [summary] = (await store.listMessages({ limit: 1 })).items;
        expect(summary).toEqual({
          id: 5,
          channel: "a",
          status: "received",
          state: "received",
          receivedAt: "2026-11-07T12:05:00.000Z",
          updatedAt: "2026-11-07T12:05:00.000Z",
          size: 5,
          duplicateOf: null,
          generation: 0,
          deliveries: { pending: 0, retrying: 0, delivered: 0, failed: 0, cleared: 0 },
        });
        expect(Object.keys(summary ?? {})).not.toContain("error");
        expect(Object.keys(summary ?? {})).not.toContain("body");
        expect(await store.channels()).toEqual(["a", "b"]);
        await store.close();
      });

      it("keeps the size a wrapping layer passes, and names retrying deliveries oldest first", async () => {
        const { store } = await openStore(database);
        const { id } = await store.receive("a", bytes("ciphertext, longer"), { size: 4 });
        expect((await store.message(id))?.size).toBe(4);
        await store.completeTransform(id, [bytes("1"), bytes("2")], 1);
        const [one, two] = await store.deliveries(id);
        await store.scheduleRetry(one?.id ?? -1, 3, 9_000, "delivery: ETIMEDOUT");
        await store.scheduleRetry(two?.id ?? -1, 1, 8_000, "delivery: ETIMEDOUT");
        expect(await store.listRetrying("a", 1)).toEqual([
          { id: one?.id, messageId: id, destination: 0, attempts: 3, nextAttemptAt: 9_000 },
        ]);
        expect(await store.listRetrying("a", 5)).toHaveLength(2);
        expect(await store.listRetrying("b", 5)).toEqual([]);
        await store.close();
      });

      it("reads a message's body, its deliveries and its current outputs", async () => {
        const { store } = await openStore(database);
        const { id } = await store.receive("a", bytes("raw"));
        expect(await store.outputs(id)).toEqual([]);
        await store.completeTransform(id, [bytes("o1"), bytes("o2")], 2);
        expect(text((await store.messageBody(id)) ?? new Uint8Array())).toBe("raw");
        expect(await store.messageBody(999)).toBeUndefined();
        expect((await store.outputs(id)).map(text)).toEqual(["o1", "o2"]);
        const deliveries = await store.deliveries(id);
        expect(deliveries.map((d) => [d.destination, d.seq, d.generation, d.status])).toEqual([
          [0, 0, 0, "pending"],
          [0, 1, 0, "pending"],
          [1, 0, 0, "pending"],
          [1, 1, 0, "pending"],
        ]);
        expect(deliveries[0]).toEqual({
          id: deliveries[0]?.id,
          destination: 0,
          seq: 0,
          generation: 0,
          status: "pending",
          attempts: 0,
          nextAttemptAt: 0,
          deliveredAt: null,
          error: null,
        });
        for (const delivery of deliveries) await store.markDelivered(delivery.id);
        await store.requeue(id, resend(["new"]), "tester");
        expect((await store.outputs(id)).map(text)).toEqual(["new"]);
        expect(await store.outputs(999)).toEqual([]);
        await store.close();
      });
    });

    describe("requeue", () => {
      it("records a replay: a new generation, fresh deliveries at the back, earlier failures cleared, and its audit entry", async () => {
        const { store } = await openStore(database);
        const { id } = await store.receive("a", bytes("in"));
        await store.completeTransform(id, [bytes("old")], 2);
        const [delivered, rejected] = await store.deliveries(id);
        await store.markDelivered(delivered?.id ?? -1);
        await store.failDelivery(rejected?.id ?? -1, "rejected: AE");
        // Another message is already waiting on both destinations.
        const { id: later } = await store.receive("a", bytes("later"));
        await store.completeTransform(later, [bytes("later-out")], 2);

        const result = await store.requeue(id, resend(["new-1", "new-2"]), "tester");
        expect(result).toMatchObject({
          done: true,
          status: "transformed",
          queued: 4,
          superseded: 1,
          generation: 1,
        });
        expect(result.entry).toMatchObject({
          actor: "tester",
          action: "replay",
          outcome: "ok",
          channel: "a",
          messageId: id,
          detail: { status: "transformed", queued: 4, superseded: 1, generation: 1 },
        });
        // The waiting message goes first on each destination; the replayed outputs follow it.
        for (const destination of [0, 1]) {
          const next = await store.nextDelivery("a", destination);
          expect(next?.messageId).toBe(later);
          await store.markDelivered(next?.id ?? -1);
          expect((await store.nextDelivery("a", destination))?.messageId).toBe(id);
        }
        expect((await store.deliveries(id)).map((d) => [d.generation, d.status])).toEqual([
          [0, "delivered"],
          [0, "cleared"],
          [1, "pending"],
          [1, "pending"],
          [1, "pending"],
          [1, "pending"],
        ]);
        expect((await store.auditEntries({ limit: 10 })).items).toEqual([result.entry]);
        await store.close();
      });

      it("records a replay that filters the message out, or fails it again with its error", async () => {
        const { store } = await openStore(database);
        const { id } = await store.receive("a", bytes("in"));
        await store.failTransform(id, "transform: TypeError: first");
        const filtered = await store.requeue(id, resend([], { expected: "failed" }), "tester");
        expect(filtered).toMatchObject({ done: true, status: "filtered", queued: 0 });
        const failed = await store.requeue(
          id,
          resend([], { expected: "filtered", failure: "transform: RangeError: second" }),
          "tester",
        );
        expect(failed).toMatchObject({ done: true, status: "failed", queued: 0, generation: 2 });
        expect(await store.message(id)).toMatchObject({
          status: "failed",
          error: "transform: RangeError: second",
        });
        const again = await store.requeue(id, resend(["ok"], { expected: "failed" }), "tester");
        expect(again).toMatchObject({ done: true, status: "transformed", queued: 2 });
        expect((await store.message(id))?.error).toBeNull();
        await store.close();
      });

      it("refuses, changing nothing, when the message is gone, has moved, or has deliveries pending, and audits the refusal", async () => {
        const { store } = await openStore(database);
        expect(await store.requeue(99, resend(["x"]), "tester")).toMatchObject({
          done: false,
          reason: "not-found",
          entry: {
            action: "replay",
            outcome: "not-found",
            messageId: 99,
            channel: null,
            detail: {},
          },
        });

        const { id } = await store.receive("a", bytes("in"));
        expect(
          await store.requeue(id, resend(["x"], { mode: "resend", expected: "failed" }), "tester"),
        ).toMatchObject({
          done: false,
          reason: "changed",
          entry: {
            action: "resend",
            outcome: "refused",
            channel: "a",
            detail: { reason: "changed" },
          },
        });

        await store.completeTransform(id, [bytes("out")], 1);
        expect(await store.requeue(id, resend(["x"]), "tester")).toMatchObject({
          done: false,
          reason: "pending",
          entry: { outcome: "refused", detail: { reason: "pending" } },
        });
        expect(await store.message(id)).toMatchObject({ status: "transformed", generation: 0 });
        expect(await store.deliveries(id)).toHaveLength(1);
        expect((await store.auditEntries({ limit: 10 })).items).toHaveLength(3);
        await store.close();
      });
    });

    describe("clear", () => {
      it("clears a failed message, or the failed deliveries of a transformed one, and audits it", async () => {
        const { store, clock } = await openStore(database);
        const { id: failed } = await store.receive("a", bytes("x"));
        await store.failTransform(failed, "transform: TypeError: boom");
        clock.now += 60_000;
        const result = await store.clear(failed, "tester");
        expect(result).toMatchObject({
          done: true,
          messages: 1,
          deliveries: 0,
          entry: { action: "clear", outcome: "ok", messageId: failed, channel: "a" },
        });
        expect(await store.message(failed)).toMatchObject({
          status: "cleared",
          state: "cleared",
          updatedAt: "2026-11-07T12:01:00.000Z",
        });
        expect(await store.messageCounts("a")).toMatchObject({ failed: 0, cleared: 1 });

        const { id: transformed } = await store.receive("a", bytes("y"));
        await store.completeTransform(transformed, [bytes("o")], 2);
        for (const delivery of await store.deliveries(transformed)) {
          await store.failDelivery(delivery.id, "rejected: AE");
        }
        expect(await store.clear(transformed, "tester")).toMatchObject({
          done: true,
          messages: 0,
          deliveries: 2,
        });
        expect(await store.deliveryCounts("a")).toEqual({
          pending: 0,
          delivered: 0,
          failed: 0,
          cleared: 2,
        });
        expect((await store.message(transformed))?.state).toBe("cleared");
        await store.close();
      });

      it("refuses a message with nothing failed, or none at all, and audits the refusal", async () => {
        const { store } = await openStore(database);
        const { id } = await store.receive("a", bytes("x"));
        expect(await store.clear(id, "tester")).toMatchObject({
          done: false,
          reason: "not-failed",
          entry: { action: "clear", outcome: "refused", detail: { reason: "not-failed" } },
        });
        expect(await store.clear(42, "tester")).toMatchObject({
          done: false,
          reason: "not-found",
          entry: { outcome: "not-found", messageId: 42 },
        });
        expect((await store.message(id))?.status).toBe("received");
        await store.close();
      });
    });

    describe("expire", () => {
      it("deletes done messages past the cutoff with their deliveries, and keeps everything else", async () => {
        const { store, clock } = await openStore(database);
        const start = clock.now;
        clock.now = start - 40 * DAY;
        const expected = await seed(store);
        // Delivered long ago, but delivered again recently: kept.
        const { id: recent } = await store.receive("a", bytes("r"));
        await store.completeTransform(recent, [bytes("o")], 1);
        clock.now = start - DAY;
        for (const d of await store.deliveries(recent)) await store.markDelivered(d.id);
        // Filtered yesterday: kept.
        const { id: fresh } = await store.receive("a", bytes("f"));
        await store.completeTransform(fresh, [], 1);
        // Another channel: untouched by this channel's run.
        clock.now = start - 40 * DAY;
        const { id: other } = await store.receive("b", bytes("b"));
        await store.completeTransform(other, [], 1);
        clock.now = start;

        const cutoff = new Date(start - 30 * DAY).toISOString();
        const gone = [...expected.delivered, ...expected.filtered, ...expected.cleared];
        const dry = await store.expire("a", cutoff, true);
        // Delivered: 2 deliveries; the cleared transformed message: 2; the others none.
        expect(dry).toEqual({ messages: gone.length, deliveries: 4 });
        expect((await store.listMessages({ limit: 100 })).items).toHaveLength(12);

        expect(await store.expire("a", cutoff, false)).toEqual(dry);
        const left = (await store.listMessages({ limit: 100 })).items.map((m) => m.id);
        for (const id of gone) expect(left).not.toContain(id);
        for (const id of [
          ...expected.received,
          ...expected.queued,
          ...expected.retrying,
          ...expected.failed,
          recent,
          fresh,
          other,
        ]) {
          expect(left).toContain(id);
        }
        for (const id of gone) expect(await store.deliveries(id)).toEqual([]);
        expect(await store.expire("a", cutoff, false)).toEqual({ messages: 0, deliveries: 0 });
        // The audit entries the seed's clears wrote are still there.
        expect((await store.auditEntries({ action: "clear", limit: 10 })).items).toHaveLength(2);
        await store.close();
      });

      // 501 messages, each stored and transformed: a batch of 500, then one more.
      it("deletes in batches until none is left", async () => {
        const { store, clock } = await openStore(database);
        const start = clock.now;
        clock.now = start - 40 * DAY;
        for (let i = 0; i < 501; i += 1) {
          const { id } = await store.receive("a", bytes("x"));
          await store.completeTransform(id, [], 1);
        }
        clock.now = start;
        const cutoff = new Date(start - 30 * DAY).toISOString();
        expect(await store.expire("a", cutoff, false)).toEqual({ messages: 501, deliveries: 0 });
        expect(await store.messageCounts("a")).toMatchObject({ filtered: 0 });
        await store.close();
      });
    }, 120_000);

    describe("the audit log", () => {
      it("appends entries with the time and the actor, and reads them back newest first with filters", async () => {
        const { store, clock } = await openStore(database);
        const first = await store.appendAudit("alice", [
          { action: "search", detail: { results: 3, state: "failed" } },
          { action: "content-view", channel: "a", messageId: 7 },
        ]);
        expect(first).toEqual([
          {
            id: 1,
            at: "2026-11-07T12:00:00.000Z",
            actor: "alice",
            action: "search",
            outcome: "ok",
            channel: null,
            messageId: null,
            detail: { results: 3, state: "failed" },
          },
          {
            id: 2,
            at: "2026-11-07T12:00:00.000Z",
            actor: "alice",
            action: "content-view",
            outcome: "ok",
            channel: "a",
            messageId: 7,
            detail: {},
          },
        ]);
        clock.now += 60_000;
        await store.appendAudit("bob", [{ action: "retention", detail: { messages: 0 } }]);

        const all = await store.auditEntries({ limit: 10 });
        expect(all.items.map((e) => e.id)).toEqual([3, 2, 1]);
        expect(all.next).toBeUndefined();
        const paged = await store.auditEntries({ limit: 2 });
        expect(paged).toMatchObject({ next: 2 });
        expect((await store.auditEntries({ limit: 2, before: 2 })).items.map((e) => e.id)).toEqual([
          1,
        ]);
        const ids = async (query: Parameters<Store["auditEntries"]>[0]): Promise<number[]> =>
          (await store.auditEntries(query)).items.map((e) => e.id);
        expect(await ids({ action: "search", limit: 10 })).toEqual([1]);
        expect(await ids({ channel: "a", limit: 10 })).toEqual([2]);
        expect(await ids({ messageId: 7, limit: 10 })).toEqual([2]);
        expect(await ids({ since: "2026-11-07T12:01:00.000Z", limit: 10 })).toEqual([3]);
        expect(await ids({ until: "2026-11-07T12:01:00.000Z", limit: 10 })).toEqual([2, 1]);
        await store.close();
      });
    });
  });
}

describe("the audit log, in the source and on SQLite", () => {
  it("has no way to change or remove an entry: the store appends and reads, and nothing else touches the table", async () => {
    const auditMethods = Object.getOwnPropertyNames(Store.prototype).filter((name) =>
      /audit/i.test(name),
    );
    // The two on MessageStore, and the private insert behind appendAudit.
    expect(auditMethods.sort()).toEqual([
      "appendAudit",
      "auditEntries",
      "insertAudit",
      "insertAuditRow",
    ]);

    // No source file updates, deletes, alters or drops the table, through Kysely or in raw SQL.
    const sources = await sourceFiles(join(import.meta.dirname, "..", "src"));
    const forbidden =
      /(updateTable|deleteFrom|alterTable|dropTable)\(\s*["']audit_log["']|(update|delete\s+from|alter\s+table|drop\s+table|truncate)\s+["'`]?audit_log/i;
    for (const bad of [
      'db.deleteFrom("audit_log")',
      "tx.updateTable('audit_log')",
      "DELETE FROM audit_log",
      "drop table audit_log",
    ]) {
      expect(forbidden.test(bad), bad).toBe(true);
    }
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      expect(forbidden.test(await readFile(file, "utf8")), file).toBe(false);
    }
  });

  it("is created by migration 0003 on a database from before it, which keeps its messages", async () => {
    const root = await makeProject({});
    const file = join(root, "old.db");
    const old = new SqliteDatabase(file);
    old.exec(`
      CREATE TABLE messages (id integer primary key autoincrement, channel text not null,
        received_at text not null, body blob not null, status text not null, error text,
        updated_at text not null, dedup_key text, duplicate_of integer);
      CREATE TABLE deliveries (id integer primary key autoincrement, message_id integer not null
        references messages (id), channel text not null, destination integer not null,
        seq integer not null, body blob not null, status text not null, attempts integer not null,
        next_attempt_at integer not null, last_error text, delivered_at text);
      CREATE TABLE kysely_migration (name varchar(255) not null primary key, timestamp varchar(255) not null);
      INSERT INTO kysely_migration VALUES ('0001-messages-and-deliveries', '2026-11-07T00:00:00.000Z');
      INSERT INTO kysely_migration VALUES ('0002-possible-duplicates', '2026-11-07T00:00:00.000Z');
      INSERT INTO messages (channel, received_at, body, status, error, updated_at)
        VALUES ('a', '2026-11-07T00:00:00.000Z', x'00', 'transformed', NULL, '2026-11-07T00:00:00.000Z');
      INSERT INTO deliveries (message_id, channel, destination, seq, body, status, attempts, next_attempt_at)
        VALUES (1, 'a', 0, 0, x'01', 'failed', 1, 0);
    `);
    old.close();

    const store = await Store.open(file);
    expect(await store.message(1)).toMatchObject({
      size: null,
      generation: 0,
      state: "failed",
      deliveries: { failed: 1 },
    });
    expect(await store.clear(1, "tester")).toMatchObject({ done: true, deliveries: 1 });
    expect((await store.auditEntries({ limit: 5 })).items).toHaveLength(1);
    await store.close();
  });
});

describe("opening a database", () => {
  it("refuses one whose migrations this version does not know, and leaves it as it was", async () => {
    const { store, file = "" } = await openStore();
    await store.close();
    const sqlite = new SqliteDatabase(file);
    sqlite.exec("INSERT INTO kysely_migration VALUES ('9999-from-a-newer-version', '2027-01-01')");
    sqlite.close();
    await expect(Store.open(file)).rejects.toThrow(
      "the database schema could not be brought up to date",
    );
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}
