import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type BatchOptions,
  type BatchResult,
  EnvelopeCheck,
  scanBatch,
  splitPieces,
} from "../src/connectors/batch.js";
import { CLAIMED_DIR, FAILED_DIR, FileSource } from "../src/connectors/file.js";
import { HttpSource, type HttpSourceOptions } from "../src/connectors/http.js";
import type { MessageSink, ReceivedPiece, ReceiveOptions } from "../src/connectors/types.js";
import { ADT_A01, cleanUp, dropFile, makeProject } from "./helpers.js";
import { makeCertificates, removeCertificates, send, type Certificates } from "./net-helpers.js";

afterEach(cleanUp);

/** A synthetic ADT^A01 whose control ID is `MSG<n>`: every value is made up. */
const adt = (n: number): string => ADT_A01.replace("MSG00001", `MSG${String(n).padStart(5, "0")}`);

/** `text` as bytes, `size` at a time. */
async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  for (let at = 0; at < bytes.byteLength; at += size) yield bytes.subarray(at, at + size);
}

/** A byte order mark, which opens a file and is not part of its first message. */
const BOM = String.fromCharCode(0xfeff);

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));
const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

/** Every piece `splitPieces` cuts `text` into, read `size` bytes at a time. */
async function cut(
  text: string | Uint8Array,
  options: Pick<BatchOptions, "split" | "delimiter">,
  size = 7,
): Promise<{ bodies: string[]; failures: (string | undefined)[]; warnings: string[] }> {
  const warnings = new Set<string>();
  const bodies: string[] = [];
  const failures: (string | undefined)[] = [];
  const bytes = typeof text === "string" ? bytesOf(text) : text;
  for await (const piece of splitPieces(chunked(bytes, size), options, warnings)) {
    expect(piece.index).toBe(bodies.length);
    bodies.push(latin1(piece.body));
    failures.push(piece.failure);
  }
  return { bodies, failures, warnings: [...warnings] };
}

describe("splitPieces", () => {
  it("cuts lines at LF on bytes, drops a CR before it and skips empty lines", async () => {
    // 0xe9 alone is not UTF-8: a cut on decoded text would turn it into U+FFFD.
    const input = new Uint8Array([...bytesOf("one\r\n"), 0xe9, ...bytesOf("two\n\n\r\nthree")]);
    for (const size of [1, 2, 5, 64]) {
      const { bodies } = await cut(input, { split: "lines" }, size);
      expect(bodies).toEqual(["one", "étwo", "three"]);
    }
  });

  it("cuts at a delimiter that spans chunks, and skips empty pieces", async () => {
    const delimiter = bytesOf("\n---\n");
    const input = "first\n---\nsecond\n---\n\n---\nthird\n---\n";
    for (const size of [1, 3, 4, 100]) {
      const { bodies } = await cut(input, { split: "delimiter", delimiter }, size);
      expect(bodies).toEqual(["first", "second", "third"]);
    }
  });

  it("cuts an HL7 batch into each message's own bytes, the envelope left out", async () => {
    const one = adt(1);
    const two = adt(2).replaceAll("\r", "\r\n");
    const input = `${BOM}BHS|^~\\&|SYNTH\r${one}${two}BTS|2\r`;
    const bytes = new Uint8Array(Buffer.from(input, "utf8"));
    for (const size of [1, 13, 4096]) {
      const { bodies, failures, warnings } = await cut(bytes, { split: "hl7" }, size);
      // Each piece is exactly the bytes it held, CR LF and all: nothing is re-serialised.
      expect(bodies).toEqual([one, two]);
      expect(failures).toEqual([undefined, undefined]);
      expect(warnings).toEqual([]);
    }
  });

  it("yields a piece HL7 cannot read with its code and no bytes, and goes on", async () => {
    const { bodies, failures } = await cut(`PID|1||TEST000009\r${adt(3)}`, { split: "hl7" });
    expect(failures).toEqual(["NO_MSH_SEGMENT", undefined]);
    expect(bodies).toEqual(["", adt(3)]);
  });

  it("says when the last HL7 message is cut off", async () => {
    const { warnings } = await cut(adt(4).slice(0, -1), { split: "hl7" });
    expect(warnings).toEqual(["UNTERMINATED_STREAM_MESSAGE"]);
  });
});

