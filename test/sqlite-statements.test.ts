// SQLite prepares a statement once per connection: preparing one parses and plans its SQL, which
// cost as much of the engine's busy time as running the queries did. These count what reaches
// better-sqlite3's `prepare`.

import { join } from "node:path";

import SqliteDatabase from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cachedStatements } from "../src/storage/dialects.js";
import { Store } from "../src/storage/store.js";
import { cleanUp, makeProject } from "./helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanUp();
});

/** Counts each SQL text prepared on any better-sqlite3 database from now on. */
function countPrepares(): () => Map<string, number> {
  const spy = vi.spyOn(SqliteDatabase.prototype, "prepare");
  return () => {
    const counts = new Map<string, number>();
    for (const [source] of spy.mock.calls) counts.set(source, (counts.get(source) ?? 0) + 1);
    return counts;
  };
}

describe("SQLite statements", () => {
  it("are prepared once per connection, however often they run", async () => {
    const root = await makeProject({});
    const counts = countPrepares();
    const store = await Store.open(join(root, ".pathways", "pathways.db"));
    try {
      const body = new TextEncoder().encode("synthetic");
      for (let n = 0; n < 20; n++) {
        await store.receive("cache", body);
        const next = await store.nextToTransform("cache");
        if (next === undefined) throw new Error("expected a message");
        await store.completeTransform(next.id, [body], 1);
        const delivery = await store.nextDelivery("cache", 0);
        if (delivery === undefined) throw new Error("expected a delivery");
        await store.markDelivered(delivery.id);
      }
      expect(await store.messageCounts("cache")).toMatchObject({ transformed: 20 });
    } finally {
      await store.close();
    }
    const repeated = [...counts()].filter(([, count]) => count > 1);
    expect(repeated).toEqual([]);
  });

  it("are prepared again while one of them is still being read", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      const statements = cachedStatements(database, 2);
      statements.prepare("create table t (n integer)").run([]);
      statements.prepare("insert into t values (1), (2)").run([]);
      const read = "select n from t order by n";
      const first = statements.prepare(read);
      const seen: unknown[] = [];
      for (const row of first.iterate([])) {
        // The first is still being read, so the same SQL gets a statement of its own.
        const second = statements.prepare(read);
        expect(second).not.toBe(first);
        seen.push(row, second.all([]));
      }
      expect(seen).toEqual([{ n: 1 }, [{ n: 1 }, { n: 2 }], { n: 2 }, [{ n: 1 }, { n: 2 }]]);
      expect(statements.prepare(read)).toBe(first);
    } finally {
      database.close();
    }
  });

  it("keep the most recently used, up to their limit", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      const statements = cachedStatements(database, 2);
      const one = statements.prepare("select 1");
      const two = statements.prepare("select 2");
      expect(statements.prepare("select 1")).toBe(one);
      statements.prepare("select 3");
      // "select 2" was the least recently used, so it went.
      expect(statements.prepare("select 1")).toBe(one);
      expect(statements.prepare("select 2")).not.toBe(two);
    } finally {
      database.close();
    }
  });
});
