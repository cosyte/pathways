import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import SqliteDatabase from "better-sqlite3";
import {
  MssqlDialect,
  MysqlDialect,
  PostgresDialect,
  SqliteDialect,
  type Dialect,
  type SqliteDatabase as KyselySqliteDatabase,
  type SqliteStatement,
} from "kysely";
import type * as Mysql2Module from "mysql2";
import type * as PgModule from "pg";
import type * as TarnModule from "tarn";
import type * as TediousModule from "tedious";

import { ConfigError } from "../config/load.js";
import type { DatabaseStorage, ServerStorage, StorageKind } from "../config/schema.js";
import { secretHolder, secretPlace, secretsOf, type SecretReader } from "../secrets/resolve.js";
import { clientTlsOptions, loadClientTls } from "../connectors/tls.js";

type Pg = typeof PgModule;
type Mysql2 = typeof Mysql2Module;
type Tedious = typeof TediousModule;
type Tarn = typeof TarnModule;

/**
 * The driver packages each database server needs. They are optional peer dependencies: a project
 * installs the one for the database it uses, and SQLite's driver ships with Pathways.
 *
 * @example
 * ```ts
 * DRIVER_PACKAGES.sqlserver; // ["tedious", "tarn"]
 * ```
 */
export const DRIVER_PACKAGES = {
  postgres: ["pg"],
  mysql: ["mysql2"],
  sqlserver: ["tedious", "tarn"],
} as const satisfies Record<Exclude<StorageKind, "sqlite">, readonly string[]>;

/**
 * One of the driver packages in {@link DRIVER_PACKAGES}.
 *
 * @example
 * ```ts
 * const name: DriverPackage = "mysql2";
 * ```
 */
export type DriverPackage = (typeof DRIVER_PACKAGES)[keyof typeof DRIVER_PACKAGES][number];

/**
 * Imports a driver package. Pathways imports each from its own `node_modules`; tests pass their own,
 * to stand in for a package that is not installed.
 *
 * @example
 * ```ts
 * const importDriver: DriverImport = (name) => import(name);
 * ```
 */
export type DriverImport = (name: DriverPackage) => Promise<unknown>;

const importDriver: DriverImport = (name) => {
  switch (name) {
    case "pg":
      return import("pg");
    case "mysql2":
      return import("mysql2");
    case "tedious":
      return import("tedious");
    case "tarn":
      return import("tarn");
  }
};

/**
 * What {@link dialectFor} reads secrets with, and, for tests, how it imports drivers.
 *
 * @example
 * ```ts
 * const options: DialectOptions = { env: process.env };
 * ```
 */
export interface DialectOptions {
  /** Where the connection URL is read from: the environment, or the secrets a start resolved. */
  readonly env: SecretReader;
  /** Imports a driver package. Defaults to a plain `import()`. */
  readonly importDriver?: DriverImport;
  /**
   * The file and key errors name, such as `channels/results/channel.yaml: destinations.0.database.postgres`.
   * Defaults to `pathways.yaml: storage.<kind>`.
   */
  readonly where?: string | undefined;
  /** On SQL Server, how long one request may run before the driver gives it up. Default 15s. */
  readonly requestTimeoutMs?: number | undefined;
}

/** The URL schemes each database server's connection URL may use; the first is the one errors name. */
const SCHEMES: Readonly<Record<ServerStorage["kind"], readonly string[]>> = {
  postgres: ["postgres:", "postgresql:"],
  mysql: ["mysql:", "mariadb:"],
  sqlserver: ["sqlserver:", "mssql:"],
};

const DEFAULT_PORTS = { mysql: 3_306, sqlserver: 1_433 } as const;

