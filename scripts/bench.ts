#!/usr/bin/env tsx
// Throughput of one channel, end to end: files in, the transform in its worker, SQLite, files out.
// Synthetic messages only. Usage: pnpm bench [messages], default 2000.
//
// It measures where the engine stands, so a change that slows it shows up; it is not a promise of
// what a deployment will see, which depends on disks, message sizes and transforms.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { pino } from "pino";

import { loadProject } from "../src/config/load.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";

const count = Number(process.argv[2] ?? 2000);
const message = (n: number): string =>
  [
    `MSH|^~\\&|SYNTH|TESTFAC|ADT|TESTFAC|20261107120000||ADT^A01^ADT_A01|MSG${String(n).padStart(8, "0")}|P|2.5.1`,
    "EVN|A01|20261107120000",
    `PID|1||TEST${String(n).padStart(6, "0")}^^^TESTFAC^MR||TESTPATIENT^ALPHA||19700101|U`,
    "PV1|1|I|WARD1^101^A",
  ].join("\r") + "\r";

const root = await mkdtemp(join(tmpdir(), "pathways-bench-"));
try {
  await mkdir(join(root, "channels/adt"), { recursive: true });
  await writeFile(
    join(root, "channels/adt/channel.yaml"),
    "source:\n  file: { dir: ../../data/in, minAge: 0 }\ntransform: ./transform.ts\ndestinations:\n  - file: { dir: ../../data/out }\n",
  );
  await writeFile(
    join(root, "channels/adt/transform.ts"),
    "export default (msg: { setField(p: string, v: string): void }) => { msg.setField('MSH.5', 'LAB'); return msg; };\n",
  );
  await mkdir(join(root, "data/in"), { recursive: true });
  for (let n = 0; n < count; n += 1)
    await writeFile(join(root, "data/in", `${String(n).padStart(8, "0")}.hl7`), message(n));

  const project = await loadProject(root);
  const store = await Store.open(project.databaseFile);
  const engine = new Engine({ project, store, logger: pino({ level: "silent" }) });
  await engine.start();

  const started = performance.now();
  await engine.tick();
  const seconds = (performance.now() - started) / 1000;

  await engine.stop();
  await store.close();
  const delivered = (await readdir(join(root, "data/out"))).length;
  if (delivered !== count) throw new Error(`delivered ${delivered} of ${count}`);
  process.stdout.write(
    `${count} messages, file to file through SQLite: ${seconds.toFixed(2)} s, ${Math.round(count / seconds)} messages/s ` +
      `(Node ${process.version})\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
