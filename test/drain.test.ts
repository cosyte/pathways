// A graceful drain with a bound. Told to stop, `pathways start` reports draining (readiness 503)
// first, waits `drain.notReadyDelay` while it still takes messages in, so a load balancer stops
// sending it new ones, then closes its listeners and stops polling, lets each MLLP connection
// finish the message it is handling and its ACK, lets the work in flight finish up to
// `drain.timeout`, releases its lease and exits 0. And `mllp.maxConnectionAge` closes a connection
// after its current message once it is older than the age, so a sender reconnects through the
// balancer and spreads over the nodes behind it.
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { encodeFrame, FrameReader } from "@cosyte/mllp";
import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { EXIT, run } from "../src/cli.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import {
  channelSchema,
  configJsonSchemas,
  DEFAULT_DRAIN_TIMEOUT_MS,
  projectSchema,
} from "../src/config/schema.js";
import { MllpSource, type MllpEvent, type MllpSourceOptions } from "../src/connectors/mllp.js";
import type { MessageSink, SourceConnector } from "../src/connectors/types.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/storage/store.js";
import { generateKey } from "../src/encryption/keys.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import { msaOf } from "./mllp-helpers.js";
import { onPickedPorts, orTaken } from "./net-helpers.js";

const sources: MllpSource[] = [];
const gates: (() => void)[] = [];

afterEach(async () => {
  for (const open of gates.splice(0)) open();
  await Promise.all(sources.splice(0).map((source) => source.stop()));
  await cleanUp();
});

const MSG = (n: number): string => ADT_A01.replace("MSG00001", `MSG0000${String(n)}`);

/** A gate a test opens: `wait` settles once `open` is called. Opened after each test regardless. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.push(open);
  return { wait, open };
}

/** A sink that counts what it stores, and holds each store until `held` settles. */
function holdingSink(held: Promise<void> = Promise.resolve()): {
  sink: MessageSink;
  stored: string[];
} {
  const stored: string[] = [];
  return {
    stored,
    sink: {
      receive: async (body) => {
        stored.push(Buffer.from(body).toString("latin1"));
        const id = stored.length;
        await held;
        return id;
      },
    },
  };
}

async function startSource(
  sink: MessageSink,
  options: Partial<MllpSourceOptions> = {},
): Promise<{ source: MllpSource; port: number; events: MllpEvent[] }> {
  const events: MllpEvent[] = [];
  const source = new MllpSource({
    host: "127.0.0.1",
    port: 0,
    tls: undefined,
    onEvent: (event) => events.push(event),
    ...options,
  });
  sources.push(source);
  await source.start(sink);
  return { source, port: source.port ?? 0, events };
}

/** An open plain connection to `port`: the ACKs it got, and when the peer closed it. */
interface Held {
  readonly socket: Socket;
  readonly replies: string[];
  readonly closed: Promise<number>;
  isClosed(): boolean;
}

function hold(port: number): Promise<Held> {
  const socket = netConnect({ host: "127.0.0.1", port });
  const replies: string[] = [];
  const reader = new FrameReader({ onFrame: (bytes) => replies.push(bytes.toString("latin1")) });
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("error", () => undefined);
  let isClosed = false;
  const closed = new Promise<number>((resolve) =>
    socket.once("close", () => {
      isClosed = true;
      resolve(Date.now());
    }),
  );
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => resolve({ socket, replies, closed, isClosed: () => isClosed }));
  });
}

/** Whether a new connection to `port` is refused. */
async function refused(port: number): Promise<boolean> {
  try {
    const held = await hold(port);
    held.socket.destroy();
    return false;
  } catch {
    return true;
  }
}

