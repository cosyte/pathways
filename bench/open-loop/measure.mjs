// The arithmetic of the open-loop bench, kept apart from its processes so the tests can hold it:
// the latency histogram and the percentiles read from it, the slope of a series, whether a queue
// stayed flat, the capacity rule, the spread of several runs, and the reading document in the
// results format cosyte/benchmarks reads (@cosyte/bench's results schema, version 1).
//
// Latency is recorded in HdrHistogram (hdr-histogram-js) in microseconds, from the time a message
// was meant to be sent to the time its ACK arrived, so a sender that falls behind is charged for the
// wait (coordinated omission). A reading publishes p50, p99, p99.9 and the maximum, never a mean.

import { availableParallelism, cpus, loadavg, release, totalmem } from "node:os";
import { readFileSync } from "node:fs";

import hdr from "hdr-histogram-js";

/** The capacity rule. A step holds when every message it sent was answered AA, the p99 of its
 * latency is at most `p99Ms`, and its queue stayed flat: the queue's fitted growth over the step is
 * below `flatSeconds` of the step's own traffic. Capacity is the highest rate on the ladder whose
 * step holds, with every rate below it holding too. */
export const CAPACITY_RULE = Object.freeze({ p99Ms: 100, flatSeconds: 1 });

/** The highest latency a histogram tracks: one hour, in microseconds. A longer wait is clamped. */
const HIGHEST_US = 3_600_000_000;

/** A histogram of latencies in microseconds, three significant digits, in plain JavaScript. */
export function latencyHistogram() {
  return hdr.build({
    useWebAssembly: false,
    lowestDiscernibleValue: 1,
    highestTrackableValue: HIGHEST_US,
    numberOfSignificantValueDigits: 3,
  });
}

/** Records one latency in milliseconds, clamped to what the histogram tracks. */
export function recordMs(histogram, ms) {
  const us = Math.min(HIGHEST_US, Math.max(1, Math.round(ms * 1000)));
  histogram.recordValue(us);
}

/** A histogram as compressed text, for another process to read back and merge. */
export function encodeHistogram(histogram) {
  return hdr.encodeIntoCompressedBase64(histogram);
}

/** Reads back what {@link encodeHistogram} wrote. */
export function decodeHistogram(text) {
  return hdr.decodeFromCompressedBase64(text, 32, false);
}

/** The percentiles a reading publishes, in milliseconds. No mean. Null values with no samples. */
export function percentiles(histogram) {
  const count = histogram.totalCount;
  const at = (p) => (count === 0 ? null : histogram.getValueAtPercentile(p) / 1000);
  return {
    count,
    p50Ms: at(50),
    p99Ms: at(99),
    p999Ms: at(99.9),
    maxMs: count === 0 ? null : histogram.maxValue / 1000,
  };
}

/** The median of numbers, or null for none. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Every run's value with the lowest, the median and the highest: the spread, never one run alone. */
export function spread(values) {
  const known = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return {
    runs: values,
    min: known.length === 0 ? null : Math.min(...known),
    median: median(known),
    max: known.length === 0 ? null : Math.max(...known),
  };
}

/**
 * The Theil-Sen slope of `points` (`[x, y]` pairs): the median of the slopes between every pair
 * with different x. One sample that jumps cannot move it the way it moves a least-squares fit.
 * Zero for fewer than two points.
 */
export function theilSen(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j][0] - points[i][0];
      if (dx !== 0) slopes.push((points[j][1] - points[i][1]) / dx);
    }
  }
  return median(slopes) ?? 0;
}

/**
 * Whether a queue stayed flat over a step: `samples` are `[seconds, depth]` pairs taken during the
 * step, and the queue is flat when its fitted growth over the step's length is below `flatSeconds`
 * of traffic at `rate`. With fewer than three samples there is nothing to judge, and it is not flat.
 */
export function queueFlat(samples, rate, rule = CAPACITY_RULE) {
  if (samples.length < 3) return { flat: false, growth: null, allowed: rate * rule.flatSeconds };
  const span = samples[samples.length - 1][0] - samples[0][0];
  const growth = theilSen(samples) * span;
  const allowed = rate * rule.flatSeconds;
  return { flat: growth < allowed, growth, allowed };
}

/**
 * Whether one step of the ladder holds by {@link CAPACITY_RULE}, and why not when it does not.
 * `step` carries the sender's counts and latency and the queue's samples.
 */
export function judgeStep(step, rule = CAPACITY_RULE) {
  const reasons = [];
  const unanswered = step.sent - step.accepted;
  if (step.sent === 0) reasons.push("nothing sent");
  if (unanswered > 0) reasons.push(`${String(unanswered)} of ${String(step.sent)} not answered AA`);
  if (step.latency.p99Ms === null || step.latency.p99Ms > rule.p99Ms) {
    reasons.push(`p99 ${String(step.latency.p99Ms)} ms over ${String(rule.p99Ms)} ms`);
  }
  const queue = queueFlat(step.queue, step.rate, rule);
  if (!queue.flat) {
    reasons.push(
      queue.growth === null
        ? "too few queue samples"
        : `queue grew ${queue.growth.toFixed(0)}, over ${String(queue.allowed)}`,
    );
  }
  return { holds: reasons.length === 0, reasons, queueGrowth: queue.growth };
}

