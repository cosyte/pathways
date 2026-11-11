// The engine lease's names and types, apart from the store so the package entry can export them
// without the database code. See `MessageStore`'s lease methods in store.ts.

/**
 * The name of the lease an engine takes on its database before it opens a source, so a second
 * engine on the same database is refused. The fenced writes check this lease's epoch.
 *
 * @example
 * ```ts
 * const holder = await store.leaseHolder?.(ENGINE_LEASE);
 * ```
 */
export const ENGINE_LEASE = "engine";

/**
 * Who asks for a lease: the node, an id each engine process draws at start, and its host name.
 *
 * @example
 * ```ts
 * const claimant: LeaseClaimant = { node: "3f9a1c2b", host: "engine-a" };
 * ```
 */
export interface LeaseClaimant {
  readonly node: string;
  readonly host: string;
}

/**
 * A lease's last holder, by the database's clock: who took it, when, under which epoch, and how
 * long it has left. `expiresInMs` of 0 or less means it has lapsed or was released, and the next
 * acquisition takes it.
 *
 * @example
 * ```ts
 * const held = (holder: LeaseHolder): boolean => holder.expiresInMs > 0;
 * ```
 */
export interface LeaseHolder {
  readonly node: string;
  readonly host: string;
  /** When it was taken, as an ISO 8601 time in UTC. */
  readonly since: string;
  readonly epoch: number;
  readonly expiresInMs: number;
}

/**
 * What {@link MessageStore.acquireLease} answers: the lease and its new epoch, or the holder that
 * keeps it.
 *
 * @example
 * ```ts
 * const claim = await store.acquireLease(ENGINE_LEASE, claimant, 15_000);
 * if (!claim.acquired) console.error(claim.holder.node);
 * ```
 */
export type LeaseClaim =
  | { readonly acquired: true; readonly epoch: number }
  | { readonly acquired: false; readonly holder: LeaseHolder };

/**
 * A fenced write that changed nothing: the epoch it carried is no longer the engine lease's, so
 * another engine has taken the lease since, or the row it was to change moved under that engine.
 * The engine that sees it stops sending and taking at once and exits (log code `lease-lost`).
 *
 * @example
 * ```ts
 * if (error instanceof LeaseLostError) process.exitCode = 1;
 * ```
 */
export class LeaseLostError extends Error {
  readonly code = "ERR_PATHWAYS_LEASE_LOST";

  constructor() {
    super("the engine lease was lost: another engine holds it now");
    this.name = "LeaseLostError";
  }
}
