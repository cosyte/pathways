// An operator's resend racing the engine's delivery of the same message, on two connections to one
// database, as `pathways replay --resend` runs beside `pathways start`. Each server runs it under
// its own default isolation level, which the store never changes, and the test first asserts that
// level: READ COMMITTED on PostgreSQL and SQL Server, REPEATABLE READ on MySQL and MariaDB. SQLite
// has one writer at a time, which is serializable.
//
// What must hold whatever the interleaving: a resend is refused while the message has a delivery
// pending, even one in the middle of its send; and of two resends of one message at once, exactly
// one is recorded and the other refused, so the receiver gets the message once more, not twice.
//
// The two at once run on two connections, with the interleaving forced at the database: a third
// connection holds the message's row locked until both resends wait on it, then lets go. The same
// race against a requeue that checks in one step and writes in the next, written here and never in
// src, queues the message twice: the race catches what it is there to catch. SQLite has one writer
// at a time and a driver that waits for a lock synchronously, so two connections in one process
// cannot wait side by side: there the two resends are two `pathways replay` processes.
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { Kysely, sql } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { DestinationConnector } from "../src/connectors/types.js";
import { destinationKeys } from "../src/engine/destination-key.js";
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

const BIN = join(import.meta.dirname, "../src/bin/pathways.ts");

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
    it("is refused while the delivery is in the middle of its send, at storage and at the command", async () => {
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
        const keys = destinationKeys(project.root, project.channels[0]?.destinations ?? []);
        for (let i = 1; i <= NOTES; i += 1) {
          const { id } = await engineStore.receive("notes", bytes(`synthetic note ${String(i)}`));
          await engineStore.completeTransform(
            id,
            [bytes(`synthetic note ${String(i)}`)],
            1,
            undefined,
            keys,
          );
        }
        const ids = Array.from({ length: NOTES }, (_, i) => i + 1);

        // A resend asked for while each first delivery is in the middle of its send: storage
        // refuses it, as the command does before it reaches storage.
        const sends: number[] = [];
        const midSend: RequeueResult[] = [];
        const commandMidSend: ReplayResult[] = [];
        let pause = 0;
        const destination: DestinationConnector = {
          async deliver(message) {
            sends.push(message.messageId);
            const outputs = [bytes(`synthetic note ${String(message.messageId)}`)];
            midSend.push(
              await operatorStore.requeue(
                message.messageId,
                { mode: "resend", expected: "transformed", outputs, destinations: 1 },
                "tester",
              ),
            );
            commandMidSend.push(...(await replayMessages([message.messageId], context)));
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

        // Every attempt is in the audit log, refused: the ones at storage and the command's.
        const entries = (await engineStore.auditEntries({ action: "resend", limit: 50 })).items;
        expect(entries.map((entry) => entry.outcome)).toEqual(
          Array.from({ length: 2 * NOTES }, () => "refused"),
        );
      } finally {
        await engine?.stop();
        await Promise.all(opened.map((store) => store.close()));
      }
    }, 60_000);

    // Servers only: SQLite's two resends are two processes, below.
    it.skipIf(database.kind === "sqlite")(
      "of two at once, records exactly one, and catches a requeue that checks before it writes",
      async () => {
        const root = await makeProject({});
        const storage = await testStorage(database, join(root, "pathways.db"));
        const opened: Store[] = [];
        try {
          const stores = [await storage.open(), await storage.open()] as const;
          opened.push(...stores);
          const [first] = stores;
          const { id } = await first.receive("notes", bytes("synthetic note 1"));
          await first.completeTransform(id, [bytes("synthetic note 1")], 1);
          const delivery = await first.nextDelivery("notes", 0);
          await first.markDelivered(delivery?.id ?? -1);
          const outputs = [bytes("synthetic note 1")];

          // The store's requeue: the guarded update, the check and the writes, one transaction.
          const atomic = await raceTwo(database, storage, id, async (index) => {
            const result = await stores[index].requeue(
              id,
              { mode: "resend", expected: "transformed", outputs, destinations: 1 },
              "tester",
            );
            return result.done ? "done" : result.reason;
          });
          expect(atomic).toEqual({ outcomes: ["done", "pending"], pending: 1 });
          const entries = (await first.auditEntries({ action: "resend", limit: 10 })).items;
          expect(entries.map((entry) => entry.outcome).sort()).toEqual(["ok", "refused"]);

          // Delivered again, so the next race starts where this one did.
          const queued = await first.nextDelivery("notes", 0);
          await first.markDelivered(queued?.id ?? -1);

          // A requeue that checks, then writes in a step of its own: both resends pass the check
          // before either writes, and the message is queued twice.
          let checked = 0;
          let bothChecked: () => void = () => undefined;
          const checks = new Promise<void>((resolve) => {
            bothChecked = resolve;
          });
          const twoStep = await raceTwo(database, storage, id, async (index) => {
            const store = stores[index];
            const pending = (await store.message(id))?.deliveries.pending ?? 0;
            checked += 1;
            if (checked === 2) bothChecked();
            await checks;
            if (pending > 0) return "pending";
            await store.completeTransform(id, outputs, 1);
            return "done";
          });
          expect(twoStep).toEqual({ outcomes: ["done", "done"], pending: 2 });
        } finally {
          await Promise.all(opened.map((store) => store.close()));
        }
      },
      60_000,
    );

    // SQLite only: two `pathways replay --resend` processes at once, each with its own connection.
    it.skipIf(database.kind !== "sqlite")(
      "of two processes at once, records exactly one",
      async () => {
        const root = await makeProject({
          "pathways.yaml": "encryption: none\n",
          "channels/notes/channel.yaml":
            "format: text\nsource:\n  file: { dir: ../../data/inbox }\n" +
            "destinations:\n  - file: { dir: ../../data/out }\n",
        });
        const project = await loadProject(root);
        const store = await testStorage(database, project.databaseFile).then((s) => s.open());
        try {
          const { id } = await store.receive("notes", bytes("synthetic note 1"));
          const keys = destinationKeys(project.root, project.channels[0]?.destinations ?? []);
          await store.completeTransform(id, [bytes("synthetic note 1")], 1, undefined, keys);
          const delivery = await store.nextDelivery("notes", 0);
          await store.markDelivered(delivery?.id ?? -1);

          const replay = (): Promise<number | null> =>
            new Promise((resolve, reject) => {
              const child = spawn(
                process.execPath,
                ["--import", "tsx", BIN, "replay", String(id), "--resend", "-C", root],
                { stdio: "ignore", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
              );
              child.once("error", reject);
              child.once("exit", (code) => resolve(code));
            });
          const codes = await Promise.all([replay(), replay()]);
          // One resent (exit 0), one refused because the first left a delivery pending (exit 1).
          expect([...codes].sort()).toEqual([0, 1]);
          expect(await store.deliveryCounts("notes")).toMatchObject({ pending: 1, delivered: 1 });
          const entries = (await store.auditEntries({ action: "resend", limit: 10 })).items;
          expect(entries.map((entry) => [entry.outcome, entry.detail["reason"]]).sort()).toEqual([
            ["ok", undefined],
            ["refused", "pending"],
          ]);
        } finally {
          await store.close();
        }
      },
      60_000,
    );
  });
}

