import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as oracleParse } from "csv-parse/sync";
import fc from "fast-check";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import type { CsvRecord, CsvTable, MessageFor, TransformFor } from "../src/transform.js";
import { loadProject } from "../src/config/load.js";
import { ChannelWorker } from "../src/engine/channel-worker.js";
import { Engine } from "../src/engine/engine.js";
import {
  CSV_DEFAULTS,
  decode,
  encode,
  readCsv,
  runTransform,
  summarize,
  writeCsv,
  type CsvSettings,
} from "../src/engine/worker-entry.js";
import { TEST_DATABASES, testStorage } from "./databases.js";
import { captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

// Every cell below is synthetic: codes and names that are plainly fake.

afterEach(cleanUp);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
/** Keeps a byte order mark, so a test can see it was written. */
const text = (body: Uint8Array): string =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
const BOM = String.fromCharCode(0xfeff);

/** Reads `body` with `settings`, through the format registry, as a worker does. */
const read = (body: string | Uint8Array, settings: CsvSettings = {}): Promise<CsvTable> =>
  decode("csv", typeof body === "string" ? bytes(body) : body, { csv: settings });

/** Writes `table` with `settings`, through the format registry, as a worker does. */
const write = async (table: unknown, settings: CsvSettings = {}): Promise<string> =>
  text(await encode("csv", table, { csv: settings }));

/** Reads and writes `body` back, untouched. */
const roundTrip = async (body: string, settings: CsvSettings = {}): Promise<string> =>
  write(await read(body, settings), settings);

/** The code a promise rejects with, and its text. */
async function refusal(promise: Promise<unknown>): Promise<{ code?: string; text: string }> {
  try {
    await promise;
  } catch (error) {
    const summary = summarize(error);
    return { ...(summary.code === undefined ? {} : { code: summary.code }), text: summary.detail };
  }
  throw new Error("expected a refusal");
}

describe("format: csv, read", () => {
  it("reads a header and rows on objects with no prototype", async () => {
    const table = await read("code,name\r\nTEST-001,Example One\r\nTEST-002,Example Two\r\n");
    expect(table.header).toEqual(["code", "name"]);
    expect(table.rows).toEqual([
      Object.assign(Object.create(null), { code: "TEST-001", name: "Example One" }),
      Object.assign(Object.create(null), { code: "TEST-002", name: "Example Two" }),
    ]);
    expect(Object.getPrototypeOf(table.rows[0])).toBeNull();
  });

  it("reads arrays when the settings say there is no header", async () => {
    const table = await read("TEST-001,Example\nTEST-002,Other\n", { header: false });
    expect(table).toEqual({
      header: null,
      rows: [
        ["TEST-001", "Example"],
        ["TEST-002", "Other"],
      ],
    });
  });

  it("keeps CRLF, LF, a bare CR and doubled quotes inside a quoted cell", async () => {
    const body = 'code,note\r\nTEST-001,"line one\r\nline two\nthree\rfour, ""quoted"""\r\n';
    const table = await read(body);
    expect((table.rows[0] as CsvRecord)["note"]).toBe(
      'line one\r\nline two\nthree\rfour, "quoted"',
    );
    expect(await roundTrip(body)).toBe(body);
  });

  it("reads lines ending in CRLF, LF and a bare CR, mixed", async () => {
    const table = await read("a,b\r\n1,2\n3,4\r5,6", { header: false });
    expect(table.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("refuses a ragged row unless pad is set, and pads a short one with empty cells", async () => {
    const body = "code,name,unit\r\nTEST-001,Example\r\n";
    expect(await refusal(read(body))).toEqual({
      code: "CSV_RAGGED_ROW",
      text: "line 2 has 2 cells where the first has 3; set pad: true to pad a short one",
    });
    const padded = await read(body, { pad: true });
    expect((padded.rows[0] as CsvRecord)["unit"]).toBe("");
    // An untouched padded row is written as it was read.
    expect(await roundTrip(body, { pad: true })).toBe(body);
    // A long row is refused even with pad: a cell would have no column.
    expect((await refusal(read("a,b\r\n1,2,3\r\n", { pad: true }))).code).toBe("CSV_RAGGED_ROW");
    expect((await refusal(read("1,2\r\n3\r\n", { header: false }))).code).toBe("CSV_RAGGED_ROW");
    expect(await read("1,2\r\n3\r\n", { header: false, pad: true })).toEqual({
      header: null,
      rows: [
        ["1", "2"],
        ["3", ""],
      ],
    });
  });

  it("refuses a header that names a column twice", async () => {
    expect(await refusal(read("code,name,code\r\n1,2,3\r\n"))).toEqual({
      code: "CSV_DUPLICATE_HEADER",
      text: "header column 3 repeats a name",
    });
  });

  it("reads a column named __proto__ or constructor as a cell like any other", async () => {
    const table = await read("__proto__,constructor,toString\r\nTEST-A,TEST-B,TEST-C\r\n");
    const row = table.rows[0] as Record<string, string>;
    expect(Object.getPrototypeOf(row)).toBeNull();
    expect(Object.keys(row)).toEqual(["__proto__", "constructor", "toString"]);
    expect(row["__proto__"]).toBe("TEST-A");
    expect(row["constructor"]).toBe("TEST-B");
    // No object's prototype was set to the cell: a plain object reads no such key.
    const plain: Record<string, unknown> = {};
    expect(plain["TEST-A"]).toBeUndefined();
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(await write(table)).toBe("__proto__,constructor,toString\r\nTEST-A,TEST-B,TEST-C\r\n");
  });

  it("drops a UTF-8 byte order mark on read and writes it back", async () => {
    const body = `${BOM}code\r\nTEST-001\r\n`;
    const table = await read(body);
    expect(table.header).toEqual(["code"]);
    expect(await roundTrip(body)).toBe(body);
    expect(await roundTrip(BOM)).toBe(BOM);
  });

  it("reads a body with no trailing newline, and keeps it without one", async () => {
    const body = "code\r\nTEST-001";
    expect((await read(body)).rows).toHaveLength(1);
    expect(await roundTrip(body)).toBe(body);
    const table = await read(body);
    (table.rows as Record<string, string>[]).push(
      Object.assign(Object.create(null) as Record<string, string>, { code: "TEST-002" }),
    );
    expect(await write(table)).toBe("code\r\nTEST-001\r\nTEST-002");
  });

  it("reads an empty file as an empty table, and writes it back empty", async () => {
    expect(await read("")).toEqual({ header: [], rows: [] });
    expect(await read("", { header: false })).toEqual({ header: null, rows: [] });
    expect(await roundTrip("")).toBe("");
    expect(await roundTrip("code\r\n")).toBe("code\r\n");
  });

  it("refuses a quote that is never closed, naming the line and not its text", async () => {
    expect(await refusal(read('code,note\r\nTEST-001,"never closed\r\n'))).toEqual({
      code: "CSV_UNTERMINATED_QUOTE",
      text: "line 2 opens a quote it never closes",
    });
  });

  it("refuses a stray quote, and text after a closing quote", async () => {
    expect((await refusal(read('a,b"c\r\n'))).code).toBe("CSV_INVALID_QUOTE");
    expect((await refusal(read('a,"b"c\r\n'))).code).toBe("CSV_INVALID_QUOTE");
  });

  it("refuses a line longer than maxRowLength, quoted or not", async () => {
    expect(await refusal(read("a,bcdef\r\n", { maxRowLength: 4 }))).toEqual({
      code: "CSV_ROW_TOO_LONG",
      text: "line 1 is longer than maxRowLength (4 characters)",
    });
    // A quote left open stops at the cap, not at the end of the body.
    expect((await refusal(read(`"${"x".repeat(100)}`, { maxRowLength: 10 }))).code).toBe(
      "CSV_ROW_TOO_LONG",
    );
    expect(await read("abcd\r\nefgh\r\n", { maxRowLength: 4, header: false })).toEqual({
      header: null,
      rows: [["abcd"], ["efgh"]],
    });
    expect(CSV_DEFAULTS.maxRowLength).toBe(1_048_576);
  });

  it("reads an empty line as one empty cell", async () => {
    expect(await read("a\r\n\r\nb\r\n", { header: false })).toEqual({
      header: null,
      rows: [["a"], [""], ["b"]],
    });
  });

  it("takes its own delimiter, quote and escape", async () => {
    const settings: CsvSettings = { delimiter: "|", quote: "'", escape: "\\", header: false };
    const body = "TEST-001|'it\\'s|here\\\\'|'a\\b'\n";
    const table = await read(body, settings);
    expect(table.rows).toEqual([["TEST-001", "it's|here\\", "a\\b"]]);
    expect(await roundTrip(body, settings)).toBe(body);
    (table.rows[0] as string[])[0] = "TEST-002";
    expect(await write(table, settings)).toBe("TEST-002|'it\\'s|here\\\\'|'a\\\\b'\n");
  });

  it("reads strict UTF-8, or Latin-1 when the settings say so, and writes back in it", async () => {
    const latin1 = new Uint8Array([0x63, 0x0d, 0x0a, 0x45, 0x78, 0xe9, 0x0d, 0x0a]);
    expect((await refusal(read(latin1))).code).toBe("ERR_ENCODING_INVALID_ENCODED_DATA");
    const table = await read(latin1, { encoding: "latin1" });
    expect((table.rows[0] as CsvRecord)["c"]).toBe("Exé");
    // No BOM is read in Latin-1: those bytes are three characters.
    const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x63, 0x0a]);
    expect((await read(bomBytes, { encoding: "latin1" })).header).toEqual(["ï»¿c"]);
    const out = await encode("csv", table, { csv: { encoding: "latin1" } });
    expect([...out]).toEqual([...latin1]);
    (table.rows[0] as Record<string, string>)["c"] = "Exè";
    expect([...(await encode("csv", table, { csv: { encoding: "latin1" } }))].at(-3)).toBe(0xe8);
    (table.rows[0] as Record<string, string>)["c"] = "☃";
    expect(await refusal(encode("csv", table, { csv: { encoding: "latin1" } }))).toEqual({
      code: "CSV_NOT_ENCODABLE",
      text: "the table holds a character Latin-1 cannot write",
    });
  });
});

describe("format: csv, write", () => {
  it("writes an untouched table back byte for byte, whatever its quoting and endings", async () => {
    const body = 'code,"name"\nTEST-001,"Example"\r\n"TEST-002",plain\rTEST-003,""\n';
    expect(await roundTrip(body)).toBe(body);
  });

  it("writes a changed row with the quoting it needs and the body's first line ending", async () => {
    const table = await read("code,name\nTEST-001,Example\nTEST-002,Other\n");
    (table.rows[0] as Record<string, string>)["name"] = 'a, "b"';
    expect(await write(table)).toBe('code,name\nTEST-001,"a, ""b"""\nTEST-002,Other\n');
  });

  it("writes the newline the settings state for a changed or new line", async () => {
    const table = await read("code\nTEST-001\n");
    (table.rows as Record<string, string>[]).push(
      Object.assign(Object.create(null) as Record<string, string>, { code: "TEST-002" }),
    );
    expect(await write(table, { newline: "crlf" })).toBe("code\nTEST-001\nTEST-002\r\n");
    expect(await write(table, { newline: "cr" })).toBe("code\nTEST-001\nTEST-002\r");
    expect(await write({ header: null, rows: [["a"], ["b"]] }, { newline: "lf" })).toBe("a\nb\n");
    // A table a transform built, with no newline stated: CRLF, as RFC 4180 writes.
    expect(await write({ header: null, rows: [["a"], ["b"]] })).toBe("a\r\nb\r\n");
    // A body with one line and no ending: a new line gets the default.
    const single = await read("TEST-001", { header: false });
    (single.rows as string[][]).push(["TEST-002"]);
    expect(await write(single, { header: false })).toBe("TEST-001\r\nTEST-002");
  });

  it("writes a table a transform built, its header first", async () => {
    const built = {
      header: ["code", "count", "flag", "none"],
      rows: [{ code: "TEST-001", count: 3, flag: true, none: null }, { code: "TEST-002" }],
    };
    expect(await write(built)).toBe("code,count,flag,none\r\nTEST-001,3,true,\r\nTEST-002,,,\r\n");
    expect(await write({ header: [], rows: [] })).toBe("");
    expect(await write({ header: null, rows: [[1n, undefined, "x"]] })).toBe("1,,x\r\n");
  });

  it("writes a renamed header column, and refuses a cell under a name the header lacks", async () => {
    const table = await read("code,name\r\nTEST-001,Example\r\n");
    (table.header as string[])[1] = "label";
    expect(await refusal(write(table))).toEqual({
      code: "CSV_UNKNOWN_COLUMN",
      text: "row 1 has a cell under a name the header does not hold",
    });
    const row = table.rows[0] as Record<string, string>;
    row["label"] = row["name"] ?? "";
    delete row["name"];
    expect(await write(table)).toBe("code,label\r\nTEST-001,Example\r\n");
  });

  it("refuses a cell or a row it cannot write", async () => {
    expect((await refusal(write({ header: null, rows: [[{}]] }))).code).toBe("CSV_INVALID_CELL");
    expect((await refusal(write({ header: null, rows: [[Number.NaN]] }))).code).toBe(
      "CSV_INVALID_CELL",
    );
    expect(await refusal(write({ header: null, rows: [{ a: "1" }] }))).toEqual({
      code: "CSV_INVALID_CELL",
      text: "row 1 is not an array, and the table has no header",
    });
    expect((await refusal(write({ header: ["a"], rows: [["1"]] }))).code).toBe("CSV_INVALID_CELL");
    expect((await refusal(write({ header: ["a"], rows: [null] }))).code).toBe("CSV_INVALID_CELL");
  });

  it("refuses what is not a table, as any other format does", async () => {
    for (const output of [{ rows: [] }, { header: "a", rows: [] }, [["a"]], 3, { header: null }]) {
      expect((await refusal(write(output))).text).toBe(
        "the transform returned something that is neither a message nor a string",
      );
    }
    // A string or bytes go out as they are.
    expect(await write("as,is\r\n")).toBe("as,is\r\n");
  });

  it("guards a formula-leading cell when escapeFormulas is set, untouched rows too", async () => {
    const body =
      "code,value\r\nTEST-001,=1+2\r\nTEST-002,-3\r\nTEST-003,@SUM(A1)\r\nTEST-004,plain\r\n";
    // Off by default: the body goes back as it came.
    expect(await roundTrip(body)).toBe(body);
    expect(await roundTrip(body, { escapeFormulas: true })).toBe(
      'code,value\r\nTEST-001,"\'=1+2"\r\nTEST-002,"\'-3"\r\nTEST-003,"\'@SUM(A1)"\r\nTEST-004,plain\r\n',
    );
    expect(
      await write({ header: null, rows: [["+1", "\tx", "\rx", "ok"]] }, { escapeFormulas: true }),
    ).toBe('"\'+1","\'\tx","\'\rx",ok\r\n');
  });
});

describe("format: csv, fixed width", () => {
  const columns = [
    { name: "code", start: 1, length: 8 },
    { name: "name", start: 10, length: 6 },
  ] as const;
  const settings: CsvSettings = { columns };

  it("cuts each line into its columns, counted in characters, not bytes or UTF-16 units", async () => {
    const body = "TEST-001 Exémpl\r\nTEST-002|\u{1F600}abcde and filler\r\n";
    const table = await read(body, settings);
    expect(table.header).toEqual(["code", "name"]);
    expect(table.rows).toEqual([
      Object.assign(Object.create(null), { code: "TEST-001", name: "Exémpl" }),
      Object.assign(Object.create(null), { code: "TEST-002", name: "\u{1F600}abcde" }),
    ]);
    expect(await roundTrip(body, settings)).toBe(body);
    // A changed line fills the gap between columns with a space and drops what lies past the last.
    (table.rows[1] as Record<string, string>)["code"] = "TEST-003";
    expect(await write(table, settings)).toBe("TEST-001 Exémpl\r\nTEST-003 \u{1F600}abcde\r\n");
  });

  it("refuses a short line unless pad is set, and pads it with spaces", async () => {
    expect(await refusal(read("TEST-001 Ex\r\n", settings))).toEqual({
      code: "CSV_SHORT_LINE",
      text: "line 1 has 11 characters where the columns need 15; set pad: true to pad it with spaces",
    });
    const padded = await read("TEST-001 Ex\r\n", { ...settings, pad: true });
    expect((padded.rows[0] as CsvRecord)["name"]).toBe("Ex    ");
    expect(await roundTrip("TEST-001 Ex\r\n", { ...settings, pad: true })).toBe("TEST-001 Ex\r\n");
  });

  it("writes a changed row at its columns, padded, and refuses a value wider than its column", async () => {
    const table = await read("TEST-001 Exampl\nTEST-002 Second\n", settings);
    (table.rows[0] as Record<string, string>)["name"] = "Ab";
    expect(await write(table, settings)).toBe("TEST-001 Ab    \nTEST-002 Second\n");
    (table.rows[0] as Record<string, string>)["name"] = "Too wide";
    expect(await refusal(write(table, settings))).toEqual({
      code: "CSV_VALUE_TOO_WIDE",
      text: "row 1: the value for column 2 is 8 characters, wider than its 6",
    });
    (table.rows[0] as Record<string, string>)["name"] = "a\nb";
    expect((await refusal(write(table, settings))).code).toBe("CSV_INVALID_CELL");
    expect(await write({ header: ["code", "name"], rows: [{ code: "TEST-003" }] }, settings)).toBe(
      "TEST-003       \r\n",
    );
    expect((await refusal(write({ header: null, rows: [["x"]] }, settings))).code).toBe(
      "CSV_INVALID_CELL",
    );
  });

  it("refuses a line longer than maxRowLength", async () => {
    expect(
      (await refusal(read("TEST-001 Exampl and more\n", { ...settings, maxRowLength: 20 }))).code,
    ).toBe("CSV_ROW_TOO_LONG");
  });
});

describe("format: csv, a differential check against csv-parse", () => {
  /** A cell as an RFC 4180 writer would put it: plain when it can be, else quoted. */
  const cell = fc.string({ unit: fc.constantFrom("a", "Z", "1", " ", ",", '"', "\r", "\n", "é") });
  const quoteCell = (value: string, force: boolean): string =>
    force || /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

  it("reads every well-formed body as csv-parse does", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).chain((width) =>
          fc.array(fc.array(fc.tuple(cell, fc.boolean()), { minLength: width, maxLength: width }), {
            minLength: 1,
            maxLength: 6,
          }),
        ),
        fc.constantFrom("\r\n", "\n"),
        fc.boolean(),
        (rows, newline, trailing) => {
          // A row of one empty cell is an empty line, which csv-parse reads otherwise; it has its
          // own test above.
          fc.pre(rows.every((row) => !(row.length === 1 && row[0]?.[0] === "" && !row[0][1])));
          const body =
            rows
              .map((row) => row.map(([value, force]) => quoteCell(value, force)).join(","))
              .join(newline) + (trailing ? newline : "");
          const ours = readCsv(bytes(body), { header: false }).rows;
          const theirs: unknown = oracleParse(body, { record_delimiter: newline });
          expect(ours).toEqual(theirs);
          expect(ours).toEqual(rows.map((row) => row.map(([value]) => value)));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("writes any table so both readers read it back as it was", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 2, maxLength: 4 }), { minLength: 1, maxLength: 6 }),
        (cells) => {
          const width = cells[0]?.length ?? 0;
          const rows = cells.map((row) => [
            ...row.slice(0, width),
            ...Array<string>(Math.max(0, width - row.length)).fill(""),
          ]);
          const written = writeCsv({ header: null, rows }, {});
          const body = typeof written === "string" ? written : text(written);
          expect(readCsv(bytes(body), { header: false }).rows).toEqual(rows);
          expect(oracleParse(body, { record_delimiter: "\r\n" })).toEqual(rows);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("refuses an unterminated quote, as csv-parse does", () => {
    const body = 'a,"b\r\n';
    expect(() => oracleParse(body)).toThrow();
    expect(() => readCsv(bytes(body), {})).toThrow("opens a quote it never closes");
  });
});

describe("format: csv, in a transform and a worker", () => {
  const workers: ChannelWorker[] = [];
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  });

  it("types a csv transform's message as a CsvTable", () => {
    expectTypeOf<MessageFor<"csv">>().toEqualTypeOf<CsvTable>();
    const transform = ((table) => {
      if (table.header === null) return table;
      return { ...table, rows: table.rows.filter((row) => row["code"] !== "TEST-002") };
    }) satisfies TransformFor<"csv">;
    expectTypeOf(transform).toBeFunction();
  });

  it("hands a transform the table and writes back what it returns", async () => {
    const outputs = await runTransform(
      (message) => {
        const table = message as CsvTable & { header: string[] };
        table.rows = table.rows.filter((row) => row["code"] !== "TEST-002");
        return table;
      },
      "csv",
      bytes("code;name\nTEST-001;Example\nTEST-002;Other\n"),
      undefined,
      { csv: { delimiter: ";" } },
    );
    expect(outputs.map(text)).toEqual(["code;name\nTEST-001;Example\n"]);
  });

  it("reads with the channel's settings in the worker thread", async () => {
    const ragged = bytes("code,name\r\nTEST-001\r\n");
    const strict = new ChannelWorker({
      channel: "csv-strict",
      transformFile: undefined,
      format: "csv",
      timeoutMs: 5_000,
      memoryMb: 256,
    });
    const padded = new ChannelWorker({
      channel: "csv-padded",
      transformFile: undefined,
      format: "csv",
      csv: { pad: true },
      timeoutMs: 5_000,
      memoryMb: 256,
    });
    workers.push(strict, padded);
    const refused = await strict.run(ragged);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.failure.code).toBe("CSV_RAGGED_ROW");
    expect(await padded.run(ragged)).toEqual({ ok: true, outputs: [ragged] });
  });

  it("runs a csv channel end to end: a file in, the transform, a .csv file out", async () => {
    const root = await makeProject({
      "channels/codes/channel.yaml":
        'format: csv\ncsv: { delimiter: ";", newline: lf }\n' +
        "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ntransform: ./transform.ts\n" +
        "destinations:\n  - file: { dir: ../../data/out }\n",
      "channels/codes/transform.ts":
        "export default (table) => {\n" +
        '  table.rows.push(Object.assign(Object.create(null), { code: "TEST-003", name: "Added" }));\n' +
        "  return table;\n};\n",
    });
    const project = await loadProject(root);
    expect(project.channels[0]?.csv).toEqual({ delimiter: ";", newline: "lf" });
    const store = await (
      await testStorage(TEST_DATABASES[0] as never, project.databaseFile)
    ).open();
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    try {
      await engine.start();
      await dropFile(join(root, "data", "inbox", "codes.csv"), "code;name\r\nTEST-001;Example\r\n");
      await engine.tick();
      expect(await readdir(join(root, "data", "out"))).toEqual(["1-1.csv"]);
      expect(await readFile(join(root, "data", "out", "1-1.csv"), "utf8")).toBe(
        "code;name\r\nTEST-001;Example\r\nTEST-003;Added\n",
      );
    } finally {
      await engine.stop();
      await store.close();
    }
  });
});
