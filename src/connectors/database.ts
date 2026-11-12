import { CompiledQuery, Kysely, type Dialect } from "kysely";

import type { StorageKind } from "../config/schema.js";
import { bindParameters, type Statement, type StatementError } from "./sql-statement.js";
import { DeliveryRejected, type DestinationConnector, type OutgoingMessage } from "./types.js";

// The database destination: one statement per delivery, in a transaction of its own, with every
// value bound as a parameter. A driver's error text can quote the row it refused, so nothing of it
// leaves this file: a refusal becomes a DeliveryRejected naming the server's code, and any other
// failure an error that carries the code alone.

/**
 * What a {@link DatabaseDestination} runs on.
 *
 * @example
 * ```ts
 * const options: DatabaseDestinationOptions = {
 *   kind: "postgres",
 *   dialect,
 *   statement: parseStatement(text, "postgres"),
 *   expectRows: 1,
 *   statementTimeoutMs: 10_000,
 * };
 * ```
 */
export interface DatabaseDestinationOptions {
  readonly kind: StorageKind;
  /** The dialect, with its own small pool, that `stop` closes. */
  readonly dialect: Dialect;
  readonly statement: Statement;
  /** When set, the number of rows the statement must change, or the delivery is rejected. */
  readonly expectRows?: number | undefined;
  /** How long the statement may run, or wait on a lock, on the server. */
  readonly statementTimeoutMs: number;
}

/**
 * A database failure the engine retries: `code` is the driver's code or the server's SQLSTATE or
 * error number, and the text is fixed, since a driver's own text can quote a row.
 *
 * @example
 * ```ts
 * const error = new DatabaseDeliveryError("40P01"); // a deadlock, retried
 * ```
 */
export class DatabaseDeliveryError extends Error {
  readonly code: string;

  /** @param code The driver's code, or the server's SQLSTATE or error number. Never its text. */
  constructor(code: string) {
    super(`the database statement failed (${code})`);
    this.name = "DatabaseDeliveryError";
    this.code = code;
  }
}

/** What a code may hold to be kept: the engine keeps a source's code by the same rule. */
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** PostgreSQL's and the SQL standard's SQLSTATE classes of data and integrity constraint errors. */
const REJECTED_CLASSES = ["22", "23"] as const;

/**
 * MySQL and MariaDB errors that refuse a row's data, beyond those whose SQLSTATE is in class 22 or
 * 23: an incorrect value for a column (1366), a CHECK constraint on MySQL (3819) and on MariaDB
 * (4025).
 */
const MYSQL_REJECTED = [1366, 3819, 4025] as const;

/**
 * SQL Server errors that refuse a row's data: arithmetic overflow (220, 8115), conversion (241, 245,
 * 8114), a date out of range (242), a null where none is allowed (515), a constraint (547), a
 * duplicate key (2601, 2627), and data that would be truncated (2628, 8152).
 */
const SQLSERVER_REJECTED = [
  220, 241, 242, 245, 515, 547, 2601, 2627, 2628, 8114, 8115, 8152,
] as const;

/** Reads a delivery's body as UTF-8, refusing bytes that are not. */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Runs one parameterised statement per delivery, in a transaction of its own, on a database server
 * or SQLite. A data or constraint error is rejected for good; a connection error, a timeout, a
 * deadlock and anything else is retried.
 *
 * @example
 * ```ts
 * const destination = new DatabaseDestination(options);
 * await destination.deliver({ messageId: 12, seq: 0, body });
 * await destination.stop();
 * ```
 */
export class DatabaseDestination implements DestinationConnector {
  readonly #options: DatabaseDestinationOptions;
  readonly #db: Kysely<unknown>;

  /** @param options The database, its statement, and the limits each delivery runs under. */
  constructor(options: DatabaseDestinationOptions) {
    this.#options = options;
    this.#db = new Kysely<unknown>({ dialect: options.dialect });
  }

  /**
   * Runs the statement once for `message`, in a transaction of its own, with its id, `seq` and
   * output bound as parameters.
   *
   * @throws {DeliveryRejected} for an output that is not UTF-8, a data or constraint error, or a
   *   count of rows other than `expectRows`: the transaction is rolled back.
   * @throws {DatabaseDeliveryError} for anything else, which the engine retries.
   */
  async deliver(message: OutgoingMessage): Promise<void> {
    const { kind, statement, expectRows, statementTimeoutMs } = this.#options;
    let output: string;
    try {
      output = UTF8.decode(message.body);
    } catch {
      throw new DeliveryRejected("output is not UTF-8");
    }
    let values: (string | number)[];
    try {
      values = bindParameters(statement, {
        messageId: message.messageId,
        seq: message.seq,
        output,
      });
    } catch (error) {
      throw new DeliveryRejected((error as StatementError).message);
    }
    const limit = timeoutStatement(kind, statementTimeoutMs);
    // SQL Server runs each request through sp_executesql, whose SET options end with it, so there
    // the limit goes first in the statement's own batch.
    const inBatch = kind === "sqlserver";
    const text = inBatch ? `${String(limit)};\n${statement.sql}` : statement.sql;
    // What failed inside the transaction: a rollback that fails after it (SQL Server ends the
    // transaction itself on some errors, such as a failed conversion) does not hide it.
    let failure: { readonly thrown: unknown } | undefined;
    try {
      await this.#db.transaction().execute(async (trx) => {
        try {
          if (limit !== undefined && !inBatch) await trx.executeQuery(CompiledQuery.raw(limit));
          const result = await trx.executeQuery(CompiledQuery.raw(text, values));
          const rows = result.numAffectedRows;
          if (expectRows !== undefined && (rows === undefined || Number(rows) !== expectRows)) {
            throw new DeliveryRejected(
              `expectRows ${expectRows}, changed ${rows === undefined ? "none" : String(rows)}`,
            );
          }
        } catch (thrown) {
          failure = { thrown };
          throw thrown;
        }
      });
    } catch (error) {
      throw databaseFailure(kind, failure === undefined ? error : failure.thrown);
    }
  }

  /** Closes the destination's connection pool. */
  async stop(): Promise<void> {
    await this.#db.destroy();
  }
}