/** What an envelope check says of `text`. */
function envelope(text: string): readonly string[] {
  const check = new EnvelopeCheck();
  for (const byte of bytesOf(text)) check.push(Uint8Array.of(byte));
  return check.end();
}

describe("EnvelopeCheck", () => {
  it("finds a whole batch, and bare messages, complete", () => {
    expect(envelope(`FHS|^~\\&\rBHS|^~\\&\r${adt(1)}${adt(2)}BTS|2\rFTS|1\r`)).toEqual([]);
    expect(envelope(`${adt(1)}${adt(2)}`)).toEqual([]);
    // A count that is not a number checks nothing, as in @cosyte/hl7.
    expect(envelope(`BHS|^~\\&\r${adt(1)}BTS|x\r`)).toEqual([]);
    // A blank line between messages is not a message.
    expect(envelope(`BHS|^~\\&\r${adt(1)}\r\n  \r${adt(2)}BTS|2`)).toEqual([]);
  });

  it("finds a missing trailer", () => {
    expect(envelope(`BHS|^~\\&\r${adt(1)}`)).toEqual(["BATCH_MISSING_TRAILER"]);
    expect(envelope(`FHS|^~\\&\rBHS|^~\\&\r${adt(1)}BTS|1\r`)).toEqual(["BATCH_MISSING_TRAILER"]);
  });

  it("finds a count that does not match", () => {
    expect(envelope(`BHS|^~\\&\r${adt(1)}BTS|2\r`)).toEqual(["BATCH_COUNT_MISMATCH"]);
    expect(envelope(`FHS|^~\\&\rBHS|^~\\&\r${adt(1)}BTS|1\rFTS|2\r`)).toEqual([
      "BATCH_COUNT_MISMATCH",
    ]);
  });
});

describe("scanBatch", () => {
  it("hashes the bytes, and stops at maxFileSize", async () => {
    const bytes = bytesOf(`${adt(1)}${adt(2)}`);
    const whole = await scanBatch(chunked(bytes, 10), { split: "hl7" });
    const again = await scanBatch(chunked(bytes, 3), { split: "hl7" });
    expect(whole).toEqual({
      size: bytes.byteLength,
      hash: again.hash,
      tooLarge: false,
      envelope: [],
    });
    expect(whole.hash).toMatch(/^[0-9a-f]{16}$/);
    const large = await scanBatch(chunked(bytes, 10), { split: "lines", maxFileSize: 20 });
    expect(large.tooLarge).toBe(true);
  });
});

/** What a sink was handed for one piece. */
interface Handed {
  readonly body: string;
  readonly key: string | undefined;
  readonly resumed: boolean | undefined;
  readonly failure: string | undefined;
  readonly source: ReceiveOptions["source"];
}

/**
 * A sink that looks a resumed message's key up, as the engine's store does, and stores it once.
 * With `failAt`, it throws instead of storing the message handed to it that many times in.
 */
function batchSink(): {
  sink: MessageSink;
  handed: Handed[];
  stored: Map<string, number>;
  results: BatchResult[];
  failAt: { at: number };
} {
  const handed: Handed[] = [];
  const stored = new Map<string, number>();
  const results: BatchResult[] = [];
  const failAt = { at: 0 };
  let next = 1;
  const receivePiece = (body: Uint8Array, options: ReceiveOptions = {}): Promise<ReceivedPiece> => {
    handed.push({
      body: latin1(body),
      key: options.idempotencyKey,
      resumed: options.resumed,
      failure: options.failure,
      source: options.source,
    });
    if (handed.length === failAt.at) return Promise.reject(new Error("synthetic stop"));
    const key = options.idempotencyKey ?? `unkeyed-${String(next)}`;
    const found = options.resumed === true ? stored.get(key) : undefined;
    if (found !== undefined) return Promise.resolve({ id: found, alreadyStored: true });
    const id = next++;
    stored.set(key, id);
    return Promise.resolve({ id, alreadyStored: false });
  };
  const sink: MessageSink = {
    receive: async (body, options) => (await receivePiece(body, options)).id,
    receivePiece,
    batchDone: (result) => {
      results.push(result);
      return Promise.resolve();
    },
  };
  return { sink, handed, stored, results, failAt };
}

