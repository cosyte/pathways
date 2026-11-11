// What the engine's own thread holds of a payload it only passes through: a text body read from a
// file, stored encrypted in SQLite, sent to the transform worker and back, stored again and
// written out. Each stage hands the body on or frees it once it is done, rather than copying it and
// leaving the copy for the collector. Memory is read as the bench's probe reads a pass
// (bench/probe.mjs), the external memory (Buffers and ArrayBuffers) of this thread just before each
// collection and at the end, and also as each step of the pass begins and ends: above what it held
// before the pass, after a full collection, over the payload's bytes. Garbage not yet collected
// counts, as it does in the process's memory.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GCProfiler, getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as S from "../bench/shapes.mjs";
import { loadProject } from "../src/config/load.js";
import { EncryptedStore } from "../src/encryption/encrypted-store.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanUp();
});

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

const external = (): number => getHeapStatistics().external_memory;

const CHANNEL = [
  "name: pass",
  "format: text",
  "source:",
  "  file: { dir: ../../data/in, minAge: 0 }",
  "destinations:",
  "  - file: { dir: ../../data/out }",
  "",
].join("\n");

describe("the engine thread's memory", () => {
  it(
    "holds a text payload it passes through at under 3 times its size",
    { timeout: 60_000 },
    async () => {
      const payload = S.textPayload(0, 4 * S.MIB);
      const root = await makeProject({
        "pathways.yaml": "",
        "channels/pass/channel.yaml": CHANNEL,
        "data/in/payload.txt": payload,
      });
      const project = await loadProject(root);
      const store = new EncryptedStore(
        await Store.open(project.databaseFile),
        new LocalKeyProvider([["k", randomBytes(KEY_BYTES)]], "k"),
      );
      const engine = new Engine({ project, store, logger: captureLogger().logger });
      let peak = 0;
      const sample = (): void => {
        peak = Math.max(peak, external());
      };
      // Each step of the pass is sampled as it begins and as it ends, the store kept the same object.
      for (const method of [
        "receive",
        "nextToTransform",
        "completeTransform",
        "nextDelivery",
        "markDelivered",
      ] as const) {
        const original = store[method].bind(store) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(store, method).mockImplementation((async (...args: unknown[]) => {
          sample();
          const result = await original(...args);
          sample();
          return result;
        }) as never);
      }
      let before: number;
      try {
        await engine.start();
        for (let i = 0; i < 3; i++) collect();
        before = external();
        peak = before;
        const profiler = new GCProfiler();
        profiler.start();
        await engine.tick();
        const { statistics } = profiler.stop();
        sample();
        for (const gc of statistics)
          peak = Math.max(peak, gc.beforeGC.heapStatistics.externalMemory);
      } finally {
        await engine.stop();
        await store.close();
      }
      const out = await readFile(join(root, "data", "out", "1-1.txt"), "utf8");
      expect(out === payload).toBe(true);
      const multiple = (peak - before) / Buffer.byteLength(payload);
      expect(multiple, `held ${multiple.toFixed(2)} times the payload`).toBeLessThan(3);
    },
  );
});
