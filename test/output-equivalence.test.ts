// The output-equivalence test: every caller-visible output of the paths a performance change
// touches, over a corpus of synthetic inputs (test/equivalence/corpus.json), compared by digest
// with what the base commit produced (test/equivalence/digests.json).
//
// - The transform worker's own functions, on every input: what `decode` hands a transform (a JSON
//   value through JSON and `util.inspect`, a text body, a library's model as its serializer writes
//   it), what `encode` writes back, what `runTransform` returns with no transform and with the
//   starter's kind of edit, and every failure as its kind, name, code and text.
// - An MLLP source's ACKs, on every HL7 v2 input: what `readHeader` reads and what
//   `defaultAckBuilder` writes for each code and reason, MSH-7 and MSH-10 (a time and a fresh id)
//   blanked.
// - The engine, on every input, a channel a format: one pass from a file folder through SQLite
//   with encryption at rest and the worker to a file folder, recording each delivered file, every
//   row the operator commands read back (status, error text, deliveries, outputs, the stored body),
//   the counts and every log line but its time.
//
// A digest that moves is a changed output. Write the digests again only from the base commit, or
// for an output a change sets out to change and names: PATHWAYS_EQUIVALENCE_WRITE=1 pnpm test
// test/output-equivalence.test.ts. No CI job sets that variable.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { defaultAckBuilder, type AckRequest } from "../src/connectors/ack.js";
import { readHeader } from "../src/connectors/mllp.js";
import { EncryptedStore } from "../src/encryption/encrypted-store.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import { Engine } from "../src/engine/engine.js";
import {
  decode,
  encode,
  runTransform,
  summarize,
  type TransformFunction,
  type WorkerFormat,
} from "../src/engine/worker-entry.js";
import { Store } from "../src/storage/store.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

interface CorpusEntry {
  readonly id: string;
  readonly format: WorkerFormat;
  readonly body: string;
}

const HERE = fileURLToPath(new URL("equivalence/", import.meta.url));
const CORPUS = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")) as CorpusEntry[];
const DIGESTS_FILE = join(HERE, "digests.json");
const WRITE = process.env["PATHWAYS_EQUIVALENCE_WRITE"] === "1";
const EXPECTED = (
  existsSync(DIGESTS_FILE) ? JSON.parse(readFileSync(DIGESTS_FILE, "utf8")) : {}
) as Record<string, Record<string, string>>;
const actual: Record<string, Record<string, string>> = {};

afterAll(async () => {
  await cleanUp();
  if (WRITE) writeFileSync(DIGESTS_FILE, `${JSON.stringify(actual, null, 2)}\n`);
});

