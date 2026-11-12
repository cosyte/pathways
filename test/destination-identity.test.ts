// A delivery, a resend and pathways verify find a destination by what it is (its name, or its kind
// and target), never by its place in channel.yaml's list: after a destination is added first, one
// is removed, or the list is reordered, no destination is sent, or compared with, another's bytes.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { ChannelConfig, DestinationConfig, ProjectConfig } from "../src/config/schema.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import { EncryptedStore } from "../src/encryption/encrypted-store.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import { destinationKeys } from "../src/engine/destination-key.js";
import type { ChannelConnectors } from "../src/engine/engine.js";
import { Engine } from "../src/engine/engine.js";
import { EXIT } from "../src/exit.js";
import { replayMessages } from "../src/operator/actions.js";
import { AuditLog } from "../src/operator/audit.js";
import { showCommand } from "../src/operator/commands.js";
import { verifyCommand } from "../src/operator/verify.js";
import { ENGINE_LEASE } from "../src/storage/lease.js";
import { Store, type MessageStore } from "../src/storage/store.js";
import { available, closeAdmins, dropDatabases, TEST_DATABASES, testStorage } from "./databases.js";
import { captureLogger, cleanUp, makeProject, type LogEvent } from "./helpers.js";
import { MemoryStore } from "./memory-store.js";