/**
 * The Kysely dialect for `storage`, with its driver loaded and configured. It connects nothing yet:
 * the first query opens the first connection.
 *
 * - SQLite: the database file's folder is created if needed, and the file is opened in WAL mode
 *   with foreign keys enforced and `secure_delete` on.
 * - A database server: its connection URL is read from the environment, its TLS files are read, and
 *   its driver is imported.
 *
 * Errors name `pathways.yaml` and the key at fault, never a URL, a password or a path.
 *
 * @throws {ConfigError} when the URL's environment variable is unset or does not hold a URL Pathways
 *   reads, a TLS file cannot be read, or the driver package is not installed.
 * @example
 * ```ts
 * const dialect = await dialectFor(project.storage, { env: process.env });
 * const db = new Kysely<Tables>({ dialect });
 * ```
 */
export async function dialectFor(
  storage: DatabaseStorage,
  options: DialectOptions,
): Promise<Dialect> {
  if (storage.kind === "sqlite") return sqliteDialect(storage.file);
  const where = options.where ?? `pathways.yaml: storage.${storage.kind}`;
  const url = readUrl(storage, options.env, `${where}.url`);
  const tls =
    storage.tls === undefined
      ? undefined
      : definedOnly(clientTlsOptions(loadClientTls(storage.tls, `${where}.tls`)));
  const load = options.importDriver ?? importDriver;
  switch (storage.kind) {
    case "postgres": {
      const [pg] = await loadDrivers(storage.kind, load, where);
      return postgresDialect(pg as Pg, storage, url, tls);
    }
    case "mysql": {
      const [mysql2] = await loadDrivers(storage.kind, load, where);
      return mysqlDialect(mysql2 as Mysql2, storage, url, tls);
    }
    case "sqlserver": {
      const [tedious, tarn] = await loadDrivers(storage.kind, load, where);
      return sqlServerDialect(
        tedious as Tedious,
        tarn as Tarn,
        storage,
        url,
        tls,
        options.requestTimeoutMs,
      );
    }
  }
}

