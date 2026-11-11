// The parts of the audit a reading cannot give, against the built package:
//   pnpm build && pnpm bench:profile [--out <dir>] [--quick]
//
// 1. Cold imports and process start: the built entry, the transform worker and the bin's start
//    (`pathways --version`), each in fresh processes against an empty one, with the gzip size of
//    each built file.
// 2. Engine passes (`pathways start --once`, bench/engine.mjs) on every channel and size of the
//    suite: the median time of 5 passes, the cost a message adds to the fixed cost of a pass, and the
//    memory of one pass read by bench/probe.mjs (the engine thread's peak heap and external memory,
//    and the whole process's peak resident set), each above the same channel's pass with no input,
//    over the input's bytes.
// 3. The transform path in process: what the channel's worker runs for each message (the built
//    `runTransform`: parse, transform, serialize) on every channel and size. Throughput from the
//    smallest size to the largest, allocations per message, and the peak heap and external memory
//    of one call over the message's bytes. A reading cannot time it, since it is asynchronous.
// 4. A long run for leaks on the transform path, on the message a feed sends all day.
// 5. A CPU profile and a sampled heap profile of the hottest paths, with the top functions of each,
//    named by their place in src/ through the build's source maps: the transform path on the dense
//    and opaque shapes in process, and the engine's own thread on a pass of 1,000 messages and on one
//    large opaque message, through Node's --cpu-prof and the allocation sampling of bench/probe.mjs.
// 6. The budgets, read from the numbers above.
//
// `--out <dir>` writes profile.md and profile.json there with every .cpuprofile and .heapprofile,
// for a profiler's own view. `--quick` leaves out every size over 1 MiB, for a developer machine;
// the reading of record is the one a GitHub-hosted runner takes. The inputs are the bench's own,
// from bench/shapes.mjs: synthetic, built in code, written to a temporary directory and removed.
//
// Run it with --expose-gc (the package script does): the memory sections settle the heap first.

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Session } from "node:inspector/promises";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GCProfiler } from "node:v8";
import { gzipSync } from "node:zlib";

import { makeProject, removeProject, runPass, TRANSFORMS } from "./engine.mjs";
import { bodiesOf, CHANNELS } from "./pathways.bench.mjs";
import {
  KIB,
  MIB,
  adtMessage,
  jsonRecords,
  oruDocument,
  oruMessage,
  textPayload,
} from "./shapes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PROBE = join(HERE, "probe.mjs");

const IMPORT_RUNS = 20;
const PASSES = 5;
const WARMUP_MS = 300;
const SAMPLES = 7;
const SAMPLE_MS = 100;
const PROFILE_MS = 2_000;
const TOP = 8;
const LONG_RUN_ROUNDS = 30;
const LONG_RUN_SETTLE = 6;
const LONG_RUN_ROUND_MS = 100;
const LONG_RUN_GROWTH_BYTES = 64 * KIB;

/** Proposed budgets: a dense shape's peak heap, an opaque payload's peak memory, a cold import, throughput kept. */
export const BUDGETS = {
  densePeakMultiple: 20,
  opaquePeakMultiple: 3,
  coldImportMs: 15,
  throughputKept: 0.5,
};

function args(argv) {
  const out = { target: argv[0] ?? "dist/index.mjs", dir: undefined, quick: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--out") out.dir = argv[++i];
    else if (argv[i] === "--quick") out.quick = true;
  }
  return out;
}

