// The open-loop bench's own parts (bench/open-loop/): its arithmetic, which decides what a reading
// says, and its sender, which must time each message from when it was due rather than from when it
// left, or a slow engine would hide its own slowness (coordinated omission). The bench itself runs
// on a GitHub-hosted runner in the Bench reading workflow, against the built package.

import { createServer, type Server, type Socket } from "node:net";

import { readResults } from "@cosyte/bench";
import { afterEach, describe, expect, it } from "vitest";

import {
  CAPACITY_RULE,
  capacityOf,
  caseReading,
  decodeHistogram,
  judgeStep,
  latencyHistogram,
  percentiles,
  queueFlat,
  readingDocument,
  recordMs,
  spread,
  theilSen,
} from "../bench/open-loop/measure.mjs";
import { ackCode, firstAck, frame, frameReader, send } from "../bench/open-loop/sender.mjs";
import { mllpSink, sinkAck } from "../bench/open-loop/sink.mjs";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * An MLLP receiver that answers in order, as the engine answers one connection, holding its first
 * answer for `holdMs` and answering the rest at once.
 */
async function slowFirstReceiver(holdMs: number): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const reader = frameReader();
    let chain = Promise.resolve();
    let n = 0;
    socket.on("data", (chunk: Buffer) => {
      for (const text of reader.push(chunk)) {
        const wait = n === 0 ? holdMs : 0;
        n += 1;
        chain = chain
          .then(() => new Promise<void>((resolve) => setTimeout(resolve, wait)))
          .then(() => {
            socket.write(frame(sinkAck(text)));
          });
      }
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  server.on("close", () => {
    for (const socket of sockets) socket.destroy();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("the open-loop sender", () => {
  it("times each message from when it was due, so a stall is charged to every message behind it", async () => {
    const port = await slowFirstReceiver(500);
    const result = await send({
      targets: [{ protocol: "mllp", host: "127.0.0.1", port }],
      rate: 100,
      seconds: 1,
      drainSeconds: 10,
    });
    expect(result.sent).toBe(100);
    expect(result.accepted).toBe(100);
    expect(result.unanswered).toBe(0);
    // The first answer is held 500 ms. Messages due in that time wait behind it on the connection,
    // so about 50 of the 100 see 100 ms or more. A sender that timed from its own send, waiting for
    // each ACK first, would have seen one slow message and 99 fast ones.
    const histogram = decodeHistogram(result.histogram);
    expect(histogram.totalCount).toBe(100);
    // At least 30 of the 100 waited 100 ms or more (values are in microseconds).
    expect(histogram.getValueAtPercentile(70)).toBeGreaterThanOrEqual(100_000);
    expect(result.latency.p50Ms).toBeGreaterThan(50);
    expect(result.latency.maxMs).toBeGreaterThanOrEqual(490);
    expect(result.messageBytes).toBeGreaterThan(250);
  });

  it("keeps sending at its rate while nothing is answered", async () => {
    const port = await slowFirstReceiver(1_500);
    const started = performance.now();
    const result = await send({
      targets: [{ protocol: "mllp", host: "127.0.0.1", port }],
      rate: 200,
      seconds: 0.5,
      drainSeconds: 10,
    });
    expect(result.sent).toBe(100);
    // Every message left in about half a second, though the first answer took 1.5 s.
    expect(result.sendSeconds).toBeLessThan(1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(result.accepted).toBe(100);
  });

  it("reads frames split across chunks and the code of an ACK", () => {
    const reader = frameReader();
    const bytes = Buffer.concat([frame("MSH|a\rMSA|AA|1\r"), frame("MSH|b\rMSA|AE|2\r")]);
    expect(reader.push(bytes.subarray(0, 7))).toEqual([]);
    const texts = reader.push(bytes.subarray(7));
    expect(texts.map(ackCode)).toEqual(["AA", "AE"]);
    expect(ackCode("MSH|x\r")).toBeUndefined();
  });

  it("waits for a port that is not yet listening and times the first ACK on the new connection", async () => {
    const sink = await mllpSink();
    await sink.takeDown();
    setTimeout(() => void sink.bringUp(), 200);
    const ms = await firstAck({ protocol: "mllp", host: "127.0.0.1", port: sink.port }, 7, 5_000);
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThanOrEqual(150);
    expect(sink.received).toBe(1);
    await sink.close();
  });
});

describe("the open-loop arithmetic", () => {
  it("publishes p50, p99, p99.9 and the maximum, never a mean", () => {
    const histogram = latencyHistogram();
    for (let i = 1; i <= 1000; i++) recordMs(histogram, i);
    const p = percentiles(histogram);
    expect(Object.keys(p).sort()).toEqual(["count", "maxMs", "p50Ms", "p999Ms", "p99Ms"]);
    expect(p.p50Ms).toBeCloseTo(500, -1);
    expect(p.p99Ms).toBeCloseTo(990, -1);
    expect(p.p999Ms).toBeCloseTo(999, -1);
    expect(p.maxMs).toBeCloseTo(1000, -1);
    expect(percentiles(latencyHistogram()).p99Ms).toBeNull();
  });

  it("fits a slope that one jump cannot move", () => {
    const points = Array.from({ length: 20 }, (_v, i) => [i, 2 * i] as [number, number]);
    points[10] = [10, 10_000];
    expect(theilSen(points)).toBe(2);
    expect(theilSen([[1, 1]])).toBe(0);
  });

  it("calls a queue flat only when it grows by less than a second of traffic over the step", () => {
    const steady = Array.from({ length: 20 }, (_v, i) => [i, 50 + (i % 3)] as [number, number]);
    expect(queueFlat(steady, 100).flat).toBe(true);
    const growing = Array.from({ length: 20 }, (_v, i) => [i, 20 * i] as [number, number]);
    expect(queueFlat(growing, 100).flat).toBe(false);
    expect(queueFlat([[0, 0]], 100).flat).toBe(false);
  });

  it("holds a step to every answer AA, the p99 and a flat queue, and names what failed", () => {
    const queue = Array.from({ length: 20 }, (_v, i) => [i, 3] as [number, number]);
    const good = { rate: 100, sent: 2000, accepted: 2000, latency: { p99Ms: 12 }, queue };
    expect(judgeStep(good)).toMatchObject({ holds: true, reasons: [] });
    const slow = { ...good, latency: { p99Ms: CAPACITY_RULE.p99Ms + 1 } };
    expect(judgeStep(slow).holds).toBe(false);
    expect(judgeStep(slow).reasons[0]).toMatch(/p99/);
    const lossy = { ...good, accepted: 1999 };
    expect(judgeStep(lossy).reasons[0]).toMatch(/1 of 2000 not answered AA/);
  });

  it("takes capacity as the highest rate below the first step that fails", () => {
    const step = (rate: number, holds: boolean) => ({ rate, judged: { holds } });
    expect(capacityOf([step(50, true), step(100, true), step(200, false)])).toEqual({
      rate: 100,
      atLeast: false,
    });
    expect(capacityOf([step(50, true), step(100, true)])).toEqual({ rate: 100, atLeast: true });
    expect(capacityOf([step(50, false), step(100, true)])).toEqual({ rate: null, atLeast: false });
  });

  it("reports every run with its spread", () => {
    expect(spread([400, 600, null, 500])).toEqual({
      runs: [400, 600, null, 500],
      min: 400,
      median: 500,
      max: 600,
    });
  });

  it("writes a reading the results format reads, stating the conditions", () => {
    const histogram = latencyHistogram();
    for (let i = 1; i <= 100; i++) recordMs(histogram, i / 10);
    const conditions = {
      messageBytes: 300,
      destinations: "an MLLP receiver",
      storage: "SQLite",
      disk: "ext4 on /dev/root",
      encryption: "on",
      tls: "the MLLP source",
      runner: "local-linux-x64",
      node: process.version,
      commit: "0000000",
    };
    const document = readingDocument({
      suiteName: "@cosyte/pathways open loop: mllps",
      suiteFile: "bench/open-loop/run.mjs",
      target: "dist/index.mjs",
      commit: "0000000",
      cases: [
        caseReading({
          benchmark: "open loop: MLLP over TLS",
          size: "run 1, 100 messages/s for 1 s",
          messages: 100,
          bytes: 30_000,
          seconds: 1,
          latency: percentiles(histogram),
          openLoop: { run: 1 },
        }),
      ],
      conditions,
      bench: {},
      toolVersion: "0.0.0",
    });
    const read = readResults(JSON.stringify(document));
    expect(read.kind).toBe("reading");
    const latency = document.reading.cases[0]?.latency;
    expect(latency).not.toBeNull();
    expect(latency?.p99Ns).toBeGreaterThan(0);
    expect(latency?.p999Ns).toBeGreaterThanOrEqual(latency?.p99Ns ?? 0);
    expect(JSON.stringify(document)).not.toMatch(/mean/i);
    for (const key of ["messageBytes", "destinations", "storage", "disk", "encryption", "tls"]) {
      expect(document.conditions).toHaveProperty(key);
    }
  });
});
