import { randomBytes } from "node:crypto";

import { Kysely, sql } from "kysely";

import type { DatabaseStorage, ServerStorage, StorageKind } from "../src/config/schema.js";
import type { Env } from "../src/connectors/endpoint.js";
import { dialectFor } from "../src/storage/dialects.js";
import { ENGINE_LEASE, Store, type StoreOptions } from "../src/storage/store.js";
import { configuredName } from "../src/env.js";

/**
 * One database the storage, engine and operator suites run on. SQLite always runs; each server runs
 * when its URL is in the environment. The URL is an administrator's (it creates and drops a
 * database per test) and names a database that exists: `postgres`, `mysql` or `master`. CI's
 * `databases` workflow runs one job per server, each with that server's URL; locally, start the
 * servers `.github/workflows/databases.yml` names (docker will do) and export the same variables.
 */
export interface TestDatabase {
  /** The name a test reports: the storage kind, or `mariadb` for MariaDB on the `mysql` kind. */
  readonly label: string;
  readonly kind: StorageKind;
  /** The environment variable holding the administrator's URL; undefined for SQLite. */
  readonly urlEnv: string | undefined;
}

/** Every database the suites know, in the order they report. */
export const TEST_DATABASES: readonly TestDatabase[] = [
  { label: "sqlite", kind: "sqlite", urlEnv: undefined },
  { label: "postgres", kind: "postgres", urlEnv: "PATHWAYS_TEST_POSTGRES_URL" },
  { label: "mysql", kind: "mysql", urlEnv: "PATHWAYS_TEST_MYSQL_URL" },
  { label: "mariadb", kind: "mysql", urlEnv: "PATHWAYS_TEST_MARIADB_URL" },
  { label: "sqlserver", kind: "sqlserver", urlEnv: "PATHWAYS_TEST_SQLSERVER_URL" },
];

/**
 * The servers this run must reach, by label: every server with `PATHWAYS_TEST_ALL_DATABASES=1`, and
 * those `PATHWAYS_TEST_DATABASES` lists, comma separated, as each job of CI's `databases` workflow
 * names its own. A label that names no server fails the run, so a typo can never pass by running
 * nothing.
 */
