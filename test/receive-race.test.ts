// One message handed in twice under one idempotency key at the same moment, on two connections to
// one database, as two nodes behind one load balancer each take a sender's retry: it is stored
// once, and the second hand-in is answered with the first's id. Each server runs it under its own
// default isolation level, which the store never changes.
//
// The interleaving is forced at the database. Each hand-in carries a metadata tag, and a unique
// index this test adds to the tags (never in src) makes each tag's insert wait while a third
// connection holds the same tag, uncommitted. Both hand-ins start; the test waits until the server
// shows both waiting, then the third connection rolls back. A store that inserts each message and
// then looks the key up gets both hand-ins past their inserts before either looks: neither sees the
// other's row, and both are kept. With the claim, the second hand-in's insert waits on the first's,
// and yields to its row once it commits.
//
// SQLite has one writer at a time and a driver that waits for a lock synchronously, so two
// connections in one process cannot wait side by side: there two processes hand in the same keys.
//
// And a database an older Pathways left holding two messages under one key, as that race could:
// the schema step keeps both, whole, and gives the earliest the claim.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Kysely, sql } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dialectFor } from "../src/storage/dialects.js";
import type { ReceivedMessage, Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
  type TestStorage,
} from "./databases.js";
import { cleanUp, makeProject } from "./helpers.js";

const CHILD = join(import.meta.dirname, "receive-keys.ts");

const stores: Store[] = [];
const connections: Kysely<Tables>[] = [];

