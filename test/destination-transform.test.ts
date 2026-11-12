// A transform per destination: the channel's transform runs, then each destination's own, once per
// channel output, in the same worker pass. A destination's transform maps, fans out or filters the
// message for that destination alone, and a throw fails only that destination's delivery.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { isEncrypted } from "../src/encryption/envelope.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import {
  ChannelWorker,
  destinationSetups,
  TransformLoadError,
  type ChannelWorkerOptions,
} from "../src/engine/channel-worker.js";
import { Engine } from "../src/engine/engine.js";
import {
  buildContext,
  DestinationLoadError,
  loadDestinations,
  runDestinations,
  UNSTORED,
  type DestinationSetup,
  type TransformFunction,
} from "../src/engine/worker-entry.js";
import { EXIT } from "../src/exit.js";
import { replayMessages } from "../src/operator/actions.js";
import { AuditLog } from "../src/operator/audit.js";
import { verifyCommand } from "../src/operator/verify.js";
import {
  replayCommand,
  showCommand,
  statusCommand,
  type OperatorContext,
} from "../src/operator/commands.js";
import type { Store } from "../src/storage/store.js";
import { destinationExpectedName, runChannelTests } from "../src/testing/run-tests.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
} from "./databases.js";
import { captureLogger, cleanUp, dropFile, makeProject, type LogEvent } from "./helpers.js";
import { MemoryStore } from "./memory-store.js";

const workers: ChannelWorker[] = [];
const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body);
const texts = (bodies: readonly Uint8Array[]): string[] => bodies.map(text);

function setup(index: number, name?: string, format: "text" | "json" = "text"): DestinationSetup {
  return { index, name, kind: "file", format, transformFile: undefined };
}

describe("runDestinations", () => {
  const upper: TransformFunction = (msg) => (msg as string).toUpperCase();
  const fanOut: TransformFunction = (msg) => [msg, `${msg as string}!`];
  const filter: TransformFunction = (msg) => ((msg as string).startsWith("beta") ? null : msg);
  const thrower: TransformFunction = () => {
    throw new TypeError("cannot route synthetic body");
  };

  it("maps, fans out and filters each destination on its own, and a throw fails only its own", async () => {
    const loaded = [
      { setup: setup(0, "upper"), transform: upper },
      { setup: setup(1, "fan"), transform: fanOut },
      { setup: setup(2), transform: undefined },
      { setup: setup(3, "only-alpha"), transform: filter },
      { setup: setup(4, "boom"), transform: thrower },
    ];
    const { outputs, destinations } = await runDestinations(
      (msg) => msg,
      "text",
      bytes("beta"),
      buildContext(UNSTORED, {}),
      loaded,
    );
    expect(texts(outputs)).toEqual(["beta"]);
    expect(destinations[0]).toEqual({ ok: true, outputs: [bytes("BETA")] });
    expect(destinations[1]).toEqual({ ok: true, outputs: [bytes("beta"), bytes("beta!")] });
    // No transform: the channel's outputs are sent as they are.
    expect(destinations[2]).toBeNull();
    expect(destinations[3]).toEqual({ ok: true, outputs: [] });
    expect(destinations[4]).toMatchObject({
      ok: false,
      failure: { kind: "transform", name: "TypeError" },
    });
  });

  it("runs a destination's transform once for each channel output, in order", async () => {
    const seen: string[] = [];
    const { destinations } = await runDestinations(
      () => ["one", "two"],
      "text",
      bytes("synthetic"),
      buildContext(UNSTORED, {}),
      [
        {
          setup: setup(0, "each"),
          transform: (msg) => {
            seen.push(msg as string);
            return `${msg as string}-sent`;
          },
        },
      ],
    );
    expect(seen).toEqual(["one", "two"]);
    expect(destinations[0]).toEqual({ ok: true, outputs: [bytes("one-sent"), bytes("two-sent")] });
  });

  it("hands a destination transform the channel's context with the destination beside it, frozen", async () => {
    const contexts: unknown[] = [];
    let channelContext: unknown;
    await runDestinations(
      (msg, ctx) => {
        channelContext = ctx;
        return msg;
      },
      "text",
      bytes("synthetic"),
      buildContext({ ...UNSTORED, messageId: 7 }, { facility: "TESTFAC" }),
      [
        {
          setup: setup(1, "lab"),
          transform: (msg, ctx) => {
            contexts.push(ctx);
            return msg;
          },
        },
      ],
    );
    expect(channelContext).not.toHaveProperty("destination");
    expect(contexts[0]).toMatchObject({
      messageId: 7,
      config: { facility: "TESTFAC" },
      destination: { index: 1, name: "lab", kind: "file" },
    });
    expect(Object.isFrozen(contexts[0])).toBe(true);
    expect(Object.isFrozen((contexts[0] as { destination: object }).destination)).toBe(true);
  });

  it("reads the channel's format and writes each destination's own", async () => {
    const { destinations } = await runDestinations(
      (msg) => msg,
      "text",
      bytes('{"code":"TEST1"}'),
      buildContext(UNSTORED, {}),
      [
        {
          setup: setup(0, "json", "json"),
          // A text channel hands over a string; a json destination writes the object as JSON.
          transform: (msg) => ({ ...(JSON.parse(msg as string) as object), seen: true }),
        },
      ],
    );
    expect(destinations[0]).toEqual({ ok: true, outputs: [bytes('{"code":"TEST1","seen":true}')] });
  });
});

