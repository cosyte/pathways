import {
  Kysely,
  sql,
  type ColumnDataType,
  type ColumnDefinitionBuilder,
  type ColumnType,
  type CreateTableBuilder,
  type Expression,
  type Insertable,
  type RawBuilder,
  type SelectQueryBuilder,
} from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";

import { ConfigError } from "../config/load.js";
import type { DatabaseStorage, StorageKind } from "../config/schema.js";
import type { Env } from "../connectors/endpoint.js";
import { dialectFor, type DriverImport } from "./dialects.js";

/**
 * Where a stored message stands.
 *
 * @example
 * ```ts
 * const done = (status: MessageStatus): boolean => status === "transformed" || status === "filtered";
 * ```
 */
export type MessageStatus = "received" | "transformed" | "filtered" | "failed";

/**
 * Where one delivery of a message to one destination stands.
 *
 * @example
 * ```ts
 * const open = (status: DeliveryStatus): boolean => status === "pending";
 * ```
 */
export type DeliveryStatus = "pending" | "delivered" | "failed";

/**
 * A 64-bit integer column. pg and tedious return one as a string, so every read goes through
 * `Number`; ids and epoch milliseconds stay far below 2^53.
 */
type Int64 = ColumnType<number | string, number, number>;

/** A primary key the database numbers. */
type Id = ColumnType<number | string, never, never>;

interface MessagesTable {
  id: Id;
  channel: string;
  received_at: string;
  body: Uint8Array;
  status: MessageStatus;
  error: string | null;
  updated_at: string;
  /** A hash of who sent the message and its control ID, for spotting a repeat. Since 0002. */
  dedup_key: string | null;
  /** The latest earlier message with the same `dedup_key`: set means a possible duplicate. Since 0002. */
  duplicate_of: ColumnType<number | string | null, number | null, number | null>;
}

interface DeliveriesTable {
  id: Id;
  message_id: Int64;
  channel: string;
  destination: number;
  seq: number;
  body: Uint8Array;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: Int64;
  last_error: string | null;
  delivered_at: string | null;
}

interface Tables {
  messages: MessagesTable;
  deliveries: DeliveriesTable;
}

/**
 * What the engine tells storage about an incoming message. Every field is optional.
 *
 * @example
 * ```ts
 * await store.receive("adt", body, { duplicateKey: hashOfSenderAndControlId });
 * ```
 */
export interface StoreReceiveOptions {
  /**
   * An opaque key for who sent the message and its control ID (the engine passes a hash). When an
   * earlier message of the channel has the same key, this one is stored flagged as a possible
   * duplicate of it.
   */
  readonly duplicateKey?: string | undefined;
  /** Stores the message as `failed`, with this reason, so it is kept but never transformed. */
  readonly failure?: string | undefined;
}

/**
 * An incoming message, stored.
 *
 * @example
 * ```ts
 * const { id, duplicateOf } = await store.receive("adt", body);
 * ```
 */
export interface ReceivedMessage {
  readonly id: number;
  /** The latest earlier message of the channel with the same duplicate key, when there is one. */
  readonly duplicateOf: number | undefined;
}

/** What storage holds about one message, without its body. */
export interface StoredMessage {
  readonly id: number;
  readonly channel: string;
  readonly status: MessageStatus;
  readonly error: string | null;
  readonly duplicateOf: number | null;
}

/**
 * A stored message waiting for its transform.
 *
 * @example
 * ```ts
 * const next: PendingMessage | undefined = await store.nextToTransform("adt");
 * ```
 */
export interface PendingMessage {
  readonly id: number;
  readonly body: Uint8Array;
}

/**
 * The oldest delivery still pending for one destination of one channel.
 *
 * @example
 * ```ts
 * const due = (delivery: PendingDelivery): boolean => delivery.nextAttemptAt <= Date.now();
 * ```
 */
export interface PendingDelivery {
  readonly id: number;
  readonly messageId: number;
  readonly seq: number;
  readonly body: Uint8Array;
  readonly attempts: number;
  /** Epoch milliseconds before which this delivery must not be tried again. */
  readonly nextAttemptAt: number;
}

