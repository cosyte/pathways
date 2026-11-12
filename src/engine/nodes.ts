import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import { NODE_ID } from "../config/schema.js";
import type {
  NodeInfo,
  NodeJoin,
  NodeRow,
  NodeSelf,
  NodeState,
  NodeStore,
} from "../storage/store.js";
import { errorCode } from "./engine.js";
import { nodeId } from "./lease.js";
import type { EngineRole, EngineState } from "./probes.js";

/**
 * Where a project keeps the node id it generated, relative to its root: in its state folder,
 * `.pathways/`, beside the SQLite database.
 *
 * @example
 * ```ts
 * join(project.root, NODE_ID_FILE); // "<project>/.pathways/node-id"
 * ```
 */
export const NODE_ID_FILE = ".pathways/node-id";

/**
 * A node id and where it came from: `pathways.yaml` (`config`), the project's state folder
 * (`kept`, read or written there), or generated for this process alone because the state folder
 * could not be written (`unsaved`, with the error's code).
 */
export type ResolvedNodeId =
  | { readonly id: string; readonly from: "config" | "kept" }
  | { readonly id: string; readonly from: "unsaved"; readonly code: string | undefined };

/**
 * This engine's node id: the one `pathways.yaml` sets, else the one kept in the project's
 * `.pathways/node-id`, else a new one, written there (mode 0600, the folder 0700) for the next start.
 * Two starts writing it at once agree on the first one written. A folder that cannot be written
 * gives an id for this process alone, which the caller logs.
 *
 * @example
 * ```ts
 * const { id } = await resolveNodeId(project.root, project.node.id);
 * ```
 */
export async function resolveNodeId(
  root: string,
  configured: string | undefined,
): Promise<ResolvedNodeId> {
  if (configured !== undefined) return { id: configured, from: "config" };
  const file = join(root, NODE_ID_FILE);
  const kept = await readKept(file);
  if (kept !== undefined) return { id: kept, from: "kept" };
  const id = nodeId();
  try {
    await mkdir(join(root, ".pathways"), { recursive: true, mode: 0o700 });
    await writeFile(file, `${id}\n`, { flag: "wx", mode: 0o600 });
    return { id, from: "kept" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Another start wrote it first: take that one, so both name the same node.
    const raced = code === "EEXIST" ? await readKept(file) : undefined;
    if (raced !== undefined) return { id: raced, from: "kept" };
    return { id, from: "unsaved", code };
  }
}

/** The id kept in `file`, or undefined when there is none or it is not a node id. */
async function readKept(file: string): Promise<string | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  const id = text?.trim();
  return id !== undefined && NODE_ID.test(id) ? id : undefined;
}

/**
 * Whether the process `pid` runs on this host. A signal 0 checks without sending one; `EPERM` means
 * it runs under another user.
 *
 * @example
 * ```ts
 * processRuns(process.pid); // true
 * ```
 */
export function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a live row that holds this node's id may be an earlier run of this same node: it names
 * this host, and its process is this one (a container restarted under the same process id) or does
 * not run here. Only may be: two containers can share a host name and a process id, and a process
 * on another host by the same name is not seen here. So the join waits to see such a row miss a
 * heartbeat before it replaces it ({@link silenceFor}); any other live row refuses the start.
 *
 * @example
 * ```ts
 * if (earlierRun(holder, self)) await store.joinNode(info, { ...holder, silentMs: silenceFor(holder) });
 * ```
 */
export function earlierRun(
  holder: NodeSelf,
  self: NodeSelf,
  runs: (pid: number) => boolean = processRuns,
): boolean {
  if (holder.host !== self.host) return false;
  return holder.pid === self.pid || !runs(holder.pid);
}

/**
 * How long a live row's heartbeat must be silent before a join takes it as an earlier run of this
 * node whose process is gone: half its stale bound, one and a half of its heartbeat intervals, so
 * a holder that still runs beats within it, even a little late, and a restarted engine gets in
 * well before the row would show stale.
 *
 * @example
 * ```ts
 * silenceFor(row); // 7_500 for a row stale after 15 s
 * ```
 */
export function silenceFor(row: NodeRow): number {
  return Math.ceil(row.staleAfterMs / 2);
}

/** How much longer than the database says a join waits for a holder to fall silent, in ms. */
const JOIN_MARGIN_MS = 250;

/**
 * A node row in a refusal or in `pathways nodes`: its id, host, process, version, role and how long
 * ago it last beat. Never a URL, a path or anything stored.
 *
 * @example
 * ```ts
 * describeNode(row); // "node engine-a on host host-a, pid 4242, Pathways 0.0.2, active, last heartbeat 1.2s ago"
 * ```
 */
export function describeNode(row: NodeRow): string {
  return `node ${row.node} on host ${row.host}, pid ${String(row.pid)}, Pathways ${row.version}, ${row.role}, last heartbeat ${seconds(row.heartbeatAgeMs)} ago`;
}

/**
 * Milliseconds as seconds with one decimal.
 *
 * @example
 * ```ts
 * seconds(1_234); // "1.2s"
 * ```
 */
