// The operator commands and actions at their edges: values a store reports that the built-in store
// rarely does (a message stored before sizes were kept, a body gone between two reads), and errors
// that are not the ones an action handles itself.
import { afterEach, describe, expect, it } from "vitest";

import SqliteDatabase from "better-sqlite3";

import { loadProject } from "../src/config/load.js";
import type { ProjectConfig } from "../src/config/schema.js";
import { destinationKeys } from "../src/engine/destination-key.js";
import { EXIT } from "../src/exit.js";
import { replayMessages } from "../src/operator/actions.js";
import { AuditLog } from "../src/operator/audit.js";
import {
  listCommand,
  parseId,
  replayCommand,
  showCommand,
  type OperatorContext,
} from "../src/operator/commands.js";
import { Store, type MessageStore, type RequeueResult } from "../src/storage/store.js";
import { ADT_A01, cleanUp, LAB_TRANSFORM, makeProject } from "./helpers.js";
import { MemoryStore } from "./memory-store.js";

const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

const CHANNEL = `
source:
  file: { dir: ../../data/inbox }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/outbox }
`;

async function project(): Promise<ProjectConfig> {
  const root = await makeProject({
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": LAB_TRANSFORM,
  });
  return loadProject(root);
}

interface Printed {
  readonly context: OperatorContext;
  readonly out: () => string;
  readonly err: () => string;
}

