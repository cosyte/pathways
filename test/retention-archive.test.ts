import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadProject } from "../src/config/load.js";
import type { ProjectConfig } from "../src/config/schema.js";
import { EncryptedStore } from "../src/encryption/encrypted-store.js";
import { decrypt, encrypt, EncryptionError } from "../src/encryption/envelope.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import {
  archivedMessage,
  LOCAL_ARCHIVE_FILES,
  openArchive,
  sealArchive,
  type ArchiveError,
  type ArchiveFiles,
  type ArchivedMessage,
} from "../src/operator/archive.js";
import { AuditLog } from "../src/operator/audit.js";
import { retentionCommand } from "../src/operator/commands.js";
import { Engine } from "../src/engine/engine.js";
import { runRetention, type RetentionOptions } from "../src/operator/retention.js";
import type { MessageStore, RetentionStore } from "../src/storage/store.js";
import { available, closeAdmins, dropDatabases, TEST_DATABASES, testStorage } from "./databases.js";
import { captureLogger, cleanUp, makeProject } from "./helpers.js";

const DAY = 86_400_000;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const CHANNEL = `
source:
  file: { dir: ../../data/inbox, minAge: 0 }
destinations:
  - file: { dir: ../../data/out }
`;

const keys = new LocalKeyProvider([["synthetic-key", randomBytes(KEY_BYTES)]], "synthetic-key");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const read = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

/** A project whose `pathways.yaml` defaults hold `retention`, with one channel, `adt`. */
async function project(retention: string, channel = CHANNEL): Promise<ProjectConfig> {
  const root = await makeProject({
    "pathways.yaml": `defaults:\n  retention: ${retention}\n`,
    "channels/adt/channel.yaml": channel,
  });
  return loadProject(root);
}

describe("retention's configuration", () => {
  it("keeps the 30-day default and the shorthand, and reads the block written out", async () => {
    const plain = await loadProject(await makeProject({ "channels/adt/channel.yaml": CHANNEL }));
    expect(plain.settings.retentionMs).toBe(30 * DAY);
    expect(plain.settings.retentionClocks).toBeUndefined();
    expect(plain.archive).toBeUndefined();

    const short = await project("7d");
    expect(short.channels[0]?.settings.retentionMs).toBe(7 * DAY);
    expect(short.channels[0]?.settings.retentionClocks).toBeUndefined();

    const full = await project(
      "{ archive: { dir: ./archive }, content: 7d, metadata: 90d, failed: 180d, audit: never }",
      `${CHANNEL}retention: { content: 3d }\n`,
    );
    expect(full.archive).toEqual({ dir: join(full.root, "archive") });
    expect(full.settings).toMatchObject({
      retentionMs: 90 * DAY,
      retentionClocks: { contentMs: 7 * DAY, failedMs: 180 * DAY },
    });
    // A channel's block sets the clocks it names and keeps the others.
    expect(full.channels[0]?.settings).toMatchObject({
      retentionMs: 90 * DAY,
      retentionClocks: { contentMs: 3 * DAY, failedMs: 180 * DAY },
    });
  });

  it("refuses a metadata clock shorter than the content clock, in pathways.yaml or a channel", async () => {
    await expect(project("{ content: 30d, metadata: 7d }")).rejects.toThrow(
      /pathways\.yaml: retention\.metadata: .* is shorter than retention\.content/,
    );
    await expect(
      project("{ content: 7d, metadata: 30d }", `${CHANNEL}retention: 5d\n`),
    ).rejects.toThrow(/channel\.yaml: retention\.metadata: .* is shorter than retention\.content/);
  });

  it("refuses an archive without encryption keys, and an archive or an audit clock in a channel", async () => {
    const root = await makeProject({
      "pathways.yaml":
        "encryption: none\ndefaults:\n  retention: { archive: { dir: ./archive } }\n",
      "channels/adt/channel.yaml": CHANNEL,
    });
    await expect(loadProject(root)).rejects.toThrow(ConfigError);
    await expect(loadProject(root)).rejects.toThrow(/retention\.archive: .*encryption: none/);
    await expect(
      project("30d", `${CHANNEL}retention: { archive: { dir: ./archive } }\n`),
    ).rejects.toThrow(ConfigError);
    await expect(project("{ audit: 30d }")).rejects.toThrow(ConfigError);
  });
});