/**
 * What the engine needs from storage. {@link Store} implements it on SQLite, PostgreSQL, MySQL or
 * MariaDB, and SQL Server; a storage adapter for anything else implements the same methods, and its
 * module's `StoreFactory` returns it. A layer around a store (encryption at rest) wraps them.
 *
 * Every method is the engine's only path to that data, so an adapter keeps these promises: `receive`
 * is durable before it resolves; `completeTransform` writes all its deliveries and the message's new
 * status, or none of them; `nextDelivery` returns the lowest pending id for that destination, so
 * deliveries stay in order; and a new delivery is due at once (`nextAttemptAt` 0).
 *
 * @example
 * ```ts
 * class PoolStore implements MessageStore {
 *   async receive(channel: string, body: Uint8Array, options?: StoreReceiveOptions) {
 *     const id = await this.pool.insertMessage(channel, body, options?.failure);
 *     return { id, duplicateOf: undefined };
 *   }
 *   // ...and the other methods, each against the same database.
 * }
 * ```
 */
export interface MessageStore {
  /**
   * Stores an incoming message, durably, before its source acknowledges it: as `received`, or as
   * `failed` when `options.failure` is set. Flags it as a possible duplicate when an earlier
   * message of the channel has the same `options.duplicateKey`.
   */
  receive(
    channel: string,
    body: Uint8Array,
    options?: StoreReceiveOptions,
  ): Promise<ReceivedMessage>;
  nextToTransform(channel: string): Promise<PendingMessage | undefined>;
  completeTransform(
    messageId: number,
    outputs: readonly Uint8Array[],
    destinations: number,
  ): Promise<void>;
  failTransform(messageId: number, error: string): Promise<void>;
  nextDelivery(channel: string, destination: number): Promise<PendingDelivery | undefined>;
  markDelivered(deliveryId: number): Promise<void>;
  scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
  ): Promise<void>;
  failDelivery(deliveryId: number, error: string): Promise<void>;
  /** How many messages of a channel stand at each status. The health endpoint reports these. */
  messageCounts(channel: string): Promise<Record<MessageStatus, number>>;
  /** How many deliveries of a channel stand at each status. */
  deliveryCounts(channel: string): Promise<Record<DeliveryStatus, number>>;
  /** How many of a channel's pending deliveries have failed at least once and wait for a retry. */
  retryingDeliveries(channel: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Which table a {@link StoredContent} row is from.
 *
 * @example
 * ```ts
 * const table: ContentTable = "deliveries";
 * ```
 */
export type ContentTable = "messages" | "deliveries";

/**
 * One row's content, exactly as storage holds it: a message's body and error, or a delivery's body
 * and last error. With encryption on, these are the encrypted values.
 *
 * @example
 * ```ts
 * const row: StoredContent = { table: "messages", id: 1, body, error: null };
 * ```
 */
export interface StoredContent {
  readonly table: ContentTable;
  readonly id: number;
  readonly body: Uint8Array;
  readonly error: string | null;
}

/**
 * What `pathways rekey` needs from storage beyond {@link MessageStore}: every stored body and error
 * text as stored, and a way to replace them. The engine never uses it. {@link Store} implements it;
 * a storage adapter that implements it can be rekeyed.
 *
 * @example
 * ```ts
 * for (const row of await store.storedContent("messages", 0, 100)) {
 *   await store.replaceContent(row, { body: reencrypted(row.body), error: row.error });
 * }
 * ```
 */
export interface ContentStore {
  /** Up to `limit` rows of `table` with an id above `after`, oldest first, as stored. */
  storedContent(table: ContentTable, after: number, limit: number): Promise<StoredContent[]>;
  /**
   * Replaces a row's body and error with `next`, but only while the row still holds what `current`
   * read, so a change made meanwhile (a retry's new error) is never overwritten. Returns whether it
   * replaced them.
   */
  replaceContent(
    current: StoredContent,
    next: { readonly body: Uint8Array; readonly error: string | null },
  ): Promise<boolean>;
}

/**
 * Whether `store` also implements {@link ContentStore}, so `pathways rekey` can rewrite what it
 * holds. {@link Store} does; a custom store may.
 *
 * @example
 * ```ts
 * if (!isContentStore(raw)) throw new Error("this store cannot be rekeyed");
 * ```
 */
export function isContentStore(store: MessageStore): store is MessageStore & ContentStore {
  const candidate = store as Partial<ContentStore>;
  return (
    typeof candidate.storedContent === "function" && typeof candidate.replaceContent === "function"
  );
}

/** A column type: one Kysely knows by name, or raw SQL. */
type DataTypeExpression = ColumnDataType | Expression<unknown>;

/**
 * The column types each database spells differently. SQLite's are the ones the first slice wrote,
 * so a database it made still matches.
 *
 * - Keys and epoch milliseconds are 64-bit on the servers; SQLite's `integer` already is.
 * - Names, statuses and duplicate keys are indexed, so MySQL and SQL Server need a bounded length.
 * - Text compares by code point everywhere: MySQL's tables and SQL Server's text columns take a
 *   binary collation, since their defaults ignore case and would let channel `ADT` read channel
 *   `adt`, or let rekey take one error text for another.
 * - Bodies take up to 4 GB on MySQL (`longblob`) and 2 GB on SQL Server; a plain MySQL `blob` holds
 *   64 KB.
 */

interface ColumnTypes {
  readonly key: DataTypeExpression;
  readonly int64: DataTypeExpression;
  readonly name: DataTypeExpression;
  readonly status: DataTypeExpression;
  readonly time: DataTypeExpression;
  readonly body: DataTypeExpression;
  readonly detail: DataTypeExpression;
  /** Makes `key` a primary key the database numbers. */
  readonly numbered: (col: ColumnDefinitionBuilder) => ColumnDefinitionBuilder;
  /** Ends a `create table`: MySQL's engine and collation. */
  readonly table: <T extends string, C extends string>(
    table: CreateTableBuilder<T, C>,
  ) => CreateTableBuilder<T, C>;
}

const SQL_SERVER_BINARY = sql.raw("collate Latin1_General_100_BIN2");

const COLUMN_TYPES: Readonly<Record<StorageKind, ColumnTypes>> = {
  sqlite: {
    key: "integer",
    int64: "integer",
    name: "text",
    status: "text",
    time: "text",
    body: "blob",
    detail: "text",
    numbered: (col) => col.primaryKey().autoIncrement(),
    table: (table) => table,
  },
  postgres: {
    key: "bigint",
    int64: "bigint",
    name: "text",
    status: "text",
    time: "text",
    body: "bytea",
    detail: "text",
    numbered: (col) => col.primaryKey().generatedByDefaultAsIdentity(),
    table: (table) => table,
  },
  mysql: {
    key: "bigint",
    int64: "bigint",
    name: "varchar(255)",
    status: "varchar(32)",
    time: "varchar(32)",
    body: sql`longblob`,
    detail: sql`mediumtext`,
    numbered: (col) => col.primaryKey().autoIncrement(),
    table: (table) =>
      table.modifyEnd(sql`engine = InnoDB default character set utf8mb4 collate utf8mb4_bin`),
  },
  sqlserver: {
    key: "bigint",
    int64: "bigint",
    name: sql`nvarchar(255) ${SQL_SERVER_BINARY}`,
    status: sql`nvarchar(32) ${SQL_SERVER_BINARY}`,
    time: sql`nvarchar(32)`,
    body: sql`varbinary(max)`,
    detail: sql`nvarchar(max) ${SQL_SERVER_BINARY}`,
    numbered: (col) => col.primaryKey().identity(),
    table: (table) => table,
  },
};

/**
 * The schema's migrations, in the column types of `kind`. One portable set: each database runs the
 * same steps under the same names, so the migration table reads the same everywhere.
 */
function migrations(kind: StorageKind): Record<string, Migration> {
  const t = COLUMN_TYPES[kind];
  return {
    "0001-messages-and-deliveries": {
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema
          .createTable("messages")
          .addColumn("id", t.key, t.numbered)
          .addColumn("channel", t.name, (col) => col.notNull())
          .addColumn("received_at", t.time, (col) => col.notNull())
          .addColumn("body", t.body, (col) => col.notNull())
          .addColumn("status", t.status, (col) => col.notNull())
          .addColumn("error", t.detail)
          .addColumn("updated_at", t.time, (col) => col.notNull())
          .$call(t.table)
          .execute();
        await db.schema
          .createIndex("messages_by_channel_status")
          .on("messages")
          .columns(["channel", "status", "id"])
          .execute();
        await db.schema
          .createTable("deliveries")
          .addColumn("id", t.key, t.numbered)
          .addColumn("message_id", t.int64, (col) => col.notNull().references("messages.id"))
          .addColumn("channel", t.name, (col) => col.notNull())
          .addColumn("destination", "integer", (col) => col.notNull())
          .addColumn("seq", "integer", (col) => col.notNull())
          .addColumn("body", t.body, (col) => col.notNull())
          .addColumn("status", t.status, (col) => col.notNull())
          .addColumn("attempts", "integer", (col) => col.notNull())
          .addColumn("next_attempt_at", t.int64, (col) => col.notNull())
          .addColumn("last_error", t.detail)
          .addColumn("delivered_at", t.time)
          .$call(t.table)
          .execute();
        await db.schema
          .createIndex("deliveries_by_destination_status")
          .on("deliveries")
          .columns(["channel", "destination", "status", "id"])
          .execute();
      },
    },
    "0002-possible-duplicates": {
      async up(db: Kysely<unknown>): Promise<void> {
        // One column per statement: SQLite adds only one column per ALTER TABLE.
        await db.schema.alterTable("messages").addColumn("dedup_key", t.name).execute();
        await db.schema.alterTable("messages").addColumn("duplicate_of", t.int64).execute();
        await db.schema
          .createIndex("messages_by_channel_dedup_key")
          .on("messages")
          .columns(["channel", "dedup_key", "id"])
          .execute();
      },
    },
  };
}