/** Waits until `check` holds, for at most `ms`; throws, naming `what`, when it does not. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("an MLLP source told to stop", () => {
  it("stops listening at once, closes an idle connection at once, and a busy one after its ACK", async () => {
    const store = gate();
    const { sink, stored } = holdingSink(store.wait);
    const { source, port } = await startSource(sink, { drainTimeoutMs: 10_000 });
    const idle = await hold(port);
    const busy = await hold(port);
    busy.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
    await until(() => stored.length === 1, "the message to reach the store");

    const stopped = source.stop();
    await until(() => idle.isClosed(), "the idle connection to close");
    expect(await refused(port)).toBe(true);
    // A message on the busy connection after the stop began is neither stored nor answered.
    busy.socket.write(encodeFrame(Buffer.from(MSG(2), "latin1")));
    await sleep(100);
    expect(busy.isClosed()).toBe(false);
    expect(busy.replies).toEqual([]);

    store.open();
    await stopped;
    await busy.closed;
    expect(busy.replies.map((ack) => msaOf(ack))).toEqual([["AA", "MSG00001"]]);
    expect(stored).toHaveLength(1);
  });

  it("cuts a connection whose message is still being stored at drainTimeoutMs, unanswered", async () => {
    const store = gate();
    const { sink, stored } = holdingSink(store.wait);
    const { source, port } = await startSource(sink, { drainTimeoutMs: 200 });
    const busy = await hold(port);
    busy.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
    await until(() => stored.length === 1, "the message to reach the store");

    const began = Date.now();
    await source.stop();
    expect(Date.now() - began).toBeLessThan(2_000);
    await busy.closed;
    // Not acknowledged, so the sender sends it again.
    expect(busy.replies).toEqual([]);
  });

  it("drains by default within 30 seconds", () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(30_000);
  });
});

describe("an MLLP source's maxConnectionAge", () => {
  it("closes a connection after the message that finds it older than the age, once its ACK is out", async () => {
    const { sink, stored } = holdingSink();
    const { port, events } = await startSource(sink, { maxConnectionAgeMs: 300 });
    const old = await hold(port);
    old.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
    await until(() => old.replies.length === 1, "the first ACK");
    // Young: it stays open after its ACK.
    await sleep(50);
    expect(old.isClosed()).toBe(false);

    await sleep(300);
    const young = await hold(port);
    old.socket.write(encodeFrame(Buffer.from(MSG(2), "latin1")));
    young.socket.write(encodeFrame(Buffer.from(MSG(3), "latin1")));
    await old.closed;
    expect(old.replies.map((ack) => msaOf(ack))).toEqual([
      ["AA", "MSG00001"],
      ["AA", "MSG00002"],
    ]);
    await until(() => young.replies.length === 1, "the young connection's ACK");
    await sleep(50);
    expect(young.isClosed()).toBe(false);
    expect(stored).toHaveLength(3);
    expect(events).toContainEqual({
      level: "info",
      event: "mllp-connection-aged",
      maxConnectionAgeMs: 300,
    });
    young.socket.destroy();
  });

  it("is off by default: an old connection stays open", async () => {
    const { sink } = holdingSink();
    const { port } = await startSource(sink);
    const held = await hold(port);
    await sleep(300);
    held.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
    await until(() => held.replies.length === 1, "the ACK");
    await sleep(50);
    expect(held.isClosed()).toBe(false);
    held.socket.destroy();
  });
});

const KEYS = "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n";
const FILE_CHANNEL =
  "source:\n  file: { dir: ../../data/inbox }\ndestinations:\n  - file: { dir: ../../data/out }\n";

async function problemsOf(files: Record<string, string>): Promise<readonly string[]> {
  const root = await makeProject(files);
  try {
    await loadProject(root);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("the drain block and maxConnectionAge", () => {
  const schemas = configJsonSchemas();
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  const json = { project: ajv.compile(schemas.project), channel: ajv.compile(schemas.channel) };

  /** Whether Zod and the editor's JSON Schema each accept `yaml`. */
  function verdicts(kind: "project" | "channel", yaml: string) {
    const value = parseYaml(yaml) as unknown;
    const zod = kind === "project" ? projectSchema : channelSchema;
    return { zod: zod.safeParse(value).success, schema: json[kind](value) };
  }

  it("default to no delay and 30 seconds, and read durations", async () => {
    const plain = await makeProject({ "channels/a/channel.yaml": FILE_CHANNEL });
    expect((await loadProject(plain)).drain).toEqual({
      notReadyDelayMs: 0,
      timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
    });
    const set = await makeProject({
      "pathways.yaml": "drain: { notReadyDelay: 10s, timeout: 2m }\n",
      "channels/a/channel.yaml":
        "format: hl7v2\nsource:\n  mllp: { port: 2575, plaintext: true, maxConnectionAge: 1h }\n" +
        "destinations:\n  - file: { dir: ../../data/out }\n",
    });
    const project = await loadProject(set);
    expect(project.drain).toEqual({ notReadyDelayMs: 10_000, timeoutMs: 120_000 });
    expect(project.channels[0]?.source).toMatchObject({ maxConnectionAgeMs: 3_600_000 });
  });

  it("refuse what is not a duration a timer can hold, in Zod and in the editor's schema alike", async () => {
    for (const bad of [
      "drain: { notReadyDelay: soon }",
      "drain: { timeout: -1 }",
      "drain: { grace: 5s }",
    ]) {
      expect(verdicts("project", bad), bad).toEqual({ zod: false, schema: false });
    }
    // Past the longest wait a timer holds: start refuses it, the editor's schema reads the shape.
    for (const bad of ["drain: { timeout: 25d }", "drain: { notReadyDelay: 2147483648 }"]) {
      expect(verdicts("project", bad).zod, bad).toBe(false);
    }
    for (const good of [
      "drain: { notReadyDelay: 0, timeout: 0 }",
      "drain: { notReadyDelay: 15s, timeout: 24d }",
      "drain: {}",
    ]) {
      expect(verdicts("project", good), good).toEqual({ zod: true, schema: true });
    }
    const mllp = (extra: string): string =>
      `format: hl7v2\nsource:\n  mllp: { port: 2575, plaintext: true, ${extra} }\n` +
      "destinations:\n  - file: { dir: ./out }\n";
    for (const bad of ["maxConnectionAge: 0", "maxConnectionAge: 25d"]) {
      expect(verdicts("channel", mllp(bad)).zod, bad).toBe(false);
    }
    expect(verdicts("channel", mllp("maxConnectionAge: old"))).toEqual({
      zod: false,
      schema: false,
    });
    expect(verdicts("channel", mllp("maxConnectionAge: 10m"))).toEqual({ zod: true, schema: true });
    expect(
      await problemsOf({
        "pathways.yaml": "drain: { timeout: 25d }\n",
        "channels/a/channel.yaml": FILE_CHANNEL,
      }),
    ).toEqual(['pathways.yaml: drain.timeout: a duration from 0 to about 24 days, such as "30s"']);
  });
});