const bodyOf = (entry: CorpusEntry): Uint8Array =>
  new Uint8Array(Buffer.from(entry.body, "base64"));
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A stable digest of any record: its JSON, with byte arrays as base64 and undefined spelled out. */
function digest(record: unknown): string {
  const text = JSON.stringify(record, (_key, value: unknown) => {
    if (value instanceof Uint8Array) return { bytes: b64(value) };
    if (value === undefined) return "<undefined>";
    if (typeof value === "bigint") return `${value.toString()}n`;
    return value;
  });
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Records one section's digests, and compares them with the base's. */
function compare(section: string, records: Map<string, unknown>): void {
  const digests: Record<string, string> = {};
  for (const [id, record] of records) digests[id] = digest(record);
  actual[section] = digests;
  if (WRITE) return;
  const expected = EXPECTED[section] ?? {};
  const moved = Object.keys({ ...expected, ...digests }).filter(
    (id) => expected[id] !== digests[id],
  );
  expect(moved, `outputs that moved in ${section}`).toEqual([]);
}

/** A failure as a caller sees it: its kind, name, code, place and text. */
async function outcome<T>(run: () => Promise<T>): Promise<{ ok: T } | { failed: unknown }> {
  try {
    return { ok: await run() };
  } catch (error) {
    return { failed: summarize(error) };
  }
}

/** What a transform is handed, as a caller can read it. */
function describeMessage(format: WorkerFormat, message: unknown): unknown {
  if (format === "json") {
    return {
      json: JSON.stringify(message),
      inspect: inspect(message, {
        depth: Infinity,
        maxArrayLength: Infinity,
        maxStringLength: Infinity,
      }),
      keys: typeof message === "object" && message !== null ? Object.keys(message) : null,
    };
  }
  if (format === "text") return { text: message };
  return { constructor: (message as object).constructor.name };
}

const passThrough: TransformFunction = (message) => [message];
const addressToLab: TransformFunction = (message) => {
  (message as { setField(path: string, value: string): void }).setField("MSH.5", "LAB");
  return message;
};

describe("output equivalence", () => {
  it("has a corpus of a few hundred inputs, in every format", () => {
    expect(CORPUS.length).toBeGreaterThan(500);
    const formats = new Set(CORPUS.map((entry) => entry.format));
    expect([...formats].sort()).toEqual(["ccda", "fhir", "hl7v2", "json", "text", "x12"]);
  });

  it("the transform worker: decode, encode and runTransform", { timeout: 120_000 }, async () => {
    const records = new Map<string, unknown>();
    for (const entry of CORPUS) {
      const decoded = await outcome(async () => {
        const message = await decode(entry.format, bodyOf(entry));
        return {
          message: describeMessage(entry.format, message),
          encoded: await outcome(() => encode(entry.format, message)),
        };
      });
      const passed = await outcome(() => runTransform(passThrough, entry.format, bodyOf(entry)));
      const edited =
        entry.format === "hl7v2"
          ? await outcome(() => runTransform(addressToLab, entry.format, bodyOf(entry)))
          : undefined;
      records.set(entry.id, { decoded, passed, edited });
    }
    compare("worker", records);
  });

  it("an MLLP source's header reading and ACKs", () => {
    const blank = (ack: Uint8Array): string =>
      Buffer.from(ack)
        .toString("latin1")
        .replace(
          /^(MSH\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|)[^|]*(\|[^|]*\|[^|]*\|)[^|]*/,
          "$1<time>$2<id>",
        );
    const records = new Map<string, unknown>();
    const requests: [string, Omit<AckRequest, "header">][] = [
      ["AA", { code: "AA", reason: "stored", problem: undefined, messageId: 1 }],
      [
        "AE store-failed",
        { code: "AE", reason: "store-failed", problem: undefined, messageId: undefined },
      ],
      [
        "AR store-failed",
        { code: "AR", reason: "store-failed", problem: undefined, messageId: undefined },
      ],
      [
        "AR no control id",
        { code: "AR", reason: "unreadable", problem: "NO_CONTROL_ID", messageId: 2 },
      ],
      [
        "AR other",
        { code: "AR", reason: "unreadable", problem: "MULTIPLE_MESSAGES", messageId: 3 },
      ],
    ];
    for (const entry of CORPUS) {
      if (entry.format !== "hl7v2") continue;
      const reading = readHeader(bodyOf(entry));
      const acks: Record<string, string> = {};
      for (const [name, request] of requests) {
        try {
          acks[name] = blank(defaultAckBuilder({ ...request, header: reading.header }));
        } catch (error) {
          acks[name] = `threw ${JSON.stringify(summarize(error))}`;
        }
      }
      records.set(entry.id, {
        problem: reading.problem,
        controlId: reading.controlId,
        duplicateKey: reading.duplicateKey,
        header: reading.header?.toString(),
        acks,
      });
    }
    for (const [name, request] of requests) {
      records.set(`no header ${name}`, blank(defaultAckBuilder({ ...request, header: undefined })));
    }
    compare("ack", records);
  });

  it(
    "the engine: one pass a format, file to file through encrypted SQLite",
    { timeout: 240_000 },
    async () => {
      const records = new Map<string, unknown>();
      const formats = [...new Set(CORPUS.map((entry) => entry.format))].sort();
      const transform = [
        "export default (msg: { setField(path: string, value: string): void }) => {",
        '  msg.setField("MSH.5", "LAB");',
        "  return msg;",
        "};",
        "",
      ].join("\n");
      for (const format of formats) {
        const entries = CORPUS.filter((entry) => entry.format === format);
        const files: Record<string, string | Uint8Array> = {
          "pathways.yaml": "",
          "channels/eq/channel.yaml": [
            "name: eq",
            `format: ${format}`,
            "source:",
            "  file: { dir: ../../data/in, minAge: 0 }",
            ...(format === "hl7v2" ? ["transform: ./transform.ts"] : []),
            "destinations:",
            "  - file: { dir: ../../data/out }",
            "",
          ].join("\n"),
          "channels/eq/transform.ts": transform,
        };
        entries.forEach((entry, n) => {
          files[`data/in/${String(n).padStart(4, "0")}.msg`] = bodyOf(entry);
        });
        const root = await makeProject(files);
        const project = await loadProject(root);
        const fixed = Date.parse("2026-11-07T12:00:00.000Z");
        const raw = await Store.open(project.databaseFile, { now: () => new Date(fixed) });
        const keys = new LocalKeyProvider([["eq", randomBytes(KEY_BYTES)]], "eq");
        const store = new EncryptedStore(raw, keys);
        const { logger, events } = captureLogger();
        // The engine's own clock is the real one, so the file source finds its files ready; what is
        // recorded reads the store's fixed clock.
        const engine = new Engine({ project, store, logger });
        try {
          await engine.start();
          await engine.tick();
          await engine.tick();
        } finally {
          await engine.stop();
        }
        const out = join(root, "data", "out");
        const delivered: Record<string, string> = {};
        for (const name of (await readdir(out).catch(() => [])).sort()) {
          delivered[name] = b64(await readFile(join(out, name)));
        }
        const rows: unknown[] = [];
        for (let id = 1; id <= entries.length; id++) {
          rows.push({
            message: await store.message(id),
            body: (await store.messageBody(id)) ?? null,
            outputs: await store.outputs(id),
            deliveries: await store.deliveries(id),
          });
        }
        // Every input was taken in, and most were delivered: a pass that took nothing in proves nothing.
        expect(
          rows.filter((row) => (row as { message?: unknown }).message !== undefined),
        ).toHaveLength(entries.length);
        expect(Object.keys(delivered).length).toBeGreaterThan(entries.length / 3);
        const log = events.map(({ time: _time, pid: _pid, hostname: _host, ...rest }) => rest);
        records.set(format, {
          delivered,
          rows,
          counts: await store.messageCounts("eq"),
          deliveryCounts: await store.deliveryCounts("eq"),
          page: await store.listMessages({ limit: 1_000 }),
          log,
        });
        await store.close();
      }
      compare("engine", records);
    },
  );
});
