// A real `pathways` process reading a folder on OpenSSH's own server over SFTP, stopped hard at
// each step of a claim, as a power cut or an out-of-memory kill stops it, then started again. The
// child is started with PATHWAYS_TEST_FAULT_POINT naming the step (src/fault-points.ts); it says
// so on stderr and freezes there, with its SSH connection and its database open, and the test ends
// it with SIGKILL. After a restart each file is stored once and delivered once to each
// destination, none is left on the server, and a clean restart after that sends nothing again.
//
// It runs where PATHWAYS_TEST_SSHD names the sshd binary (test/sshd.ts), as
// .github/workflows/sftp.yml sets it, on SQLite: the crash tests in test/fault-points.test.ts run
// the same steps on a local folder, and on each database server.
import { spawn } from "node:child_process";
import { chmod, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateKey } from "../src/encryption/keys.js";
import {
  FAULT_POINT_ENV,
  FAULT_POINT_REACHED,
  FAULT_POINT_RESUME_ENV,
  type FaultPoint,
} from "../src/fault-points.js";
import { Store } from "../src/storage/store.js";
import { leaseLapsed } from "./databases.js";
import { cleanUp, dropFile, makeProject } from "./helpers.js";
import { SSHD, type Sshd, startSshd, stopAllSshd } from "./sshd.js";

const BIN = join(import.meta.dirname, "../src/bin/pathways.ts");

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

/** How many notes each test drops on the server, and the two destinations each goes to. */
const NOTES = 3;
const DESTINATIONS = ["a", "b"] as const;
const notes = Array.from({ length: NOTES }, (_, at) => `synthetic note ${String(at + 1)}`);

interface Project {
  readonly root: string;
  /** The folder on the server the channel reads, which is a folder on this machine too. */
  readonly inbox: string;
  readonly open: () => Promise<Store>;
  readonly sent: () => Promise<Sent[]>;
}

let sshd: Sshd;
let projects = 0;

/**
 * A project with one text channel that reads a folder of its own on the server over SFTP, to two
 * recording destinations, stored on SQLite, with {@link NOTES} notes in the folder.
 */
async function project(): Promise<Project> {
  projects += 1;
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "destination.ts": RECORDING_DESTINATION,
    id_synthetic: sshd.userKey,
    known_hosts: `[127.0.0.1]:${String(sshd.port)} ${sshd.hostPublic}\n`,
    "channels/notes/transform.ts": "export default (text: string): string => text;\n",
  });
  await chmod(join(root, "id_synthetic"), 0o600);
  await chmod(join(root, "known_hosts"), 0o644);
  const log = join(root, "sent.jsonl");
  const inbox = join(sshd.home, `notes-${String(projects)}`);
  await writeFile(
    join(root, "pathways.yaml"),
    "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\nlease:\n  ttl: 3s\n",
  );
  // JSON's string is YAML's double-quoted one.
  await writeFile(
    join(root, "channels/notes/channel.yaml"),
    [
      "format: text",
      "source:",
      "  file:",
      `    dir: ${JSON.stringify(inbox)}`,
      "    minAge: 0",
      "    sftp:",
      "      host: 127.0.0.1",
      `      port: ${String(sshd.port)}`,
      `      user: ${JSON.stringify(userInfo().username)}`,
      `      key: { file: ${JSON.stringify(join(root, "id_synthetic"))} }`,
      `      knownHosts: ${JSON.stringify(join(root, "known_hosts"))}`,
      "      connectTimeout: 10s",
      "      timeout: 10s",
      "transform: ./transform.ts",
      "destinations:",
      ...DESTINATIONS.map(
        (name) =>
          `  - module: ../../destination.ts\n` +
          `    options: { log: ${JSON.stringify(log)}, name: ${name} }`,
      ),
      "",
    ].join("\n"),
  );
  for (const [at, note] of notes.entries()) {
    await dropFile(join(inbox, `note-${String(at + 1)}.txt`), note);
  }
  const sent = async (): Promise<Sent[]> =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Sent);
  return { root, inbox, open: () => Store.open(join(root, ".pathways/pathways.db")), sent };
}

