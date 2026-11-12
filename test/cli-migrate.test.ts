// `pathways migrate` and `pathways start --no-migrate`, run in this process on SQLite: steps printed
// with their tags, a dry run that applies nothing, every run audited, a schema a newer Pathways
// moved forward left as it is, and every refusal naming both versions. The contract-step paths
// (waiting steps, the rollback window, a failed step) run against a stand-in for the store's own
// migrate, since this version ships no contract step; test/schema-steps.test.ts runs them for real
// on every database.
import { join } from "node:path";

import SqliteDatabase from "better-sqlite3";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { loadProject } from "../src/config/load.js";
import { generateKey } from "../src/encryption/keys.js";
import { AuditLog } from "../src/operator/audit.js";
import { migrateCommand, type OperatorContext } from "../src/operator/commands.js";
import {
  SchemaStepError,
  SchemaVersionError,
  type MigrateOptions,
  type MigrationReport,
  type SchemaState,
} from "../src/storage/schema.js";
import { Store, type AuditEntry } from "../src/storage/store.js";
import { VERSION } from "../src/version.js";
import { MEMORY_STORE_FILE } from "./extension-helpers.js";
import { ADT_A01, cleanUp, dropFile, makeProject } from "./helpers.js";

afterEach(cleanUp);

const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";
const CHANNEL =
  "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ndestinations:\n  - file: { dir: ../../data/out }\n";
const STEPS = 12;

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly audit: AuditEntry[];
}

async function cli(argv: readonly string[]): Promise<Result> {
  let out = "";
  let err = "";
  const audit: AuditEntry[] = [];
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    logger: pino({ level: "silent" }),
    onAudit: (entry) => {
      audit.push(entry);
    },
  });
  return { code, out, err, audit };
}

/** A project on SQLite with one file channel, `yaml` after its keys, and one message waiting. */
async function project(yaml = ""): Promise<string> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": `${KEYS}${yaml}`,
    "channels/adt/channel.yaml": CHANNEL,
  });
  await dropFile(join(root, "data/inbox/a01.hl7"), ADT_A01);
  return root;
}

const dbFile = (root: string): string => join(root, ".pathways/pathways.db");

/** Records a step a newer Pathways applied, as it records one. */
function newerStep(root: string, tag: "expand" | "contract", minEngine: string): void {
  const db = new SqliteDatabase(dbFile(root));
  // Later than this version's own steps, as a newer Pathways' would be.
  const at = "2099-01-01T00:00:00.000Z";
  db.prepare("insert into kysely_migration values (?, ?)").run("0099-from-pathways-99", at);
  db.prepare("insert into schema_info values (?, ?, ?, ?, ?, ?)").run(
    "0099-from-pathways-99",
    99,
    tag,
    minEngine,
    "99.0.0",
    at,
  );
  db.close();
}

