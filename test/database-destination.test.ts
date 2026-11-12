import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Kysely, sql, type Dialect } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import type {
  DatabaseDestination as DatabaseConfig,
  DatabaseStorage,
} from "../src/config/schema.js";
import type { Env } from "../src/connectors/endpoint.js";
import {
  DatabaseDeliveryError,
  DatabaseDestination,
  databaseFailure,
  timeoutStatement,
} from "../src/connectors/database.js";
import { parseStatement } from "../src/connectors/sql-statement.js";
import { DeliveryRejected } from "../src/connectors/types.js";
import { connectorsFor, Engine } from "../src/engine/engine.js";
import { secretUses } from "../src/secrets/sources.js";
import { dialectFor } from "../src/storage/dialects.js";
import { Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  freshDatabase,
  TEST_DATABASES,
  type TestDatabase,
} from "./databases.js";
import { captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

const opened: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const each of opened.splice(0)) await each.stop();
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

/** A synthetic output: no real patient, and text a naive substitution would break on. */
const OUTPUT =
  "MSH|^~\\&|LAB|SYN|||20261111||ORU^R01|SYN-0001|P|2.5\rOBX|1|ST|NOTE||it's :seq; -- not SQL";

/** A database for one test: a SQLite file in a fresh folder, or a fresh database on a server. */
async function target(database: TestDatabase): Promise<{ storage: DatabaseStorage; env: Env }> {
  if (database.kind === "sqlite") {
    return { storage: { kind: "sqlite", file: join(await makeProject({}), "out.db") }, env: {} };
  }
  const fresh = await freshDatabase(database);
  return { storage: fresh.storage, env: fresh.env };
}

/** A Kysely over `storage`, closed after the test. */
async function connect(storage: DatabaseStorage, env: Env): Promise<Kysely<unknown>> {
  const db = new Kysely<unknown>({ dialect: await dialectFor(storage, { env }) });
  opened.push({ stop: () => db.destroy() });
  return db;
}

const TEXT = { postgres: "text", mysql: "longtext", sqlserver: "nvarchar(max)", sqlite: "text" };

/** The results and scores tables, strict on SQLite so that a value of the wrong type is refused. */
async function createTables(db: Kysely<unknown>, kind: DatabaseStorage["kind"]): Promise<void> {
  const strict = kind === "sqlite" ? sql.raw(" strict") : sql.raw("");
  const big = sql.raw(kind === "sqlite" ? "integer" : "bigint");
  await sql`create table results (message_id ${big} not null, seq int not null, body ${sql.raw(TEXT[kind])} not null, primary key (message_id, seq))${strict}`.execute(
    db,
  );
  await sql`create table scores (score int not null)${strict}`.execute(db);
}

/** An insert that does nothing when the row is there already, as each database writes it. */
const IDEMPOTENT: Record<DatabaseStorage["kind"], string> = {
  postgres:
    "insert into results (message_id, seq, body) values (:messageId, :seq, :output) on conflict (message_id, seq) do nothing",
  sqlite:
    "insert into results (message_id, seq, body) values (:messageId, :seq, :output) on conflict (message_id, seq) do nothing",
  mysql:
    "insert into results (message_id, seq, body) values (:messageId, :seq, :output) on duplicate key update message_id = message_id",
  sqlserver:
    "insert into results (message_id, seq, body) select :messageId, :seq, :output where not exists (select 1 from results where message_id = :messageId and seq = :seq)",
};

const INSERT = "insert into results (message_id, seq, body) values (:messageId, :seq, :output)";

/** What each database's refusal of a duplicate key, and of a value of the wrong type, is named. */
const DUPLICATE: Record<string, string> = {
  postgres: "sqlstate 23505",
  mysql: "mysql 1062",
  mariadb: "mysql 1062",
  sqlserver: "sqlserver 2627",
  sqlite: "sqlite SQLITE_CONSTRAINT_PRIMARYKEY",
};
const WRONG_TYPE: Record<string, string> = {
  postgres: "sqlstate 22P02",
  mysql: "mysql 1366",
  mariadb: "mysql 1366",
  sqlserver: "sqlserver 245",
  sqlite: "sqlite SQLITE_CONSTRAINT_DATATYPE",
};