describe("an archive", () => {
  const message = (id: number, channel = "adt"): ArchivedMessage => ({
    id,
    channel,
    status: "transformed",
    receivedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    size: 9,
    generation: 0,
    duplicateOf: null,
    contentHash: null,
    contentDroppedAt: null,
    error: null,
    body: Buffer.from("SYNTHETIC").toString("base64"),
    outputs: [],
    deliveries: [],
  });
  const sealed = () =>
    sealArchive(
      {
        channel: "adt",
        step: "metadata",
        created: "2026-11-11T00:00:00.000Z",
        messages: [message(1), message(2)],
      },
      keys,
    );

  /** The archive's lines, changed by `edit` and sealed again under the same envelope. */
  async function reseal(edit: (lines: string[]) => string[]): Promise<Buffer> {
    const lines = gunzipSync(await decrypt(await sealed(), keys))
      .toString("utf8")
      .trimEnd()
      .split("\n");
    return encrypt(gzipSync(`${edit(lines).join("\n")}\n`), keys);
  }

  it("is gzipped NDJSON inside the envelope, with a header and a trailer", async () => {
    const bytes = await sealed();
    // The envelope's marker, a zero byte and PWE; inside it, gzip's.
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x50, 0x57, 0x45]);
    const packed = await decrypt(bytes, keys);
    expect([...packed.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    const lines = gunzipSync(packed).toString("utf8").trimEnd().split("\n");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      format: "pathways-archive",
      version: 1,
      channel: "adt",
      keyId: "synthetic-key",
      created: "2026-11-11T00:00:00.000Z",
      step: "metadata",
    });
    expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ trailer: true, count: 2 });
    const opened = await openArchive(bytes, keys);
    expect(opened.messages.map((m) => m.id)).toEqual([1, 2]);
    // One data key per file: the same records seal to different bytes.
    expect((await sealed()).equals(bytes)).toBe(false);
  });

  it("refuses a master key it does not hold", async () => {
    const other = new LocalKeyProvider([["other", randomBytes(KEY_BYTES)]], "other");
    const error = await openArchive(await sealed(), other).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EncryptionError);
    expect((error as EncryptionError).code).toBe("ERR_PATHWAYS_UNKNOWN_KEY");
  });

  it("refuses records that do not match the trailer, and a record of another channel", async () => {
    const code = (bytes: Buffer) =>
      openArchive(bytes, keys).catch((error: unknown) => (error as ArchiveError).code);
    const dropped = await reseal((lines) => [lines[0] ?? "", lines[1] ?? "", lines.at(-1) ?? ""]);
    expect(await code(dropped)).toBe("ERR_PATHWAYS_ARCHIVE_INTEGRITY");
    const changed = await reseal((lines) =>
      lines.map((line, index) => (index === 1 ? line.replace('"id":1', '"id":7') : line)),
    );
    expect(await code(changed)).toBe("ERR_PATHWAYS_ARCHIVE_INTEGRITY");
    const unsealed = await reseal((lines) => lines.slice(0, -1));
    expect(await code(unsealed)).toBe("ERR_PATHWAYS_ARCHIVE_FORMAT");
    const other = await sealArchive(
      {
        channel: "adt",
        step: "content",
        created: "2026-11-11T00:00:00.000Z",
        messages: [message(1, "lab")],
      },
      keys,
    );
    expect(await code(other)).toBe("ERR_PATHWAYS_ARCHIVE_INTEGRITY");
  });

  it("caps the file, its decompressed size and each record", async () => {
    const bytes = await sealed();
    const limits = { maxFileBytes: 1e9, maxDecompressedBytes: 1e9, maxRecordBytes: 1e9 };
    const code = (over: Partial<typeof limits>) =>
      openArchive(bytes, keys, { ...limits, ...over }).catch(
        (error: unknown) => (error as ArchiveError).code,
      );
    expect(await code({ maxFileBytes: 16 })).toBe("ERR_PATHWAYS_ARCHIVE_TOO_LARGE");
    expect(await code({ maxDecompressedBytes: 64 })).toBe("ERR_PATHWAYS_ARCHIVE_TOO_LARGE");
    expect(await code({ maxRecordBytes: 32 })).toBe("ERR_PATHWAYS_ARCHIVE_TOO_LARGE");
  });

  it("refuses what is not an archive inside a good envelope", async () => {
    const code = async (inside: Buffer) =>
      openArchive(await encrypt(inside, keys), keys).catch(
        (error: unknown) => (error as ArchiveError).code,
      );
    expect(await code(Buffer.from("not gzip"))).toBe("ERR_PATHWAYS_ARCHIVE_FORMAT");
    expect(await code(gzipSync("{}"))).toBe("ERR_PATHWAYS_ARCHIVE_FORMAT");
    expect(await code(gzipSync("not json\n{}\n"))).toBe("ERR_PATHWAYS_ARCHIVE_FORMAT");
    expect(await code(gzipSync("[]\n{}\n"))).toBe("ERR_PATHWAYS_ARCHIVE_FORMAT");
    const short = await reseal((lines) =>
      lines.map((line, index) =>
        index === lines.length - 1 ? JSON.stringify({ trailer: true, count: 2, hmac: "00" }) : line,
      ),
    );
    expect(
      await openArchive(short, keys).catch((error: unknown) => (error as ArchiveError).code),
    ).toBe("ERR_PATHWAYS_ARCHIVE_INTEGRITY");
  });
});

