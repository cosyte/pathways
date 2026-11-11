import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ENGINE_LEASE,
  LeaseLostError,
  type LeaseClaim,
  type LeaseClaimant,
  type LeaseHolder,
  type LeaseStore,
} from "../storage/store.js";

/**
 * Why an engine stopped holding its lease: a renewal the database refused (the lease lapsed or was
 * freed by force), a renewal that failed (the database could not be reached), a renewal later
 * than the lease lasts by the holder's own monotonic clock (the process was paused), or a fenced
 * write that changed nothing (another engine took the lease).
 */
export type LeaseLossReason =
  "renewal-refused" | "renewal-failed" | "renewal-late" | "write-refused";

/**
 * The {@link LeaseLostError} {@link EngineLease.check} throws: the lease was found lost before a
 * write, for `reason`, rather than refused by one.
 *
 * @example
 * ```ts
 * if (error instanceof LeaseCheckFailed) console.error(error.reason);
 * ```
 */
export class LeaseCheckFailed extends LeaseLostError {
  readonly reason: LeaseLossReason;

  /** @param reason Why the lease was lost. */
  constructor(reason: LeaseLossReason) {
    super();
    this.reason = reason;
  }
}

/**
 * What the engine needs from a lease: the epoch its writes carry, and a check before each send and
 * each message it takes, which throws a {@link LeaseLostError} once the lease is lost.
 *
 * @example
 * ```ts
 * fence.check();
 * await store.markDelivered(delivery.id, fence.epoch);
 * ```
 */
export interface EngineFence {
  readonly epoch: number | undefined;
  check(): void;
}

/** What an {@link EngineLease} runs on. */
export interface EngineLeaseOptions {
  readonly store: LeaseStore;
  /** How long the lease lasts unless renewed, in milliseconds; it is renewed every third of it. */
  readonly ttlMs: number;
  /** Who asks: by default a fresh node id and this host's name. */
  readonly claimant?: LeaseClaimant;
  /** The holder's monotonic clock, in milliseconds. Tests pass their own. */
  readonly monotonic?: () => number;
  /** Told once, when the lease is lost while held. */
  readonly onLost?: (reason: LeaseLossReason) => void;
}

/**
 * A node id: 8 random bytes in hex, drawn once per process, so two engines on one host differ.
 *
 * @example
 * ```ts
 * nodeId(); // "3f9a1c2b7d4e5f60"
 * ```
 */
export function nodeId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * The engine lease, as one engine process holds it: taken before any source opens, renewed every
 * third of its time to live, and given up at a clean stop. Expiry is the database's to judge, in
 * the statement that takes or renews it; this process judges only its own lateness, by its
 * monotonic clock, which no clock change moves. Once a renewal is refused, fails, or comes later
 * than the lease lasts, the lease is lost: {@link check} throws from then on, and `onLost` is told.
 *
 * @example
 * ```ts
 * const lease = new EngineLease({ store, ttlMs: 15_000, onLost: (reason) => abort(reason) });
 * const claim = await lease.acquire();
 * if (!claim.acquired) console.error(describeHolder(claim.holder));
 * ```
 */
export class EngineLease implements EngineFence {
  readonly claimant: LeaseClaimant;
  private readonly options: EngineLeaseOptions;
  private readonly monotonic: () => number;
  private held: number | undefined;
  private lost: LeaseLossReason | undefined;
  /** When the last renewal that the database took was sent, by the monotonic clock. */
  private renewedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private renewing = false;

  /** @param options The store, the time to live, and for tests a claimant and a clock. */
  constructor(options: EngineLeaseOptions) {
    this.options = options;
    this.claimant = options.claimant ?? { node: nodeId(), host: hostname() };
    this.monotonic = options.monotonic ?? (() => performance.now());
  }

  /** The epoch the engine's writes carry while it holds the lease. */
  get epoch(): number | undefined {
    return this.held;
  }

