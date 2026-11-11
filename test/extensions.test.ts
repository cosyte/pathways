import { readdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { loadProject } from "../src/config/load.js";
import { Engine } from "../src/engine/engine.js";
import {
  buildFromModule,
  ExtensionLoadError,
  isTimeout,
  loadDefaultFunction,
  methodsMissing,
  withTimeout,
} from "../src/extensions/load.js";
import { UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { openRawStore, openStore } from "../src/storage/open.js";
import { Store, type MessageStore } from "../src/storage/store.js";
import {
  CUSTOM_ACK,
  freshBench,
  HANGING_ACK,
  LIST_DESTINATION,
  LISTEN_SOURCE,
  MEMORY_STORE_FILE,
  POLL_SOURCE,
} from "./extension-helpers.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import { controlIdOf, exchange, msaOf } from "./mllp-helpers.js";
import { opened } from "./memory-store.js";
import { CLOSED_PORT, onPickedPorts, sourceListening } from "./net-helpers.js";

const engines: Engine[] = [];
const stores: MessageStore[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

interface Running {
  readonly root: string;
  readonly engine: Engine;
  readonly store: MessageStore;
  readonly events: LogEvent[];
  readonly lines: string[];
  readonly clock: { now: number };
}

/** Loads a project from `files`, opens its store, and starts an engine on it. */
async function startEngine(
  files: Record<string, string>,
  env: Record<string, string> = {},
): Promise<Running> {
  const root = await makeProject(files);
  const project = await loadProject(root);
  const { logger, events, lines } = captureLogger();
  const store = await openStore(project, { env, logger, keys: undefined });
  stores.push(store);
  const clock = { now: Date.now() };
  const engine = new Engine({ project, store, logger, env, now: () => clock.now });
  engines.push(engine);
  await engine.start();
  return { root, engine, store, events, lines, clock };
}

/**
 * {@link startEngine} with the channel's source on a port picked for it, picked again when a listener
 * in another test file's worker takes it first.
 */
async function startOnPort(
  files: (port: number) => Record<string, string>,
): Promise<Running & { readonly port: number }> {
  return onPickedPorts(1, async ([port = 0]) => {
    const running = await startEngine(files(port));
    await sourceListening(running.engine, "adt");
    return { ...running, port };
  });
}

/** Starts an engine on `files` and returns why it would not start. */
async function refusal(files: Record<string, string>): Promise<ExtensionLoadError> {
  const root = await makeProject(files);
  const project = await loadProject(root);
  const store = await Store.open(":memory:");
  stores.push(store);
  const engine = new Engine({ project, store, logger: captureLogger().logger, env: {} });
  const error: unknown = await engine.start().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ExtensionLoadError);
  return error as ExtensionLoadError;
}

const MODULE_CHANNEL = `
format: text
source:
  module: ./source.ts
  options: { key: in, extra: [1, 2] }
transform: ./transform.ts
destinations:
  - module: ./destination.ts
    options: { key: out }
  - file: { dir: ./out }
`;

const UPPER = "export default (text: string): string => text.toUpperCase();\n";

describe("loading an extension module", () => {
  it("returns a module's default export function", async () => {
    const root = await makeProject({ "m.ts": "export default (a: number): number => a + 1;\n" });
    const fn = await loadDefaultFunction(join(root, "m.ts"), "x.yaml: k", "a thing");
    expect(fn(1)).toBe(2);
  });

  it("names the file and key, and what to export, when the default export is missing or wrong", async () => {
    const root = await makeProject({
      "none.ts": "export const x = 1;\n",
      "number.ts": "export default 42;\n",
      "null.ts": "export default null;\n",
      "array.ts": "export default [1];\n",
    });
    const messages = await Promise.all(
      ["none", "number", "null", "array"].map((name) =>
        loadDefaultFunction(join(root, `${name}.ts`), "x.yaml: k", "a widget").catch(
          (error: unknown) => (error as Error).message,
        ),
      ),
    );
    expect(messages).toEqual([
      "x.yaml: k: the module has no default export; export default a widget",
      "x.yaml: k: the module's default export is a number, not a function; export default a widget",
      "x.yaml: k: the module's default export is a null, not a function; export default a widget",
      "x.yaml: k: the module's default export is a array, not a function; export default a widget",
    ]);
  });

  // A module reached through a link is named by its real path in the stack, and one whose stack
  // names only file URLs no path can be made of is placed nowhere: another host, which Linux and
  // macOS refuse, and no drive, which Windows refuses. A junction on Windows,
  // which needs no administrator's rights there; elsewhere the type is ignored.
  it("places an error in a module reached through a link, and none in a frame of another host", async () => {
    const root = await makeProject({
      "real/throws.ts": "throw new RangeError('synthetic TESTPATIENT');\n",
      "elsewhere.ts":
        "const error = new RangeError('synthetic');\n" +
        "error.stack = 'RangeError: synthetic\\n    at file://remote-host/share/elsewhere.ts:1:1" +
        "\\n    at file:///share/elsewhere.ts:1:1';\n" +
        "throw error;\n",
    });
    await symlink(join(root, "real"), join(root, "linked"), "junction");
    const linked = (await loadDefaultFunction(
      join(root, "linked", "throws.ts"),
      "x.yaml: k",
      "a thing",
    ).catch((e: unknown) => e)) as ExtensionLoadError;
    expect(linked.problem).toMatch(
      /^the module could not be loaded \(RangeError at throws\.ts:1:\d+\)$/,
    );
    const remote = (await loadDefaultFunction(
      join(root, "elsewhere.ts"),
      "x.yaml: k",
      "a thing",
    ).catch((e: unknown) => e)) as ExtensionLoadError;
    expect(remote.problem).toBe("the module could not be loaded (RangeError)");
  });

  it("reports a module that throws on load by error name and place, never its text", async () => {
    const root = await makeProject({
      "throws.ts": "throw new RangeError('synthetic TESTPATIENT');\n",
      "broken.ts": "export default (;\n",
      "string.ts": "throw 'synthetic TESTPATIENT';\n",
    });
    const error = (await loadDefaultFunction(join(root, "throws.ts"), "x.yaml: k", "a thing").catch(
      (e: unknown) => e,
    )) as ExtensionLoadError;
    expect(error).toBeInstanceOf(ExtensionLoadError);
    expect(error.name).toBe("ExtensionLoadError");
    expect(error.where).toBe("x.yaml: k");
    expect(error.problem).toMatch(
      /^the module could not be loaded \(RangeError at throws\.ts:1:\d+\)$/,
    );
    expect(error.message).not.toContain("TESTPATIENT");

    // A syntax error's name depends on the loader (Node's type stripping, or the test runner's);
    // either way it is named, and nothing it quotes is.
    const broken = (await loadDefaultFunction(
      join(root, "broken.ts"),
      "x.yaml: k",
      "a thing",
    ).catch((e: unknown) => e)) as ExtensionLoadError;
    expect(broken.problem).toMatch(/^the module could not be loaded \(\w+/);

    const thrown = (await loadDefaultFunction(
      join(root, "string.ts"),
      "x.yaml: k",
      "a thing",
    ).catch((e: unknown) => e)) as ExtensionLoadError;
    expect(thrown.problem).toBe("the module could not be loaded (string)");
  });

  it("builds from a factory, and names a factory that throws or returns the wrong shape", async () => {
    const root = await makeProject({
      "ok.ts":
        "export default async (o: { n: number }, c: { k: string }) => ({ go: () => o.n, k: c.k });\n",
      "throws.ts":
        "export default () => { throw Object.assign(new Error('synthetic secret'), { code: 'ECONNREFUSED' }); };\n",
      "number.ts": "export default () => 7;\n",
    });
    const check = (value: unknown): string | undefined =>
      methodsMissing(value, "a goer", ["go"], ["stop"]);
    const built = await buildFromModule<{ go(): number; k: string }>(
      join(root, "ok.ts"),
      "x.yaml: k",
      "a goer factory",
      { n: 3 },
      { k: "context" },
      check,
    );
    expect([built.go(), built.k]).toEqual([3, "context"]);

    const threw = await buildFromModule(
      join(root, "throws.ts"),
      "x.yaml: k",
      "f",
      {},
      {},
      check,
    ).catch((e: unknown) => (e as Error).message);
    expect(threw).toMatch(
      /^x\.yaml: k: the factory threw \(Error ECONNREFUSED at throws\.ts:1:\d+\)$/,
    );
    expect(threw).not.toContain("secret");

    const number = await buildFromModule(
      join(root, "number.ts"),
      "x.yaml: k",
      "f",
      {},
      {},
      check,
    ).catch((e: unknown) => (e as Error).message);
    expect(number).toBe("x.yaml: k: the factory did not return a goer: it returned a number");
  });

  it("checks required and optional methods, and says which are wrong", () => {
    expect(methodsMissing({ go: () => 1 }, "a goer", ["go"], ["stop"])).toBeUndefined();
    expect(methodsMissing({ go: 1 }, "a goer", ["go"])).toBe("a goer: go must be a method");
    expect(methodsMissing({ stop: "no" }, "a goer", ["go"], ["stop"])).toBe(
      "a goer: go, stop must be methods",
    );
    expect(methodsMissing(null, "a goer", ["go"])).toBe("a goer: it returned a null");
  });
});

describe("withTimeout", () => {
  it("passes a result or a failure through, synchronous throws included", async () => {
    expect(await withTimeout(() => 5, 1_000)).toBe(5);
    expect(await withTimeout(() => Promise.resolve("done"), 1_000)).toBe("done");
    const thrown = await withTimeout(() => {
      throw new TypeError("synthetic");
    }, 1_000).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(TypeError);
    expect(isTimeout(thrown)).toBe(false);
  });

  it("gives up after the time limit, aborting the work's signal", async () => {
    let seen: AbortSignal | undefined;
    const error = await withTimeout((signal) => {
      seen = signal;
      return new Promise(() => undefined);
    }, 20).catch((e: unknown) => e);
    expect(isTimeout(error)).toBe(true);
    expect(error).toMatchObject({ name: "TimeoutError", code: "EXTENSION_TIMEOUT" });
    expect(seen?.aborted).toBe(true);
    // A late failure of abandoned work is dropped, not left unhandled.
    await withTimeout(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 30)),
      10,
    ).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});

describe("custom connectors", () => {
  it("takes messages in from a custom source and delivers them through a custom destination", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one", "synthetic two"];
    const { root, engine, store, lines, events } = await startEngine(
      {
        "channels/text/channel.yaml": MODULE_CHANNEL,
        "channels/text/source.ts": POLL_SOURCE,
        "channels/text/destination.ts": LIST_DESTINATION,
        "channels/text/transform.ts": UPPER,
      },
      { SYNTH_TOKEN: "synthetic-token-value" },
    );
    await engine.tick();

    expect(bench.outbox["out"]).toEqual(["SYNTHETIC ONE", "SYNTHETIC TWO"]);
    expect(await readdir(join(root, "channels/text/out"))).toEqual(["1-1.txt", "2-1.txt"]);
    expect(await store.deliveryCounts("text")).toEqual({
      pending: 0,
      delivered: 4,
      failed: 0,
      cleared: 0,
    });
    // The factory got its options as written, and the channel's context.
    expect(bench.notes["source"]).toEqual([
      {
        options: { key: "in", extra: [1, 2] },
        channel: "text",
        format: "text",
        dir: join(root, "channels/text"),
        token: "synthetic-token-value",
      },
    ]);
    // Its log lines carry the channel and which extension wrote them.
    expect(events).toContainEqual(
      expect.objectContaining({ event: "source-built", channel: "text", extension: "source" }),
    );
    expect(lines.join("")).not.toContain("SYNTHETIC");

    await engine.stop();
    expect(bench.notes["destination"]).toEqual(["stopped"]);
  });

  it("starts and stops a listening custom source, and holds one that cannot start", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic listened"];
    bench.script["in"] = ["fail"];
    const { engine, store, events, clock } = await startEngine({
      "channels/text/channel.yaml": `format: text\nsource:\n  module: ./source.ts\n  options: { key: in }\ndestinations:\n  - module: ./destination.ts\n    options: { key: out }\n`,
      "channels/text/source.ts": LISTEN_SOURCE,
      "channels/text/destination.ts": LIST_DESTINATION,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ event: "source-start-failed", code: "EADDRINUSE" }),
    );
    expect((await engine.health()).channels["text"]?.source).toBe("down");

    clock.now += 1_000;
    await engine.tick();
    expect(bench.notes["listen"]).toEqual(["started"]);
    expect(bench.outbox["out"]).toEqual(["synthetic listened"]);
    expect(await store.messageCounts("text")).toMatchObject({ transformed: 1 });

    await engine.stop();
    expect(bench.notes["listen"]).toEqual(["started", "stopped"]);
  });

  it("retries a custom destination's failure, and fails a rejection from another copy of Pathways", async () => {
    const bench = freshBench();
    bench.inbox["in"] = ["synthetic one", "synthetic two"];
    bench.script["out"] = ["retry", "ok", "reject"];
    const { engine, store, events, clock } = await startEngine({
      "channels/text/channel.yaml": `format: text\nsource:\n  module: ./source.ts\n  options: { key: in }\ndestinations:\n  - module: ./destination.ts\n    options: { key: out }\n`,
      "channels/text/source.ts": POLL_SOURCE,
      "channels/text/destination.ts": LIST_DESTINATION,
    });
    await engine.tick();
    expect(events).toContainEqual(
      expect.objectContaining({ event: "delivery-retry", attempt: 1, code: "ECONNRESET" }),
    );
    clock.now += 1_000;
    await engine.tick();
    expect(bench.outbox["out"]).toEqual(["synthetic one"]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "delivery-rejected", reason: "NOPE" }),
    );
    expect(await store.deliveryCounts("text")).toEqual({
      pending: 0,
      delivered: 1,
      failed: 1,
      cleared: 0,
    });
  });

  it("refuses to start on a bad module, by file and key", async () => {
    const channel = (source: string, destination = "  - file: { dir: ./out }"): string =>
      `format: text\nsource:\n${source}\ndestinations:\n${destination}\n`;
    const cases: [Record<string, string>, string][] = [
      [
        {
          "channels/a/channel.yaml": channel("  module: ./source.ts"),
          "channels/a/source.ts": "export const notDefault = 1;\n",
        },
        "channels/a/channel.yaml: source.module: the module has no default export; export default a source factory",
      ],
      [
        {
          "channels/a/channel.yaml": channel("  module: ./source.ts"),
          "channels/a/source.ts": "export default () => ({ stop: async () => undefined });\n",
        },
        "channels/a/channel.yaml: source.module: the factory did not return a source connector: it needs poll or start",
      ],
      [
        {
          "channels/a/channel.yaml": channel("  module: ./source.ts"),
          "channels/a/source.ts": "export default () => ({ poll: 'often' });\n",
        },
        "channels/a/channel.yaml: source.module: the factory did not return a source connector: poll must be a method",
      ],
      [
        {
          "channels/a/channel.yaml": channel(
            "  file: { dir: ./in }",
            "  - file: { dir: ./out }\n  - module: ./destination.ts",
          ),
          "channels/a/destination.ts": "export default () => ({ send: async () => undefined });\n",
        },
        "channels/a/channel.yaml: destinations.1.module: the factory did not return a destination connector: deliver must be a method",
      ],
    ];
    for (const [files, message] of cases) {
      expect((await refusal(files)).message).toBe(message);
    }
    const loadFailure = await refusal({
      "channels/a/channel.yaml": channel("  module: ./source.ts"),
      "channels/a/source.ts": "throw new RangeError('synthetic TESTPATIENT');\n",
    });
    expect(loadFailure.message).toMatch(
      /^channels\/a\/channel\.yaml: source\.module: the module could not be loaded \(RangeError at source\.ts:1:\d+\)$/,
    );
  });

  it("stops what it started when a channel's module is bad, and the command exits 1 naming it", async () => {
    const bench = freshBench();
    const root = await makeProject({
      "pathways.yaml": `encryption: none\nstorage: { sqlite: { file: ./data/p.db } }\n`,
      "channels/a/channel.yaml": `format: text\nsource:\n  module: ./source.ts\n  options: { key: in }\ndestinations:\n  - module: ./destination.ts\n    options: { key: out }\n`,
      "channels/a/source.ts": POLL_SOURCE,
      "channels/a/destination.ts": LIST_DESTINATION,
      "channels/b/channel.yaml": `format: text\nsource:\n  module: ./source.ts\ndestinations:\n  - file: { dir: ./out }\n`,
      "channels/b/source.ts": "export default () => { throw new Error('synthetic'); };\n",
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["start", "--once", "-C", root], {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      logger: captureLogger().logger,
      env: {},
    });
    expect(code).toBe(EXIT.failed);
    expect(err.join("")).toMatch(
      /^pathways: channels\/b\/channel\.yaml: source\.module: the factory threw \(Error at source\.ts:1:\d+\)\n$/,
    );
    // Channel a had started; it was stopped.
    expect(bench.notes["destination"]).toEqual(["stopped"]);
  });
});

