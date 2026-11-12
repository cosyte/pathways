import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindParameters,
  parseStatement,
  readStatement,
  STATEMENT_PARAMETERS,
  StatementError,
} from "../src/connectors/sql-statement.js";
import { cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

/** What `parseStatement` refuses `text` with on `kind`. */
function refusal(text: string, kind: Parameters<typeof parseStatement>[1] = "postgres"): string {
  try {
    parseStatement(text, kind);
  } catch (error) {
    expect(error).toBeInstanceOf(StatementError);
    return (error as StatementError).message;
  }
  throw new Error("the statement was accepted");
}

describe("parseStatement", () => {
  const insert = "insert into results (id, seq, body) values (:messageId, :seq, :output)";

  it("rewrites each parameter to the driver's placeholder", () => {
    expect(parseStatement(insert, "postgres")).toEqual({
      sql: "insert into results (id, seq, body) values ($1, $2, $3)",
      parameters: ["messageId", "seq", "output"],
    });
    expect(parseStatement(insert, "sqlserver")).toEqual({
      sql: "insert into results (id, seq, body) values (@1, @2, @3)",
      parameters: ["messageId", "seq", "output"],
    });
    for (const kind of ["mysql", "sqlite"] as const) {
      expect(parseStatement(insert, kind)).toEqual({
        sql: "insert into results (id, seq, body) values (?, ?, ?)",
        parameters: ["messageId", "seq", "output"],
      });
    }
  });

  it("numbers a name used twice once where the driver numbers, and binds it twice where it does not", () => {
    const text = "update t set a = :output, b = :seq where c = :output";
    expect(parseStatement(text, "postgres")).toEqual({
      sql: "update t set a = $1, b = $2 where c = $1",
      parameters: ["output", "seq"],
    });
    expect(parseStatement(text, "sqlserver").sql).toBe("update t set a = @1, b = @2 where c = @1");
    expect(parseStatement(text, "mysql")).toEqual({
      sql: "update t set a = ?, b = ? where c = ?",
      parameters: ["output", "seq", "output"],
    });
  });

  it("passes over literals, quoted identifiers and comments on every kind", () => {
    const text = [
      "-- :output in a line comment",
      "/* :output in a block comment */",
      "insert into \"t:seq\" (a, b) values (':output', ''':seq''', :messageId) -- :seq",
    ].join("\n");
    for (const kind of ["postgres", "mysql", "sqlserver", "sqlite"] as const) {
      const { parameters } = parseStatement(text, kind);
      expect(parameters, kind).toEqual(["messageId"]);
    }
  });

  it("reads PostgreSQL's casts, dollar quotes, escape strings and nested comments", () => {
    const text = [
      "insert into t (a, b, c, d)",
      "values (:seq::int, $$:output$$, $tag$ $$ :output $tag$, E'\\':output', x$y$ + :messageId)",
      "/* outer /* :output */ still a comment :output */",
    ].join("\n");
    const { sql, parameters } = parseStatement(text, "postgres");
    expect(parameters).toEqual(["seq", "messageId"]);
    expect(sql).toContain("$1::int");
    expect(sql).toContain("x$y$ + $2");
    expect(sql).toContain("E'\\':output'");
  });

  it("reads MySQL's backslash escapes, backticks and # comments", () => {
    const text =
      "insert into `t:seq` values ('it\\'s :output', \"q\\\":seq\", :messageId) # :output";
    expect(parseStatement(text, "mysql")).toEqual({
      sql: "insert into `t:seq` values ('it\\'s :output', \"q\\\":seq\", ?) # :output",
      parameters: ["messageId"],
    });
  });

  it("reads T-SQL's brackets and nested comments", () => {
    const text = "insert into [t:seq]]x] values (:output) /* a /* :seq */ :seq */";
    expect(parseStatement(text, "sqlserver")).toEqual({
      sql: "insert into [t:seq]]x] values (@1) /* a /* :seq */ :seq */",
      parameters: ["output"],
    });
    // SQLite reads brackets and backticks as identifiers too, and does not nest comments.
    expect(
      parseStatement("insert into [a:seq] values (`:seq`, :output)", "sqlite").parameters,
    ).toEqual(["output"]);
    expect(parseStatement("select 1 /* /* */ :seq", "sqlite").parameters).toEqual(["seq"]);
  });

  it("does not read a bracket as an identifier on PostgreSQL, nor nest MySQL's comments", () => {
    expect(parseStatement("select a[:seq]", "postgres").parameters).toEqual(["seq"]);
    expect(parseStatement("select /* /* */ :seq", "mysql").parameters).toEqual(["seq"]);
  });

  it("leaves a colon that starts no name as it is", () => {
    expect(parseStatement("select 1 : 2, a[1:2], :seq", "postgres")).toEqual({
      sql: "select 1 : 2, a[1:2], $1",
      parameters: ["seq"],
    });
  });

  it("allows one terminating semicolon, with comments after it", () => {
    expect(
      parseStatement("insert into t values (:seq); -- done\n/* end */\n", "mysql").parameters,
    ).toEqual(["seq"]);
    expect(parseStatement("select 1 # a\n;", "mysql").sql).toBe("select 1 # a\n;");
  });

  it("refuses a second statement, however it is written", () => {
    expect(refusal("insert into t values (1); delete from t")).toBe(
      "line 1: a second statement; a statement file holds one statement",
    );
    expect(refusal("select 1;\n\n;")).toBe(
      "line 3: a second statement; a statement file holds one statement",
    );
    expect(refusal("select ';'; select 2", "sqlserver")).toBe(
      "line 1: a second statement; a statement file holds one statement",
    );
  });

  it("refuses a file that holds no statement", () => {
    expect(refusal("")).toBe("holds no statement");
    expect(refusal("  -- nothing\n/* here */\n;")).toBe("holds no statement");
  });

  it("refuses a name it does not bind, naming the ones it does", () => {
    expect(refusal("select 1;\nselect :patient")).toBe(
      "line 2: a second statement; a statement file holds one statement",
    );
    expect(refusal("insert into t\nvalues (:patient)")).toBe(
      "line 2: :patient is not a parameter Pathways binds; use :messageId, :seq, :output",
    );
    expect(parseStatement("select :mrn", "postgres", ["mrn"]).parameters).toEqual(["mrn"]);
  });

  it("refuses the driver's own placeholders, which would shift what a parameter binds", () => {
    expect(refusal("select $1, :seq", "postgres")).toBe(
      "line 1: $1 is the driver's own placeholder; write a parameter as :name",
    );
    expect(refusal("select ?, :seq", "mysql")).toBe(
      "line 1: ? is the driver's own placeholder; write a parameter as :name",
    );
    expect(refusal("select ?", "sqlite")).toBe(
      "line 1: ? is the driver's own placeholder; write a parameter as :name",
    );
    expect(refusal("select\n@12", "sqlserver")).toBe(
      "line 2: @12 is the driver's own placeholder; write a parameter as :name",
    );
    // Each is ordinary SQL elsewhere: a JSON operator, a variable, a dollar sign in a name.
    expect(parseStatement("select data ? 'k', @x, $1", "sqlserver").parameters).toEqual([]);
    expect(parseStatement("select data ? 'k', @1", "postgres").parameters).toEqual([]);
    expect(parseStatement("select $1, @1", "mysql").parameters).toEqual([]);
    expect(parseStatement("select @x, $y", "sqlite").parameters).toEqual([]);
  });

  it("refuses what is opened and never closed", () => {
    expect(refusal("select 'open")).toBe("line 1: a string literal that is never closed");
    expect(refusal('select\n"open')).toBe("line 2: a quoted identifier that is never closed");
    expect(refusal("select `open", "mysql")).toBe(
      "line 1: a quoted identifier that is never closed",
    );
    expect(refusal("select [open", "sqlserver")).toBe(
      "line 1: a bracketed identifier that is never closed",
    );
    expect(refusal("select /* open")).toBe("line 1: a comment that is never closed");
    expect(refusal("select /* a /* b */")).toBe("line 1: a comment that is never closed");
    expect(refusal("select $q$ open")).toBe("line 1: a dollar quote that is never closed");
    expect(refusal("select 'a\\'", "mysql")).toBe("line 1: a string literal that is never closed");
    expect(refusal("select E'a\\'")).toBe("line 1: a string literal that is never closed");
  });

  it("reads a backslash as itself in a standard PostgreSQL string, and in an identifier ending in e", () => {
    expect(parseStatement("select 'a\\', :seq", "postgres").parameters).toEqual(["seq"]);
    expect(parseStatement("select some'a\\', :seq", "postgres").parameters).toEqual(["seq"]);
  });

  it("refuses no well-formed statement, and binds only names it found", () => {
    const pieces = fc.constantFrom(
      "select",
      " ",
      "\n",
      ":seq ",
      ":output ",
      ":messageId ",
      "'a:seq'",
      '"b:seq"',
      "-- :seq\n",
      "/* :seq */",
      "::int",
      "x",
      "1",
    );
    fc.assert(
      fc.property(
        fc.array(pieces, { maxLength: 30 }),
        fc.constantFrom(...(["postgres", "mysql", "sqlserver", "sqlite"] as const)),
        (parts, kind) => {
          const text = `select ${parts.join("")}`;
          const { parameters } = parseStatement(text, kind);
          const written = parts
            .filter((part) => /^:[a-zA-Z]/.test(part))
            .map((part) => part.slice(1, -1));
          if (kind === "mysql" || kind === "sqlite") expect(parameters).toEqual(written);
          else expect(parameters).toEqual([...new Set(written)]);
        },
      ),
    );
  });
});

describe("bindParameters", () => {
  it("binds each placeholder's value in order", () => {
    const statement = parseStatement("select :output, :seq, :output", "mysql");
    expect(bindParameters(statement, { output: "MSH|", seq: 0, messageId: 1 })).toEqual([
      "MSH|",
      0,
      "MSH|",
    ]);
  });

  it("refuses a parameter with no value, never binding null", () => {
    const statement = parseStatement("select :mrn", "postgres", ["mrn"]);
    expect(() => bindParameters(statement, {})).toThrow(new StatementError(":mrn has no value"));
  });
});

describe("readStatement", () => {
  it("reads a file inside the project", async () => {
    const root = await makeProject({ "channels/out/insert.sql": "insert into t values (:seq)\n" });
    await expect(
      readStatement(join(root, "channels/out/insert.sql"), "sqlite", root),
    ).resolves.toEqual({
      sql: "insert into t values (?)\n",
      parameters: ["seq"],
    });
  });

  it("refuses a file outside the project, through a symbolic link too", async () => {
    const outside = await makeProject({ "insert.sql": "select 1" });
    const root = await makeProject({});
    await mkdir(join(root, "channels"), { recursive: true });
    await symlink(join(outside, "insert.sql"), join(root, "channels", "linked.sql"));
    for (const file of [join(outside, "insert.sql"), join(root, "channels", "linked.sql")]) {
      await expect(readStatement(file, "sqlite", root)).rejects.toThrow(
        new StatementError("the file is outside the project; keep statement files inside it"),
      );
    }
    // Without a project, any file.
    await expect(readStatement(join(outside, "insert.sql"), "sqlite")).resolves.toEqual({
      sql: "select 1",
      parameters: [],
    });
  });

  it("refuses a file that is missing, or a folder", async () => {
    const root = await makeProject({});
    await writeFile(join(root, "empty.sql"), "");
    await expect(readStatement(join(root, "missing.sql"), "sqlite", root)).rejects.toThrow(
      new StatementError("the file does not exist or cannot be read"),
    );
    await expect(readStatement(root, "sqlite", root)).rejects.toThrow(
      new StatementError("the file does not exist or cannot be read"),
    );
    await expect(readStatement(join(root, "empty.sql"), "sqlite", root)).rejects.toThrow(
      new StatementError("holds no statement"),
    );
  });

  it("names what it binds", () => {
    expect(STATEMENT_PARAMETERS).toEqual(["messageId", "seq", "output"]);
  });
});