const engines: Engine[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (body: Uint8Array): string => new TextDecoder().decode(body);

/** A destination block: named, with its own transform when one is given. */
const block = (name: string, transform?: string): string =>
  `  - name: ${name}\n    file: { dir: out-${name} }\n${transform === undefined ? "" : `    transform: ./${transform}\n`}`;

/** The channel with these destinations: a filters a message that starts with skip, b maps all. */
const channel = (...blocks: string[]): string =>
  `format: text\nsource:\n  file: { dir: in }\ndestinations:\n${blocks.join("")}`;

/** A destination block that sends to the one folder `out`: named when a name is given. */
const twin = (name: string | undefined, transform: string): string =>
  `  - ${name === undefined ? "" : `name: ${name}\n    `}file: { dir: out }\n    transform: ./${transform}\n`;

const A = block("a", "a.ts");
const B = block("b", "b.ts");
const C = block("c");

const FILES = {
  "channels/adt/channel.yaml": channel(A, B),
  "channels/adt/a.ts":
    'export default (msg: string) => (msg.startsWith("skip") ? null : `A:${msg}`);\n',
  "channels/adt/b.ts": "export default (msg: string) => `B:${msg}`;\n",
  "channels/adt/none.ts": "export default () => null;\n",
};

/** What each destination was handed, by its name, in order. */
type Sent = Record<string, string[]>;

/**
 * Connectors that take nothing in (messages are stored by the test) and hand each destination's
 * deliveries to `sent` under its name, or refuse them all when `down`, so they stay pending.
 */
function connectors(sent: Sent, down: boolean) {
  return (config: ChannelConfig): ChannelConnectors => ({
    source: { poll: () => Promise.resolve() },
    destinations: config.destinations.map((destination) => ({
      deliver: (message) => {
        if (down) return Promise.reject(new Error("synthetic receiver down"));
        const name = String(destination.name);
        (sent[name] ??= []).push(text(message.body));
        return Promise.resolve();
      },
    })),
  });
}

interface Setup {
  readonly root: string;
  readonly store: MessageStore;
}

/** One engine run of one pass: a later clock, so a retry the last run scheduled is due. */
async function pass(
  setup: Setup,
  options: { readonly down?: boolean; readonly later?: boolean } = {},
): Promise<{ sent: Sent; events: LogEvent[] }> {
  const project = await loadProject(setup.root);
  const sent: Sent = {};
  const { logger, events } = captureLogger();
  const offset = options.later === true ? 3_600_000 : 0;
  const engine = new Engine({
    project,
    store: setup.store,
    logger,
    now: () => Date.now() + offset,
    connectors: connectors(sent, options.down === true),
  });
  engines.push(engine);
  await engine.start();
  await engine.tick();
  await engine.stop();
  engines.splice(engines.indexOf(engine), 1);
  return { sent, events };
}

/** Rewrites the channel's destinations, as an operator edits channel.yaml between two starts. */
async function edit(setup: Setup, ...blocks: string[]): Promise<ProjectConfig> {
  await writeFile(join(setup.root, "channels/adt/channel.yaml"), channel(...blocks));
  return loadProject(setup.root);
}

/** Stores alpha and skip-beta: a sends A:alpha and filters skip-beta, b sends B: of both. */
async function receiveTwo(store: MessageStore): Promise<void> {
  await store.receive("adt", bytes("alpha"));
  await store.receive("adt", bytes("skip-beta"));
}

const STORES: readonly {
  readonly label: string;
  readonly skip: boolean;
  readonly open: (root: string) => Promise<MessageStore>;
}[] = [
  { label: "the in-memory store", skip: false, open: () => Promise.resolve(new MemoryStore()) },
  ...TEST_DATABASES.map((database) => ({
    label: `${database.label} through encryption`,
    skip: !available(database),
    open: async (root: string) => {
      const raw = await (await testStorage(database, join(root, "pathways.db"))).open();
      stores.push(raw);
      const keys = new LocalKeyProvider([["k1", Buffer.alloc(KEY_BYTES, 3)]], "k1");
      return new EncryptedStore(raw, keys);
    },
  })),
];

for (const kind of STORES) {
  describe.skipIf(kind.skip)(`destinations by identity on ${kind.label}`, () => {
    async function setUp(): Promise<Setup> {
      const root = await makeProject(FILES);
      return { root, store: await kind.open(root) };
    }

    describe("the engine's pending deliveries, after a restart", () => {
      /** Queues both messages while every destination is down, then edits the list. */
      async function pending(...blocks: string[]): Promise<{ sent: Sent; events: LogEvent[] }> {
        const setup = await setUp();
        await receiveTwo(setup.store);
        const first = await pass(setup, { down: true });
        expect(first.sent).toEqual({});
        await edit(setup, ...blocks);
        return pass(setup, { later: true });
      }

      it("sends each its own when a destination was added first", async () => {
        const { sent } = await pending(C, A, B);
        expect(sent).toEqual({ a: ["A:alpha"], b: ["B:alpha", "B:skip-beta"] });
      });

      it("sends each its own when the list was reordered", async () => {
        const { sent } = await pending(B, A);
        expect(sent).toEqual({ a: ["A:alpha"], b: ["B:alpha", "B:skip-beta"] });
      });

      it("holds a removed destination's deliveries, with a code, and sends the rest their own", async () => {
        const { sent, events } = await pending(B);
        expect(sent).toEqual({ b: ["B:alpha", "B:skip-beta"] });
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "deliveries-held",
            channel: "adt",
            code: "destination-gone",
            deliveries: 1,
          }),
        );
      });

      it("sends a destination its held deliveries when it comes back", async () => {
        const setup = await setUp();
        await receiveTwo(setup.store);
        await pass(setup, { down: true });
        await edit(setup, B);
        expect((await pass(setup, { later: true })).sent).toEqual({
          b: ["B:alpha", "B:skip-beta"],
        });
        await edit(setup, C, A, B);
        expect((await pass(setup, { later: true })).sent).toEqual({ a: ["A:alpha"] });
      });
    });

    describe("a resend", () => {
      /** Delivers both messages, edits the list, resends both and returns what the engine sent. */
      async function resend(...blocks: string[]) {
        const setup = await setUp();
        await receiveTwo(setup.store);
        expect((await pass(setup)).sent).toEqual({
          a: ["A:alpha"],
          b: ["B:alpha", "B:skip-beta"],
        });
        const project = await edit(setup, ...blocks);
        const audit = new AuditLog(setup.store, { actor: "tester" });
        const results = await replayMessages([1, 2], {
          project,
          store: setup.store,
          audit,
          resend: true,
        });
        return { results, sent: (await pass(setup)).sent };
      }

      it("sends each its own stored bytes, and one added first nothing", async () => {
        const { results, sent } = await resend(C, A, B);
        expect(results).toEqual([
          {
            id: 1,
            outcome: "resent",
            status: "transformed",
            queued: 2,
            superseded: 0,
            notStored: 1,
          },
          {
            id: 2,
            outcome: "resent",
            status: "transformed",
            queued: 1,
            superseded: 0,
            notStored: 1,
          },
        ]);
        expect(sent).toEqual({ a: ["A:alpha"], b: ["B:alpha", "B:skip-beta"] });
      });

      it("sends each its own stored bytes when the list was reordered", async () => {
        const { results, sent } = await resend(B, A);
        expect(results).toMatchObject([
          { id: 1, outcome: "resent", queued: 2 },
          { id: 2, outcome: "resent", queued: 1 },
        ]);
        expect(sent).toEqual({ a: ["A:alpha"], b: ["B:alpha", "B:skip-beta"] });
      });

      it("sends the destinations left their own stored bytes when one was removed", async () => {
        const { results, sent } = await resend(B);
        expect(results).toMatchObject([
          { id: 1, outcome: "resent", queued: 1 },
          { id: 2, outcome: "resent", queued: 1 },
        ]);
        expect(sent).toEqual({ b: ["B:alpha", "B:skip-beta"] });
      });
    });

    describe("pathways verify", () => {
      /** Delivers both messages, edits the list, and verifies both against what was stored. */
      async function verify(...blocks: string[]) {
        const setup = await setUp();
        await receiveTwo(setup.store);
        await pass(setup);
        return verifyOn(setup, await edit(setup, ...blocks));
      }

      async function verifyOn(setup: Setup, project: ProjectConfig, ids = [1, 2]) {
        let printed = "";
        const code = await verifyCommand(
          {
            project,
            store: setup.store,
            audit: new AuditLog(setup.store, { actor: "tester" }),
            json: true,
            out: (line) => {
              printed += line;
            },
            err: () => undefined,
          },
          { kind: "ids", ids },
          "adt",
        );
        const report = JSON.parse(printed) as {
          channels: { destination: number; same: number; different: number; failed: number }[];
          notStored?: number;
        };
        return { code, report };
      }

      it("compares each destination with its own stored outputs when one was added first", async () => {
        const { code, report } = await verify(C, A, B);
        expect(
          report.channels.map(({ destination, same, different, failed }) => ({
            destination,
            same,
            different,
            failed,
          })),
        ).toEqual([
          { destination: 0, same: 0, different: 0, failed: 0 },
          { destination: 1, same: 2, different: 0, failed: 0 },
          { destination: 2, same: 2, different: 0, failed: 0 },
        ]);
        expect(report.notStored).toBe(2);
        expect(code).toBe(EXIT.ok);
      });

      it("compares each destination with its own stored outputs when the list was reordered", async () => {
        const { code, report } = await verify(B, A);
        expect(report.channels.map(({ same, different }) => [same, different])).toEqual([
          [2, 0],
          [2, 0],
        ]);
        expect(code).toBe(EXIT.ok);
      });

      it("compares the destination left with its own stored outputs when one was removed", async () => {
        const { code, report } = await verify(B);
        expect(report.channels.map(({ same, different }) => [same, different])).toEqual([[2, 0]]);
        expect(code).toBe(EXIT.ok);
      });

      it("refuses to compare outputs stored without keys destination by destination, and compares them once without destination transforms", async () => {
        const setup = await setUp();
        const { id } = await setup.store.receive("adt", bytes("alpha"));
        // As an earlier version stored them: the same outputs for each destination, and no keys.
        await setup.store.completeTransform(id, [bytes("alpha")], 2);
        const project = await loadProject(setup.root);
        const { code, report } = await verifyOn(setup, project, [id]);
        expect(report.channels.map(({ failed }) => failed)).toEqual([1, 1]);
        expect(code).toBe(EXIT.failed);
        const plain = await verifyOn(setup, await edit(setup, block("x"), block("y")), [id]);
        expect(plain.report.channels.map(({ same }) => same)).toEqual([1, 1]);
        expect(plain.code).toBe(EXIT.ok);
      });
    });

    describe("deliveries stored before keys", () => {
      it("are held failed with a code, sent to no destination; a resend is refused and a replay sends each its own", async () => {
        const setup = await setUp();
        const { id } = await setup.store.receive("adt", bytes("alpha"));
        await setup.store.completeTransform(id, [bytes("alpha")], 2);
        const { sent, events } = await pass(setup);
        expect(sent).toEqual({});
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "deliveries-held",
            channel: "adt",
            code: "destination-unknown",
            deliveries: 2,
          }),
        );
        expect(JSON.stringify(events)).not.toContain("alpha");
        expect(await setup.store.message(id)).toMatchObject({ state: "failed" });
        expect((await setup.store.deliveries(id)).map((d) => [d.status, d.error])).toEqual([
          ["failed", "delivery: destination-unknown"],
          ["failed", "delivery: destination-unknown"],
        ]);
        const project = await loadProject(setup.root);
        const audit = new AuditLog(setup.store, { actor: "tester" });
        const context = { project, store: setup.store, audit };
        expect(await replayMessages([id], { ...context, resend: true })).toEqual([
          { id, outcome: "refused", reason: "destination-unknown" },
        ]);
        expect(await replayMessages([id], { ...context, resend: false })).toMatchObject([
          { id, outcome: "replayed", queued: 2, superseded: 2 },
        ]);
        expect((await pass(setup)).sent).toEqual({ a: ["A:alpha"], b: ["B:alpha"] });
      });
    });

    describe("two destinations that send to one place", () => {
      it("are refused without names, and named, the one left after the other is removed is never sent its bytes", async () => {
        const setup = await setUp();
        // Unnamed, nothing would tell their deliveries apart once one is removed: no start.
        await expect(
          edit(setup, twin(undefined, "a.ts"), twin(undefined, "none.ts")),
        ).rejects.toThrow(ConfigError);
        await edit(setup, twin("a", "a.ts"), twin("b", "none.ts"));
        const { id } = await setup.store.receive("adt", bytes("alpha"));
        expect((await pass(setup, { down: true })).sent).toEqual({});
        expect((await setup.store.deliveries(id)).map((d) => d.status)).toEqual([
          "pending",
          "filtered",
        ]);
        const project = await edit(setup, twin("b", "none.ts"));
        const restarted = await pass(setup, { later: true });
        expect(restarted.sent).toEqual({});
        expect(restarted.events).toContainEqual(
          expect.objectContaining({ event: "deliveries-held", code: "destination-gone" }),
        );
        const audit = new AuditLog(setup.store, { actor: "tester" });
        await replayMessages([id], { project, store: setup.store, audit, resend: true });
        expect((await pass(setup, { later: true })).sent).toEqual({});
      });
    });

    describe("messages show", () => {
      it("names each delivery's destination by its key after the list was reordered", async () => {
        const setup = await setUp();
        await receiveTwo(setup.store);
        await pass(setup);
        const project = await edit(setup, B, A);
        let printed = "";
        const code = await showCommand(
          {
            project,
            store: setup.store,
            audit: new AuditLog(setup.store, { actor: "tester" }),
            json: true,
            out: (line) => {
              printed += line;
            },
            err: () => undefined,
            now: Date.now,
          },
          2,
          false,
        );
        expect(code).toBe(EXIT.ok);
        const shown = JSON.parse(printed) as { deliveries: Record<string, unknown>[] };
        expect(shown.deliveries.map((d) => [d["destinationName"], d["status"]])).toEqual([
          ["a", "filtered"],
          ["b", "delivered"],
        ]);
      });
    });
  });
}

