// `pathways start` stopped from outside, as an operator or a service manager stops it: the real
// command in its own process, sent a signal or ended.
//
// On Linux and macOS, SIGINT and SIGTERM each stop it cleanly with exit code 0, and the promise the
// hooks page makes holds: each hook gets up to its time limit to finish the events queued for it.
//
// Windows has no signals between processes. Node's `kill` there ends the process at once
// (TerminateProcess) whatever signal it names, so a test cannot send it SIGINT, and SIGTERM does not
// exist. So on Windows the engine is only ever ended hard here, never sent SIGTERM; Ctrl+C in its
// console is the SIGINT a person or a service wrapper sends, and the command reference says so. The
// hard stop runs on every system: it loses no message, and the hook events still queued are lost.
// So does the hard stop in the middle of a send, the receiver given the message and the engine
// ended before it could record that: the next start sends that message again, flagged.
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateKey } from "../src/encryption/keys.js";
import { ADT_A01, cleanUp, dropFileWhileRunning, LAB_TRANSFORM, makeProject } from "./helpers.js";

afterEach(cleanUp);

const BIN = join(import.meta.dirname, "../src/bin/pathways.ts");
const windows = process.platform === "win32";

/** How many messages each test sends through. */
const MESSAGES = 3;

/**
 * An engine-wide hook that takes 300 ms over each event, then writes its type on a line of its own
 * in `options.file`, so the events of {@link MESSAGES} messages queue up behind it.
 */
const SLOW_HOOK = `
import { appendFileSync } from "node:fs";
export default (options: { file: string }) => ({
  async onEvent(event: { type: string }): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    appendFileSync(options.file, event.type + "\\n");
  },
});
`;

interface Project {
  readonly root: string;
  readonly hookFile: string;
}

async function project(): Promise<Project> {
  const root = await makeProject({
    "test.key": `${generateKey()}\n`,
    "hooks/slow.ts": SLOW_HOOK,
    "channels/adt/channel.yaml":
      "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ntransform: ./transform.ts\n" +
      "destinations:\n  - file: { dir: ../../data/out }\n",
    "channels/adt/transform.ts": LAB_TRANSFORM,
  });
  const hookFile = join(root, "hook-events.txt");
  // JSON's string is YAML's double-quoted one, so a Windows path keeps its backslashes.
  await writeFile(
    join(root, "pathways.yaml"),
    "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" +
      "defaults:\n  pollInterval: 10ms\n" +
      `hooks:\n  - module: ./hooks/slow.ts\n    options: { file: ${JSON.stringify(hookFile)} }\n`,
  );
  return { root, hookFile };
}

interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stderr: () => string;
}

/** `pathways start` (or `start --once`) on `root`, in a process of its own, as an operator runs it. */
function start(root: string, once = false): Running {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", BIN, "start", ...(once ? ["--once"] : []), "-C", root],
    // tsx's loader draws a deprecation warning from Node 26; nothing else may reach stderr.
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, exited, stderr: () => stderr };
}

/** The files delivered so far, sorted. */
async function delivered(root: string): Promise<string[]> {
  return (await readdir(join(root, "data/out")).catch(() => [])).sort();
}

