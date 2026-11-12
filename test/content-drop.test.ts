import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import { configJsonSchemas, DEFAULT_SETTINGS } from "../src/config/schema.js";
import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { generateKey, KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import { rekey } from "../src/encryption/rekey.js";
import { destinationKeys } from "../src/engine/destination-key.js";
import { Engine } from "../src/engine/engine.js";
import { AuditLog } from "../src/operator/audit.js";
import { replayMessages } from "../src/operator/actions.js";
import { emptySqliteLog } from "../src/storage/dialects.js";
import { LeaseLostError, Store, type MessageStore } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  TEST_DATABASES,
  testStorage,
  type TestDatabase,
} from "./databases.js";
import {
  ADT_A01,
  captureLogger,
  cleanUp,
  dropFile,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";
import { MemoryStore } from "./memory-store.js";

const closables: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(closables.splice(0).map((closable) => closable.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");
const sha256 = (body: string | Uint8Array): string =>
  createHash("sha256").update(body).digest("hex");
const DAY = 86_400_000;

/** A fresh store on `database`, with a clock a test can move. */
async function openStore(
  database: TestDatabase,
): Promise<{ store: Store; clock: { now: number } }> {
  const clock = { now: Date.parse("2026-11-07T12:00:00.000Z") };
  const storage = await testStorage(database, join(await makeProject({}), "pathways.db"));
  const store = await storage.open({ now: () => new Date(clock.now) });
  closables.push(store);
  return { store, clock };
}

/** Stores a message on channel `a` with its hash, and queues `outputs` to `destinations`. */
async function queued(
  store: Store,
  outputs: readonly string[],
  destinations: number,
  body = "MSH|^~\\&|SYNTH|TESTPATIENT",
): Promise<{ id: number; deliveries: number[] }> {
  const { id } = await store.receive("a", bytes(body), {
    contentHash: sha256(body),
    duplicateKey: "k",
  });
  await store.completeTransform(id, outputs.map(bytes), destinations);
  const deliveries = (await store.deliveries(id)).map((delivery) => delivery.id);
  return { id, deliveries };
}

// The same suite on every database: SQLite always, each server whose URL is in the environment.
for (const database of TEST_DATABASES) {
  const timeout = database.kind === "sqlite" ? 10_000 : 30_000;
  describe.skipIf(!available(database))(
    `dropping content on ${database.label}`,
    { timeout },
    () => {
      it("drops every body once the last delivery is delivered, and keeps the metadata", async () => {
        const { store } = await openStore(database);
        const earlier = await queued(store, ["x"], 1);
        const { id, deliveries } = await queued(store, ["out-1", "out-2"], 2);
        expect(deliveries).toHaveLength(4);
        const [d1, d2, d3, d4] = deliveries as [number, number, number, number];

        // Not the last: the delivery is recorded, and every body stays.
        expect(await store.markDeliveredAndDropContent(d1)).toBe(false);
        expect(await store.markDeliveredAndDropContent(d2)).toBe(false);
        await store.markDelivered(d3);
        expect((await store.message(id))?.contentDroppedAt).toBeUndefined();
        expect(await store.messageBody(id)).toBeDefined();
        expect((await store.outputs(id)).map((o) => Buffer.from(o).toString())).toEqual([
          "out-1",
          "out-2",
        ]);

        expect(await store.markDeliveredAndDropContent(d4)).toBe(true);
        expect(await store.messageBody(id)).toBeUndefined();
        expect(await store.outputs(id)).toEqual([]);
        const message = await store.message(id);
        expect(message).toMatchObject({
          id,
          channel: "a",
          status: "transformed",
          state: "delivered",
          size: "MSH|^~\\&|SYNTH|TESTPATIENT".length,
          duplicateOf: earlier.id,
          generation: 0,
          contentHash: sha256("MSH|^~\\&|SYNTH|TESTPATIENT"),
          contentDroppedAt: "2026-11-07T12:00:00.000Z",
          error: null,
        });
        expect(message?.deliveries).toMatchObject({ delivered: 4, pending: 0 });
        const listed = await store.listMessages({ channel: "a", limit: 10 });
        expect(listed.items[0]).toMatchObject({ id, contentDroppedAt: "2026-11-07T12:00:00.000Z" });
        expect(listed.items[1]?.contentDroppedAt).toBeUndefined();
        for (const delivery of await store.deliveries(id)) {
          expect(delivery).toMatchObject({ status: "delivered", attempts: 0, error: null });
          expect(delivery.deliveredAt).not.toBeNull();
        }
        // A message whose bodies are gone holds nothing for rekey, so rekey reads none of its rows.
        const contentIds = async (table: "messages" | "deliveries"): Promise<number[]> =>
          (await store.storedContent(table, 0, 100)).map((row) => row.id);
        expect(await contentIds("messages")).toEqual([earlier.id]);
        expect(await contentIds("deliveries")).toEqual(earlier.deliveries);

        // Once dropped, a later call has nothing to drop.
        expect(await store.markDeliveredAndDropContent(d4)).toBe(false);
        expect(await store.markDeliveredAndDropContent(987_654)).toBe(false);
      });

      it("keeps every body while a delivery has failed or waits to be tried again", async () => {
        const { store } = await openStore(database);
        const rejected = await queued(store, ["out"], 2);
        await store.failDelivery(rejected.deliveries[0] ?? -1, "rejected: AE");
        expect(await store.markDeliveredAndDropContent(rejected.deliveries[1] ?? -1)).toBe(false);
        expect(await store.messageBody(rejected.id)).toBeDefined();
        expect(await store.outputs(rejected.id)).toHaveLength(1);

        const retrying = await queued(store, ["out"], 2);
        await store.scheduleRetry(retrying.deliveries[0] ?? -1, 1, 5_000, "delivery: ECONNREFUSED");
        expect(await store.markDeliveredAndDropContent(retrying.deliveries[1] ?? -1)).toBe(false);
        expect(await store.messageBody(retrying.id)).toBeDefined();
        const [first] = await store.storedContent("deliveries", 0, 100);
        expect(first?.body.byteLength).toBeGreaterThan(0);
      });

      it("counts the current generation only, and drops every generation's bodies", async () => {
        const { store } = await openStore(database);
        const { id, deliveries } = await queued(store, ["out"], 1);
        await store.failDelivery(deliveries[0] ?? -1, "rejected: AE");
        const resent = await store.requeue(
          id,
          { mode: "resend", expected: "transformed", outputs: [bytes("out")], destinations: 1 },
          "tester",
        );
        expect(resent).toMatchObject({ done: true, superseded: 1, generation: 1 });
        const current = (await store.deliveries(id)).find((d) => d.generation === 1);
        expect(await store.markDeliveredAndDropContent(current?.id ?? -1)).toBe(true);
        expect(await store.storedContent("deliveries", 0, 100)).toEqual([]);
        expect((await store.deliveries(id)).map((d) => [d.generation, d.status, d.error])).toEqual([
          [0, "cleared", null],
          [1, "delivered", null],
        ]);
      });

      it("is fenced by the engine lease's epoch, and changes nothing without it", async () => {
        const { store } = await openStore(database);
        const { id, deliveries } = await queued(store, ["out"], 1);
        const claim = await store.acquireLease("engine", { node: "n1", host: "h1" }, 60_000);
        expect(claim).toMatchObject({ acquired: true, epoch: 1 });
        await expect(
          store.markDeliveredAndDropContent(deliveries[0] ?? -1, 2),
        ).rejects.toBeInstanceOf(LeaseLostError);
        expect((await store.deliveries(id))[0]?.status).toBe("pending");
        expect(await store.messageBody(id)).toBeDefined();
        expect(await store.markDeliveredAndDropContent(deliveries[0] ?? -1, 1)).toBe(true);
      });

      it("refuses a replay and a resend of a message whose content was dropped", async () => {
        const { store } = await openStore(database);
        const { id, deliveries } = await queued(store, ["out"], 1);
        await store.markDeliveredAndDropContent(deliveries[0] ?? -1);
        for (const mode of ["replay", "resend"] as const) {
          const result = await store.requeue(
            id,
            { mode, expected: "transformed", outputs: [bytes("again")], destinations: 1 },
            "tester",
          );
          expect(result).toMatchObject({
            done: false,
            reason: "content-dropped",
            entry: { action: mode, outcome: "refused", detail: { reason: "content-dropped" } },
          });
        }
        expect(await store.deliveries(id)).toHaveLength(1);
        expect((await store.message(id))?.generation).toBe(0);
      });

      it("leaves a message whose content was dropped to retention", async () => {
        const { store, clock } = await openStore(database);
        const dropped = await queued(store, ["out"], 1);
        await store.markDeliveredAndDropContent(dropped.deliveries[0] ?? -1);
        const kept = await queued(store, ["out"], 1);
        await store.markDelivered(kept.deliveries[0] ?? -1);
        clock.now += 40 * DAY;
        const cutoff = new Date(clock.now - 30 * DAY).toISOString();
        expect(await store.expire("a", cutoff, true)).toEqual({ messages: 1, deliveries: 1 });
        expect(await store.expire("a", cutoff, false)).toEqual({ messages: 1, deliveries: 1 });
        expect(await store.message(kept.id)).toBeUndefined();
        expect(await store.message(dropped.id)).toMatchObject({ state: "delivered" });
      });

      it("drops through the engine for a channel that asks for it, and keeps the others", async () => {
        const root = await makeProject({
          "pathways.yaml": "storage:\n  content: dropAfterDelivery\n",
          // Two destinations: the first delivered drops nothing, the second drops it all.
          "channels/drop/channel.yaml": `${channelYaml("drop")}  - file: { dir: ../../data/drop-out-2 }\n`,
          "channels/drop/transform.ts": LAB_TRANSFORM,
          "channels/keep/channel.yaml": `storage:\n  content: keep\n${channelYaml("keep")}`,
          "channels/keep/transform.ts": LAB_TRANSFORM,
        });
        const project = await loadProject(root);
        expect(project.channels.map((c) => [c.name, c.settings.content])).toEqual([
          ["drop", "dropAfterDelivery"],
          ["keep", "keep"],
        ]);
        const storage = await testStorage(database, project.databaseFile);
        const store = await storage.open();
        closables.push(store);
        const { logger, events, lines } = captureLogger();
        const engine = new Engine({ project, store, logger });
        closables.push({ close: () => engine.stop() });
        await engine.start();
        await dropFile(join(root, "data", "drop-in", "TESTPATIENT.hl7"), ADT_A01);
        await dropFile(join(root, "data", "keep-in", "TESTPATIENT.hl7"), ADT_A01);
        await engine.tick();

        const written = await readFile(join(root, "data", "drop-out", "1-1.hl7"), "utf8");
        expect(written).toBe(ADT_A01.replace("|LAB|", "|LAB2|"));
        const [drop] = (await store.listMessages({ channel: "drop", limit: 1 })).items;
        expect(drop).toMatchObject({ state: "delivered", contentHash: sha256(ADT_A01) });
        expect(drop?.contentDroppedAt).toBeDefined();
        expect(await store.messageBody(drop?.id ?? -1)).toBeUndefined();
        const [keep] = (await store.listMessages({ channel: "keep", limit: 1 })).items;
        expect(keep).toMatchObject({ state: "delivered" });
        expect(keep?.contentHash).toBeUndefined();
        expect(keep?.contentDroppedAt).toBeUndefined();
        expect(await store.messageBody(keep?.id ?? -1)).toBeDefined();
        const dropped = events.filter((event: LogEvent) => event.event === "content-dropped");
        expect(
          dropped.map(({ channel, message, delivery }) => ({ channel, message, delivery })),
        ).toEqual([{ channel: "drop", message: drop?.id, delivery: 2 }]);
        expect(lines.join("")).not.toContain("TESTPATIENT");
      });
    },
  );
}

/** A channel that reads `data/<name>-in` and writes `data/<name>-out`. */
function channelYaml(name: string): string {
  return [
    "source:",
    `  file: { dir: ../../data/${name}-in, minAge: 0 }`,
    "transform: ./transform.ts",
    "destinations:",
    `  - file: { dir: ../../data/${name}-out }`,
    "",
  ].join("\n");
}

describe("dropping content in a SQLite file", () => {
  // A synthetic marker no message holds otherwise: once dropped, no copy of it is left in the file.
  const MARKER = "SYNTHMARKER-7Q3Z-DROPPED";

  async function scan(content: "keep" | "drop", size: number): Promise<boolean> {
    const file = join(await makeProject({}), "pathways.db");
    const store = await Store.open(file);
    const body = `MSH|^~\\&|SYNTH|${MARKER}|${"Z".repeat(size)}|${MARKER}`;
    const { id } = await store.receive("a", bytes(body));
    await store.completeTransform(id, [bytes(`OUT|${MARKER}|${"Y".repeat(size)}`)], 2);
    for (const delivery of await store.deliveries(id)) {
      if (content === "drop") await store.markDeliveredAndDropContent(delivery.id);
      else await store.markDelivered(delivery.id);
    }
    // Closing the last connection checkpoints the write-ahead log into the file and removes it.
    await store.close();
    return (await readFile(file)).includes(MARKER);
  }

  it("finds the marker in a message that is kept, so the scan can see one", async () => {
    expect(await scan("keep", 100)).toBe(true);
  });

  it("finds no copy of the marker once a small message's content is dropped", async () => {
    expect(await scan("drop", 100)).toBe(false);
  });

  it("finds no copy of the marker once a message on overflow pages is dropped", async () => {
    expect(await scan("drop", 64 * 1024)).toBe(false);
  });

  // While a connection is open, the write-ahead log still holds the frames written when the message
  // was received: the drop zeroes the file's pages, not the log's earlier copies of them. Emptying
  // the log beside the open store (a running engine's, idle between queries) leaves no copy in
  // either file.
  for (const size of [100, 64 * 1024]) {
    it(`finds the marker in the open log after a drop, and none once the log is emptied (${size} bytes)`, async () => {
      const file = join(await makeProject({}), "pathways.db");
      const store = await Store.open(file);
      closables.push(store);
      const body = `MSH|^~\\&|SYNTH|${MARKER}|${"Z".repeat(size)}|${MARKER}`;
      const { id } = await store.receive("a", bytes(body));
      await store.completeTransform(id, [bytes(`OUT|${MARKER}|${"Y".repeat(size)}`)], 1);
      for (const delivery of await store.deliveries(id)) {
        await store.markDeliveredAndDropContent(delivery.id);
      }
      expect((await store.message(id))?.contentDroppedAt).toBeDefined();

      expect((await readFile(`${file}-wal`)).includes(MARKER)).toBe(true);
      expect(emptySqliteLog(file)).toBe(true);
      expect((await readFile(`${file}-wal`)).length).toBe(0);
      expect((await readFile(file)).includes(MARKER)).toBe(false);
    });
  }
});

describe("dropping content through the encryption layer", () => {
  const keys = new LocalKeyProvider([["k1", randomBytes(KEY_BYTES)]], "k1");

  it("passes the drop through, and reads no body once it is gone", async () => {
    const raw = await Store.open(join(await makeProject({}), "pathways.db"));
    const store = new EncryptedStore(raw, keys);
    closables.push(store);
    const { id } = await store.receive("a", bytes("MSH|SYNTH"), { contentHash: sha256("x") });
    await store.completeTransform(id, [bytes("out")], 1);
    const [delivery] = await store.deliveries(id);
    expect(await store.markDeliveredAndDropContent?.(delivery?.id ?? -1)).toBe(true);
    expect(await store.messageBody(id)).toBeUndefined();
    expect(await store.outputs(id)).toEqual([]);
    expect(await store.message(id)).toMatchObject({ contentHash: sha256("x") });
    // Nothing of it is left for rekey, so a rekey finds every value current.
    expect(await rekey(raw, keys)).toMatchObject({ current: 0, unencrypted: 0, unreadable: 0 });
  });

  it("has the method only when the store underneath has it", () => {
    expect(new UnencryptedStore(new MemoryStore()).markDeliveredAndDropContent).toBeUndefined();
  });
});

describe("a store that cannot drop content", () => {
  it("is refused at start for a channel that asks for it, naming the channel", async () => {
    const root = await makeProject({
      "channels/drop/channel.yaml": `storage:\n  content: dropAfterDelivery\n${channelYaml("drop")}`,
      "channels/drop/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const store: MessageStore = new MemoryStore();
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    const started = await engine.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(started).toBeInstanceOf(ConfigError);
    expect((started as ConfigError).problems).toEqual([
      "channels/drop/channel.yaml: storage.content: dropAfterDelivery needs a store that can drop content after delivery (markDeliveredAndDropContent), and this one cannot",
    ]);
    await engine.stop();
  });
});

describe("storage.content in the configuration", () => {
  it("defaults to keep, and a channel overrides the project", async () => {
    expect(DEFAULT_SETTINGS.content).toBe("keep");
    const root = await makeProject({
      "pathways.yaml": "storage:\n  content: dropAfterDelivery\n  sqlite:\n    file: x.db\n",
      "channels/a/channel.yaml": channelYaml("a"),
      "channels/a/transform.ts": LAB_TRANSFORM,
      "channels/b/channel.yaml": `storage: { content: keep }\n${channelYaml("b")}`,
      "channels/b/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    expect(project.settings.content).toBe("dropAfterDelivery");
    expect(project.storage).toMatchObject({ kind: "sqlite", file: join(root, "x.db") });
    expect(project.channels.map((c) => c.settings.content)).toEqual(["dropAfterDelivery", "keep"]);

    const plain = await makeProject({
      "channels/a/channel.yaml": channelYaml("a"),
      "channels/a/transform.ts": LAB_TRANSFORM,
    });
    expect((await loadProject(plain)).channels[0]?.settings.content).toBe("keep");

    // Read from the environment, as every setting can be.
    const fromEnv = await makeProject({
      "pathways.yaml": "storage:\n  content: { env: PATHWAYS_CONTENT, default: keep }\n",
      "channels/a/channel.yaml": channelYaml("a"),
      "channels/a/transform.ts": LAB_TRANSFORM,
    });
    const env = { PATHWAYS_CONTENT: "dropAfterDelivery" };
    expect((await loadProject(fromEnv, { env })).settings.content).toBe("dropAfterDelivery");
    expect((await loadProject(fromEnv, { env: {} })).settings.content).toBe("keep");
  });

  it("refuses a value it does not know, and a storage block naming two databases", async () => {
    const root = await makeProject({
      "pathways.yaml": "storage:\n  content: none\n",
      "channels/a/channel.yaml": `storage: { content: drop }\n${channelYaml("a")}`,
      "channels/a/transform.ts": LAB_TRANSFORM,
    });
    const problems = await loadProject(root).then(
      () => [],
      (error: unknown) => (error as ConfigError).problems,
    );
    expect(problems).toEqual([
      expect.stringMatching(/^pathways\.yaml: storage\.content: /),
      expect.stringMatching(/^channels\/a\/channel\.yaml: storage\.content: /),
    ]);

    const two = await makeProject({
      "pathways.yaml": "storage:\n  sqlite: { file: a.db }\n  module: ./store.ts\n",
      "channels/a/channel.yaml": channelYaml("a"),
      "channels/a/transform.ts": LAB_TRANSFORM,
    });
    const refused = await loadProject(two).then(
      () => [],
      (error: unknown) => (error as ConfigError).problems,
    );
    expect(refused).toEqual([
      "pathways.yaml: storage: name exactly one of: sqlite, postgres, mysql, sqlserver, module",
    ]);
  });

  it("is in the JSON Schemas, where a storage block may name content alone", () => {
    const { channel, project } = configJsonSchemas();
    const storage = (project.properties as Record<string, Record<string, unknown>>)["storage"];
    expect(storage?.["properties"]).toHaveProperty("content.anyOf.0.enum", [
      "keep",
      "dropAfterDelivery",
    ]);
    expect((storage?.["else"] as Record<string, unknown> | undefined)?.["oneOf"]).toContainEqual({
      required: ["content"],
      not: {
        anyOf: ["sqlite", "postgres", "mysql", "sqlserver", "module"].map((k) => ({
          required: [k],
        })),
      },
    });
    const channelStorage = (channel.properties as Record<string, Record<string, unknown>>)[
      "storage"
    ];
    expect(channelStorage?.["properties"]).toHaveProperty("content.anyOf.0.enum", [
      "keep",
      "dropAfterDelivery",
    ]);
  });
});

describe("the operator commands on a message whose content was dropped", () => {
  it("show its metadata without content, refuse a replay and a resend, and rekey skips it", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml":
        "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\nstorage:\n  content: dropAfterDelivery\n",
      "channels/adt/channel.yaml": channelYaml("adt"),
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    await dropFile(join(root, "data", "adt-in", "TESTPATIENT.hl7"), ADT_A01);
    const cli = async (argv: readonly string[]): Promise<{ code: number; out: string }> => {
      let out = "";
      const code = await run([...argv, "-C", root], {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          out += text;
        },
        logger: captureLogger().logger,
      });
      return { code, out };
    };
    expect((await cli(["start", "--once"])).code).toBe(EXIT.ok);

    const shown = await cli(["messages", "show", "1", "--content"]);
    expect(shown.code).toBe(EXIT.ok);
    expect(shown.out).toMatch(/^ {2}content hash +[0-9a-f]{64}$/m);
    expect(shown.out).toMatch(
      /^Content dropped after delivery at \d{4}-\d\d-\d\dT[\d:.]+Z: storage\.content is dropAfterDelivery\.$/m,
    );
    expect(shown.out).not.toContain("MSH");
    const json = JSON.parse((await cli(["messages", "show", "1", "--json"])).out) as {
      message: Record<string, unknown>;
    };
    expect(json.message).toMatchObject({ contentHash: sha256(ADT_A01) });
    expect(json.message["contentDroppedAt"]).toEqual(expect.any(String));

    for (const argv of [
      ["replay", "1"],
      ["replay", "1", "--resend"],
    ]) {
      const replayed = await cli(argv);
      expect(replayed).toEqual({
        code: EXIT.failed,
        out: "message 1: refused: its content was dropped after delivery (storage.content: dropAfterDelivery), so there is nothing to send again\n",
      });
    }
    // Nothing of the message is left to rekey, so rekey finds every value under the current key.
    expect((await cli(["rekey"])).code).toBe(EXIT.ok);
  });

  it("refuses a replay in storage too, when the drop comes after the check", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": channelYaml("adt"),
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const raw = await Store.open(join(root, "pathways.db"));
    closables.push(raw);
    const { id } = await raw.receive("adt", bytes("MSH|SYNTH"));
    const keys = destinationKeys(root, project.channels[0]?.destinations ?? []);
    await raw.completeTransform(id, [bytes("out")], 1, undefined, keys);
    const [delivery] = await raw.deliveries(id);
    // A store that drops the content just after the replay read the message, as the engine can.
    const racing: MessageStore = Object.assign(Object.create(raw) as Store, {
      outputs: async (messageId: number): Promise<Uint8Array[]> => {
        const outputs = await raw.outputs(messageId);
        await raw.markDeliveredAndDropContent(delivery?.id ?? -1);
        return outputs;
      },
      message: async (messageId: number) => {
        const message = await raw.message(messageId);
        return message === undefined
          ? undefined
          : { ...message, deliveries: { ...message.deliveries, pending: 0 } };
      },
    });
    const audit = new AuditLog(racing, { actor: "tester" });
    const results = await replayMessages([id], { project, store: racing, audit, resend: true });
    expect(results).toEqual([{ id, outcome: "refused", reason: "content-dropped" }]);
  });
});