describe("a custom MLLP ACK builder", () => {
  const channel = (port: number, extra = ""): string => `
source:
  mllp: { port: ${String(port)}, plaintext: true, ackBuilder: ./ack.ts }
transform: ./transform.ts
destinations:
  - file: { dir: ./out }
${extra}`;

  it("answers each stored message with the ACK the module builds", async () => {
    const bench = freshBench();
    const { port, engine, store } = await startOnPort((port) => ({
      "channels/adt/channel.yaml": channel(port),
      "channels/adt/ack.ts": CUSTOM_ACK,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    }));
    const { replies } = await exchange(port, [ADT_A01, ADT_A08], { replies: 2 });
    expect(replies.map(msaOf)).toEqual([
      ["AA", controlIdOf(ADT_A01)],
      ["AA", controlIdOf(ADT_A08)],
    ]);
    expect(replies[0]).toContain(`ACK|CUSTOM${controlIdOf(ADT_A01)}|`);
    expect(replies[0]).toContain("custom ack");
    expect(bench.notes["ack"]).toEqual([
      { code: "AA", reason: "stored", messageId: 1 },
      { code: "AA", reason: "stored", messageId: 2 },
    ]);
    await engine.tick();
    expect(await store.messageCounts("adt")).toMatchObject({ transformed: 1, filtered: 1 });
  });

  it("sends the default ACK when the builder runs past the channel's time limit", async () => {
    const { port, events } = await startOnPort((port) => ({
      "channels/adt/channel.yaml": channel(port, "timeout: 50ms"),
      "channels/adt/ack.ts": HANGING_ACK,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    }));
    const { replies } = await exchange(port, [ADT_A01], { replies: 1 });
    expect(replies.map(msaOf)).toEqual([["AA", controlIdOf(ADT_A01)]]);
    expect(replies[0]).not.toContain("CUSTOM");
    expect(events).toContainEqual(
      expect.objectContaining({ event: "mllp-ack-builder-failed", name: "TimeoutError" }),
    );
  });

  it("refuses to start when the ACK builder module has no default export", async () => {
    // Refused before the source listens: nothing binds the port.
    const error = await refusal({
      "channels/adt/channel.yaml": channel(CLOSED_PORT),
      "channels/adt/ack.ts": "export const ack = 1;\n",
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    expect(error.message).toBe(
      "channels/adt/channel.yaml: source.mllp.ackBuilder: the module has no default export; export default an ACK builder",
    );
  });
});

describe("a custom storage adapter", () => {
  const FILE_CHANNEL = `
source:
  file: { dir: ./in, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ./out }
`;

  it("runs the engine on an in-memory MessageStore from a module", async () => {
    const { root, engine } = await startEngine({
      "pathways.yaml": `storage:\n  module: ${MEMORY_STORE_FILE}\n  options: { label: synthetic }\n`,
      "channels/adt/channel.yaml": FILE_CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    // The store the module built, below the layer openStore wraps it in.
    const memory = opened.at(-1);
    expect(memory?.messageRows).toEqual([]);

    await dropFile(join(root, "channels/adt/in/a01.hl7"), ADT_A01);
    await dropFile(join(root, "channels/adt/in/a08.hl7"), ADT_A08);
    await engine.tick();

    expect(memory?.messageRows.map((m) => m.status)).toEqual(["transformed", "filtered"]);
    expect(memory?.deliveryRows.map((d) => d.status)).toEqual(["delivered"]);
    expect(await readFile(join(root, "channels/adt/out/1-1.hl7"), "utf8")).toBe(
      ADT_A01.replace("|LAB|", "|LAB2|"),
    );
    expect((await engine.health()).channels["adt"]).toMatchObject({
      status: "ok",
      messages: { transformed: 1, filtered: 1 },
    });
  });

  it("opens SQLite by default, inside the encryption layer", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": FILE_CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const context = { env: {}, logger: captureLogger().logger };
    const raw = await openRawStore(project, context);
    stores.push(raw);
    expect(raw).toBeInstanceOf(Store);
    const store = await openStore(project, { ...context, keys: undefined });
    stores.push(store);
    expect(store).toBeInstanceOf(UnencryptedStore);
  });

  it("names a store module that refuses to open or returns something short of a MessageStore", async () => {
    const opening = async (files: Record<string, string>): Promise<string> => {
      const root = await makeProject({
        "channels/adt/channel.yaml": FILE_CHANNEL,
        "channels/adt/transform.ts": LAB_TRANSFORM,
        ...files,
      });
      const project = await loadProject(root);
      return openStore(project, { env: {}, logger: captureLogger().logger, keys: undefined }).then(
        () => "opened",
        (error: unknown) => (error as Error).message,
      );
    };
    expect(
      await opening({
        "pathways.yaml": `storage:\n  module: ${MEMORY_STORE_FILE}\n  options: { refuse: true }\n`,
      }),
    ).toMatch(
      /^pathways\.yaml: storage\.module: the factory threw \(RangeError at memory-store\.ts:\d+:\d+\)$/,
    );
    expect(
      await opening({
        "pathways.yaml": "storage: { module: ./store.ts }\n",
        "store.ts":
          "export default () => ({ receive: async () => ({ id: 1 }), close: async () => undefined });\n",
      }),
    ).toBe(
      "pathways.yaml: storage.module: the factory did not return a message store: nextToTransform, completeTransform, failTransform, nextDelivery, markSending, markDelivered, scheduleRetry, failDelivery, messageCounts, deliveryCounts, retryingDeliveries, channels, message, messageBody, deliveries, outputs, listMessages, listRetrying, requeue, clear, expire, appendAudit, auditEntries must be methods",
    );
  });

  it("runs pathways start on a custom store, and exits 1 naming a bad one", async () => {
    const files = {
      "channels/adt/channel.yaml": FILE_CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    };
    const good = await makeProject({
      ...files,
      "pathways.yaml": `encryption: none\nstorage: { module: ${MEMORY_STORE_FILE} }\n`,
    });
    await dropFile(join(good, "channels/adt/in/a01.hl7"), ADT_A01);
    const io = (err: string[]) => ({
      out: () => undefined,
      err: (t: string) => err.push(t),
      logger: captureLogger().logger,
      env: {},
    });
    const okErr: string[] = [];
    expect(await run(["start", "--once", "-C", good], io(okErr))).toBe(EXIT.ok);
    expect(okErr).toEqual([]);
    expect(await readdir(join(good, "channels/adt/out"))).toEqual(["1-1.hl7"]);

    const bad = await makeProject({
      ...files,
      "pathways.yaml": "encryption: none\nstorage: { module: ./store.ts }\n",
      "store.ts": "export default 'not a factory';\n",
    });
    const badErr: string[] = [];
    expect(await run(["start", "--once", "-C", bad], io(badErr))).toBe(EXIT.failed);
    expect(badErr.join("")).toBe(
      "pathways: pathways.yaml: storage.module: the module's default export is a string, not a function; export default a store factory\n",
    );
  });
});