/** Drops {@link MESSAGES} admissions into the running engine's inbox and waits for each to be delivered. */
async function sendThrough(root: string): Promise<void> {
  for (let i = 0; i < MESSAGES; i += 1) {
    await dropFileWhileRunning(join(root, `data/inbox/${String(i)}.hl7`), ADT_A01);
  }
  for (let i = 0; i < 1_000; i += 1) {
    if ((await delivered(root)).length >= MESSAGES) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the running engine did not deliver in time");
}

/** How many times the hook wrote each event type. */
async function hookCounts(file: string): Promise<Record<string, number>> {
  const text = await readFile(file, "utf8").catch(() => "");
  const counts: Record<string, number> = {};
  for (const type of text.split("\n").filter(Boolean)) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

const outputs = Array.from({ length: MESSAGES }, (_, i) => `${String(i + 1)}-1.hl7`).sort();

describe("pathways start, stopped from outside", () => {
  // Windows: Node's kill ends the process whatever the signal, so no signal can be sent to test.
  it.skipIf(windows).each(["SIGINT", "SIGTERM"] as const)(
    "stops cleanly on %s with exit code 0, and each hook finishes the events queued for it",
    async (signal) => {
      const { root, hookFile } = await project();
      const engine = start(root);
      try {
        await sendThrough(root);
        // The hook takes 300 ms an event, so most of the messages' events are still queued.
        expect((await hookCounts(hookFile))["delivered"] ?? 0).toBeLessThan(MESSAGES);
      } finally {
        engine.child.kill(signal);
      }
      expect(await engine.exited).toEqual({ code: 0, signal: null });
      expect(engine.stderr()).toBe("");
      expect(await hookCounts(hookFile)).toMatchObject({
        received: MESSAGES,
        transformed: MESSAGES,
        delivered: MESSAGES,
      });
      expect(await delivered(root)).toEqual(outputs);
    },
    30_000,
  );

  it("loses no message when it is ended at once, and the next start finds nothing left to do", async () => {
    const { root, hookFile } = await project();
    const engine = start(root);
    try {
      await sendThrough(root);
    } finally {
      // A hard stop, on every system: SIGKILL on Linux and macOS, TerminateProcess on Windows.
      engine.child.kill("SIGKILL");
    }
    const ended = await engine.exited;
    expect(ended.code === 0 && ended.signal === null).toBe(false);
    // The hook's queue went with the process: a hard stop flushes nothing.
    const flushed = await hookCounts(hookFile);
    expect(flushed["delivered"] ?? 0).toBeLessThan(MESSAGES);

    // Every message was stored before its file left the inbox, and delivered before the stop.
    const again = start(root, true);
    expect(await again.exited).toEqual({ code: 0, signal: null });
    expect(again.stderr()).toBe("");
    expect(await delivered(root)).toEqual(outputs);
    expect(
      (await readdir(join(root, "data/inbox"))).filter((name) => !name.startsWith(".")),
    ).toEqual([]);
  }, 30_000);
});

/**
 * A destination that appends each message it is handed to `options.log`, as a JSON line of its id
 * and its resend flag, and then, while `options.hold` exists, never answers about message 2: the
 * receiver has it, and the engine waits for an outcome that never comes.
 */
const HOLDING_DESTINATION = `
import { appendFileSync, existsSync } from "node:fs";
interface Outgoing { messageId: number; seq: number; body: Uint8Array; resend?: { previousAttempts: number } }
export default (options: { log: string; hold: string }) => ({
  deliver(message: Outgoing): Promise<void> {
    appendFileSync(options.log, JSON.stringify({ id: message.messageId, resend: message.resend ?? null }) + "\\n");
    if (message.messageId === 2 && existsSync(options.hold)) return new Promise<void>(() => undefined);
    return Promise.resolve();
  },
});
`;

describe("pathways start, ended in the middle of a send", () => {
  it("sends the message in flight again, flagged, and nothing else twice", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "destination.ts": HOLDING_DESTINATION,
      "channels/adt/transform.ts": LAB_TRANSFORM,
      hold: "",
    });
    const log = join(root, "sent.jsonl");
    const hold = join(root, "hold");
    await writeFile(
      join(root, "pathways.yaml"),
      "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" +
        "defaults:\n  pollInterval: 10ms\n",
    );
    await writeFile(
      join(root, "channels/adt/channel.yaml"),
      "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ntransform: ./transform.ts\n" +
        "destinations:\n  - module: ../../destination.ts\n" +
        `    options: { log: ${JSON.stringify(log)}, hold: ${JSON.stringify(hold)} }\n`,
    );
    const sent = async (): Promise<{ id: number; resend: unknown }[]> =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: number; resend: unknown });

    const engine = start(root);
    try {
      for (let i = 0; i < MESSAGES; i += 1) {
        await dropFileWhileRunning(join(root, `data/inbox/${String(i)}.hl7`), ADT_A01);
      }
      // Message 2 is in flight: the receiver has it, and its outcome is never recorded.
      for (let i = 0; (await sent()).length < 2; i += 1) {
        if (i >= 1_000) throw new Error("the running engine did not send in time");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      // A hard stop, on every system: SIGKILL on Linux and macOS, TerminateProcess on Windows.
      engine.child.kill("SIGKILL");
    }
    const ended = await engine.exited;
    expect(ended.code === 0 && ended.signal === null).toBe(false);
    expect(await sent()).toEqual([
      { id: 1, resend: null },
      { id: 2, resend: null },
    ]);

    // The next start sends message 2 again, flagged, then message 3 for the first time.
    await rm(hold);
    const again = start(root, true);
    expect(await again.exited).toEqual({ code: 0, signal: null });
    expect(again.stderr()).toBe("");
    expect(await sent()).toEqual([
      { id: 1, resend: null },
      { id: 2, resend: null },
      { id: 2, resend: { previousAttempts: 1 } },
      { id: 3, resend: null },
    ]);

    // A clean restart after that sends nothing at all.
    const clean = start(root, true);
    expect(await clean.exited).toEqual({ code: 0, signal: null });
    expect(clean.stderr()).toBe("");
    expect(await sent()).toHaveLength(4);
  }, 30_000);
});