/** The columns this file writes beside the store, as an older Pathways writes a message. */
interface Tables {
  messages: {
    channel: string;
    received_at: string;
    body: Buffer;
    status: string;
    updated_at: string;
    idempotency_key: string | null;
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(connections.splice(0).map((db) => db.destroy()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array | undefined): string | undefined =>
  body === undefined ? undefined : new TextDecoder().decode(body);

/** The tag each of the two hand-ins carries, which the third connection holds until the race. */
const TAGS = ["synthetic-gate-a", "synthetic-gate-b"] as const;

/** A connection of the test's own to the database `storage` names. */
async function connect(storage: TestStorage): Promise<Kysely<Tables>> {
  const db = new Kysely<Tables>({
    dialect: await dialectFor(storage.storage, { env: storage.env }),
  });
  connections.push(db);
  return db;
}

/** How many messages the database holds on channel `notes`. */
async function count(db: Kysely<Tables>): Promise<number> {
  const { rows } = await sql<{
    n: number | string;
  }>`select count(*) as n from messages where channel = 'notes'`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

/** Each message's id and claim, oldest first. */
async function claims(db: Kysely<Tables>): Promise<[number, string, string | null][]> {
  const { rows } = await sql<{
    id: number | string;
    channel: string;
    idempotency_claim: string | null;
  }>`select id, channel, idempotency_claim from messages order by id`.execute(db);
  return rows.map((row) => [Number(row.id), row.channel, row.idempotency_claim]);
}

class Rollback extends Error {}

for (const database of TEST_DATABASES) {
  const timeout = database.kind === "sqlite" ? 30_000 : 60_000;
  describe.skipIf(!available(database))(
    `One message handed in twice at once on ${database.label}`,
    { timeout },
    () => {
      // Servers only: SQLite's two hand-ins are two processes, below.
      it.skipIf(database.kind === "sqlite")(
        "is stored once on two connections, and the second hand-in gets the first's id",
        async () => {
          const storage = await testStorage(database, join(await makeProject({}), "pathways.db"));
          const both = [await storage.open(), await storage.open()] as const;
          stores.push(...both);
          const db = await connect(storage);
          await sql`create unique index race_gate on meta_index (tag)`.execute(db);

          let release: () => void = () => undefined;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let locked: () => void = () => undefined;
          const holding = new Promise<void>((resolve) => {
            locked = resolve;
          });
          const holder = db
            .transaction()
            .execute(async (tx) => {
              for (const tag of TAGS) {
                await sql`insert into meta_index (message_id, channel, index_name, key_id, tag)
                  values (0, 'gate', 'gate', 'gate', ${tag})`.execute(tx);
              }
              locked();
              await released;
              throw new Rollback();
            })
            .catch((error: unknown) => {
              if (!(error instanceof Rollback)) throw error;
            });
          await holding;

          const handIn = (index: 0 | 1): Promise<ReceivedMessage> =>
            both[index].receive("notes", bytes("synthetic note 1"), {
              idempotencyKey: "synthetic-key-1",
              resumed: true,
              metaTags: [{ index: "gate", keyId: "gate", tag: TAGS[index] }],
            });
          let returned = 0;
          const running = Promise.allSettled(
            [handIn(0), handIn(1)].map((attempt) =>
              attempt.finally(() => {
                returned += 1;
              }),
            ),
          );
          try {
            await waiting(database, db, 2, () => returned);
          } finally {
            release();
            await holder;
          }
          const results = (await running).map((result) => {
            if (result.status === "rejected") throw result.reason;
            return result.value;
          });

          expect(await count(db)).toBe(1);
          const [stored] = (await claims(db)).map(([id]) => id);
          const answers = results
            .map((result) => ({ ...result, alreadyStored: result.alreadyStored === true }))
            .sort((a, b) => Number(a.alreadyStored) - Number(b.alreadyStored));
          expect(answers).toEqual([
            { id: stored, duplicateOf: undefined, alreadyStored: false },
            { id: stored, duplicateOf: undefined, alreadyStored: true },
          ]);
          // The stored message keeps its own tag; the hand-in that yielded left none behind.
          const { rows } = await sql<{
            n: number | string;
          }>`select count(*) as n from meta_index where message_id = ${stored}`.execute(db);
          expect(Number(rows[0]?.n ?? 0)).toBe(1);
        },
      );

      // SQLite only: two processes, each with its own connection, hand in the same keys at once.
      it.skipIf(database.kind !== "sqlite")(
        "stores each message once when two processes hand the same ones in at once",
        async () => {
          const file = join(await makeProject({}), "pathways.db");
          const storage = await testStorage(database, file);
          await (await storage.open()).close();
          const keys = 20;
          const handIn = (): Promise<string> =>
            new Promise((resolve, reject) => {
              const child = spawn(
                process.execPath,
                ["--import", "tsx", CHILD, file, String(keys)],
                {
                  stdio: ["ignore", "pipe", "inherit"],
                  env: { ...process.env, NODE_NO_WARNINGS: "1" },
                },
              );
              let out = "";
              child.stdout.on("data", (chunk: Buffer) => {
                out += chunk.toString();
              });
              child.once("error", reject);
              child.once("exit", (code) => {
                if (code === 0) resolve(out);
                else reject(new Error(`a hand-in process exited with ${String(code)}`));
              });
            });
          const again = await Promise.all([handIn(), handIn()]);
          // Every key handed in twice: stored once, and answered as stored once.
          expect(again.reduce((sum, each) => sum + Number(each), 0)).toBe(keys);
          const db = await connect(storage);
          expect(await count(db)).toBe(keys);
          const held = (await claims(db)).map(([, , claim]) => claim);
          expect(new Set(held).size).toBe(keys);
        },
      );

      it("keeps both of two messages an older Pathways stored under one key, and gives the earliest the claim", async () => {
        const storage = await testStorage(database, join(await makeProject({}), "pathways.db"));
        await (await storage.open()).close();
        const db = await connect(storage);
        await beforeClaims(db, database);
        // Two messages of one channel under one key, as two nodes on the version before could
        // store them at the same moment, and one under the same key on another channel.
        const at = "2026-11-12T00:00:00.000Z";
        for (const [channel, note] of [
          ["notes", "synthetic note A"],
          ["notes", "synthetic note B"],
          ["other", "synthetic note C"],
        ] as const) {
          await db
            .insertInto("messages")
            .values({
              channel,
              received_at: at,
              body: Buffer.from(note),
              status: "received",
              updated_at: at,
              idempotency_key: "synthetic-key-1",
            })
            .execute();
        }

        const store = await storage.open();
        stores.push(store);
        expect(await claims(db)).toEqual([
          [1, "notes", "synthetic-key-1"],
          [2, "notes", null],
          [3, "other", "synthetic-key-1"],
        ]);
        // Both kept whole: each body, status and key as it was stored.
        expect(text(await store.messageBody(1))).toBe("synthetic note A");
        expect(text(await store.messageBody(2))).toBe("synthetic note B");
        for (const id of [1, 2]) {
          expect(await store.message(id)).toMatchObject({
            id,
            channel: "notes",
            status: "received",
          });
        }
        // A resumed hand-in finds the earliest, as before the step; one that is not resumed is
        // stored, without the claim the earliest holds.
        const resumed = { idempotencyKey: "synthetic-key-1", resumed: true };
        expect(await store.receive("notes", bytes("synthetic note A"), resumed)).toEqual({
          id: 1,
          duplicateOf: undefined,
          alreadyStored: true,
        });
        expect(await store.receive("other", bytes("synthetic note C"), resumed)).toEqual({
          id: 3,
          duplicateOf: undefined,
          alreadyStored: true,
        });
        // A server spends an id on an insert that yielded, so the new one's id is read back.
        const added = await store.receive("notes", bytes("synthetic note D"), {
          idempotencyKey: "synthetic-key-1",
        });
        expect(added).toEqual({ id: added.id, duplicateOf: undefined });
        expect(added.id).toBeGreaterThan(3);
        expect(await count(db)).toBe(3);
        expect((await claims(db)).at(-1)).toEqual([added.id, "notes", null]);
      });

      it("finds a message an older Pathways stored after the step, under a key no message claims", async () => {
        const storage = await testStorage(database, join(await makeProject({}), "pathways.db"));
        const store = await storage.open();
        stores.push(store);
        const db = await connect(storage);
        // An older Pathways, running beside this one, stores without a claim.
        const at = "2026-11-12T00:00:00.000Z";
        await db
          .insertInto("messages")
          .values({
            channel: "notes",
            received_at: at,
            body: Buffer.from("synthetic note A"),
            status: "received",
            updated_at: at,
            idempotency_key: "synthetic-key-1",
          })
          .execute();
        expect(
          await store.receive("notes", bytes("synthetic note A"), {
            idempotencyKey: "synthetic-key-1",
            resumed: true,
            metaTags: [{ index: "synthetic", keyId: "k1", tag: "synthetic-tag" }],
          }),
        ).toEqual({ id: 1, duplicateOf: undefined, alreadyStored: true });
        expect(await claims(db)).toEqual([[1, "notes", null]]);
        const { rows } = await sql<{
          n: number | string;
        }>`select count(*) as n from meta_index`.execute(db);
        expect(Number(rows[0]?.n ?? 0)).toBe(0);
      });
    },
  );
}

/**
 * Takes the database back to the schema before claims, as the version before left it: the index,
 * the column, and the step's records go.
 */
async function beforeClaims(db: Kysely<Tables>, database: TestDatabase): Promise<void> {
  const index = db.schema.dropIndex("messages_by_channel_idempotency_claim");
  await (
    database.kind === "mysql" || database.kind === "sqlserver" ? index.on("messages") : index
  ).execute();
  await db.schema.alterTable("messages").dropColumn("idempotency_claim").execute();
  await sql`delete from kysely_migration where name = '0014-idempotency-claims'`.execute(db);
  await sql`delete from schema_info where step = '0014-idempotency-claims'`.execute(db);
}

/**
 * Waits until `count` statements on this database wait for a lock, as the server's own views show
 * them: the lock views on PostgreSQL and SQL Server, and on MySQL and MariaDB the process list,
 * where a waiting insert stays with its text, as `Execute`, since the store's statements with values
 * run as prepared statements. Polls for up to 20 seconds, then fails saying the race's precondition
 * was not observed, with the last count the server showed and how many hand-ins had returned.
 */
async function waiting(
  database: TestDatabase,
  db: Kysely<Tables>,
  count: number,
  returned: () => number,
): Promise<void> {
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
            and lower(info) like 'insert%'`;
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
      `${String(count)} statements waiting for a lock in 20 seconds, and ${String(returned())} ` +
      "of the hand-ins had returned",
  );
}