describe("pathways migrate", () => {
  it("says what a dry run would apply, then applies it, each step with its tag, and audits it", async () => {
    const root = await project();
    const dry = await cli(["migrate", "--dry-run", "-C", root]);
    expect(dry).toMatchObject({ code: EXIT.ok, err: "" });
    const lines = dry.out.split("\n");
    expect(lines[0]).toBe(`The database has no schema yet; this is Pathways ${VERSION}.`);
    expect(lines[1]).toBe(`Would apply ${STEPS} steps:`);
    expect(lines[2]).toMatch(/^ {2}1 +0001-messages-and-deliveries +expand$/);
    expect(lines[8]).toMatch(/^ {2}7 +0007-schema-info +expand$/);
    expect(lines[9]).toMatch(/^ {2}8 +0008-content-drop +expand$/);
    expect(lines[10]).toMatch(/^ {2}9 +0009-channel-states +expand$/);
    expect(lines[11]).toMatch(/^ {2}10 +0010-message-meta +expand$/);
    expect(lines[12]).toMatch(/^ {2}11 +0011-delivery-failed-at +expand$/);
    expect(lines[13]).toMatch(/^ {2}12 +0012-settled +expand$/);
    // An empty database has no audit log to write the dry run to, and says so.
    expect(lines[14]).toBe("Not written to the audit log: the database has none yet.");
    expect(dry.audit).toEqual([]);
    // The dry run applied nothing, and opening the store for it applied nothing either.
    const fresh = await cli(["migrate", "--json", "-C", root]);
    expect(fresh.audit).toMatchObject([
      {
        action: "migrate",
        outcome: "ok",
        detail: {
          engine: VERSION,
          from: 0,
          to: STEPS,
          steps: STEPS,
          contract: false,
          dryRun: false,
        },
      },
    ]);
    expect(JSON.parse(fresh.out)).toMatchObject({
      engine: VERSION,
      before: { generation: 0 },
      after: { generation: STEPS, minEngine: "0.0.1", changedBy: VERSION },
      dryRun: false,
      waiting: [],
      audited: true,
    });
    expect((JSON.parse(fresh.out) as { steps: unknown[] }).steps).toHaveLength(STEPS);

    const again = await cli(["migrate", "--contract", "-C", root]);
    expect(again).toMatchObject({ code: EXIT.ok, err: "" });
    expect(again.out).toBe(
      `Schema generation ${STEPS}, last changed by Pathways ${VERSION}; this is Pathways ${VERSION}.\nNothing to apply.\n`,
    );
    expect(again.audit[0]?.detail).toMatchObject({
      from: STEPS,
      to: STEPS,
      steps: 0,
      contract: true,
    });
  });

  it("leaves a schema a newer Pathways moved forward as it is", async () => {
    const root = await project();
    expect((await cli(["migrate", "-C", root])).code).toBe(EXIT.ok);
    newerStep(root, "expand", "0.0.1");
    const result = await cli(["migrate", "-C", root]);
    expect(result).toMatchObject({ code: EXIT.ok, err: "" });
    expect(result.out).toBe(
      `Schema generation 99, last changed by Pathways 99.0.0; this is Pathways ${VERSION}.\nIt is newer than this Pathways ${VERSION} knows: nothing to apply.\n`,
    );
    // And the engine runs on it.
    expect((await cli(["start", "--once", "-C", root])).code).toBe(EXIT.ok);
  });

  it("refuses a schema contracted past this version, in migrate and every command, naming both versions", async () => {
    const root = await project();
    expect((await cli(["migrate", "-C", root])).code).toBe(EXIT.ok);
    newerStep(root, "contract", "99.0.0");
    const refusal = `pathways: the database schema is generation 99 and needs Pathways 99.0.0 or later; this is Pathways ${VERSION}.\n`;
    const migrate = await cli(["migrate", "-C", root]);
    expect(migrate).toMatchObject({ code: EXIT.failed, out: "", err: refusal });
    expect(migrate.audit).toMatchObject([
      {
        action: "migrate",
        outcome: "refused",
        detail: {
          reason: "engine-too-old",
          engine: VERSION,
          schema: "99.0.0",
          generation: 99,
        },
      },
    ]);
    for (const argv of [["start", "--once"], ["status"]]) {
      expect(await cli([...argv, "-C", root])).toMatchObject({
        code: EXIT.failed,
        out: "",
        err: refusal,
      });
    }
  });

  it("refuses a custom store, which keeps its own schema", async () => {
    const root = await project(`storage: { module: ${MEMORY_STORE_FILE} }\n`);
    expect(await cli(["migrate", "-C", root])).toMatchObject({
      code: EXIT.failed,
      out: "",
      err: "pathways: pathways.yaml: storage.module: migrate changes the schema of the built-in stores; a custom store keeps its own.\n",
    });
  });

  it("refuses an argument, and options of other commands", async () => {
    const root = await project();
    expect((await cli(["migrate", "now", "-C", root])).code).toBe(EXIT.usage);
    expect((await cli(["migrate", "--once", "-C", root])).code).toBe(EXIT.usage);
    expect((await cli(["status", "--contract", "-C", root])).code).toBe(EXIT.usage);
  });

  it("says in the help that --contract does not see which versions other engines run", async () => {
    const { code, out } = await cli(["--help"]);
    expect(code).toBe(EXIT.ok);
    expect(out.replace(/\s+/g, " ")).toContain(
      "--contract migrate: apply contract steps too, unless the schema changed within migrations.rollbackWindow. It does not see which versions other engines run: stop or upgrade them first",
    );
  });

  it("says why a database will not open for it", async () => {
    const root = await project("storage:\n  sqlite: { file: ./a-file/pathways.db }\n");
    await dropFile(join(root, "a-file"), "");
    expect(await cli(["migrate", "-C", root])).toMatchObject({
      code: EXIT.failed,
      err: "pathways: the database could not be opened (EEXIST).\n",
    });
  });
});

