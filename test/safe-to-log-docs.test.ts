import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { PassFailed, type MessageSink } from "../src/connectors/types.js";
import { isEncryptedText } from "../src/encryption/envelope.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import { Engine } from "../src/engine/engine.js";
import { scriptLogLine } from "../src/engine/worker-entry.js";
import { openStore } from "../src/storage/open.js";
import { Store } from "../src/storage/store.js";
import { fences } from "./docs-helpers.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

afterEach(cleanUp);

/**
 * What the pages show is safe to log, and the page that says what is safe to log is true.
 *
 * `example-print.test.ts` reads what a sample passes to a printer. This suite reads what a page shows
 * as a value or an output, which that rule cannot see: the commands' and the scripts' output blocks
 * and the values written after code (`// =>`). None holds an identifying value this repository's own
 * synthetic data carries, or a whole segment: a page shows ids the engine made, codes, counts and
 * names the project chose. It also holds "What is safe to log from a channel" to the code.
 */
const root = join(import.meta.dirname, "..");
const docsDir = join(root, "docs-content");

/** Every file under `dir` whose name `keep` accepts, recursively, outside `node_modules`. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && keep(d.name) && !d.parentPath.includes("node_modules"))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

/** The README, the hand-written pages and the example projects' READMEs, as `[label, text]`. */
function pages(): [string, string][] {
  const out: [string, string][] = [["README.md", readFileSync(join(root, "README.md"), "utf8")]];
  for (const name of readdirSync(docsDir).sort()) {
    if (name.endsWith(".md")) out.push([name, readFileSync(join(docsDir, name), "utf8")]);
  }
  for (const file of filesUnder(join(root, "examples"), (name) => name === "README.md")) {
    out.push([relative(root, file), readFileSync(file, "utf8")]);
  }
  return out;
}

/** The text of a `## heading` section of a page, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * The identifying values this repository's synthetic data carries, read from the data and not from
 * the expression that shows them: a shown value is caught however it was reached.
 */
interface Identifying {
  /** Whole words matched case-insensitively: names. */
  words: Set<string>;
  /** Substrings matched as tokens: ids, addresses, phones, free text. */
  literals: Set<string>;
  /** Birth dates as `YYYYMMDD`, matched in every written form `datePatterns` builds. */
  dates: Set<string>;
}

/** Which fields of which segment carry a person, by kind, as 1-based field numbers. */
const PERSON_FIELDS: Record<
  string,
  {
    ids?: number[];
    names?: number[];
    xcn?: number[];
    dob?: number[];
    addr?: number[];
    phone?: number[];
  }
> = {
  PID: { ids: [2, 3, 4, 18, 19, 20], names: [5, 6, 9], dob: [7], addr: [11], phone: [13, 14] },
  NK1: { names: [2], addr: [4], phone: [5, 6], dob: [16] },
  MRG: { ids: [1, 2, 3, 4, 5, 6], names: [7] },
  GT1: { ids: [2], names: [3], addr: [5], phone: [6, 7], dob: [8] },
  IN1: { ids: [36], names: [16], dob: [18], addr: [19] },
  PV1: { ids: [19, 50], xcn: [7, 8, 9, 17] },
  ORC: { xcn: [10, 11, 12] },
  OBR: { xcn: [10, 16, 28] },
};

/** HL7 escape sequences, which break a free-text field into the plain runs between them. */
const ESCAPE = /\\[^\\]*\\/gu;

/** The plain runs of a free-text value worth matching: two words or more. */
function freeTextRuns(value: string): string[] {
  return [...value.split(ESCAPE), value.replace(ESCAPE, "")]
    .map((run) => run.replace(/\s+/gu, " ").trim())
    .filter((run) => run.length >= 6 && /\S\s\S/u.test(run));
}

