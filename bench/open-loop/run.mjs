// The open-loop bench: the paths production runs, measured from outside the engine.
//
//   pnpm build
//   node bench/open-loop/run.mjs --target dist/index.mjs --case <case> [--runs 5] [--seconds <n>]
//     [--commit <sha>] [--out <file.json>] [--summary <file.md>]
//
// Three processes: this driver, the built `pathways start` (bench/open-loop/project.mjs), and the
// open-loop sender (bench/open-loop/sender.mjs), which sends at a fixed rate and times each message
// from when it was due to its ACK. The driver runs the receivers downstream of the engine
// (bench/open-loop/sink.mjs), reads the engine's queue from its health endpoint once a second, and
// reads the engine's resident set from /proc. Every run starts a fresh project and database.
//
// The cases, in CASES below:
// - a ladder of rates (`mllp`, `mllps`, `https`, `postgres`, `channels`): each rate for STEP_SECONDS,
//   judged by the capacity rule in measure.mjs; the capacity of a run is the highest rate that holds;
// - `retry-backlog`: the MLLP receiver goes down while the sender keeps sending, and comes back;
//   how long the backlog takes to drain, how long the engine's first delivery on its new connection
//   to the receiver takes, and how long a new connection from the sender waits for its first ACK
//   while the backlog drains;
// - `startup-backlog`: a backlog built up with the receiver down, then the engine stopped and started
//   again: the time to answer health, to the first ACK on a new connection, and to drain;
// - `soak`: one fixed rate for an hour (`--seconds`), with the slope of the engine's resident set;
// - `drain`: the closed loop the first figure came from, `pathways start --once` over 2,000 messages
//   already waiting in a folder, file to file, for comparison.
//
// It writes a reading in @cosyte/bench's results format (version 1) and a Markdown summary. Every
// run is reported, with the spread across runs; none is picked. Readings on a hosted runner are
// advisory: they say where the engine stands on that machine, not what a deployment will see.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { BENCH_CONTRACT } from "@cosyte/bench";

import {
  makeProject as makeFileProject,
  removeProject as removeFileProject,
  runPass,
  TRANSFORMS,
} from "../engine.mjs";
import { adtMessage } from "../shapes.mjs";
import {
  CAPACITY_RULE,
  capacityOf,
  caseReading,
  decodeHistogram,
  diskOf,
  judgeStep,
  latencyHistogram,
  percentiles,
  queueFlat,
  readingDocument,
  spread,
  theilSen,
} from "./measure.mjs";
import {
  health,
  makeProject,
  queueDepth,
  removeProject,
  residentBytes,
  startEngine,
  stopEngine,
} from "./project.mjs";
import { firstAck } from "./sender.mjs";
import { httpSink, mllpSink } from "./sink.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SENDER = join(HERE, "sender.mjs");

/** The rates a ladder climbs, in messages a second. */
export const LADDER = [50, 100, 200, 400, 600, 800, 1000, 1200, 1500, 2000, 2500, 3000];
/** How long each rate of a ladder runs. */
export const STEP_SECONDS = 20;
/** A warmup at the lowest rate before each ladder, not judged. */
export const WARMUP_SECONDS = 10;
/** How long to wait for the queue to empty between steps and at the end of a case. */
const DRAIN_LIMIT_MS = 180_000;

/**
 * Every case. `protocol` is the sources', `connections` the sender's per source, `destinations`
 * each channel's, `storage` the database.
 */