/**
 * What {@link Store.open} runs with. Every field is optional.
 *
 * @example
 * ```ts
 * const store = await Store.open(project.storage, { env: process.env });
 * ```
 */
export interface StoreOptions {
  /** The clock for the times a store records. Tests pass their own. */
  readonly now?: () => Date;
  /** Where a database server's connection URL is read from. Defaults to `process.env`. */
  readonly env?: Env;
  /** Imports a driver package. Tests pass their own, to stand in for one that is not installed. */
  readonly importDriver?: DriverImport;
}

/**
 * Storage that could not be opened: `open` when the database could not be reached or opened (a
 * refused connection, a login it refused, a file it could not create), `schema` when its schema
 * could not be brought up to date. `code` is the driver's code, such as `ECONNREFUSED`, `28P01` or
 * `ELOGIN`; the driver's own error, which can name the server, the login or the file, is kept as
 * `cause` and never shown.
 *
 * @example
 * ```ts
 * try {
 *   await Store.open(project.databaseFile);
 * } catch (error) {
 *   if (error instanceof StorageError) console.error(error.reason, error.code);
 * }
 * ```
 */
export class StorageError extends Error {
  readonly reason: "open" | "schema";
  readonly code: string | undefined;

  /**
   * @param reason What could not be done.
   * @param cause The driver's error, kept and never shown.
   */
  constructor(reason: "open" | "schema", cause: unknown) {
    super(
      reason === "open"
        ? "the database could not be opened"
        : "the database schema could not be brought up to date",
      { cause },
    );
    this.name = "StorageError";
    this.reason = reason;
    const code = (cause as { code?: unknown } | undefined)?.code;
    this.code = typeof code === "string" ? code : undefined;
  }
}

