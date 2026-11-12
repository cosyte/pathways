// Node identity and heartbeat between real `pathways` processes, on SQLite and on each server whose
// URL is set: the running engine listed by `pathways nodes`, and on a server its standby too, each
// from the other's project, their wall clocks four hours apart; and an engine killed hard shown
// stale within the bound the docs state, then forgotten. A hard stop is SIGKILL (TerminateProcess
// on Windows).
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { generateKey } from "../src/encryption/keys.js";
import type { NodeRow, Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
  type TestStorage,
} from "./databases.js";
import { cleanUp, makeProject } from "./helpers.js";

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const BIN = join(import.meta.dirname, "../src/bin/pathways.ts");

/** Loaded before the engine with --import: moves this process's wall clock by PATHWAYS_SKEW_MS. */
const SKEWED_CLOCK = `
const offset = Number(process.env.PATHWAYS_SKEW_MS ?? "0");
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
class SkewedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(realNow() + offset);
    else super(...args);
  }
  static now() {
    return realNow() + offset;
  }
}
globalThis.Date = SkewedDate;
`;

/** The heartbeat these tests run with, and the stale bound it gives: three of them. */
const HEARTBEAT_MS = 1_000;
const BOUND_MS = 3 * HEARTBEAT_MS;

interface Project {
  readonly root: string;
  readonly storage: TestStorage;
  readonly env: Record<string, string>;
}

/** A project with one idle channel and a 1s heartbeat; on `shared`'s database and key when given. */
async function project(database: TestDatabase, shared?: Project): Promise<Project> {
  const key =
    shared === undefined
      ? `${generateKey()}\n`
      : await readFile(join(shared.root, "test.key"), "utf8");
  const root = await makeProject({
    "test.key": key,
    "skew.mjs": SKEWED_CLOCK,
    "channels/notes/channel.yaml":
      "format: text\nsource:\n  file: { dir: ../../data/inbox, minAge: 0 }\ndestinations:\n  - file: { dir: ../../data/out }\n",
  });
  const storage =
    shared?.storage ?? (await testStorage(database, join(root, ".pathways/pathways.db")));
  const block =
    storage.url === undefined
      ? ""
      : `storage:\n  ${database.kind}: { plaintext: true, pool: { max: 2 } }\n`;
  await writeFile(
    join(root, "pathways.yaml"),
    "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" +
      `defaults:\n  pollInterval: 50ms\nlease:\n  ttl: 3s\nnode:\n  heartbeat: ${String(HEARTBEAT_MS)}\n` +
      block,
  );
  return {
    root,
    storage,
    env: storage.url === undefined ? {} : { PATHWAYS_DATABASE_URL: storage.url },
  };
}

interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

/** `pathways <args> -C root` in a process of its own, its wall clock moved by `skewMs`. */
function start(setup: Project, args: readonly string[], skewMs?: number): Running {
  const skew =
    skewMs === undefined ? [] : ["--import", pathToFileURL(join(setup.root, "skew.mjs")).href];
  const child = spawn(
    process.execPath,
    ["--import", "tsx", ...skew, BIN, ...args, "-C", setup.root],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...setup.env,
        NODE_NO_WARNINGS: "1",
        ...(skewMs === undefined ? {} : { PATHWAYS_SKEW_MS: String(skewMs) }),
      },
    },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

/** Runs `pathways <args>` to its end. */
async function finish(
  setup: Project,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const running = start(setup, args);
  const { code } = await running.exited;
  return { code, stdout: running.stdout(), stderr: running.stderr() };
}

async function inStore<T>(setup: Project, read: (store: Store) => Promise<T>): Promise<T> {
  const store = await setup.storage.open();
  try {
    return await read(store);
  } finally {
    await store.close();
  }
}

