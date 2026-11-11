import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import SqliteDatabase from "better-sqlite3";

import { StorageError, Store, type StoredContent } from "../src/storage/store.js";
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
const clock = (): Date => new Date("2026-11-07T12:00:00.000Z");

/** A fresh store on `database`, and a way to open the same database again. */
async function openStore(
  database: TestDatabase,
): Promise<{ store: Store; reopen: () => Promise<Store> }> {
  let open: () => Promise<Store>;
  if (database.kind === "sqlite") {
    const file = join(await makeProject({}), "nested/folder/pathways.db");
    open = () => Store.open(file, { now: clock });
  } else {
    const { storage, env } = await freshDatabase(database);
    open = () => Store.open(storage, { env, now: clock });
  }
  const reopen = async (): Promise<Store> => {
    const store = await open();
    stores.push(store);
    return store;
  };
  return { store: await reopen(), reopen };
}

// The same suite on every database: SQLite always, each server whose URL is in the environment.
for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`Store on ${database.label}`, () => {
    it("hands messages to the transform oldest first, per channel", async () => {
      const { store } = await openStore(database);
      const { id: first } = await store.receive("a", bytes("one"));
      await store.receive("b", bytes("other channel"));
      await store.receive("a", bytes("two"));
      const next = await store.nextToTransform("a");
      expect(next?.id).toBe(first);
      expect(text(next?.body ?? new Uint8Array())).toBe("one");
      await store.close();
    });

    it("queues each output for each destination, in order, and moves the message along", async () => {
      const { store } = await openStore(database);
      const { id } = await store.receive("a", bytes("in"));
      await store.completeTransform(id, [bytes("out-1"), bytes("out-2")], 2);
      expect(await store.nextToTransform("a")).toBeUndefined();
      expect(await store.messageCounts("a")).toEqual({
        received: 0,
        transformed: 1,
        filtered: 0,
        failed: 0,
        cleared: 0,
      });

      for (const destination of [0, 1]) {
        const first = await store.nextDelivery("a", destination);
        expect(first).toMatchObject({ messageId: id, seq: 0, attempts: 0, nextAttemptAt: 0 });
        expect(text(first?.body ?? new Uint8Array())).toBe("out-1");
        await store.markDelivered(first?.id ?? -1);
        const second = await store.nextDelivery("a", destination);
        expect(second?.seq).toBe(1);
        await store.markDelivered(second?.id ?? -1);
        expect(await store.nextDelivery("a", destination)).toBeUndefined();
      }
      expect(await store.deliveryCounts("a")).toEqual({
        pending: 0,
        delivered: 4,
        failed: 0,
        cleared: 0,
      });
      await store.close();
    });

    it("marks a message with no outputs filtered, and a failed one failed", async () => {
      const { store } = await openStore(database);
      const { id: filtered } = await store.receive("a", bytes("x"));
      const { id: failed } = await store.receive("a", bytes("y"));
      await store.completeTransform(filtered, [], 1);
      await store.failTransform(failed, "transform: TypeError: boom");
      expect(await store.messageCounts("a")).toEqual({
        received: 0,
        transformed: 0,
        filtered: 1,
        failed: 1,
        cleared: 0,
      });
      expect(await store.nextDelivery("a", 0)).toBeUndefined();
      await store.close();
    });

    it("records retries at a real clock's time, and lets a destination move past a delivery that failed for good", async () => {
      const { store } = await openStore(database);
      const { id } = await store.receive("a", bytes("in"));
      await store.completeTransform(id, [bytes("1"), bytes("2")], 1);
      const first = await store.nextDelivery("a", 0);
      // Epoch milliseconds are past 2^31: the column must be 64-bit on every database.
      const later = Date.parse("2026-11-07T12:00:05.000Z");
      await store.scheduleRetry(first?.id ?? -1, 1, later, "delivery: EACCES");
      expect(await store.nextDelivery("a", 0)).toMatchObject({
        id: first?.id,
        attempts: 1,
        nextAttemptAt: later,
      });
      expect(await store.retryingDeliveries("a")).toBe(1);
      await store.failDelivery(first?.id ?? -1, "rejected: AE");
      expect((await store.nextDelivery("a", 0))?.seq).toBe(1);
      expect(await store.deliveryCounts("a")).toEqual({
        pending: 1,
        delivered: 0,
        failed: 1,
        cleared: 0,
      });
      expect(await store.retryingDeliveries("a")).toBe(0);
      await store.close();
    });

    it("keeps everything across a restart, and opens an existing database without migrating it twice", async () => {
      const { store, reopen } = await openStore(database);
      const { id } = await store.receive("a", bytes("kept"));
      await store.close();
      const reopened = await reopen();
      expect((await reopened.nextToTransform("a"))?.id).toBe(id);
      await reopened.close();
    });

    it("rolls the whole transform result back when part of it fails", async () => {
      const { store } = await openStore(database);
      await expect(store.completeTransform(999, [bytes("x")], 1)).rejects.toThrow();
      expect(await store.deliveryCounts("a")).toEqual({
        pending: 0,
        delivered: 0,
        failed: 0,
        cleared: 0,
      });
      await store.close();
    });

    it("flags a message whose duplicate key repeats on its channel, pointing at the latest earlier one", async () => {
      const { store } = await openStore(database);
      const first = await store.receive("a", bytes("1"), { duplicateKey: "k" });
      const other = await store.receive("b", bytes("2"), { duplicateKey: "k" });
      const second = await store.receive("a", bytes("3"), { duplicateKey: "k" });
      const third = await store.receive("a", bytes("4"), { duplicateKey: "k" });
      const unkeyed = await store.receive("a", bytes("5"));
      expect([first, other, second, third, unkeyed]).toEqual([
        { id: 1, duplicateOf: undefined },
        { id: 2, duplicateOf: undefined },
        { id: 3, duplicateOf: 1 },
        { id: 4, duplicateOf: 3 },
        { id: 5, duplicateOf: undefined },
      ]);
      // A flagged message is processed like any other.
      expect((await store.nextToTransform("a"))?.id).toBe(1);
      expect(await store.message(4)).toMatchObject({ id: 4, duplicateOf: 3 });
      await store.close();
    });

    it("stores a resumed message once per idempotency key on its channel, returning the first id", async () => {
      const { store, reopen } = await openStore(database);
      const first = await store.receive("a", bytes("1"), { idempotencyKey: "k" });
      // The same key on another channel is another message.
      const other = await store.receive("b", bytes("1"), { idempotencyKey: "k", resumed: true });
      // A restart between storing and acknowledging hands the same message in again, resumed.
      await store.close();
      const restarted = await reopen();
      const again = await restarted.receive("a", bytes("1"), {
        idempotencyKey: "k",
        resumed: true,
      });
      const next = await restarted.receive("a", bytes("2"), {
        idempotencyKey: "k2",
        resumed: true,
      });
      const unkeyed = await restarted.receive("a", bytes("3"), { resumed: true });
      expect([first, other, again, next, unkeyed]).toEqual([
        { id: 1, duplicateOf: undefined },
        { id: 2, duplicateOf: undefined },
        { id: 1, duplicateOf: undefined, alreadyStored: true },
        { id: 4, duplicateOf: undefined },
        { id: 5, duplicateOf: undefined },
      ]);
      expect((await restarted.messageCounts("a")).received).toBe(3);
      expect(
        (await restarted.listMessages({ channel: "a", limit: 10 })).items.map((m) => m.id),
      ).toEqual([5, 4, 1]);
      await restarted.close();
    });

    it("looks an idempotency key up only for a resumed message: one handed in for the first time is stored", async () => {
      const { store } = await openStore(database);
      await store.receive("a", bytes("1"), { idempotencyKey: "k" });
      // Not resumed: the source says it never handed this one in, so the key is not looked up.
      expect(await store.receive("a", bytes("2"), { idempotencyKey: "k" })).toEqual({
        id: 2,
        duplicateOf: undefined,
      });
      expect(await store.receive("a", bytes("3"), { idempotencyKey: "k", resumed: false })).toEqual(
        {
          id: 3,
          duplicateOf: undefined,
        },
      );
      // Resumed, it is the first message stored under the key that comes back.
      expect(await store.receive("a", bytes("1"), { idempotencyKey: "k", resumed: true })).toEqual({
        id: 1,
        duplicateOf: undefined,
        alreadyStored: true,
      });
      expect((await store.messageCounts("a")).received).toBe(3);
      await store.close();
    });

    it("keeps the first message's duplicate flag when an idempotency key repeats with a duplicate key", async () => {
      const { store } = await openStore(database);
      await store.receive("a", bytes("1"), { duplicateKey: "d" });
      const flagged = await store.receive("a", bytes("2"), {
        duplicateKey: "d",
        idempotencyKey: "k",
      });
      const again = await store.receive("a", bytes("2"), {
        duplicateKey: "d",
        idempotencyKey: "k",
        resumed: true,
      });
      expect(flagged).toEqual({ id: 2, duplicateOf: 1 });
      expect(again).toEqual({ id: 2, duplicateOf: 1, alreadyStored: true });
      expect((await store.messageCounts("a")).received).toBe(2);
      await store.close();
    });

    it("stores a message as failed, with its reason, when told to, and never hands it to the transform", async () => {
      const { store } = await openStore(database);
      const { id } = await store.receive("a", bytes("x"), { failure: "inbound: NO_MSH_SEGMENT" });
      expect(await store.message(id)).toEqual({
        id,
        channel: "a",
        status: "failed",
        state: "failed",
        error: "inbound: NO_MSH_SEGMENT",
        receivedAt: "2026-11-07T12:00:00.000Z",
        updatedAt: "2026-11-07T12:00:00.000Z",
        size: 1,
        duplicateOf: null,
        generation: 0,
        deliveries: { pending: 0, retrying: 0, delivered: 0, failed: 0, cleared: 0 },
      });
      expect(await store.nextToTransform("a")).toBeUndefined();
      expect(await store.message(999)).toBeUndefined();
      await store.close();
    });

    it("keeps a body's bytes exactly, whatever they are and however large", async () => {
      const { store } = await openStore(database);
      // 3 MB holding every byte value: past a MySQL blob's 64 KB and any text encoding.
      const body = new Uint8Array(3 * 1_048_576).map((_, index) => index % 256);
      const { id } = await store.receive("a", body);
      const pending = await store.nextToTransform("a");
      expect(Buffer.compare(Buffer.from(pending?.body ?? []), Buffer.from(body))).toBe(0);
      // A view into a larger buffer stores only its own bytes.
      const backing = bytes("xxout-1yy");
      await store.completeTransform(id, [backing.subarray(2, 7)], 1);
      expect(text((await store.nextDelivery("a", 0))?.body ?? new Uint8Array())).toBe("out-1");
      await store.close();
    });

    it("keeps channels apart whose names differ only in case", async () => {
      const { store } = await openStore(database);
      await store.receive("adt", bytes("lower"));
      expect(await store.nextToTransform("ADT")).toBeUndefined();
      const { id } = await store.receive("ADT", bytes("upper"));
      expect((await store.nextToTransform("ADT"))?.id).toBe(id);
      expect((await store.messageCounts("adt")).received).toBe(1);
      await store.close();
    });

    it("replaces content only while it holds exactly what was read, byte for byte", async () => {
      const { store } = await openStore(database);
      const { id } = await store.receive("a", new Uint8Array([1]));
      const [read] = await store.storedContent("messages", 0, 1);
      // Changed meanwhile by a trailing zero byte, which SQL Server's = would ignore.
      expect(
        await store.replaceContent(read as StoredContent, {
          body: new Uint8Array([1, 0]),
          error: null,
        }),
      ).toBe(true);
      expect(
        await store.replaceContent(read as StoredContent, { body: bytes("x"), error: null }),
      ).toBe(false);

      // Changed meanwhile by a trailing space or by case, which MySQL's or SQL Server's = would
      // ignore.
      for (const [before, after] of [
        ["transform: Error", "transform: Error "],
        ["transform: Error", "transform: ERROR"],
      ] as const) {
        await store.failTransform(id, before);
        const [row] = await store.storedContent("messages", 0, 1);
        await store.failTransform(id, after);
        expect(
          await store.replaceContent(row as StoredContent, { body: bytes("x"), error: "e" }),
        ).toBe(false);
        expect((await store.message(id))?.error).toBe(after);
      }
      const [now] = await store.storedContent("messages", 0, 1);
      expect(Array.from(now?.body ?? [])).toEqual([1, 0]);
      await store.close();
    });

    it("keeps a long failure reason whole", async () => {
      const { store } = await openStore(database);
      const { id } = await store.receive("a", bytes("x"));
      const reason = `transform: Error: ${"e".repeat(100_000)}`;
      await store.failTransform(id, reason);
      expect((await store.message(id))?.error).toBe(reason);
      await store.close();
    });
  });
}

