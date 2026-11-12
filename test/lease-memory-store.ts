// The in-memory store of test/memory-store.ts with the lease methods a custom store may add, written
// as a user would add them: a lease row per name, its expiry judged by one clock (here this
// process's, standing in for a database's), and each fenced write refused with LeaseLostError when
// the epoch it carries is no longer the lease's. Every store this module makes shares the lease rows,
// as engines on one database share its table, so two `pathways start` runs in one test process
// contend for one lease.
import {
  LeaseLostError,
  type LeaseClaim,
  type LeaseClaimant,
  type LeaseHolder,
  type SendStart,
  type StoreFactory,
} from "../src/index.js";
import { MemoryStore } from "./memory-store.js";

interface LeaseRow {
  node: string;
  host: string;
  epoch: number;
  since: number;
  expiresAt: number;
}

/** The lease rows every store of this module shares, by lease name. */
export const leaseRows = new Map<string, LeaseRow>();

/** The engine lease's row, for a test to read or change behind the engines' backs. */
export function engineLease(): LeaseRow | undefined {
  return leaseRows.get("engine");
}

/** How a store of this module fails, for the tests of what the engine does then. */
interface Failing {
  /** `acquireLease` rejects: with an error with a code, or one without. */
  readonly acquire?: "code" | "plain";
  /** `releaseLease` rejects. */
  readonly release?: boolean;
}

export class LeasedMemoryStore extends MemoryStore {
  readonly failing: Failing;

  constructor(failing: Failing = {}) {
    super();
    this.failing = failing;
  }

  acquireLease(name: string, claimant: LeaseClaimant, ttlMs: number): Promise<LeaseClaim> {
    if (this.failing.acquire !== undefined) {
      const error = new Error("the database went away");
      if (this.failing.acquire === "code") Object.assign(error, { code: "ECONNRESET" });
      return Promise.reject(error);
    }
    const now = Date.now();
    const row = leaseRows.get(name);
    if (row !== undefined && row.expiresAt > now) {
      return Promise.resolve({ acquired: false, holder: holderOf(row, now) });
    }
    const epoch = (row?.epoch ?? 0) + 1;
    leaseRows.set(name, { ...claimant, epoch, since: now, expiresAt: now + ttlMs });
    return Promise.resolve({ acquired: true, epoch });
  }

  renewLease(name: string, epoch: number, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const row = leaseRows.get(name);
    if (row === undefined || row.epoch !== epoch || row.expiresAt <= now) {
      return Promise.resolve(false);
    }
    row.expiresAt = now + ttlMs;
    return Promise.resolve(true);
  }

  releaseLease(name: string, epoch?: number): Promise<boolean> {
    if (this.failing.release === true) {
      return Promise.reject(Object.assign(new Error("gone"), { code: "ECONNRESET" }));
    }
    const row = leaseRows.get(name);
    if (row === undefined || (epoch !== undefined && row.epoch !== epoch)) {
      return Promise.resolve(false);
    }
    row.expiresAt = 0;
    return Promise.resolve(true);
  }

  leaseHolder(name: string): Promise<LeaseHolder | undefined> {
    const row = leaseRows.get(name);
    return Promise.resolve(row === undefined ? undefined : holderOf(row, Date.now()));
  }

  override completeTransform(
    messageId: number,
    outputs: readonly Uint8Array[],
    destinations: number,
    epoch?: number,
    keys?: readonly string[],
  ): Promise<void> {
    fence(epoch);
    return super.completeTransform(messageId, outputs, destinations, undefined, keys);
  }

  override failTransform(messageId: number, error: string, epoch?: number): Promise<void> {
    fence(epoch);
    return super.failTransform(messageId, error);
  }

  override markSending(deliveryId: number, start: SendStart, epoch?: number): Promise<void> {
    fence(epoch);
    return super.markSending(deliveryId, start);
  }

  override markDelivered(deliveryId: number, epoch?: number): Promise<void> {
    fence(epoch);
    return super.markDelivered(deliveryId);
  }

  override markDryRun(deliveryId: number, epoch?: number): Promise<void> {
    fence(epoch);
    return super.markDryRun(deliveryId);
  }

  override scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
    epoch?: number,
  ): Promise<void> {
    fence(epoch);
    return super.scheduleRetry(deliveryId, attempts, nextAttemptAt, error);
  }

  override failDelivery(deliveryId: number, error: string, epoch?: number): Promise<void> {
    fence(epoch);
    return super.failDelivery(deliveryId, error);
  }
}

/** Throws LeaseLostError when `epoch` is given and is no longer the engine lease's. */
function fence(epoch: number | undefined): void {
  if (epoch !== undefined && engineLease()?.epoch !== epoch) throw new LeaseLostError();
}

function holderOf(row: LeaseRow, now: number): LeaseHolder {
  return {
    node: row.node,
    host: row.host,
    since: new Date(row.since).toISOString(),
    epoch: row.epoch,
    expiresInMs: row.expiresAt - now,
  };
}

/** A storage adapter module's default export: `storage: { module: ./lease-memory-store.ts }`. */
const leasedMemoryStore = ((options) => new LeasedMemoryStore(options)) satisfies StoreFactory;

export default leasedMemoryStore;