function contextFor(project: ProjectConfig, store: MessageStore, json = false): Printed {
  let out = "";
  let err = "";
  const context: OperatorContext = {
    project,
    store,
    audit: new AuditLog(store, { actor: "tester" }),
    json,
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    now: Date.now,
  };
  return { context, out: () => out, err: () => err };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("parseId", () => {
  it("refuses an id past the largest whole number JavaScript holds exactly", () => {
    expect(parseId("9007199254740991")).toBe(9_007_199_254_740_991);
    expect(parseId("9007199254740992")).toBeUndefined();
    expect(parseId("9999999999999999")).toBeUndefined();
  });
});

describe("messages and messages show, for a message stored before sizes were kept", () => {
  it("print a dash for its size, and the message it may duplicate", async () => {
    const config = await project();
    const store = await Store.open(config.databaseFile);
    stores.push(store);
    await store.receive("adt", encode("first synthetic body"), { duplicateKey: "SYNTH|1" });
    const second = await store.receive("adt", encode("second synthetic body"), {
      duplicateKey: "SYNTH|1",
    });
    expect(second.duplicateOf).toBe(1);
    // A database Pathways wrote before it kept sizes: the column is null for those rows.
    const raw = new SqliteDatabase(config.databaseFile);
    raw.prepare("update messages set size = null where id = ?").run(second.id);
    raw.close();

    const listed = contextFor(config, store);
    expect(await listCommand(listed.context, { limit: 10 })).toBe(EXIT.ok);
    const rows = listed
      .out()
      .trimEnd()
      .split("\n")
      .map((line) => line.split(/ {2,}/));
    // ID, CHANNEL, STATE, RECEIVED, BYTES, DUPLICATE OF, DELIVERIES; newest first.
    expect(rows[1]).toEqual(["2", "adt", "received", expect.any(String), "-", "1", "-"]);
    expect(rows[2]).toEqual(["1", "adt", "received", expect.any(String), "20", "-", "-"]);

    const shown = contextFor(config, store);
    expect(await showCommand(shown.context, second.id, false)).toBe(EXIT.ok);
    expect(shown.out()).toMatch(/\n {2}bytes +-\n/);
    expect(shown.out()).toMatch(/\n {2}duplicate of +1\n/);
  });
});

describe("messages show --content", () => {
  it("prints a body that does not end in a line break as it is", async () => {
    const config = await project();
    const store = new MemoryStore();
    const { id } = await store.receive("adt", encode("synthetic text body"));
    const shown = contextFor(config, store);
    expect(await showCommand(shown.context, id, true)).toBe(EXIT.ok);
    expect(shown.out()).toMatch(/Content as received \(19 bytes\):\nsynthetic text body\n$/);
  });

  it("prints no content, and no hint to add --content, when the body is gone after the view is audited", async () => {
    const config = await project();
    const memory = new MemoryStore();
    const { id } = await memory.receive("adt", encode("synthetic text body"));
    // Retention deleted the message between the read of its summary and the read of its body.
    const store = Object.assign(Object.create(memory) as MemoryStore, {
      messageBody: () => Promise.resolve(undefined),
    });
    const shown = contextFor(config, store);
    expect(await showCommand(shown.context, id, true)).toBe(EXIT.ok);
    expect(shown.out()).not.toContain("Content");
    expect(shown.out()).not.toContain("synthetic text body");
    expect(memory.auditRows.map((entry) => entry.action)).toEqual(["content-view"]);

    const json = contextFor(config, store, true);
    expect(await showCommand(json.context, id, true)).toBe(EXIT.ok);
    expect(JSON.parse(json.out())).not.toHaveProperty("content");
  });
});

describe("replay", () => {
  it("says the transform failed when a store reports a failed requeue without saying why", async () => {
    const config = await project();
    const memory = new MemoryStore();
    const { id } = await memory.receive("adt", encode("synthetic text body"));
    const keys = destinationKeys(config.root, config.channels[0]?.destinations ?? []);
    await memory.completeTransform(id, [encode("synthetic output")], 1, undefined, keys);
    const [delivery] = await memory.deliveries(id);
    await memory.markDelivered(delivery?.id ?? 0);
    // A custom store's requeue is free to report the message as failed on a resend.
    const store = Object.assign(Object.create(memory) as MemoryStore, {
      requeue: async (...args: Parameters<MemoryStore["requeue"]>): Promise<RequeueResult> => {
        const result = await memory.requeue(...args);
        return result.done ? { ...result, status: "failed" } : result;
      },
    });
    const replayed = contextFor(config, store);
    expect(await replayCommand(replayed.context, [id], true)).toBe(EXIT.failed);
    expect(replayed.out()).toBe(`message ${id}: resent, and failed again: the transform failed\n`);
  });

  it("does not find a message whose body is gone after its summary was read", async () => {
    const config = await project();
    const memory = new MemoryStore();
    const { id } = await memory.receive("adt", encode("synthetic text body"));
    await memory.failTransform(id, "transform: TypeError");
    const store = Object.assign(Object.create(memory) as MemoryStore, {
      messageBody: () => Promise.resolve(undefined),
    });
    const audit = new AuditLog(store, { actor: "tester" });
    expect(await replayMessages([id], { project: config, store, audit, resend: false })).toEqual([
      { id, outcome: "not-found" },
    ]);
    expect(memory.auditRows).toEqual([
      expect.objectContaining({ action: "replay", outcome: "not-found", messageId: id }),
    ]);
    expect(await memory.message(id)).toMatchObject({ status: "failed", generation: 0 });
  });

  it("throws an error other than an unreadable value, after the replays before it", async () => {
    const config = await project();
    const memory = new MemoryStore();
    const first = await memory.receive("adt", encode(ADT_A01));
    await memory.failTransform(first.id, "transform: TypeError");
    const failure = new RangeError("synthetic storage failure");
    let reads = 0;
    const store = Object.assign(Object.create(memory) as MemoryStore, {
      message: (id: number) => {
        reads += 1;
        return reads === 1 ? memory.message(id) : Promise.reject(failure);
      },
      requeue: (...args: Parameters<MemoryStore["requeue"]>) => memory.requeue(...args),
    });
    const audit = new AuditLog(store, { actor: "tester" });
    await expect(
      replayMessages([first.id, 2], { project: config, store, audit, resend: false }),
    ).rejects.toBe(failure);
    // The first replay went through before the second read failed.
    expect(await memory.message(first.id)).toMatchObject({ status: "transformed", generation: 1 });
  });
});
