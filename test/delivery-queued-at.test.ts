// Each delivery's own queue time, on every database: schema step 0017-delivery-queued-at adds the
// `queued_at` column, the store sets it when it inserts a delivery, and nothing moves it after: not a
// retry, not a failure beside it, not an operator clearing a failed delivery of the same message.
// The oldest pending age per destination counts from it. The step goes up on a queue that holds
// deliveries in flight while the version before writes beside it, comes down again with its `down`,
// and goes up again, keeping every row. Every body is synthetic.
import { join } from "node:path";

import { Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dialectFor } from "../src/storage/dialects.js";
import { recordedSteps } from "../src/storage/schema.js";
import { migrations, QUEUED_AT_STEP, type Store } from "../src/storage/store.js";
import { VERSION } from "../src/version.js";
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

const stores: Store[] = [];
const connections: Kysely<unknown>[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(connections.splice(0).map((db) => db.destroy()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

/** 2026-11-12T08:00:00.000Z: when the first message is transformed. */
const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);
const at = (ms: number): string => new Date(ms).toISOString();
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const KEYS = ["synthetic-key-a", "synthetic-key-b"];

/** A connection of the test's own to the database `storage` names. */
async function connect(storage: TestStorage): Promise<Kysely<unknown>> {
  const db = new Kysely<unknown>({
    dialect: await dialectFor(storage.storage, { env: storage.env }),
  });
  connections.push(db);
  return db;
}

/** Whether `deliveries` has the `queued_at` column. */
async function hasQueuedAt(db: Kysely<unknown>): Promise<boolean> {
  const tables = await db.introspection.getTables();
  const deliveries = tables.find((table) => table.name === "deliveries");
  return deliveries?.columns.some((column) => column.name === "queued_at") ?? false;
}

/** The step names `kysely_migration` and `schema_info` hold, each sorted. */
async function recorded(db: Kysely<unknown>): Promise<{ applied: string[]; info: string[] }> {
  const applied = await sql<{ name: string }>`select name from kysely_migration`.execute(db);
  const info = await sql<{ step: string }>`select step from schema_info`.execute(db);
  return {
    applied: applied.rows.map((row) => row.name).sort(),
    info: info.rows.map((row) => row.step).sort(),
  };
}

/** One delivery as it stands, its ids as numbers on every database. */
interface DeliveryRow {
  readonly id: number;
  readonly message_id: number;
  readonly destination: number;
  readonly seq: number;
  readonly status: string;
  readonly attempts: number;
  readonly destination_key: string | null;
}

/** Every delivery as it stands, by id: what a schema step must never change. */
async function rows(db: Kysely<unknown>): Promise<DeliveryRow[]> {
  const { rows: found } = await sql<{
    id: number | string;
    message_id: number | string;
    destination: number;
    seq: number;
    status: string;
    attempts: number;
    destination_key: string | null;
  }>`select id, message_id, destination, seq, status, attempts, destination_key from deliveries order by id`.execute(
    db,
  );
  return found.map((row) => ({ ...row, id: Number(row.id), message_id: Number(row.message_id) }));
}

/** Each delivery's queue time, by id, as the column holds it. */
async function queuedAt(db: Kysely<unknown>): Promise<(string | null)[]> {
  const { rows: found } = await sql<{
    queued_at: string | null;
  }>`select queued_at from deliveries order by id`.execute(db);
  return found.map((row) => row.queued_at);
}

/** Takes the schema's last step back down, as `down` does it, through the steps as Kysely runs them. */
async function stepDown(db: Kysely<unknown>, kind: TestDatabase["kind"]): Promise<void> {
  const steps = recordedSteps(migrations(kind), VERSION, () => new Date(T0));
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(steps) },
    allowUnorderedMigrations: true,
  });
  const { error, results } = await migrator.migrateDown();
  expect(error).toBeUndefined();
  expect(results).toEqual([
    { migrationName: QUEUED_AT_STEP, direction: "Down", status: "Success" },
  ]);
}

