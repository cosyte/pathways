// Loaded with `node --import` ahead of the `pathways` bin by bench/profile.mjs, to read what one
// whole engine pass held at its peak. It starts V8's GC profiler before the bin loads, and when the
// process exits it writes, to the file PATHWAYS_BENCH_PROBE_OUT names:
// - the peak V8 heap of the engine's own thread: the most in use just before any collection, or at
//   exit;
// - the peak external memory (Buffers, ArrayBuffers) of that thread, read the same way;
// - the peak resident set of the whole process, from the kernel: every thread, the transform worker
//   and SQLite's own memory among them;
// - how many collections ran.
// With PATHWAYS_BENCH_HEAP_OUT set instead, it samples every allocation of the engine's thread,
// collected or not, from before the bin loads to exit, and writes the sampled heap profile there:
// Node's own --heap-prof keeps only what is still alive at exit.
// The engine starts its worker with no Node options, so this runs in the engine's thread only. It
// reads sizes and places in the code, never a message.

import { writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { isMainThread } from "node:worker_threads";
import { getHeapStatistics, GCProfiler } from "node:v8";

const out = process.env["PATHWAYS_BENCH_PROBE_OUT"];
const heapOut = process.env["PATHWAYS_BENCH_HEAP_OUT"];

if (isMainThread && heapOut !== undefined) {
  // A session in this thread answers each call before `post` returns, so the profile is written
  // inside the exit handler.
  const session = new Session();
  session.connect();
  session.post("HeapProfiler.enable");
  session.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  process.on("exit", () => {
    session.post("HeapProfiler.stopSampling", (error, result) => {
      if (!error) writeFileSync(heapOut, JSON.stringify(result.profile));
    });
  });
}

if (isMainThread && out !== undefined) {
  const profiler = new GCProfiler();
  profiler.start();
  process.on("exit", () => {
    const { statistics } = profiler.stop();
    const end = getHeapStatistics();
    let peakHeapBytes = end.used_heap_size;
    let peakExternalBytes = end.external_memory;
    for (const gc of statistics) {
      peakHeapBytes = Math.max(peakHeapBytes, gc.beforeGC.heapStatistics.usedHeapSize);
      peakExternalBytes = Math.max(peakExternalBytes, gc.beforeGC.heapStatistics.externalMemory);
    }
    writeFileSync(
      out,
      JSON.stringify({
        peakHeapBytes,
        peakExternalBytes,
        peakResidentBytes: process.resourceUsage().maxRSS * 1024,
        collections: statistics.length,
      }),
    );
  });
}