const channel = "adt";

async function inbox(): Promise<string> {
  return join(await makeProject({}), "inbox");
}

describe("A file source with batch", () => {
  it("stores each piece under its own key, with the piece's facts, then deletes the file", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "feed.hl7"), `BHS|^~\\&\r${adt(1)}${adt(2)}${adt(3)}BTS|3\r`);
    const { sink, handed, results } = batchSink();
    const source = new FileSource({ dir, channel, minAgeMs: 0, batch: { split: "hl7" } });
    await source.poll(sink);

    expect(handed.map((piece) => piece.body)).toEqual([adt(1), adt(2), adt(3)]);
    const hash = (handed[0]?.source?.["batch"] as { hash: string }).hash;
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    handed.forEach((piece, index) => {
      expect(piece.key).toMatch(
        new RegExp(`^file:\\d{15}\\.\\d{8}\\.[0-9a-f]{8}-feed\\.hl7#${hash}#${String(index)}$`),
      );
      expect(piece.resumed).toBe(false);
      expect(piece.source).toEqual({ name: "feed.hl7", batch: { piece: index, hash } });
    });
    expect(results).toEqual([
      {
        source: "file",
        outcome: "stored",
        pieces: 3,
        stored: 3,
        failed: 0,
        duplicates: 0,
        warnings: [],
      },
    ]);
    expect(await readdir(dir)).toEqual([CLAIMED_DIR]);
    expect(await readdir(join(dir, CLAIMED_DIR, channel))).toEqual([]);
  });

  it("keeps a file a stop cut short claimed, and the next pass stores each piece once", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "notes.txt"), "note one\nnote two\nnote three\nnote four\n");
    const { sink, handed, stored, results, failAt } = batchSink();
    const source = new FileSource({ dir, channel, minAgeMs: 0, batch: { split: "lines" } });
    failAt.at = 3;
    await expect(source.poll(sink)).rejects.toThrow("synthetic stop");
    // Two pieces stored, the third refused: the file is still claimed.
    expect(stored.size).toBe(2);
    expect(await readdir(join(dir, CLAIMED_DIR, channel))).toHaveLength(1);

    await source.poll(sink);
    // Every piece handed in again, resumed, and each stored once.
    expect(handed.slice(3).map((piece) => [piece.body, piece.resumed])).toEqual([
      ["note one", true],
      ["note two", true],
      ["note three", true],
      ["note four", true],
    ]);
    expect(stored.size).toBe(4);
    expect(results).toEqual([
      expect.objectContaining({ pieces: 4, stored: 2, duplicates: 2, failed: 0 }),
    ]);
    expect(await readdir(join(dir, CLAIMED_DIR, channel))).toEqual([]);
  });

  it("stores a piece that cannot be read as failed with no content, and its siblings go on", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "feed.hl7"), `PID|1||TEST000009\r${adt(5)}`);
    const { sink, handed, results } = batchSink();
    await new FileSource({ dir, channel, minAgeMs: 0, batch: { split: "hl7" } }).poll(sink);
    expect(handed.map((piece) => [piece.body, piece.failure])).toEqual([
      ["", "batch: NO_MSH_SEGMENT"],
      [adt(5), undefined],
    ]);
    expect(handed[0]?.source).toBeUndefined();
    expect(results[0]).toEqual(expect.objectContaining({ pieces: 2, stored: 1, failed: 1 }));
  });

  it("fails a file with no message and moves it aside, so no pass reads it again", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "blank.txt"), "\n\r\n\n");
    const { sink, handed, results } = batchSink();
    const faults: string[] = [];
    const source = new FileSource({
      dir,
      channel,
      minAgeMs: 0,
      batch: { split: "lines" },
      onFileFault: ({ reason }) => faults.push(reason),
    });
    await source.poll(sink);
    await source.poll(sink);
    expect(handed.map((piece) => [piece.body, piece.failure])).toEqual([
      ["", "batch: BATCH_EMPTY"],
    ]);
    expect(handed[0]?.key).toMatch(/#file$/);
    expect(results).toEqual([
      expect.objectContaining({ outcome: "failed", code: "BATCH_EMPTY", pieces: 0, failed: 1 }),
    ]);
    expect(faults).toEqual(["batch-empty"]);
    const failed = await readdir(join(dir, CLAIMED_DIR, channel, FAILED_DIR));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/-blank\.txt$/);
  });

  it("fails a file larger than maxFileSize with its code, into errorDir", async () => {
    const root = await makeProject({});
    const dir = join(root, "inbox");
    const errorDir = join(root, "errors");
    await dropFile(join(dir, "big.txt"), "x".repeat(100));
    const { sink, handed } = batchSink();
    const source = new FileSource({
      dir,
      channel,
      minAgeMs: 0,
      errorDir,
      batch: { split: "lines", maxFileSize: 50 },
    });
    await source.poll(sink);
    expect(handed.map((piece) => piece.failure)).toEqual(["batch: BATCH_FILE_TOO_LARGE"]);
    expect(await readFile(join(errorDir, "big.txt"), "utf8")).toBe("x".repeat(100));
  });

  it("holds an incomplete HL7 batch claimed for holdFor, then fails it", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "feed.hl7"), `BHS|^~\\&\r${adt(1)}`);
    const { sink, handed, results } = batchSink();
    let now = Date.now();
    const source = new FileSource({
      dir,
      channel,
      minAgeMs: 0,
      now: () => now,
      batch: { split: "hl7", holdForMs: 60_000 },
    });
    await source.poll(sink);
    await source.poll(sink);
    expect(handed).toEqual([]);
    expect(await readdir(join(dir, CLAIMED_DIR, channel))).toHaveLength(1);

    now += 60_000;
    await source.poll(sink);
    expect(handed.map((piece) => piece.failure)).toEqual(["batch: BATCH_INCOMPLETE"]);
    expect(results[0]).toEqual(
      expect.objectContaining({ code: "BATCH_INCOMPLETE", warnings: ["BATCH_MISSING_TRAILER"] }),
    );
  });

  it("stores an incomplete HL7 batch as it is with accept, and the warning goes with the result", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "feed.hl7"), `BHS|^~\\&\r${adt(1)}BTS|2\r`);
    const { sink, handed, results } = batchSink();
    await new FileSource({
      dir,
      channel,
      minAgeMs: 0,
      batch: { split: "hl7", onIncomplete: "accept" },
    }).poll(sink);
    expect(handed.map((piece) => piece.body)).toEqual([adt(1)]);
    expect(results[0]?.warnings).toEqual(["BATCH_COUNT_MISMATCH"]);
  });

  it("fails an incomplete HL7 batch at once with fail", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "feed.hl7"), `FHS|^~\\&\r${adt(1)}`);
    const { sink, handed } = batchSink();
    await new FileSource({
      dir,
      channel,
      minAgeMs: 0,
      batch: { split: "hl7", onIncomplete: "fail" },
    }).poll(sink);
    expect(handed.map((piece) => piece.failure)).toEqual(["batch: BATCH_INCOMPLETE"]);
  });

  it("works with a sink that has only receive", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.txt"), "a\nb\n");
    const bodies: string[] = [];
    const sink: MessageSink = {
      receive: (body) => {
        bodies.push(latin1(body));
        return Promise.resolve(bodies.length);
      },
    };
    await new FileSource({ dir, channel, minAgeMs: 0, batch: { split: "lines" } }).poll(sink);
    expect(bodies).toEqual(["a", "b"]);
  });
});

