import { spawn } from "node:child_process";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { encryptText, isEncrypted, isEncryptedText } from "../src/encryption/envelope.js";
import {
  generateKey,
  LocalKeyProvider,
  KEY_BYTES,
  type KeyProvider,
} from "../src/encryption/keys.js";
import { rekey, rekeyComplete } from "../src/encryption/rekey.js";
import type { ProjectConfig } from "../src/config/schema.js";
import { Engine } from "../src/engine/engine.js";
import { clearMessages, replayMessages } from "../src/operator/actions.js";
import { AuditLog, operatingSystemUser } from "../src/operator/audit.js";
import { configFingerprints, recordConfigChanges } from "../src/operator/config-audit.js";
import { recordRetention, runRetention } from "../src/operator/retention.js";
import { startingKeys } from "../src/storage/open.js";
import { Store, type AuditEntry, type RequeueRequest } from "../src/storage/store.js";
import {
  ADT_A01,
  ADT_A08,
  captureLogger,
  cleanUp,
  dropFile,
  dropFileWhileRunning,
  LAB_TRANSFORM,
  makeProject,
  type LogEvent,
} from "./helpers.js";

const stores: Store[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanUp();
});

const DAY = 86_400_000;

/** The project's master keys, as `pathways start` reads them. */
async function keysOf(project: ProjectConfig): Promise<KeyProvider> {
  const keys = await startingKeys(project, { env: process.env, logger: captureLogger().logger });
  if (keys === undefined) throw new Error("the test project has no keys");
  return keys;
}
const THROWS = `export default () => { throw new TypeError("TESTPATIENT in the error text"); };\n`;

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out-a }
  - file: { dir: ../../data/out-b }
