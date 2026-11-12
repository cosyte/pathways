// The engine lease in storage, on every database: one row whose epoch rises on each acquisition,
// expiry judged by the database's clock in the statement that changes it, and the engine's writes
// fenced by the epoch in the same statement. Two stores here are two engines: each has a pool of its
// own on the same database, and a clock of its own, set hours apart.
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import {
  ENGINE_LEASE,
  leaseStore,
  LeaseLostError,
  type LeaseClaimant,
  type Store,
} from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestStorage,
} from "./databases.js";
import { cleanUp, makeProject } from "./helpers.js";
import { MemoryStore } from "./memory-store.js";

const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const HOUR = 3_600_000;
const A: LeaseClaimant = { node: "aaaa0000aaaa0000", host: "engine-a" };
const B: LeaseClaimant = { node: "bbbb0000bbbb0000", host: "engine-b" };

/** Waits until the engine lease has lapsed by the database's clock. */
async function lapsed(store: Store): Promise<void> {
  for (;;) {
    const holder = await store.leaseHolder(ENGINE_LEASE);
    if (holder === undefined || holder.expiresInMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(holder.expiresInMs + 5, 200)));
  }
}

for (const database of TEST_DATABASES) {
  const timeout = database.kind === "sqlite" ? 10_000 : 30_000;
  describe.skipIf(!available(database))(
    `The engine lease on ${database.label}`,
    { timeout },
    () => {
      /** Two engines' stores on one fresh database, their node clocks two hours apart. */
      async function twoEngines(): Promise<{ a: Store; b: Store; storage: TestStorage }> {
        const storage = await testStorage(database, join(await makeProject({}), "pathways.db"));
        const a = await storage.open({ now: () => new Date(Date.now() + HOUR) });
        const b = await storage.open({ now: () => new Date(Date.now() - HOUR) });
        stores.push(a, b);
        return { a, b, storage };
      }

      it("goes to one of two engines asking at once; the other is told the holder", async () => {
        const { a, b } = await twoEngines();
        expect(await a.leaseHolder(ENGINE_LEASE)).toBeUndefined();
        const claims = await Promise.all([
          a.acquireLease(ENGINE_LEASE, A, 60_000),
          b.acquireLease(ENGINE_LEASE, B, 60_000),
        ]);
        const won = claims.filter((claim) => claim.acquired);
        const lost = claims.flatMap((claim) => (claim.acquired ? [] : [claim.holder]));
        expect(won).toEqual([{ acquired: true, epoch: 1 }]);
        expect(lost).toHaveLength(1);
        const winner = claims[0]?.acquired === true ? A : B;
        expect(lost[0]).toMatchObject({ ...winner, epoch: 1 });
        expect(lost[0]?.expiresInMs).toBeGreaterThan(55_000);
        expect(lost[0]?.expiresInMs).toBeLessThanOrEqual(60_000);
        // Since when, by the database's clock: within a minute of now, whatever the nodes' clocks say.
        expect(Math.abs(Date.parse(lost[0]?.since ?? "") - Date.now())).toBeLessThan(60_000);
      });

      it("lapses by the database's clock, not a node's, and the next acquisition raises the epoch", async () => {
        const { a, b } = await twoEngines();
        expect(await a.acquireLease(ENGINE_LEASE, A, 1_000)).toEqual({ acquired: true, epoch: 1 });
        // b's clock is two hours behind a's: neither clock decides, so b is refused until it lapses.
        const refused = await b.acquireLease(ENGINE_LEASE, B, 1_000);
        expect(refused).toMatchObject({ acquired: false, holder: { ...A, epoch: 1 } });
        await lapsed(b);
        expect(await a.renewLease(ENGINE_LEASE, 1, 1_000)).toBe(false);
        expect(await b.acquireLease(ENGINE_LEASE, B, 60_000)).toEqual({ acquired: true, epoch: 2 });
        expect(await a.acquireLease(ENGINE_LEASE, A, 60_000)).toMatchObject({
          acquired: false,
          holder: { ...B, epoch: 2 },
        });
      });

      it("renews only under its epoch, and is released under its epoch or by force", async () => {
        const { a, b } = await twoEngines();
        await a.acquireLease(ENGINE_LEASE, A, 2_000);
        expect(await a.renewLease(ENGINE_LEASE, 2, 60_000)).toBe(false);
        expect(await a.renewLease(ENGINE_LEASE, 1, 60_000)).toBe(true);
        expect((await b.leaseHolder(ENGINE_LEASE))?.expiresInMs).toBeGreaterThan(50_000);
        expect(await a.releaseLease(ENGINE_LEASE, 2)).toBe(false);
        expect(await a.releaseLease(ENGINE_LEASE, 1)).toBe(true);
        expect((await b.leaseHolder(ENGINE_LEASE))?.expiresInMs).toBeLessThanOrEqual(0);
        // Freed: taken at once, the epoch raised; then freed by force, whoever holds it.
        expect(await b.acquireLease(ENGINE_LEASE, B, 60_000)).toEqual({ acquired: true, epoch: 2 });
        expect(await a.releaseLease(ENGINE_LEASE)).toBe(true);
        expect(await b.renewLease(ENGINE_LEASE, 2, 60_000)).toBe(false);
        expect(await a.acquireLease(ENGINE_LEASE, A, 60_000)).toEqual({ acquired: true, epoch: 3 });
        // A lease never taken has nothing to release.
        expect(await a.releaseLease("another")).toBe(false);
        expect(await a.leaseHolder("another")).toBeUndefined();
      });

      it("fences each engine write by the epoch: under a stale one, each changes nothing", async () => {
        const { a, b } = await twoEngines();
        await a.acquireLease(ENGINE_LEASE, A, 60_000);
        const first = (await a.receive("adt", bytes("one"))).id;
        const second = (await a.receive("adt", bytes("two"))).id;
        await a.completeTransform(first, [bytes("out")], 1, 1);
        const delivery = (await a.nextDelivery("adt", 0))?.id ?? 0;
        await a.markSending(delivery, { attempt: 1, at: Date.now() }, 1);

        // b takes the lease from a: a's writes under epoch 1 now change nothing.
        await b.releaseLease(ENGINE_LEASE);
        expect(await b.acquireLease(ENGINE_LEASE, B, 60_000)).toEqual({ acquired: true, epoch: 2 });
        const stale = [
          () => a.completeTransform(second, [bytes("out")], 1, 1),
          () => a.failTransform(second, "transform: Error", 1),
          () => a.markSending(delivery, { attempt: 2, at: Date.now() }, 1),
          () => a.markDelivered(delivery, 1),
          () => a.scheduleRetry(delivery, 1, Date.now() + 1_000, "delivery: ECONNREFUSED", 1),
          () => a.failDelivery(delivery, "rejected: AR", 1),
          () => a.recordWarnings(second, ["ENCODING_MISMATCH"], 1),
        ];
        for (const write of stale) await expect(write()).rejects.toBeInstanceOf(LeaseLostError);
        expect(await b.message(second)).toMatchObject({ status: "received" });
        expect((await b.message(second))?.warnings).toBeUndefined();
        // Under the lease's epoch the warnings are stored, and an empty list clears them.
        await b.recordWarnings(second, ["ENCODING_MISMATCH"], 2);
        expect((await b.message(second))?.warnings).toEqual(["ENCODING_MISMATCH"]);
        await b.recordWarnings(second, [], 2);
        expect((await b.message(second))?.warnings).toBeUndefined();
        expect(await b.deliveries(second)).toEqual([]);
        expect(await b.deliveries(first)).toMatchObject([
          { id: delivery, status: "pending", attempts: 0 },
        ]);
        expect((await b.nextDelivery("adt", 0))?.sending).toMatchObject({ attempt: 1 });

        // Under the lease's epoch they write; once done, a delivery takes no second outcome.
        await b.markDelivered(delivery, 2);
        await expect(b.markDelivered(delivery, 2)).rejects.toThrow(
          "the engine lease was lost: another engine holds it now",
        );
        await b.completeTransform(second, [], 1, 2);
        await expect(b.failTransform(second, "transform: Error", 2)).rejects.toMatchObject({
          name: "LeaseLostError",
          code: "ERR_PATHWAYS_LEASE_LOST",
        });
        // Without an epoch, a write is unfenced, as for a store without leases.
        await a.failTransform(second, "transform: Error");
        expect(await b.message(second)).toMatchObject({ status: "failed" });
      });

      it("passes through an encryption layer, which keeps the epoch on each write", async () => {
        const { a } = await twoEngines();
        const wrapped = new EncryptedStore(
          a,
          new LocalKeyProvider([["test", randomBytes(KEY_BYTES)]], "test"),
        );
        const leases = leaseStore(wrapped);
        expect(leases).toBeDefined();
        expect(await leases?.acquireLease(ENGINE_LEASE, A, 60_000)).toEqual({
          acquired: true,
          epoch: 1,
        });
        const id = (await wrapped.receive("adt", bytes("one"))).id;
        await wrapped.completeTransform(id, [bytes("x")], 1, 1);
        const delivery = (await wrapped.nextDelivery("adt", 0))?.id ?? 0;
        await expect(
          wrapped.scheduleRetry(delivery, 1, 0, "delivery: E", 2),
        ).rejects.toBeInstanceOf(LeaseLostError);
        await expect(wrapped.failDelivery(delivery, "rejected: AR", 2)).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        const next = (await wrapped.receive("adt", bytes("two"))).id;
        await expect(wrapped.completeTransform(next, [bytes("y")], 1, 2)).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        await expect(wrapped.failTransform(next, "transform: Error", 2)).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        expect(await leases?.renewLease(ENGINE_LEASE, 1, 60_000)).toBe(true);
        expect(await leases?.leaseHolder(ENGINE_LEASE)).toMatchObject({ ...A, epoch: 1 });
        expect(await leases?.releaseLease(ENGINE_LEASE, 1)).toBe(true);
      });
    },
  );
}

describe("A store without the lease methods", () => {
  it("has no lease, wrapped or not", () => {
    const memory = new MemoryStore();
    expect(leaseStore(memory)).toBeUndefined();
    expect(leaseStore(new UnencryptedStore(memory))).toBeUndefined();
  });
});
