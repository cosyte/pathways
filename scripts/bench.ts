#!/usr/bin/env tsx
// Throughput of one channel, end to end: files in, the transform in its worker, storage, files out,
// measured with encryption at rest on (the default) and off. Synthetic messages only.
// Usage: pnpm bench [messages] [database], default 2000 through SQLite.
//
// database is sqlite (the default), postgres, mysql or sqlserver. A server is reached at the
// administrator's URL in PATHWAYS_BENCH_DATABASE_URL, the same form as the test URLs in CLAUDE.md;
// each run creates a database of its own there and drops it afterwards.
//
// It measures where the engine stands, so a change that slows it shows up; it is not a promise of
// what a deployment will see, which depends on disks, message sizes and transforms.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { pino } from "pino";

import { loadProject } from "../src/config/load.js";
import { STORAGE_KINDS, type StorageKind } from "../src/config/schema.js";
import type { Env } from "../src/connectors/endpoint.js";
import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { decodeKey, generateKey, LocalKeyProvider } from "../src/encryption/keys.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { closeAdmins, dropDatabases, freshDatabase, URL_ENV } from "../test/databases.js";

const count = Number(process.argv[2] ?? 2000);
const kind = (process.argv[3] ?? "sqlite") as StorageKind;
if (!STORAGE_KINDS.includes(kind)) {
  throw new Error(`database must be one of ${STORAGE_KINDS.join(", ")}`);
}
const message = (n: number): string =>
  [
    `MSH|^~\\&|SYNTH|TESTFAC|ADT|TESTFAC|20261107120000||ADT^A01^ADT_A01|MSG${String(n).padStart(8, "0")}|P|2.5.1`,
    "EVN|A01|20261107120000",
    `PID|1||TEST${String(n).padStart(6, "0")}^^^TESTFAC^MR||TESTPATIENT^ALPHA||19700101|U`,
    "PV1|1|I|WARD1^101^A",
  ].join("\r") + "\r";

/** One run: `count` messages through a fresh project, with encryption on or off. Seconds taken. */
async function measure(encrypted: boolean): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), "pathways-bench-"));
  try {
    let env: Env = {};
    if (kind !== "sqlite") {
      const database = { label: "bench", kind, urlEnv: "PATHWAYS_BENCH_DATABASE_URL" };
      env = (await freshDatabase(database)).env;
      await writeFile(
        join(root, "pathways.yaml"),
        `storage:\n  ${kind}:\n    url: { env: ${URL_ENV} }\n    plaintext: true\n`,
      );
    }
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
    const { storage } = project;
    if (storage.kind === "module")
      throw new Error("the bench runs on a database, not a custom store");
    const raw = await Store.open(storage, { env });
    const keys = new LocalKeyProvider([["bench", decodeKey(generateKey()) as Buffer]], "bench");
    const store = encrypted ? new EncryptedStore(raw, keys) : new UnencryptedStore(raw);
    const engine = new Engine({ project, store, logger: pino({ level: "silent" }) });
    await engine.start();

    const started = performance.now();
    await engine.tick();
    const seconds = (performance.now() - started) / 1000;

    await engine.stop();
    await store.close();
    const delivered = (await readdir(join(root, "data/out"))).length;
    if (delivered !== count) throw new Error(`delivered ${delivered} of ${count}`);
    return seconds;
  } finally {
    await dropDatabases();
    await rm(root, { recursive: true, force: true });
  }
}

try {
  for (const encrypted of [false, true]) {
    const seconds = await measure(encrypted);
    process.stdout.write(
      `${count} messages, file to file through ${kind}, encryption ${encrypted ? "on" : "off"}: ` +
        `${seconds.toFixed(2)} s, ${Math.round(count / seconds)} messages/s (Node ${process.version})\n`,
    );
  }
} finally {
  await closeAdmins();
}