describe("pathways start --no-migrate", () => {
  it("refuses a database that lacks a step this version needs, naming both versions, until migrate applies it", async () => {
    const root = await project();
    const empty = await cli(["start", "--once", "--no-migrate", "-C", root]);
    expect(empty).toMatchObject({
      code: EXIT.failed,
      out: "",
      err: `pathways: the database schema is empty (generation 0); this is Pathways ${VERSION}, which needs generation ${STEPS}. Run pathways migrate first, or start without --no-migrate.\n`,
    });
    expect((await cli(["migrate", "-C", root])).code).toBe(EXIT.ok);
    expect((await cli(["start", "--once", "--no-migrate", "-C", root])).code).toBe(EXIT.ok);
  });

  it("names the generation and the Pathways that last changed an older schema", async () => {
    const root = await project();
    expect((await cli(["migrate", "-C", root])).code).toBe(EXIT.ok);
    // Back to the schema before schema_info, as the version before left it.
    const db = new SqliteDatabase(dbFile(root));
    db.exec(
      "drop table schema_info; drop table channel_states; drop table meta_index; delete from kysely_migration where name in ('0007-schema-info', '0008-content-drop', '0009-channel-states', '0010-message-meta', '0011-delivery-failed-at', '0012-settled'); alter table messages drop column content_hash; alter table messages drop column content_dropped_at; alter table messages drop column meta; alter table deliveries drop column failed_at; alter table messages drop column settled_generation",
    );
    db.close();
    expect((await cli(["start", "--once", "--no-migrate", "-C", root])).err).toBe(
      `pathways: the database schema is generation 6, last changed by Pathways 0.0.1; this is Pathways ${VERSION}, which needs generation ${STEPS}. Run pathways migrate first, or start without --no-migrate.\n`,
    );
  });

  it("is an option of start alone", async () => {
    const root = await project();
    expect((await cli(["status", "--no-migrate", "-C", root])).code).toBe(EXIT.usage);
  });
});