/**
 * Where Pathways keeps every message and every delivery, so a restart loses nothing: SQLite,
 * PostgreSQL, MySQL or MariaDB, or SQL Server, through Kysely.
 *
 * Every database runs the same queries but three. SQL Server writes `TOP` where the others write
 * `LIMIT`, and each returns a new row's id its own way (`RETURNING`, `OUTPUT`, or MySQL's insert id).
 * Nothing claims rows: one engine process owns a database, and reads the head of each queue in order.
 *
 * @example
 * ```ts
 * const store = await Store.open(".pathways/pathways.db");
 * const { id } = await store.receive("adt-to-lab", body);
 * await store.close();
 * ```
 */
export class Store implements MessageStore, ContentStore {
  private constructor(
    private readonly db: Kysely<Tables>,
    private readonly kind: StorageKind,
    private readonly now: () => Date,
  ) {}

  /**
   * Opens the database `storage` names (a path is a SQLite file), connects once to check it can,
   * and brings its schema up to date. A SQLite file and its folder are created if needed.
   *
   * @throws {ConfigError} when the connection URL's environment variable, a TLS file or the driver
   *   package cannot be had.
   * @throws {StorageError} when the database cannot be opened or its schema brought up to date.
   * @example
   * ```ts
   * const store = await Store.open(project.storage, { env: process.env });
   * ```
   */
  static async open(storage: string | DatabaseStorage, options: StoreOptions = {}): Promise<Store> {
    const config: DatabaseStorage =
      typeof storage === "string" ? { kind: "sqlite", file: storage } : storage;
    const { importDriver } = options;
    let db: Kysely<Tables>;
    try {
      const dialect = await dialectFor(config, {
        env: options.env ?? process.env,
        ...(importDriver === undefined ? {} : { importDriver }),
      });
      db = new Kysely<Tables>({ dialect });
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new StorageError("open", error);
    }
    try {
      await sql`select 1`.execute(db);
    } catch (error) {
      await db.destroy();
      throw new StorageError("open", error);
    }
    const provider: MigrationProvider = {
      getMigrations: () => Promise.resolve(migrations(config.kind)),
    };
    const { error } = await new Migrator({ db, provider }).migrateToLatest();
    if (error !== undefined) {
      await db.destroy();
      throw new StorageError("schema", error);
    }
    return new Store(db, config.kind, options.now ?? (() => new Date()));
  }