  /** How often the holder renews, and a standby asks again: a third of the time to live. */
  get renewEveryMs(): number {
    return Math.max(1, Math.floor(this.options.ttlMs / 3));
  }

  /** Asks for the lease once; when it is taken, starts renewing it. */
  async acquire(): Promise<LeaseClaim> {
    const sent = this.monotonic();
    const claim = await this.options.store.acquireLease(
      ENGINE_LEASE,
      this.claimant,
      this.options.ttlMs,
    );
    if (claim.acquired) {
      this.held = claim.epoch;
      this.renewedAt = sent;
      const { epoch } = claim;
      this.timer = setInterval(() => void this.renew(epoch), this.renewEveryMs);
      this.timer.unref();
    }
    return claim;
  }

  /**
   * For a standby: asks for the lease every renewal interval until it is taken, or `signal` aborts.
   * `onWaiting` is told the holder on the first refusal. Resolves true when the lease is held.
   */
  async waitFor(signal: AbortSignal, onWaiting: (holder: LeaseHolder) => void): Promise<boolean> {
    let told = false;
    while (!signal.aborted) {
      const claim = await this.acquire();
      if (claim.acquired) return true;
      if (!told) onWaiting(claim.holder);
      told = true;
      await sleep(this.renewEveryMs, undefined, { signal }).catch(() => undefined);
    }
    return false;
  }

  /**
   * Throws a {@link LeaseLostError} when the lease is lost, or when the last renewal the database
   * took was sent longer ago than the lease lasts: this process was paused, and another engine may
   * hold the lease now.
   */
  check(): void {
    if (this.held === undefined) return;
    if (this.lost === undefined && this.monotonic() - this.renewedAt > this.options.ttlMs) {
      this.lose("renewal-late");
    }
    if (this.lost !== undefined) throw new LeaseCheckFailed(this.lost);
  }

  /** Records that a fenced write changed nothing: the lease is lost. */
  writeRefused(): void {
    if (this.held !== undefined && this.lost === undefined) this.lose("write-refused");
  }

  /** Why the lease was lost, or `undefined` while it is held or was never taken. */
  get lossReason(): LeaseLossReason | undefined {
    return this.lost;
  }

  /** Stops renewing and, unless it was lost, frees the lease so the next engine takes it at once. */
  async release(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    const epoch = this.held;
    if (epoch === undefined || this.lost !== undefined) return;
    this.held = undefined;
    await this.options.store.releaseLease(ENGINE_LEASE, epoch);
  }

  private async renew(epoch: number): Promise<void> {
    if (this.lost !== undefined || this.renewing) return;
    const sent = this.monotonic();
    if (sent - this.renewedAt > this.options.ttlMs) {
      this.lose("renewal-late");
      return;
    }
    this.renewing = true;
    try {
      const renewed = await this.options.store.renewLease(ENGINE_LEASE, epoch, this.options.ttlMs);
      if (this.lost !== undefined) return;
      if (renewed) this.renewedAt = sent;
      else this.lose("renewal-refused");
    } catch {
      this.lose("renewal-failed");
    } finally {
      this.renewing = false;
    }
  }

  private lose(reason: LeaseLossReason): void {
    if (this.lost !== undefined) return;
    this.lost = reason;
    clearInterval(this.timer);
    this.timer = undefined;
    this.options.onLost?.(reason);
  }
}

/**
 * The holder in a refusal or in `pathways lease status`: its node, host, since when, epoch, and
 * time left. Never a URL, a path or anything stored.
 *
 * @example
 * ```ts
 * describeHolder(holder); // "node 3f9a1c2b7d4e5f60 on host engine-a, since 2026-11-11T04:00:00.000Z, epoch 3, 12.4s left"
 * ```
 */
export function describeHolder(holder: LeaseHolder): string {
  const left =
    holder.expiresInMs > 0 ? `${(holder.expiresInMs / 1_000).toFixed(1)}s left` : "lapsed";
  return `node ${holder.node} on host ${holder.host}, since ${holder.since}, epoch ${String(holder.epoch)}, ${left}`;
}