for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`retention's clocks on ${database.label}`, () => {
    /** An encrypted store on `database` whose clock the test moves. */
    async function storeFor(config: ProjectConfig) {
      const clock = { now: Date.now() - 200 * DAY };
      const raw = await (
        await testStorage(database, config.databaseFile)
      ).open({ now: () => new Date(clock.now) });
      closers.push(() => raw.close());
      const store = new EncryptedStore(raw, keys);
      return { store, clock };
    }

    /** A message of `adt`, delivered to its one destination. */
    async function delivered(store: MessageStore, body: string): Promise<number> {
      const { id } = await store.receive("adt", text(body));
      await store.completeTransform(id, [text(`out ${body}`)], 1);
      const delivery = await store.nextDelivery("adt", 0);
      if (delivery === undefined) throw new Error("no delivery");
      await store.markDelivered(delivery.id);
      return id;
    }

    async function failed(store: MessageStore): Promise<number> {
      const { id } = await store.receive("adt", text("SYNTHETIC-FAILED"));
      await store.failTransform(id, "transform: TypeError");
      return id;
    }

    const run = (
      store: MessageStore,
      config: ProjectConfig,
      extra: Partial<RetentionOptions> = {},
    ) => runRetention(store, config, { now: Date.now(), dryRun: false, keys, ...extra });

    it("drops content on its own clock and keeps the row, which replay then refuses", async () => {
      const config = await project("{ content: 7d, metadata: 90d }");
      const { store, clock } = await storeFor(config);
      clock.now = Date.now() - 10 * DAY;
      const id = await delivered(store, "SYNTHETIC-1");
      clock.now = Date.now();
      const recent = await delivered(store, "SYNTHETIC-2");

      const dry = await run(store, config, { dryRun: true });
      expect(dry.channels["adt"]).toMatchObject({
        messages: 0,
        content: { messages: 1, deliveries: 1 },
      });
      expect(dry.pruned).toBe(1);
      expect(read(await store.messageBody(id))).toBe("SYNTHETIC-1");

      const report = await run(store, config);
      expect(report).toMatchObject({ messages: 0, pruned: 1 });
      expect(await store.messageBody(id)).toBeUndefined();
      expect(await store.outputs(id)).toEqual([]);
      expect((await store.message(id))?.contentDroppedAt).toBeDefined();
      expect(read(await store.messageBody(recent))).toBe("SYNTHETIC-2");
      const refused = await store.requeue(
        id,
        { mode: "resend", expected: "transformed", outputs: [], destinations: 1 },
        "tester",
      );
      expect(refused).toMatchObject({ done: false, reason: "content-dropped" });
    });

    it("deletes a dropped row on the metadata clock of a block, and leaves it under the shorthand", async () => {
      const block = await project("{ content: 7d, metadata: 30d }");
      const { store, clock } = await storeFor(block);
      clock.now = Date.now() - 40 * DAY;
      const id = await delivered(store, "SYNTHETIC-3");
      await run(store, block, { now: Date.now() - 20 * DAY });
      expect((await store.message(id))?.contentDroppedAt).toBeDefined();

      const short = { ...block, settings: { ...block.settings, retentionClocks: undefined } };
      const shortChannels = short.channels.map((c) => ({
        ...c,
        settings: { ...c.settings, retentionClocks: undefined },
      }));
      expect((await run(store, { ...short, channels: shortChannels })).messages).toBe(0);
      expect(await store.message(id)).toBeDefined();

      expect((await run(store, block)).messages).toBe(1);
      expect(await store.message(id)).toBeUndefined();
    });

    it("deletes a failed message on the failed clock, and keeps it without one", async () => {
      const config = await project("{ failed: 180d }");
      const { store, clock } = await storeFor(config);
      clock.now = Date.now() - 190 * DAY;
      const old = await failed(store);
      clock.now = Date.now() - 10 * DAY;
      const young = await failed(store);
      const report = await run(store, config);
      expect(report.channels["adt"]?.failed).toMatchObject({ messages: 1, retentionMs: 180 * DAY });
      expect(await store.message(old)).toBeUndefined();
      expect(await store.message(young)).toBeDefined();

      const without = await project("{ metadata: 1d }");
      expect((await run(store, without)).messages).toBe(0);
      expect(await store.message(young)).toBeDefined();
    });

    it("changes nothing given no ids, or ids a step no longer reaches", async () => {
      const config = await project("{ content: 7d, metadata: 90d }");
      const { store, clock } = await storeFor(config);
      clock.now = Date.now();
      const id = await delivered(store, "SYNTHETIC-5");
      const steps = store as unknown as RetentionStore;
      const query = {
        step: "content" as const,
        cutoff: new Date(Date.now() - 7 * DAY).toISOString(),
      };
      expect(await steps.applyExpiry("adt", [], query)).toEqual({ messages: 0, deliveries: 0 });
      expect(await steps.applyExpiry("adt", [id], query)).toEqual({ messages: 0, deliveries: 0 });
      expect(read(await store.messageBody(id))).toBe("SYNTHETIC-5");
    });

    it("prints each clock's counts, and fails a run that left a channel alone", async () => {
      const config = await project(
        "{ archive: { dir: ./archive }, content: 7d, metadata: 30d, failed: 60d }",
      );
      const { store, clock } = await storeFor(config);
      clock.now = Date.now() - 40 * DAY;
      await delivered(store, "SYNTHETIC-6");
      await failed(store);
      const out: string[] = [];
      const err: string[] = [];
      const context = {
        project: config,
        store,
        audit: new AuditLog(store, { actor: "tester" }),
        json: false,
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
        now: Date.now,
        keys,
      };
      expect(await retentionCommand(context, true)).toBe(0);
      expect(out.join("")).toMatch(/Content would be dropped from 1 message\./);
      expect(out.join("")).toMatch(/    content: 1 message \(done, and last active before /);
      expect(out.join("")).toMatch(/    failed: 0 messages, 0 deliveries \(last active before /);
      out.length = 0;
      expect(await retentionCommand({ ...context, keys: undefined }, false)).toBe(1);
      expect(out.join("")).toMatch(/left alone from here: ERR_PATHWAYS_ARCHIVE_NO_KEYS/);
      expect(err.join("")).toMatch(/retention left 1 channel alone part way/);
      out.length = 0;
      expect(await retentionCommand(context, false)).toBe(0);
      expect(out.join("")).toMatch(/Content was dropped from 1 message\./);
      expect(out.join("")).toMatch(/2 archives written and checked first\./);
    });

    it("logs a channel the engine's run left alone, and what an archiving run did", async () => {
      const config = await project("{ archive: { dir: ./archive }, metadata: 30d }");
      const { store, clock } = await storeFor(config);
      clock.now = Date.now() - 40 * DAY;
      await delivered(store, "SYNTHETIC-7");
      const keyless = captureLogger();
      await new Engine({ project: config, store, logger: keyless.logger }).retention();
      expect(keyless.events).toContainEqual(
        expect.objectContaining({
          event: "retention-skipped",
          channel: "adt",
          code: "ERR_PATHWAYS_ARCHIVE_NO_KEYS",
        }),
      );
      const keyed = captureLogger();
      await new Engine({ project: config, store, logger: keyed.logger, keys }).retention();
      expect(keyed.events).toContainEqual(
        expect.objectContaining({ event: "retention", messages: 1, archives: 1 }),
      );
    });

    it("skips the clocks on a store without the retention methods", async () => {
      const config = await project("{ content: 7d }");
      const bare = {
        channels: () => Promise.resolve(["adt"]),
        expire: () => Promise.resolve({ messages: 0, deliveries: 0 }),
      } as unknown as MessageStore;
      const report = await runRetention(bare, config, { now: Date.now(), dryRun: false });
      expect(report.channels["adt"]?.skipped).toBe("ERR_PATHWAYS_RETENTION_UNSUPPORTED");
    });

    describe("with an archive", () => {
      async function archived(batch: number) {
        const config = await project("{ archive: { dir: ./archive }, metadata: 30d }");
        const { store, clock } = await storeFor(config);
        clock.now = Date.now() - 40 * DAY;
        const ids = [];
        for (const n of [1, 2, 3]) ids.push(await delivered(store, `SYNTHETIC-${String(n)}`));
        const dir = join(config.root, "archive", "adt");
        const files = async () =>
          (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".pwa")).sort();
        const entries = async () => (await store.auditEntries({ limit: 50 })).items;
        const options = { batch, audit: new AuditLog(store, { actor: "tester" }) };
        return { config, store, ids, dir, files, entries, options };
      }

      it("writes, checks and audits one sealed archive a batch, then deletes", async () => {
        const { config, store, ids, dir, files, entries, options } = await archived(2);
        const report = await run(store, config, options);
        expect(report).toMatchObject({ messages: 3, archives: 2 });
        const written = await files();
        expect(written).toHaveLength(2);
        const opened = await Promise.all(
          written.map(async (file) => openArchive(await readFile(join(dir, file)), keys)),
        );
        expect(opened.flatMap((a) => a.messages.map((m) => m.id))).toEqual(ids);
        const first = opened[0]?.messages[0];
        expect(Buffer.from(first?.body ?? "", "base64").toString()).toBe("SYNTHETIC-1");
        expect(first?.outputs.map((o) => Buffer.from(o, "base64").toString())).toEqual([
          "out SYNTHETIC-1",
        ]);
        expect(first?.deliveries).toMatchObject([{ status: "delivered", attempts: 0 }]);
        // Nothing left half written, and each archive was audited before the run's own entry.
        expect((await readdir(dir)).filter((f) => f.endsWith(".partial"))).toEqual([]);
        expect((await entries()).map((e) => [e.action, e.detail["messages"]]).reverse()).toEqual([
          ["archive", 2],
          ["archive", 1],
        ]);
        for (const id of ids) expect(await store.message(id)).toBeUndefined();
      });

      const failing = (step: keyof ArchiveFiles): ArchiveFiles => ({
        ...LOCAL_ARCHIVE_FILES,
        [step]: () => Promise.reject(Object.assign(new Error("injected"), { code: "EINJECTED" })),
      });

      for (const step of ["makeDir", "write", "sync", "rename", "syncDir"] as const) {
        it(`deletes nothing and logs a code when ${step} fails`, async () => {
          const { config, store, ids, files, entries, options } = await archived(2);
          const skipped: string[] = [];
          const report = await run(store, config, {
            ...options,
            files: failing(step),
            onSkip: (channel, code) => skipped.push(`${channel} ${code}`),
          });
          expect(report).toMatchObject({ messages: 0, skipped: 1 });
          expect(report.channels["adt"]?.skipped).toBe("EINJECTED");
          expect(skipped).toEqual(["adt EINJECTED"]);
          expect(await files()).toEqual([]);
          expect(await entries()).toEqual([]);
          for (const id of ids) expect(await store.message(id)).toBeDefined();
        });
      }

      it("starts a new archive once one holds enough, and names a failure without a code", async () => {
        const { config, store, files, options } = await archived(10);
        const plain = await run(store, config, {
          ...options,
          files: { ...LOCAL_ARCHIVE_FILES, write: () => Promise.reject(new Error("no code")) },
        });
        expect(plain.channels["adt"]?.skipped).toBe("ERR_PATHWAYS_ARCHIVE");
        expect(await run(store, config, { ...options, archiveBytes: 1 })).toMatchObject({
          messages: 3,
          archives: 3,
        });
        expect(await files()).toHaveLength(3);
      });

      it("archives on the metadata clock alone in a project built without clocks", async () => {
        const { config, store, files, options } = await archived(10);
        const bare = {
          ...config,
          settings: { ...config.settings, retentionClocks: undefined },
          channels: config.channels.map((c) => ({
            ...c,
            settings: { ...c.settings, retentionClocks: undefined },
          })),
        };
        expect(await run(store, bare, options)).toMatchObject({ messages: 3, archives: 1 });
        expect(await files()).toHaveLength(1);
      });

      it("deletes nothing when the file read back is not what was written", async () => {
        const { config, store, ids, files, options } = await archived(2);
        const report = await run(store, config, {
          ...options,
          files: {
            ...LOCAL_ARCHIVE_FILES,
            read: async (path) => {
              const bytes = Buffer.from(await LOCAL_ARCHIVE_FILES.read(path));
              bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
              return bytes;
            },
          },
        });
        expect(report.channels["adt"]?.skipped).toBe("ERR_PATHWAYS_INTEGRITY");
        expect(await files()).toEqual([]);
        // A sound archive, but not the one written: other ids.
        const other = await sealArchive(
          { channel: "adt", step: "metadata", created: new Date().toISOString(), messages: [] },
          keys,
        );
        const swapped = await run(store, config, {
          ...options,
          files: { ...LOCAL_ARCHIVE_FILES, read: () => Promise.resolve(other) },
        });
        expect(swapped.channels["adt"]?.skipped).toBe("ERR_PATHWAYS_ARCHIVE_INTEGRITY");
        expect(await files()).toEqual([]);
        for (const id of ids) expect(await store.message(id)).toBeDefined();
      });

      it("passes over a message gone since it was listed, and keeps going when a cleanup fails", async () => {
        const { config, store, ids, files, options } = await archived(10);
        expect(await archivedMessage(store, 9_999)).toBeUndefined();
        Object.defineProperty(store, "message", {
          value: () => Promise.resolve(undefined),
          configurable: true,
        });
        expect(await run(store, config, options)).toMatchObject({ messages: 0, archives: 0 });
        Reflect.deleteProperty(store, "message");
        const report = await run(store, config, {
          ...options,
          files: {
            ...LOCAL_ARCHIVE_FILES,
            syncDir: () => Promise.reject(Object.assign(new Error("x"), { code: "EIO" })),
            remove: () => Promise.reject(new Error("cannot remove")),
          },
        });
        expect(report.channels["adt"]?.skipped).toBe("EIO");
        for (const id of ids) expect(await store.message(id)).toBeDefined();
        // The archive that did not prove itself is still there; nothing was deleted on its strength.
        expect(await files()).toHaveLength(1);
      });

      it("names a channel's folder so no name leaves the archive folder", async () => {
        const { config, store, options } = await archived(10);
        const { id } = await store.receive("lab.v2", text("SYNTHETIC-8"));
        await store.completeTransform(id, [], 1);
        await run(store, config, { ...options, now: Date.now() + 40 * DAY });
        expect(await readdir(join(config.root, "archive"))).toEqual(["adt", "lab%2ev2"]);
      });

      it("deletes nothing when the archive cannot be audited, or there are no keys", async () => {
        const { config, store, ids, options } = await archived(2);
        const broken = {
          appendAudit: () => Promise.reject(Object.assign(new Error("x"), { code: "EAUDIT" })),
        } as unknown as MessageStore;
        const audited = await run(store, config, { ...options, audit: new AuditLog(broken) });
        expect(audited.channels["adt"]?.skipped).toBe("EAUDIT");
        const keyless = await run(store, config, { ...options, keys: undefined });
        expect(keyless.channels["adt"]?.skipped).toBe("ERR_PATHWAYS_ARCHIVE_NO_KEYS");
        for (const id of ids) expect(await store.message(id)).toBeDefined();
      });

      it("leaves a duplicate archive and no loss when the delete fails after the archive", async () => {
        const { config, store, ids, files, options } = await archived(10);
        const steps = store as unknown as RetentionStore;
        const apply = steps.applyExpiry.bind(steps);
        Object.defineProperty(store, "applyExpiry", {
          value: () => Promise.reject(Object.assign(new Error("lost"), { code: "ELOST" })),
          configurable: true,
        });
        await expect(run(store, config, options)).rejects.toMatchObject({ code: "ELOST" });
        expect(await files()).toHaveLength(1);
        for (const id of ids) expect(await store.message(id)).toBeDefined();

        Object.defineProperty(store, "applyExpiry", { value: apply, configurable: true });
        expect(await run(store, config, options)).toMatchObject({ messages: 3, archives: 1 });
        expect(await files()).toHaveLength(2);
        for (const id of ids) expect(await store.message(id)).toBeUndefined();
      });

      it("archives a message whose content was dropped with what it still holds", async () => {
        const config = await project("{ archive: { dir: ./archive }, content: 7d, metadata: 30d }");
        const { store, clock } = await storeFor(config);
        clock.now = Date.now() - 40 * DAY;
        const id = await delivered(store, "SYNTHETIC-9");
        const report = await run(store, config, { now: Date.now() - 20 * DAY });
        expect(report).toMatchObject({ pruned: 1, archives: 1 });
        expect(await run(store, config)).toMatchObject({ messages: 1, archives: 1 });
        const dir = join(config.root, "archive", "adt");
        const opened = await Promise.all(
          (await readdir(dir))
            .sort()
            .map(async (f) => openArchive(await readFile(join(dir, f)), keys)),
        );
        expect(
          opened.map((a) => [a.header.step, a.messages[0]?.id, a.messages[0]?.body !== null]),
        ).toEqual([
          ["content", id, true],
          ["metadata", id, false],
        ]);
      });
    });
  });
}
