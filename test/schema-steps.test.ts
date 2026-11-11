// Schema steps tagged expand and contract, on every database, with fake steps after this version's
// own: start applies only expand steps, even past a contract step it leaves waiting; migrate
// applies contract steps only when asked and outside the rollback window; a contract step raises
// the oldest Pathways the schema allows; and a step that fails is reported, not half recorded.
import { join } from "node:path";

import { Kysely, type Dialect } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dialectFor } from "../src/storage/dialects.js";
import {
  compareVersions,
  migrateSchema,
  openSchema,
  readSchema,
  recordedSteps,
  SchemaStepError,
  SchemaVersionError,
  UnrecordedStepError,
  type SchemaStep,
} from "../src/storage/schema.js";
import { migrations } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
} from "./databases.js";
import { cleanUp, makeProject } from "./helpers.js";

const open: Kysely<unknown>[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.destroy()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const HOUR = 3_600_000;
const T0 = new Date("2026-11-11T00:00:00.000Z");

/** A step that adds a table of its own name, tagged as given. */
function table(name: string): SchemaStep["up"] {
  return async (db) => {
    await db.schema.createTable(name).addColumn("id", "integer").execute();
  };
}

/**
 * This version's steps, then two from a later one: a contract step that needs Pathways 2.0.0 and
 * an expand step after it.
 */
function laterSteps(database: TestDatabase, extra: Record<string, SchemaStep> = {}) {
  return recordedSteps(
    {
      ...migrations(database.kind),
      "0010-contract": { tag: "contract", minEngine: "2.0.0", up: table("fake_contract") },
      "0011-expand": { tag: "expand", up: table("fake_expand") },
      ...extra,
    },
    "2.0.0",
    () => T0,
  );
}

async function connect(database: TestDatabase): Promise<Kysely<unknown>> {
  const storage = await testStorage(database, join(await makeProject({}), "pathways.db"));
  const dialect: Dialect = await dialectFor(storage.storage, { env: storage.env });
  const db = new Kysely<unknown>({ dialect });
  open.push(db);
  return db;
}

const names = (steps: readonly { name: string }[]): string[] => steps.map((step) => step.name);

describe("compareVersions", () => {
  it("orders by major, minor and patch as numbers, and a prerelease before its release", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });
});

