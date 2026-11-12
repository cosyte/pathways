// A real `pathways start` process told to stop with SIGTERM, then stopped hard at each step of its
// drain, as an orchestrator that runs out of patience, a power cut or an out-of-memory kill stops it:
// when it has just reported draining, once it has closed its sources, and once it has stopped but
// not released its lease. After a restart nothing is lost: every note reaches each destination, and
// at most one send is repeated, flagged as a possible duplicate (the one cut off mid-send). A
// second signal stops it at once, as it always has.
//
// Windows has no signals between processes (Node's `kill` there ends the process at once whatever
// signal it names), so these run on Linux and macOS only; test/engine-stop.test.ts says more.
import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { generateKey } from "../src/encryption/keys.js";
import { FAULT_POINT_ENV, FAULT_POINT_REACHED, type FaultPoint } from "../src/fault-points.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  leaseLapsed,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
  type TestStorage,
} from "./databases.js";
import { cleanUp, dropFile, makeProject } from "./helpers.js";

afterEach(async () => {
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const BIN = join(import.meta.dirname, "../src/bin/pathways.ts");
const windows = process.platform === "win32";

/**
 * A destination that takes 150 ms over each send, then appends what it was handed to
 * `options.log` as a JSON line: its name, the message's body and its resend flag.
 */
const SLOW_RECORDING_DESTINATION = `
import { appendFileSync } from "node:fs";
interface Outgoing { messageId: number; body: Uint8Array; resend?: { previousAttempts: number } }
export default (options: { log: string; name: string }) => ({
  async deliver(message: Outgoing): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const sent = { to: options.name, body: new TextDecoder().decode(message.body), resend: message.resend ?? null };
    appendFileSync(options.log, JSON.stringify(sent) + "\\n");
  },
});
`;

interface Sent {
  readonly to: string;
  readonly body: string;
  readonly resend: { readonly previousAttempts: number } | null;
}

const NOTES = 3;
const DESTINATIONS = ["a", "b"] as const;

interface Project {
  readonly root: string;
  readonly storage: TestStorage;
  readonly env: Record<string, string>;
  readonly sent: () => Promise<Sent[]>;
}

/** A project of one text channel to two slow recording destinations, stored on `database`. */
async function project(database: TestDatabase): Promise<Project> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "destination.ts": SLOW_RECORDING_DESTINATION,
    "channels/notes/transform.ts": "export default (text: string): string => text;\n",
  });
  const log = join(root, "sent.jsonl");
  const storage = await testStorage(database, join(root, ".pathways/pathways.db"));
  const block =
    storage.url === undefined
      ? ""
      : `storage:\n  ${database.kind}: { plaintext: true, pool: { max: 2 } }\n`;
  await writeFile(
    join(root, "pathways.yaml"),
    "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" +
      "lease:\n  ttl: 3s\ndefaults:\n  pollInterval: 20ms\n" +
      "drain: { notReadyDelay: 300ms, timeout: 10s }\n" +
      block,
  );
  // JSON's string is YAML's double-quoted one, so a Windows path keeps its backslashes.
  await writeFile(
    join(root, "channels/notes/channel.yaml"),
    "format: text\nsource:\n  file: { dir: ../../data/inbox, minAge: 0 }\n" +
      "transform: ./transform.ts\ndestinations:\n" +
      DESTINATIONS.map(
        (name) =>
          `  - module: ../../destination.ts\n` +
          `    options: { log: ${JSON.stringify(log)}, name: ${name} }\n`,
      ).join(""),
  );
  for (let i = 1; i <= NOTES; i += 1) {
    await dropFile(join(root, `data/inbox/note-${String(i)}.txt`), `synthetic note ${String(i)}`);
  }
  const sent = async (): Promise<Sent[]> =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Sent);
  return {
    root,
    storage,
    env: storage.url === undefined ? {} : { PATHWAYS_DATABASE_URL: storage.url },
    sent,
  };
}

interface Ended {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/** `pathways <args> -C root` in a process of its own, with `extra` in its environment. */
function launch(setup: Project, args: readonly string[], extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args, "-C", setup.root], {
    stdio: ["ignore", "ignore", "pipe"],
    // tsx's loader draws a deprecation warning from Node 26; nothing else may reach stderr.
    env: { ...process.env, ...setup.env, NODE_NO_WARNINGS: "1", ...extra },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<Ended>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, stderr })),
  );
  return { child, exited, stderr: () => stderr };
}