async function sqliteDialect(file: string): Promise<Dialect> {
  if (file !== ":memory:") await mkdir(dirname(file), { recursive: true });
  const sqlite = new SqliteDatabase(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Freed space is overwritten with zeros, so a value rewritten in place (`pathways rekey`) or
  // deleted leaves none of its old bytes in the file. The write-ahead log keeps them until it is
  // emptied (`emptySqliteLog`).
  sqlite.pragma("secure_delete = ON");
  return new SqliteDialect({ database: cachedStatements(sqlite) });
}

/**
 * Copies every change in a SQLite database's write-ahead log into its file and truncates the log to
 * nothing (`wal_checkpoint(TRUNCATE)`), so the pages the log held, earlier versions of rewritten rows
 * among them, are gone from the database's files. The file's own freed space is already zeroed
 * (`secure_delete`). It waits, as long as a connection's busy timeout, for another connection's
 * write to finish. Returns false, having copied what it could, while a connection is still reading a
 * snapshot from before the latest change, which keeps the log; an idle open connection, as a running
 * engine's is between queries, does not.
 *
 * @example
 * ```ts
 * if (!emptySqliteLog(project.databaseFile)) console.error("a read is under way; try again");
 * ```
 */
export function emptySqliteLog(file: string): boolean {
  const sqlite = new SqliteDatabase(file, { fileMustExist: true });
  try {
    return sqlite.pragma("wal_checkpoint(TRUNCATE)", { simple: true }) === 0;
  } finally {
    sqlite.close();
  }
}

/** How many prepared statements a SQLite connection keeps: more than the store's queries number. */
const STATEMENTS_KEPT = 256;

/**
 * A SQLite connection that prepares each SQL text once and keeps the statement, for Kysely, which
 * asks for a statement every time it runs a query. Preparing parses and plans the SQL, and cost as
 * much as running the store's queries did. Statements are kept by their exact text, the most
 * recently used `limit` of them; one still being read (a stream not yet finished) is never handed
 * out twice, and the same text gets one of its own meanwhile. A kept statement is prepared again by
 * SQLite itself when the schema changes under it.
 *
 * @example
 * ```ts
 * const dialect = new SqliteDialect({ database: cachedStatements(new SqliteDatabase(file)) });
 * ```
 */
export function cachedStatements(
  database: SqliteDatabase.Database,
  limit: number = STATEMENTS_KEPT,
): KyselySqliteDatabase {
  const kept = new Map<string, SqliteDatabase.Statement>();
  return {
    close: () => {
      kept.clear();
      database.close();
    },
    prepare: (sql: string): SqliteStatement => {
      const statement = kept.get(sql);
      if (statement !== undefined) {
        if (statement.busy) return database.prepare(sql);
        // Most recently used last, so the first is the one to let go.
        kept.delete(sql);
        kept.set(sql, statement);
        return statement;
      }
      const prepared = database.prepare(sql);
      if (kept.size >= limit) kept.delete(kept.keys().next().value as string);
      kept.set(sql, prepared);
      return prepared;
    },
  };
}

/** TLS options as the drivers take them: verified always, with a CA and client pair when set. */
type TlsOptions = Readonly<Record<string, unknown>>;

function postgresDialect(
  pg: Pg,
  storage: ServerStorage,
  url: URL,
  tls: TlsOptions | undefined,
): Dialect {
  const pool = new pg.Pool({
    connectionString: url.href,
    // Always set, so neither the URL nor PGSSLMODE decides: readUrl refuses a URL with TLS options.
    ssl: tls ?? false,
    max: storage.pool.max,
    idleTimeoutMillis: storage.pool.idleTimeoutMs,
    connectionTimeoutMillis: storage.connectTimeoutMs,
  });
  // An idle connection's error (the server restarted, say) would otherwise end the process. The
  // pool drops that connection and the next query opens another; until then, the health endpoint
  // reports storage it cannot reach.
  pool.on("error", () => undefined);
  return new PostgresDialect({ pool });
}

function mysqlDialect(
  mysql2: Mysql2,
  storage: ServerStorage,
  url: URL,
  tls: TlsOptions | undefined,
): Dialect {
  const pool = mysql2.createPool({
    ...address(url, DEFAULT_PORTS.mysql),
    ...(tls === undefined ? {} : { ssl: tls }),
    connectionLimit: storage.pool.max,
    maxIdle: storage.pool.max,
    idleTimeout: storage.pool.idleTimeoutMs,
    connectTimeout: storage.connectTimeoutMs,
  });
  return new MysqlDialect({ pool });
}

function sqlServerDialect(
  tedious: Tedious,
  tarn: Tarn,
  storage: ServerStorage,
  url: URL,
  tls: TlsOptions | undefined,
  requestTimeoutMs?: number,
): Dialect {
  const { host, port, user, password, database } = address(url, DEFAULT_PORTS.sqlserver);
  const Connection = quietConnection(tedious);
  return new MssqlDialect({
    tarn: {
      Pool: tarn.Pool,
      options: {
        min: 0,
        max: storage.pool.max,
        idleTimeoutMillis: storage.pool.idleTimeoutMs,
        // Without this, a connection that fails is retried until the acquire times out, and the
        // reason (a refused login, say) is lost.
        propagateCreateError: true,
      },
    },
    tedious: {
      ISOLATION_LEVEL: tedious.ISOLATION_LEVEL,
      Request: tedious.Request,
      TYPES: tedious.TYPES,
      connectionFactory: () =>
        new Connection({
          server: host,
          authentication: { type: "default", options: { userName: user, password } },
          options: {
            port,
            database,
            // tedious verifies the server's certificate unless trustServerCertificate is set, and
            // reads only the CA and the client pair from cryptoCredentialsDetails.
            encrypt: tls !== undefined,
            trustServerCertificate: false,
            cryptoCredentialsDetails: { ...tls },
            connectTimeout: storage.connectTimeoutMs,
            ...(requestTimeoutMs === undefined ? {} : { requestTimeout: requestTimeoutMs }),
          },
        }),
    },
  });
}

/**
 * tedious's `Connection`, with each `error` event's text replaced by a fixed one that keeps only its
 * code. Kysely's SQL Server driver writes every connection error to `console.error`, and tedious's
 * own text names the server and the login.
 */
function quietConnection(tedious: Tedious): typeof tedious.Connection {
  return class QuietConnection extends tedious.Connection {
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event !== "error") return EventEmitter.prototype.emit.call(this, event, ...args);
      const code = (args[0] as { code?: unknown } | undefined)?.code;
      const quiet = new Error("the SQL Server connection failed");
      return super.emit("error", typeof code === "string" ? Object.assign(quiet, { code }) : quiet);
    }
  };
}

