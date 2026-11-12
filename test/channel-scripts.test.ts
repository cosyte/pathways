// A channel's scripts: the onStart and onStop its transform.ts may export beside the transform. Each
// runs in the channel's worker; onStart on every new worker, onStop before a worker is ended.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { DestinationConnector, SourceConnector } from "../src/connectors/types.js";
import {
  ChannelWorker,
  TransformLoadError,
  type ChannelWorkerOptions,
} from "../src/engine/channel-worker.js";
import { Engine, settledState } from "../src/engine/engine.js";
import {
  freezeDeep,
  isStopRequest,
  loadScripts,
  runOnStart,
  runOnStop,
  scriptContext,
  scriptLogLine,
  summarize,
  type ScriptLogLine,
} from "../src/engine/worker-entry.js";
import { AuditLog } from "../src/operator/audit.js";
import { recordEngineStart, recordEngineStop } from "../src/operator/engine-audit.js";
import { MemoryStore } from "./memory-store.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

const workers: ChannelWorker[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await cleanUp();
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A transform module whose scripts append a line to `journal` in the project's root: `start` for
 * each onStart, `stop` for each onStop. `body` is put in front of each script's own code.
 */
function scripts(options: { onStart?: string; onStop?: string; transform?: string } = {}): string {
  return `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const journal = join(import.meta.dirname, "journal");
export default ${options.transform ?? "(m: string): string => m"};
export async function onStart(ctx: { channel: string; config: Record<string, unknown>; logger: { info(code: string, ids?: Record<string, number>): void } }): Promise<void> {
  ${options.onStart ?? ""}
  appendFileSync(journal, "start\\n");
}
export async function onStop(): Promise<void> {
  ${options.onStop ?? ""}
  appendFileSync(journal, "stop\\n");
}
`;
}

/** Never settles, and keeps the worker's thread alive meanwhile, as a script stuck on I/O does. */
const HANG = "await new Promise(() => { setInterval(() => undefined, 1_000); });";

async function journal(root: string): Promise<string[]> {
  return (await readFile(join(root, "journal"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
}

async function workerFor(
  source: string,
  options: Partial<ChannelWorkerOptions> = {},
): Promise<{ worker: ChannelWorker; root: string }> {
  const root = await makeProject({ "transform.ts": source });
  const worker = new ChannelWorker({
    channel: "scripted",
    transformFile: join(root, "transform.ts"),
    format: "text",
    timeoutMs: 5_000,
    memoryMb: 256,
    ...options,
  });
  workers.push(worker);
  return { worker, root };
}

describe("onStart", () => {
  it("runs before the worker takes its first message, with the channel, its configuration and an ids-only logger", async () => {
    const { logger, events } = captureLogger();
    const { worker, root } = await workerFor(
      scripts({
        onStart: `
          if (ctx.channel !== "scripted" || ctx.config["facility"] !== "TESTFAC") throw new Error("context");
          if (!Object.isFrozen(ctx) || !Object.isFrozen(ctx.config)) throw new Error("not frozen");
          ctx.logger.info("lookup-loaded", { entries: 3, name: "TESTPATIENT" as unknown as number });
          ctx.logger.info("Not A Code: TESTPATIENT");`,
      }),
      { config: { facility: "TESTFAC" }, logger },
    );
    await worker.start();
    expect(await journal(root)).toEqual(["start"]);
    expect(await worker.run(bytes("x"))).toEqual({ ok: true, outputs: [bytes("x")] });
    const lines = events.filter((event) => event.event === "channel-script");
    expect(lines).toEqual([
      expect.objectContaining({ channel: "scripted", code: "lookup-loaded", ids: { entries: 3 } }),
      expect.objectContaining({ channel: "scripted", code: "script-log", ids: {} }),
    ]);
    expect(JSON.stringify(events)).not.toContain("TESTPATIENT");
  });

  it("is a load failure when it throws: the worker does not start", async () => {
    const { worker } = await workerFor(
      scripts({ onStart: 'throw new RangeError("synthetic onStart failure");' }),
    );
    const error = await worker.start().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransformLoadError);
    expect((error as TransformLoadError).failure).toMatchObject({
      kind: "load",
      name: "RangeError",
      code: "ON_START_FAILED",
      where: expect.stringMatching(/^transform\.ts:\d+:\d+$/) as unknown,
    });
  });

  it("is a load failure when it runs past its limit, and the worker is ended", async () => {
    const { worker, root } = await workerFor(scripts({ onStart: HANG }), { scriptTimeoutMs: 200 });
    const began = Date.now();
    const error = await worker.start().catch((thrown: unknown) => thrown);
    expect(Date.now() - began).toBeLessThan(4_000);
    expect(error).toBeInstanceOf(TransformLoadError);
    expect((error as TransformLoadError).failure).toMatchObject({
      kind: "timeout",
      code: "ON_START_TIMEOUT",
    });
    expect(await journal(root)).toEqual([]);
  });

  it("is timed from when it begins, not from the module's load", async () => {
    // A limit shorter than loading the worker takes: only onStart's own run counts against it.
    const { worker, root } = await workerFor(scripts(), { scriptTimeoutMs: 50 });
    await worker.start();
    expect(await journal(root)).toEqual(["start"]);
  });

  it("runs again in the replacement worker after a transform runs past its timeout", async () => {
    const { worker, root } = await workerFor(
      scripts({
        transform:
          "(m: string): string => { if (m === 'hang') { for (;;) { /* runs past the timeout */ } } return m; }",
      }),
      { timeoutMs: 300, scriptTimeoutMs: 5_000 },
    );
    expect((await worker.run(bytes("one"))).ok).toBe(true);
    expect(await worker.run(bytes("hang"))).toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
    expect((await worker.run(bytes("two"))).ok).toBe(true);
    // No onStop for the worker that was ended for running past its timeout.
    expect(await journal(root)).toEqual(["start", "start"]);
  });

  it("makes a worker that crashed fail to start again when it throws the second time", async () => {
    const { worker } = await workerFor(
      scripts({
        onStart: `
          const { existsSync, writeFileSync } = await import("node:fs");
          const once = join(import.meta.dirname, "once");
          if (existsSync(once)) throw new Error("synthetic second start");
          writeFileSync(once, "");`,
        transform: "(m: string): string => { if (m === 'crash') process.exit(3); return m; }",
      }),
    );
    expect(await worker.run(bytes("crash"))).toMatchObject({
      ok: false,
      failure: { kind: "crash" },
    });
    const error = await worker.run(bytes("next")).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransformLoadError);
    expect((error as TransformLoadError).failure).toMatchObject({ code: "ON_START_FAILED" });
  });
});

describe("onStop", () => {
  it("runs when the worker stops, after its last message", async () => {
    const { worker, root } = await workerFor(scripts());
    expect((await worker.run(bytes("x"))).ok).toBe(true);
    await worker.stop();
    expect(await journal(root)).toEqual(["start", "stop"]);
  });

  it("is cut at its limit, noted by its channel, and the worker ends", async () => {
    const { logger, events } = captureLogger();
    const { worker, root } = await workerFor(
      scripts({ onStop: "await new Promise(() => undefined);" }),
      { scriptTimeoutMs: 200, logger },
    );
    await worker.start();
    const began = Date.now();
    await worker.stop();
    expect(Date.now() - began).toBeLessThan(4_000);
    expect(await journal(root)).toEqual(["start"]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "on-stop-timeout", channel: "scripted", limitMs: 200 }),
    );
  });

  it("defaults its limit to the transform timeout", async () => {
    const { logger, events } = captureLogger();
    const { worker } = await workerFor(scripts({ onStop: "await new Promise(() => undefined);" }), {
      timeoutMs: 150,
      logger,
    });
    await worker.start();
    await worker.stop();
    expect(events).toContainEqual(
      expect.objectContaining({ event: "on-stop-timeout", limitMs: 150 }),
    );
  });

  it("is noted by name and code when it throws, and the worker ends", async () => {
    const { logger, events } = captureLogger();
    const { worker } = await workerFor(
      scripts({ onStop: 'throw new TypeError("synthetic onStop failure");' }),
      { logger },
    );
    await worker.start();
    await worker.stop();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "on-stop-failed",
        name: "TypeError",
        code: "ON_STOP_FAILED",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("synthetic onStop failure");
  });

  it("follows an onStart still running when the stop comes, once it is done", async () => {
    const { worker, root } = await workerFor(
      scripts({ onStart: "await new Promise((resolve) => setTimeout(resolve, 300));" }),
    );
    const starting = worker.start();
    // Stopped while onStart runs: the stop waits for it, then runs onStop and ends the worker.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.stop();
    await starting;
    expect(await journal(root)).toEqual(["start", "stop"]);
  });

  it("is not run when onStart ran past its limit and the stop came meanwhile", async () => {
    const { worker, root } = await workerFor(scripts({ onStart: HANG }), { scriptTimeoutMs: 200 });
    const starting = worker.start().catch((thrown: unknown) => thrown);
    await worker.stop();
    expect(await starting).toBeInstanceOf(TransformLoadError);
    expect(await journal(root)).toEqual([]);
  });
});