`;

interface Setup {
  readonly root: string;
  readonly project: ProjectConfig;
  readonly store: Store;
  readonly engine: Engine;
  readonly audit: AuditLog;
  readonly events: LogEvent[];
}

async function setUp(transform = LAB_TRANSFORM, extra: Record<string, string> = {}) {
  const root = await makeProject({
    "channels/adt/channel.yaml": CHANNEL,
    "channels/adt/transform.ts": transform,
    ...extra,
  });
  const project = await loadProject(root);
  const store = await Store.open(project.databaseFile);
  stores.push(store);
  const { logger, events } = captureLogger();
  const audit = new AuditLog(store, { actor: "tester" });
  const engine = new Engine({ project, store, logger, audit });
  engines.push(engine);
  await engine.start();
  return { root, project, store, engine, audit, events } satisfies Setup;
}

async function take(setup: Setup, ...bodies: string[]): Promise<void> {
  for (const [index, body] of bodies.entries()) {
    await dropFile(join(setup.root, "data/inbox", `${index}.hl7`), body);
  }
  await setup.engine.tick();
}

describe("replayMessages", () => {
  it("runs a failed message through the transform on disk now and delivers it, and audits the replay", async () => {
    const setup = await setUp(THROWS);
    const { root, project, store, engine, audit } = setup;
    await take(setup, ADT_A01);
    expect(await store.message(1)).toMatchObject({ status: "failed" });

    await writeFile(join(root, "channels/adt/transform.ts"), LAB_TRANSFORM);
    const results = await replayMessages([1], { project, store, audit, resend: false });
    expect(results).toEqual([
      { id: 1, outcome: "replayed", status: "transformed", queued: 2, superseded: 0 },
    ]);
    await engine.tick();
    for (const out of ["out-a", "out-b"]) {
      expect(await readFile(join(root, "data", out, "1-1.hl7"), "utf8")).toBe(
        ADT_A01.replace("|LAB|", "|LAB2|"),
      );
    }
    expect(await store.message(1)).toMatchObject({
      state: "delivered",
      generation: 1,
      error: null,
    });
    expect((await store.auditEntries({ limit: 5 })).items).toEqual([
      expect.objectContaining({
        actor: "tester",
        action: "replay",
        outcome: "ok",
        channel: "adt",
        messageId: 1,
      }),
    ]);
  });

  it("reports a replay that fails again by what happened, never the error's text", async () => {
    const setup = await setUp(THROWS);
    await take(setup, ADT_A01);
    const [result] = await replayMessages([1], { ...setup, resend: false });
    expect(result).toMatchObject({ outcome: "replayed", status: "failed", queued: 0 });
    expect(result).toHaveProperty(
      "failure",
      expect.stringMatching(/^the transform threw TypeError/),
    );
    expect(JSON.stringify(result)).not.toContain("TESTPATIENT");
    // Storage keeps the error's text, for the deployer's own inspection.
    expect((await setup.store.message(1))?.error).toContain("TESTPATIENT");
  });

  it("filters a message the transform now filters out", async () => {
    const setup = await setUp(THROWS);
    await take(setup, ADT_A08);
    await writeFile(join(setup.root, "channels/adt/transform.ts"), LAB_TRANSFORM);
    expect(await replayMessages([1], { ...setup, resend: false })).toEqual([
      { id: 1, outcome: "replayed", status: "filtered", queued: 0, superseded: 0 },
    ]);
  });

  it("resends the stored outputs without transforming, and refuses a message with none", async () => {
    const setup = await setUp();
    const { root, store, engine } = setup;
    await take(setup, ADT_A01, ADT_A08);
    await rm(join(root, "data/out-a"), { recursive: true });
    // The transform on disk now would throw; a resend never runs it.
    await writeFile(join(root, "channels/adt/transform.ts"), THROWS);
    const results = await replayMessages([1, 2], { ...setup, resend: true });
    expect(results).toEqual([
      { id: 1, outcome: "resent", status: "transformed", queued: 2, superseded: 0 },
      { id: 2, outcome: "refused", reason: "no-output" },
    ]);
    await engine.tick();
    expect(await readdir(join(root, "data/out-a"))).toEqual(["1-1.hl7"]);
    expect((await store.auditEntries({ action: "resend", limit: 5 })).items).toHaveLength(2);
  });

  it("refuses a message not yet transformed, one with deliveries pending, and one whose channel is gone; and does not find a missing one", async () => {
    const setup = await setUp();
    const { store, project } = setup;
    await store.receive("adt", new TextEncoder().encode(ADT_A01));
    const { id: pending } = await store.receive("adt", new TextEncoder().encode(ADT_A01));
    await store.completeTransform(pending, [new Uint8Array([1])], 2);
    const { id: orphan } = await store.receive("removed", new TextEncoder().encode(ADT_A01));
    await store.failTransform(orphan, "transform: TypeError");

    const results = await replayMessages([1, pending, orphan, 99], {
      ...setup,
      project,
      resend: false,
    });
    expect(results).toEqual([
      { id: 1, outcome: "refused", reason: "waiting" },
      { id: pending, outcome: "refused", reason: "pending" },
      { id: orphan, outcome: "refused", reason: "no-channel" },
      { id: 99, outcome: "not-found" },
    ]);
    const entries = (await store.auditEntries({ limit: 10 })).items;
    expect(entries.map((e) => [e.messageId, e.outcome, e.detail["reason"]])).toEqual([
      [99, "not-found", undefined],
      [orphan, "refused", "no-channel"],
      [pending, "refused", "pending"],
      [1, "refused", "waiting"],
    ]);
  });

  it("refuses every message of a channel whose transform will not load, saying so without its text", async () => {
    const setup = await setUp(THROWS);
    await take(setup, ADT_A01, ADT_A01);
    await writeFile(join(setup.root, "channels/adt/transform.ts"), "export const nothing = 1;\n");
    expect(await replayMessages([1, 2], { ...setup, resend: false })).toEqual([
      {
        id: 1,
        outcome: "refused",
        reason: "transform-load",
        failure: "the transform could not be loaded (TypeError)",
      },
      {
        id: 2,
        outcome: "refused",
        reason: "transform-load",
        failure: "the transform could not be loaded (TypeError)",
      },
    ]);
  });

  it("is safe while pathways start runs against the same database", async () => {
    const root = await makeProject({
      "test.key": `${generateKey()}\n`,
      "pathways.yaml":
        "encryption:\n  keys: [{ id: test, file: ./test.key }]\n  current: test\n" +
        "defaults:\n  pollInterval: 10ms\n",
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    // The real command in its own process, as an operator runs it: SIGTERM reaches it directly.
    const engine = spawn(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "../src/bin/pathways.ts"), "start", "-C", root],
      // tsx's loader draws a deprecation warning from Node 26; nothing else may reach stderr.
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    let stderr = "";
    engine.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => engine.on("exit", resolve));
    try {
      const delivered = async (count: number): Promise<void> => {
        for (let i = 0; i < 500; i += 1) {
          const files = await readdir(join(root, "data/out-b")).catch(() => []);
          if (files.length >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("the running engine did not deliver in time");
      };
      for (let i = 0; i < 5; i += 1) {
        await dropFileWhileRunning(join(root, `data/inbox/${i}.hl7`), ADT_A01);
      }
      await delivered(5);

      // Replays and new messages, side by side with the engine's own writes.
      for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < 5; i += 1) {
          await dropFileWhileRunning(join(root, `data/inbox/r${round}-${i}.hl7`), ADT_A01);
        }
        const store = new EncryptedStore(
          await Store.open(project.databaseFile),
          await keysOf(project),
        );
        try {
          const audit = new AuditLog(store, { actor: "tester" });
          const results = await replayMessages([1, 2, 3, 4, 5], {
            project,
            store,
            audit,
            resend: round === 1,
          });
          for (const result of results) {
            // A message the engine is still delivering from the last round is refused, never lost.
            expect(["replayed", "resent", "refused"]).toContain(result.outcome);
            if (result.outcome === "refused") expect(result.reason).toBe("pending");
          }
        } finally {
          await store.close();
        }
      }
      await delivered(20);

      const store = await Store.open(project.databaseFile);
      stores.push(store);
      for (let i = 0; i < 500; i += 1) {
        const states = (await store.listMessages({ limit: 100 })).items.map((m) => m.state);
        if (states.length === 20 && states.every((s) => s === "delivered")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const messages = (await store.listMessages({ limit: 100 })).items;
      expect(messages).toHaveLength(20);
      expect(messages.every((m) => m.state === "delivered")).toBe(true);
      expect(await store.messageCounts("adt")).toMatchObject({ received: 0, failed: 0 });
      expect(await store.deliveryCounts("adt")).toMatchObject({ pending: 0, failed: 0 });
      const replays = (await store.auditEntries({ limit: 100 })).items.filter(
        (e) => e.action === "replay" || e.action === "resend",
      );
      expect(replays).toHaveLength(15);
    } finally {
      engine.kill("SIGTERM");
      expect(await exited).toBe(0);
    }
    expect(stderr).toBe("");
  }, 60_000);
});

describe("replay through encryption at rest", () => {
  it("stores new outputs and failures encrypted, and reads bodies and errors back decrypted", async () => {
    const setup = await setUp(THROWS);
    const { root, project, store: raw } = setup;
    const keys = new LocalKeyProvider([["k", Buffer.alloc(KEY_BYTES, 7)]], "k");
    const store = new EncryptedStore(raw, keys);
    const { id } = await store.receive("adt", new TextEncoder().encode(ADT_A01));
    await store.failTransform(id, "transform: TypeError at transform.ts:1:1: TESTPATIENT");
    const audit = new AuditLog(store, { actor: "tester" });
    expect(await replayMessages([id], { project, store, audit, resend: false })).toMatchObject([
      { outcome: "replayed", status: "failed" },
    ]);
    const failed = await raw.message(id);
    expect(isEncryptedText(failed?.error ?? "")).toBe(true);
    expect((await store.message(id))?.error).toMatch(/^transform: TypeError at transform\.ts/);

    await writeFile(join(root, "channels/adt/transform.ts"), LAB_TRANSFORM);
    expect(await replayMessages([id], { project, store, audit, resend: false })).toMatchObject([
      { outcome: "replayed", status: "transformed", queued: 2 },
    ]);
    for (const output of await raw.outputs(id)) expect(isEncrypted(output)).toBe(true);
    const outputs = (await store.outputs(id)).map((o) => Buffer.from(o).toString("utf8"));
    expect(outputs).toEqual([ADT_A01.replace("|LAB|", "|LAB2|")]);
    const [delivery] = await raw.deliveries(id);
    await raw.failDelivery(delivery?.id ?? -1, await encryptText("delivery: ECONNRESET", keys));
    expect((await store.deliveries(id))[0]?.error).toBe("delivery: ECONNRESET");
    expect(await store.messageBody(999)).toBeUndefined();
    expect(await store.message(999)).toBeUndefined();
  });
});

describe("operator reads and rekey, beside encryption", () => {
  it("read plaintext error text back as it is under encryption: none", async () => {
    const raw = await Store.open(":memory:");
    stores.push(raw);
    const store = new UnencryptedStore(raw);
    const { id } = await store.receive("adt", new Uint8Array([1]));
    await store.failTransform(id, "transform: TypeError");
    expect((await store.message(id))?.error).toBe("transform: TypeError");
  });

  it("let retention delete a row rekey is about to replace: rekey changes nothing gone, and the next run is complete", async () => {
    const root = await makeProject({});
    const clock = { now: Date.now() - 40 * DAY };
    const raw = await Store.open(join(root, "pathways.db"), { now: () => new Date(clock.now) });
    stores.push(raw);
    const old = new LocalKeyProvider([["old", Buffer.alloc(KEY_BYTES, 1)]], "old");
    const both = new LocalKeyProvider(
      [
        ["new", Buffer.alloc(KEY_BYTES, 2)],
        ["old", Buffer.alloc(KEY_BYTES, 1)],
      ],
      "new",
    );
    const written = new EncryptedStore(raw, old);
    for (let i = 0; i < 3; i += 1) {
      const { id } = await written.receive("adt", new TextEncoder().encode(ADT_A01));
      await written.completeTransform(id, [], 1);
    }
    clock.now = Date.now();
    const cutoff = new Date(clock.now - 30 * DAY).toISOString();
    // Retention runs between rekey's read of a page and its first replacement.
    let retained = false;
    const racing = Object.assign(Object.create(raw) as Store, {
      replaceContent: async (...args: Parameters<Store["replaceContent"]>) => {
        if (!retained) {
          retained = true;
          expect(await raw.expire("adt", cutoff, false)).toEqual({ messages: 3, deliveries: 0 });
        }
        return raw.replaceContent(...args);
      },
    });
    const first = await rekey(racing, both);
    expect(first).toMatchObject({ reencrypted: 0, changed: 3 });
    expect(await raw.messageCounts("adt")).toMatchObject({ filtered: 0 });
    expect(await raw.storedContent("messages", 0, 10)).toEqual([]);
    expect(rekeyComplete(await rekey(raw, both))).toBe(true);
  });
});

describe("rekey, on rows whose body and error are under different keys", () => {
  it("rewrites only the value under an older key, and leaves the one under the current key as it was", async () => {
    const raw = await Store.open(":memory:");
    stores.push(raw);
    const old = new LocalKeyProvider([["old", Buffer.alloc(KEY_BYTES, 1)]], "old");
    const both = new LocalKeyProvider(
      [
        ["new", Buffer.alloc(KEY_BYTES, 2)],
        ["old", Buffer.alloc(KEY_BYTES, 1)],
      ],
      "new",
    );
    const body = new TextEncoder().encode(ADT_A01);
    // Received under the old key, its transform failing after the key was rotated; and the other
    // way round, its error written by an operator command still running with the old key current.
    const first = await new EncryptedStore(raw, old).receive("adt", body);
    await new EncryptedStore(raw, both).failTransform(first.id, "transform: TypeError");
    const second = await new EncryptedStore(raw, both).receive("adt", body);
    await new EncryptedStore(raw, old).failTransform(second.id, "transform: RangeError");
    const before = await raw.storedContent("messages", 0, 10);

    expect(await rekey(raw, both)).toMatchObject({ reencrypted: 2, current: 2, changed: 0 });
    const after = await raw.storedContent("messages", 0, 10);
    const same = (x: Uint8Array | undefined, y: Uint8Array | undefined): boolean =>
      Buffer.from(x ?? []).equals(Buffer.from(y ?? []));
    expect(same(after[0]?.body, before[0]?.body)).toBe(false);
    expect(after[0]?.error).toBe(before[0]?.error);
    expect(same(after[1]?.body, before[1]?.body)).toBe(true);
    expect(after[1]?.error).not.toBe(before[1]?.error);
    // The old key can go: everything reads under the new one alone.
    const read = new EncryptedStore(
      raw,
      new LocalKeyProvider([["new", Buffer.alloc(KEY_BYTES, 2)]], "new"),
    );
    for (const id of [first.id, second.id]) {
      expect(new TextDecoder().decode(await read.messageBody(id))).toBe(ADT_A01);
    }
    expect((await read.message(first.id))?.error).toBe("transform: TypeError");
    expect((await read.message(second.id))?.error).toBe("transform: RangeError");
  });
});

describe("a replay storage refuses", () => {
  it("is reported as storage says: changed meanwhile, or gone", async () => {
    const setup = await setUp(THROWS);
    await take(setup, ADT_A01, ADT_A01);
    const { store } = setup;
    // Storage sees the message moved, or deleted, between the command's read and its write.
    const racing = Object.assign(Object.create(store) as Store, {
      requeue: (id: number, request: RequeueRequest, actor: string) =>
        id === 1
          ? store.requeue(id, { ...request, expected: "cleared" }, actor)
          : store.requeue(999, request, actor),
    });
    expect(await replayMessages([1, 2], { ...setup, store: racing, resend: false })).toEqual([
      { id: 1, outcome: "refused", reason: "changed" },
      { id: 2, outcome: "not-found" },
    ]);
    expect(await store.message(1)).toMatchObject({ status: "failed", generation: 0 });
  });
});

describe("clearMessages", () => {
  it("clears failed messages, refuses one with nothing failed, and does not find a missing one", async () => {
    const setup = await setUp(THROWS);
    await take(setup, ADT_A01);
    await setup.store.receive("adt", new Uint8Array([1]));
    const seen: AuditEntry[] = [];
    setup.audit.subscribe((entry) => {
      seen.push(entry);
    });
    expect(await clearMessages([1, 2, 3], setup)).toEqual([
      { id: 1, outcome: "cleared", messages: 1, deliveries: 0 },
      { id: 2, outcome: "refused", reason: "not-failed" },
      { id: 3, outcome: "not-found" },
    ]);
    expect(seen.map((e) => [e.action, e.outcome, e.messageId])).toEqual([
      ["clear", "ok", 1],
      ["clear", "refused", 2],
      ["clear", "not-found", 3],
    ]);
    expect((await setup.engine.health()).channels["adt"]?.status).toBe("ok");
  });
});

describe("AuditLog", () => {
  it("tells each listener of each entry once stored, in order, until it unsubscribes", async () => {
    const store = await Store.open(":memory:");
    stores.push(store);
    const failures: unknown[] = [];
    const audit = new AuditLog(store, {
      actor: "tester",
      onListenerError: (error) => failures.push(error),
    });
    const seen: string[] = [];
    const stop = audit.subscribe(async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      // The entry is durable before any listener hears of it.
      const stored = await store.auditEntries({ limit: 10 });
      expect(stored.items.map((e) => e.id)).toContain(entry.id);
      seen.push(`${entry.id}:${entry.action}`);
    });
    audit.subscribe(() => {
      throw new Error("a listener that throws");
    });
    audit.subscribe(() => Promise.reject(new Error("a listener that rejects")));

    const entries = await audit.record(
      { action: "search", detail: { results: 1 } },
      { action: "view", messageId: 3 },
    );
    expect(entries.map((e) => [e.actor, e.action])).toEqual([
      ["tester", "search"],
      ["tester", "view"],
    ]);
    expect(seen).toEqual(["1:search", "2:view"]);
    expect(failures).toHaveLength(4);
    stop();
    await audit.record({ action: "retention" });
    expect(seen).toHaveLength(2);
    expect((await store.auditEntries({ limit: 10 })).items).toHaveLength(3);
  });

  it("rejects and tells no one when the store cannot write, and names the operating system user by default", async () => {
    const store = await Store.open(":memory:");
    const audit = new AuditLog(store);
    expect(audit.actor).toBe(operatingSystemUser());
    expect(audit.actor).not.toBe("");
    let told = 0;
    audit.subscribe(() => {
      told += 1;
    });
    await store.close();
    await expect(audit.record({ action: "content-view", messageId: 1 })).rejects.toThrow();
    expect(told).toBe(0);
  });
});

describe("retention", () => {
  async function aged(retention: string) {
    const root = await makeProject({
      "pathways.yaml":
        "defaults:\n  pollInterval: 10ms\n  retention: 30d\n  retentionInterval: 1h\n",
      "channels/adt/channel.yaml": `${CHANNEL}retention: ${retention}\n`,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    const clock = { now: Date.now() - 10 * DAY };
    const store = await Store.open(project.databaseFile, { now: () => new Date(clock.now) });
    stores.push(store);
    const filtered = async (channel: string): Promise<void> => {
      const { id } = await store.receive(channel, new Uint8Array([1]));
      await store.completeTransform(id, [], 1);
    };
    await filtered("adt");
    await filtered("old-channel");
    const { id: failed } = await store.receive("adt", new Uint8Array([2]));
    await store.failTransform(failed, "transform: TypeError");
    clock.now = Date.now();
    return { project, store };
  }

  it("deletes per each channel's period, keeps failed messages, and uses the engine's default for a channel no longer configured", async () => {
    const { project, store } = await aged("7d");
    expect(project.channels[0]?.settings).toMatchObject({
      retentionMs: 7 * DAY,
      retentionIntervalMs: 3_600_000,
    });
    expect(project.settings.retentionMs).toBe(30 * DAY);

    const now = Date.now();
    const dry = await runRetention(store, project, { now, dryRun: true });
    expect(dry).toEqual({
      dryRun: true,
      messages: 1,
      deliveries: 0,
      channels: {
        adt: {
          retentionMs: 7 * DAY,
          cutoff: new Date(now - 7 * DAY).toISOString(),
          configured: true,
          messages: 1,
          deliveries: 0,
        },
        "old-channel": {
          retentionMs: 30 * DAY,
          cutoff: new Date(now - 30 * DAY).toISOString(),
          configured: false,
          messages: 0,
          deliveries: 0,
        },
      },
    });
    const audit = new AuditLog(store, { actor: "tester" });
    expect(await recordRetention(audit, dry)).toBeUndefined();
    const real = await runRetention(store, project, { now, dryRun: false });
    expect(real).toMatchObject({ dryRun: false, messages: 1 });
    expect(await recordRetention(audit, real)).toMatchObject({
      action: "retention",
      detail: { messages: 1, deliveries: 0, channels: 2 },
    });
    expect(await store.messageCounts("adt")).toMatchObject({ filtered: 0, failed: 1 });
    expect(await store.messageCounts("old-channel")).toMatchObject({ filtered: 1 });
  });

  it("runs in the engine at start and every interval, recorded and logged in counts only", async () => {
    const { project, store } = await aged("1d");
    const { logger, events, lines } = captureLogger();
    const clock = { now: Date.now() };
    const engine = new Engine({ project, store, logger, now: () => clock.now });
    engines.push(engine);
    const seen: AuditEntry[] = [];
    engine.audit.subscribe((entry) => {
      seen.push(entry);
    });
    engine.audit.subscribe(() => {
      throw Object.assign(new Error("a hook failed"), { code: "EHOOK" });
    });
    await engine.start();
    const stop = new AbortController();
    const running = engine.run(stop.signal);
    for (let i = 0; i < 100 && seen.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(seen).toEqual([
      expect.objectContaining({
        action: "retention",
        detail: { messages: 1, deliveries: 0, channels: 2 },
      }),
    ]);
    // Not again until the interval has passed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(1);
    clock.now += 3_600_000;
    for (let i = 0; i < 100 && seen.length === 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stop.abort();
    await running;
    expect(seen[1]).toMatchObject({ action: "retention", detail: { messages: 0 } });
    expect(events.filter((e) => e.event === "retention")[0]).toMatchObject({
      messages: 1,
      deliveries: 0,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ event: "audit-listener-failed", code: "EHOOK" }),
    );
    expect(lines.join("")).not.toContain("a hook failed");
  });

  it("logs a failed run by its code and carries on", async () => {
    const { project, store } = await aged("1d");
    const { logger, events } = captureLogger();
    const engine = new Engine({ project, store, logger });
    await store.close();
    stores.splice(0);
    expect(await engine.retention()).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ event: "retention-failed" }));
  });
});

describe("configuration changes", () => {
  it("records what changed since the last start, as fingerprints, never content", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
      "channels/lab/channel.yaml": CHANNEL.replace("transform: ./transform.ts\n", ""),
    });
    const store = await Store.open(join(root, "pathways.db"));
    stores.push(store);
    const audit = new AuditLog(store, { actor: "tester" });
    const changes = async () =>
      (await recordConfigChanges(await loadProject(root), store, audit)).map((e) => [
        e.channel,
        e.detail["change"],
      ]);

    expect(await changes()).toEqual([
      [null, "added"],
      ["adt", "added"],
      ["lab", "added"],
    ]);
    const prints = await configFingerprints(await loadProject(root));
    expect(prints.get("")).toEqual({ yaml: "none" });
    expect(prints.get("lab")).toMatchObject({ transform: "none" });
    expect(prints.get("adt")?.["transform"]).toMatch(/^[0-9a-f]{64}$/);
    expect(await changes()).toEqual([]);

    await writeFile(join(root, "channels/adt/transform.ts"), `${LAB_TRANSFORM}\n// edited\n`);
    await writeFile(join(root, "pathways.yaml"), "defaults:\n  retention: 7d\n");
    expect(await changes()).toEqual([
      [null, "changed"],
      ["adt", "changed"],
    ]);

    await rm(join(root, "channels/lab"), { recursive: true });
    expect(await changes()).toEqual([["lab", "removed"]]);
    expect(await changes()).toEqual([]);
    await writeFile(join(root, "channels/adt/channel.yaml"), CHANNEL);
    expect(await changes()).toEqual([]);

    const entries = (await store.auditEntries({ action: "config", limit: 50 })).items;
    expect(JSON.stringify(entries)).not.toContain("LAB2");
    expect(entries.every((e) => e.actor === "tester")).toBe(true);
  });

  it("fingerprints a file it cannot read as unreadable", async () => {
    // Root reads any file whatever its mode, so there is nothing to check as root.
    if (process.getuid?.() === 0) return;
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": LAB_TRANSFORM,
    });
    const project = await loadProject(root);
    await chmod(join(root, "channels/adt/transform.ts"), 0o000);
    try {
      expect((await configFingerprints(project)).get("adt")).toMatchObject({
        transform: "unreadable",
      });
    } finally {
      await chmod(join(root, "channels/adt/transform.ts"), 0o644);
    }
  });
});