/** Waits until `check` holds, for at most `ms`; throws, naming `what`, when it does not. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Checks what a restart after the kill must leave: every note stored once and delivered to each
 * destination, nothing pending or failed, and at most one send repeated, flagged; then that a clean
 * restart sends nothing again.
 */
async function recovered(setup: Project): Promise<void> {
  const store = await setup.storage.open();
  try {
    expect(await store.messageCounts("notes")).toMatchObject({ received: 0, transformed: NOTES });
    expect(await store.deliveryCounts("notes")).toMatchObject({
      pending: 0,
      delivered: NOTES * DESTINATIONS.length,
      failed: 0,
    });
  } finally {
    await store.close();
  }
  const sent = await setup.sent();
  const notes = Array.from({ length: NOTES }, (_, i) => `synthetic note ${String(i + 1)}`);
  for (const to of DESTINATIONS) {
    expect([...new Set(sent.filter((s) => s.to === to).map((s) => s.body))].sort()).toEqual(notes);
  }
  expect(sent.filter((s) => s.resend !== null).length).toBeLessThanOrEqual(1);
  expect(sent.length).toBeLessThanOrEqual(NOTES * DESTINATIONS.length + 1);
  // Each repeat is flagged: a note sent twice to one destination was sent once unflagged at most.
  for (const to of DESTINATIONS) {
    for (const body of notes) {
      const copies = sent.filter((s) => s.to === to && s.body === body);
      expect(copies.filter((s) => s.resend === null).length).toBeLessThanOrEqual(1);
    }
  }
  const again = await launch(setup, ["start", "--once"]).exited;
  expect(again.code).toBe(0);
  expect(await setup.sent()).toEqual(sent);
}

const STEPS: readonly FaultPoint[] = [
  "drain-not-ready",
  "drain-sources-closed",
  "drain-before-release",
];

for (const database of TEST_DATABASES) {
  describe.skipIf(windows || !available(database))(
    `pathways start told to stop on ${database.label}, then killed`,
    () => {
      it.each(STEPS)(
        "at %s loses nothing, and repeats at most one send, flagged",
        async (step) => {
          const setup = await project(database);
          const engine = launch(setup, ["start"], { [FAULT_POINT_ENV]: step });
          try {
            await until(async () => (await setup.sent()).length >= 1, "the first send");
            engine.child.kill("SIGTERM");
            await until(() => engine.stderr().includes(`${FAULT_POINT_REACHED}${step}\n`), step);
          } finally {
            engine.child.kill("SIGKILL");
          }
          const killed = await engine.exited;
          expect(killed.signal).toBe("SIGKILL");
          await leaseLapsed(() => setup.storage.open());

          const restart = await launch(setup, ["start", "--once"]).exited;
          expect(restart.code).toBe(0);
          await recovered(setup);
          expect(await readdir(join(setup.root, "data/inbox/.claimed/notes"))).toEqual([]);
        },
        120_000,
      );
    },
  );
}

describe.skipIf(windows)("pathways start told to stop twice", () => {
  const sqlite = TEST_DATABASES.find((database) => database.kind === "sqlite");

  it("stops at once on the second signal, and the next start loses nothing", async () => {
    if (sqlite === undefined) throw new Error("the test databases have no SQLite");
    const setup = await project(sqlite);
    await writeFile(
      join(setup.root, "pathways.yaml"),
      (await readFile(join(setup.root, "pathways.yaml"), "utf8")).replace(
        "notReadyDelay: 300ms",
        "notReadyDelay: 10m",
      ),
    );
    const engine = launch(setup, ["start"]);
    try {
      await until(async () => (await setup.sent()).length >= 1, "the first send");
      engine.child.kill("SIGTERM");
      // Draining, it waits ten minutes before it closes its sources: the second signal ends that.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const told = Date.now();
      engine.child.kill("SIGTERM");
      const ended = await engine.exited;
      expect(ended.signal).toBe("SIGTERM");
      expect(Date.now() - told).toBeLessThan(5_000);
    } finally {
      engine.child.kill("SIGKILL");
    }
    await leaseLapsed(() => setup.storage.open());
    expect((await launch(setup, ["start", "--once"]).exited).code).toBe(0);
    await recovered(setup);
  }, 120_000);
});