describe("migrateCommand", () => {
  const state = (generation: number, changedAt?: string): SchemaState => ({
    generation,
    minEngine: "0.0.1",
    changedBy: "0.0.1",
    changedAt,
    applied: [{ name: "0003-operator-and-audit", generation: 3, tag: "expand" }],
    unknown: [],
    pending: [],
  });
  const contractStep = { name: "0008-example", generation: 8, tag: "contract" as const };

  async function context(
    yaml = "",
    migrate: "expand" | "inspect" = "expand",
  ): Promise<{
    context: OperatorContext;
    out: string[];
    err: string[];
    store: Store;
  }> {
    const root = await project(yaml);
    const store = await Store.open(":memory:", { migrate });
    const out: string[] = [];
    const err: string[] = [];
    return {
      context: {
        project: await loadProject(root),
        store,
        audit: new AuditLog(store, { actor: "tester" }),
        json: false,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        now: () => Date.parse("2026-11-11T01:00:00.000Z"),
      },
      out,
      err,
      store,
    };
  }

  it("passes the rollback window and the time, and lists contract steps left waiting", async () => {
    const { context: ctx, out, store } = await context("migrations:\n  rollbackWindow: 7d\n");
    let seen: MigrateOptions | undefined;
    const code = await migrateCommand(
      ctx,
      (options) => {
        seen = options;
        return Promise.resolve({
          before: state(7),
          after: state(7),
          steps: [],
          waiting: [contractStep],
          dryRun: false,
        } satisfies MigrationReport);
      },
      { contract: false, dryRun: false },
    );
    expect(code).toBe(EXIT.ok);
    expect(seen).toEqual({
      contract: false,
      dryRun: false,
      rollbackWindowMs: 7 * 86_400_000,
      now: new Date("2026-11-11T01:00:00.000Z"),
    });
    expect(out.join("").split("\n").slice(1, 3)).toEqual([
      "Nothing to apply.",
      "Waiting for pathways migrate --contract: 1 contract step:",
    ]);
    expect(out.join("")).toMatch(/ {2}8 +0008-example +contract\n$/);
    await store.close();
  });

  it("refuses contract steps inside the rollback window, naming both versions, and audits it", async () => {
    const { context: ctx, out, err, store } = await context();
    const code = await migrateCommand(
      ctx,
      () =>
        Promise.resolve({
          before: state(7, "2026-11-11T00:00:00.000Z"),
          after: state(7, "2026-11-11T00:00:00.000Z"),
          steps: [contractStep],
          waiting: [],
          dryRun: false,
          refused: { reason: "rollback-window", until: "2026-11-18T00:00:00.000Z" },
        }),
      { contract: true, dryRun: false },
    );
    expect(code).toBe(EXIT.failed);
    expect(out).toEqual([]);
    expect(err.join("")).toBe(
      `pathways: contract steps wait for the rollback window: the schema last changed at 2026-11-11T00:00:00.000Z, by Pathways 0.0.1, and the window ends at 2026-11-18T00:00:00.000Z. This is Pathways ${VERSION}. Nothing was applied.\n`,
    );
    expect((await store.auditEntries({ limit: 5 })).items).toMatchObject([
      { action: "migrate", outcome: "refused", detail: { reason: "rollback-window", steps: 1 } },
    ]);
    await store.close();
  });

  it("says a step failed by its code alone, and audits it", async () => {
    const { context: ctx, err, store } = await context();
    for (const cause of [Object.assign(new Error("synthetic"), { code: "E1" }), new Error("x")]) {
      const code = await migrateCommand(ctx, () => Promise.reject(new SchemaStepError(cause)), {
        contract: false,
        dryRun: false,
      });
      expect(code).toBe(EXIT.failed);
    }
    expect(err).toEqual([
      "pathways: a schema step failed (E1).\n",
      "pathways: a schema step failed.\n",
    ]);
    expect((await store.auditEntries({ limit: 5 })).items).toMatchObject([
      { outcome: "refused", detail: { reason: "step-failed" } },
      { outcome: "refused", detail: { reason: "step-failed", code: "E1" } },
    ]);
    await store.close();
  });

  it("still reports a failed step on a database with no audit log yet", async () => {
    const { context: ctx, err, store } = await context("", "inspect");
    const code = await migrateCommand(
      ctx,
      () => Promise.reject(new SchemaStepError(new Error("synthetic"))),
      { contract: false, dryRun: false },
    );
    expect(code).toBe(EXIT.failed);
    expect(err).toEqual(["pathways: a schema step failed.\n"]);
    await store.close();
  });

  it("leaves any other error to the command's caller", async () => {
    const { context: ctx, store } = await context();
    const failure = new Error("synthetic");
    await expect(
      migrateCommand(ctx, () => Promise.reject(failure), { contract: false, dryRun: false }),
    ).rejects.toBe(failure);
    await expect(
      migrateCommand(
        ctx,
        () => Promise.reject(new SchemaVersionError("schema-too-old", state(6), VERSION, STEPS)),
        { contract: false, dryRun: false },
      ),
    ).resolves.toBe(EXIT.failed);
    await store.close();
  });
});