describe("storage without keys", () => {
  it("refuses each destination's own outputs without each destination's key", async () => {
    const root = await makeProject(FILES);
    const store = await Store.open(join(root, "pathways.db"));
    stores.push(store);
    const { id } = await store.receive("adt", bytes("alpha"));
    await expect(
      store.completeTransform(id, { byDestination: [{ outputs: [] }, { outputs: [] }] }, 2),
    ).rejects.toThrow(RangeError);
    await expect(
      store.completeTransform(id, { byDestination: [{ outputs: [] }] }, 1, undefined, ["k", "l"]),
    ).rejects.toThrow(RangeError);
    expect(await store.deliveries(id)).toEqual([]);
    expect(await store.message(id)).toMatchObject({ status: "received" });
  });
});

describe("destinationKeys", () => {
  const root = "/srv/synthetic-project";
  const as = (value: Record<string, unknown>): DestinationConfig =>
    value as unknown as DestinationConfig;
  const file = as({ kind: "file", dir: `${root}/out` });
  const sftp = as({
    kind: "file",
    dir: "/upload",
    sftp: { host: "sftp.example.com", port: 22, user: "synthetic" },
  });
  const s3 = as({ kind: "file", dir: "in/", s3: { bucket: "synthetic-bucket" } });
  const s3At = as({
    kind: "file",
    dir: "in/",
    s3: { bucket: "synthetic-bucket", endpoint: "https://s3.example.com" },
  });
  const azblob = as({
    kind: "file",
    dir: "in/",
    azblob: { account: "synthetic", container: "inbound" },
  });
  const azblobAt = as({
    kind: "file",
    dir: "in/",
    azblob: { account: "synthetic", container: "inbound", endpoint: "https://blob.example.com" },
  });
  const http = as({ kind: "http", url: "https://lab.example.com/in" });
  const mllp = as({ kind: "mllp", host: "lab.example.com", port: 2575 });
  const tcp = as({ kind: "tcp", host: "lab.example.com", port: 2575 });
  const module = as({ kind: "module", module: `${root}/destination.ts` });
  const smtp = as({
    kind: "smtp",
    host: "mail.example.com",
    port: 587,
    to: ["lab@example.com"],
    cc: [],
  });
  const named = as({ kind: "http", url: "https://lab.example.com/in", name: "lab" });

  it("keys a destination by its name, else by its kind and target, and refuses two alike without names", () => {
    const keys = destinationKeys(root, [file, sftp, http, mllp, tcp, module, named]);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys).size).toBe(7);
    const others = destinationKeys(root, [s3, s3At, azblob, azblobAt, smtp]);
    expect(new Set([...keys, ...others]).size).toBe(12);
    // Two unnamed alike would share a key: refused, as the configuration refuses them.
    expect(() => destinationKeys(root, [http, named, http])).toThrow(RangeError);
    // A name keeps its key whatever the destination's kind or target.
    expect(destinationKeys(root, [as({ ...mllp, name: "lab" })])).toEqual([keys[6]]);
    // A destination keeps its key wherever it stands in the list.
    expect(destinationKeys(root, [named, http])).toEqual([keys[6], keys[2]]);
    // A moved project keeps the keys of its folders and modules.
    const moved = "/srv/moved";
    expect(
      destinationKeys(moved, [
        as({ kind: "file", dir: `${moved}/out` }),
        as({ kind: "module", module: `${moved}/destination.ts` }),
      ]),
    ).toEqual([keys[0], keys[5]]);
  });
});

