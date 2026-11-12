// The schema gate a store passes when it opens, on every database: a schema a newer Pathways moved
// forward with expand steps opens as it is, one it contracted past this version is refused naming
// both versions, an older one gets its expand steps at start, once, however many engines start at
// the same moment, and `migrate: "none"` (pathways start --no-migrate) refuses an older one.
import { join } from "node:path";

import { Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dialectFor } from "../src/storage/dialects.js";
import { migrations, type Store } from "../src/storage/store.js";
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

const open: Kysely<unknown>[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(open.splice(0).map((db) => db.destroy()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

/** Tables this file reads and writes beside the store, by plain SQL. */
interface Tables {
  kysely_migration: { name: string; timestamp: string };
  schema_info: {
    step: string;
    generation: number;
    tag: string;
    min_engine: string;
    applied_by: string;
    applied_at: string;
  };
}

/** A connection of the test's own to the database `storage` names. */
async function connect(storage: TestStorage): Promise<Kysely<Tables>> {
  const db = new Kysely<Tables>({
    dialect: await dialectFor(storage.storage, { env: storage.env }),
  });
  open.push(db as Kysely<unknown>);
  return db;
}

/** The steps applied, by name. */
async function applied(db: Kysely<Tables>): Promise<string[]> {
  const rows = await db.selectFrom("kysely_migration").select("name").execute();
  return rows.map((row) => row.name).sort();
}

/** Whether the database has `schema_info`: it does once this version has opened it. */
async function hasSchemaInfo(db: Kysely<Tables>): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === "schema_info");
}

/**
 * Makes the database look as a newer Pathways left it: one more step applied, and recorded in
 * `schema_info` with its tag and the oldest Pathways that runs on the schema after it.
 */
async function newerStep(
  db: Kysely<Tables>,
  tag: "expand" | "contract",
  minEngine: string,
): Promise<void> {
  const at = new Date().toISOString();
  await db
    .insertInto("kysely_migration")
    .values({ name: "0099-from-pathways-99", timestamp: at })
    .execute();
  if (!(await hasSchemaInfo(db))) return;
  await db
    .insertInto("schema_info")
    .values({
      step: "0099-from-pathways-99",
      generation: 99,
      tag,
      min_engine: minEngine,
      applied_by: "99.0.0",
      applied_at: at,
    })
    .execute();
}

/** Brings the database to the schema of the version before `schema_info`: steps 0001 to 0006. */
async function olderSchema(storage: TestStorage, database: TestDatabase): Promise<void> {
  const db = await connect(storage);
  const steps = Object.fromEntries(
    Object.entries(migrations(database.kind)).filter(([name]) => name < "0007"),
  );
  const { error } = await new Migrator({
    db: db as Kysely<unknown>,
    provider: { getMigrations: () => Promise.resolve(steps) },
  }).migrateToLatest();
  expect(error).toBeUndefined();
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

for (const database of TEST_DATABASES) {
  const timeout = database.kind === "sqlite" ? 10_000 : 60_000;
  describe.skipIf(!available(database))(`The schema gate on ${database.label}`, { timeout }, () => {
    async function fresh(): Promise<TestStorage> {
      return testStorage(database, join(await makeProject({}), "pathways.db"));
    }

    it("opens a schema a newer Pathways moved forward with an expand step, and leaves it as it is", async () => {
      const storage = await fresh();
      await (await storage.open()).close();
      const db = await connect(storage);
      await newerStep(db, "expand", "0.0.1");
      const before = await applied(db);

      const store = await storage.open();
      stores.push(store);
      expect(await store.receive("adt", bytes("x"))).toMatchObject({ id: 1 });
      expect(await applied(db)).toEqual(before);
      expect(await store.schema()).toMatchObject({
        generation: 99,
        minEngine: "0.0.1",
        changedBy: "99.0.0",
        unknown: ["0099-from-pathways-99"],
        pending: [],
      });
    });

    it("refuses a schema a newer Pathways contracted past this version, naming both versions", async () => {
      const storage = await fresh();
      await (await storage.open()).close();
      const db = await connect(storage);
      await newerStep(db, "contract", "99.0.0");

      const error: unknown = await storage.open().catch((e: unknown) => e);
      expect((error as Error).message).toBe(
        `the database schema is generation 99 and needs Pathways 99.0.0 or later; this is Pathways ${VERSION}`,
      );
      expect((error as Error).message).not.toMatch(/:\/\/|pathways\.db/);
    });

    it("brings a schema from before schema_info up at start, recording every step and its tag", async () => {
      const storage = await fresh();
      await olderSchema(storage, database);
      const store = await storage.open();
      stores.push(store);
      const db = await connect(storage);
      const rows = await db.selectFrom("schema_info").selectAll().orderBy("generation").execute();
      expect(rows.map((row) => [row.step, Number(row.generation), row.tag])).toEqual(
        Object.keys(migrations(database.kind)).map((name, index) => [name, index + 1, "expand"]),
      );
      for (const row of rows) {
        expect(row).toMatchObject({ min_engine: "0.0.1", applied_by: VERSION });
      }
    });

    it("with migrate: none, refuses a schema that lacks an expand step, naming both versions, and applies nothing", async () => {
      const storage = await fresh();
      await olderSchema(storage, database);
      const error: unknown = await storage.open({ migrate: "none" }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(
        `the database schema is generation 6, last changed by Pathways 0.0.1; this is Pathways ${VERSION}, which needs generation 12`,
      );
      const db = await connect(storage);
      expect(await applied(db)).toHaveLength(6);
      expect(await hasSchemaInfo(db)).toBe(false);
    });

    it.skipIf(database.kind === "sqlite")(
      "applies each step once when engines start at the same moment",
      async () => {
        const asIs = (): Promise<void> => Promise.resolve();
        for (const prepare of [asIs, olderSchema]) {
          const storage = await fresh();
          await prepare(storage, database);
          const started = await Promise.all([storage.open(), storage.open(), storage.open()]);
          stores.push(...started);
          const db = await connect(storage);
          const steps = Object.keys(migrations(database.kind));
          expect(await applied(db)).toEqual(steps);
          const rows = await db
            .selectFrom("schema_info")
            .select(["step", sql<number>`count(*)`.as("times")])
            .groupBy("step")
            .execute();
          expect(rows.map((row) => [row.step, Number(row.times)]).sort()).toEqual(
            steps.map((step) => [step, 1]),
          );
        }
      },
    );
  });
}