/**
 * Runs `attempt(0)` and `attempt(1)` side by side on two connections, with the interleaving forced
 * at the database: a third connection locks message `id`'s row, both attempts start and wait on
 * it (as the server's own lock views show), then the lock is let go. Returns each attempt's
 * outcome, sorted, and how many deliveries are pending after.
 */
async function raceTwo(
  database: TestDatabase,
  storage: TestStorage,
  id: number,
  attempt: (index: 0 | 1) => Promise<string>,
): Promise<{ outcomes: string[]; pending: number }> {
  const db = new Kysely<unknown>({
    dialect: await dialectFor(storage.storage, { env: storage.env }),
  });
  try {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction().execute(async (tx) => {
      await sql`update messages set updated_at = updated_at where id = ${id}`.execute(tx);
      locked();
      await released;
    });
    await holding;
    const running = Promise.allSettled([attempt(0), attempt(1)]);
    try {
      await waiting(database, db, 2);
    } finally {
      release();
      await holder;
    }
    const settled = await running;
    const outcomes = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const { rows } = await sql<{
      n: number | string;
    }>`select count(*) as n from deliveries where message_id = ${id} and status = 'pending'`.execute(
      db,
    );
    return { outcomes: outcomes.sort(), pending: Number(rows[0]?.n ?? 0) };
  } finally {
    await db.destroy();
  }
}

/**
 * Waits until `count` statements on this database are blocked behind the locked message row, as
 * the server's own view of running statements shows them: the process list on MySQL and MariaDB
 * (a blocked update stays there with its text, as `Execute`, since the store's statements with
 * values run as prepared statements), and the lock views on PostgreSQL and SQL Server.
 * Polls for up to 20 seconds, then fails saying the race's precondition was not observed, with the
 * last count the server showed.
 */
async function waiting(database: TestDatabase, db: Kysely<unknown>, count: number): Promise<void> {
  let seen = 0;
  for (let i = 0; i < 400; i += 1) {
    let query;
    switch (database.kind) {
      case "postgres":
        query = sql<{ n: number | string }>`
          select count(*) as n from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock' and state = 'active'`;
        break;
      case "mysql":
        query = sql<{ n: number | string }>`
          select count(*) as n from information_schema.processlist
          where db = database() and id <> connection_id() and command in ('Query', 'Execute')
            and lower(info) like 'update%messages%'`;
        break;
      case "sqlite":
        throw new Error("SQLite runs this race in two processes, with no lock to wait on");
      case "sqlserver":
        query = sql<{ n: number | string }>`
          select count(*) as n from sys.dm_exec_requests
          where blocking_session_id <> 0 and database_id = db_id()`;
    }
    const { rows } = await query.execute(db);
    seen = Number(rows[0]?.n ?? 0);
    if (seen >= count) return;
    await sleep(50);
  }
  throw new Error(
    `the race's precondition was not observed: ${database.label} showed ${String(seen)} of ` +
      `${String(count)} statements blocked behind the locked message row in 20 seconds`,
  );
}
