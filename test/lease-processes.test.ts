// The engine lease between real `pathways` processes, on SQLite and on each server whose URL is set,
// each at its default isolation level: two engines started at once, their clocks hours apart; an
// engine killed hard and its lease taken a time to live later, by a restart or by a standby, timed
// against the bound the docs state; an engine held in the middle of a send past its lease while a
// second takes over, then let go, its next write refused by the epoch; and the operator commands
// beside a held lease, with a forced release that stops the holder.
//
// A process is held at a fault point (src/fault-points.ts), which blocks its thread as a pause by its
// host does, and is let go when the test writes the file PATHWAYS_TEST_FAULT_POINT_RESUME names. That
// works the same on Linux, macOS and Windows, where there is no SIGSTOP. A hard stop is SIGKILL
// (TerminateProcess on Windows); SIGTERM is never sent here.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { generateKey } from "../src/encryption/keys.js";
import {
  FAULT_POINT_ENV,
  FAULT_POINT_REACHED,
  FAULT_POINT_RESUME_ENV,
  FAULT_POINT_RESUMED,
} from "../src/fault-points.js";
import { ENGINE_LEASE, type Store } from "../src/storage/store.js";
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

/** A destination that appends each message it is handed to `options.log` as a JSON line. */
const RECORDING_DESTINATION = `
import { appendFileSync } from "node:fs";
interface Outgoing { messageId: number; body: Uint8Array; resend?: { previousAttempts: number } }
export default (options: { log: string; name: string }) => ({
  deliver(message: Outgoing): Promise<void> {
    const sent = { to: options.name, id: message.messageId, resend: message.resend ?? null };
    appendFileSync(options.log, JSON.stringify(sent) + "\\n");
    return Promise.resolve();
  },
});
`;

/**
 * Loaded before the engine with --import: moves this process's wall clock by PATHWAYS_SKEW_MS, as
 * a node whose clock has drifted. The monotonic clock is left alone, as drift leaves it.
 */
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

interface Sent {
  readonly to: string;
  readonly id: number;
  readonly resend: { readonly previousAttempts: number } | null;
}

const NOTES = 3;

interface Project {
  readonly root: string;
  readonly storage: TestStorage;
  readonly env: Record<string, string>;
  readonly sent: () => Promise<Sent[]>;
}

/**
 * A project with one text channel to two recording destinations and `NOTES` notes waiting, its
 * engine lease lasting `ttl`; on the database and key of `shared` when given, as a second engine's
 * project on the same database.
 */