/**
 * Reads and checks a database server's connection URL. Errors name where it is read from, never its
 * value.
 */
function readUrl(storage: ServerStorage, env: SecretReader, where: string): URL {
  const name = secretHolder(storage.url);
  const schemes = SCHEMES[storage.kind];
  const url = URL.parse(secretsOf(env).read(storage.url, where));
  if (url === null || !schemes.includes(url.protocol)) {
    throw new ConfigError([
      `${where}: ${secretPlace(storage.url)} does not hold a ${String(schemes[0])}// URL`,
    ]);
  }
  const options = [...url.searchParams.keys()];
  if (storage.kind === "postgres") {
    // pg reads the rest of a URL's options itself; TLS is the one setting pathways.yaml owns.
    if (options.some((option) => option.toLowerCase().startsWith("ssl"))) {
      throw new ConfigError([
        `${where}: the URL in ${name} sets TLS options; set TLS in pathways.yaml instead, with tls or plaintext: true`,
      ]);
    }
    return url;
  }
  // mysql2 would turn each option into a driver setting, some of which log every packet.
  if (options.length > 0) {
    throw new ConfigError([
      `${where}: the URL in ${name} carries options after "?", which Pathways does not read; set TLS, the pool and timeouts in pathways.yaml`,
    ]);
  }
  if (url.hostname === "") {
    throw new ConfigError([`${where}: the URL in ${name} names no host`]);
  }
  if (!/^\/[^/]+$/.test(url.pathname)) {
    throw new ConfigError([
      `${where}: the URL in ${name} names no database; add it as the path, such as ${String(schemes[0])}//host/pathways`,
    ]);
  }
  try {
    address(url, 0);
  } catch {
    throw new ConfigError([`${where}: the URL in ${name} is not percent-encoded correctly`]);
  }
  return url;
}

/** A server's address and login, from a URL {@link readUrl} has checked. */
function address(
  url: URL,
  defaultPort: number,
): { host: string; port: number; user: string; password: string; database: string } {
  return {
    // An IPv6 address keeps its brackets in a URL, and loses them here.
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? defaultPort : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

/** Imports each driver package `kind` needs, or fails naming every one that is not installed. */
async function loadDrivers(
  kind: ServerStorage["kind"],
  load: DriverImport,
  where: string,
): Promise<unknown[]> {
  const names: readonly DriverPackage[] = DRIVER_PACKAGES[kind];
  const missing: DriverPackage[] = [];
  const modules = await Promise.all(
    names.map(async (name) => {
      try {
        return interop(await load(name));
      } catch (error) {
        const code = (error as { code?: unknown } | undefined)?.code;
        if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw error;
        missing.push(name);
        return undefined;
      }
    }),
  );
  if (missing.length > 0) {
    const [one, two] = missing;
    const what =
      two === undefined
        ? `the driver package ${String(one)} is not installed; add it`
        : `the driver packages ${String(one)} and ${two} are not installed; add them`;
    throw new ConfigError([
      `${where}: ${what} to the project with npm install ${missing.join(" ")}`,
    ]);
  }
  return modules;
}

/**
 * A CommonJS package's exports, however it was imported: a native `import()` puts them on
 * `default`, a bundler's CommonJS build may hand them over as they are.
 */
function interop(module: unknown): unknown {
  const exported = (module as { default?: unknown }).default;
  return typeof exported === "object" && exported !== null ? exported : module;
}

/** `options` without its undefined values, which some drivers read as set. */
function definedOnly(options: Readonly<Record<string, unknown>>): TlsOptions {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}
