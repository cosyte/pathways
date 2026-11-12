import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type { StorageKind } from "../config/schema.js";

// A database destination's statement file, read by our own tokeniser rather than by string
// replacement: it finds each `:name` parameter outside string literals, quoted identifiers, comments
// and dollar quotes, passes over `::` casts, and rewrites each to the driver's own placeholder. A
// value is always sent beside the SQL as a bound parameter, never written into it.

/**
 * The parameters a database destination's statement may name, each written `:name`: the stored
 * message's id, the output's `seq` within it, and the output itself as UTF-8 text.
 *
 * @example
 * ```ts
 * STATEMENT_PARAMETERS.includes("output"); // true
 * ```
 */
export const STATEMENT_PARAMETERS = ["messageId", "seq", "output"] as const;

/**
 * A statement file read for one kind of database: its SQL with each `:name` rewritten to the
 * driver's placeholder, and the name of the value each placeholder binds, in order.
 *
 * @example
 * ```ts
 * const statement: Statement = { sql: "insert into results values ($1, $2)", parameters: ["messageId", "output"] };
 * ```
 */
export interface Statement {
  readonly sql: string;
  readonly parameters: readonly string[];
}

/**
 * Why a statement file cannot be used: its text names the line, never the SQL around it.
 *
 * @example
 * ```ts
 * try {
 *   parseStatement(text, "postgres");
 * } catch (error) {
 *   if (error instanceof StatementError) problems.push(`statement: ${error.message}`);
 * }
 * ```
 */
export class StatementError extends Error {
  /** @param message What is wrong, naming a line and never the SQL around it. */
  constructor(message: string) {
    super(message);
    this.name = "StatementError";
  }
}

/** The first character of a parameter's name, and the rest of it. */
const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
/** A PostgreSQL dollar quote's opening tag: `$$` or `$tag$`. */
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const SPACE = /\s/;

/**
 * Reads `text`, a statement file, for a database of `kind`: exactly one statement, whose `:name`
 * parameters each name one of `known`. A statement may end with one `;`, followed by nothing but
 * whitespace and comments.
 *
 * What the tokeniser passes over, for each kind:
 *
 * - every kind: `'...'` literals (`''` inside), `"..."` (`""` inside), `--` and block comments;
 * - PostgreSQL: nested block comments, `E'...'` with backslash escapes, `$$...$$` and
 *   `$tag$...$tag$` dollar quotes, and `::` casts;
 * - MySQL and MariaDB: backslash escapes in `'...'` and `"..."`, `` `...` `` identifiers, and `#`
 *   comments;
 * - SQL Server: `[...]` identifiers (`]]` inside), and nested block comments;
 * - SQLite: `[...]` and `` `...` `` identifiers.
 *
 * The driver's own placeholders are refused, so none can shift what a parameter binds: `$1` on
 * PostgreSQL, `?` on MySQL and SQLite, `@1` on SQL Server.
 *
 * @throws {StatementError} when the file holds no statement, more than one, an unterminated literal,
 *   identifier or comment, a driver's placeholder, or a `:name` that is not in `known`.
 * @example
 * ```ts
 * parseStatement("insert into t (id, body) values (:messageId, :output)", "postgres");
 * // { sql: "insert into t (id, body) values ($1, $2)", parameters: ["messageId", "output"] }
 * ```
 */
export function parseStatement(
  text: string,
  kind: StorageKind,
  known: readonly string[] = STATEMENT_PARAMETERS,
): Statement {
  const pieces: string[] = [];
  const named: string[] = [];
  /** For PostgreSQL and SQL Server, which number their placeholders: each name once. */
  const numbered: string[] = [];
  let copied = 0;
  let ended = false;
  let found = false;
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const next = text.charAt(at + 1);
    const comment = commentEnd(text, at, kind);
    if (comment !== undefined) {
      at = comment;
      continue;
    }
    if (SPACE.test(char)) {
      at += 1;
      continue;
    }
    if (ended) {
      throw new StatementError(
        `line ${lineOf(text, at)}: a second statement; a statement file holds one statement`,
      );
    }
    if (char === ";") {
      ended = true;
      at += 1;
      continue;
    }
    found = true;
    const quoted = quoteEnd(text, at, kind);
    if (quoted !== undefined) {
      at = quoted;
      continue;
    }
    if (char === ":" && next === ":") {
      at += 2;
      continue;
    }
    if (char === ":") {
      NAME.lastIndex = at + 1;
      const name = NAME.exec(text)?.[0];
      if (name !== undefined) {
        if (!known.includes(name)) {
          throw new StatementError(
            `line ${lineOf(text, at)}: :${name} is not a parameter Pathways binds; use ${known.map((each) => `:${each}`).join(", ")}`,
          );
        }
        pieces.push(text.slice(copied, at), placeholder(kind, name, named, numbered));
        at += 1 + name.length;
        copied = at;
        continue;
      }
    }
    const native = nativePlaceholder(text, at, kind);
    if (native !== undefined) {
      throw new StatementError(
        `line ${lineOf(text, at)}: ${native} is the driver's own placeholder; write a parameter as :name`,
      );
    }
    at += 1;
  }
  if (!found) throw new StatementError("holds no statement");
  pieces.push(text.slice(copied));
  return {
    sql: pieces.join(""),
    parameters: kind === "postgres" || kind === "sqlserver" ? numbered : named,
  };
}

/** The driver's placeholder for `name`, recording the value it binds. */
function placeholder(kind: StorageKind, name: string, named: string[], numbered: string[]): string {
  named.push(name);
  if (kind === "mysql" || kind === "sqlite") return "?";
  let index = numbered.indexOf(name);
  if (index < 0) index = numbered.push(name) - 1;
  // Kysely's SQL Server driver names its parameters 1, 2 and so on.
  return kind === "postgres" ? `$${index + 1}` : `@${index + 1}`;
}