interface Result {
  readonly code: number;
  readonly err: string;
}

/** `pathways <argv>` in this process, stopped by `signal`, its log events captured. */
function runCli(
  argv: readonly string[],
  signal?: AbortSignal,
): { done: Promise<Result>; events: LogEvent[] } {
  let err = "";
  const { logger, events } = captureLogger();
  const done = run(argv, {
    out: () => undefined,
    err: (text) => {
      err += text;
    },
    logger,
    ...(signal === undefined ? {} : { signal }),
  }).then((code) => ({ code, err }));
  return { done, events };
}

/** GETs a path over plain HTTP: its status and body, or undefined when nothing answers. */
async function get(port: number, path: string) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
}

/**
 * A destination that appends what it is handed to `sent.jsonl` beside it: the message id and its
 * resend flag. While a file named `hang` sits beside it, a send never ends unless it is cut off.
 */
const RECORDING_DESTINATION = `
import { appendFileSync, existsSync } from "node:fs";
interface Outgoing { messageId: number; resend?: { previousAttempts: number }; signal?: AbortSignal }
export default () => ({
  async deliver(message: Outgoing): Promise<void> {
    if (existsSync(new URL("./hang", import.meta.url))) {
      appendFileSync(new URL("./hanging", import.meta.url), "");
      await new Promise((_resolve, reject) => {
        message.signal?.addEventListener("abort", () => reject(new Error("cut off")));
      });
    }
    const line = JSON.stringify({ id: message.messageId, resend: message.resend ?? null });
    appendFileSync(new URL("./sent.jsonl", import.meta.url), line + "\\n");
  },
});
`;