export const CASES = {
  mllp: { kind: "ladder", protocol: "mllp", label: "MLLP" },
  mllps: { kind: "ladder", protocol: "mllps", label: "MLLP over TLS" },
  https: { kind: "ladder", protocol: "https", connections: 8, label: "HTTPS" },
  postgres: {
    kind: "ladder",
    protocol: "mllps",
    storage: "postgres",
    label: "MLLP over TLS, PostgreSQL",
  },
  channels: {
    kind: "ladder",
    protocol: "mllps",
    channels: 4,
    destinations: ["mllp", "http", "file"],
    label: "MLLP over TLS, 4 channels, 3 destinations each",
  },
  "retry-backlog": {
    kind: "retry",
    protocol: "mllps",
    rate: 200,
    outageSeconds: 30,
    afterSeconds: 90,
    label: "MLLP over TLS, a retry backlog draining",
  },
  "startup-backlog": {
    kind: "startup",
    protocol: "mllps",
    rate: 500,
    fillSeconds: 20,
    label: "MLLP over TLS, startup with a backlog",
  },
  soak: {
    kind: "soak",
    protocol: "mllps",
    rate: 100,
    seconds: 3600,
    label: "MLLP over TLS, an hour",
  },
  drain: { kind: "drain", messages: 2000, label: "closed-loop drain, file to file" },
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Runs the sender in a process of its own and resolves with what it printed. */
function runSender(options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SENDER, JSON.stringify(options)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`the sender exited ${String(code)}`));
        return;
      }
      resolvePromise(JSON.parse(out.trim().split("\n").pop()));
    });
  });
}

/** Samples the queue (and the engine's resident set) every `everyMs` until stopped. */
function sampler(project, pid, everyMs = 1_000) {
  const queue = [];
  const resident = [];
  const begun = performance.now();
  let running = true;
  const loop = (async () => {
    while (running) {
      const at = (performance.now() - begun) / 1000;
      const answer = await health(project.healthPort);
      const depth = queueDepth(answer.body);
      if (depth !== undefined) queue.push([at, depth]);
      const rss = residentBytes(pid);
      if (rss !== undefined) resident.push([at, rss]);
      await sleep(Math.max(0, everyMs - (performance.now() - begun - at * 1000)));
    }
  })();
  return {
    queue,
    resident,
    async stop() {
      running = false;
      await loop;
    },
  };
}

/** Waits until the queue is empty (or holds at most `allowed`), up to `limitMs`; ms taken or null. */
async function drained(project, limitMs = DRAIN_LIMIT_MS, allowed = 0) {
  const begun = performance.now();
  while (performance.now() - begun < limitMs) {
    const depth = queueDepth((await health(project.healthPort)).body);
    if (depth !== undefined && depth <= allowed) return performance.now() - begun;
    await sleep(100);
  }
  return null;
}