/** Where a comment starting at `at` ends, or undefined when none starts there. */
function commentEnd(text: string, at: number, kind: StorageKind): number | undefined {
  const char = text.charAt(at);
  const next = text.charAt(at + 1);
  if ((char === "-" && next === "-") || (char === "#" && kind === "mysql")) {
    const end = text.indexOf("\n", at);
    return end < 0 ? text.length : end + 1;
  }
  if (char !== "/" || next !== "*") return undefined;
  const nests = kind === "postgres" || kind === "sqlserver";
  let depth = 0;
  let index = at;
  while (index < text.length) {
    const pair = text.slice(index, index + 2);
    if (pair === "/*" && (nests || depth === 0)) {
      depth += 1;
      index += 2;
    } else if (pair === "*/") {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  throw new StatementError(`line ${lineOf(text, at)}: a comment that is never closed`);
}

/**
 * Where a string literal, quoted identifier or dollar quote starting at `at` ends, or undefined
 * when none starts there.
 */
function quoteEnd(text: string, at: number, kind: StorageKind): number | undefined {
  const char = text.charAt(at);
  if (char === "'") {
    const escapes = kind === "mysql" || (kind === "postgres" && escapeString(text, at));
    return closing(text, at, "'", escapes, "a string literal");
  }
  if (char === '"') return closing(text, at, '"', kind === "mysql", "a quoted identifier");
  if (char === "`" && (kind === "mysql" || kind === "sqlite")) {
    return closing(text, at, "`", false, "a quoted identifier");
  }
  if (char === "[" && (kind === "sqlserver" || kind === "sqlite")) {
    return closing(text, at, "]", false, "a bracketed identifier");
  }
  if (char === "$" && kind === "postgres" && !IDENTIFIER_CHAR.test(text.charAt(at - 1))) {
    DOLLAR_TAG.lastIndex = at;
    const tag = DOLLAR_TAG.exec(text)?.[0];
    if (tag === undefined) return undefined;
    const end = text.indexOf(tag, at + tag.length);
    if (end < 0)
      throw new StatementError(`line ${lineOf(text, at)}: a dollar quote that is never closed`);
    return end + tag.length;
  }
  return undefined;
}

/** Whether the `'` at `at` opens a PostgreSQL escape string, `E'...'`. */
function escapeString(text: string, at: number): boolean {
  return /[Ee]/.test(text.charAt(at - 1)) && !IDENTIFIER_CHAR.test(text.charAt(at - 2));
}

/**
 * Where the quoted text opened at `at` ends: after its closing `close`, where a doubled `close` is
 * one character of the text, and with `escapes`, a backslash escapes the character after it.
 */
function closing(text: string, at: number, close: string, escapes: boolean, what: string): number {
  let index = at + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (escapes && char === "\\") {
      index += 2;
    } else if (char !== close) {
      index += 1;
    } else if (text.charAt(index + 1) === close) {
      index += 2;
    } else {
      return index + 1;
    }
  }
  throw new StatementError(`line ${lineOf(text, at)}: ${what} that is never closed`);
}

/** The driver's own placeholder starting at `at`, as written, or undefined when none does. */
function nativePlaceholder(text: string, at: number, kind: StorageKind): string | undefined {
  const char = text.charAt(at);
  const digits = /\d+/y;
  digits.lastIndex = at + 1;
  const number = digits.exec(text)?.[0];
  if (char === "?" && (kind === "mysql" || kind === "sqlite")) return "?";
  if (number === undefined) return undefined;
  if (char === "$" && kind === "postgres") return `$${number}`;
  if (char === "@" && kind === "sqlserver") return `@${number}`;
  return undefined;
}

/** The line `at` is on, from 1. */
function lineOf(text: string, at: number): number {
  return text.slice(0, at).split("\n").length;
}

/**
 * The values a statement binds, in its placeholders' order, from `values` by name.
 *
 * @throws {StatementError} when a name has no value: never bound as null.
 * @example
 * ```ts
 * bindParameters({ sql: "...", parameters: ["messageId", "output"] }, { messageId: 12, output: "MSH|..." });
 * // [12, "MSH|..."]
 * ```
 */
export function bindParameters(
  statement: Statement,
  values: Readonly<Record<string, string | number | undefined>>,
): (string | number)[] {
  return statement.parameters.map((name) => {
    const value = values[name];
    if (value === undefined) throw new StatementError(`:${name} has no value`);
    return value;
  });
}

/**
 * Reads and parses a statement file for a database of `kind`. With `root`, the file, once its
 * symbolic links are followed, must be inside that folder: a statement comes from the project.
 *
 * @throws {StatementError} when the file is missing, outside `root`, or not one statement
 *   {@link parseStatement} reads: never any other error.
 * @example
 * ```ts
 * const statement = await readStatement("/srv/project/channels/results/insert.sql", "postgres", "/srv/project");
 * ```
 */
export async function readStatement(
  file: string,
  kind: StorageKind,
  root?: string,
): Promise<Statement> {
  let real: string;
  let text: string;
  let project: string | undefined;
  try {
    real = await realpath(file);
    text = await readFile(real, "utf8");
    project = root === undefined ? undefined : await realpath(root);
  } catch {
    throw new StatementError("the file does not exist or cannot be read");
  }
  if (project !== undefined) {
    const inside = relative(project, real);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new StatementError("the file is outside the project; keep statement files inside it");
    }
  }
  return parseStatement(text, kind);
}