/** The schema the first slice wrote at migration 0002, as SQLite records it. */
const FIRST_SLICE_SCHEMA = [
  `CREATE INDEX "deliveries_by_destination_status" on "deliveries" ("channel", "destination", "status", "id")`,
  `CREATE INDEX "messages_by_channel_dedup_key" on "messages" ("channel", "dedup_key", "id")`,
  `CREATE INDEX "messages_by_channel_status" on "messages" ("channel", "status", "id")`,
  `CREATE TABLE "deliveries" ("id" integer primary key autoincrement, "message_id" integer not null references "messages" ("id"), "channel" text not null, "destination" integer not null, "seq" integer not null, "body" blob not null, "status" text not null, "attempts" integer not null, "next_attempt_at" integer not null, "last_error" text, "delivered_at" text)`,
  `CREATE TABLE "kysely_migration" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null)`,
  `CREATE TABLE "kysely_migration_lock" ("id" varchar(255) not null primary key, "is_locked" integer default 0 not null)`,
  `CREATE TABLE "messages" ("id" integer primary key autoincrement, "channel" text not null, "received_at" text not null, "body" blob not null, "status" text not null, "error" text, "updated_at" text not null, "dedup_key" text, "duplicate_of" integer)`,
  `CREATE TABLE sqlite_sequence(name,seq)`,
];

