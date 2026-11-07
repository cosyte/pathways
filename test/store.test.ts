import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import SqliteDatabase from "better-sqlite3";

import { Store } from "../src/storage/store.js";
import { cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array): string => new TextDecoder().decode(body);

async function openStore(): Promise<{ store: Store; file: string }> {
  const root = await makeProject({});
  const file = join(root, "nested/folder/pathways.db");
  return { store: await Store.open(file, () => new Date("2026-11-07T12:00:00.000Z")), file };
}

describe("Store", () => {
  it("hands messages to the transform oldest first, per channel", async () => {
    const { store } = await openStore();
    const { id: first } = await store.receive("a", bytes("one"));
    await store.receive("b", bytes("other channel"));
    await store.receive("a", bytes("two"));
    const next = await store.nextToTransform("a");
    expect(next?.id).toBe(first);
    expect(text(next?.body ?? new Uint8Array())).toBe("one");
    await store.close();
  });

  it("queues each output for each destination, in order, and moves the message along", async () => {
    const { store } = await openStore();
    const { id } = await store.receive("a", bytes("in"));
    await store.completeTransform(id, [bytes("out-1"), bytes("out-2")], 2);
    expect(await store.nextToTransform("a")).toBeUndefined();
    expect(await store.messageCounts("a")).toEqual({
      received: 0,
      transformed: 1,
      filtered: 0,
      failed: 0,
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
    expect(await store.deliveryCounts("a")).toEqual({ pending: 0, delivered: 4, failed: 0 });
    await store.close();
  });

  it("marks a message with no outputs filtered, and a failed one failed", async () => {
    const { store } = await openStore();
    const { id: filtered } = await store.receive("a", bytes("x"));
    const { id: failed } = await store.receive("a", bytes("y"));
    await store.completeTransform(filtered, [], 1);
    await store.failTransform(failed, "transform: TypeError: boom");
    expect(await store.messageCounts("a")).toEqual({
      received: 0,
      transformed: 0,
      filtered: 1,
      failed: 1,
    });
    expect(await store.nextDelivery("a", 0)).toBeUndefined();
    await store.close();
  });

  it("records retries, and lets a destination move past a delivery that failed for good", async () => {
    const { store } = await openStore();
    const { id } = await store.receive("a", bytes("in"));
    await store.completeTransform(id, [bytes("1"), bytes("2")], 1);
    const first = await store.nextDelivery("a", 0);
    await store.scheduleRetry(first?.id ?? -1, 1, 5_000, "delivery: EACCES");
    expect(await store.nextDelivery("a", 0)).toMatchObject({
      id: first?.id,
      attempts: 1,
      nextAttemptAt: 5_000,
    });
    await store.failDelivery(first?.id ?? -1, "rejected: AE");
    expect((await store.nextDelivery("a", 0))?.seq).toBe(1);
    expect(await store.deliveryCounts("a")).toEqual({ pending: 1, delivered: 0, failed: 1 });
    await store.close();
  });

  it("keeps everything across a restart, and opens an existing database without migrating it twice", async () => {
    const { store, file } = await openStore();
    const { id } = await store.receive("a", bytes("kept"));
    await store.close();
    const reopened = await Store.open(file);
    expect((await reopened.nextToTransform("a"))?.id).toBe(id);
    await reopened.close();
  });

  it("rolls the whole transform result back when part of it fails", async () => {
    const { store } = await openStore();
    await expect(store.completeTransform(999, [bytes("x")], 1)).rejects.toThrow();
    expect(await store.deliveryCounts("a")).toEqual({ pending: 0, delivered: 0, failed: 0 });
    await store.close();
  });

  it("flags a message whose duplicate key repeats on its channel, pointing at the latest earlier one", async () => {
    const { store } = await openStore();
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
    await store.close();
  });

  it("stores a message as failed, with its reason, when told to, and never hands it to the transform", async () => {
    const { store } = await openStore();
    const { id } = await store.receive("a", bytes("x"), { failure: "inbound: NO_MSH_SEGMENT" });
    expect(await store.message(id)).toEqual({
      id,
      channel: "a",
      status: "failed",
      error: "inbound: NO_MSH_SEGMENT",
      duplicateOf: null,
    });
    expect(await store.nextToTransform("a")).toBeUndefined();
    expect(await store.message(999)).toBeUndefined();
    await store.close();
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
    expect(await store.message(1)).toMatchObject({ status: "received", duplicateOf: null });
    expect(await store.receive("a", bytes("y"), { duplicateKey: "k" })).toEqual({
      id: 2,
      duplicateOf: undefined,
    });
    await store.close();
  });

  it("opens an in-memory database", async () => {
    const store = await Store.open(":memory:");
    expect(await store.receive("a", bytes("x"))).toEqual({ id: 1, duplicateOf: undefined });
    await store.close();
  });

  it("refuses a database file it cannot open", async () => {
    const root = await makeProject({ "a-file": "" });
    await expect(Store.open(join(root, "a-file/inner.db"))).rejects.toThrow();
  });
});
