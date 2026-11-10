// The store when the database itself fails inside a replay or a clear: the error is thrown as it is,
// never turned into a refusal, and the transaction leaves the message as it was.
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import SqliteDatabase from "better-sqlite3";

import { Store } from "../src/storage/store.js";
import { cleanUp, makeProject } from "./helpers.js";

const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

/** A store holding one failed message, whose audit table another connection then drops. */
async function failedMessageWithoutAuditTable(): Promise<{ store: Store; id: number }> {
  const root = await makeProject({});
  const file = join(root, "pathways.db");
  const store = await Store.open(file);
  stores.push(store);
  const { id } = await store.receive("adt", new TextEncoder().encode("synthetic body"));
  await store.failTransform(id, "transform: TypeError");
  const raw = new SqliteDatabase(file);
  raw.exec("drop table audit_log");
  raw.close();
  return { store, id };
}

describe("Store, when the database fails inside the transaction", () => {
  it("throws a replay's database error, and rolls the replay back", async () => {
    const { store, id } = await failedMessageWithoutAuditTable();
    const replay = store.requeue(
      id,
      {
        mode: "replay",
        expected: "failed",
        outputs: [new TextEncoder().encode("synthetic output")],
        failure: undefined,
        destinations: 1,
      },
      "tester",
    );
    await expect(replay).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    expect(await store.message(id)).toMatchObject({ status: "failed", generation: 0 });
    expect(await store.deliveries(id)).toEqual([]);
  });

  it("throws a clear's database error, and rolls the clear back", async () => {
    const { store, id } = await failedMessageWithoutAuditTable();
    await expect(store.clear(id, "tester")).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    expect(await store.message(id)).toMatchObject({ status: "failed" });
  });
});