for (const database of TEST_DATABASES) {
  const timeout = database.kind === "sqlite" ? 10_000 : 60_000;
  describe.skipIf(!available(database))(
    `A delivery's queue time on ${database.label}`,
    { timeout },
    () => {
      async function fresh(): Promise<TestStorage> {
        return testStorage(database, join(await makeProject({}), "pathways.db"));
      }

      it("stays when its delivery is retried and when a failed delivery of its message is cleared", async () => {
        const storage = await fresh();
        const clock = { now: T0 };
        const store = await storage.open({ now: () => new Date(clock.now) });
        stores.push(store);
        const { id } = await store.receive("adt", bytes("synthetic-body"));
        await store.completeTransform(id, [bytes("synthetic-output")], 2, undefined, KEYS);
        const [first, second] = await store.deliveries(id);

        clock.now += 60_000;
        await store.scheduleRetry(second?.id ?? 0, 1, clock.now + 1_000, "delivery: ECONNREFUSED");
        await store.failDelivery(first?.id ?? 0, "delivery: rejected");
        clock.now += 60_000;
        // The clear moves the message's last update; the delivery still pending keeps its own time.
        expect(await store.clear(id, "synthetic-operator")).toMatchObject({ done: true });
        expect((await store.message(id))?.updatedAt).toBe(at(T0 + 120_000));

        expect(await store.destinationQueues("adt")).toEqual([
          {
            destination: 1,
            destinationKey: KEYS[1],
            pending: 1,
            retrying: 1,
            failed: 0,
            oldestPendingSince: at(T0),
          },
        ]);
      });

      it("goes up on a queue with deliveries in flight beside the version before, comes down, and goes up again, keeping every row", async () => {
        const storage = await fresh();
        const clock = { now: T0 };
        const now = (): Date => new Date(clock.now);
        const store = await storage.open({ now });
        const { id } = await store.receive("adt", bytes("synthetic-body"));
        await store.completeTransform(id, [bytes("synthetic-output")], 2, undefined, KEYS);
        const [, second] = await store.deliveries(id);
        await store.scheduleRetry(second?.id ?? 0, 1, T0 + 1_000, "delivery: ECONNREFUSED");
        // Every engine of this version stops before the step comes down.
        await store.close();

        const db = await connect(storage);
        expect(await hasQueuedAt(db)).toBe(true);
        const before = await rows(db);

        // Down: the column, and the step's record in both tables, go; every delivery stays.
        await stepDown(db, database.kind);
        expect(await hasQueuedAt(db)).toBe(false);
        const down = await recorded(db);
        expect(down.applied).not.toContain(QUEUED_AT_STEP);
        expect(down.info).not.toContain(QUEUED_AT_STEP);
        expect(down.applied).toEqual(down.info);
        expect(await rows(db)).toEqual(before);

        // Up again at start, while the version before goes on working the queue: it retries the
        // delivery in flight and queues another, neither of which names the column.
        clock.now = T0 + 60_000;
        const older = async (): Promise<void> => {
          for (let attempt = 2; attempt <= 4; attempt += 1) {
            await sql`update deliveries set attempts = ${attempt} where id = ${second?.id ?? 0}`.execute(
              db,
            );
          }
          await sql`insert into deliveries (message_id, channel, destination, seq, body, status, attempts, next_attempt_at, generation, destination_key)
            select message_id, channel, destination, seq + 1, body, status, 0, 0, generation, destination_key
            from deliveries where id = ${second?.id ?? 0}`.execute(db);
        };
        const [upgraded] = await Promise.all([storage.open({ now }), older()]);
        stores.push(upgraded);
        expect(await hasQueuedAt(db)).toBe(true);
        const up = await recorded(db);
        expect(up.applied).toEqual(Object.keys(migrations(database.kind)).sort());
        expect(up.info).toEqual(up.applied);
        const { rows: info } = await sql<{
          generation: number;
          tag: string;
        }>`select generation, tag from schema_info where step = ${QUEUED_AT_STEP}`.execute(db);
        expect(info.map((row) => [Number(row.generation), row.tag])).toEqual([
          [Object.keys(migrations(database.kind)).indexOf(QUEUED_AT_STEP) + 1, "expand"],
        ]);

        // Every row is kept, the version before's writes with them. Nothing fills the new column
        // in: those rows count from their message's last update, the transform at T0.
        const after = await rows(db);
        expect(after.slice(0, before.length)).toEqual(
          before.map((row) => (row.id === second?.id ? { ...row, attempts: 4 } : row)),
        );
        expect(after).toHaveLength(before.length + 1);
        expect(await queuedAt(db)).toEqual([null, null, null]);
        expect(await upgraded.destinationQueues("adt")).toEqual([
          {
            destination: 0,
            destinationKey: KEYS[0],
            pending: 1,
            retrying: 0,
            failed: 0,
            oldestPendingSince: at(T0),
          },
          {
            destination: 1,
            destinationKey: KEYS[1],
            pending: 2,
            retrying: 1,
            failed: 0,
            oldestPendingSince: at(T0),
          },
        ]);

        // A delivery this version queues has its own time; the queue's oldest is still the earlier.
        clock.now = T0 + 120_000;
        const later = await upgraded.receive("adt", bytes("synthetic-body-2"));
        await upgraded.completeTransform(
          later.id,
          [bytes("synthetic-output-2")],
          2,
          undefined,
          KEYS,
        );
        expect(await queuedAt(db)).toEqual([null, null, null, at(T0 + 120_000), at(T0 + 120_000)]);
        const queues = await upgraded.destinationQueues("adt");
        expect(queues.map((q) => [q.destination, q.pending, q.oldestPendingSince])).toEqual([
          [0, 2, at(T0)],
          [1, 3, at(T0)],
        ]);
      });
    },
  );
}
