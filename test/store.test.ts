import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    const first = await store.receive("a", bytes("one"));
    await store.receive("b", bytes("other channel"));
    await store.receive("a", bytes("two"));
    const next = await store.nextToTransform("a");
    expect(next?.id).toBe(first);
    expect(text(next?.body ?? new Uint8Array())).toBe("one");
    await store.close();
  });

  it("queues each output for each destination, in order, and moves the message along", async () => {
    const { store } = await openStore();
    const id = await store.receive("a", bytes("in"));
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
    const filtered = await store.receive("a", bytes("x"));
    const failed = await store.receive("a", bytes("y"));
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
    const id = await store.receive("a", bytes("in"));
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
    const id = await store.receive("a", bytes("kept"));
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

  it("opens an in-memory database", async () => {
    const store = await Store.open(":memory:");
    expect(await store.receive("a", bytes("x"))).toBe(1);
    await store.close();
  });

  it("refuses a database file it cannot open", async () => {
    const root = await makeProject({ "a-file": "" });
    await expect(Store.open(join(root, "a-file/inner.db"))).rejects.toThrow();
  });
});