describe("scriptLogLine", () => {
  it("keeps a code of lower-case words and finite numbers under plain names, at most 16", () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${String(i)}`, i]));
    expect(
      scriptLogLine("warn", "cache-warmed", { a: 1, "b c": 2, d: Number.NaN, e: "x" }),
    ).toEqual({
      level: "warn",
      code: "cache-warmed",
      ids: { a: 1 },
    });
    expect(Object.keys(scriptLogLine("info", "x", many).ids)).toHaveLength(16);
    expect(scriptLogLine("error", "Has Spaces", undefined).code).toBe("script-log");
    expect(scriptLogLine("info", 42, null)).toEqual({ level: "info", code: "script-log", ids: {} });
  });
});

/** A source that hands the engine the bodies queued in `inbox` on each poll. */
function queueSource(inbox: string[]): SourceConnector {
  return {
    async poll(sink) {
      for (const body of inbox.splice(0)) await sink.receive(bytes(body));
    },
  };
}

describe("a replacement worker whose onStart fails, in the engine", () => {
  it("stops that channel, says why on the health endpoint, and runs the others", async () => {
    const onStart = `
      const { existsSync, writeFileSync } = await import("node:fs");
      const once = join(import.meta.dirname, "once");
      if (existsSync(once)) throw new RangeError("synthetic second start");
      writeFileSync(once, "");`;
    const root = await makeProject({
      "channels/flaky/channel.yaml":
        "format: text\nsource:\n  file: { dir: ../../data/in-flaky }\ntransform: ./transform.ts\ntimeout: 300ms\n" +
        "destinations:\n  - file: { dir: ../../data/out-flaky }\n",
      "channels/flaky/transform.ts": scripts({
        onStart,
        transform:
          "(m: string): string => { if (m === 'hang') { for (;;) { /* past the timeout */ } } return m; }",
      }),
      "channels/steady/channel.yaml":
        "format: text\nsource:\n  file: { dir: ../../data/in-steady }\ntransform: ./transform.ts\n" +
        "destinations:\n  - file: { dir: ../../data/out-steady }\n",
      "channels/steady/transform.ts": scripts(),
    });
    const project = await loadProject(root);
    const inboxes: Record<string, string[]> = { flaky: ["hang", "after"], steady: ["fine"] };
    const delivered: Record<string, string[]> = { flaky: [], steady: [] };
    const { logger, events } = captureLogger();
    const store = new MemoryStore();
    const engine = new Engine({
      project,
      store,
      logger,
      connectors: (channel) => ({
        source: queueSource(inboxes[channel.name] ?? []),
        destinations: [
          {
            deliver(message) {
              delivered[channel.name]?.push(new TextDecoder().decode(message.body));
              return Promise.resolve();
            },
          } satisfies DestinationConnector,
        ],
      }),
    });
    engines.push(engine);
    await engine.start();
    await engine.tick();

    // The first message ran past its timeout; its replacement worker's onStart threw.
    expect(delivered).toEqual({ flaky: [], steady: ["fine"] });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "transform-load-failed",
        channel: "flaky",
        name: "RangeError",
        code: "ON_START_FAILED",
      }),
    );
    const health = await engine.health();
    expect(health.status).toBe("unavailable");
    expect(health.channels["flaky"]?.transform).toEqual({
      loaded: false,
      kind: "load",
      name: "RangeError",
      code: "ON_START_FAILED",
    });
    expect(health.channels["steady"]?.transform).toBeUndefined();
    // The message it held waits, untransformed, for a reload.
    expect((await store.messageCounts("flaky")).received).toBe(1);

    // The other channel runs on; the stopped one takes no part in a pass.
    inboxes["steady"]?.push("more");
    await engine.tick();
    expect(delivered).toEqual({ flaky: [], steady: ["fine", "more"] });
  }, 20_000);
});

describe("the worker's script helpers", () => {
  it("build a frozen context whose logger posts checked lines", () => {
    const lines: ScriptLogLine[] = [];
    const ctx = scriptContext("adt", freezeDeep({ facility: "TESTFAC" }), (line) =>
      lines.push(line),
    ) as {
      channel: string;
      config: Record<string, unknown>;
      logger: Record<"info" | "warn" | "error", (code: unknown, ids?: unknown) => void>;
    };
    expect(Object.isFrozen(ctx) && Object.isFrozen(ctx.logger)).toBe(true);
    expect(ctx.channel).toBe("adt");
    ctx.logger.info("one", { n: 1 });
    ctx.logger.warn("two");
    ctx.logger.error("three", { s: "TESTPATIENT" });
    expect(lines).toEqual([
      { level: "info", code: "one", ids: { n: 1 } },
      { level: "warn", code: "two", ids: {} },
      { level: "error", code: "three", ids: {} },
    ]);
  });

  it("run onStart, and make its throw a load failure with a fallback code", async () => {
    await runOnStart(undefined, {});
    const seen: unknown[] = [];
    await runOnStart((ctx) => seen.push(ctx), "ctx");
    expect(seen).toEqual(["ctx"]);
    const thrown = await runOnStart(() => {
      throw new RangeError("synthetic");
    }, {}).catch((error: unknown) => error);
    expect(summarize(thrown)).toMatchObject({
      kind: "load",
      name: "RangeError",
      code: "ON_START_FAILED",
    });
    const coded = await runOnStart(() => {
      throw Object.assign(new Error("synthetic"), { code: "EOWN" });
    }, {}).catch((error: unknown) => error);
    expect(summarize(coded)).toMatchObject({ code: "EOWN" });
  });

  it("run onStop, and describe its throw without passing it on", async () => {
    expect(await runOnStop(undefined)).toEqual({ stopped: true });
    expect(await runOnStop(() => undefined)).toEqual({ stopped: true });
    expect(
      await runOnStop(() => {
        throw new TypeError("synthetic");
      }),
    ).toMatchObject({
      stopped: true,
      failure: { kind: "load", name: "TypeError", code: "ON_STOP_FAILED" },
    });
    expect(isStopRequest({ stop: true })).toBe(true);
    expect(isStopRequest({ id: 1 })).toBe(false);
    expect(isStopRequest(null)).toBe(false);
  });

  it("load a module's scripts, and refuse an onStart or onStop that is not a function", async () => {
    const root = await makeProject({
      "good.ts": "export default (m: string): string => m;\nexport function onStart(): void {}\n",
      "bad.ts": "export default (m: string): string => m;\nexport const onStop = 42;\n",
    });
    const good = await loadScripts(join(root, "good.ts"));
    expect(typeof good.onStart).toBe("function");
    expect(good.onStop).toBeUndefined();
    const none = await loadScripts(undefined);
    expect([none.onStart, none.onStop]).toEqual([undefined, undefined]);
    const bad = await loadScripts(join(root, "bad.ts")).catch((error: unknown) => error);
    expect(summarize(bad)).toMatchObject({ kind: "load", name: "TypeError" });
  });
});

describe("what a worker posts besides its replies", () => {
  it("logs only well-formed script lines, and only their numbers", async () => {
    const { logger, events } = captureLogger();
    const { worker } = await workerFor(
      `import { parentPort } from "node:worker_threads";
export default (m: string): string => {
  parentPort?.postMessage({ scriptLog: { level: "info", code: "posted", ids: { a: 1, "b c": 2, d: "TESTPATIENT" } } });
  parentPort?.postMessage({ scriptLog: { level: "info", code: "lots", ids: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["n" + i, i])) } });
  parentPort?.postMessage({ scriptLog: { level: "info", code: "no-ids", ids: null } });
  parentPort?.postMessage({ scriptLog: { level: "loud", code: "posted" } });
  parentPort?.postMessage({ scriptLog: { level: "info", code: "Not A Code" } });
  parentPort?.postMessage({ scriptLog: null });
  parentPort?.postMessage(null);
  parentPort?.postMessage({ hello: "nonsense" });
  return m;
};
`,
      { logger },
    );
    expect((await worker.run(bytes("x"))).ok).toBe(true);
    await worker.stop();
    const lines = events.filter((event) => event.event === "channel-script");
    expect(lines.map((line) => line["code"])).toEqual(["posted", "lots", "no-ids"]);
    expect(lines[0]?.["ids"]).toEqual({ a: 1 });
    expect(Object.keys(lines[1]?.["ids"] as object)).toHaveLength(16);
    expect(JSON.stringify(events)).not.toContain("TESTPATIENT");
  });

  it("spawns one worker for two starts asked at once", async () => {
    const { worker, root } = await workerFor(scripts());
    await Promise.all([worker.start(), worker.start()]);
    expect(await journal(root)).toEqual(["start"]);
  });

  it("drops script lines when the worker has no logger", async () => {
    const { worker, root } = await workerFor(
      scripts({ onStart: 'ctx.logger.info("dropped", { n: 1 });' }),
    );
    await worker.start();
    expect(await journal(root)).toEqual(["start"]);
  });

  it("ends the stop when onStop ends the worker itself", async () => {
    const { worker } = await workerFor(
      scripts({
        // A message of its own first, which the stop passes over, then the worker ends itself.
        onStop:
          'const { parentPort } = await import("node:worker_threads"); parentPort?.postMessage({ other: 1 }); process.exit(0);',
      }),
      {
        scriptTimeoutMs: 5_000,
      },
    );
    await worker.start();
    const began = Date.now();
    await worker.stop();
    expect(Date.now() - began).toBeLessThan(4_000);
  });
});

describe("scriptTimeout", () => {
  it("is read from a channel, over the project's defaults, and unset by default", async () => {
    const channel = (extra: string): string =>
      `format: text\nsource:\n  file: { dir: ./in }\n${extra}destinations:\n  - file: { dir: ./out }\n`;
    const root = await makeProject({
      "pathways.yaml": "defaults:\n  scriptTimeout: 3s\n",
      "channels/own/channel.yaml": channel("scriptTimeout: 2s\n"),
      "channels/project/channel.yaml": channel(""),
    });
    const project = await loadProject(root);
    const byName = Object.fromEntries(project.channels.map((c) => [c.name, c.settings]));
    expect(byName["own"]?.scriptTimeoutMs).toBe(2_000);
    expect(byName["project"]?.scriptTimeoutMs).toBe(3_000);
    const plain = await loadProject(
      await makeProject({ "channels/plain/channel.yaml": channel("") }),
    );
    expect(plain.channels[0]?.settings.scriptTimeoutMs).toBeUndefined();
  });
});

describe("settledState", () => {
  const at = (
    status: "transformed" | "filtered" | "failed" | "cleared",
    deliveries: string[] = [],
  ) => ({
    messageId: 1,
    channel: "adt",
    status,
    deliveries: deliveries.map((delivery) => ({
      destination: 0,
      status: delivery as "delivered" | "failed" | "cleared" | "dry-run" | "pending",
    })),
  });

  it("reads a destination's state from the message and its deliveries", () => {
    expect(settledState(at("filtered"), 0)).toBe("filtered");
    expect(settledState(at("cleared"), 0)).toBe("cleared");
    expect(settledState(at("failed"), 0)).toBe("failed");
    expect(settledState(at("transformed"), 0)).toBe("filtered");
    expect(settledState(at("transformed", ["delivered", "failed"]), 0)).toBe("failed");
    expect(settledState(at("transformed", ["delivered", "cleared"]), 0)).toBe("cleared");
    expect(settledState(at("transformed", ["dry-run"]), 0)).toBe("dry-run");
    expect(settledState(at("transformed", ["delivered", "delivered"]), 0)).toBe("delivered");
    expect(settledState(at("transformed", ["delivered"]), 1)).toBe("filtered");
  });
});

describe("recordEngineStop", () => {
  it("logs a write that fails by its code, and stops nothing", async () => {
    const { logger, events } = captureLogger();
    const store = new MemoryStore();
    const failing = Object.assign(Object.create(store) as MemoryStore, {
      appendAudit: () =>
        Promise.reject(Object.assign(new Error("synthetic"), { code: "SQLITE_FULL" })),
    });
    const particulars = { version: "0.0.0", channels: 1, node: "0a" };
    await recordEngineStop(new AuditLog(failing), particulars, logger);
    await recordEngineStop(
      new AuditLog(
        Object.assign(Object.create(store) as MemoryStore, {
          appendAudit: () => Promise.reject(new Error("x")),
        }),
      ),
      particulars,
      logger,
    );
    expect(events.filter((event) => event.event === "audit-failed")).toEqual([
      expect.objectContaining({ action: "engine-stop", code: "SQLITE_FULL" }),
      expect.not.objectContaining({ code: expect.anything() as unknown }),
    ]);
    await recordEngineStop(new AuditLog(store), particulars, logger);
    expect(store.auditRows.map((row) => row.action)).toEqual(["engine-stop"]);
  });
});

describe("recordEngineStart", () => {
  it("records an unclean shutdown first when the run before left no engine-stop", async () => {
    const store = new MemoryStore();
    const audit = new AuditLog(store);
    const run = (node: string) => ({ version: "0.0.0", channels: 2, node });
    await recordEngineStart(audit, store, run("0a"));
    await recordEngineStart(audit, store, run("0b"));
    await recordEngineStop(audit, run("0b"), captureLogger().logger);
    await recordEngineStart(audit, store, run("0c"));
    expect(store.auditRows.map((row) => [row.action, row.detail])).toEqual([
      ["engine-start", run("0a")],
      ["unclean-shutdown", { since: store.auditRows[0]?.id, version: "0.0.0", node: "0a" }],
      ["engine-start", run("0b")],
      ["engine-stop", run("0b")],
      ["engine-start", run("0c")],
    ]);
  });

  it("pairs a stop with its own node's start: a late stop from another node hides no crash", async () => {
    const store = new MemoryStore();
    const audit = new AuditLog(store);
    const { logger } = captureLogger();
    const run = (node: string) => ({ version: "0.0.0", channels: 2, node });
    // Node 0a runs; it loses its lease, 0b takes over, and 0a's late stop lands after 0b's start.
    // 0b is then killed, and 0c starts.
    await recordEngineStart(audit, store, run("0a"));
    await recordEngineStart(audit, store, run("0b"));
    await recordEngineStop(audit, run("0a"), logger);
    await recordEngineStart(audit, store, run("0c"));
    // 0c stops cleanly, and 0d finds nothing to record.
    await recordEngineStop(audit, run("0c"), logger);
    await recordEngineStart(audit, store, run("0d"));
    expect(store.auditRows.map((row) => [row.action, row.detail])).toEqual([
      ["engine-start", run("0a")],
      ["unclean-shutdown", { since: store.auditRows[0]?.id, version: "0.0.0", node: "0a" }],
      ["engine-start", run("0b")],
      ["engine-stop", run("0a")],
      ["unclean-shutdown", { since: store.auditRows[2]?.id, version: "0.0.0", node: "0b" }],
      ["engine-start", run("0c")],
      ["engine-stop", run("0c")],
      ["engine-start", run("0d")],
    ]);
  });

  it("reads past a page of other nodes' stops to find its run's own", async () => {
    const store = new MemoryStore();
    const audit = new AuditLog(store);
    const { logger } = captureLogger();
    const run = (node: string) => ({ version: "0.0.0", channels: 1, node });
    const lateStops = async (): Promise<void> => {
      for (let i = 0; i < 60; i += 1) await recordEngineStop(audit, run("ff"), logger);
    };
    await recordEngineStart(audit, store, run("0a"));
    await recordEngineStop(audit, run("0a"), logger);
    await lateStops();
    await recordEngineStart(audit, store, run("0b"));
    await lateStops();
    await recordEngineStart(audit, store, run("0c"));
    expect(
      store.auditRows.filter((row) => row.action !== "engine-stop").map((row) => row.action),
    ).toEqual(["engine-start", "engine-start", "unclean-shutdown", "engine-start"]);
  });
});
