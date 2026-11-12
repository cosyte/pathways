// The node table on every database: one row per node id, its times read from the database's clock
// in the statement that writes them, a live id refused to a second node and a stale one taken
// over, one UPDATE per heartbeat, and a stale row forgotten only once it is stale. Two stores here
// are two engines: each has a pool of its own on the same database, and a clock of its own, set
// hours apart.
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import { nodeStore, type NodeInfo, type NodeRow, type Store } from "../src/storage/store.js";
import { available, closeAdmins, dropDatabases, TEST_DATABASES, testStorage } from "./databases.js";
import { cleanUp, makeProject } from "./helpers.js";
import { MemoryStore } from "./memory-store.js";

const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const HOUR = 3_600_000;
const A: NodeInfo = {
  node: "engine-a",
  host: "host-a",
  pid: 1111,
  version: "0.0.2",
  schemaGeneration: 11,
  role: "active",
  draining: false,
  staleAfterMs: 60_000,
};
const B: NodeInfo = {
  node: "engine-b",
  host: "host-b",
  pid: 2222,
  version: "0.0.3-next.1",
  schemaGeneration: null,
  role: "standby",
  draining: false,
  staleAfterMs: 60_000,
};

const self = (info: NodeInfo) => ({ node: info.node, host: info.host, pid: info.pid });

/** Waits until `node`'s row shows stale by the database's clock. */
async function staleOn(store: Store, node: string): Promise<NodeRow> {
  for (;;) {
    const row = (await store.nodes()).find((candidate) => candidate.node === node);
    if (row === undefined) throw new Error(`no row for ${node}`);
    if (row.stale) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

for (const database of TEST_DATABASES) {
  const timeout = database.kind === "sqlite" ? 10_000 : 30_000;
  describe.skipIf(!available(database))(`The node table on ${database.label}`, { timeout }, () => {
    /** Two engines' stores on one fresh database, their node clocks two hours apart. */
    async function twoEngines(): Promise<{ a: Store; b: Store }> {
      const storage = await testStorage(database, join(await makeProject({}), "pathways.db"));
      const a = await storage.open({ now: () => new Date(Date.now() + 2 * HOUR) });
      const b = await storage.open({ now: () => new Date(Date.now() - 2 * HOUR) });
      stores.push(a, b);
      return { a, b };
    }

    it("lists two nodes to each other, aged by the database's clock, their node clocks four hours apart", async () => {
      const { a, b } = await twoEngines();
      expect(await a.nodes()).toEqual([]);
      expect(await a.joinNode(A)).toEqual({ joined: true });
      expect(await b.joinNode(B)).toEqual({ joined: true });
      for (const store of [a, b]) {
        const rows = await store.nodes();
        expect(rows.map((row) => row.node)).toEqual(["engine-a", "engine-b"]);
        expect(rows[0]).toMatchObject({ ...A, stale: false });
        expect(rows[1]).toMatchObject({ ...B, stale: false });
        for (const row of rows) {
          // By the database's clock: a moment ago, whatever either node's clock says.
          expect(row.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
          expect(row.heartbeatAgeMs).toBeLessThan(10_000);
          expect(Math.abs(Date.parse(row.startedAt) - Date.now())).toBeLessThan(60_000);
        }
      }
    });

    it("refuses a live node's id to another, and takes it over from an earlier run it names", async () => {
      const { a, b } = await twoEngines();
      await a.joinNode(A);
      const again = { ...A, pid: 3333 };
      const refused = await b.joinNode(again);
      expect(refused).toMatchObject({ joined: false, holder: { node: "engine-a", pid: 1111 } });
      // A replacement names the run it replaces: another process's row is not taken.
      expect(await b.joinNode(again, { ...self(A), pid: 9999 })).toMatchObject({ joined: false });
      expect(await b.joinNode(again, self(A))).toEqual({ joined: true });
      expect((await a.nodes())[0]).toMatchObject({ node: "engine-a", pid: 3333 });
      // The run it replaced can no longer beat or remove the row.
      expect(await a.nodeHeartbeat(self(A), { role: "active", draining: false })).toBe(false);
      expect(await a.leaveNode(self(A))).toBe(false);
      expect(await b.nodes()).toHaveLength(1);
    });

    it("takes over a stale node's id, and forgets a stale row only", async () => {
      const { a, b } = await twoEngines();
      const short = { ...A, staleAfterMs: 300 };
      await a.joinNode(short);
      expect(await b.forgetNode("engine-a")).toBe(false);
      expect(await b.forgetNode("engine-z")).toBe(false);
      const stale = await staleOn(b, "engine-a");
      expect(stale.heartbeatAgeMs).toBeGreaterThanOrEqual(300);
      // Another process may run under the id once it is stale.
      expect(await b.joinNode({ ...short, pid: 4444 })).toEqual({ joined: true });
      expect((await a.nodes())[0]).toMatchObject({ pid: 4444, stale: false });
      await staleOn(a, "engine-a");
      expect(await a.forgetNode("engine-a")).toBe(true);
      expect(await b.nodes()).toEqual([]);
    });

    it("beats in one UPDATE from the database's clock, with the role and draining flag", async () => {
      const { a, b } = await twoEngines();
      await a.joinNode({ ...A, role: "standby", staleAfterMs: 300 });
      await staleOn(b, "engine-a");
      expect(await a.nodeHeartbeat(self(A), { role: "draining", draining: true })).toBe(true);
      const [row] = await b.nodes();
      expect(row).toMatchObject({ role: "draining", draining: true, stale: false });
      expect(row?.heartbeatAgeMs).toBeLessThan(300);
      // Another process's beat under the same id changes nothing.
      expect(await b.nodeHeartbeat({ ...self(A), pid: 5555 }, A)).toBe(false);
      expect(await b.leaveNode({ ...self(A), host: "host-z" })).toBe(false);
      expect(await a.leaveNode(self(A))).toBe(true);
      expect(await b.nodes()).toEqual([]);
    });

    it("passes the node methods through an encrypted store", async () => {
      const { a } = await twoEngines();
      const wrapped = new EncryptedStore(
        a,
        new LocalKeyProvider([["test", randomBytes(KEY_BYTES)]], "test"),
      );
      const nodes = nodeStore(wrapped);
      expect(nodes).toBeDefined();
      expect(await nodes?.joinNode(A)).toEqual({ joined: true });
      expect(await nodes?.nodeHeartbeat(self(A), A)).toBe(true);
      expect((await nodes?.nodes())?.map((row) => row.node)).toEqual(["engine-a"]);
      expect(await nodes?.forgetNode("engine-a")).toBe(false);
      expect(await nodes?.leaveNode(self(A))).toBe(true);
    });
  });
}

describe("A custom store without the node methods", () => {
  it("has none, wrapped or not", () => {
    const memory = new MemoryStore();
    expect(nodeStore(memory)).toBeUndefined();
    expect(nodeStore(new UnencryptedStore(memory))).toBeUndefined();
  });
});