/** Waits until `read` holds, or fails naming `what`. */
async function until(read: () => Promise<boolean>, what: () => string): Promise<void> {
  for (let i = 0; i < 1_200; i += 1) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what()}`);
}

/** `pathways nodes --json` from `setup`'s project, by node id. */
async function listed(setup: Project): Promise<Record<string, NodeRow>> {
  const result = await finish(setup, ["nodes", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const { nodes } = JSON.parse(result.stdout) as { nodes: NodeRow[] };
  return Object.fromEntries(nodes.map((row) => [row.node, row]));
}

for (const database of TEST_DATABASES) {
  const server = database.kind !== "sqlite";
  describe.skipIf(!available(database))(`Nodes between processes on ${database.label}`, () => {
    it("lists the running engine, and on a server its standby, each from the other's project, their clocks four hours apart", async () => {
      const setup = await project(database);
      const holder = start(setup, ["start"], 2 * 3_600_000);
      const second = server ? await project(database, setup) : undefined;
      // The standby starts once the holder runs, so the holder is the one that takes the lease.
      await until(
        async () => (await inStore(setup, (store) => store.nodes())).length === 1,
        () => `the holder's row: ${holder.stderr()}`,
      );
      const standby =
        second === undefined ? undefined : start(second, ["start", "--standby"], -2 * 3_600_000);
      const expected = server ? 2 : 1;
      await until(
        async () => (await inStore(setup, (store) => store.nodes())).length === expected,
        () => `${String(expected)} rows: ${holder.stderr()} ${standby?.stderr() ?? ""}`,
      );
      // Past a few heartbeats, so the ages read are the heartbeats', not the joins'.
      await new Promise((resolve) => setTimeout(resolve, 2 * HEARTBEAT_MS));
      const fromHolder = await listed(setup);
      const fromStandby = second === undefined ? fromHolder : await listed(second);
      for (const rows of [fromHolder, fromStandby]) {
        const roles = Object.values(rows)
          .map((row) => row.role)
          .sort();
        expect(roles).toEqual(server ? ["active", "standby"] : ["active"]);
        for (const row of Object.values(rows)) {
          // Aged by the database's clock: under the bound, whatever either node's clock says.
          expect(row.stale).toBe(false);
          expect(row.heartbeatAgeMs).toBeLessThan(BOUND_MS);
          expect(row.staleAfterMs).toBe(BOUND_MS);
          expect(row.pid).not.toBe(process.pid);
          expect(Math.abs(Date.parse(row.startedAt) - Date.now())).toBeLessThan(60_000);
        }
      }
      expect(Object.keys(fromStandby).sort()).toEqual(Object.keys(fromHolder).sort());
      const text = await finish(setup, ["nodes"]);
      expect(text.stdout).toMatch(/^NODE +HOST +PID +ROLE +VERSION +HEARTBEAT +STATE\n/);
      expect(text.stdout).toMatch(/ active +\S+ +\d+\.\ds ago +live\n/);
      expect(text.stdout).not.toContain("://");
      holder.child.kill("SIGKILL");
      standby?.child.kill("SIGKILL");
      await holder.exited;
      await standby?.exited;
    }, 120_000);

    it("shows an engine killed hard stale within three heartbeats, then forgets it, audited", async () => {
      const setup = await project(database);
      const holder = start(setup, ["start"]);
      await until(
        async () => (await inStore(setup, (store) => store.nodes())).length === 1,
        () => `the holder's row: ${holder.stderr()}`,
      );
      const kept = (await readFile(join(setup.root, ".pathways/node-id"), "utf8")).trim();
      expect(Object.keys(await listed(setup))).toEqual([kept]);
      // A live node is not forgotten.
      const live = await finish(setup, ["nodes", "forget", kept]);
      expect(live.code).toBe(1);
      expect(live.stdout).toContain(`Node ${kept} is live, not forgotten`);

      holder.child.kill("SIGKILL");
      const killedAt = Date.now();
      await holder.exited;
      let row: NodeRow | undefined;
      await until(
        async () => {
          row = (await inStore(setup, (store) => store.nodes()))[0];
          return row?.stale === true;
        },
        () => "the row to show stale",
      );
      const shown = Date.now() - killedAt;
      // Written to the run's log, for the times a pull request reports.
      process.stdout.write(`node stale on ${database.label}: ${String(shown)} ms after the kill\n`);
      // The bound the docs state: three heartbeats after the last one, which came at most one
      // heartbeat before the kill; with a second for the reads here.
      expect(shown).toBeLessThanOrEqual(BOUND_MS + 1_000);
      expect(row?.heartbeatAgeMs).toBeGreaterThanOrEqual(BOUND_MS);
      expect((await finish(setup, ["nodes"])).stdout).toMatch(/ stale\n$/);

      const forgotten = await finish(setup, ["nodes", "forget", kept]);
      expect(forgotten.code).toBe(0);
      expect(forgotten.stdout).toMatch(new RegExp(`^Node forgotten: node ${kept} on host `));
      expect((await finish(setup, ["nodes"])).stdout).toBe("No engine runs on this database.\n");
      const audit = await inStore(setup, (store) =>
        store.auditEntries({ action: "node-forget", limit: 10 }),
      );
      expect(audit.items.map((entry) => [entry.outcome, entry.detail?.["node"]])).toEqual([
        ["ok", kept],
        ["refused", kept],
      ]);
    }, 120_000);
  });
}