/**
 * The capacity of one run: the highest rate whose step holds, every lower step holding too, and
 * whether the ladder ended before a step failed (then the capacity is at least that rate).
 * `steps` are in rising order of rate, each judged.
 */
export function capacityOf(steps) {
  let capacity = null;
  let topped = true;
  for (const step of steps) {
    if (!step.judged.holds) {
      topped = false;
      break;
    }
    capacity = step.rate;
  }
  return { rate: capacity, atLeast: topped && capacity !== null };
}

/** The file system and device the folder `dir` is on, from /proc/self/mounts on Linux. */
export function diskOf(dir) {
  try {
    const mounts = readFileSync("/proc/self/mounts", "utf8")
      .split("\n")
      .map((line) => line.split(" "))
      .filter((parts) => parts.length >= 3);
    let best;
    for (const [device, mount, type] of mounts) {
      const prefix = mount.endsWith("/") ? mount : `${mount}/`;
      if (
        (dir === mount || dir.startsWith(prefix)) &&
        (!best || mount.length > best.mount.length)
      ) {
        best = { device, mount, type };
      }
    }
    return best === undefined ? null : `${best.type} on ${best.device}`;
  } catch {
    return null;
  }
}

function readCgroupCpuMax() {
  try {
    return readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
  } catch {
    return null;
  }
}

/** The machine a reading ran on, in the shape @cosyte/bench writes: no host name, user or path. */
export function environment(env = process.env) {
  const cpu = cpus()[0];
  const provider = env["GITHUB_ACTIONS"] === "true" ? "github-actions" : null;
  const imageOS = env["ImageOS"] ?? null;
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpuModel: cpu === undefined ? null : cpu.model.trim(),
    logicalCpus: availableParallelism(),
    totalMemoryBytes: totalmem(),
    cgroupCpuMax: readCgroupCpuMax(),
    loadAverage: loadavg().map((x) => Math.round(x * 100) / 100),
    runner: {
      ci: env["CI"] === "true",
      provider,
      environment: env["RUNNER_ENVIRONMENT"] ?? null,
      imageOS,
      imageVersion: env["ImageVersion"] ?? null,
      class:
        provider === null
          ? `local-${process.platform}-${process.arch}`
          : `${provider}-${env["RUNNER_ENVIRONMENT"] ?? "unknown"}-${imageOS ?? "unknown"}-${process.arch}`,
    },
  };
}

const NS_PER_MS = 1_000_000;

/**
 * One case of a reading, in the results schema's shape: the sender's latency as `latency` (p50,
 * p99 and max, with p99.9 beside them), the rate the engine answered as `throughput`, and the
 * conditions the reading was taken under. Memory is the profile's, so `allocations` and `peak` are
 * null, and `longRun` too: the hour-long run reports its slope in `openLoop`.
 */
export function caseReading({ benchmark, size, messages, bytes, seconds, latency, openLoop }) {
  const msPerOp = messages > 0 ? (seconds * 1000) / messages : 0;
  return {
    benchmark,
    size,
    inputsPerPass: messages,
    bytesPerPass: bytes,
    throughput:
      messages > 0
        ? {
            status: "measured",
            processes: [{ samplesMsPerOp: [msPerOp], medianMsPerOp: msPerOp }],
            medianMsPerOp: msPerOp,
            opsPerSecond: messages / seconds,
            bytesPerSecond: bytes === null ? null : bytes / seconds,
          }
        : { status: "skipped", reason: "no message was answered" },
    latency:
      latency.count > 0
        ? {
            status: "measured",
            calls: latency.count,
            timerOverheadNs: 0,
            p50Ns: latency.p50Ms * NS_PER_MS,
            p99Ns: latency.p99Ms * NS_PER_MS,
            maxNs: latency.maxMs * NS_PER_MS,
            p999Ns: latency.p999Ms * NS_PER_MS,
          }
        : null,
    allocations: null,
    peak: null,
    longRun: null,
    openLoop,
  };
}

/**
 * A reading document in the results format, version 1. `conditions` are what every reading of this
 * case states: message size, destinations, storage, disk, encryption, TLS, runner, Node and commit.
 */
export function readingDocument({
  suiteName,
  suiteFile,
  target,
  commit,
  cases,
  conditions,
  bench,
  toolVersion,
}) {
  return {
    schemaVersion: 1,
    kind: "reading",
    tool: { name: "@cosyte/bench", version: toolVersion },
    createdAt: new Date().toISOString(),
    suite: { name: suiteName, file: suiteFile },
    environment: environment(),
    contract: { bench, warmup: {}, openLoop: { capacityRule: CAPACITY_RULE } },
    subject: { target, commit },
    reading: { processes: 1, cases, importCost: null },
    conditions,
  };
}