  /** Closes the database, and every pooled connection to it. */
  async close(): Promise<void> {
    await this.db.destroy();
  }

  /**
   * Stores an incoming message as `received` (or `failed`, given `options.failure`) and returns its
   * id, with the earlier message it may duplicate. With a duplicate key, the lookup and the insert
   * are one transaction; without one, the insert alone.
   */
  async receive(
    channel: string,
    body: Uint8Array,
    options: StoreReceiveOptions = {},
  ): Promise<ReceivedMessage> {
    const at = this.now().toISOString();
    const { duplicateKey, failure } = options;
    const insert = (db: Kysely<Tables>, duplicateOf: number | undefined): Promise<number> =>
      this.insertMessage(db, {
        channel,
        received_at: at,
        body: blob(body),
        status: failure === undefined ? "received" : "failed",
        error: failure ?? null,
        updated_at: at,
        dedup_key: duplicateKey ?? null,
        duplicate_of: duplicateOf ?? null,
      });
    if (duplicateKey === undefined) {
      return { id: await insert(this.db, undefined), duplicateOf: undefined };
    }
    return this.db.transaction().execute(async (tx) => {
      const earlier = await tx
        .selectFrom("messages")
        .select("id")
        .where("channel", "=", channel)
        .where("dedup_key", "=", duplicateKey)
        .orderBy("id", "desc")
        .$call((query) => this.first(query))
        .executeTakeFirst();
      const duplicateOf = earlier === undefined ? undefined : Number(earlier.id);
      return { id: await insert(tx, duplicateOf), duplicateOf };
    });
  }