const size = (bytes) => {
  const abs = Math.abs(bytes);
  if (abs >= MIB) return `${(bytes / MIB).toFixed(2)} MiB`;
  if (abs >= KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${String(Math.round(bytes))} B`;
};
const ms = (value) => (value >= 100 ? `${value.toFixed(0)} ms` : `${value.toFixed(2)} ms`);
const times = (value) => (value === undefined ? "n/a" : `${value.toFixed(2)}x`);
const rate = (bytesPerSecond) => `${(bytesPerSecond / MIB).toFixed(2)} MiB/s`;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function settle() {
  for (let i = 0; i < 3; i++) globalThis.gc();
}

/* 1. Cold imports and process start ----------------------------------------------------------- */

const IMPORT_SNIPPET =
  "const t=performance.now();await import(process.argv[1]);process.stdout.write(String(performance.now()-t))";

function importMs(url) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", IMPORT_SNIPPET, url], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`the import of ${basename(url)} exited ${String(r.status)}`);
  return Number(r.stdout);
}

function wallMs(argv) {
  const start = performance.now();
  const r = spawnSync(process.execPath, argv, { stdio: ["ignore", "ignore", "ignore"] });
  if (r.status !== 0) throw new Error(`a timed process exited ${String(r.status)}`);
  return performance.now() - start;
}

function coldImports(dist, bin, worker) {
  const empty = pathToFileURL(join(HERE, "empty.mjs")).href;
  writeFileSync(fileURLToPath(empty), "export {};\n");
  const entries = [
    ["the package entry, dist/index.mjs", pathToFileURL(join(dist, "index.mjs")).href],
    ["the transform worker, dist/bin/pathways-worker.mjs", pathToFileURL(worker).href],
  ];
  const rows = [];
  try {
    for (const [label, url] of entries) {
      const runs = [];
      const base = [];
      for (let i = 0; i < IMPORT_RUNS; i++) {
        runs.push(importMs(url));
        base.push(importMs(empty));
      }
      rows.push({ label, ms: median(runs) - median(base) });
    }
    const start = [];
    const node = [];
    for (let i = 0; i < IMPORT_RUNS; i++) {
      start.push(wallMs([bin, "--version"]));
      node.push(wallMs(["-e", ""]));
    }
    rows.push({
      label: "the bin's start, `pathways --version`, over an empty Node process",
      ms: median(start) - median(node),
    });
  } finally {
    rmSync(fileURLToPath(empty), { force: true });
  }
  const files = ["index.mjs", "bin/pathways.mjs", "bin/pathways-worker.mjs"].map((file) => {
    const bytes = readFileSync(join(dist, file));
    return { file: `dist/${file}`, bytes: bytes.length, gzip: gzipSync(bytes).length };
  });
  return { rows, files };
}

/* 2. Engine passes ----------------------------------------------------------------------------- */

function probePass(bin, project) {
  const out = join(project.root, "probe.json");
  runPass(bin, project, {
    nodeArgs: ["--import", pathToFileURL(PROBE).href],
    env: { ...process.env, PATHWAYS_BENCH_PROBE_OUT: out },
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

function timePasses(bin, project) {
  runPass(bin, project);
  const runs = [];
  for (let i = 0; i < PASSES; i++) {
    const start = performance.now();
    runPass(bin, project);
    runs.push(performance.now() - start);
  }
  return median(runs);
}

function engineSection(bin, quick) {
  const rows = [];
  for (const channel of CHANNELS) {
    const empty = makeProject({ format: channel.format, transform: channel.transform, bodies: [] });
    let base;
    try {
      base = { ms: timePasses(bin, empty), memory: probePass(bin, empty) };
    } finally {
      removeProject(empty);
    }
    for (const s of channel.sizes) {
      if (s.count === 0) continue;
      const bodies = bodiesOf(s);
      const bytes = bodies.reduce((n, b) => n + Buffer.byteLength(b), 0);
      if (quick && bytes > MIB + 64 * KIB) continue;
      const project = makeProject({
        format: channel.format,
        transform: channel.transform,
        bodies,
        extension: channel.extension,
      });
      try {
        const passMs = timePasses(bin, project);
        const memory = probePass(bin, project);
        const over = (key) => (memory[key] - base.memory[key]) / bytes;
        rows.push({
          channel: channel.name,
          shape: channel.shape,
          size: s.label,
          count: s.count,
          bytes,
          passMs,
          emptyMs: base.ms,
          perMessageMs: (passMs - base.ms) / s.count,
          messagesPerSecond: (s.count * 1000) / Math.max(passMs - base.ms, 1e-3),
          bytesPerSecond: (bytes * 1000) / Math.max(passMs - base.ms, 1e-3),
          heapMultiple: over("peakHeapBytes"),
          externalMultiple: over("peakExternalBytes"),
          engineThreadMultiple:
            (memory.peakHeapBytes +
              memory.peakExternalBytes -
              base.memory.peakHeapBytes -
              base.memory.peakExternalBytes) /
            bytes,
          residentMultiple: over("peakResidentBytes"),
          memory,
          baseMemory: base.memory,
        });
      } finally {
        removeProject(project);
      }
    }
  }
  return rows;
}

/* 3. The transform path in process ------------------------------------------------------------ */

/** The channel's transform as the worker would load it from the TypeScript in bench/engine.mjs. */
function transformOf(channel) {
  if (channel.transform === TRANSFORMS.hl7Address) {
    return (msg) => {
      msg.setField("MSH.5", "LAB");
      return msg;
    };
  }
  return (message) => [message];
}

async function throughput(call) {
  const warmEnd = performance.now() + WARMUP_MS;
  let calls = 0;
  while (performance.now() < warmEnd || calls < 3) {
    await call();
    calls++;
  }
  const rates = [];
  for (let s = 0; s < SAMPLES; s++) {
    let n = 0;
    const start = performance.now();
    let elapsed = 0;
    do {
      await call();
      n++;
      elapsed = performance.now() - start;
    } while (elapsed < SAMPLE_MS);
    rates.push((n * 1000) / elapsed);
  }
  return median(rates);
}

/** The peak heap and external memory of one call above what was in use before it, and its allocations. */
async function peakOf(call) {
  settle();
  const before = process.memoryUsage();
  const profiler = new GCProfiler();
  profiler.start();
  const kept = await call();
  const { statistics } = profiler.stop();
  const end = process.memoryUsage();
  let heap = end.heapUsed;
  let external = end.external;
  let reclaimed = 0;
  for (const gc of statistics) {
    heap = Math.max(heap, gc.beforeGC.heapStatistics.usedHeapSize);
    external = Math.max(external, gc.beforeGC.heapStatistics.externalMemory);
    reclaimed += gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize;
  }
  void kept;
  return {
    heap: heap - before.heapUsed,
    external: external - before.external,
    allocated: end.heapUsed - before.heapUsed + reclaimed,
  };
}

async function transformSection(worker, quick) {
  const rows = [];
  for (const channel of CHANNELS) {
    const transform = transformOf(channel);
    await worker.loadFormat(channel.format);
    // One message a call: a size that is many messages in a row is the engine's to measure.
    for (const s of channel.sizes) {
      if (s.count !== 1) continue;
      const body = new Uint8Array(Buffer.from(s.build(0)));
      if (quick && body.byteLength > MIB + 64 * KIB) continue;
      const call = () => worker.runTransform(transform, channel.format, body);
      const perSecond = await throughput(call);
      const peak = await peakOf(call);
      // Allocations per call over a run of calls, which averages out one call's collection timing.
      const runs = Math.max(1, Math.min(200, Math.round((4 * MIB) / body.byteLength)));
      const many = await peakOf(async () => {
        for (let i = 0; i < runs; i++) await call();
      });
      rows.push({
        channel: channel.name,
        shape: channel.shape,
        size: s.label,
        bytes: body.byteLength,
        callsPerSecond: perSecond,
        bytesPerSecond: perSecond * body.byteLength,
        latencyMs: 1000 / perSecond,
        heapMultiple: peak.heap / body.byteLength,
        externalMultiple: peak.external / body.byteLength,
        totalMultiple: (peak.heap + peak.external) / body.byteLength,
        allocatedPerCall: many.allocated / runs,
      });
    }
  }
  return rows;
}

/* 4. A long run for leaks ---------------------------------------------------------------------- */

function theilSen(ys) {
  const slopes = [];
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) slopes.push((ys[j] - ys[i]) / (j - i));
  }
  return median(slopes);
}

async function longRun(worker) {
  await worker.loadFormat("hl7v2");
  const transform = transformOf(CHANNELS[0]);
  const body = new Uint8Array(Buffer.from(adtMessage(0)));
  const heaps = [];
  let calls = 0;
  for (let round = 0; round < LONG_RUN_ROUNDS; round++) {
    const end = performance.now() + LONG_RUN_ROUND_MS;
    while (performance.now() < end) {
      await worker.runTransform(transform, "hl7v2", body);
      calls++;
    }
    settle();
    heaps.push(process.memoryUsage().heapUsed);
  }
  const fitted = heaps.slice(LONG_RUN_SETTLE);
  const slope = theilSen(fitted);
  const growth = slope * (fitted.length - 1);
  return {
    calls,
    rounds: LONG_RUN_ROUNDS,
    growthBytes: growth,
    perCallBytes: growth / ((calls * fitted.length) / LONG_RUN_ROUNDS),
    growing: growth >= LONG_RUN_GROWTH_BYTES,
  };
}

/* 5. CPU and heap profiles --------------------------------------------------------------------- */

const maps = new Map();

/** Where a frame of the built code came from in src/, through its source map; else the package. */
function placeOf(url, line, column) {
  if (url === "" || url.startsWith("node:")) return url === "" ? "(native)" : url;
  if (!url.startsWith("file:")) return url;
  const file = fileURLToPath(url);
  const pkg = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(file);
  if (pkg !== null) return `${pkg[1]} (${basename(file)}:${String(line + 1)})`;
  if (!file.includes(`${ROOT}/dist/`) && !file.startsWith(join(ROOT, "dist"))) {
    return `${relative(ROOT, file)}:${String(line + 1)}`;
  }
  let map = maps.get(file);
  if (map === undefined) {
    try {
      map = new SourceMap(JSON.parse(readFileSync(`${file}.map`, "utf8")));
    } catch {
      map = null;
    }
    maps.set(file, map);
  }
  const entry = map?.findEntry(line, column);
  if (entry === undefined || entry === null || entry.originalSource === undefined) {
    return `${relative(ROOT, file)}:${String(line + 1)}`;
  }
  const source = entry.originalSource.replace(/^.*?(src\/)/, "$1").replace(/^.*node_modules\//, "");
  return `${source}:${String(entry.originalLine + 1)}`;
}

/**
 * The functions with the most self time, as shares of the time the thread was busy: an engine pass
 * spends much of its time waiting on the disk, which the profile records as idle.
 */
function topCpu(profile) {
  const total = profile.endTime - profile.startTime;
  const count = (name) =>
    profile.nodes
      .filter((node) => node.callFrame.functionName === name)
      .reduce((n, node) => n + (node.hitCount ?? 0), 0);
  const all = profile.nodes.reduce((n, node) => n + (node.hitCount ?? 0), 0) || 1;
  const idle = count("(idle)");
  const hits = Math.max(all - idle, 1);
  const byPlace = new Map();
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    const name = functionName === "" ? "(anonymous)" : functionName;
    const key = `${name} ${placeOf(url, lineNumber, columnNumber)}`;
    byPlace.set(key, (byPlace.get(key) ?? 0) + (node.hitCount ?? 0));
  }
  return [...byPlace.entries()]
    .filter(([key]) => !/^\((idle|program|garbage collector)\)/.test(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([where, n]) => ({ where, share: n / hits, ms: (n / all) * (total / 1000) }))
    .concat([
      {
        where: "(garbage collector)",
        share: count("(garbage collector)") / hits,
        ms: (count("(garbage collector)") / all) * (total / 1000),
      },
      {
        where: "(idle: waiting on the disk, the worker or a timer; a share of the whole profile)",
        share: idle / all,
        ms: (idle / all) * (total / 1000),
      },
    ]);
}

function topHeap(profile) {
  const byPlace = new Map();
  const walk = (node) => {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    const name = functionName === "" ? "(anonymous)" : functionName;
    const key = `${name} ${placeOf(url, lineNumber, columnNumber)}`;
    byPlace.set(key, (byPlace.get(key) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) walk(child);
  };
  walk(profile.head);
  const total = [...byPlace.values()].reduce((a, b) => a + b, 0) || 1;
  return [...byPlace.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([where, bytes]) => ({ where, bytes, share: bytes / total }));
}

async function profileInProcess(session, label, call, dir) {
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 100 });
  await session.post("HeapProfiler.enable");
  // Every allocation sampled, collected or not: what a call allocates, not what it leaves behind.
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await session.post("Profiler.start");
  const end = performance.now() + PROFILE_MS;
  let calls = 0;
  while (performance.now() < end || calls < 2) {
    await call();
    calls++;
  }
  const { profile } = await session.post("Profiler.stop");
  const { profile: heap } = await session.post("HeapProfiler.stopSampling");
  await session.post("Profiler.disable");
  await session.post("HeapProfiler.disable");
  if (dir !== undefined) {
    const name = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    writeFileSync(join(dir, `${name}.cpuprofile`), JSON.stringify(profile));
    writeFileSync(join(dir, `${name}.heapprofile`), JSON.stringify(heap));
  }
  return { label, calls, cpu: topCpu(profile), heap: topHeap(heap) };
}

/**
 * One pass under Node's CPU profiler, with bench/probe.mjs sampling every allocation of the engine's
 * thread, collected or not. The worker's own work is profiled in process above.
 */
function profileEngine(bin, label, project, dir) {
  const where = mkdtempSync(join(tmpdir(), "pathways-prof-"));
  try {
    const heapFile = join(where, "engine.heapprofile");
    runPass(bin, project, {
      nodeArgs: [
        "--import",
        pathToFileURL(PROBE).href,
        "--cpu-prof",
        "--cpu-prof-dir",
        where,
        "--cpu-prof-interval",
        "200",
      ],
      env: { ...process.env, PATHWAYS_BENCH_HEAP_OUT: heapFile },
    });
    const cpuFile = readdirSync(where).find((f) => f.endsWith(".cpuprofile"));
    if (cpuFile === undefined) throw new Error("no CPU profile was written");
    const cpu = JSON.parse(readFileSync(join(where, cpuFile), "utf8"));
    const heap = JSON.parse(readFileSync(heapFile, "utf8"));
    if (dir !== undefined) {
      const name = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      renameSync(join(where, cpuFile), join(dir, `${name}.cpuprofile`));
      renameSync(heapFile, join(dir, `${name}.heapprofile`));
    }
    return { label, calls: 1, cpu: topCpu(cpu), heap: topHeap(heap) };
  } finally {
    rmSync(where, { recursive: true, force: true });
  }
}

async function profileSection(bin, worker, quick, dir) {
  const large = quick ? MIB : 8 * MIB;
  const session = new Session();
  session.connect();
  const out = [];
  try {
    await worker.loadFormat("hl7v2");
    const hl7 = transformOf(CHANNELS[0]);
    const pass = (m) => [m];
    const cases = [
      ["transform path: HL7 v2 ADT^A01", "hl7v2", hl7, adtMessage(0)],
      [`transform path: HL7 v2 ORU^R01, ${size(large)}`, "hl7v2", hl7, oruMessage(0, large)],
      [
        `transform path: HL7 v2 ORU^R01 with a base64 document, ${size(large)}`,
        "hl7v2",
        hl7,
        oruDocument(0, large),
      ],
      [`transform path: JSON lab records, ${size(large)}`, "json", pass, jsonRecords(0, large)],
    ];
    for (const [label, format, transform, text] of cases) {
      const body = new Uint8Array(Buffer.from(text));
      out.push(
        await profileInProcess(
          session,
          label,
          () => worker.runTransform(transform, format, body),
          dir,
        ),
      );
    }
  } finally {
    session.disconnect();
  }
  const engineCases = [
    [
      "engine thread: 1,000 HL7 v2 ADT^A01 messages",
      {
        format: "hl7v2",
        transform: TRANSFORMS.hl7Address,
        bodies: Array.from({ length: 1_000 }, (_v, i) => adtMessage(i)),
      },
    ],
    [
      `engine thread: one ${size(large)} text payload`,
      { format: "text", transform: undefined, bodies: [textPayload(0, large)] },
    ],
  ];
  for (const [label, spec] of engineCases) {
    const project = makeProject(spec);
    try {
      out.push(profileEngine(bin, label, project, dir));
    } finally {
      removeProject(project);
    }
  }
  return out;
}

/* 6. Budgets ----------------------------------------------------------------------------------- */

/** The heaviest row by `key`, or undefined when there is none. */
function worstBy(rows, key) {
  return rows.reduce((a, b) => (a === undefined || b[key] > a[key] ? b : a), undefined);
}

/**
 * The budgets, read from the sections above. Memory is read on inputs of 1 MiB and more only: below
 * that, what a call or a pass holds whatever its input (a parser's tables, a database's pages)
 * swamps the input's own bytes, and the multiple says nothing about the input. Throughput kept is
 * read by bytes from the smallest such input to the largest, and by messages from a pass of 100 in a
 * row to the longest, past the fixed cost of a pass, which a single message cannot be told from.
 */
function budgets({ imports, engine, transform }) {
  const lines = [];
  const entry = imports.rows[0];
  lines.push({
    budget: `cold import of the package entry under ${String(BUDGETS.coldImportMs)} ms`,
    worst: `${ms(entry.ms)}`,
    within: entry.ms < BUDGETS.coldImportMs,
  });
  const worker = imports.rows[1];
  lines.push({
    budget: `cold import of the transform worker under ${String(BUDGETS.coldImportMs)} ms`,
    worst: `${ms(worker.ms)}`,
    within: worker.ms < BUDGETS.coldImportMs,
  });
  for (const [shape, limit] of [
    ["dense", BUDGETS.densePeakMultiple],
    ["opaque", BUDGETS.opaquePeakMultiple],
  ]) {
    const large = (rows) => rows.filter((r) => r.shape === shape && r.bytes >= MIB);
    const checks = [
      ["transform path peak heap and external", large(transform), "totalMultiple"],
      ["engine thread peak heap and external", large(engine), "engineThreadMultiple"],
      ["whole process peak resident set", large(engine), "residentMultiple"],
    ];
    for (const [what, rows, key] of checks) {
      const worst = worstBy(rows, key);
      if (worst === undefined) continue;
      lines.push({
        budget: `${what} under ${String(limit)}x input (${shape}, 1 MiB and more)`,
        worst: `${times(worst[key])} on ${worst.channel}, ${worst.size}`,
        within: worst[key] < limit,
      });
    }
  }
  for (const channel of CHANNELS) {
    const t = transform.filter((r) => r.channel === channel.name && r.bytes >= MIB / 16);
    if (t.length >= 2) {
      const first = t[0];
      const last = t[t.length - 1];
      const kept = last.bytesPerSecond / first.bytesPerSecond;
      lines.push({
        budget: `transform path throughput kept, ${channel.name}, ${first.size} to ${last.size}, at least ${String(BUDGETS.throughputKept)}`,
        worst: `${kept.toFixed(2)} (${rate(first.bytesPerSecond)} to ${rate(last.bytesPerSecond)})`,
        within: kept >= BUDGETS.throughputKept,
      });
    }
    const byCount = engine.filter((r) => r.channel === channel.name && r.count >= 100);
    if (byCount.length >= 2) {
      const first = byCount[0];
      const last = byCount[byCount.length - 1];
      const kept = last.messagesPerSecond / first.messagesPerSecond;
      lines.push({
        budget: `engine throughput kept, ${channel.name}, ${first.size} to ${last.size}, at least ${String(BUDGETS.throughputKept)}`,
        worst: `${kept.toFixed(2)} (${first.messagesPerSecond.toFixed(0)} to ${last.messagesPerSecond.toFixed(0)} messages/s past the fixed cost)`,
        within: kept >= BUDGETS.throughputKept,
      });
    }
    const bySize = engine.filter(
      (r) => r.channel === channel.name && r.count === 1 && r.bytes >= MIB,
    );
    if (bySize.length >= 2) {
      const first = bySize[0];
      const last = bySize[bySize.length - 1];
      const kept = last.bytesPerSecond / first.bytesPerSecond;
      lines.push({
        budget: `engine throughput kept, ${channel.name}, ${first.size} to ${last.size}, at least ${String(BUDGETS.throughputKept)}`,
        worst: `${kept.toFixed(2)} (${rate(first.bytesPerSecond)} to ${rate(last.bytesPerSecond)} past the fixed cost)`,
        within: kept >= BUDGETS.throughputKept,
      });
    }
  }
  return lines;
}

/* Report --------------------------------------------------------------------------------------- */

function markdown(result) {
  const out = [];
  out.push(`### Pathways profile (Node ${process.version}, ${result.cpu})`, "");
  out.push("#### Budgets", "", "| budget | worst | within |", "| --- | --- | --- |");
  for (const b of result.budgets)
    out.push(`| ${b.budget} | ${b.worst} | ${b.within ? "yes" : "**no**"} |`);
  out.push(
    "",
    "#### Cold import and process start",
    "",
    "| what | median above an empty process |",
    "| --- | --- |",
  );
  for (const r of result.imports.rows) out.push(`| ${r.label} | ${ms(r.ms)} |`);
  out.push("", "| built file | bytes | gzip |", "| --- | --- | --- |");
  for (const f of result.imports.files)
    out.push(`| ${f.file} | ${size(f.bytes)} | ${size(f.gzip)} |`);
  out.push(
    "",
    "#### Engine passes (`pathways start --once`, file to file, SQLite, encrypted)",
    "",
    "Median of 5 passes. Per message and throughput are past the fixed cost of the same channel's pass with no input. Memory is the peak of one pass above that empty pass, over the input's bytes: heap and external of the engine's thread, and the resident set of the whole process (every thread).",
    "",
    "| channel | size | input | pass | empty pass | per message | messages/s | engine thread heap+external | resident set |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of result.engine) {
    out.push(
      `| ${r.channel} | ${r.size} | ${size(r.bytes)} | ${ms(r.passMs)} | ${ms(r.emptyMs)} | ${ms(r.perMessageMs)} | ${r.messagesPerSecond.toFixed(0)} | ${times(r.engineThreadMultiple)} | ${times(r.residentMultiple)} |`,
    );
  }
  out.push(
    "",
    "#### Transform path in process (the worker's parse, transform, serialize)",
    "",
    "| channel | size | input | calls/s | throughput | mean latency | allocated per call | peak heap | peak external | peak total |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of result.transform) {
    out.push(
      `| ${r.channel} | ${r.size} | ${size(r.bytes)} | ${r.callsPerSecond.toFixed(1)} | ${rate(r.bytesPerSecond)} | ${ms(r.latencyMs)} | ${size(r.allocatedPerCall)} | ${times(r.heapMultiple)} | ${times(r.externalMultiple)} | ${times(r.totalMultiple)} |`,
    );
  }
  const l = result.longRun;
  out.push(
    "",
    "#### Long run, transform path, HL7 v2 ADT^A01",
    "",
    `${String(l.calls)} calls over ${String(l.rounds)} rounds; fitted heap growth over the last ${String(l.rounds - LONG_RUN_SETTLE)} rounds ${size(l.growthBytes)} (${l.growing ? "**growing**" : "flat"}, the line is ${size(LONG_RUN_GROWTH_BYTES)}).`,
  );
  for (const p of result.profiles) {
    out.push("", `#### Profile: ${p.label}`, "", "| CPU, self time | share |", "| --- | --- |");
    for (const c of p.cpu) out.push(`| ${c.where} | ${(c.share * 100).toFixed(1)}% |`);
    out.push("", "| allocations, sampled | bytes | share |", "| --- | --- | --- |");
    for (const h of p.heap)
      out.push(`| ${h.where} | ${size(h.bytes)} | ${(h.share * 100).toFixed(1)}% |`);
  }
  return out.join("\n") + "\n";
}

async function main() {
  if (typeof globalThis.gc !== "function") throw new Error("run with --expose-gc");
  const opts = args(process.argv.slice(2));
  const entry = resolve(opts.target);
  const dist = dirname(entry);
  const bin = join(dist, "bin", "pathways.mjs");
  const workerFile = join(dist, "bin", "pathways-worker.mjs");
  if (opts.dir !== undefined) mkdirSync(opts.dir, { recursive: true });
  const step = (text) => process.stderr.write(`profile: ${text}\n`);

  step("cold imports");
  const imports = coldImports(dist, bin, workerFile);
  const worker = await import(pathToFileURL(workerFile).href);
  step("transform path");
  const transform = await transformSection(worker, opts.quick);
  step("long run");
  const longRunResult = await longRun(worker);
  step("engine passes");
  const engine = engineSection(bin, opts.quick);
  step("profiles");
  const profiles = await profileSection(bin, worker, opts.quick, opts.dir);
  const { cpus } = await import("node:os");
  const result = {
    node: process.version,
    cpu: cpus()[0]?.model ?? "unknown CPU",
    quick: opts.quick,
    imports,
    engine,
    transform,
    longRun: longRunResult,
    profiles,
  };
  result.budgets = budgets(result);
  const md = markdown(result);
  if (opts.dir !== undefined) {
    writeFileSync(join(opts.dir, "profile.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(opts.dir, "profile.md"), md);
  }
  process.stdout.write(md);
}

await main();