async function project(database: TestDatabase, ttl: string, shared?: Project): Promise<Project> {
  const key =
    shared === undefined
      ? `${generateKey()}\n`
      : await readFile(join(shared.root, "test.key"), "utf8");
  const root = await makeProject({
    "test.key": key,
    "destination.ts": RECORDING_DESTINATION,
    "skew.mjs": SKEWED_CLOCK,
    "channels/notes/channel.yaml": "",
  });
  const log = join(root, "sent.jsonl");
  const storage =
    shared?.storage ?? (await testStorage(database, join(root, ".pathways/pathways.db")));
  const block =
    storage.url === undefined
      ? ""
      : `storage:\n  ${database.kind}: { plaintext: true, pool: { max: 2 } }\n`;
  await writeFile(
    join(root, "pathways.yaml"),
    "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" +
      `defaults:\n  pollInterval: 50ms\nlease:\n  ttl: ${ttl}\n` +
      block,
  );
  await writeFile(
    join(root, "channels/notes/channel.yaml"),
    "format: text\nsource:\n  file: { dir: ../../data/inbox, minAge: 0 }\ndestinations:\n" +
      ["a", "b"]
        .map(
          (name) =>
            `  - module: ../../destination.ts\n` +
            `    options: { log: ${JSON.stringify(log)}, name: ${name} }\n`,
        )
        .join(""),
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

interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves with the first log event of `event`, and the time it was seen. */
  readonly logged: (event: string) => Promise<{ at: number; fields: Record<string, unknown> }>;
}

/** `pathways <args> -C root` in a process of its own, with `env` added and its clock skewed. */
function start(
  setup: Project,
  args: readonly string[],
  options: { env?: Record<string, string>; skewMs?: number } = {},
): Running {
  const skew =
    options.skewMs === undefined
      ? []
      : ["--import", pathToFileURL(join(setup.root, "skew.mjs")).href];
  const child = spawn(
    process.execPath,
    ["--import", "tsx", ...skew, BIN, ...args, "-C", setup.root],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...setup.env,
        NODE_NO_WARNINGS: "1",
        ...(options.skewMs === undefined ? {} : { PATHWAYS_SKEW_MS: String(options.skewMs) }),
        ...options.env,
      },
    },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  const waiters: (() => void)[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const waiter of waiters.splice(0)) waiter();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    for (const waiter of waiters.splice(0)) waiter();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const find = (event: string): Record<string, unknown> | undefined =>
    stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((fields) => fields["event"] === event);
  const logged = (event: string): Promise<{ at: number; fields: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ${event} in time: ${stderr}`));
      }, 60_000);
      const look = (): void => {
        const fields = find(event);
        if (fields !== undefined) {
          clearTimeout(timer);
          resolve({ at: Date.now(), fields });
        } else waiters.push(look);
      };
      look();
      void exited.then(() => {
        const fields = find(event);
        clearTimeout(timer);
        if (fields === undefined) reject(new Error(`ended before ${event}: ${stderr}`));
      });
    });
  return { child, exited, stdout: () => stdout, stderr: () => stderr, logged };
}

/** Waits until `read` holds; `what` names it, or says what was seen, when it never does. */
async function until(read: () => Promise<boolean>, what: string | (() => string)): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
}

async function inStore<T>(setup: Project, read: (store: Store) => Promise<T>): Promise<T> {
  const store = await setup.storage.open();
  try {
    return await read(store);
  } finally {
    await store.close();
  }
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

const REFUSAL =
  /^pathways: another engine holds the engine lease on this database: node ([0-9a-f]{16}) on host [^,]+, since \d{4}-\d\d-\d\dT[\d:.]+Z, epoch (\d+), (\d+\.\d)s left\. Stop it first, or start this one with --standby to take over when it stops\.\n$/;

for (const database of TEST_DATABASES) {
  const server = database.kind !== "sqlite";
  describe.skipIf(!available(database))(
    `The engine lease between processes on ${database.label}`,
    () => {
      it("lets one of two engines started at once run, their clocks two hours apart, and refuses the other", async () => {
        const setup = await project(database, "3s");
        // The schema first, so the two race for the lease and not for the migrations.
        await inStore(setup, (store) => store.leaseHolder(ENGINE_LEASE));
        const ahead = start(setup, ["start"], { skewMs: 2 * 3_600_000 });
        const behind = start(setup, ["start"], { skewMs: -2 * 3_600_000 });
        const first = await Promise.race([
          ahead.exited.then(() => ahead),
          behind.exited.then(() => behind),
        ]);
        const winner = first === ahead ? behind : ahead;
        expect(await first.exited).toEqual({ code: 1, signal: null });
        const refusal = REFUSAL.exec(first.stderr());
        expect(refusal, first.stderr()).not.toBeNull();
        expect(first.stderr()).not.toContain("://");
        const { fields } = await winner.logged("lease-acquired");
        expect(refusal?.[1]).toBe(fields["node"]);
        expect(refusal?.[2]).toBe("1");
        // Time left by the database's clock: at most the time to live, whatever either clock says.
        expect(Number(refusal?.[3])).toBeLessThanOrEqual(3);
        // The refused engine opened no source and took nothing in. (The one that runs reads its
        // folder by its own clock, which for the one behind puts every file in the future.)
        expect(first.stdout()).not.toContain('"event":"received"');
        expect(first.stdout()).not.toContain('"event":"lease-acquired"');
        winner.child.kill("SIGKILL");
        await winner.exited;
      }, 120_000);

      it("takes a killed engine's lease a time to live later, and not before", async () => {
        const setup = await project(database, "8s");
        const holder = start(setup, ["start"]);
        await holder.logged("lease-acquired");
        await until(async () => (await setup.sent()).length === NOTES * 2, "the deliveries");
        // A standby on the same database, with a project of its own: it reads no folder while it waits.
        const second = server ? await project(database, "8s", setup) : undefined;
        const standby = second === undefined ? undefined : start(second, ["start", "--standby"]);
        await standby?.logged("standby-waiting");

        holder.child.kill("SIGKILL");
        const killedAt = Date.now();
        await holder.exited;
        // A restart while the lease lasts is refused, naming the dead holder.
        const early = await finish(setup, ["start", "--once"]);
        expect(early.code).toBe(1);
        expect(early.stderr).toMatch(REFUSAL);
        expect(second === undefined ? [] : await second.sent()).toEqual([]);

        if (standby !== undefined && second !== undefined) {
          // The bound the docs state: the time to live, plus one renewal interval, plus the start.
          const { at, fields } = await standby.logged("lease-acquired");
          const takeover = at - killedAt;
          // Written to the run's log, for the takeover times a pull request reports.
          process.stdout.write(
            `lease takeover on ${database.label}: ${String(takeover)} ms after the kill\n`,
          );
          expect(fields["epoch"]).toBe(2);
          expect(takeover).toBeGreaterThanOrEqual((8_000 * 2) / 3 - 500);
          expect(takeover).toBeLessThanOrEqual(8_000 + 8_000 / 3 + 2_000);
          await until(async () => (await second.sent()).length === NOTES * 2, "the standby's work");
          standby.child.kill("SIGKILL");
          await standby.exited;
        }
        await leaseLapsed(() => setup.storage.open());
        const restarted = await finish(setup, ["start", "--once"]);
        expect(restarted.code).toBe(0);
        const epochs = server ? 3 : 2;
        expect(await inStore(setup, (store) => store.leaseHolder(ENGINE_LEASE))).toMatchObject({
          epoch: epochs,
        });
      }, 120_000);

      it("refuses the next write of an engine held mid-send past its lease, by the epoch", async () => {
        const setup = await project(database, "3s");
        const resume = join(setup.root, "resume");
        const held = start(setup, ["start", "--once"], {
          env: { [FAULT_POINT_ENV]: "after-send-before-record", [FAULT_POINT_RESUME_ENV]: resume },
        });
        await until(
          () =>
            Promise.resolve(
              held.stderr().includes(`${FAULT_POINT_REACHED}after-send-before-record`),
            ),
          "the fault point",
        );
        // Held, it renews nothing: the lease lapses, and a second engine takes it and does the work,
        // sending the delivery in flight again, flagged.
        await leaseLapsed(() => setup.storage.open());
        const second = await finish(setup, ["start", "--once"]);
        expect(second.code).toBe(0);
        expect(
          (await setup.sent()).filter((s) => s.to === "a").map((s) => [s.id, s.resend]),
        ).toEqual([
          [1, null],
          [1, { previousAttempts: 1 }],
          [2, null],
          [3, null],
        ]);

        // Let go, the held engine records its send under its old epoch: refused, and it stops.
        await writeFile(resume, "");
        expect(await held.exited).toEqual({ code: 1, signal: null });
        expect(held.stderr()).toContain(`${FAULT_POINT_RESUMED}after-send-before-record`);
        expect(held.stderr()).toContain(
          "pathways: the engine lease was lost (write-refused); this engine stopped sending and taking in.",
        );
        const lost = held
          .stdout()
          .split("\n")
          .filter((line) => line.includes('"event":"lease-lost"'))
          .map((line) => JSON.parse(line) as { reason: string; epoch: number });
        expect(lost.at(-1)).toMatchObject({ reason: "write-refused", epoch: 1 });
        // It sent nothing more, and what the second engine recorded stands.
        expect(await setup.sent()).toHaveLength(NOTES * 2 + 1);
        expect(await inStore(setup, (store) => store.deliveryCounts("notes"))).toMatchObject({
          pending: 0,
          delivered: NOTES * 2,
          failed: 0,
        });
      }, 120_000);

      it("runs the operator commands beside a held lease, and a forced release stops the holder", async () => {
        const setup = await project(database, "3s");
        const holder = start(setup, ["start"]);
        const { fields } = await holder.logged("lease-acquired");
        await until(async () => (await setup.sent()).length === NOTES * 2, "the deliveries");

        const codes: Record<string, number | null> = {};
        for (const args of [
          ["replay", "2", "--resend"],
          ["clear", "1"],
          ["retention"],
          ["audit"],
          ["messages"],
          ["rekey"],
        ]) {
          codes[args.join(" ")] = (await finish(setup, args)).code;
        }
        // clear is refused only because message 1 has not failed.
        expect(codes).toEqual({
          "replay 2 --resend": 0,
          "clear 1": 1,
          retention: 0,
          audit: 0,
          messages: 0,
          rekey: 0,
        });
        // The engine still holds the lease, and sends the resend.
        await until(async () => (await setup.sent()).length === NOTES * 2 + 2, "the resend");
        const status = await finish(setup, ["lease", "status"]);
        expect(status.code).toBe(0);
        expect(status.stdout).toContain(`held by node ${String(fields["node"])}`);

        const released = await finish(setup, ["lease", "release", "--force"]);
        expect(released.code).toBe(0);
        expect(await holder.exited).toEqual({ code: 1, signal: null });
        expect(holder.stderr()).toContain("the engine lease was lost (renewal-refused)");
        const audit = await inStore(setup, (store) =>
          store.auditEntries({ action: "lease-release", limit: 10 }),
        );
        expect(audit.items).toMatchObject([
          { outcome: "ok", detail: { node: fields["node"], epoch: 1 } },
        ]);
      }, 120_000);
    },
  );
}