  /** What is stored about one message, without its body, or `undefined` if there is none. */
  async message(id: number): Promise<StoredMessage | undefined> {
    const row = await this.db
      .selectFrom("messages")
      .select(["id", "channel", "status", "error", "duplicate_of"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const { channel, status, error, duplicate_of: duplicateOf } = row;
    return {
      id: Number(row.id),
      channel,
      status,
      error,
      duplicateOf: duplicateOf === null ? null : Number(duplicateOf),
    };
  }

  /** The oldest message of `channel` still waiting for its transform, if any. */
  async nextToTransform(channel: string): Promise<PendingMessage | undefined> {
    const row = await this.db
      .selectFrom("messages")
      .select(["id", "body"])
      .where("channel", "=", channel)
      .where("status", "=", "received")
      .orderBy("id")
      .$call((query) => this.first(query))
      .executeTakeFirst();
    return row === undefined ? undefined : { id: Number(row.id), body: row.body };
  }

  /**
   * Records a transform's outputs: one pending delivery per output per destination, in order, and
   * the message as `transformed`, or as `filtered` when there were no outputs. All or nothing.
   */
  async completeTransform(
    messageId: number,
    outputs: readonly Uint8Array[],
    destinations: number,
  ): Promise<void> {
    const at = this.now();
    await this.db.transaction().execute(async (tx) => {
      const message = await tx
        .selectFrom("messages")
        .select("channel")
        .where("id", "=", messageId)
        .executeTakeFirstOrThrow();
      for (let destination = 0; destination < destinations; destination += 1) {
        for (const [seq, body] of outputs.entries()) {
          await tx
            .insertInto("deliveries")
            .values({
              message_id: messageId,
              channel: message.channel,
              destination,
              seq,
              body: blob(body),
              status: "pending",
              attempts: 0,
              // Due at once, whatever the reader's clock: only a retry sets a time in the future.
              next_attempt_at: 0,
              last_error: null,
              delivered_at: null,
            })
            .execute();
        }
      }
      await tx
        .updateTable("messages")
        .set({
          status: outputs.length === 0 ? "filtered" : "transformed",
          updated_at: at.toISOString(),
        })
        .where("id", "=", messageId)
        .execute();
    });
  }

  /** Marks a message `failed`, with its error, so the channel moves on to the next. */
  async failTransform(messageId: number, error: string): Promise<void> {
    await this.db
      .updateTable("messages")
      .set({ status: "failed", error, updated_at: this.now().toISOString() })
      .where("id", "=", messageId)
      .execute();
  }

  /**
   * The oldest pending delivery for one destination of one channel. Later deliveries wait behind it,
   * which is what keeps a destination's messages in order.
   */
  async nextDelivery(channel: string, destination: number): Promise<PendingDelivery | undefined> {
    const row = await this.db
      .selectFrom("deliveries")
      .select(["id", "message_id", "seq", "body", "attempts", "next_attempt_at"])
      .where("channel", "=", channel)
      .where("destination", "=", destination)
      .where("status", "=", "pending")
      .orderBy("id")
      .$call((query) => this.first(query))
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: Number(row.id),
      messageId: Number(row.message_id),
      seq: row.seq,
      body: row.body,
      attempts: row.attempts,
      nextAttemptAt: Number(row.next_attempt_at),
    };
  }

  /** Marks a delivery done. */
  async markDelivered(deliveryId: number): Promise<void> {
    await this.db
      .updateTable("deliveries")
      .set({ status: "delivered", delivered_at: this.now().toISOString() })
      .where("id", "=", deliveryId)
      .execute();
  }

  /** Records a failed attempt and when to try again. */
  async scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
  ): Promise<void> {
    await this.db
      .updateTable("deliveries")
      .set({ attempts, next_attempt_at: nextAttemptAt, last_error: error })
      .where("id", "=", deliveryId)
      .execute();
  }

  /** Marks a delivery `failed` for good, so its destination moves on to the next. */
  async failDelivery(deliveryId: number, error: string): Promise<void> {
    await this.db
      .updateTable("deliveries")
      .set({ status: "failed", last_error: error })
      .where("id", "=", deliveryId)
      .execute();
  }

