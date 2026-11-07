import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect, type Generated } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";

/** Where a stored message stands. */
export type MessageStatus = "received" | "transformed" | "filtered" | "failed";

/** Where one delivery of a message to one destination stands. */
export type DeliveryStatus = "pending" | "delivered" | "failed";

interface MessagesTable {
  id: Generated<number>;
  channel: string;
  received_at: string;
  body: Uint8Array;
  status: MessageStatus;
  error: string | null;
  updated_at: string;
}

interface DeliveriesTable {
  id: Generated<number>;
  message_id: number;
  channel: string;
  destination: number;
  seq: number;
  body: Uint8Array;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  delivered_at: string | null;
}

interface Tables {
  messages: MessagesTable;
  deliveries: DeliveriesTable;
}

/** A stored message waiting for its transform. */
export interface PendingMessage {
  readonly id: number;
  readonly body: Uint8Array;
}

/** The oldest delivery still pending for one destination of one channel. */
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
 * What the engine needs from storage. {@link Store} implements it on SQLite; a storage adapter for
 * another database implements the same methods.
 */
export interface MessageStore {
  receive(channel: string, body: Uint8Array): Promise<number>;
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

const MIGRATIONS: Record<string, Migration> = {
  "0001-messages-and-deliveries": {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable("messages")
        .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
        .addColumn("channel", "text", (col) => col.notNull())
        .addColumn("received_at", "text", (col) => col.notNull())
        .addColumn("body", "blob", (col) => col.notNull())
        .addColumn("status", "text", (col) => col.notNull())
        .addColumn("error", "text")
        .addColumn("updated_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("messages_by_channel_status")
        .on("messages")
        .columns(["channel", "status", "id"])
        .execute();
      await db.schema
        .createTable("deliveries")
        .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
        .addColumn("message_id", "integer", (col) => col.notNull().references("messages.id"))
        .addColumn("channel", "text", (col) => col.notNull())
        .addColumn("destination", "integer", (col) => col.notNull())
        .addColumn("seq", "integer", (col) => col.notNull())
        .addColumn("body", "blob", (col) => col.notNull())
        .addColumn("status", "text", (col) => col.notNull())
        .addColumn("attempts", "integer", (col) => col.notNull())
        .addColumn("next_attempt_at", "integer", (col) => col.notNull())
        .addColumn("last_error", "text")
        .addColumn("delivered_at", "text")
        .execute();
      await db.schema
        .createIndex("deliveries_by_destination_status")
        .on("deliveries")
        .columns(["channel", "destination", "status", "id"])
        .execute();
    },
  },
};

const provider: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

/**
 * Where Pathways keeps every message and every delivery, so a restart loses nothing.
 *
 * SQLite for now, through Kysely; the other databases arrive behind the same methods.
 *
 * @example
 * ```ts
 * const store = await Store.open(".pathways/pathways.db");
 * const id = await store.receive("adt-to-lab", body);
 * await store.close();
 * ```
 */
export class Store implements MessageStore {
  private constructor(
    private readonly db: Kysely<Tables>,
    private readonly now: () => Date,
  ) {}

  /**
   * Opens (creating if needed) the SQLite database at `file` and brings its schema up to date.
   *
   * @example
   * ```ts
   * const store = await Store.open(".pathways/pathways.db");
   * ```
   */
  static async open(file: string, now: () => Date = () => new Date()): Promise<Store> {
    if (file !== ":memory:") await mkdir(dirname(file), { recursive: true });
    const sqlite = new SqliteDatabase(file);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = new Kysely<Tables>({ dialect: new SqliteDialect({ database: sqlite }) });
    const { error } = await new Migrator({ db, provider }).migrateToLatest();
    if (error !== undefined) {
      await db.destroy();
      throw new Error("the database schema could not be brought up to date", { cause: error });
    }
    return new Store(db, now);
  }

  /** Closes the database. */
  async close(): Promise<void> {
    await this.db.destroy();
  }

  /** Stores an incoming message as `received` and returns its id. */
  async receive(channel: string, body: Uint8Array): Promise<number> {
    const at = this.now().toISOString();
    const row = await this.db
      .insertInto("messages")
      .values({ channel, received_at: at, body, status: "received", error: null, updated_at: at })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** The oldest message of `channel` still waiting for its transform, if any. */
  async nextToTransform(channel: string): Promise<PendingMessage | undefined> {
    return this.db
      .selectFrom("messages")
      .select(["id", "body"])
      .where("channel", "=", channel)
      .where("status", "=", "received")
      .orderBy("id")
      .limit(1)
      .executeTakeFirst();
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
              body,
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
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      messageId: row.message_id,
      seq: row.seq,
      body: row.body,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
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
      .select(["status", (eb) => eb.fn.countAll<number>().as("count")])
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
      .select(["status", (eb) => eb.fn.countAll<number>().as("count")])
      .where("channel", "=", channel)
      .groupBy("status")
      .execute();
    const counts: Record<DeliveryStatus, number> = { pending: 0, delivered: 0, failed: 0 };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /** How many of `channel`'s pending deliveries have failed at least once and wait for a retry. */
  async retryingDeliveries(channel: string): Promise<number> {
    const row = await this.db
      .selectFrom("deliveries")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("channel", "=", channel)
      .where("status", "=", "pending")
      .where("attempts", ">", 0)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
