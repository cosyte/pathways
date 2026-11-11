// The fault points: a real `pathways` process stopped hard at a named step, as a power cut or an
// out-of-memory kill stops it, then started again. The child is started with
// PATHWAYS_TEST_FAULT_POINT naming the step; it says so on stderr and freezes there, with its
// connections and transactions open, and the test ends it with SIGKILL (TerminateProcess on
// Windows, which has no other way to end a process from outside; SIGTERM is never sent here). The
// database sees a dropped connection. After a restart no message is lost, each delivery is made at
// least once, and a clean restart after that sends nothing again.
//
// Each runs on SQLite and on each server whose URL is set; each test has a database of its own,
// and stops its own processes and closes its own stores before it ends.
import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { generateKey } from "../src/encryption/keys.js";
import {
  FAULT_POINT_ENV,
  FAULT_POINT_REACHED,
  FAULT_POINTS,
  faultPoints,
  type FaultPoint,
} from "../src/fault-points.js";
import type { Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  requiredServers,
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

describe("faultPoints", () => {
  it("is inert unless armed, and halts at the armed point's count-th call only", () => {
    const halted: FaultPoint[] = [];
    const halt = (point: FaultPoint): void => {
      halted.push(point);
    };
    for (const armed of [undefined, ""]) {
      const point = faultPoints(armed, halt);
      for (const name of FAULT_POINTS) point(name);
    }
    expect(halted).toEqual([]);

    const once = faultPoints("mid-requeue", halt);
    once("after-send-before-record");
    once("mid-requeue");
    once("mid-requeue");
    expect(halted).toEqual(["mid-requeue"]);

    const third = faultPoints("after-store-before-ack@3", halt);
    for (let i = 0; i < 5; i += 1) third("after-store-before-ack");
    expect(halted).toEqual(["mid-requeue", "after-store-before-ack"]);
  });

  it("refuses a value that names no point, so a typo cannot pass by never stopping", () => {
    const halt = (): void => undefined;
    for (const armed of ["after-send", "mid-requeue@0", "mid-requeue@x", "mid-requeue@1@2"]) {
      expect(() => faultPoints(armed, halt)).toThrow(`${FAULT_POINT_ENV} names no fault point`);
    }
  });
});

describe("The servers a run must reach", () => {
  it("are every server with PATHWAYS_TEST_ALL_DATABASES, or those PATHWAYS_TEST_DATABASES lists", () => {
    expect(requiredServers({})).toEqual([]);
    expect(requiredServers({ PATHWAYS_TEST_ALL_DATABASES: "1" })).toEqual([
      "postgres",
      "mysql",
      "mariadb",
      "sqlserver",
    ]);
    expect(requiredServers({ PATHWAYS_TEST_DATABASES: " mariadb, sqlserver ," })).toEqual([
      "mariadb",
      "sqlserver",
    ]);
    expect(() => requiredServers({ PATHWAYS_TEST_DATABASES: "postgress" })).toThrow(
      "PATHWAYS_TEST_DATABASES names postgress",
    );
  });

  it("fail the run when one has no URL, and the rest are skipped", () => {
    const [sqlite, postgres, mysql] = TEST_DATABASES as [TestDatabase, TestDatabase, TestDatabase];
    const env = { PATHWAYS_TEST_DATABASES: "postgres" };
    expect(available(sqlite, env)).toBe(true);
    expect(available(mysql, env)).toBe(false);
    expect(() => available(postgres, env)).toThrow(
      "postgres must run here, and PATHWAYS_TEST_POSTGRES_URL is not set",
    );
    expect(available(postgres, { ...env, PATHWAYS_TEST_POSTGRES_URL: "postgres://x/y" })).toBe(
      true,
    );
  });
});

/**
 * A destination that appends each message it is handed to `options.log`, as a JSON line of its
 * name, the message's id and body, and its resend flag.
 */
const RECORDING_DESTINATION = `
import { appendFileSync } from "node:fs";
interface Outgoing { messageId: number; body: Uint8Array; resend?: { previousAttempts: number } }
export default (options: { log: string; name: string }) => ({
  deliver(message: Outgoing): Promise<void> {
    const sent = { to: options.name, id: message.messageId, body: new TextDecoder().decode(message.body), resend: message.resend ?? null };
    appendFileSync(options.log, JSON.stringify(sent) + "\\n");
    return Promise.resolve();
  },
});
`;

/** What the recording destination was handed. */
interface Sent {
  readonly to: string;
  readonly id: number;
  readonly body: string;
  readonly resend: { readonly previousAttempts: number } | null;
}

/** How many notes each test sends through, and the two destinations each goes to. */
const NOTES = 3;
const DESTINATIONS = ["a", "b"] as const;

interface Project {
  readonly root: string;
  readonly storage: TestStorage;
  /** The environment a child reads its database URL from. */
  readonly env: Record<string, string>;
  readonly sent: () => Promise<Sent[]>;
}

/** A project with one text channel to two recording destinations, stored on `database`. */
async function project(database: TestDatabase): Promise<Project> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "destination.ts": RECORDING_DESTINATION,
    "channels/notes/transform.ts": "export default (text: string): string => text;\n",
  });
  const log = join(root, "sent.jsonl");
  const storage = await testStorage(database, join(root, ".pathways/pathways.db"));
  // JSON's string is YAML's double-quoted one, so a Windows path keeps its backslashes.
  const block =
    storage.url === undefined
      ? ""
      : `storage:\n  ${database.kind}: { plaintext: true, pool: { max: 2 } }\n`;
  await writeFile(
    join(root, "pathways.yaml"),
    "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" + block,
  );
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