  /** How many messages of `channel` stand at each status. */
  async messageCounts(channel: string): Promise<Record<MessageStatus, number>> {
    const rows = await this.db
      .selectFrom("messages")
      .select(["status", (eb) => eb.fn.countAll<number | string>().as("count")])
      .where("channel", "=", channel)
      .groupBy("status")
      .execute();
    const counts: Record<MessageStatus, number> = {
      received: 0,
      transformed: 0,
      filtered: 0,
      failed: 0,
    };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /** How many deliveries of `channel` stand at each status. */
  async deliveryCounts(channel: string): Promise<Record<DeliveryStatus, number>> {
    const rows = await this.db
      .selectFrom("deliveries")
      .select(["status", (eb) => eb.fn.countAll<number | string>().as("count")])
      .where("channel", "=", channel)
      .groupBy("status")
      .execute();
    const counts: Record<DeliveryStatus, number> = { pending: 0, delivered: 0, failed: 0 };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /** Up to `limit` rows of `table` with an id above `after`, oldest first, as stored. */
  async storedContent(table: ContentTable, after: number, limit: number): Promise<StoredContent[]> {
    const rows =
      table === "messages"
        ? await this.db
            .selectFrom("messages")
            .select(["id", "body", "error"])
            .where("id", ">", after)
            .orderBy("id")
            .$call((query) => this.take(query, limit))
            .execute()
        : await this.db
            .selectFrom("deliveries")
            .select(["id", "body", "last_error as error"])
            .where("id", ">", after)
            .orderBy("id")
            .$call((query) => this.take(query, limit))
            .execute();
    return rows.map(({ id, body, error }) => ({ table, id: Number(id), body, error }));
  }

  /**
   * Replaces a row's body and error with `next`, only while the row still holds `current`'s body
   * and error, byte for byte. Returns whether it did.
   *
   * SQL Server's `=` ignores trailing zero bytes and trailing spaces, and MySQL's ignores trailing
   * spaces in text, so on those two the lengths are compared as well.
   *
   * The old values are overwritten in place, but a database server keeps earlier row versions for
   * a while: PostgreSQL until VACUUM, and even then in free space and its WAL; MySQL in its undo
   * log and binary log; SQL Server in its transaction log and freed pages; and every server in its
   * backups. Under encryption those versions are ciphertext under the older master key, so that key
   * is what keeps them unreadable: retire it once the server no longer holds them, not as soon as
   * rekey reports nothing left under it. SQLite, opened with `secure_delete`, zeroes them in its file.
   */
  async replaceContent(
    current: StoredContent,
    next: { readonly body: Uint8Array; readonly error: string | null },
  ): Promise<boolean> {
    const body = blob(current.body);
    const result =
      current.table === "messages"
        ? await this.db
            .updateTable("messages")
            .set({ body: blob(next.body), error: next.error })
            .where("id", "=", current.id)
            .where(sql<boolean>`${this.same("body", body)}`)
            .where(sql<boolean>`${this.same("error", current.error)}`)
            .executeTakeFirst()
        : await this.db
            .updateTable("deliveries")
            .set({ body: blob(next.body), last_error: next.error })
            .where("id", "=", current.id)
            .where(sql<boolean>`${this.same("body", body)}`)
            .where(sql<boolean>`${this.same("last_error", current.error)}`)
            .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** How many of `channel`'s pending deliveries have failed at least once and wait for a retry. */
  async retryingDeliveries(channel: string): Promise<number> {
    const row = await this.db
      .selectFrom("deliveries")
      .select((eb) => eb.fn.countAll<number | string>().as("count"))
      .where("channel", "=", channel)
      .where("status", "=", "pending")
      .where("attempts", ">", 0)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** Keeps a query's first row. */
  private first<TB extends keyof Tables, O>(
    query: SelectQueryBuilder<Tables, TB, O>,
  ): SelectQueryBuilder<Tables, TB, O> {
    return this.take(query, 1);
  }

  /** Keeps a query's first `count` rows: SQL Server writes `TOP`, the others `LIMIT`. */
  private take<TB extends keyof Tables, O>(
    query: SelectQueryBuilder<Tables, TB, O>,
    count: number,
  ): SelectQueryBuilder<Tables, TB, O> {
    return this.kind === "sqlserver" ? query.top(count) : query.limit(count);
  }

  /**
   * A condition that `column` holds exactly `value`, or is null when `value` is. On SQL Server and
   * MySQL it also compares lengths, since their `=` pads the shorter value.
   */
  private same(column: string, value: Uint8Array | string | null): RawBuilder<boolean> {
    const ref = sql.ref(column);
    if (value === null) return sql<boolean>`${ref} is null`;
    if (this.kind !== "sqlserver" && this.kind !== "mysql") return sql<boolean>`${ref} = ${value}`;
    const length = sql.raw(this.kind === "sqlserver" ? "datalength" : "octet_length");
    return sql<boolean>`(${ref} = ${value} and ${length}(${ref}) = ${length}(${value}))`;
  }

  /** Inserts a message and returns its id, which each database hands back its own way. */
  private async insertMessage(
    db: Kysely<Tables>,
    values: Insertable<MessagesTable>,
  ): Promise<number> {
    const insert = db.insertInto("messages").values(values);
    switch (this.kind) {
      case "mysql":
        // MySQL has no RETURNING; the driver reports the id it assigned.
        return Number((await insert.executeTakeFirstOrThrow()).insertId);
      case "sqlserver":
        return Number((await insert.output("inserted.id").executeTakeFirstOrThrow()).id);
      case "postgres":
      case "sqlite":
        return Number((await insert.returning("id").executeTakeFirstOrThrow()).id);
    }
  }
}

/**
 * A body as every driver binds it. mysql2 and Kysely's SQL Server driver recognise a `Buffer` as
 * binary, not a bare `Uint8Array`; the view shares the body's memory, so nothing is copied.
 */
function blob(body: Uint8Array): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}
