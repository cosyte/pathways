/**
 * The scaling gates for the synchronous paths Pathways runs on every message, from
 * `@cosyte/test-utils/perf`, run by `pnpm test:perf` and never under coverage (see
 * `vitest.perf.config.ts`).
 *
 * Each asks one question: does the cost grow faster than the input? On the count axis, 4 times the
 * messages; on the size axis, messages 4 times longer. Each ratio must stay inside the band the
 * shared contract fixes. A gate does not see a constant-factor slowdown: a path 10% slower
 * everywhere passes. The base against head comparison on a pull request (`bench/pathways.bench.mjs`)
 * is the instrument for that, and the engine's own asynchronous path (storage, encryption, the
 * worker) is read by the bench's throughput budget, since the gate times synchronous calls only.
 *
 * - `readHeader`: an MLLP source reads the header of every message it takes in, in the engine's own
 *   thread, before it stores the message: it parses the MSH segment and scans every later segment
 *   for another message's start.
 * - `decode` for a `json` channel: the worker parses every JSON body, then reads its text once to
 *   check each number can be held exactly. That branch does all of its work before it returns, so the
 *   gate times it as a synchronous call; the first test below holds it to that.
 *
 * Each base phase is sized to take 10 ms or more on a GitHub-hosted runner (the contract refuses a
 * phase under 4 ms); the input count only lengthens a phase, it does not move a ratio. Each
 * self-check proves its fixtures are large enough for its gate to fail: the same work reached
 * quadratically, each segment or record found by hopping from the start of the message over every
 * one before it, must clear the ceiling at exactly these sizes. Every input is synthetic and built in
 * code by `bench/shapes.mjs`, the code the benchmarks use.
 */

import {
  assertScalingGateFires,
  scalingGate,
  type ScalingGateOptions,
} from "@cosyte/test-utils/perf";
import { describe, expect, it } from "vitest";

import { adtMessage, jsonRecord, jsonRecords, oruMessage } from "../../bench/shapes.mjs";
import { readHeader, type HeaderReading } from "../../src/connectors/mllp.js";
import { decode } from "../../src/engine/worker-entry.js";

const CR = 0x0d;
/** The bytes of one ORU^R01 OBX segment, near enough to turn a segment count into a size. */
const OBX_BYTES = 70;
/** The bytes of one JSON lab record in `jsonRecords`, near enough to turn a count into a size. */
const RECORD_BYTES = 125;

/**
 * The same bytes, reached the wrong way: each segment is found by hopping from the start of the
 * message over every segment before it, so the cost grows with the square of the segment count.
 */
function resegmentQuadratically(bytes: Uint8Array): Uint8Array {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 1;
  for (let p = buffer.indexOf(CR); p !== -1; p = buffer.indexOf(CR, p + 1)) count++;
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    let start = 0;
    for (let k = 0; k < i; k++) start = buffer.indexOf(CR, start) + 1;
    const end = buffer.indexOf(CR, start);
    parts.push(buffer.subarray(start, end === -1 ? buffer.length : end + 1));
  }
  return Buffer.concat(parts);
}

/** The same text, each record found by hopping from the start over every record before it. */
function rerecordQuadratically(text: string): string {
  const parts: string[] = [];
  let count = 1;
  for (let p = text.indexOf("},"); p !== -1; p = text.indexOf("},", p + 1)) count++;
  for (let i = 0; i < count; i++) {
    let start = 0;
    for (let k = 0; k < i; k++) start = text.indexOf("},", start) + 2;
    const end = text.indexOf("},", start);
    parts.push(text.slice(start, end === -1 ? text.length : end + 2));
  }
  return parts.join("");
}

/** A skip is not a pass: a gate that could not measure says so here, rather than reading green. */
function expectMeasured(report: ReturnType<typeof scalingGate>): void {
  expect(report.count.status, report.count.diagnostic).toBe("measured");
  expect(report.size.status, report.size.diagnostic).toBe("measured");
}

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));