interface Ended {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/**
 * `pathways start --once -C root`, with `armed` in PATHWAYS_TEST_FAULT_POINT when given and `resume`
 * as the file that lets a held point carry on: `reached` waits for the child to say it reached a
 * point, and `exited` for its end.
 */
function start(setup: Project, armed?: string, resume?: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", BIN, "start", "--once", "-C", setup.root],
    {
      stdio: ["ignore", "ignore", "pipe"],
      // tsx's loader draws a deprecation warning from Node 26; nothing else may reach stderr.
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        ...(armed === undefined ? {} : { [FAULT_POINT_ENV]: armed }),
        ...(resume === undefined ? {} : { [FAULT_POINT_RESUME_ENV]: resume }),
      },
    },
  );
  let stderr = "";
  const exited = new Promise<Ended>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, stderr })),
  );
  const listeners = new Set<() => void>();
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    for (const listener of listeners) listener();
  });
  const reached = (point: FaultPoint): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the child did not reach ${point} in time: ${stderr}`));
      }, 30_000);
      const check = (): void => {
        if (!stderr.includes(`${FAULT_POINT_REACHED}${point}\n`)) return;
        listeners.delete(check);
        clearTimeout(timer);
        resolve();
      };
      listeners.add(check);
      check();
      void exited.then(({ code }) => {
        clearTimeout(timer);
        reject(new Error(`the child ended (${String(code)}) before ${point}: ${stderr}`));
      });
    });
  return { child, exited, reached };
}

/**
 * Starts `pathways` with `armed`, waits for it to reach the point, ends it there with SIGKILL, and
 * waits for its engine lease to lapse (3s).
 */
async function killAt(setup: Project, armed: string): Promise<Ended> {
  const run = start(setup, armed);
  try {
    await run.reached((armed.split("@")[0] ?? armed) as FaultPoint);
  } finally {
    run.child.kill("SIGKILL");
  }
  const ended = await run.exited;
  await leaseLapsed(setup.open);
  return ended;
}

/** Runs `pathways start --once` to its end, which must be clean: exit 0, nothing on stderr. */
async function cleanly(setup: Project): Promise<void> {
  const { code, signal, stderr } = await start(setup).exited;
  expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
}

/** The names on the server in the channel's folder, and in its claim folder. */
async function onServer(setup: Project): Promise<{ inbox: string[]; claimed: string[] }> {
  const inbox = (await readdir(setup.inbox)).filter((name) => !name.startsWith(".")).sort();
  const claimed = await readdir(join(setup.inbox, ".claimed/notes")).catch(() => []);
  return { inbox, claimed };
}

/**
 * Checks what a restart after a crash must leave: each of `bodies` stored once and delivered once
 * to each destination, unflagged, nothing pending or failed, nothing left on the server; then that
 * a clean restart sends nothing again.
 */
async function recovered(setup: Project, bodies: readonly string[] = notes): Promise<void> {
  const store = await setup.open();
  try {
    expect(await store.messageCounts("notes")).toEqual({
      received: 0,
      transformed: bodies.length,
      filtered: 0,
      failed: 0,
      cleared: 0,
    });
    expect(await store.deliveryCounts("notes")).toEqual({
      pending: 0,
      delivered: bodies.length * DESTINATIONS.length,
      failed: 0,
      cleared: 0,
    });
  } finally {
    await store.close();
  }
  expect(await onServer(setup)).toEqual({ inbox: [], claimed: [] });
  const sent = await setup.sent();
  for (const to of DESTINATIONS) {
    const copies = sent.filter((s) => s.to === to);
    // Each once: none lost, none delivered twice.
    expect(copies.map((s) => s.body).sort()).toEqual([...bodies].sort());
    expect(copies.every((s) => s.resend === null)).toBe(true);
  }
  await cleanly(setup);
  expect(await setup.sent()).toEqual(sent);
}

describe.skipIf(SSHD === undefined)(
  "A pathways process reading over SFTP, killed at each step of a claim",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      sshd = await startSshd();
    });
    afterAll(async () => {
      await stopAllSshd();
      await cleanUp();
    });

    it("before-claim-move: the file opened and checked stays on the server, and is stored once", async () => {
      const setup = await project();
      const killed = await killAt(setup, "before-claim-move@2");
      expect(killed.signal).toBe("SIGKILL");
      // The first file is claimed; the second and third are still where they were dropped.
      expect(await onServer(setup)).toMatchObject({
        inbox: ["note-2.txt", "note-3.txt"],
        claimed: [expect.stringMatching(/-note-1\.txt$/)],
      });
      expect(await setup.sent()).toEqual([]);
      await cleanly(setup);
      await recovered(setup);
    });

    it("after-claim-move: the claims not yet flushed are stored once by the restart", async () => {
      const setup = await project();
      const killed = await killAt(setup, "after-claim-move@2");
      expect(killed.signal).toBe("SIGKILL");
      expect(await onServer(setup)).toMatchObject({
        inbox: ["note-3.txt"],
        claimed: [expect.stringMatching(/-note-1\.txt$/), expect.stringMatching(/-note-2\.txt$/)],
      });
      await cleanly(setup);
      await recovered(setup);
    });

    it("after-claim-flush: every claim is kept, and the restart stores each once", async () => {
      const setup = await project();
      const killed = await killAt(setup, "after-claim-flush");
      expect(killed.signal).toBe("SIGKILL");
      expect((await onServer(setup)).inbox).toEqual([]);
      expect((await onServer(setup)).claimed).toHaveLength(NOTES);
      expect(await setup.sent()).toEqual([]);
      await cleanly(setup);
      await recovered(setup);
    });

    it("after-store-before-ack: the restart reads the stored file again and stores it once", async () => {
      const setup = await project();
      const killed = await killAt(setup, "after-store-before-ack@2");
      expect(killed.signal).toBe("SIGKILL");
      const store = await setup.open();
      try {
        expect((await store.messageCounts("notes")).received).toBe(2);
      } finally {
        await store.close();
      }
      // The second is stored and its file not yet deleted, and the third is not stored.
      expect((await onServer(setup)).claimed).toHaveLength(2);
      await cleanly(setup);
      await recovered(setup);
    });

    it("mid-move-back: a file swapped in before the move goes back under one name, and is stored once", async () => {
      const setup = await project();
      const resume = join(setup.root, "resume");
      const held = start(setup, "before-claim-move,mid-move-back", resume);
      try {
        // Held after its last check of note-1.txt, the first by name: another file takes its place.
        await held.reached("before-claim-move");
        const swap = join(sshd.home, `swap-${String(projects)}`);
        await dropFile(join(swap, "note-1.txt"), "synthetic swapped note");
        await rename(join(setup.inbox, "note-1.txt"), join(setup.root, "kept-note-1.txt"));
        await rename(join(swap, "note-1.txt"), join(setup.inbox, "note-1.txt"));
        await writeFile(resume, "");
        // The move takes the swapped file, which the check after it refuses: killed mid move back.
        await held.reached("mid-move-back");
      } finally {
        held.child.kill("SIGKILL");
      }
      expect((await held.exited).signal).toBe("SIGKILL");
      // Nothing waits in the claim folder: the swapped file is back where it was dropped.
      expect(await onServer(setup)).toEqual({
        inbox: ["note-1.txt", "note-2.txt", "note-3.txt"],
        claimed: [],
      });
      await leaseLapsed(setup.open);
      await cleanly(setup);
      await recovered(setup, ["synthetic note 2", "synthetic note 3", "synthetic swapped note"]);
      expect(await readFile(join(setup.root, "kept-note-1.txt"), "utf8")).toBe("synthetic note 1");
    });
  },
);