async function sentOf(root: string): Promise<{ id: number; resend: unknown }[]> {
  const text = await readFile(join(root, "sent.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: number; resend: unknown });
}

/** A project of one MLLP channel to the recording destination, with `yaml` in pathways.yaml. */
function mllpProject(yaml: string, mllpPort: number): Promise<string> {
  return makeProject({
    "test.key": `${generateKey()}\n`,
    "pathways.yaml": `${KEYS}lease:\n  ttl: 10m\ndefaults:\n  pollInterval: 20ms\n${yaml}`,
    "destination.ts": RECORDING_DESTINATION,
    "channels/adt/channel.yaml":
      `format: hl7v2\nsource:\n  mllp: { port: ${String(mllpPort)}, plaintext: true }\n` +
      "destinations:\n  - module: ../../destination.ts\n",
  });
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("pathways start, told to stop", () => {
  it("reports draining, keeps taking messages for notReadyDelay, then closes its listener, releases its lease and exits 0", async () => {
    await onPickedPorts(2, async ([probePort = 0, mllpPort = 0]) => {
      const root = await mllpProject(
        `probes: { port: ${String(probePort)}, plaintext: true }\n` +
          "drain: { notReadyDelay: 1500ms, timeout: 5s }\n",
        mllpPort,
      );
      const stop = new AbortController();
      const started = runCli(["start", "-C", root], stop.signal);
      await orTaken(
        async () => {
          try {
            await until(
              async () => (await get(probePort, "/readyz"))?.status === 200,
              "ready",
              10_000,
            );
            const sender = await hold(mllpPort);
            stop.abort();
            const told = Date.now();
            // Not ready at once, while the listener still takes a new connection and its message.
            expect(await get(probePort, "/readyz")).toEqual({ status: 503, body: "draining\n" });
            const late = await hold(mllpPort);
            late.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
            await until(() => late.replies.length === 1, "the ACK during the delay");
            expect(msaOf(late.replies[0] ?? "")).toEqual(["AA", "MSG00001"]);
            expect(Date.now() - told).toBeLessThan(1_500);
            // After the delay the listener closes: the idle sender is let go, new ones refused.
            await sender.closed;
            expect(Date.now() - told).toBeGreaterThanOrEqual(1_400);
            expect(await refused(mllpPort)).toBe(true);
          } finally {
            stop.abort();
          }
          const ended = await started.done;
          expect(ended).toEqual({ code: EXIT.ok, err: "" });
          const names = started.events.map((e) => e.event);
          expect(started.events).toContainEqual(
            expect.objectContaining({
              event: "draining",
              notReadyDelayMs: 1_500,
              timeoutMs: 5_000,
            }),
          );
          expect(names.indexOf("draining")).toBeLessThan(names.indexOf("delivered"));
          expect(names).not.toContain("drain-timeout");
          expect(await sentOf(root)).toEqual([{ id: 1, resend: null }]);
          // The lease was released: a start at once takes it, though its time to live is 10 minutes.
          expect((await runCli(["start", "--once", "-C", root]).done).code).toBe(EXIT.ok);
        },
        async () => {
          stop.abort();
          return (await started.done).err;
        },
      );
    });
  }, 30_000);

  it("cuts off a send still in flight at drain.timeout, which the next start sends again, flagged", async () => {
    await onPickedPorts(1, async ([mllpPort = 0]) => {
      const root = await mllpProject("drain: { timeout: 300ms }\n", mllpPort);
      await writeFile(join(root, "hang"), "");
      const stop = new AbortController();
      const started = runCli(["start", "-C", root], stop.signal);
      await orTaken(
        async () => {
          try {
            await until(async () => !(await refused(mllpPort)), "the listener", 10_000);
            const sender = await hold(mllpPort);
            sender.socket.write(encodeFrame(Buffer.from(MSG(1), "latin1")));
            await until(() => sender.replies.length === 1, "the ACK");
            await until(() => exists(join(root, "hanging")), "the send to start");
            stop.abort();
            const told = Date.now();
            expect((await started.done).code).toBe(EXIT.ok);
            expect(Date.now() - told).toBeLessThan(3_000);
          } finally {
            stop.abort();
          }
          const names = started.events.map((e) => e.event);
          expect(names).toContain("drain-timeout");
          expect(names).toContain("delivery-halted");
          expect(names).not.toContain("delivered");
          expect(started.events).toContainEqual(
            expect.objectContaining({ event: "drain-timeout", timeoutMs: 300 }),
          );
          await rm(join(root, "hang"));
          expect((await runCli(["start", "--once", "-C", root]).done).code).toBe(EXIT.ok);
          expect(await sentOf(root)).toEqual([{ id: 1, resend: { previousAttempts: 1 } }]);
        },
        async () => {
          stop.abort();
          return (await started.done).err;
        },
      );
    });
  }, 30_000);
});

/** A source the test drives: it counts its starts, stops and polls, and keeps its sink. */
class CountingSource implements SourceConnector {
  sink: MessageSink | undefined;
  starts = 0;
  stops = 0;
  polls = 0;

  start = (sink: MessageSink): Promise<void> => {
    this.starts += 1;
    this.sink = sink;
    return Promise.resolve();
  };

  stop = (): Promise<void> => {
    this.stops += 1;
    return Promise.resolve();
  };

  poll = (): Promise<void> => {
    this.polls += 1;
    return Promise.resolve();
  };
}

describe("an engine run told to stop", () => {
  it("closes its listening sources at once, beside the send under way, and opens or polls nothing after", async () => {
    const channel =
      "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ntransform: ./transform.ts\n" +
      "destinations:\n  - file: { dir: ../../data/out }\n";
    const root = await makeProject({
      "channels/a/channel.yaml": channel,
      "channels/a/transform.ts": LAB_TRANSFORM,
      "channels/b/channel.yaml": channel,
      "channels/b/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    const listening = new CountingSource();
    const polled = new CountingSource();
    const send = gate();
    let sending = false;
    const engine = new Engine({
      project,
      store,
      logger: captureLogger().logger,
      connectors: (config) => ({
        source:
          config.name === "a"
            ? { start: listening.start, stop: listening.stop }
            : { poll: polled.poll, stop: polled.stop },
        destinations: [
          {
            deliver: async () => {
              sending = true;
              await send.wait;
            },
          },
        ],
      }),
    });
    try {
      await engine.start();
      expect(listening.starts).toBe(1);
      await engine.command("pause", "b", { actor: "test-operator" });
      await listening.sink?.receive(new TextEncoder().encode(ADT_A01));

      const stop = new AbortController();
      const running = engine.run(stop.signal);
      await until(() => sending, "the send");
      stop.abort();
      // The listener closes while the send is still under way.
      await until(() => listening.stops === 1, "the listener to close");
      // A resume during the drain opens nothing, and the pass that follows polls nothing.
      await engine.command("resume", "b", { actor: "test-operator" });
      send.open();
      await running;
      expect(listening.starts).toBe(1);
      expect(polled.polls).toBe(0);
      expect(await store.deliveryCounts("a")).toMatchObject({ pending: 0, delivered: 1 });
    } finally {
      send.open();
      await engine.stop();
      await store.close();
    }
  });

  it("stops at once, exiting 0, when told to stop before it starts", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml": KEYS,
      "channels/a/channel.yaml": FILE_CHANNEL,
    });
    const stop = new AbortController();
    stop.abort();
    const started = runCli(["start", "-C", root], stop.signal);
    expect(await started.done).toEqual({ code: EXIT.ok, err: "" });
    expect(started.events).toContainEqual(expect.objectContaining({ event: "draining" }));
  });
});