/** Runs `pathways <args> -C root` to its end, as an operator does. */
function run(setup: Project, args: readonly string[]): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args, "-C", setup.root], {
      stdio: ["ignore", "ignore", "pipe"],
      // tsx's loader draws a deprecation warning from Node 26; nothing else may reach stderr.
      env: { ...process.env, ...setup.env, NODE_NO_WARNINGS: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

/**
 * Runs `pathways <args> -C root` with `armed` in PATHWAYS_TEST_FAULT_POINT, waits for it to reach
 * the point, and ends it there with SIGKILL. Rejects when it ends first, or takes over 30 seconds.
 */
async function killAt(setup: Project, args: readonly string[], armed: string): Promise<Ended> {
  const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args, "-C", setup.root], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...setup.env, NODE_NO_WARNINGS: "1", [FAULT_POINT_ENV]: armed },
  });
  let stderr = "";
  const exited = new Promise<Ended>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, stderr })),
  );
  const point = armed.split("@")[0] ?? armed;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the child did not reach ${point} in time`));
      }, 30_000);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes(`${FAULT_POINT_REACHED}${point}\n`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      void exited.then(({ code }) => {
        clearTimeout(timer);
        reject(new Error(`the child ended (${String(code)}) before ${point}: ${stderr}`));
      });
    });
  } finally {
    // A hard stop, on every system: SIGKILL on Linux and macOS, TerminateProcess on Windows.
    child.kill("SIGKILL");
  }
  return exited;
}

/**
 * Ends a run cleanly with exit code 0 and nothing on stderr, or fails the test. `plaintextWarnings`
 * is how many of the operator commands' warning that storage runs without TLS stderr must hold, and
 * nothing else: one for `pathways replay` on a test server, which runs without TLS; none otherwise
 * (`pathways start` logs it to stdout, and SQLite has no connection to warn about).
 */
async function cleanly(ended: Promise<Ended>, plaintextWarnings = 0): Promise<void> {
  const { code, signal, stderr } = await ended;
  const warning =
    /^\{"level":40,"time":\d+,"pid":\d+,"hostname":"[^"]*","event":"plaintext","endpoint":"storage"\}$/;
  const lines = stderr.split("\n").filter(Boolean);
  expect({
    code,
    signal,
    lines: lines.map((line) => (warning.test(line) ? "warning" : line)),
  }).toEqual({
    code: 0,
    signal: null,
    lines: Array.from({ length: plaintextWarnings }, () => "warning"),
  });
}

/** Opens the project's database in this process, hands it to `read`, and closes it. */
async function inStore<T>(setup: Project, read: (store: Store) => Promise<T>): Promise<T> {
  const store = await setup.storage.open();
  try {
    return await read(store);
  } finally {
    await store.close();
  }
}

/**
 * Checks what a restart after a crash must leave: every note stored once and delivered to each
 * destination, nothing pending or failed, the inbox empty, and each delivery made at least once and
 * at most once unflagged, besides the `resent` ones an operator queued again; then that a clean
 * restart sends nothing again. Notes are told apart by body: a crash can leave a gap in the ids.
 */
async function recovered(setup: Project, resent = 0): Promise<void> {
  await inStore(setup, async (store) => {
    expect(await store.messageCounts("notes")).toEqual({
      received: 0,
      transformed: NOTES,
      filtered: 0,
      failed: 0,
      cleared: 0,
    });
    expect(await store.deliveryCounts("notes")).toEqual({
      pending: 0,
      delivered: (NOTES + resent) * DESTINATIONS.length,
      failed: 0,
      cleared: 0,
    });
  });
  const inbox = join(setup.root, "data/inbox");
  expect((await readdir(inbox)).filter((name) => !name.startsWith("."))).toEqual([]);
  expect(await readdir(join(inbox, ".claimed/notes"))).toEqual([]);

  const sent = await setup.sent();
  const notes = Array.from({ length: NOTES }, (_, i) => `synthetic note ${String(i + 1)}`);
  for (const to of DESTINATIONS) {
    const copies = sent.filter((s) => s.to === to);
    expect([...new Set(copies.map((s) => s.body))].sort()).toEqual(notes);
    expect(new Set(copies.map((s) => s.id)).size).toBe(NOTES);
    const unflagged = copies.filter((s) => s.resend === null);
    expect(unflagged.length).toBe(NOTES + resent);
  }

  // A clean restart finds nothing left to do.
  await cleanly(run(setup, ["start", "--once"]));
  expect(await setup.sent()).toEqual(sent);
}

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(
    `A process killed at a fault point on ${database.label}`,
    () => {
      it("after-store-before-ack: the restart reads the file again and stores it once", async () => {
        const setup = await project(database);
        const killed = await killAt(setup, ["start", "--once"], "after-store-before-ack@2");
        expect(killed.code === 0 && killed.signal === null).toBe(false);
        await inStore(setup, async (store) => {
          expect((await store.messageCounts("notes")).received).toBe(2);
        });
        // Every file was claimed before the first was stored; the second is stored and its file not
        // yet deleted, and the third is not stored.
        expect(await readdir(join(setup.root, "data/inbox/.claimed/notes"))).toHaveLength(2);

        await cleanly(run(setup, ["start", "--once"]));
        // Each note once to each destination: nothing stored twice, nothing sent twice.
        expect(await setup.sent()).toHaveLength(NOTES * DESTINATIONS.length);
        await recovered(setup);
      }, 120_000);

      it("after-transform-before-complete: the restart transforms the message again", async () => {
        const setup = await project(database);
        const killed = await killAt(
          setup,
          ["start", "--once"],
          "after-transform-before-complete@2",
        );
        expect(killed.code === 0 && killed.signal === null).toBe(false);
        await inStore(setup, async (store) => {
          expect(await store.messageCounts("notes")).toMatchObject({ received: 2, transformed: 1 });
          expect(await store.deliveryCounts("notes")).toMatchObject({ pending: 2, delivered: 0 });
        });
        expect(await setup.sent()).toEqual([]);

        await cleanly(run(setup, ["start", "--once"]));
        expect(await setup.sent()).toHaveLength(NOTES * DESTINATIONS.length);
        await recovered(setup);
      }, 120_000);

      it("after-send-before-record: the restart sends that delivery once more, flagged", async () => {
        const setup = await project(database);
        const killed = await killAt(setup, ["start", "--once"], "after-send-before-record@2");
        expect(killed.code === 0 && killed.signal === null).toBe(false);
        expect((await setup.sent()).map((s) => [s.to, s.id])).toEqual([
          ["a", 1],
          ["a", 2],
        ]);
        await inStore(setup, async (store) => {
          expect(await store.deliveryCounts("notes")).toMatchObject({ pending: 5, delivered: 1 });
        });

        await cleanly(run(setup, ["start", "--once"]));
        const sent = await setup.sent();
        expect(sent.filter((s) => s.to === "a").map((s) => [s.id, s.resend])).toEqual([
          [1, null],
          [2, null],
          [2, { previousAttempts: 1 }],
          [3, null],
        ]);
        expect(sent.filter((s) => s.to === "b").map((s) => [s.id, s.resend])).toEqual([
          [1, null],
          [2, null],
          [3, null],
        ]);
        await recovered(setup);
      }, 120_000);

      it("mid-requeue: the resend is rolled back whole, and the next one is recorded once", async () => {
        const setup = await project(database);
        await cleanly(run(setup, ["start", "--once"]));
        expect(await setup.sent()).toHaveLength(NOTES * DESTINATIONS.length);

        const killed = await killAt(setup, ["replay", "2", "--resend"], "mid-requeue");
        expect(killed.code === 0 && killed.signal === null).toBe(false);
        // Nothing of the transaction is kept: no new deliveries, no new generation, no audit entry.
        await inStore(setup, async (store) => {
          expect(await store.message(2)).toMatchObject({ generation: 0, status: "transformed" });
          expect(await store.deliveries(2)).toHaveLength(DESTINATIONS.length);
          expect(await store.deliveryCounts("notes")).toMatchObject({ pending: 0 });
          expect((await store.auditEntries({ action: "resend", limit: 10 })).items).toEqual([]);
        });

        // On a server, the one line on stderr is the warning that storage runs without TLS.
        await cleanly(
          run(setup, ["replay", "2", "--resend"]),
          setup.storage.url === undefined ? 0 : 1,
        );
        await inStore(setup, async (store) => {
          expect(await store.message(2)).toMatchObject({ generation: 1 });
          const entries = (await store.auditEntries({ action: "resend", limit: 10 })).items;
          expect(entries.map((e) => [e.messageId, e.outcome])).toEqual([[2, "ok"]]);
        });
        await cleanly(run(setup, ["start", "--once"]));
        const resent = (await setup.sent()).slice(NOTES * DESTINATIONS.length);
        expect(resent.map((s) => [s.to, s.id, s.resend])).toEqual([
          ["a", 2, null],
          ["b", 2, null],
        ]);
        await recovered(setup, 1);
      }, 120_000);
    },
  );
}