describe("loadDestinations", () => {
  it("loads each destination's transform, and names the one that does not load", async () => {
    const root = await makeProject({
      "good.ts": "export default (msg: string) => msg;\n",
      "bad.ts": "export const notDefault = 1;\n",
    });
    const good = { ...setup(0, "good"), transformFile: join(root, "good.ts") };
    const loaded = await loadDestinations([good, setup(1)]);
    expect(loaded.map((d) => typeof d.transform)).toEqual(["function", "undefined"]);

    const bad = { ...setup(2, "bad"), transformFile: join(root, "bad.ts") };
    const error = await loadDestinations([good, bad]).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DestinationLoadError);
    expect((error as DestinationLoadError).destination).toBe(bad);
  });
});

describe("destinationExpectedName", () => {
  it("puts the destination's name, or its place from 1, and its format's extension after the input's stem", () => {
    expect(destinationExpectedName("a01.hl7", setup(0, "lab", "json"))).toBe(
      "a01.expected.lab.json",
    );
    expect(destinationExpectedName("noext", setup(2))).toBe("noext.expected.3.txt");
  });
});

describe("destinationSetups", () => {
  it("is undefined for a channel with no destination transform", () => {
    expect(
      destinationSetups({
        format: "text",
        destinations: [{ kind: "file", dir: "/out", sftp: undefined, name: "a" }],
      }),
    ).toBeUndefined();
  });
});

describe("ChannelWorker with destination transforms", () => {
  async function workerWith(
    files: Record<string, string>,
    destinations: readonly (Partial<DestinationSetup> & { file?: string })[],
    options: Partial<ChannelWorkerOptions> = {},
  ): Promise<ChannelWorker> {
    const root = await makeProject(files);
    const worker = new ChannelWorker({
      channel: "test",
      transformFile: undefined,
      format: "text",
      timeoutMs: 5_000,
      memoryMb: 256,
      destinations: destinations.map(({ file, ...rest }, index) => ({
        ...setup(index),
        ...rest,
        transformFile: file === undefined ? undefined : join(root, file),
      })),
      ...options,
    });
    workers.push(worker);
    return worker;
  }

  it("names the destination whose transform does not load, and fails the start", async () => {
    const worker = await workerWith({ "broken.ts": "export default 42;\n" }, [
      {},
      { name: "lab", file: "broken.ts" },
    ]);
    const error = await worker.start().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TransformLoadError);
    expect(error).toMatchObject({
      channel: "test",
      destination: { index: 1, name: "lab" },
      failure: { kind: "load" },
    });
    expect((error as Error).message).toBe(
      "the transform of destination lab of channel test could not be loaded (TypeError)",
    );
  });

  it("replies with each destination's outputs, filter or failure in one outcome", async () => {
    const worker = await workerWith(
      {
        "upper.ts": "export default (msg: string) => msg.toUpperCase();\n",
        "skip.ts": "export default () => null;\n",
        "boom.ts":
          "export default (msg: string) => { throw new RangeError(`no route for ${msg}`); };\n",
      },
      [{ file: "upper.ts" }, { file: "skip.ts" }, {}, { file: "boom.ts" }],
    );
    const outcome = await worker.run(bytes("alpha"));
    expect(outcome).toMatchObject({ ok: true, outputs: [bytes("alpha")] });
    if (!outcome.ok) throw new Error("expected an outcome");
    expect(outcome.destinations?.[0]).toEqual({ ok: true, outputs: [bytes("ALPHA")] });
    expect(outcome.destinations?.[1]).toEqual({ ok: true, outputs: [] });
    // A destination without a transform holds the channel's outputs.
    expect(outcome.destinations?.[2]).toEqual({ ok: true, outputs: [bytes("alpha")] });
    expect(outcome.destinations?.[3]).toMatchObject({
      ok: false,
      failure: { kind: "transform", name: "RangeError" },
    });
    const failed = outcome.destinations?.[3];
    expect(failed?.ok === false ? failed.failure.where : undefined).toMatch(/^boom\.ts:1:/);
  });

  it("stops a destination transform that runs past the channel's one timeout, and the next message runs", async () => {
    const worker = await workerWith(
      {
        "slow.ts":
          'export default (msg: string) => { if (msg === "stuck") for (;;) {} return msg; };\n',
      },
      [{}, { file: "slow.ts" }],
      { timeoutMs: 300 },
    );
    expect(await worker.run(bytes("stuck"))).toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
    expect(await worker.run(bytes("alpha"))).toMatchObject({
      ok: true,
      destinations: [
        { ok: true, outputs: [bytes("alpha")] },
        { ok: true, outputs: [bytes("alpha")] },
      ],
    });
  });
});

const CHANNEL = `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
destinations:
  - name: upper
    file: { dir: ../../data/out-0 }
    transform: ./upper.ts
  - name: fan
    file: { dir: ../../data/out-1 }
    transform: ./fan.ts
  - file: { dir: ../../data/out-2 }
    format: json
  - name: boom
    file: { dir: ../../data/out-3 }
    transform: ./boom.ts
`;

