// An operator's resend racing the engine's delivery of the same message, on two connections to one
// database, as `pathways replay --resend` runs beside `pathways start`. Each server runs it under
// its own default isolation level, which the store never changes, and the test first asserts that
// level: READ COMMITTED on PostgreSQL and SQL Server, REPEATABLE READ on MySQL and MariaDB. SQLite
// has one writer at a time, which is serializable.
//
// What must hold whatever the interleaving: a resend is refused while the message has a delivery
// pending, even one in the middle of its send; each resend that is recorded queues exactly one new
// delivery per destination, and each is sent once; nothing is left pending; and every attempt is in
// the audit log.
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Kysely, sql } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { DestinationConnector } from "../src/connectors/types.js";
import { Engine } from "../src/engine/engine.js";
import { replayMessages, type ReplayResult } from "../src/operator/actions.js";
import { AuditLog } from "../src/operator/audit.js";
import { dialectFor } from "../src/storage/dialects.js";
import type { RequeueResult, Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
  type TestStorage,
} from "./databases.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

afterEach(async () => {
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Each server's default isolation level, as the server names it, and SQLite's only one. */
const DEFAULT_ISOLATION: Readonly<Record<string, string>> = {
  sqlite: "serializable",
  postgres: "read committed",
  mysql: "REPEATABLE-READ",
  mariadb: "REPEATABLE-READ",
  // sys.dm_exec_sessions' level 2, with READ_COMMITTED_SNAPSHOT off: SQL Server's locking read
  // committed, the default for a new database.
  sqlserver: "read committed, snapshot off",
};

/** The isolation level a new session on `storage` runs under, named as the server names it. */
async function isolation(database: TestDatabase, storage: TestStorage): Promise<string> {
  if (database.kind === "sqlite") return "serializable";
  const db = new Kysely<unknown>({
    dialect: await dialectFor(storage.storage, { env: storage.env }),
  });
  try {
    switch (database.kind) {
      case "postgres": {
        const { rows } = await sql<{
          level: string;
        }>`select current_setting('transaction_isolation') as level`.execute(db);
        return rows[0]?.level ?? "";
      }
      case "mysql": {
        const { rows } = await sql<{
          level: string;
        }>`select @@session.transaction_isolation as level`.execute(db);
        return rows[0]?.level ?? "";
      }
      case "sqlserver": {
        const { rows } = await sql<{ level: number; snapshot: boolean }>`
          select s.transaction_isolation_level as level, d.is_read_committed_snapshot_on as snapshot
          from sys.dm_exec_sessions s join sys.databases d on d.database_id = db_id()
          where s.session_id = @@spid`.execute(db);
        const row = rows[0];
        const level = row?.level === 2 ? "read committed" : `level ${String(row?.level)}`;
        return `${level}, snapshot ${row?.snapshot === true ? "on" : "off"}`;
      }
    }
  } finally {
    await db.destroy();
  }
}

/** How many synthetic notes each test stores. */
const NOTES = 4;

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`A resend racing a delivery on ${database.label}`, () => {
    it("is refused while the delivery is pending, and recorded once each time it is not", async () => {
      const root = await makeProject({
        "channels/notes/channel.yaml":
          "format: text\nsource:\n  file: { dir: ../../data/inbox }\n" +
          "destinations:\n  - file: { dir: ../../data/out }\n",
      });
      const project = await loadProject(root);
      const storage = await testStorage(database, join(root, "pathways.db"));
      expect(await isolation(database, storage)).toBe(DEFAULT_ISOLATION[database.label]);

      // The engine and the operator each on a connection of their own, as two processes are.
      const opened: Store[] = [];
      const open = async (): Promise<Store> => {
        const store = await storage.open();
        opened.push(store);
        return store;
      };
      let engine: Engine | undefined;
      try {
        const engineStore = await open();
        const operatorStore = await open();
        const audit = new AuditLog(operatorStore, { actor: "tester" });
        const context = { project, store: operatorStore, audit, resend: true };
        for (let i = 1; i <= NOTES; i += 1) {
          const { id } = await engineStore.receive("notes", bytes(`synthetic note ${String(i)}`));
          await engineStore.completeTransform(id, [bytes(`synthetic note ${String(i)}`)], 1);
        }
        const ids = Array.from({ length: NOTES }, (_, i) => i + 1);

        // A resend asked for while each first delivery is in the middle of its send: storage
        // refuses it, as the command does before it reaches storage.
        const sends: number[] = [];
        const midSend: RequeueResult[] = [];
        const commandMidSend: ReplayResult[] = [];
        let racing = true;
        let pause = 0;
        const destination: DestinationConnector = {
          async deliver(message) {
            sends.push(message.messageId);
            if (racing) {
              const outputs = [bytes(`synthetic note ${String(message.messageId)}`)];
              midSend.push(
                await operatorStore.requeue(
                  message.messageId,
                  { mode: "resend", expected: "transformed", outputs, destinations: 1 },
                  "tester",
                ),
              );
              commandMidSend.push(...(await replayMessages([message.messageId], context)));
            }
            pause = (pause + 1) % 3;
            if (pause > 0) await sleep(pause);
          },
        };
        engine = new Engine({
          project,
          store: engineStore,
          logger: captureLogger().logger,
          connectors: () => ({ source: {}, destinations: [destination] }),
        });
        await engine.start();
        await engine.tick();
        expect(sends).toEqual(ids);
        expect(midSend.map((result) => (result.done ? "done" : result.reason))).toEqual(
          ids.map(() => "pending"),
        );
        expect(commandMidSend).toEqual(
          ids.map((id) => ({ id, outcome: "refused", reason: "pending" })),
        );
        expect(await engineStore.deliveryCounts("notes")).toMatchObject({
          pending: 0,
          delivered: NOTES,
        });

        // Now side by side: the engine sending in a loop, the operator resending every note over
        // and over, each on its own connection.
        racing = false;
        const results: ReplayResult[] = [];
        let operating = true;
        const engineLoop = (async () => {
          while (operating) {
            await engine.tick();
            await sleep(1);
          }
        })();
        try {
          for (let round = 0; round < 6; round += 1) {
            results.push(...(await replayMessages(ids, context)));
            await sleep(round % 3);
          }
        } finally {
          operating = false;
          await engineLoop;
        }
        for (let i = 0; i < 50; i += 1) {
          if ((await engineStore.deliveryCounts("notes")).pending === 0) break;
          await engine.tick();
        }

        for (const result of results) {
          expect(
            result.outcome === "resent" ||
              (result.outcome === "refused" && result.reason === "pending"),
          ).toBe(true);
        }
        const resent = (id: number): number =>
          results.filter((r) => r.id === id && r.outcome === "resent").length;
        expect(ids.some((id) => resent(id) > 0)).toBe(true);
        for (const id of ids) {
          expect(sends.filter((sent) => sent === id)).toHaveLength(1 + resent(id));
          const deliveries = await engineStore.deliveries(id);
          expect(deliveries).toHaveLength(1 + resent(id));
          expect(deliveries.every((delivery) => delivery.status === "delivered")).toBe(true);
          expect(await engineStore.message(id)).toMatchObject({ generation: resent(id) });
        }
        expect(await engineStore.deliveryCounts("notes")).toMatchObject({
          pending: 0,
          failed: 0,
        });
        // Every attempt, recorded or refused, is in the audit log: the storage-level ones made in
        // the middle of a send, and each the command made.
        const entries = (await engineStore.auditEntries({ action: "resend", limit: 500 })).items;
        expect(entries).toHaveLength(midSend.length + commandMidSend.length + results.length);
        expect(entries.filter((entry) => entry.outcome === "ok")).toHaveLength(
          results.filter((r) => r.outcome === "resent").length,
        );
      } finally {
        await engine?.stop();
        await Promise.all(opened.map((store) => store.close()));
      }
    }, 60_000);
  });
}