/**
 * The schema today: the first slice's, with the columns of migrations 0003, 0004 and 0005 added to its two
 * tables (SQLite appends them to the recorded statement), and the audit log, the leases, schema_info and three indexes beside
 * them.
 */
const CURRENT_SCHEMA = [
  `CREATE INDEX "audit_log_by_message" on "audit_log" ("message_id", "id")`,
  `CREATE INDEX "deliveries_by_destination_status" on "deliveries" ("channel", "destination", "status", "id")`,
  `CREATE INDEX "deliveries_by_message" on "deliveries" ("message_id", "status")`,
  `CREATE INDEX "messages_by_channel_dedup_key" on "messages" ("channel", "dedup_key", "id")`,
  `CREATE INDEX "messages_by_channel_idempotency_key" on "messages" ("channel", "idempotency_key", "id")`,
  `CREATE INDEX "messages_by_channel_status" on "messages" ("channel", "status", "id")`,
  `CREATE TABLE "audit_log" ("id" integer primary key autoincrement, "at" text not null, "actor" text not null, "action" text not null, "outcome" text not null, "channel" text, "message_id" integer, "detail" text)`,
  `CREATE TABLE "deliveries" ("id" integer primary key autoincrement, "message_id" integer not null references "messages" ("id"), "channel" text not null, "destination" integer not null, "seq" integer not null, "body" blob not null, "status" text not null, "attempts" integer not null, "next_attempt_at" integer not null, "last_error" text, "delivered_at" text, "generation" integer default 0 not null, "sending_at" integer, "sending_attempt" integer, "interrupted_attempt" integer)`,
  `CREATE TABLE "kysely_migration" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null)`,
  `CREATE TABLE "kysely_migration_lock" ("id" varchar(255) not null primary key, "is_locked" integer default 0 not null)`,
  `CREATE TABLE "leases" ("name" text primary key, "owner" text not null, "host" text not null, "epoch" integer not null, "since" integer not null, "expires_at" integer not null)`,
  `CREATE TABLE "messages" ("id" integer primary key autoincrement, "channel" text not null, "received_at" text not null, "body" blob not null, "status" text not null, "error" text, "updated_at" text not null, "dedup_key" text, "duplicate_of" integer, "size" integer, "generation" integer default 0 not null, "idempotency_key" text, "content_hash" text, "content_dropped_at" text)`,
  `CREATE TABLE "schema_info" ("step" text primary key, "generation" integer not null, "tag" text not null, "min_engine" text not null, "applied_by" text not null, "applied_at" text not null)`,
  `CREATE TABLE sqlite_sequence(name,seq)`,
];