/** A destination on `storage` running `text`, stopped after the test. */
async function destination(
  storage: DatabaseStorage,
  env: Env,
  text: string,
  options: { expectRows?: number; statementTimeoutMs?: number; dialect?: Dialect } = {},
): Promise<DatabaseDestination> {
  const made = new DatabaseDestination({
    kind: storage.kind,
    dialect: options.dialect ?? (await dialectFor(storage, { env })),
    statement: parseStatement(text, storage.kind),
    expectRows: options.expectRows,
    statementTimeoutMs: options.statementTimeoutMs ?? 10_000,
  });
  opened.push(made);
  return made;
}

const body = (text: string): Uint8Array => new TextEncoder().encode(text);

/** What `promise` rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("it resolved");
}

async function rows(
  db: Kysely<unknown>,
): Promise<{ message_id: unknown; seq: number; body: string }[]> {
  const result = await sql<{
    message_id: unknown;
    seq: number;
    body: string;
  }>`select message_id, seq, body from results order by message_id, seq`.execute(db);
  return result.rows;
}

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`a database destination on ${database.label}`, () => {
    it("writes each output through bound parameters, never into the SQL", async () => {
      const { storage, env } = await target(database);
      const db = await connect(storage, env);
      await createTables(db, storage.kind);
      const sink = await destination(storage, env, INSERT);
      await sink.deliver({ messageId: 7, seq: 0, body: body(OUTPUT) });
      await sink.deliver({ messageId: 7, seq: 1, body: body("") });
      expect(
        (await rows(db)).map((row) => ({ ...row, message_id: Number(row.message_id) })),
      ).toEqual([
        { message_id: 7, seq: 0, body: OUTPUT },
        { message_id: 7, seq: 1, body: "" },
      ]);
    });

    it("rejects a duplicate key and a value of the wrong type for good, naming only the code", async () => {
      const { storage, env } = await target(database);
      const db = await connect(storage, env);
      await createTables(db, storage.kind);
      const sink = await destination(storage, env, INSERT);
      await sink.deliver({ messageId: 1, seq: 0, body: body(OUTPUT) });
      const duplicate = await rejection(sink.deliver({ messageId: 1, seq: 0, body: body(OUTPUT) }));
      expect(duplicate).toBeInstanceOf(DeliveryRejected);
      expect((duplicate as DeliveryRejected).reason).toBe(DUPLICATE[database.label]);

      const scores = await destination(storage, env, "insert into scores (score) values (:output)");
      const wrong = await rejection(
        scores.deliver({ messageId: 2, seq: 0, body: body("SYN-not-a-number") }),
      );
      expect(wrong).toBeInstanceOf(DeliveryRejected);
      expect((wrong as DeliveryRejected).reason).toBe(WRONG_TYPE[database.label]);
      expect(JSON.stringify(wrong)).not.toContain("SYN");
      expect((wrong as Error).message).not.toContain("SYN");
    });

    it("stores an output once when it is sent again, with the insert written to skip it", async () => {
      const { storage, env } = await target(database);
      const db = await connect(storage, env);
      await createTables(db, storage.kind);
      const sink = await destination(storage, env, IDEMPOTENT[storage.kind]);
      await sink.deliver({ messageId: 3, seq: 0, body: body(OUTPUT) });
      await sink.deliver({
        messageId: 3,
        seq: 0,
        body: body(OUTPUT),
        resend: { previousAttempts: 1 },
      });
      expect(await rows(db)).toHaveLength(1);
    });

    it("rejects a statement that changes a count of rows other than expectRows, and rolls it back", async () => {
      const { storage, env } = await target(database);
      const db = await connect(storage, env);
      await createTables(db, storage.kind);
      const insert = await destination(storage, env, INSERT);
      await insert.deliver({ messageId: 4, seq: 0, body: body("first") });
      await insert.deliver({ messageId: 5, seq: 0, body: body("second") });
      const update = await destination(
        storage,
        env,
        "update results set body = :output where seq = :seq",
        { expectRows: 1 },
      );
      const tooMany = await rejection(
        update.deliver({ messageId: 6, seq: 0, body: body("changed") }),
      );
      expect((tooMany as DeliveryRejected).reason).toBe("expectRows 1, changed 2");
      const none = await rejection(update.deliver({ messageId: 6, seq: 9, body: body("changed") }));
      expect((none as DeliveryRejected).reason).toBe("expectRows 1, changed 0");
      expect((await rows(db)).map((row) => row.body)).toEqual(["first", "second"]);

      // A statement that changes no rows by its kind reports no count, which no expectRows matches.
      const select = await destination(storage, env, "select :seq as seq", { expectRows: 0 });
      const counted = await rejection(select.deliver({ messageId: 6, seq: 0, body: body("") }));
      expect((counted as DeliveryRejected).reason).toMatch(/^expectRows 0, changed (none|0|1|-1)$/);
    });

    it.skipIf(database.kind === "sqlite")(
      "retries a statement held past its timeout by another transaction's lock, naming the code",
      async () => {
        const { storage, env } = await target(database);
        const db = await connect(storage, env);
        await createTables(db, storage.kind);
        await sql`insert into results (message_id, seq, body) values (1, 0, 'held')`.execute(db);
        const update = await destination(
          storage,
          env,
          "update results set body = :output where message_id = :messageId",
          { statementTimeoutMs: 1_000 },
        );
        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked = (): void => undefined;
        const holding = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const holder = db.transaction().execute(async (trx) => {
          await sql`update results set body = 'locked' where message_id = 1`.execute(trx);
          locked();
          await held;
        });
        await holding;
        const failed = await rejection(update.deliver({ messageId: 1, seq: 0, body: body("x") }));
        release();
        await holder;
        expect(failed).toBeInstanceOf(DatabaseDeliveryError);
        expect((failed as DatabaseDeliveryError).code).toBe(
          { postgres: "57014", mysql: "ER_LOCK_WAIT_TIMEOUT", sqlserver: "SQLSERVER_1222" }[
            storage.kind as "postgres"
          ],
        );
      },
      20_000,
    );

    it("runs on the engine: a file in, a row out", async () => {
      const { storage, env } = await target(database);
      const db = await connect(storage, env);
      await createTables(db, storage.kind);
      const block =
        storage.kind === "sqlite"
          ? `sqlite: { file: ${storage.file} }`
          : `${storage.kind}: { url: { env: RESULTS_DB_URL }, plaintext: true, pool: { max: 1 } }`;
      const root = await makeProject({
        "channels/results/channel.yaml": [
          "source:",
          "  file: { dir: ../../data/inbox, minAge: 0 }",
          "destinations:",
          "  - database:",
          `      ${block}`,
          "      statement: ./insert.sql",
          "      expectRows: 1",
          "",
        ].join("\n"),
        "channels/results/insert.sql": `-- one row per output\n${INSERT};\n`,
      });
      const project = await loadProject(root);
      const store = await Store.open(project.databaseFile);
      const { logger, lines } = captureLogger();
      const urlEnv =
        storage.kind === "sqlite" ? {} : { RESULTS_DB_URL: Object.values(env)[0] ?? "" };
      const engine = new Engine({ project, store, logger, env: urlEnv });
      opened.push({
        stop: async () => {
          await engine.stop();
          await store.close();
        },
      });
      await engine.start();
      await dropFile(join(root, "data", "inbox", "result.hl7"), OUTPUT);
      await engine.tick();
      expect(await store.deliveryCounts("results")).toEqual({
        pending: 0,
        delivered: 1,
        failed: 0,
        cleared: 0,
      });
      const written = await rows(db);
      expect(written).toHaveLength(1);
      expect(written[0]?.body).toMatch(/^MSH\|\^~\\&\|LAB\|SYN\|/);
      expect(lines.join("")).not.toContain("SYN-0001");
    });
  });
}

describe("loading a database destination", () => {
  async function load(statement: string, files: Record<string, string> = {}): Promise<unknown> {
    const root = await makeProject({
      "channels/results/channel.yaml": [
        "source:",
        "  file: { dir: ./in }",
        "destinations:",
        "  - file: { dir: ./out }",
        "  - database:",
        "      postgres: { url: { env: RESULTS_DB_URL }, tls: {} }",
        `      statement: ${statement}`,
        "",
      ].join("\n"),
      ...files,
    });
    try {
      return await loadProject(root);
    } catch (error) {
      return (error as ConfigError).problems;
    }
  }

  it("resolves the block, with a small pool and every default filled in", async () => {
    const root = await makeProject({
      "channels/results/channel.yaml": [
        "source:",
        "  file: { dir: ./in }",
        "destinations:",
        "  - database:",
        "      mysql: { url: { env: RESULTS_DB_URL }, plaintext: true }",
        "      statement: ./insert.sql",
        "  - database:",
        "      sqlserver:",
        "        url: { file: ./db-url }",
        "        tls: { ca: ./ca.pem }",
        "        pool: { max: 4, idleTimeout: 5s }",
        "        connectTimeout: 3s",
        "      statement: ./insert.sql",
        "      expectRows: 1",
        "      statementTimeout: 2s",
        "    timeout: 5s",
        "  - database:",
        "      sqlite: { file: ./out.db }",
        "      statement: ./insert.sql",
        "",
      ].join("\n"),
      "channels/results/insert.sql": INSERT,
    });
    const project = await loadProject(root);
    const dir = join(root, "channels", "results");
    expect(project.channels[0]?.destinations).toEqual([
      {
        kind: "database",
        database: {
          kind: "mysql",
          url: { env: "RESULTS_DB_URL" },
          tls: undefined,
          plaintext: true,
          pool: { max: 2, idleTimeoutMs: 30_000 },
          connectTimeoutMs: 10_000,
        },
        statement: join(dir, "insert.sql"),
        expectRows: undefined,
        statementTimeoutMs: 10_000,
      },
      {
        kind: "database",
        database: {
          kind: "sqlserver",
          url: { file: join(dir, "db-url") },
          tls: { ca: join(dir, "ca.pem"), cert: undefined, key: undefined },
          plaintext: false,
          pool: { max: 4, idleTimeoutMs: 5_000 },
          connectTimeoutMs: 3_000,
        },
        statement: join(dir, "insert.sql"),
        expectRows: 1,
        statementTimeoutMs: 2_000,
        timeoutMs: 5_000,
      },
      {
        kind: "database",
        database: { kind: "sqlite", file: join(dir, "out.db") },
        statement: join(dir, "insert.sql"),
        expectRows: undefined,
        statementTimeoutMs: 10_000,
      },
    ]);
    // The URL is a secret a start reads; a destination that runs dry is left out, as is SQLite.
    expect(secretUses(project, "all").map(({ where }) => where)).toEqual([
      "channels/results/channel.yaml: destinations.0.database.mysql.url",
      "channels/results/channel.yaml: destinations.1.database.sqlserver.url",
    ]);
    expect(secretUses(project, "all", "all")).toEqual([]);
  });

  it("refuses a statement that names a parameter it does not bind, or holds two statements", async () => {
    expect(
      await load("./insert.sql", {
        "channels/results/insert.sql": "insert into t values (:messageId,\n:patientName)",
      }),
    ).toEqual([
      "channels/results/channel.yaml: destinations.1.database.statement: line 2: :patientName is not a parameter Pathways binds; use :messageId, :seq, :output",
    ]);
    expect(
      await load("./insert.sql", {
        "channels/results/insert.sql": "insert into t values (:seq); drop table t",
      }),
    ).toEqual([
      "channels/results/channel.yaml: destinations.1.database.statement: line 1: a second statement; a statement file holds one statement",
    ]);
  });

  it("refuses a statement file that is missing or outside the project", async () => {
    expect(await load("./missing.sql")).toEqual([
      "channels/results/channel.yaml: destinations.1.database.statement: the file does not exist or cannot be read",
    ]);
    const outside = await makeProject({ "insert.sql": INSERT });
    expect(await load(join(outside, "insert.sql"))).toEqual([
      "channels/results/channel.yaml: destinations.1.database.statement: the file is outside the project; keep statement files inside it",
    ]);
  });

  it("refuses a block with no database or two, a server with neither tls nor plaintext, and a URL in the YAML", async () => {
    const problems = async (block: string[]): Promise<unknown> => {
      const root = await makeProject({
        "channels/results/channel.yaml": [
          "source:",
          "  file: { dir: ./in }",
          "destinations:",
          "  - database:",
          ...block.map((line) => `      ${line}`),
          "",
        ].join("\n"),
        "channels/results/insert.sql": INSERT,
      });
      try {
        await loadProject(root);
      } catch (error) {
        return (error as ConfigError).problems.join("\n");
      }
      throw new Error("the project loaded");
    };
    expect(await problems(["statement: ./insert.sql"])).toContain(
      "name exactly one of: sqlite, postgres, mysql, sqlserver",
    );
    expect(
      await problems([
        "sqlite: { file: ./a.db }",
        "postgres: { url: { env: A }, plaintext: true }",
        "statement: ./insert.sql",
      ]),
    ).toContain("name exactly one of: sqlite, postgres, mysql, sqlserver");
    expect(await problems(["postgres: { url: { env: A } }", "statement: ./insert.sql"])).toContain(
      "tls: {}",
    );
    expect(
      await problems([
        "postgres: { url: postgres://db.example.test/x, plaintext: true }",
        "statement: ./insert.sql",
      ]),
    ).toContain("never goes in the YAML");
    expect(
      await problems([
        "sqlite: { file: ./a.db }",
        "statement: ./insert.sql",
        "statementTimeout: 0",
      ]),
    ).toContain("a duration of at least 1ms");
  });
});

describe("building a database destination at start", () => {
  async function project(sqlText: string): Promise<{ root: string; channel: DatabaseConfig }> {
    const root = await makeProject({
      "channels/results/channel.yaml": [
        "source:",
        "  file: { dir: ./in }",
        "destinations:",
        "  - database:",
        "      sqlite: { file: ./out.db }",
        "      statement: ./insert.sql",
        "",
      ].join("\n"),
      "channels/results/insert.sql": sqlText,
    });
    const loaded = await loadProject(root);
    return { root, channel: loaded.channels[0]?.destinations[0] as DatabaseConfig };
  }

  it("refuses a statement file changed since the project loaded, naming the key", async () => {
    const { root } = await project(INSERT);
    const loaded = await loadProject(root);
    await writeFile(join(root, "channels/results/insert.sql"), "select :mrn");
    const { logger } = captureLogger();
    await expect(
      connectorsFor(loaded.channels[0] as never, { now: Date.now, logger, env: {} }),
    ).rejects.toThrow(
      new ConfigError([
        "channels/results/channel.yaml: destinations.0.database.statement: line 1: :mrn is not a parameter Pathways binds; use :messageId, :seq, :output",
      ]),
    );
  });

  it("names the destination's key when its URL is not set", async () => {
    const root = await makeProject({
      "channels/results/channel.yaml": [
        "source:",
        "  file: { dir: ./in }",
        "destinations:",
        "  - database:",
        "      postgres: { url: { env: RESULTS_DB_URL }, plaintext: true }",
        "      statement: ./insert.sql",
        "",
      ].join("\n"),
      "channels/results/insert.sql": INSERT,
    });
    const loaded = await loadProject(root);
    const { logger } = captureLogger();
    await expect(
      connectorsFor(loaded.channels[0] as never, { now: Date.now, logger, env: {} }),
    ).rejects.toThrow(
      "channels/results/channel.yaml: destinations.0.database.postgres.url: the environment variable RESULTS_DB_URL is not set",
    );
  });

  it("warns at start of a server reached without TLS", async () => {
    const root = await makeProject({
      "channels/results/channel.yaml": [
        "source:",
        "  file: { dir: ./in }",
        "destinations:",
        "  - database:",
        "      postgres: { url: { env: RESULTS_DB_URL }, plaintext: true }",
        "      statement: ./insert.sql",
        "  - database:",
        "      sqlite: { file: ./out.db }",
        "      statement: ./insert.sql",
        "",
      ].join("\n"),
      "channels/results/insert.sql": INSERT,
    });
    const loaded = await loadProject(root);
    const store = await Store.open(loaded.databaseFile);
    const { logger, events } = captureLogger();
    const engine = new Engine({
      project: loaded,
      store,
      logger,
      // Nothing listens on port 1: the pool connects on the first delivery, never at start.
      env: { RESULTS_DB_URL: "postgres://synthetic:synthetic@127.0.0.1:1/results" },
    });
    opened.push({
      stop: async () => {
        await engine.stop();
        await store.close();
      },
    });
    await engine.start();
    expect(events.filter((event) => event.event === "plaintext")).toEqual([
      expect.objectContaining({ endpoint: "destination", destination: 0, channel: "results" }),
    ]);
  });
});

describe("a database destination's failures", () => {
  it("retries a server it cannot reach, with the connection's code", async () => {
    const storage: DatabaseStorage = {
      kind: "postgres",
      url: { env: "URL" },
      tls: undefined,
      plaintext: true,
      pool: { max: 1, idleTimeoutMs: 1_000 },
      connectTimeoutMs: 2_000,
    };
    const sink = await destination(
      storage,
      { URL: "postgres://synthetic:synthetic@127.0.0.1:1/results" },
      INSERT,
    );
    const failed = await rejection(sink.deliver({ messageId: 1, seq: 0, body: body(OUTPUT) }));
    expect(failed).toEqual(new DatabaseDeliveryError("ECONNREFUSED"));
    expect((failed as DatabaseDeliveryError).code).toBe("ECONNREFUSED");
  });

  it("rejects an output that is not UTF-8 before it opens a connection", async () => {
    const sink = await destination(
      { kind: "sqlite", file: join(await makeProject({}), "never.db") },
      {},
      INSERT,
    );
    const failed = await rejection(
      sink.deliver({ messageId: 1, seq: 0, body: new Uint8Array([0xff, 0xfe]) }),
    );
    expect(failed).toEqual(new DeliveryRejected("output is not UTF-8"));
  });

  it("rejects a statement whose parameter has no value", async () => {
    const storage: DatabaseStorage = {
      kind: "sqlite",
      file: join(await makeProject({}), "out.db"),
    };
    const sink = new DatabaseDestination({
      kind: "sqlite",
      dialect: await dialectFor(storage, { env: {} }),
      statement: parseStatement("select :mrn", "sqlite", ["mrn"]),
      statementTimeoutMs: 1_000,
    });
    opened.push(sink);
    const failed = await rejection(sink.deliver({ messageId: 1, seq: 0, body: body("") }));
    expect(failed).toEqual(new DeliveryRejected(":mrn has no value"));
  });

  it("names each server's data and constraint errors as rejections, and everything else by code", () => {
    const error = (fields: Record<string, unknown>): Error =>
      Object.assign(new Error("SYN-0001 quoted by the driver"), fields);
    const reason = (kind: DatabaseStorage["kind"], thrown: unknown): string => {
      const result = databaseFailure(kind, thrown);
      expect(result.message).not.toContain("SYN");
      return result instanceof DeliveryRejected
        ? `rejected ${result.reason}`
        : `retried ${(result as DatabaseDeliveryError).code}`;
    };
    expect(reason("postgres", error({ code: "23503" }))).toBe("rejected sqlstate 23503");
    expect(reason("postgres", error({ code: "22001" }))).toBe("rejected sqlstate 22001");
    expect(reason("postgres", error({ code: "40P01" }))).toBe("retried 40P01");
    expect(reason("postgres", error({ code: "ECONNRESET" }))).toBe("retried ECONNRESET");
    expect(reason("mysql", error({ code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000" }))).toBe(
      "rejected mysql 1062",
    );
    expect(
      reason(
        "mysql",
        error({ code: "ER_CHECK_CONSTRAINT_VIOLATED", errno: 3819, sqlState: "HY000" }),
      ),
    ).toBe("rejected mysql 3819");
    expect(
      reason("mysql", error({ code: "ER_LOCK_DEADLOCK", errno: 1213, sqlState: "40001" })),
    ).toBe("retried ER_LOCK_DEADLOCK");
    expect(reason("mysql", error({ code: "PROTOCOL_CONNECTION_LOST" }))).toBe(
      "retried PROTOCOL_CONNECTION_LOST",
    );
    const server = (number: number): Error => error({ code: "EREQUEST", number });
    expect(reason("sqlserver", server(547))).toBe("rejected sqlserver 547");
    expect(reason("sqlserver", server(1205))).toBe("retried SQLSERVER_1205");
    // tedious reports the server's error and "the statement has been terminated" together.
    expect(reason("sqlserver", new AggregateError([server(2627), server(3621)]))).toBe(
      "rejected sqlserver 2627",
    );
    expect(reason("sqlserver", new AggregateError([error({ code: "ESOCKET" })]))).toBe(
      "retried ESOCKET",
    );
    expect(reason("sqlserver", new AggregateError([]))).toBe("retried DATABASE_ERROR");
    expect(reason("sqlserver", error({ code: "ETIMEOUT" }))).toBe("retried ETIMEOUT");
    expect(reason("sqlite", error({ code: "SQLITE_CONSTRAINT_NOTNULL" }))).toBe(
      "rejected sqlite SQLITE_CONSTRAINT_NOTNULL",
    );
    expect(reason("sqlite", error({ code: "SQLITE_MISMATCH" }))).toBe(
      "rejected sqlite SQLITE_MISMATCH",
    );
    expect(reason("sqlite", error({ code: "SQLITE_TOOBIG" }))).toBe(
      "rejected sqlite SQLITE_TOOBIG",
    );
    expect(reason("sqlite", error({ code: "SQLITE_BUSY" }))).toBe("retried SQLITE_BUSY");
    expect(reason("sqlite", error({ code: "has spaces in it" }))).toBe("retried DATABASE_ERROR");
    expect(reason("sqlite", error({ code: 5 }))).toBe("retried DATABASE_ERROR");
    expect(reason("postgres", "a thrown string")).toBe("retried DATABASE_ERROR");
    expect(reason("mysql", undefined)).toBe("retried DATABASE_ERROR");
    const rejected = new DeliveryRejected("expectRows 1, changed 0");
    expect(databaseFailure("postgres", rejected)).toBe(rejected);
  });

  it("bounds the statement on each server", () => {
    expect(timeoutStatement("postgres", 10_000)).toBe("set local statement_timeout = 10000");
    expect(timeoutStatement("postgres", 0.5)).toBe("set local statement_timeout = 1");
    expect(timeoutStatement("mysql", 10_000)).toBe("set session innodb_lock_wait_timeout = 10");
    expect(timeoutStatement("mysql", 1_500)).toBe("set session innodb_lock_wait_timeout = 2");
    expect(timeoutStatement("mysql", 200)).toBe("set session innodb_lock_wait_timeout = 1");
    expect(timeoutStatement("sqlserver", 2_000)).toBe("set lock_timeout 2000");
    expect(timeoutStatement("sqlite", 2_000)).toBeUndefined();
  });
});
