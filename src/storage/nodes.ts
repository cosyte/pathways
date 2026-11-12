// The node table's names and types, apart from the store so the package entry can export them
// without the database code. See `MessageStore`'s node methods in store.ts.

/**
 * Every role a node row can hold:
 *
 * - `single`: an engine on a store without leases, the only one.
 * - `standby`: waiting for the engine lease another node holds.
 * - `active`: holding the engine lease, or about to take it.
 * - `proving`: reserved for a node that checks it can take over before it does; nothing sets it yet.
 * - `draining`: told to stop, and closing its sources.
 * - `fenced`: it lost the engine lease and is stopping.
 *
 * @example
 * ```ts
 * NODE_ROLES.includes("standby"); // true
 * ```
 */
export const NODE_ROLES = ["single", "standby", "active", "proving", "draining", "fenced"] as const;

/**
 * One of {@link NODE_ROLES}.
 *
 * @example
 * ```ts
 * const role: NodeRole = "active";
 * ```
 */
export type NodeRole = (typeof NODE_ROLES)[number];

/**
 * Which process a node row belongs to: its node id, host name and process id. A heartbeat or a
 * leave changes the row only while it still names all three, so an earlier process that ran under
 * the same id cannot touch the row of the one that replaced it.
 *
 * @example
 * ```ts
 * const self: NodeSelf = { node: "engine-a", host: "host-a", pid: 4242 };
 * ```
 */
export interface NodeSelf {
  readonly node: string;
  readonly host: string;
  readonly pid: number;
}

/**
 * What a heartbeat writes beside the database's time: the node's role and its draining flag.
 *
 * @example
 * ```ts
 * const state: NodeState = { role: "active", draining: false };
 * ```
 */
export interface NodeState {
  readonly role: NodeRole;
  readonly draining: boolean;
}

/**
 * Everything a node writes when it joins: who it is, which Pathways and schema generation it runs,
 * where it stands, and how long after its last heartbeat it counts as stale. Ids, a host name,
 * numbers and states only: never content, a path or a URL.
 *
 * @example
 * ```ts
 * const info: NodeInfo = {
 *   node: "engine-a", host: "host-a", pid: 4242, version: "0.0.2", schemaGeneration: 11,
 *   role: "active", draining: false, staleAfterMs: 15_000,
 * };
 * ```
 */
export interface NodeInfo extends NodeSelf, NodeState {
  /** The version of `@cosyte/pathways` the node runs. */
  readonly version: string;
  /** The schema generation that version brings a built-in store to; null for a custom store. */
  readonly schemaGeneration: number | null;
  /** How long after its last heartbeat the node counts as stale, in milliseconds. */
  readonly staleAfterMs: number;
}

/**
 * A node row as read, by the database's clock: its info, when it joined, how long ago its last
 * heartbeat was, and whether that is longer ago than its own stale bound.
 *
 * @example
 * ```ts
 * const alive = (row: NodeRow): boolean => !row.stale;
 * ```
 */
export interface NodeRow extends NodeInfo {
  /** When the node joined, as an ISO 8601 time in UTC. */
  readonly startedAt: string;
  /** How long ago the last heartbeat was, in milliseconds, by the database's clock. */
  readonly heartbeatAgeMs: number;
  /** True once the last heartbeat is older than `staleAfterMs`. */
  readonly stale: boolean;
}

/**
 * What {@link MessageStore.joinNode} answers: joined, or the live row that holds the id.
 *
 * @example
 * ```ts
 * const join = await store.joinNode(info);
 * if (!join.joined) console.error(join.holder.host);
 * ```
 */
export type NodeJoin =
  { readonly joined: true } | { readonly joined: false; readonly holder: NodeRow };