/** Add what one HL7 segment line carries about a person. */
function readSegment(line: string, into: Identifying): void {
  const fields = line.split("|");
  const id = fields[0] ?? "";
  const at = (n: number): string[] => (fields[n] ?? "").split("~").filter((v) => v !== "");
  const addName = (part: string): void => {
    for (const word of part.split(/[&\s]/u)) {
      if (/^[\p{L}'-]{3,}$/u.test(word)) into.words.add(word.toLowerCase());
    }
  };
  const spec = PERSON_FIELDS[id];
  if (spec) {
    for (const n of spec.ids ?? []) {
      for (const rep of at(n)) {
        const value = rep.split("^")[0] ?? "";
        if (value.length >= 4 && !value.includes("$")) into.literals.add(value);
      }
    }
    for (const n of spec.names ?? []) {
      for (const rep of at(n)) rep.split("^").slice(0, 3).forEach(addName);
    }
    for (const n of spec.xcn ?? []) {
      for (const rep of at(n)) {
        const parts = rep.split("^");
        if ((parts[0] ?? "").length >= 4) into.literals.add(parts[0] ?? "");
        parts.slice(1, 4).forEach(addName);
      }
    }
    for (const n of spec.dob ?? []) {
      for (const rep of at(n)) {
        const digits = /^\d{8}/u.exec(rep);
        if (digits) into.dates.add(digits[0]);
      }
    }
    for (const n of spec.addr ?? []) {
      for (const rep of at(n)) {
        const street = rep.split("^")[0] ?? "";
        if (street.length >= 4) into.literals.add(street);
      }
    }
    for (const n of spec.phone ?? []) {
      for (const rep of at(n)) {
        for (const part of rep.split("^")) {
          if (part.replace(/\D/gu, "").length >= 7) into.literals.add(part);
        }
      }
    }
  }
  if (id === "NTE") for (const rep of at(3)) freeTextRuns(rep).forEach((r) => into.literals.add(r));
  if (id === "OBX" && ["ST", "TX", "FT"].includes(fields[2] ?? "")) {
    for (const rep of at(5)) freeTextRuns(rep).forEach((r) => into.literals.add(r));
  }
}

/** A segment line inside source text: a person-bearing or free-text segment id and its fields. */
const SEGMENT_IN_SOURCE = new RegExp(
  `\\b(?:${[...Object.keys(PERSON_FIELDS), "NTE", "OBX"].join("|")})\\|[^"'\`\\r\\n]*`,
  "gu",
);

/**
 * Every identifying value the synthetic data carries: the PHI allow list (which declares every
 * synthetic name, birth date and bare id the scan meets), the HL7 files of the example projects,
 * the starter and the tests, and every HL7 segment written into the pages, the example projects'
 * scripts and the tests.
 */
function identifying(): Identifying {
  const out: Identifying = { words: new Set(), literals: new Set(), dates: new Set() };
  for (const line of readFileSync(join(root, "scripts", "phi-allow-list.txt"), "utf8").split(
    "\n",
  )) {
    const m = /^(NAME|DOB|ID) (.+)$/u.exec(line.trim());
    if (!m) continue;
    const [, tag, value = ""] = m;
    if (tag === "NAME" && value.length >= 3) out.words.add(value.toLowerCase());
    if (tag === "DOB" && /^\d{8}$/u.test(value)) out.dates.add(value);
    if (tag === "ID") out.literals.add(value);
  }
  const dirs = ["examples", join("templates", "starter"), "test"].map((d) => join(root, d));
  for (const file of dirs.flatMap((dir) => filesUnder(dir, (n) => /\.(?:hl7|ndhl7)$/u.test(n)))) {
    for (const line of readFileSync(file, "latin1").split(/\r\n|\r|\n/u)) readSegment(line, out);
  }
  const sources = [
    ...pages().map(([, text]) => text),
    ...dirs.flatMap((dir) => filesUnder(dir, (n) => /\.(?:ts|mts|js|mjs)$/u.test(n))),
  ].map((textOrFile) =>
    textOrFile.startsWith(root) ? readFileSync(textOrFile, "utf8") : textOrFile,
  );
  for (const text of sources) {
    // Source text: `\\` is one backslash and `\r` ends a segment.
    const code = text.replace(/\\([\\rn])/gu, (_, c: string) => (c === "\\" ? "\\" : "\n"));
    for (const m of code.matchAll(SEGMENT_IN_SOURCE)) readSegment(m[0], out);
  }
  return out;
}

/** A birth date in the forms a page can show it: HL7, ISO, and both slash orders. */
function datePatterns(yyyymmdd: string): RegExp[] {
  const [y, mm, dd] = [yyyymmdd.slice(0, 4), yyyymmdd.slice(4, 6), yyyymmdd.slice(6, 8)];
  const [m, d] = [String(Number(mm)), String(Number(dd))];
  return [
    new RegExp(`(?<!\\d)${yyyymmdd}(?!\\d)`, "u"),
    new RegExp(`(?<!\\d)${y}-${mm}-${dd}(?!\\d)`, "u"),
    new RegExp(`(?<!\\d)0?${m}/0?${d}/${y}(?!\\d)`, "u"),
    new RegExp(`(?<!\\d)0?${d}/0?${m}/${y}(?!\\d)`, "u"),
  ];
}

/**
 * Synthetic name parts that are also ordinary words a page uses in another sense. A shown value
 * holding one of these as a name is still caught by the record number or the birth date beside it,
 * or by the segment check.
 */
const ORDINARY_WORDS = new Set(["test", "patient", "one", "two", "alpha", "lab", "synth"]);

/** Whether `value` holds `token` with no word character either side. */
function holdsToken(value: string, token: string): boolean {
  for (let i = value.indexOf(token); i !== -1; i = value.indexOf(token, i + 1)) {
    const before = value[i - 1] ?? "";
    const after = value[i + token.length] ?? "";
    if (!/\w/u.test(before) && !/\w/u.test(after)) return true;
  }
  return false;
}

/** What in a shown value identifies a person, or `[]` when nothing does. */
function findIdentifying(value: string, ids: Identifying, patterns: RegExp[]): string[] {
  const found: string[] = [];
  for (const word of value.toLowerCase().match(/[\p{L}]+/gu) ?? []) {
    if (ids.words.has(word) && !ORDINARY_WORDS.has(word)) found.push(word);
  }
  for (const literal of ids.literals) if (holdsToken(value, literal)) found.push(literal);
  for (const p of patterns) if (p.test(value)) found.push(p.source);
  return found;
}

/** A whole segment in a shown value: an HL7 segment line or a v2 XML segment element. */
const SHOWN_SEGMENT = /(?:^|[^A-Za-z0-9])[A-Z][A-Z0-9]{2}\|[^|\s]*\||<([A-Z][A-Z0-9]{2})>.*<\/\1>/u;

/** The fences that show output rather than a file or code: untitled `text`, `console`, `output`, `json`. */
function isOutput(lang: string, title: string | undefined): boolean {
  return title === undefined && ["", "text", "console", "output", "json"].includes(lang);
}

/** The fences that hold code whose trailing comments may show a value. */
const CODE_LANGS = new Set(["ts", "typescript", "tsx", "js", "javascript", "mjs"]);

/** A plain trailing comment that shows a value after code: `x; // "1988-07-05"`. */
const TRAILING_VALUE = /\S\s+\/\/\s+(?:=>\s*)?(["[{].*)$/u;

/**
 * Every shown value on the pages, as `[where, value]`: each line of an output block, and each value
 * a code block writes after code, as `// => value` or a trailing comment holding a literal.
 */
function shownValues(): [string, string][] {
  const out: [string, string][] = [];
  for (const [label, text] of pages()) {
    for (const fence of fences(text)) {
      fence.body.split("\n").forEach((line, i) => {
        const where = `${label}:${String(fence.line + i + 1)}`;
        if (isOutput(fence.lang, fence.title)) {
          if (line.trim() !== "") out.push([where, line.trim()]);
          return;
        }
        if (!CODE_LANGS.has(fence.lang)) return;
        const at = line.indexOf("// =>");
        if (at !== -1) {
          out.push([where, line.slice(at + "// =>".length).trim()]);
          return;
        }
        const trailing = TRAILING_VALUE.exec(line);
        if (trailing) out.push([where, (trailing[1] ?? "").trim()]);
      });
    }
  }
  return out;
}

describe("a shown value on the pages", () => {
  const ids = identifying();
  const patterns = [...ids.dates].flatMap(datePatterns);
  const shown = shownValues();

  it("is read against the synthetic data, so the check cannot pass on nothing", () => {
    expect(ids.words.has("testpatient")).toBe(true);
    expect(ids.literals.has("TEST000001")).toBe(true);
    expect(ids.dates.has("19700101")).toBe(true);
    expect(ids.words.size).toBeGreaterThan(30);
    expect(ids.literals.size).toBeGreaterThan(30);
    expect(shown.length).toBeGreaterThan(200);
  });

  it("finds a planted value in each form a page could show it", () => {
    for (const form of [
      "PID|1||TEST000001^^^SYNTHHOSP^MR",
      "TESTPATIENT^ALPHA",
      '"1970-01-01"',
      "01/01/1970",
      '{ "family": "Testpatient" }',
    ]) {
      expect(findIdentifying(form, ids, patterns), form).not.toEqual([]);
    }
    expect(findIdentifying("message 17: replayed: 1 delivery queued", ids, patterns)).toEqual([]);
    expect(findIdentifying("PASS adt-to-lab/tests/a01.hl7", ids, patterns)).toEqual([]);
    expect(SHOWN_SEGMENT.test("PID|1||TEST000001^^^SYNTHHOSP^MR")).toBe(true);
    expect(SHOWN_SEGMENT.test("<PID><PID.3>TEST000001</PID.3></PID>")).toBe(true);
    expect(SHOWN_SEGMENT.test("ADT^A01^ADT_A01")).toBe(false);
    expect(SHOWN_SEGMENT.test("| ID | CHANNEL |")).toBe(false);
  });

  it("holds no identifying value from the synthetic data", () => {
    const hits = shown
      .map(([where, value]) => [where, value, findIdentifying(value, ids, patterns)] as const)
      .filter(([, , found]) => found.length > 0)
      .map(([where, , found]) => `${where}: ${found.join(", ")}`);
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("is never a whole segment: a page shows a segment's name, a code or a count instead", () => {
    const segments = shown.filter(([, value]) => SHOWN_SEGMENT.test(value)).map(([where]) => where);
    expect(segments, segments.join("\n")).toEqual([]);
  });
});

describe("What is safe to log from a channel", () => {
  const text = section(
    readFileSync(join(docsDir, "logs-and-codes.md"), "utf8"),
    "What is safe to log from a channel",
  );

  it("is a section of the logs page", () => {
    expect(text).not.toBe("");
  });

  it.each(["ctx.messageId", "ctx.attempt", "ctx.destination"])(
    "names %s, which the engine made, as safe",
    (field) => {
      expect(text).toContain(`\`${field}\``);
    },
  );

  it.each(["ctx.source", "ctx.config", "ctx.meta"])("names %s as never to log", (field) => {
    const lines = text.split("\n").filter((line) => line.includes(`\`${field}\``));
    expect(lines.length).toBeGreaterThan(0);
  });

  it("says console output from a transform is not filtered, as the worker shares the engine's", () => {
    expect(text).toMatch(/`console`/u);
    expect(text).toMatch(/not filtered/u);
  });

  it("says the script logger keeps a code and numbers only, as scriptLogLine does", () => {
    expect(text).toMatch(/`ctx\.logger`/u);
    // A name that is not a code becomes `script-log`, and an id that is not a number is dropped.
    const line = scriptLogLine("info", "TESTPATIENT^ALPHA", {
      entries: 3,
      mrn: "TEST000001" as unknown as number,
    });
    expect(line).toEqual({ level: "info", code: "script-log", ids: { entries: 3 } });
    expect(text).toMatch(/`script-log`/u);
    expect(text).toMatch(/dropped/u);
  });

  it("names each context field it lists as a field of TransformContext", () => {
    const source = readFileSync(join(root, "src", "transform.ts"), "utf8");
    const context = /export interface TransformContext \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? "";
    const fields = new Set([...context.matchAll(/readonly (\w+)\??:/gu)].map((m) => m[1]));
    for (const m of text.matchAll(/`ctx\.(\w+)/gu)) {
      if (m[1] === "logger") continue;
      expect(fields.has(m[1]), `ctx.${m[1] ?? ""}`).toBe(true);
    }
  });
});

/** A value of the synthetic data a thrown error quotes, as a careless transform's would. */
const QUOTED = "TESTPATIENT^ALPHA";

/** Where a thrown error's text ends up in one storage setup: the stored rows' error texts and the log. */
async function thrownErrorIn(setup: "encrypted" | "none" | "stores-nothing"): Promise<{
  errors: (string | null)[];
  log: string;
  refused: PassFailed | undefined;
}> {
  const root = await makeProject({
    "channels/notes/channel.yaml": [
      "format: text",
      ...(setup === "stores-nothing" ? ["storage: { content: none }"] : []),
      "source:",
      "  file: { dir: ../../data/in, errorDir: ../../data/error }",
      "transform: ./transform.ts",
      "destinations:",
      "  - file: { dir: ../../data/out }",
      "",
    ].join("\n"),
    "channels/notes/transform.ts":
      'export default (text: string): string => { throw new Error("cannot route " + text); };\n',
  });
  const project = await loadProject(root);
  const { logger, lines } = captureLogger();
  // No keys is `encryption: none`: openStore then gives the store unencrypted, as a start does.
  const keys =
    setup === "encrypted"
      ? new LocalKeyProvider([["synthetic", randomBytes(KEY_BYTES)]], "synthetic")
      : undefined;
  const store = await openStore(project, { env: {}, logger, keys });
  let sink: MessageSink | undefined;
  const engine = new Engine({
    project,
    store,
    logger,
    connectors: () => ({
      source: {
        start: (given: MessageSink) => {
          sink = given;
          return Promise.resolve();
        },
      },
      destinations: [{ deliver: () => Promise.resolve() }],
    }),
  });
  let refused: PassFailed | undefined;
  await engine.start();
  try {
    if (sink === undefined) throw new Error("the source was not started");
    await sink.receive(Buffer.from(QUOTED, "utf8")).catch((error: unknown) => {
      if (!(error instanceof PassFailed)) throw error;
      refused = error;
    });
    await engine.tick();
  } finally {
    await engine.stop();
    await store.close();
  }
  // The database as it is on disk, read under no encryption.
  const raw = await Store.open(project.databaseFile);
  try {
    const rows = await raw.storedContent("messages", 0, 100);
    return { errors: rows.map((row) => row.error), log: lines.join(""), refused };
  } finally {
    await raw.close();
  }
}

describe("What is safe to log from a channel: a thrown error, in each storage setup", () => {
  const text = section(
    readFileSync(join(docsDir, "logs-and-codes.md"), "utf8"),
    "What is safe to log from a channel",
  ).replace(/\s+/gu, " ");

  it("says an error's message must never carry a value from the message", () => {
    expect(text).toMatch(/must never carry a value from the message/u);
  });

  it("an encrypted store keeps the text with the message, encrypted, and the log leaves it out", async () => {
    expect(text).toMatch(/stored with the message, encrypted when the store is encrypted/u);
    const { errors, log } = await thrownErrorIn("encrypted");
    expect(errors).toHaveLength(1);
    expect(isEncryptedText(errors[0] ?? "")).toBe(true);
    expect(errors[0]).not.toContain("TESTPATIENT");
    expect(log).not.toContain("TESTPATIENT");
  });

  it("with encryption none, the text is stored in the clear, for anyone who reads the database", async () => {
    expect(text).toMatch(/`encryption: none`[^.]*in the clear/u);
    expect(text).toMatch(/anyone who can read the database reads it/u);
    const { errors, log } = await thrownErrorIn("none");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`cannot route ${QUOTED}`);
    expect(log).not.toContain("TESTPATIENT");
  });

  it("a channel that stores nothing keeps no error text at all", async () => {
    expect(text).toMatch(/stores nothing \(`storage\.content: none`\) keeps no error text/u);
    const { errors, log, refused } = await thrownErrorIn("stores-nothing");
    expect(refused).toMatchObject({ permanent: true, code: "TRANSFORM_FAILED" });
    expect(errors).toEqual([]);
    expect(log).toContain("pass-transform-failed");
    expect(log).not.toContain("TESTPATIENT");
  });

  it("says a ctx.logger code is words the author chooses, so never built from the message", () => {
    // A valid code is kept as written, and so is a number, whatever it was read from.
    expect(scriptLogLine("info", "testpatient-alpha", { mrn: 12345 })).toEqual({
      level: "info",
      code: "testpatient-alpha",
      ids: { mrn: 12345 },
    });
    expect(text).toMatch(/`testpatient-alpha`/u);
    expect(text).toMatch(/never build a code or an id from the message/u);
  });

  it("says ctx.messageId on a channel that stores nothing is the pass id, as the engine gives it", async () => {
    expect(text).toMatch(/`ctx\.messageId`[^.]*stores nothing, the pass id/u);
    const { seen, pass, log } = await passOnChannelThatStoresNothing();
    // The id the source was answered with, the one the destination was handed and the one the
    // transform read are the one pass id, which the log names.
    expect(seen).toEqual([{ messageId: pass, body: String(pass) }]);
    expect(log).toContain(`"pass":${String(pass)}`);
  });

  it("says console.error and console.warn go to standard error, console.log to standard output", () => {
    expect(text).toMatch(/`console\.log`[^;]*standard output/u);
    expect(text).toMatch(/`console\.error` and `console\.warn` to standard error/u);
  });

  it("says a destination connector's thrown error is retried with only its code stored, as the engine does", async () => {
    expect(text).toMatch(
      /error thrown from a destination connector's send[^.]*does not fail the message: the delivery is retried/u,
    );
    expect(text).toMatch(/Only the error's `code` is stored with the delivery and logged/u);
    expect(text).toMatch(/error thrown from a transform\*\* fails the message/u);
    const { message, deliveries, log } = await sendThrows();
    expect(message).toBe("transformed");
    expect(deliveries).toEqual([{ status: "pending", attempts: 1, error: "delivery: ECONNRESET" }]);
    expect(log).toContain('"event":"delivery-retry"');
    expect(log).toContain('"code":"ECONNRESET"');
    expect(log).not.toContain("TESTPATIENT");
  });
});

/** A text channel of one destination, `content: none` or stored, with `transform` as its transform. */
async function textChannel(transform: string, storesNothing: boolean): Promise<string> {
  return makeProject({
    "channels/notes/channel.yaml": [
      "format: text",
      ...(storesNothing ? ["storage: { content: none }"] : []),
      "source:",
      "  file: { dir: ../../data/in, errorDir: ../../data/error }",
      "transform: ./transform.ts",
      "destinations:",
      "  - file: { dir: ../../data/out }",
      "",
    ].join("\n"),
    "channels/notes/transform.ts": transform,
  });
}

/**
 * One message through a channel that stores nothing whose transform outputs `ctx.messageId`: the
 * pass id its source was answered with, what its destination was handed, and the log.
 */
async function passOnChannelThatStoresNothing(): Promise<{
  seen: { messageId: number; body: string }[];
  pass: number;
  log: string;
}> {
  const root = await textChannel(
    "export default (_text: string, ctx?: { messageId: number }): string => String(ctx?.messageId);\n",
    true,
  );
  const project = await loadProject(root);
  const { logger, lines } = captureLogger();
  const store = await openStore(project, { env: {}, logger, keys: undefined });
  const seen: { messageId: number; body: string }[] = [];
  let sink: MessageSink | undefined;
  const engine = new Engine({
    project,
    store,
    logger,
    connectors: () => ({
      source: {
        start: (given: MessageSink) => {
          sink = given;
          return Promise.resolve();
        },
      },
      destinations: [
        {
          deliver: (message) => {
            seen.push({
              messageId: message.messageId,
              body: Buffer.from(message.body).toString("utf8"),
            });
            return Promise.resolve();
          },
        },
      ],
    }),
  });
  await engine.start();
  try {
    if (sink === undefined) throw new Error("the source was not started");
    const pass = await sink.receive(Buffer.from("synthetic note", "utf8"));
    return { seen, pass, log: lines.join("") };
  } finally {
    await engine.stop();
    await store.close();
  }
}

/**
 * One message through a stored channel whose destination's send throws an error that quotes the
 * message and carries a code: the message's status, its deliveries and the log.
 */
async function sendThrows(): Promise<{
  message: string | undefined;
  deliveries: { status: string; attempts: number; error: string | null }[];
  log: string;
}> {
  const root = await textChannel("export default (text: string): string => text;\n", false);
  const project = await loadProject(root);
  const { logger, lines } = captureLogger();
  // No keys is `encryption: none`: the stored error reads as it was written.
  const store = await openStore(project, { env: {}, logger, keys: undefined });
  let sink: MessageSink | undefined;
  const engine = new Engine({
    project,
    store,
    logger,
    connectors: () => ({
      source: {
        start: (given: MessageSink) => {
          sink = given;
          return Promise.resolve();
        },
      },
      destinations: [
        {
          deliver: () =>
            Promise.reject(
              Object.assign(new Error(`cannot send ${QUOTED}`), { code: "ECONNRESET" }),
            ),
        },
      ],
    }),
  });
  await engine.start();
  try {
    if (sink === undefined) throw new Error("the source was not started");
    const id = await sink.receive(Buffer.from(QUOTED, "utf8"));
    await engine.tick();
    const stored = await store.message(id);
    const deliveries = (await store.deliveries(id)).map(({ status, attempts, error }) => ({
      status,
      attempts,
      error,
    }));
    return { message: stored?.status, deliveries, log: lines.join("") };
  } finally {
    await engine.stop();
    await store.close();
  }
}