export function seconds(ms: number): string {
  return `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * Where an engine stands, as its node row says it: `draining` or `fenced` while it is, else its
 * role (`single`, `standby` or `active`), and the draining flag beside it.
 *
 * @example
 * ```ts
 * nodeStateOf("draining", "active"); // { role: "draining", draining: true }
 * ```
 */
export function nodeStateOf(state: EngineState, role: EngineRole): NodeState {
  return {
    role: state === "draining" || state === "fenced" ? state : role,
    draining: state === "draining",
  };
}

/** What a {@link NodeHeartbeat} tells its caller, for the log: codes and ids only. */
export type NodeEvent =
  | { readonly event: "heartbeat-failed"; readonly code: string | undefined }
  | { readonly event: "node-rejoined" }
  | { readonly event: "node-duplicate"; readonly holder: string; readonly host: string };

/** What a {@link NodeHeartbeat} runs on. */
export interface NodeHeartbeatOptions {
  readonly store: NodeStore;
  /** The node's row as it joins: its role and draining flag are where it stands at the start. */
  readonly info: NodeInfo;
  /** How often it beats, in milliseconds. */
  readonly intervalMs: number;
  /** Where the node stands now, read at each beat. */
  readonly state: () => NodeState;
  /** The node's monotonic clock, in milliseconds. Tests pass their own. */
  readonly monotonic?: () => number;
  /** Waits `ms`, or until `signal` aborts: between beats, and at a join. Tests pass their own. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Told of a failed beat, a row written again, and a row another live node holds. */
  readonly onEvent?: (event: NodeEvent) => void;
  /** Whether a process runs on this host. Tests pass their own. */
  readonly processRuns?: (pid: number) => boolean;
}

/** Waits `ms` without keeping the process up, or until `signal` aborts. */
function unrefWait(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, undefined, { signal, ref: false }).catch(aborted);
}

/** Waits `ms`, keeping the process up, as a start does, or until `signal` aborts. */
function refWait(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, undefined, { signal }).catch(aborted);
}

/** A wait cut short by its signal: it simply ends. */
function aborted(): undefined {
  return undefined;
}

/**
 * One engine's node row: joined at start, beaten once per interval, and removed at a clean stop.
 * Each beat is one UPDATE that takes its time from the database's clock in the same statement; the
 * node never sends a time of its own. The interval is timed by the node's monotonic clock, which no
 * clock change moves, and a beat that comes late (the process was paused) is not made up with a
 * burst: the next one is an interval later. A failed beat is told and the next one tried; a beat
 * that finds the row gone (forgotten while this node was stale) writes it again.
 *
 * @example
 * ```ts
 * const heartbeat = new NodeHeartbeat({ store, info, intervalMs: 5_000, state: () => current });
 * const join = await heartbeat.join();
 * if (join.joined) heartbeat.start();
 * ```
 */
export class NodeHeartbeat {
  private readonly options: NodeHeartbeatOptions;
  private readonly monotonic: () => number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly joinWait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly stopping = new AbortController();
  private loop: Promise<void> | undefined;
  private joined = false;

  /** @param options The store, the node's row, its interval, and for tests a clock. */
  constructor(options: NodeHeartbeatOptions) {
    this.options = options;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.wait = options.wait ?? unrefWait;
    this.joinWait = options.wait ?? refWait;
  }

  /** Who this node is: its id, host and process. */
  get self(): NodeSelf {
    const { node, host, pid } = this.options.info;
    return { node, host, pid };
  }

  /**
   * Writes the node's row. A live row of the same id that may be an earlier run of this node, on
   * this host, is replaced once its heartbeat has been silent for {@link silenceFor} by the
   * database's clock: this waits out the rest of that time, then asks the store to replace the row
   * only if it did not beat meanwhile. A row that beat is another engine that runs, and is the
   * answer, as is any other live row: this node may not run.
   */
  async join(): Promise<NodeJoin> {
    const { store } = this.options;
    const info = { ...this.options.info, ...this.options.state() };
    let join = await store.joinNode(info);
    if (!join.joined && earlierRun(join.holder, this.self, this.options.processRuns)) {
      const { holder } = join;
      const silentMs = silenceFor(holder);
      const left = silentMs - holder.heartbeatAgeMs;
      // A local timer may fire a little early by the database's clock: the margin keeps a crashed
      // holder's row from being asked for before the database counts it silent.
      if (left > 0) await this.joinWait(left + JOIN_MARGIN_MS, this.stopping.signal);
      const replace = { node: holder.node, host: holder.host, pid: holder.pid, silentMs };
      join = await store.joinNode({ ...this.options.info, ...this.options.state() }, replace);
    }
    this.joined = join.joined;
    return join;
  }

  /** Starts beating once per interval, until {@link stop}. */
  start(): void {
    this.loop ??= this.run(this.stopping.signal);
  }

  /** Stops beating, waits for a beat under way, and removes the node's row if it joined. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop;
    if (this.joined) await this.options.store.leaveNode(this.self);
    this.joined = false;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { intervalMs } = this.options;
    let next = this.monotonic() + intervalMs;
    while (!signal.aborted) {
      await this.wait(Math.max(0, next - this.monotonic()), signal);
      if (signal.aborted) return;
      await this.beat();
      const now = this.monotonic();
      next += intervalMs;
      // Late (paused, or a slow database): the next beat is an interval from now, not a burst.
      if (next <= now) next = now + intervalMs;
    }
  }

  /** One beat; a row found gone is written again. */
  private async beat(): Promise<void> {
    const { store, onEvent } = this.options;
    try {
      if (await store.nodeHeartbeat(this.self, this.options.state())) return;
      const join = await store.joinNode({ ...this.options.info, ...this.options.state() });
      this.joined = join.joined;
      if (join.joined) onEvent?.({ event: "node-rejoined" });
      else onEvent?.({ event: "node-duplicate", holder: join.holder.node, host: join.holder.host });
    } catch (error) {
      onEvent?.({ event: "heartbeat-failed", code: errorCode(error) });
    }
  }
}
