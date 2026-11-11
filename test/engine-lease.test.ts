// The engine lease as one process holds it: renewed every third of its time to live, lost when a
// renewal is refused, fails, or comes late by the process's monotonic clock, and given up at a
// clean stop. The store here is a stand-in that answers as told; the databases' own answers are in
// test/lease-store.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeHolder, EngineLease, nodeId, type LeaseLossReason } from "../src/engine/lease.js";
import {
  LeaseLostError,
  type LeaseClaim,
  type LeaseHolder,
  type LeaseStore,
} from "../src/storage/store.js";

afterEach(() => {
  vi.useRealTimers();
});

const HOLDER: LeaseHolder = {
  node: "bbbb0000bbbb0000",
  host: "engine-b",
  since: "2026-11-11T04:00:00.000Z",
  epoch: 3,
  expiresInMs: 12_345,
};

/** A lease store that answers as `answers` says, and records each call. */
function fakeStore(answers: {
  acquire?: () => LeaseClaim;
  renew?: () => boolean | Promise<boolean>;
}): LeaseStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    acquireLease: (name, claimant, ttlMs) => {
      calls.push(`acquire ${name} ${claimant.host} ${String(ttlMs)}`);
      return Promise.resolve(answers.acquire?.() ?? { acquired: true, epoch: 4 });
    },
    renewLease: async (name, epoch, ttlMs) => {
      calls.push(`renew ${name} ${String(epoch)} ${String(ttlMs)}`);
      return (await answers.renew?.()) ?? true;
    },
    releaseLease: (name, epoch) => {
      calls.push(`release ${name} ${String(epoch)}`);
      return Promise.resolve(true);
    },
    leaseHolder: () => Promise.resolve(HOLDER),
  };
}

/** A lease on `store` with a 3-second time to live, a clock a test moves, and the losses it saw. */
function leaseOn(store: LeaseStore): {
  lease: EngineLease;
  clock: { now: number };
  lost: LeaseLossReason[];
} {
  const clock = { now: 1_000 };
  const lost: LeaseLossReason[] = [];
  const lease = new EngineLease({
    store,
    ttlMs: 3_000,
    claimant: { node: "aaaa0000aaaa0000", host: "engine-a" },
    monotonic: () => clock.now,
    onLost: (reason) => lost.push(reason),
  });
  return { lease, clock, lost };
}

describe("An engine lease", () => {
  it("is taken with its epoch, renewed every third of its time to live, and released at a stop", async () => {
    vi.useFakeTimers();
    const store = fakeStore({});
    const { lease, clock, lost } = leaseOn(store);
    expect(lease.epoch).toBeUndefined();
    lease.check(); // nothing held, nothing to lose
    expect(await lease.acquire()).toEqual({ acquired: true, epoch: 4 });
    expect(lease.epoch).toBe(4);
    expect(lease.renewEveryMs).toBe(1_000);
    for (let i = 0; i < 3; i += 1) {
      clock.now += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      lease.check();
    }
    expect(store.calls).toEqual([
      "acquire engine engine-a 3000",
      "renew engine 4 3000",
      "renew engine 4 3000",
      "renew engine 4 3000",
    ]);
    await lease.release();
    expect(store.calls.at(-1)).toBe("release engine 4");
    expect(lease.epoch).toBeUndefined();
    expect(lost).toEqual([]);
  });

  it("is lost when a renewal is refused, and then checks and releases no more", async () => {
    vi.useFakeTimers();
    const store = fakeStore({ renew: () => false });
    const { lease, clock, lost } = leaseOn(store);
    await lease.acquire();
    clock.now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lost).toEqual(["renewal-refused"]);
    expect(lease.lossReason).toBe("renewal-refused");
    expect(() => {
      lease.check();
    }).toThrow(LeaseLostError);
    lease.writeRefused(); // already lost: told once
    await lease.release();
    expect(store.calls.filter((call) => call.startsWith("release"))).toEqual([]);
    expect(lost).toEqual(["renewal-refused"]);
  });

  it("is lost when a renewal fails, and a late answer to one changes nothing", async () => {
    vi.useFakeTimers();
    let answer: (value: boolean) => void = () => undefined;
    let calls = 0;
    const store = fakeStore({
      renew: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
    });
    const { lease, clock, lost } = leaseOn(store);
    await lease.acquire();
    clock.now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lost).toEqual(["renewal-failed"]);

    // A second lease whose renewal answers after it was lost by lateness.
    const second = leaseOn(store);
    await second.lease.acquire();
    second.clock.now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    // Its renewal still waits for an answer: the next tick sends no second one.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.calls.filter((call) => call.startsWith("renew"))).toHaveLength(2);
    second.clock.now += 5_000;
    expect(() => {
      second.lease.check();
    }).toThrow(LeaseLostError);
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.lost).toEqual(["renewal-late"]);
    await second.lease.release();
  });

  it("is lost when a renewal comes later than the lease lasts, as after a pause", async () => {
    vi.useFakeTimers();
    const store = fakeStore({});
    const { lease, clock, lost } = leaseOn(store);
    await lease.acquire();
    // The process was paused: its timer fires late, by the monotonic clock.
    clock.now += 3_500;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lost).toEqual(["renewal-late"]);
    expect(store.calls.filter((call) => call.startsWith("renew"))).toEqual([]);
  });

  it("is lost when a fenced write is refused", async () => {
    const { lease, lost } = leaseOn(fakeStore({}));
    lease.writeRefused(); // not held yet: nothing to lose
    await lease.acquire();
    lease.writeRefused();
    expect(lost).toEqual(["write-refused"]);
    await lease.release();
  });

  it("is refused while another engine holds it, and a standby asks until it is taken", async () => {
    vi.useFakeTimers();
    let refusals = 2;
    const store = fakeStore({
      acquire: () =>
        refusals-- > 0 ? { acquired: false, holder: HOLDER } : { acquired: true, epoch: 4 },
    });
    const { lease } = leaseOn(store);
    const waiting: LeaseHolder[] = [];
    const taken = lease.waitFor(new AbortController().signal, (holder) => waiting.push(holder));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await taken).toBe(true);
    expect(waiting).toEqual([HOLDER]);
    expect(store.calls.filter((call) => call.startsWith("acquire"))).toHaveLength(3);
    await lease.release();
  });

  it("stops a standby's asking when it is stopped", async () => {
    const store = fakeStore({ acquire: () => ({ acquired: false, holder: HOLDER }) });
    const { lease } = leaseOn(store);
    const stop = new AbortController();
    const taken = lease.waitFor(stop.signal, () => {
      stop.abort();
    });
    expect(await taken).toBe(false);
    expect(lease.epoch).toBeUndefined();
    await lease.release();
    expect(store.calls.filter((call) => call.startsWith("release"))).toEqual([]);
  });

  it("draws a node id of its own, and names its holder in plain words", () => {
    expect(nodeId()).toMatch(/^[0-9a-f]{16}$/);
    expect(nodeId()).not.toBe(nodeId());
    const lease = new EngineLease({ store: fakeStore({}), ttlMs: 2 });
    expect(lease.claimant.node).toMatch(/^[0-9a-f]{16}$/);
    expect(lease.renewEveryMs).toBe(1);
    expect(describeHolder(HOLDER)).toBe(
      "node bbbb0000bbbb0000 on host engine-b, since 2026-11-11T04:00:00.000Z, epoch 3, 12.3s left",
    );
    expect(describeHolder({ ...HOLDER, expiresInMs: 0 })).toBe(
      "node bbbb0000bbbb0000 on host engine-b, since 2026-11-11T04:00:00.000Z, epoch 3, lapsed",
    );
  });
});