describe("two unnamed destinations of one kind and target", () => {
  it("are refused by the configuration, which asks for a name on each", async () => {
    const root = await makeProject({
      ...FILES,
      "channels/adt/channel.yaml": `format: text\nsource:\n  file: { dir: in }\ndestinations:\n  - http: { url: https://lab.example.com/in }\n  - file: { dir: out }\n  - http: { url: https://lab.example.com/in }\n`,
    });
    const refused = await loadProject(root).then(
      () => [],
      (error: unknown) => (error instanceof ConfigError ? error.problems : [String(error)]),
    );
    expect(refused).toEqual([
      "channels/adt/channel.yaml: destinations.2: sends where destinations.0 sends, and neither has a name:; give each a name: so each keeps its own deliveries",
    ]);
    // A name on one of them is enough to tell them apart.
    await writeFile(
      join(root, "channels/adt/channel.yaml"),
      `format: text\nsource:\n  file: { dir: in }\ndestinations:\n  - http: { url: https://lab.example.com/in }\n  - name: copy\n    http: { url: https://lab.example.com/in }\n`,
    );
    expect((await loadProject(root)).channels[0]?.destinations).toHaveLength(2);
  });
});

describe("Store.holdDeliveries", () => {
  it("fails pending deliveries with no key and counts those of a destination not listed, fenced by the lease", async () => {
    const store = await Store.open(join(await makeProject({}), "pathways.db"));
    stores.push(store);
    const claim = await store.acquireLease(
      ENGINE_LEASE,
      { node: "synthetic-node", host: "synthetic-host" },
      60_000,
    );
    if (!claim.acquired) throw new Error("the lease was not taken");
    const unkeyed = await store.receive("adt", bytes("alpha"));
    await store.completeTransform(unkeyed.id, [bytes("alpha")], 1);
    const keyed = await store.receive("adt", bytes("beta"));
    await store.completeTransform(keyed.id, [bytes("beta")], 1, undefined, ["removed"]);
    const error = "delivery: destination-unknown";
    // An engine that lost the lease fails nothing.
    expect(await store.holdDeliveries("adt", ["kept"], error, claim.epoch + 1)).toEqual({
      unknown: 0,
      gone: 1,
    });
    expect(await store.holdDeliveries("adt", [], error, claim.epoch)).toEqual({
      unknown: 1,
      gone: 1,
    });
    expect(await store.deliveries(unkeyed.id)).toMatchObject([{ status: "failed", error }]);
    expect(await store.deliveries(keyed.id)).toMatchObject([
      { status: "pending", destinationKey: "removed" },
    ]);
  });
});