/**
 * The statement that bounds the next one on `kind`'s server, run first in each delivery's
 * transaction, or undefined where the dialect bounds it another way.
 *
 * - PostgreSQL: `statement_timeout`, for this transaction alone.
 * - MySQL and MariaDB: `innodb_lock_wait_timeout`, in whole seconds, at least 1: the wait for a row
 *   lock. Neither server bounds every statement by one setting both read.
 * - SQL Server: `LOCK_TIMEOUT`, the wait for a lock, run in the statement's own batch; the
 *   connection's request timeout bounds the rest.
 * - SQLite: none; its connection waits up to 5 seconds for another writer.
 *
 * @example
 * ```ts
 * timeoutStatement("postgres", 10_000); // "set local statement_timeout = 10000"
 * ```
 */
export function timeoutStatement(kind: StorageKind, ms: number): string | undefined {
  const whole = Math.max(1, Math.ceil(ms));
  switch (kind) {
    case "postgres":
      return `set local statement_timeout = ${whole}`;
    case "mysql":
      return `set session innodb_lock_wait_timeout = ${Math.max(1, Math.ceil(ms / 1_000))}`;
    case "sqlserver":
      return `set lock_timeout ${whole}`;
    case "sqlite":
      return undefined;
  }
}

/**
 * What a failed delivery throws: a {@link DeliveryRejected} for a data or constraint error, which
 * sending again cannot fix, and a {@link DatabaseDeliveryError} carrying only a code for the rest.
 * Neither carries the driver's text.
 *
 * @example
 * ```ts
 * databaseFailure("postgres", Object.assign(new Error("..."), { code: "23505" })); // DeliveryRejected("sqlstate 23505")
 * ```
 */
export function databaseFailure(kind: StorageKind, thrown: unknown): Error {
  if (thrown instanceof DeliveryRejected) return thrown;
  const error = first(thrown);
  const code = error["code"];
  switch (kind) {
    case "postgres":
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
        if (REJECTED_CLASSES.some((rejected) => code.startsWith(rejected))) {
          return new DeliveryRejected(`sqlstate ${code}`);
        }
      }
      break;
    case "mysql": {
      const { errno, sqlState } = error;
      const refused =
        (typeof sqlState === "string" &&
          REJECTED_CLASSES.some((rejected) => sqlState.startsWith(rejected))) ||
        (typeof errno === "number" && (MYSQL_REJECTED as readonly number[]).includes(errno));
      if (refused) return new DeliveryRejected(`mysql ${String(errno)}`);
      break;
    }
    case "sqlserver": {
      const { number } = error;
      if (typeof number !== "number") break;
      if ((SQLSERVER_REJECTED as readonly number[]).includes(number)) {
        return new DeliveryRejected(`sqlserver ${number}`);
      }
      return new DatabaseDeliveryError(`SQLSERVER_${number}`);
    }
    case "sqlite":
      if (
        typeof code === "string" &&
        (code.startsWith("SQLITE_CONSTRAINT") ||
          code === "SQLITE_MISMATCH" ||
          code === "SQLITE_TOOBIG")
      ) {
        return new DeliveryRejected(`sqlite ${code}`);
      }
      break;
  }
  return new DatabaseDeliveryError(
    typeof code === "string" && CODE.test(code) ? code : "DATABASE_ERROR",
  );
}

/**
 * The error that says why: tedious reports a statement's errors together, the server's own first,
 * as an `AggregateError`, which Kysely hands on as the plain list of its errors.
 */
function first(thrown: unknown): Readonly<Record<string, unknown>> {
  const list: unknown =
    thrown instanceof AggregateError ? thrown.errors : Array.isArray(thrown) ? thrown : undefined;
  if (Array.isArray(list)) {
    const found: unknown = list.find(
      (each) => typeof (each as { number?: unknown } | undefined)?.number === "number",
    );
    return first(found ?? list[0]);
  }
  return typeof thrown === "object" && thrown !== null ? (thrown as Record<string, unknown>) : {};
}