const FILES = {
  "channels/adt/channel.yaml": CHANNEL,
  "channels/adt/upper.ts": "export default (msg: string) => msg.toUpperCase();\n",
  "channels/adt/fan.ts":
    'export default (msg: string) => (msg.startsWith("beta") ? null : [msg, `${msg}!`]);\n',
  "channels/adt/boom.ts":
    'export default (msg: string) => { if (msg.startsWith("beta")) throw new TypeError(`no route for ${msg}`); return msg; };\n',
};

describe("the destination keys in channel.yaml", () => {
  async function problemsOf(files: Record<string, string>): Promise<readonly string[]> {
    try {
      await loadProject(await makeProject(files));
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
    return [];
  }

  it("resolves name, transform and format on a destination, and leaves them off one without", async () => {
    const root = await makeProject(FILES);
    const [channel] = (await loadProject(root)).channels;
    expect(channel?.destinations[0]).toMatchObject({
      name: "upper",
      transform: join(root, "channels/adt/upper.ts"),
    });
    expect(channel?.destinations[2]).toMatchObject({ format: "json" });
    expect(channel?.destinations[2]).not.toHaveProperty("name");
    expect(channel?.destinations[2]).not.toHaveProperty("transform");
  });

  it("refuses a name used twice in a channel, and a destination transform that does not exist", async () => {
    const twice = CHANNEL.replace("name: fan", "name: upper");
    expect(await problemsOf({ ...FILES, "channels/adt/channel.yaml": twice })).toEqual([
      expect.stringContaining(
        "destinations.1.name: upper names another destination of this channel",
      ),
    ]);
    const { "channels/adt/boom.ts": _boom, ...missing } = FILES;
    expect(await problemsOf(missing)).toEqual([
      expect.stringMatching(/destinations\.3\.transform: .*boom\.ts does not exist$/),
    ]);
  });
});

/** A store for one test on `database`. */
async function storeOn(database: TestDatabase, file: string): Promise<Store> {
  const store = await (await testStorage(database, file)).open();
  stores.push(store);
  return store;
}

interface Running {
  readonly root: string;
  readonly store: Store;
  readonly engine: Engine;
  readonly events: LogEvent[];
  readonly lines: string[];
  readonly audit: AuditLog;
}

async function run(
  database: TestDatabase,
  files: Record<string, string> = FILES,
): Promise<Running> {
  const root = await makeProject(files);
  const project = await loadProject(root);
  const store = await storeOn(database, project.databaseFile);
  const { logger, events, lines } = captureLogger();
  const audit = new AuditLog(store, { actor: "tester" });
  const engine = new Engine({ project, store, logger, audit });
  engines.push(engine);
  await engine.start();
  return { root, store, engine, events, lines, audit };
}

async function take(running: Running, ...bodies: string[]): Promise<void> {
  for (const [index, body] of bodies.entries()) {
    await dropFile(join(running.root, "data/inbox", `${index}.txt`), body);
    // One at a time, so the ids follow the order of the bodies.
    await running.engine.tick();
  }
}

const out = (root: string, dir: string): Promise<string[]> =>
  readdir(join(root, "data", dir)).then(
    (names) => names.filter((name) => !name.startsWith(".")).sort(),
    () => [],
  );

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`destination transforms on ${database.label}`, () => {
    it("delivers each destination its own outputs, records a filter and a failure per destination, and logs no content", async () => {
      const running = await run(database);
      const { root, store, engine, events, lines } = running;
      await take(running, "alpha", "beta");
      await engine.tick();

      expect(await out(root, "out-0")).toEqual(["1-1.txt", "2-1.txt"]);
      expect(await readFile(join(root, "data/out-0/1-1.txt"), "utf8")).toBe("ALPHA");
      expect(await readFile(join(root, "data/out-0/2-1.txt"), "utf8")).toBe("BETA");
      // Fanned out for alpha, filtered for beta.
      expect(await out(root, "out-1")).toEqual(["1-1.txt", "1-2.txt"]);
      expect(await readFile(join(root, "data/out-1/1-2.txt"), "utf8")).toBe("alpha!");
      // No transform, and its own format's extension.
      expect(await out(root, "out-2")).toEqual(["1-1.json", "2-1.json"]);
      // Failed for beta only.
      expect(await out(root, "out-3")).toEqual(["1-1.txt"]);

      expect(await store.message(1)).toMatchObject({ status: "transformed", state: "delivered" });
      expect(await store.message(2)).toMatchObject({ status: "transformed", state: "failed" });
      const second = (await store.deliveries(2)).map(({ destination, seq, status }) => ({
        destination,
        seq,
        status,
      }));
      expect(second).toEqual([
        { destination: 0, seq: 0, status: "delivered" },
        { destination: 1, seq: -1, status: "filtered" },
        { destination: 2, seq: 0, status: "delivered" },
        { destination: 3, seq: -1, status: "failed" },
      ]);
      // The failure is stored, with its text, for the deployer; never logged.
      const failed = (await store.deliveries(2)).find((d) => d.status === "failed");
      expect(failed?.error).toMatch(/^transform: TypeError at boom\.ts:1:\d+: no route for beta$/);
      expect(lines.join("")).not.toContain("beta");
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "destination-transform-failed",
          channel: "adt",
          message: 2,
          destination: 3,
          kind: "transform",
          name: "TypeError",
        }),
      );
      expect(await store.deliveryCounts("adt")).toEqual({
        pending: 0,
        delivered: 7,
        failed: 1,
        cleared: 0,
        filtered: 1,
      });
    });

    it("files a message every destination filters as filtered, settled and expirable", async () => {
      const running = await run(database, {
        "channels/adt/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./channel.ts
destinations:
  - name: first
    file: { dir: ../../data/out-0 }
    transform: ./skip.ts
  - name: second
    file: { dir: ../../data/out-1 }
    transform: ./skip.ts
`,
        "channels/adt/skip.ts": "export default () => null;\n",
        "channels/adt/channel.ts":
          'export default (msg: string) => (msg === "omega" ? null : msg);\n',
      });
      await take(running, "alpha", "omega");
      // Filtered by the channel's own transform: no destination transform runs, and no rows.
      expect(await running.store.message(2)).toMatchObject({ status: "filtered" });
      expect(await running.store.deliveries(2)).toEqual([]);
      expect(await running.store.message(1)).toMatchObject({
        status: "filtered",
        state: "filtered",
      });
      expect((await running.store.deliveries(1)).map((d) => d.status)).toEqual([
        "filtered",
        "filtered",
      ]);
      expect(running.events).toContainEqual(
        expect.objectContaining({ event: "filtered", message: 1 }),
      );
      const later = new Date(Date.now() + 60_000).toISOString();
      expect(await running.store.expire("adt", later, false)).toEqual({
        messages: 2,
        deliveries: 2,
      });
    });

    it("resends the stored bytes after a destination transform changed, and a replay runs the new one", async () => {
      const running = await run(database);
      const { root, store, engine, audit } = running;
      await take(running, "alpha");
      await engine.tick();
      expect(await readFile(join(root, "data/out-0/1-1.txt"), "utf8")).toBe("ALPHA");

      await writeFile(
        join(root, "channels/adt/upper.ts"),
        "export default (msg: string) => `changed ${msg}`;\n",
      );
      const project = await loadProject(root);
      await rm(join(root, "data/out-0/1-1.txt"));
      expect(await replayMessages([1], { project, store, audit, resend: true })).toEqual([
        { id: 1, outcome: "resent", status: "transformed", queued: 5, superseded: 0 },
      ]);
      await engine.tick();
      expect(await readFile(join(root, "data/out-0/1-1.txt"), "utf8")).toBe("ALPHA");

      await rm(join(root, "data/out-0/1-1.txt"));
      expect(await replayMessages([1], { project, store, audit, resend: false })).toEqual([
        { id: 1, outcome: "replayed", status: "transformed", queued: 5, superseded: 0 },
      ]);
      await engine.tick();
      expect(await readFile(join(root, "data/out-0/1-1.txt"), "utf8")).toBe("changed alpha");
    });

    it("lists a filtered delivery and its destination in messages show and status", async () => {
      const running = await run(database);
      await take(running, "beta");
      await running.engine.tick();
      let printed = "";
      const context: OperatorContext = {
        project: await loadProject(running.root),
        store: running.store,
        audit: running.audit,
        json: false,
        out: (line) => {
          printed += line;
        },
        err: () => undefined,
        now: Date.now,
      };
      expect(await showCommand(context, 1, false)).toBe(EXIT.ok);
      const rows = printed
        .split("\n")
        .filter((line) => line.startsWith("  ") && /^\s+\d+\s{2}/.test(line))
        .map((line) => line.trim().split(/ {2,}/));
      // ID, GENERATION, DESTINATION, OUTPUT, STATUS, ...
      expect(rows.map((row) => [row[2], row[3], row[4]])).toEqual([
        ["0 (upper)", "1", "delivered"],
        ["1 (fan)", "-", "filtered"],
        ["2", "1", "delivered"],
        ["3 (boom)", "-", "failed"],
      ]);
      printed = "";
      expect(await statusCommand(context, ["adt"])).toBe(EXIT.ok);
      expect(printed).toContain(", 1 filtered (by a destination transform)");
    });

    it("resends a message with a filtered and a failed destination as it stands, through encryption", async () => {
      const root = await makeProject(FILES);
      const project = await loadProject(root);
      const raw = await storeOn(database, project.databaseFile);
      const keys = new LocalKeyProvider([["k1", Buffer.alloc(KEY_BYTES, 9)]], "k1");
      const store = new EncryptedStore(raw, keys);
      const audit = new AuditLog(store, { actor: "tester" });
      const { id } = await store.receive("adt", bytes("beta"));
      await store.completeTransform(
        id,
        {
          byDestination: [
            { outputs: [bytes("BETA")] },
            { outputs: [] },
            { outputs: [bytes("beta")] },
            { failure: "transform: TypeError: no route for beta" },
          ],
        },
        4,
      );
      for (const destination of [0, 2]) {
        const next = await store.nextDelivery("adt", destination);
        await store.markDelivered(next?.id ?? -1);
      }
      expect(await replayMessages([id], { project, store, audit, resend: true })).toEqual([
        { id, outcome: "resent", status: "transformed", queued: 2, superseded: 1 },
      ]);
      const current = (await store.deliveries(id)).filter((d) => d.generation === 1);
      expect(current.map((d) => [d.destination, d.status])).toEqual([
        [0, "pending"],
        [1, "filtered"],
        [2, "pending"],
        [3, "failed"],
      ]);
      expect(current[3]?.error).toBe("transform: TypeError: no route for beta");
      expect(texts(await store.outputs(id, 0))).toEqual(["BETA"]);
    });

    it("resends no destination another's bytes when a destination was added since, through encryption", async () => {
      const root = await makeProject({
        ...FILES,
        "channels/adt/channel.yaml": `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
destinations:
  - name: skip
    file: { dir: ../../data/out-0 }
    transform: ./skip.ts
  - name: upper
    file: { dir: ../../data/out-1 }
    transform: ./upper.ts
  - name: added
    file: { dir: ../../data/out-2 }
`,
        "channels/adt/skip.ts": "export default () => null;\n",
      });
      const project = await loadProject(root);
      const raw = await storeOn(database, project.databaseFile);
      const keys = new LocalKeyProvider([["k1", Buffer.alloc(KEY_BYTES, 5)]], "k1");
      const store = new EncryptedStore(raw, keys);
      const audit = new AuditLog(store, { actor: "tester" });
      const { id } = await store.receive("adt", bytes("alpha"));
      // Stored when the channel had the first two destinations only.
      await store.completeTransform(
        id,
        { byDestination: [{ outputs: [] }, { outputs: [bytes("ALPHA")] }] },
        2,
      );
      const next = await store.nextDelivery("adt", 1);
      await store.markDelivered(next?.id ?? -1);
      expect(await replayMessages([id], { project, store, audit, resend: true })).toEqual([
        { id, outcome: "resent", status: "transformed", queued: 1, superseded: 0, notStored: 1 },
      ]);
      const current = (await store.deliveries(id)).filter((d) => d.generation === 1);
      expect(current.map((d) => [d.destination, d.seq, d.status])).toEqual([
        [0, -1, "filtered"],
        [1, 0, "pending"],
      ]);
      expect(await store.outputs(id, 0)).toEqual([]);
      expect(texts(await store.outputs(id, 1))).toEqual(["ALPHA"]);
      expect(await store.outputs(id, 2)).toEqual([]);
      const entries = await store.auditEntries({ limit: 10 });
      expect(entries.items.find((entry) => entry.action === "resend")?.detail).toMatchObject({
        queued: 1,
        notStored: 1,
      });
    });

    it("drops a message's content once its last delivery is delivered and the rest were filtered", async () => {
      const root = await makeProject(FILES);
      const store = await storeOn(database, (await loadProject(root)).databaseFile);
      const { id } = await store.receive("adt", bytes("alpha"));
      await store.completeTransform(
        id,
        { byDestination: [{ outputs: [bytes("ALPHA")] }, { outputs: [] }] },
        2,
      );
      const next = await store.nextDelivery("adt", 0);
      expect(await store.markDeliveredAndDropContent(next?.id ?? -1)).toBe(true);
      expect(await store.message(id)).toMatchObject({ state: "delivered" });
    });

    it("writes the empty body of a row with no output as each database takes one, without encryption", async () => {
      const root = await makeProject(FILES);
      const raw = await storeOn(database, (await loadProject(root)).databaseFile);
      const store = new UnencryptedStore(raw);
      const { id } = await store.receive("adt", bytes("alpha"));
      await store.completeTransform(id, { byDestination: [{ outputs: [] }, { failure: "x" }] }, 2);
      expect((await store.deliveries(id)).map((d) => d.status)).toEqual(["filtered", "failed"]);
    });

    it("stores a destination's failure and its empty body encrypted", async () => {
      const root = await makeProject(FILES);
      const project = await loadProject(root);
      const raw = await storeOn(database, project.databaseFile);
      const keys = new LocalKeyProvider([["k1", Buffer.alloc(KEY_BYTES, 7)]], "k1");
      const store = new EncryptedStore(raw, keys);
      const { id } = await store.receive("adt", bytes("beta"));
      await store.completeTransform(
        id,
        {
          byDestination: [
            { outputs: [bytes("BETA")] },
            { outputs: [] },
            { failure: "transform: TypeError: no route for beta" },
          ],
        },
        3,
      );
      const rows = await raw.storedContent("deliveries", 0, 10);
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(isEncrypted(row.body)).toBe(true);
      expect(rows[2]?.error).not.toContain("beta");
      expect((await store.deliveries(id))[2]?.error).toBe(
        "transform: TypeError: no route for beta",
      );
      expect(texts(await store.outputs(id, 0))).toEqual(["BETA"]);
      expect(await store.outputs(id, 1)).toEqual([]);
    });
  });
}

describe("pathways test with destination transforms", () => {
  const TEST_CHANNEL = `
format: text
source:
  file: { dir: in }
destinations:
  - name: upper
    file: { dir: out-0 }
    transform: ./upper.ts
  - file: { dir: out-1 }
    transform: ./fan.ts
`;
  const files = {
    "channels/adt/channel.yaml": TEST_CHANNEL,
    "channels/adt/upper.ts": "export default (msg: string) => msg.toUpperCase();\n",
    "channels/adt/fan.ts":
      'export default (msg: string) => (msg.startsWith("beta") ? null : [msg, `${msg}!`]);\n',
    "channels/adt/tests/alpha.txt": "alpha",
    "channels/adt/tests/beta.txt": "beta",
  };

  async function testIn(extra: Record<string, string>, update = false) {
    const root = await makeProject({ ...files, ...extra });
    const lines: string[] = [];
    const summary = await runChannelTests((await loadProject(root)).channels, {
      update,
      out: (line) => lines.push(line),
    });
    return { root, summary, lines };
  }

  it("compares one expected file per destination, and a missing file expects a filter", async () => {
    const { summary, lines } = await testIn({
      "channels/adt/tests/alpha.expected.upper.txt": "ALPHA",
      "channels/adt/tests/alpha.expected.2.txt": "alpha\nalpha!",
      "channels/adt/tests/beta.expected.upper.txt": "BETA",
    });
    expect(lines).toEqual([
      "PASS adt/tests/alpha.txt -> upper",
      "PASS adt/tests/alpha.txt -> 2",
      "PASS adt/tests/beta.txt -> upper",
      "PASS adt/tests/beta.txt -> 2 (filtered)",
    ]);
    expect(summary).toEqual({ passed: 4, failed: 0, updated: 0 });
  });

  it("fails an output with no expected file, a filter with one, and a difference", async () => {
    const { summary, lines } = await testIn({
      "channels/adt/tests/alpha.expected.upper.txt": "ALPHA?",
      "channels/adt/tests/beta.expected.upper.txt": "BETA",
      "channels/adt/tests/beta.expected.2.txt": "beta",
    });
    expect(lines).toEqual([
      "FAIL adt/tests/alpha.txt -> upper: output differs from the expected at line 1, column 6 (alpha.expected.upper.txt)",
      'FAIL adt/tests/alpha.txt -> 2: no alpha.expected.2.txt, which expects this destination to filter the input out; run "pathways test --update" to save the current output',
      "PASS adt/tests/beta.txt -> upper",
      "FAIL adt/tests/beta.txt -> 2: filtered, and beta.expected.2.txt expects an output",
    ]);
    expect(summary).toEqual({ passed: 1, failed: 3, updated: 0 });
  });

  it("saves each destination's output with --update, and removes the file of a destination that filtered", async () => {
    const { root, summary } = await testIn(
      { "channels/adt/tests/beta.expected.2.txt": "stale" },
      true,
    );
    expect(summary).toEqual({ passed: 0, failed: 0, updated: 4 });
    const tests = join(root, "channels/adt/tests");
    expect((await readdir(tests)).sort()).toEqual([
      "alpha.expected.2.txt",
      "alpha.expected.upper.txt",
      "alpha.txt",
      "beta.expected.upper.txt",
      "beta.txt",
    ]);
    expect(await readFile(join(tests, "alpha.expected.2.txt"), "utf8")).toBe("alpha\nalpha!");
  });

  it("fails a destination whose transform throws, by what happened", async () => {
    const { summary, lines } = await testIn({
      "channels/adt/fan.ts": "export default () => { throw new TypeError(); };\n",
      "channels/adt/tests/alpha.expected.upper.txt": "ALPHA",
      "channels/adt/tests/beta.expected.upper.txt": "BETA",
    });
    expect(lines[1]).toMatch(
      /^FAIL adt\/tests\/alpha\.txt -> 2: the transform threw TypeError at fan\.ts:1:\d+$/,
    );
    expect(summary).toEqual({ passed: 2, failed: 2, updated: 0 });
  });
});

describe("a resend from a store with destination outputs", () => {
  const TWO = `
format: text
source:
  file: { dir: in }
destinations:
  - file: { dir: out-0 }
  - file: { dir: out-1 }
`;

  async function resendWith(
    outcomes: Parameters<MemoryStore["completeTransform"]>[1],
    stored: number,
    channel = TWO,
  ) {
    const project = await loadProject(await makeProject({ "channels/adt/channel.yaml": channel }));
    const store = new MemoryStore();
    const audit = new AuditLog(store, { actor: "tester" });
    const { id } = await store.receive("adt", bytes("alpha"));
    await store.completeTransform(id, outcomes, stored);
    for (const row of store.deliveryRows) if (row.status === "pending") row.status = "delivered";
    const results = await replayMessages([id], { project, store, audit, resend: true });
    return { store, results };
  }

  it("keeps a first destination's failure, and sends what the other has", async () => {
    const { store, results } = await resendWith(
      {
        byDestination: [{ failure: "transform: TypeError: synthetic" }, { outputs: [bytes("b")] }],
      },
      2,
    );
    expect(results).toMatchObject([{ outcome: "resent", queued: 1 }]);
    expect(store.deliveryRows.filter((d) => d.generation === 1).map((d) => d.status)).toEqual([
      "failed",
      "pending",
    ]);
  });

  it("sends each destination its own outputs when they differ byte for byte", async () => {
    const { store, results } = await resendWith(
      { byDestination: [{ outputs: [bytes("a")] }, { outputs: [bytes("b")] }] },
      2,
    );
    expect(results).toMatchObject([{ outcome: "resent", queued: 2 }]);
    expect(store.deliveryRows.filter((d) => d.generation === 1).map((d) => text(d.body))).toEqual([
      "a",
      "b",
    ]);
  });

  it("sends a destination added since nothing, and the others their own outputs", async () => {
    const { store, results } = await resendWith([bytes("a")], 1);
    expect(results).toMatchObject([{ outcome: "resent", queued: 1, notStored: 1 }]);
    expect(
      store.deliveryRows
        .filter((d) => d.generation === 1)
        .map((d) => [d.destination, d.status, text(d.body)]),
    ).toEqual([[0, "pending", "a"]]);
  });

  const THREE = `${TWO}  - file: { dir: out-2 }\n`;

  it("never sends one destination's outputs to another: a filtered one stays filtered, one added since gets nothing", async () => {
    const { store, results } = await resendWith(
      { byDestination: [{ outputs: [] }, { outputs: [bytes("B")] }] },
      2,
      THREE,
    );
    expect(results).toMatchObject([{ outcome: "resent", queued: 1, notStored: 1 }]);
    expect(
      store.deliveryRows
        .filter((d) => d.generation === 1)
        .map((d) => [d.destination, d.seq, d.status, text(d.body)]),
    ).toEqual([
      [0, -1, "filtered", ""],
      [1, 0, "pending", "B"],
    ]);
  });

  it("sends each of two destinations its own outputs when a third was added since", async () => {
    const { store, results } = await resendWith(
      { byDestination: [{ outputs: [bytes("A")] }, { outputs: [bytes("B")] }] },
      2,
      THREE,
    );
    expect(results).toMatchObject([{ outcome: "resent", queued: 2, notStored: 1 }]);
    expect(
      store.deliveryRows
        .filter((d) => d.generation === 1)
        .map((d) => [d.destination, text(d.body)]),
    ).toEqual([
      [0, "A"],
      [1, "B"],
    ]);
  });

  it("names the destinations with nothing stored in the audit entry and the command's output", async () => {
    const project = await loadProject(await makeProject({ "channels/adt/channel.yaml": THREE }));
    const store = new MemoryStore();
    const audit = new AuditLog(store, { actor: "tester" });
    const { id } = await store.receive("adt", bytes("alpha"));
    await store.completeTransform(
      id,
      { byDestination: [{ outputs: [] }, { outputs: [bytes("B")] }] },
      2,
    );
    for (const row of store.deliveryRows) if (row.status === "pending") row.status = "delivered";
    let printed = "";
    const context: OperatorContext = {
      project,
      store,
      audit,
      json: false,
      out: (line) => {
        printed += line;
      },
      err: () => undefined,
      now: Date.now,
    };
    expect(await replayCommand(context, [id], true)).toBe(EXIT.ok);
    expect(printed).toBe(
      `message ${id}: resent: 1 delivery queued; 1 destination with nothing stored for this message was sent nothing (not-stored)\n`,
    );
    expect(store.auditRows.find((entry) => entry.action === "resend")?.detail).toMatchObject({
      queued: 1,
      notStored: 1,
    });
  });

  it("refuses a resend when no destination has an output to send", async () => {
    const { results } = await resendWith(
      { byDestination: [{ failure: "transform: TypeError: synthetic" }, { outputs: [] }] },
      2,
    );
    expect(results).toMatchObject([{ outcome: "refused", reason: "no-output" }]);
  });
});

describe("messages show for a channel no longer configured", () => {
  it("shows each destination by its place alone", async () => {
    const project = await loadProject(await makeProject(FILES));
    const store = new MemoryStore();
    const { id } = await store.receive("gone", bytes("alpha"));
    await store.completeTransform(id, { byDestination: [{ outputs: [] }] }, 1);
    let printed = "";
    const context: OperatorContext = {
      project,
      store,
      audit: new AuditLog(store, { actor: "tester" }),
      json: true,
      out: (line) => {
        printed += line;
      },
      err: () => undefined,
      now: Date.now,
    };
    expect(await showCommand(context, id, false)).toBe(EXIT.ok);
    const shown = JSON.parse(printed) as { deliveries: Record<string, unknown>[] };
    expect(shown.deliveries[0]).toMatchObject({ destination: 0, seq: -1, status: "filtered" });
    expect(shown.deliveries[0]).not.toHaveProperty("destinationName");
  });
});

describe("pathways verify with destination transforms", () => {
  const VERIFY_CHANNEL = `
format: text
source:
  file: { dir: in }
destinations:
  - file: { dir: out-0 }
  - name: upper
    file: { dir: out-1 }
    transform: ./upper.ts
  - name: only-alpha
    file: { dir: out-2 }
    transform: ./only-alpha.ts
`;
  const VERIFY_FILES = {
    "channels/adt/channel.yaml": VERIFY_CHANNEL,
    "channels/adt/upper.ts": "export default (msg: string) => msg.toUpperCase();\n",
    "channels/adt/only-alpha.ts":
      'export default (msg: string) => (msg.startsWith("alpha") ? msg : null);\n',
  };

  /** Stores alpha and beta as the channel above recorded them, then verifies both by id. */
  async function verifyStored(files: Record<string, string>) {
    const project = await loadProject(await makeProject({ ...VERIFY_FILES, ...files }));
    const store = new MemoryStore();
    const audit = new AuditLog(store, { actor: "tester" });
    const alpha = await store.receive("adt", bytes("alpha"));
    await store.completeTransform(
      alpha.id,
      {
        byDestination: [
          { outputs: [bytes("alpha")] },
          { outputs: [bytes("ALPHA")] },
          { outputs: [bytes("alpha")] },
        ],
      },
      3,
    );
    const beta = await store.receive("adt", bytes("beta"));
    await store.completeTransform(
      beta.id,
      {
        byDestination: [
          { outputs: [bytes("beta")] },
          { outputs: [bytes("BETA")] },
          { outputs: [] },
        ],
      },
      3,
    );
    let printed = "";
    const code = await verifyCommand(
      {
        project,
        store,
        audit,
        json: false,
        out: (line) => {
          printed += line;
        },
        err: () => undefined,
      },
      { kind: "ids", ids: [alpha.id, beta.id] },
      undefined,
    );
    return { code, lines: printed.trimEnd().split("\n") };
  }

  it("compares with each destination's own stored outputs, not the first destination's", async () => {
    const project = await loadProject(
      await makeProject({
        ...VERIFY_FILES,
        "channels/adt/channel.yaml": `
format: text
source:
  file: { dir: in }
destinations:
  - name: upper
    file: { dir: out-0 }
    transform: ./upper.ts
  - file: { dir: out-1 }
`,
      }),
    );
    const store = new MemoryStore();
    const { id } = await store.receive("adt", bytes("alpha"));
    await store.completeTransform(
      id,
      { byDestination: [{ outputs: [bytes("ALPHA")] }, { outputs: [bytes("alpha")] }] },
      2,
    );
    let printed = "";
    const code = await verifyCommand(
      {
        project,
        store,
        audit: new AuditLog(store, { actor: "tester" }),
        json: true,
        out: (line) => {
          printed += line;
        },
        err: () => undefined,
      },
      { kind: "ids", ids: [id] },
      "adt",
    );
    const report = JSON.parse(printed) as { channels: Record<string, unknown>[] };
    expect(report.channels).toEqual([
      {
        channel: "adt",
        destination: 0,
        same: 1,
        different: 0,
        failed: 0,
        results: [{ message: id, outcome: "same" }],
      },
      {
        channel: "adt",
        destination: 1,
        same: 1,
        different: 0,
        failed: 0,
        results: [{ message: id, outcome: "same" }],
      },
    ]);
    expect(code).toBe(EXIT.ok);
  });

  it("finds every destination the same when nothing changed, a filtered one included", async () => {
    const { code, lines } = await verifyStored({});
    expect(lines).toEqual([
      "Verified 2 messages named.",
      "adt, destination 0: 2 same, 0 different, 0 failed",
      "adt, destination 1: 2 same, 0 different, 0 failed",
      "adt, destination 2: 2 same, 0 different, 0 failed",
    ]);
    expect(code).toBe(EXIT.ok);
  });

  it("finds a changed destination transform different on its own destination only", async () => {
    const { code, lines } = await verifyStored({
      "channels/adt/upper.ts": "export default (msg: string) => `${msg.toUpperCase()}!`;\n",
    });
    expect(lines).toEqual([
      "Verified 2 messages named.",
      "adt, destination 0: 2 same, 0 different, 0 failed",
      "adt, destination 1: 0 same, 2 different, 0 failed",
      "  message 1: different, output 1 at byte offset 5",
      "  message 2: different, output 1 at byte offset 4",
      "adt, destination 2: 2 same, 0 different, 0 failed",
    ]);
    expect(code).toBe(EXIT.failed);
  });

  it("finds a destination that now filters, or throws, on its own destination only", async () => {
    const { lines } = await verifyStored({
      "channels/adt/only-alpha.ts": "export default () => { throw new TypeError(); };\n",
      "channels/adt/upper.ts":
        'export default (msg: string) => (msg.startsWith("beta") ? null : msg.toUpperCase());\n',
    });
    expect(lines[1]).toBe("adt, destination 0: 2 same, 0 different, 0 failed");
    expect(lines[2]).toBe("adt, destination 1: 1 same, 1 different, 0 failed");
    expect(lines[3]).toBe(
      "  message 2: different, 0 outputs from the transform, 1 output recorded",
    );
    expect(lines[4]).toBe("adt, destination 2: 0 same, 0 different, 2 failed");
    expect(lines[5]).toMatch(
      /^ {2}message 1: failed, the transform threw TypeError at only-alpha\.ts:1:\d+$/,
    );
  });

  it("compares each destination with its own expected sample, a missing one expecting a filter", async () => {
    const root = await makeProject(VERIFY_FILES);
    const project = await loadProject(root);
    const samples = join(root, "samples", "adt");
    await mkdir(samples, { recursive: true });
    await writeFile(join(samples, "beta.txt"), "beta");
    await writeFile(join(samples, "beta.expected.1.txt"), "beta");
    await writeFile(join(samples, "beta.expected.upper.txt"), "BETA?");
    let printed = "";
    const code = await verifyCommand(
      {
        project,
        json: false,
        out: (line) => {
          printed += line;
        },
        err: () => undefined,
      },
      { kind: "samples", dir: join(root, "samples") },
      undefined,
    );
    expect(printed.trimEnd().split("\n")).toEqual([
      "Verified 1 sample from the samples folder.",
      "adt, destination 0: 1 same, 0 different, 0 failed",
      "adt, destination 1: 0 same, 1 different, 0 failed",
      "  sample beta.txt: different, output 1 at byte offset 4",
      "adt, destination 2: 1 same, 0 different, 0 failed",
    ]);
    expect(code).toBe(EXIT.failed);
  });
});