describe("a store without holdDeliveries", () => {
  it("still has each destination's deliveries found by key, and an encrypting store adds none", async () => {
    const root = await makeProject(FILES);
    const memory = new MemoryStore();
    const store: MessageStore = Object.assign(Object.create(memory) as MemoryStore, {
      holdDeliveries: undefined,
    });
    const keys = new LocalKeyProvider([["k1", Buffer.alloc(KEY_BYTES, 4)]], "k1");
    expect(new EncryptedStore(store, keys).holdDeliveries).toBeUndefined();
    await receiveTwo(store);
    const setup = { root, store };
    await pass(setup, { down: true });
    await edit(setup, B, A);
    expect((await pass(setup, { later: true })).sent).toEqual({
      a: ["A:alpha"],
      b: ["B:alpha", "B:skip-beta"],
    });
  });
});

describe("pathways verify, in text", () => {
  it("names a destination with nothing stored for a message on a line of its own", async () => {
    const root = await makeProject(FILES);
    const setup = { root, store: new MemoryStore() };
    await setup.store.receive("adt", bytes("alpha"));
    await pass(setup);
    const project = await edit(setup, C, A, B);
    let printed = "";
    const code = await verifyCommand(
      {
        project,
        store: setup.store,
        audit: new AuditLog(setup.store, { actor: "tester" }),
        json: false,
        out: (line) => {
          printed += line;
        },
        err: () => undefined,
      },
      { kind: "ids", ids: [1] },
      "adt",
    );
    expect(printed.trimEnd().split("\n")).toEqual([
      "Verified 1 message named.",
      "adt, destination 0: 0 same, 0 different, 0 failed",
      "adt, destination 1: 1 same, 0 different, 0 failed",
      "adt, destination 2: 1 same, 0 different, 0 failed",
      "Not compared: 1 destination of a stored message with nothing stored for it (added or renamed since), not-stored.",
    ]);
    expect(code).toBe(EXIT.ok);
  });
});