for (const database of TEST_DATABASES) {
  const timeout = database.kind === "sqlite" ? 10_000 : 60_000;
  describe.skipIf(!available(database))(`Schema steps on ${database.label}`, { timeout }, () => {
    it("applies only expand steps at start, past a contract step it leaves for migrate --contract", async () => {
      const db = await connect(database);
      const steps = laterSteps(database);
      const opened = await openSchema(db, database.kind, steps, "2.0.0", "expand");
      expect(opened.error).toBeUndefined();
      const state = opened.state;
      expect(names(state?.pending ?? [])).toEqual(["0010-contract"]);
      expect(state).toMatchObject({ generation: 10, minEngine: "0.0.1", changedBy: "2.0.0" });
      expect(state?.applied.at(-1)).toEqual({ name: "0011-expand", generation: 10, tag: "expand" });

      // Without --contract, migrate leaves it waiting; a dry run with it says it would apply it.
      const plain = await migrateSchema(db, database.kind, steps, "2.0.0");
      expect(plain).toMatchObject({ steps: [], dryRun: false });
      expect(names(plain.waiting)).toEqual(["0010-contract"]);
      const dry = await migrateSchema(db, database.kind, steps, "2.0.0", {
        contract: true,
        dryRun: true,
      });
      expect(dry.steps).toEqual([{ name: "0010-contract", generation: 9, tag: "contract" }]);
      expect(dry.after).toBe(dry.before);
      expect(names((await readSchema(db, steps)).pending)).toEqual(["0010-contract"]);

      // Inside the rollback window, counted from the last change, it is refused.
      const window = { contract: true, rollbackWindowMs: 2 * HOUR };
      const early = await migrateSchema(db, database.kind, steps, "2.0.0", {
        ...window,
        now: new Date(T0.getTime() + HOUR),
      });
      expect(early.refused).toEqual({
        reason: "rollback-window",
        until: new Date(T0.getTime() + 2 * HOUR).toISOString(),
      });
      expect(names((await readSchema(db, steps)).pending)).toEqual(["0010-contract"]);

      const done = await migrateSchema(db, database.kind, steps, "2.0.0", {
        ...window,
        now: new Date(T0.getTime() + 3 * HOUR),
      });
      expect(names(done.steps)).toEqual(["0010-contract"]);
      expect(done.after).toMatchObject({ generation: 10, minEngine: "2.0.0", pending: [] });
      expect(done.refused).toBeUndefined();

      // Nothing left: a second run applies nothing.
      const again = await migrateSchema(db, database.kind, steps, "2.0.0", { contract: true });
      expect(again.steps).toEqual([]);
    });

    it("holds no contract step back on a database with no schema yet, whatever the rollback window", async () => {
      const db = await connect(database);
      const report = await migrateSchema(db, database.kind, laterSteps(database), "2.0.0", {
        contract: true,
        dryRun: true,
        rollbackWindowMs: 2 * HOUR,
      });
      expect(report.before.changedAt).toBeUndefined();
      expect(report.refused).toBeUndefined();
      expect(names(report.steps)).toContain("0010-contract");
    });

    it("refuses an engine older than a contract step allows, at open and in migrate, naming both versions", async () => {
      const db = await connect(database);
      const steps = laterSteps(database);
      await openSchema(db, database.kind, steps, "2.0.0", "expand");
      await migrateSchema(db, database.kind, steps, "2.0.0", { contract: true });

      // This version's own steps, run by an engine before 2.0.0: two steps it does not know.
      const own = recordedSteps(migrations(database.kind), "1.0.0", () => T0);
      for (const mode of ["expand", "none"] as const) {
        const error: unknown = await openSchema(db, database.kind, own, "1.0.0", mode).catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(SchemaVersionError);
        expect(error).toMatchObject({
          reason: "engine-too-old",
          engine: "1.0.0",
          schemaVersion: "2.0.0",
          generation: 10,
          message:
            "the database schema is generation 10 and needs Pathways 2.0.0 or later; this is Pathways 1.0.0",
        });
      }
      await expect(migrateSchema(db, database.kind, own, "1.0.0")).rejects.toThrow(
        SchemaVersionError,
      );
      // Inspecting refuses nothing: it says what the schema is.
      const inspected = await openSchema(db, database.kind, own, "1.0.0", "inspect");
      expect(inspected.state?.unknown).toEqual(["0010-contract", "0011-expand"]);
    });

    it("leaves a schema a newer Pathways moved forward as it is when asked to migrate", async () => {
      const db = await connect(database);
      await openSchema(db, database.kind, laterSteps(database), "2.0.0", "expand");
      const own = recordedSteps(migrations(database.kind), "1.0.0", () => T0);
      const report = await migrateSchema(db, database.kind, own, "1.0.0", { contract: true });
      expect(report).toMatchObject({ steps: [], waiting: [] });
      expect(report.before.unknown).toEqual(["0011-expand"]);
    });

    it("reports a step that fails, and records none of it", async () => {
      const db = await connect(database);
      const fails: SchemaStep["up"] = () =>
        Promise.reject(Object.assign(new Error("synthetic failure"), { code: "E1" }));
      const failing = laterSteps(database, { "0010-fails": { tag: "expand", up: fails } });
      const opened = await openSchema(db, database.kind, failing, "2.0.0", "expand");
      expect(opened.error).toMatchObject({ code: "E1" });
      const state = await readSchema(db, failing);
      expect(names(state.pending)).toContain("0010-fails");
      expect(names(state.applied)).not.toContain("0010-fails");

      const later = laterSteps(database, {
        "0010-fails": { tag: "contract", minEngine: "2.0.0", up: fails },
      });
      const error: unknown = await migrateSchema(db, database.kind, later, "2.0.0", {
        contract: true,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SchemaStepError);
      expect((error as Error).message).toBe("a schema step failed");
    });

    it("refuses a step it does not know that schema_info does not record", async () => {
      const db = await connect(database);
      const own = recordedSteps(migrations(database.kind), "1.0.0", () => T0);
      await openSchema(db, database.kind, own, "1.0.0", "expand");
      await (db as Kysely<{ kysely_migration: { name: string; timestamp: string } }>)
        .insertInto("kysely_migration")
        .values({ name: "0099-unrecorded", timestamp: T0.toISOString() })
        .execute();
      await expect(readSchema(db, own)).rejects.toThrow(UnrecordedStepError);
    });
  });
}