const TOKEN = "synthetic-token-0123456789abcdef";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let certs: Certificates;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

const sources: HttpSource[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop()));
});

async function listening(
  sink: MessageSink,
  options: Partial<HttpSourceOptions> = {},
): Promise<number> {
  const source = new HttpSource({
    host: "127.0.0.1",
    port: 0,
    paths: ["/batch"],
    maxBytes: 65_536,
    tls: { cert: certs.serverCert, key: certs.serverKey, ca: undefined },
    token: TOKEN,
    batch: { split: "hl7" },
    ...options,
  });
  sources.push(source);
  await source.start(sink);
  return source.port ?? 0;
}

describe("An HTTP source with batch", () => {
  it("keys each piece by the Idempotency-Key, answers with the ids, and stores a retry once", async () => {
    const { sink, handed, results } = batchSink();
    const port = await listening(sink);
    const body = `${adt(1)}${adt(2)}`;
    const headers = { ...AUTH, "Idempotency-Key": '"synthetic-key-0001"' };
    const first = await send(port, { path: "/batch", headers, body, ca: certs.ca });
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toEqual({ ids: [1, 2] });
    expect(first.body).not.toContain("MSH");
    const again = await send(port, { path: "/batch", headers, body, ca: certs.ca });
    expect(JSON.parse(again.body)).toEqual({ ids: [1, 2] });

    expect(handed.map((piece) => [piece.key, piece.resumed])).toEqual([
      ["http:key:synthetic-key-0001#0", true],
      ["http:key:synthetic-key-0001#1", true],
      ["http:key:synthetic-key-0001#0", true],
      ["http:key:synthetic-key-0001#1", true],
    ]);
    expect(handed[1]?.source).toEqual(
      expect.objectContaining({
        method: "POST",
        path: "/batch",
        batch: expect.objectContaining({ piece: 1 }) as unknown,
      }),
    );
    expect(results.map((result) => [result.stored, result.duplicates])).toEqual([
      [2, 0],
      [0, 2],
    ]);
  });

  it("keys each piece by the body's hash without an Idempotency-Key", async () => {
    const { sink, handed } = batchSink();
    const port = await listening(sink, { batch: { split: "lines" } });
    const answer = await send(port, { path: "/batch", headers: AUTH, body: "a\nb", ca: certs.ca });
    expect(JSON.parse(answer.body)).toEqual({ ids: [1, 2] });
    expect(handed[0]?.key).toMatch(/^http:sha256:[0-9a-f]{16}#0$/);
  });

  it("refuses an Idempotency-Key that is not one, and an incomplete or empty batch, storing nothing", async () => {
    const { sink, handed } = batchSink();
    const port = await listening(sink);
    const bad = await send(port, {
      path: "/batch",
      headers: { ...AUTH, "Idempotency-Key": "" },
      body: adt(1),
      ca: certs.ca,
    });
    expect(bad.status).toBe(400);
    const incomplete = await send(port, {
      path: "/batch",
      headers: AUTH,
      body: `BHS|^~\\&\r${adt(1)}`,
      ca: certs.ca,
    });
    expect(incomplete.status).toBe(422);
    expect(JSON.parse(incomplete.body)).toEqual({ error: "BATCH_INCOMPLETE" });
    const empty = await send(port, {
      path: "/batch",
      headers: AUTH,
      body: "\r\n\r\n",
      ca: certs.ca,
    });
    expect(empty.status).toBe(422);
    expect(JSON.parse(empty.body)).toEqual({ error: "BATCH_EMPTY" });
    expect(handed).toEqual([]);
  });

  it("answers 503 when a piece cannot be stored", async () => {
    const { sink, failAt } = batchSink();
    failAt.at = 2;
    const port = await listening(sink);
    const answer = await send(port, {
      path: "/batch",
      headers: AUTH,
      body: `${adt(1)}${adt(2)}`,
      ca: certs.ca,
    });
    expect(answer.status).toBe(503);
  });
});