function schemaOf(file: string): string[] {
  const db = new SqliteDatabase(file, { readonly: true });
  const rows = db
    .prepare<[], { sql: string }>(
      "select sql from sqlite_master where sql is not null order by type, name",
    )
    .all();
  db.close();
  return rows.map((row) => row.sql);
}

describe("Store on SQLite files the first slice made", () => {
  it("makes a new database as the first slice did, with 0003's, 0004's and 0005's additions, so old and new files are the same", async () => {
    const file = join(await makeProject({}), "new.db");
    await (await Store.open(file)).close();
    expect(schemaOf(file)).toEqual(CURRENT_SCHEMA);
    // 0003, 0004 and 0005 only add: each of the first slice's statements is still there, as it was written.
    for (const statement of FIRST_SLICE_SCHEMA) {
      const table = /^CREATE TABLE "(messages|deliveries)"/.exec(statement);
      const current =
        table === null
          ? statement
          : CURRENT_SCHEMA.find((s) => s.startsWith(`CREATE TABLE "${String(table[1])}"`));
      expect(current?.startsWith(statement.replace(/\)$/, ""))).toBe(true);
    }
  });

  it("opens a database made at migration 0002, keeping its messages, and brings it to 0003, 0004 and 0005 alone", async () => {
    const file = join(await makeProject({}), "at-0002.db");
    const old = new SqliteDatabase(file);
    const statements = FIRST_SLICE_SCHEMA.filter((s) => !s.includes("sqlite_sequence"));
    // Tables before the indexes on them.
    for (const statement of [
      ...statements.filter((s) => s.startsWith("CREATE TABLE")),
      ...statements.filter((s) => s.startsWith("CREATE INDEX")),
    ]) {
      old.exec(statement);
    }
    old.exec(`
      INSERT INTO kysely_migration VALUES ('0001-messages-and-deliveries', '2026-11-07T00:00:00.000Z');
      INSERT INTO kysely_migration VALUES ('0002-possible-duplicates', '2026-11-07T00:00:01.000Z');
      INSERT INTO kysely_migration_lock VALUES ('migration_lock', 0);
      INSERT INTO messages (channel, received_at, body, status, error, updated_at, dedup_key, duplicate_of)
        VALUES ('a', '2026-11-07T00:00:00.000Z', x'00', 'received', NULL, '2026-11-07T00:00:00.000Z', 'k', NULL);
    `);
    old.close();

    const store = await Store.open(file);
    stores.push(store);
    expect(await store.message(1)).toMatchObject({ status: "received", duplicateOf: null });
    expect(await store.receive("a", bytes("y"), { duplicateKey: "k" })).toEqual({
      id: 2,
      duplicateOf: 1,
    });
    await store.completeTransform(1, [bytes("out")], 1);
    expect((await store.nextDelivery("a", 0))?.messageId).toBe(1);
    await store.close();
    expect(schemaOf(file)).toEqual(CURRENT_SCHEMA);
    const db = new SqliteDatabase(file, { readonly: true });
    expect(db.prepare("select name from kysely_migration order by name").pluck().all()).toEqual([
      "0001-messages-and-deliveries",
      "0002-possible-duplicates",
      "0003-operator-and-audit",
      "0004-idempotency-keys",
      "0005-send-markers",
      "0006-leases",
      "0007-schema-info",
      "0008-content-drop",
    ]);
    db.close();
  });

  it("brings a database made before migration 0002 up to date, keeping its messages", async () => {
    const root = await makeProject({});
    const file = join(root, "old.db");
    // The schema and migration record the first slice left behind.
    const old = new SqliteDatabase(file);
    old.exec(`
      CREATE TABLE messages (id integer primary key autoincrement, channel text not null,
        received_at text not null, body blob not null, status text not null, error text,
        updated_at text not null);
      CREATE TABLE deliveries (id integer primary key autoincrement, message_id integer not null
        references messages (id), channel text not null, destination integer not null,
        seq integer not null, body blob not null, status text not null, attempts integer not null,
        next_attempt_at integer not null, last_error text, delivered_at text);
      CREATE TABLE kysely_migration (name varchar(255) not null primary key, timestamp varchar(255) not null);
      INSERT INTO kysely_migration VALUES ('0001-messages-and-deliveries', '2026-11-07T00:00:00.000Z');
      INSERT INTO messages (channel, received_at, body, status, error, updated_at)
        VALUES ('a', '2026-11-07T00:00:00.000Z', x'00', 'received', NULL, '2026-11-07T00:00:00.000Z');
    `);
    old.close();

    const store = await Store.open(file);
    stores.push(store);
    expect(await store.message(1)).toMatchObject({ status: "received", duplicateOf: null });
    expect(await store.receive("a", bytes("y"), { duplicateKey: "k" })).toEqual({
      id: 2,
      duplicateOf: undefined,
    });
    await store.close();
  });

  it("refuses a database whose migrations it does not know, naming no file", async () => {
    const file = join(await makeProject({}), "future.db");
    const future = new SqliteDatabase(file);
    future.exec(`
      CREATE TABLE kysely_migration (name varchar(255) not null primary key, timestamp varchar(255) not null);
      INSERT INTO kysely_migration VALUES ('9999-from-a-later-version', '2026-11-07T00:00:00.000Z');
    `);
    future.close();
    const error: unknown = await Store.open(file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ reason: "schema" });
    expect((error as Error).message).not.toContain(file);
  });

  it("opens an in-memory database", async () => {
    const store = await Store.open(":memory:");
    stores.push(store);
    expect(await store.receive("a", bytes("x"))).toEqual({ id: 1, duplicateOf: undefined });
    await store.close();
  });

  it("refuses a database file it cannot open, with the error's code and not its text", async () => {
    const root = await makeProject({ "a-file": "" });
    const error: unknown = await Store.open(join(root, "a-file/inner.db")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ reason: "open", code: expect.stringMatching(/^E/) as unknown });
    expect((error as Error).message).toBe("the database could not be opened");
  });
});
