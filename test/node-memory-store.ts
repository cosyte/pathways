// The in-memory store of test/memory-store.ts with the node methods a custom store may add, written
// as a user would add them: one row per node id, every time from one clock (here this process's,
// standing in for a database's). Every store this module makes shares the rows, as engines on one
// database share its table. Given `options.fail`, a method rejects, for the tests of what the
// engine does then.
import type {
  NodeInfo,
  NodeJoin,
  NodeRow,
  NodeSelf,
  NodeState,
  StoreFactory,
} from "../src/index.js";
import { MemoryStore } from "./memory-store.js";

interface Row extends NodeInfo {
  startedAt: number;
  heartbeatAt: number;
}

/** The node rows every store of this module shares, by node id. */
export const nodeRows = new Map<string, Row>();

/** How a store of this module fails. */
interface Failing {
  /** `joinNode` rejects: with an error with a code, or one without. */
  readonly join?: "code" | "plain";
  /** `leaveNode` rejects. */
  readonly leave?: boolean;
}

function rowOf(row: Row, now: number): NodeRow {
  const { startedAt, heartbeatAt, ...info } = row;
  const heartbeatAgeMs = now - heartbeatAt;
  return {
    ...info,
    startedAt: new Date(startedAt).toISOString(),
    heartbeatAgeMs,
    stale: heartbeatAgeMs >= row.staleAfterMs,
  };
}

const named = (row: Row | undefined, self: NodeSelf): row is Row =>
  row !== undefined && row.host === self.host && row.pid === self.pid;

export class NodeMemoryStore extends MemoryStore {
  readonly failing: Failing;

  constructor(options: { fail?: Failing } = {}) {
    super();
    this.failing = options.fail ?? {};
  }

  joinNode(info: NodeInfo, replace?: NodeSelf): Promise<NodeJoin> {
    if (this.failing.join !== undefined) {
      const error = new Error("the database went away");
      if (this.failing.join === "code") Object.assign(error, { code: "ECONNRESET" });
      return Promise.reject(error);
    }
    const now = Date.now();
    const row = nodeRows.get(info.node);
    const free =
      row === undefined ||
      row.heartbeatAt + row.staleAfterMs <= now ||
      (replace !== undefined && named(row, replace));
    if (!free) return Promise.resolve({ joined: false, holder: rowOf(row, now) });
    nodeRows.set(info.node, { ...info, startedAt: now, heartbeatAt: now });
    return Promise.resolve({ joined: true });
  }

  nodeHeartbeat(self: NodeSelf, state: NodeState): Promise<boolean> {
    const row = nodeRows.get(self.node);
    if (!named(row, self)) return Promise.resolve(false);
    Object.assign(row, state, { heartbeatAt: Date.now() });
    return Promise.resolve(true);
  }

  leaveNode(self: NodeSelf): Promise<boolean> {
    if (this.failing.leave === true) {
      return Promise.reject(Object.assign(new Error("gone"), { code: "ECONNRESET" }));
    }
    if (!named(nodeRows.get(self.node), self)) return Promise.resolve(false);
    nodeRows.delete(self.node);
    return Promise.resolve(true);
  }

  nodes(): Promise<NodeRow[]> {
    const now = Date.now();
    return Promise.resolve([...nodeRows.values()].map((row) => rowOf(row, now)));
  }

  forgetNode(node: string): Promise<boolean> {
    const row = nodeRows.get(node);
    if (row === undefined || row.heartbeatAt + row.staleAfterMs > Date.now()) {
      return Promise.resolve(false);
    }
    nodeRows.delete(node);
    return Promise.resolve(true);
  }
}

/** A storage adapter module's default export: `storage: { module: ./node-memory-store.ts }`. */
const nodeMemoryStore = ((options) => new NodeMemoryStore(options)) satisfies StoreFactory;

export default nodeMemoryStore;