/** A fresh PostgreSQL database for one run, and its dropping. */
async function postgresDatabase(run) {
  const admin = process.env["PATHWAYS_BENCH_POSTGRES_URL"];
  if (admin === undefined || admin === "") {
    throw new Error("the postgres case needs PATHWAYS_BENCH_POSTGRES_URL, an administrator's URL");
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  const name = `pathways_bench_${String(process.pid)}_${String(run)}`;
  await client.query(`create database ${name}`);
  const version = (await client.query("show server_version")).rows[0].server_version;
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return {
    env: { PATHWAYS_DATABASE_URL: url.href },
    version,
    async drop() {
      await client.query(`drop database if exists ${name} with (force)`);
      await client.end();
    },
  };
}

/** Everything one run needs: receivers, a project, a database and the engine. */
async function setUp(c, bin, run) {
  const sinks = { mllp: await mllpSink(), http: await httpSink() };
  const project = await makeProject({
    protocol: c.protocol,
    channels: c.channels,
    destinations: c.destinations,
    storage: c.storage,
    sinks: { mllp: sinks.mllp.port, http: sinks.http.port },
  });
  const database = c.storage === "postgres" ? await postgresDatabase(run) : undefined;
  const env = database?.env ?? {};
  const engine = await startEngine(bin, project, env);
  return {
    sinks,
    project,
    database,
    env,
    engine,
    async tearDown() {
      await stopEngine(this.engine.child);
      await sinks.mllp.close();
      await sinks.http.close();
      await database?.drop();
      removeProject(project);
    },
  };
}

/** One step: the sender at `rate` for `seconds`, the queue sampled meanwhile. */
async function step(setup, c, rate, seconds, first) {
  const samples = sampler(setup.project, setup.engine.child.pid);
  const result = await runSender({
    targets: setup.project.targets,
    rate,
    seconds,
    first,
    connections: c.connections ?? 1,
  });
  await samples.stop();
  // The queue while the sender was sending; the sender's wait for its last answers is not the step.
  const queue = samples.queue.filter(([at]) => at <= seconds + 1);
  return { rate, seconds, ...result, queue, resident: samples.resident };
}

async function ladderRun(c, bin, run) {
  const setup = await setUp(c, bin, run);
  try {
    let first = 0;
    const warm = await step(setup, c, LADDER[0], WARMUP_SECONDS, first);
    first += warm.sent;
    await drained(setup.project);
    const steps = [];
    for (const rate of LADDER) {
      const s = await step(setup, c, rate, STEP_SECONDS, first);
      first += s.sent;
      s.judged = judgeStep({ ...s, latency: s.latency });
      s.drainMs = await drained(setup.project);
      steps.push(s);
      if (!s.judged.holds || s.drainMs === null) break;
    }
    return {
      readyMs: setup.engine.readyMs,
      steps,
      capacity: capacityOf(steps),
      extra: extraOf(setup),
    };
  } finally {
    await setup.tearDown();
  }
}

function extraOf(setup) {
  return setup.database === undefined ? {} : { postgres: setup.database.version };
}

async function retryRun(c, bin, run) {
  const setup = await setUp(c, bin, run);
  try {
    let first = 0;
    const warm = await step(setup, c, 50, WARMUP_SECONDS, first);
    first += warm.sent;
    await drained(setup.project);
    const seconds = c.outageSeconds + c.afterSeconds;
    const sending = step(setup, c, c.rate, seconds, first);
    // Awaited below; marked handled so a failure meanwhile is reported there, not as a crash.
    sending.catch(() => undefined);
    first += Math.round(c.rate * seconds);
    await setup.sinks.mllp.takeDown();
    await sleep(c.outageSeconds * 1000);
    const before = setup.sinks.mllp.received;
    const peak = queueDepth((await health(setup.project.healthPort)).body);
    const upAt = performance.now();
    await setup.sinks.mllp.bringUp();
    // The engine's first delivery on its new connection to the receiver, and a new connection from
    // a sender while the backlog drains.
    const [probe, deliveredMs] = await Promise.all([
      firstAck(setup.project.targets[0], first + 1_000_000),
      (async () => {
        while (setup.sinks.mllp.received === before) {
          if (performance.now() - upAt > DRAIN_LIMIT_MS) return null;
          await sleep(5);
        }
        return performance.now() - upAt;
      })(),
    ]);
    const drainMs = await drained(setup.project, DRAIN_LIMIT_MS, c.rate);
    const drainedAt = performance.now();
    const s = await sending;
    return {
      readyMs: setup.engine.readyMs,
      steps: [s],
      backlog: {
        peak: peak ?? null,
        receiverFirstDeliveryMs: deliveredMs,
        newConnectionFirstAckMs: probe,
        // From the receiver's return to a queue no deeper than one second of traffic.
        drainMs: drainMs === null ? null : drainedAt - upAt,
      },
      extra: extraOf(setup),
    };
  } finally {
    await setup.tearDown();
  }
}

async function startupRun(c, bin, run) {
  const setup = await setUp(c, bin, run);
  let restarted;
  try {
    await setup.sinks.mllp.takeDown();
    const fill = await step(setup, c, c.rate, c.fillSeconds, 0);
    const backlog = queueDepth((await health(setup.project.healthPort)).body) ?? null;
    const stopBegun = performance.now();
    await stopEngine(setup.engine.child);
    const stopMs = performance.now() - stopBegun;
    // Past every retry wait the outage set: the doubling wait after a fill of this length.
    await sleep((2 * c.fillSeconds + 5) * 1000);
    await setup.sinks.mllp.bringUp();
    const before = setup.sinks.mllp.received;
    const begun = performance.now();
    const probing = firstAck(setup.project.targets[0], fill.sent + 1_000_000);
    restarted = await startEngine(bin, setup.project, setup.env, DRAIN_LIMIT_MS);
    const firstAckMs = await probing;
    const drainMs = await drained(setup.project);
    const totalMs = performance.now() - begun;
    const delivered = setup.sinks.mllp.received - before;
    return {
      readyMs: restarted.readyMs,
      steps: [fill],
      startup: {
        backlog,
        stopMs,
        readyMs: restarted.readyMs,
        firstAckMs,
        drainMs: drainMs === null ? null : totalMs,
        delivered,
        deliveredPerSecond: drainMs === null ? null : delivered / (totalMs / 1000),
      },
      extra: extraOf(setup),
    };
  } finally {
    if (restarted !== undefined) setup.engine = restarted;
    await setup.tearDown();
  }
}

async function soakRun(c, bin, run, seconds) {
  const setup = await setUp(c, bin, run);
  try {
    const samples = sampler(setup.project, setup.engine.child.pid, 10_000);
    const result = await runSender({
      targets: setup.project.targets,
      rate: c.rate,
      seconds,
      first: 0,
      connections: 1,
    });
    await samples.stop();
    // The resident set after the first tenth of the run (at most 5 minutes), once the engine has
    // warmed up and SQLite's cache has filled, in MiB an hour.
    const settle = Math.min(300, seconds / 10);
    const settled = samples.resident.filter(([at]) => at >= settle);
    const mib = (bytes) => bytes / 1024 / 1024;
    const slope = theilSen(settled.map(([at, rss]) => [at / 3600, mib(rss)]));
    const queue = queueFlat(
      samples.queue.filter(([at]) => at <= seconds),
      c.rate,
    );
    return {
      readyMs: setup.engine.readyMs,
      steps: [{ rate: c.rate, seconds, ...result, queue: samples.queue }],
      soak: {
        seconds,
        residentMiB: {
          first: settled.length === 0 ? null : mib(settled[0][1]),
          last: settled.length === 0 ? null : mib(settled[settled.length - 1][1]),
          max: settled.length === 0 ? null : Math.max(...settled.map(([, rss]) => mib(rss))),
          slopePerHour: slope,
          samples: samples.resident.map(([at, rss]) => [
            Math.round(at),
            Math.round(mib(rss) * 10) / 10,
          ]),
        },
        queueGrowth: queue.growth,
        queueFlat: queue.flat,
      },
      extra: extraOf(setup),
    };
  } finally {
    await setup.tearDown();
  }
}

async function drainRun(c, bin) {
  const project = makeFileProject({
    format: "hl7v2",
    transform: TRANSFORMS.hl7Address,
    bodies: Array.from({ length: c.messages }, (_v, i) => adtMessage(i)),
    extension: "hl7",
  });
  const empty = makeFileProject({ format: "hl7v2", bodies: [], extension: "hl7" });
  try {
    const time = (p) => {
      const begun = performance.now();
      runPass(bin, p);
      return performance.now() - begun;
    };
    // The fixed cost of a pass (start, schema, worker), then the pass with every message.
    const emptyMs = time(empty);
    const passMs = time(project);
    return {
      steps: [],
      drain: {
        messages: c.messages,
        bytes: project.bytes,
        passMs,
        emptyMs,
        wholePassPerSecond: c.messages / (passMs / 1000),
        aboveEmptyPerSecond: passMs > emptyMs ? c.messages / ((passMs - emptyMs) / 1000) : null,
        disk: diskOf(project.root),
      },
    };
  } finally {
    removeFileProject(project);
    removeFileProject(empty);
  }
}

/** The conditions a reading of case `c` states. */
function conditionsOf(c, runs, commit, sample) {
  const first = runs.find((r) => r.steps?.length > 0)?.steps[0];
  const destinations =
    c.kind === "drain"
      ? "one file destination"
      : `${String(c.channels ?? 1)} channel(s), each to ${(c.destinations ?? ["mllp"])
          .map((d) =>
            d === "mllp" ? "an MLLP receiver" : d === "http" ? "an HTTP receiver" : "a folder",
          )
          .join(", ")} on this machine, without TLS`;
  const postgres = runs.find((r) => r.extra?.postgres)?.extra?.postgres;
  return {
    messageBytes:
      c.kind === "drain"
        ? Math.round(runs[0].drain.bytes / c.messages)
        : (first?.messageBytes ?? null),
    message: "a synthetic HL7 v2 ADT^A01 (bench/shapes.mjs), MSH-5 set in the channel's worker",
    destinations,
    storage:
      c.storage === "postgres"
        ? `PostgreSQL ${String(postgres)} in a service container on this runner, over loopback without TLS`
        : "SQLite, the project's file",
    disk:
      c.storage === "postgres"
        ? "the service container's file system on the runner's disk"
        : sample,
    encryption: "on: every body and error text encrypted at rest under a local key",
    tls:
      c.kind === "drain"
        ? "none: no network"
        : c.protocol === "mllp"
          ? "none: plaintext MLLP source"
          : `the ${c.protocol === "https" ? "HTTPS" : "MLLP"} source, TLS 1.2 or later with a P-256 certificate; destinations without TLS`,
    connections:
      c.kind === "drain"
        ? null
        : c.protocol === "https"
          ? `a keep-alive agent of ${String(c.connections)} sockets per source`
          : `${String(c.connections ?? 1)} connection(s) per source, as a feed sends`,
    engine:
      c.kind === "drain"
        ? "the built `pathways start --once` with the engine lease and the marker before each send on, fault points compiled out"
        : "the built `pathways start` with the engine lease and the marker before each send on, fault points compiled out",
    runner: null,
    node: process.version,
    commit,
  };
}

function fmt(n, digits = 1) {
  return n === null || n === undefined ? "n/a" : Number(n).toFixed(digits);
}

/** The reading's cases and its Markdown, from every run. */
function report(name, c, runs, commit, target) {
  const benchmark = `open loop: ${c.label}`;
  const cases = [];
  const lines = [`## Open-loop bench: ${c.label}`, ""];
  const sampleDisk = runs.find((r) => r.disk)?.disk ?? null;
  const conditions = conditionsOf(c, runs, commit, sampleDisk);
  const merged = latencyHistogram();
  runs.forEach((r, i) => {
    for (const s of r.steps ?? []) {
      merged.add(decodeHistogram(s.histogram));
      cases.push(
        caseReading({
          benchmark,
          size: `run ${String(i + 1)}, ${String(s.rate)} messages/s for ${String(s.seconds)} s`,
          messages: s.accepted,
          bytes: s.bytes,
          seconds: s.sendSeconds > 0 ? s.sendSeconds : s.seconds,
          latency: s.latency,
          openLoop: {
            run: i + 1,
            rate: s.rate,
            sent: s.sent,
            accepted: s.accepted,
            refused: s.refused,
            lost: s.lost,
            unanswered: s.unanswered,
            p999Ms: s.latency.p999Ms,
            senderBehindMs: s.senderBehindMs,
            queue: s.queue,
            judged: s.judged ?? null,
            drainMs: s.drainMs ?? null,
          },
        }),
      );
    }
  });

  if (c.kind === "ladder") {
    const capacities = runs.map((r) => r.capacity.rate);
    lines.push(
      `Capacity rule: the highest rate on the ladder (${LADDER.join(", ")} messages a second, ${String(STEP_SECONDS)} s each) at which every message is answered AA, the p99 from when a message was due to its ACK is at most ${String(CAPACITY_RULE.p99Ms)} ms, and the engine's queue grows by less than ${String(CAPACITY_RULE.flatSeconds)} s of traffic over the step.`,
      "",
      `Capacity by run: ${runs.map((r) => (r.capacity.rate === null ? "none" : `${r.capacity.atLeast ? "at least " : ""}${String(r.capacity.rate)}`)).join(", ")} messages a second; spread ${fmt(spread(capacities).min, 0)} to ${fmt(spread(capacities).max, 0)}, median ${fmt(spread(capacities).median, 0)}.`,
      "",
      "| run | rate /s | sent | p50 ms | p99 ms | p99.9 ms | max ms | queue growth | holds |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    runs.forEach((r, i) => {
      for (const s of r.steps) {
        lines.push(
          `| ${String(i + 1)} | ${String(s.rate)} | ${String(s.sent)} | ${fmt(s.latency.p50Ms, 2)} | ${fmt(s.latency.p99Ms, 2)} | ${fmt(s.latency.p999Ms, 2)} | ${fmt(s.latency.maxMs, 2)} | ${fmt(s.judged.queueGrowth, 0)} | ${s.judged.holds ? "yes" : `no: ${s.judged.reasons.join("; ")}`} |`,
        );
      }
    });
  }
  if (c.kind === "retry") {
    lines.push(
      `The MLLP receiver down for ${String(c.outageSeconds)} s while the sender sends ${String(c.rate)} messages a second, then up for ${String(c.afterSeconds)} s.`,
      "",
      "| run | backlog at the receiver's return | receiver's first delivery ms | new connection's first ACK ms | drained ms | p50 ms | p99 ms | p99.9 ms | max ms |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    runs.forEach((r, i) => {
      const s = r.steps[0];
      lines.push(
        `| ${String(i + 1)} | ${String(r.backlog.peak)} | ${fmt(r.backlog.receiverFirstDeliveryMs, 0)} | ${fmt(r.backlog.newConnectionFirstAckMs, 1)} | ${fmt(r.backlog.drainMs, 0)} | ${fmt(s.latency.p50Ms, 2)} | ${fmt(s.latency.p99Ms, 2)} | ${fmt(s.latency.p999Ms, 2)} | ${fmt(s.latency.maxMs, 2)} |`,
      );
    });
  }
  if (c.kind === "startup") {
    lines.push(
      `A backlog built by ${String(c.rate)} messages a second for ${String(c.fillSeconds)} s with the MLLP receiver down; the engine stopped with SIGTERM, the receiver brought back, and the engine started again.`,
      "",
      "| run | backlog | stop ms | health ms | first ACK on a new connection ms | drained ms | delivered /s |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    runs.forEach((r, i) => {
      const u = r.startup;
      lines.push(
        `| ${String(i + 1)} | ${String(u.backlog)} | ${fmt(u.stopMs, 0)} | ${fmt(u.readyMs, 0)} | ${fmt(u.firstAckMs, 1)} | ${fmt(u.drainMs, 0)} | ${fmt(u.deliveredPerSecond, 0)} |`,
      );
    });
  }
  if (c.kind === "soak") {
    lines.push(
      "| run | seconds | resident MiB first, last, max | slope MiB/h | queue flat | p50 ms | p99 ms | p99.9 ms | max ms |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    runs.forEach((r, i) => {
      const s = r.steps[0];
      const m = r.soak.residentMiB;
      lines.push(
        `| ${String(i + 1)} | ${String(r.soak.seconds)} | ${fmt(m.first)}, ${fmt(m.last)}, ${fmt(m.max)} | ${fmt(m.slopePerHour, 2)} | ${r.soak.queueFlat ? "yes" : "no"} | ${fmt(s.latency.p50Ms, 2)} | ${fmt(s.latency.p99Ms, 2)} | ${fmt(s.latency.p999Ms, 2)} | ${fmt(s.latency.maxMs, 2)} |`,
      );
    });
  }
  if (c.kind === "drain") {
    lines.push(
      `\`pathways start --once\` over ${String(c.messages)} messages already in a folder, file to file through SQLite, a fresh process each pass. Closed loop: the engine sets the pace.`,
      "",
      "| run | pass ms | empty pass ms | messages/s, whole pass | messages/s above an empty pass |",
      "| --- | --- | --- | --- | --- |",
    );
    runs.forEach((r, i) => {
      const d = r.drain;
      lines.push(
        `| ${String(i + 1)} | ${fmt(d.passMs, 0)} | ${fmt(d.emptyMs, 0)} | ${fmt(d.wholePassPerSecond, 0)} | ${fmt(d.aboveEmptyPerSecond, 0)} |`,
      );
      cases.push(
        caseReading({
          benchmark,
          size: `run ${String(i + 1)}, ${String(d.messages)} messages`,
          messages: d.messages,
          bytes: d.bytes,
          seconds: d.passMs / 1000,
          latency: { count: 0 },
          openLoop: { run: i + 1, ...d },
        }),
      );
    });
  }
  const all = percentiles(merged);
  if (all.count > 0) {
    lines.push(
      "",
      `Every message of every run together: p50 ${fmt(all.p50Ms, 2)} ms, p99 ${fmt(all.p99Ms, 2)} ms, p99.9 ${fmt(all.p999Ms, 2)} ms, max ${fmt(all.maxMs, 2)} ms over ${String(all.count)} messages.`,
    );
  }
  lines.push(
    "",
    `Conditions: ${Object.entries(conditions)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join("; ")}. Advisory: a hosted runner shares its machine.`,
    "",
  );
  const require = createRequire(import.meta.url);
  const toolVersion = JSON.parse(
    readFileSync(join(dirname(require.resolve("@cosyte/bench")), "..", "package.json"), "utf8"),
  ).version;
  const document = readingDocument({
    suiteName: `@cosyte/pathways open loop: ${name}`,
    suiteFile: relative(ROOT, fileURLToPath(import.meta.url)),
    target,
    commit,
    cases,
    conditions: { ...conditions, runner: null },
    bench: BENCH_CONTRACT,
    toolVersion,
  });
  document.conditions.runner = document.environment.runner.class;
  document.openLoop = {
    case: name,
    runs: runs.length,
    capacity: c.kind === "ladder" ? spread(runs.map((r) => r.capacity.rate)) : null,
    capacityAtLeast: c.kind === "ladder" ? runs.map((r) => r.capacity.atLeast) : null,
    backlog: runs.map((r) => r.backlog ?? null).filter((x) => x !== null),
    startup: runs.map((r) => r.startup ?? null).filter((x) => x !== null),
    soak: runs.map((r) => r.soak ?? null).filter((x) => x !== null),
    drain: runs.map((r) => r.drain ?? null).filter((x) => x !== null),
    readyMs: spread(runs.map((r) => r.readyMs ?? null)),
    allMessages: all,
  };
  return { document, markdown: lines.join("\n") };
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: "dist/index.mjs" },
      case: { type: "string" },
      runs: { type: "string", default: "5" },
      seconds: { type: "string" },
      commit: { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
    },
  });
  const name = values.case;
  const c = name === undefined ? undefined : CASES[name];
  if (c === undefined) {
    process.stderr.write(`usage: run.mjs --case <${Object.keys(CASES).join(" | ")}>\n`);
    process.exit(2);
  }
  const target = resolve(values.target);
  const bin = join(dirname(target), "bin", "pathways.mjs");
  const runsWanted = Number(values.runs);
  const runs = [];
  for (let run = 1; run <= runsWanted; run++) {
    process.stderr.write(`open-loop ${name}: run ${String(run)} of ${String(runsWanted)}\n`);
    let result;
    switch (c.kind) {
      case "ladder":
        result = await ladderRun(c, bin, run);
        break;
      case "retry":
        result = await retryRun(c, bin, run);
        break;
      case "startup":
        result = await startupRun(c, bin, run);
        break;
      case "soak":
        result = await soakRun(c, bin, run, Number(values.seconds ?? c.seconds));
        break;
      default:
        result = await drainRun(c, bin);
    }
    result.disk ??= diskOf(tmpdir());
    runs.push(result);
  }
  const commit = values.commit ?? null;
  const { document, markdown } = report(name, c, runs, commit, relative(ROOT, target));
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(document, null, 2)}\n`);
  if (values.summary !== undefined) writeFileSync(values.summary, markdown);
  process.stdout.write(`${markdown}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