export function requiredServers(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const servers = TEST_DATABASES.filter((database) => database.urlEnv !== undefined);
  if (env["PATHWAYS_TEST_ALL_DATABASES"] === "1") return servers.map((database) => database.label);
  const listed = (env["PATHWAYS_TEST_DATABASES"] ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");
  for (const label of listed) {
    if (!servers.some((database) => database.label === label)) {
      throw new Error(
        `PATHWAYS_TEST_DATABASES names ${label}, which is not a server the suites know`,
      );
    }
  }
  return listed;
}

/**
 * Whether `database` can run here: SQLite always, a server when its URL is set. A server the run
 * must reach ({@link requiredServers}) and whose URL is not set fails the file instead of skipping,
 * so a renamed variable can never pass by running nothing.
 */
export function available(database: TestDatabase, env: NodeJS.ProcessEnv = process.env): boolean {
  if (database.urlEnv === undefined || (env[database.urlEnv] ?? "") !== "") return true;
  if (requiredServers(env).includes(database.label)) {
    throw new Error(`${database.label} must run here, and ${database.urlEnv} is not set`);
  }
  return false;
}

/** The server databases, as [label, database] pairs for `describe.each`, each skipped when unset. */
export const SERVER_DATABASES = TEST_DATABASES.filter((database) => database.kind !== "sqlite");

/** The environment variable the storage under test reads its URL from. */
export const URL_ENV = "PATHWAYS_TEST_DATABASE_URL";

/**
 * A server's storage settings for a test: plaintext (the test servers run without TLS), a small
 * pool, and short timeouts.
 */
export function serverStorage(
  kind: Exclude<StorageKind, "sqlite">,
  overrides: Partial<ServerStorage> = {},
): ServerStorage {
  return {
    kind,
    url: { env: configuredName(URL_ENV) },
    tls: undefined,
    plaintext: true,
    pool: { max: 4, idleTimeoutMs: 1_000 },
    connectTimeoutMs: 15_000,
    ...overrides,
  };
}

/** A fresh database on a server: the storage that opens it, the env it reads, and its URL. */
export interface FreshDatabase {
  readonly storage: DatabaseStorage;
  readonly env: Env;
  readonly url: string;
}

const admins = new Map<string, Kysely<unknown>>();
const created: { readonly label: string; readonly name: string }[] = [];

function adminUrl(database: TestDatabase): URL {
  return new URL(process.env[database.urlEnv ?? ""] ?? "");
}

function admin(database: TestDatabase): Promise<Kysely<unknown>> {
  const existing = admins.get(database.label);
  if (existing !== undefined) return Promise.resolve(existing);
  const kind = database.kind as Exclude<StorageKind, "sqlite">;
  return dialectFor(serverStorage(kind), { env: { [URL_ENV]: adminUrl(database).href } }).then(
    (dialect) => {
      const db = new Kysely<unknown>({ dialect });
      admins.set(database.label, db);
      return db;
    },
  );
}

/**
 * Creates an empty database on `database`'s server, named for this process and a random suffix, so
 * test files running side by side never share one. {@link dropDatabases} removes it.
 */
export async function freshDatabase(database: TestDatabase): Promise<FreshDatabase> {
  const kind = database.kind as Exclude<StorageKind, "sqlite">;
  const name = `pathways_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  await sql`create database ${sql.id(name)}`.execute(await admin(database));
  created.push({ label: database.label, name });
  const url = adminUrl(database);
  url.pathname = `/${name}`;
  return { storage: serverStorage(kind), env: { [URL_ENV]: url.href }, url: url.href };
}

/**
 * A store for one test on a database of its own: SQLite in `file`, which the test makes fresh, or a
 * fresh database on `database`'s server. Each call to `open` opens that same database again, as a
 * restart does; the caller closes each store it opens.
 */
export interface TestStorage {
  /** The storage block a project names it by, and the environment that block reads its URL from. */
  readonly storage: DatabaseStorage;
  readonly env: Env;
  /** The server database's URL; undefined for SQLite. */
  readonly url: string | undefined;
  readonly open: (options?: Omit<StoreOptions, "env">) => Promise<Store>;
}

/** Makes {@link TestStorage} on `database`, with SQLite's file at `file`. */
export async function testStorage(database: TestDatabase, file: string): Promise<TestStorage> {
  if (database.kind === "sqlite") {
    const storage: DatabaseStorage = { kind: "sqlite", file };
    return { storage, env: {}, url: undefined, open: (options) => Store.open(file, options) };
  }
  const { storage, env, url } = await freshDatabase(database);
  return { storage, env, url, open: (options) => Store.open(storage, { ...options, env }) };
}

/** Drops every database {@link freshDatabase} made since the last call. Run it after each test. */
export async function dropDatabases(): Promise<void> {
  for (const { label, name } of created.splice(0)) {
    const db = admins.get(label);
    const database = TEST_DATABASES.find((candidate) => candidate.label === label);
    if (db === undefined || database === undefined) continue;
    switch (database.kind) {
      case "postgres":
        await sql`drop database if exists ${sql.id(name)} with (force)`.execute(db);
        break;
      case "sqlserver":
        await sql`alter database ${sql.id(name)} set single_user with rollback immediate`.execute(
          db,
        );
        await sql`drop database ${sql.id(name)}`.execute(db);
        break;
      case "mysql":
      case "sqlite":
        await sql`drop database if exists ${sql.id(name)}`.execute(db);
    }
  }
}

/** Closes the administrators' connections. Run it after all of a file's tests. */
export async function closeAdmins(): Promise<void> {
  await Promise.all([...admins.values()].map((db) => db.destroy()));
  admins.clear();
}

/**
 * Waits, on a store `open` opens, until the engine lease has lapsed by the database's clock, as it
 * does a time to live after its holder was killed: then the next `pathways start` takes it. Rejects
 * after `limitMs`.
 */
export async function leaseLapsed(open: () => Promise<Store>, limitMs = 30_000): Promise<void> {
  const store = await open();
  try {
    for (const started = Date.now(); Date.now() - started < limitMs;) {
      const holder = await store.leaseHolder(ENGINE_LEASE);
      if (holder === undefined || holder.expiresInMs <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(holder.expiresInMs + 10, 250)));
    }
    throw new Error("the engine lease did not lapse in time");
  } finally {
    await store.close();
  }
}