const headerOptions: ScalingGateOptions<Uint8Array, HeaderReading> = {
  name: "@cosyte/pathways readHeader",
  parse: (payload) => readHeader(payload),
  weigh: (reading) => (reading.problem === undefined ? 1 : 0),
  // 2,000 headers measured a clean base phase of 20.9 ms and 24 reports 16.5 ms on a runner, both
  // over 10 ms. At 48 reports the self-check's quadratic pass took over a second, and its warmup did
  // not settle inside its 5 s bound on a busy machine, so the size axis stays at 24.
  count: { n: 2_000, generate: (i) => bytesOf(adtMessage(i)) },
  size: {
    inputs: 24,
    size: 1_000,
    generate: (i, segments) => bytesOf(oruMessage(i, segments * OBX_BYTES)),
  },
};

const sameReading = (a: HeaderReading, b: HeaderReading): boolean =>
  a.problem === b.problem && a.controlId === b.controlId && a.duplicateKey === b.duplicateKey;

/** What `decode` was handed, kept so the self-check can show both versions read the same text. */
interface JsonInput {
  readonly text: string;
  readonly body: Uint8Array;
}

const jsonInput = (text: string): JsonInput => ({ text, body: bytesOf(text) });

const decodeJson = (input: JsonInput): Promise<unknown> => decode("json", input.body);

const jsonOptions: ScalingGateOptions<JsonInput, Promise<unknown>> = {
  name: "@cosyte/pathways decode, json",
  parse: decodeJson,
  weigh: () => 1,
  // Once the read checked numbers in one pass, 2,000 records measured a base phase of 3.8 ms, under
  // the 4 ms floor, and 6,000 measured 11.1 ms on one runner: it runs at 12,000, for 10 ms or more
  // on a slower one.
  count: { n: 12_000, generate: (i) => jsonInput(jsonRecord(i)) },
  size: {
    // At 400 records against 1,600 the quadratic self-check measured a signal of 7.2, under the
    // ceiling of 8: the reviver's own cost per record is high enough that the hops need more
    // records to stand out: 1,000 against 4,000 measured 9.2, a margin of 1.15, so it runs at 1,600.
    // Once the read checked numbers in one pass, 3 inputs measured a base phase of 7.0 ms on one
    // runner and 3.9 ms on another, under the 4 ms floor: it runs at 12, for 10 ms or more.
    inputs: 12,
    size: 1_600,
    generate: (i, records) => jsonInput(jsonRecords(i, records * RECORD_BYTES)),
  },
};

describe("the scaling gate: readHeader", () => {
  it("has not acquired a complexity regression on either axis", () => {
    expectMeasured(scalingGate(headerOptions));
  });

  it("has fixtures large enough for that gate to fail", () => {
    const sample = bytesOf(oruMessage(0, 50 * OBX_BYTES));
    expect(Buffer.from(resegmentQuadratically(sample)).equals(Buffer.from(sample))).toBe(true);
    const report = assertScalingGateFires(headerOptions, {
      regressedParse: (payload) => readHeader(resegmentQuadratically(payload)),
      equals: sameReading,
    });
    expect(report.margin).toBeGreaterThan(1);
  });
});

describe("the scaling gate: decode, json", () => {
  it("reads a JSON body before it returns, so the gate times the whole read", async () => {
    const parse = JSON.parse;
    let calls = 0;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      calls++;
      return parse(...args) as unknown;
    }) as typeof JSON.parse;
    let pending: Promise<unknown>;
    try {
      pending = decode("json", bytesOf(jsonRecords(0, 4 * RECORD_BYTES)));
      expect(calls).toBe(1);
    } finally {
      JSON.parse = parse;
    }
    await expect(pending).resolves.toHaveLength(4);
  });

  it("has not acquired a complexity regression on either axis", () => {
    expectMeasured(scalingGate(jsonOptions));
  });

  it("has fixtures large enough for that gate to fail", async () => {
    const sample = jsonRecords(0, 20 * RECORD_BYTES);
    expect(rerecordQuadratically(sample)).toBe(sample);
    const report = assertScalingGateFires(jsonOptions, {
      regressedParse: (input) => decodeJson(jsonInput(rerecordQuadratically(input.text))),
      // Each version hands decode the same text (shown above), so they read the same value.
      equals: () => true,
    });
    expect(report.margin).toBeGreaterThan(1);
    await Promise.resolve();
  });
});
