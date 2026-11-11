import { createSecretKey, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import SqliteDatabase from "better-sqlite3";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { EXIT, run } from "../src/cli.js";
import { ConfigError, loadProject } from "../src/config/load.js";
import type { MetaIndexConfig } from "../src/config/schema.js";
import {
  indexKeyInfo,
  indexTag,
  isLowEntropyKey,
  MetaIndexer,
  metaText,
  projectIndexes,
} from "../src/encryption/blind-index.js";
import {
  EncryptedStore,
  MetaSearchError,
  UnencryptedStore,
  canSearchMeta,
} from "../src/encryption/encrypted-store.js";
import { decryptTextWithKeyId, isEncryptedText } from "../src/encryption/envelope.js";
import {
  decodeKey,
  generateKey,
  KEY_BYTES,
  LocalKeyProvider,
  type KeyProvider,
} from "../src/encryption/keys.js";
import { rekey } from "../src/encryption/rekey.js";
import { AuditLog } from "../src/operator/audit.js";
import { searchCommand } from "../src/operator/commands.js";
import { openStore } from "../src/storage/open.js";
import { isMetaStore, Store, type AuditEntry, type StoredMeta } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  freshDatabase,
  TEST_DATABASES,
  type TestDatabase,
} from "./databases.js";
import { ADT_A01, captureLogger, cleanUp, makeProject, type LogEvent } from "./helpers.js";
import { MemoryStore } from "./memory-store.js";

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((closable) => closable.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

/** Master keys by id, each 32 fresh bytes, and providers over any of them. */
function keyring(...ids: string[]): (current: string, ...others: string[]) => LocalKeyProvider {
  const raw = new Map(ids.map((id) => [id, randomBytes(KEY_BYTES)] as const));
  return (current, ...others) =>
    new LocalKeyProvider(
      [current, ...others].map((id) => [id, raw.get(id) as Buffer] as const),
      current,
    );
}

/** One channel's indexes. */
function indexes(
  channel: string,
  ...entries: MetaIndexConfig[]
): ReadonlyMap<string, readonly MetaIndexConfig[]> {
  return new Map([[channel, entries]]);
}

describe("index tags", () => {
  it("keeps the first bits of an HMAC-SHA-256, the rest of the last byte zero", () => {
    const key = createSecretKey(randomBytes(32));
    const twelve = indexTag(key, "SYN-000123", 12);
    expect(twelve).toMatch(/^[0-9a-f]{3}0$/);
    expect(indexTag(key, "SYN-000123", 16)).toMatch(/^[0-9a-f]{4}$/);
    expect(indexTag(key, "SYN-000123", 16).slice(0, 3)).toBe(twelve.slice(0, 3));
    expect(indexTag(key, "SYN-000123", 4)).toMatch(/^[0-9a-f]0$/);
    expect(indexTag(key, "SYN-000123", 32)).toHaveLength(8);
    // The same key and value always give the same tag.
    expect(indexTag(key, "SYN-000123", 12)).toBe(twelve);
  });

  it("tags a value as text, so a number and its digits tag alike", () => {
    expect(metaText(42)).toBe("42");
    expect(metaText(true)).toBe("true");
  });

  it("derives a key of its own for each master key, channel and index", async () => {
    const keys = keyring("a", "b")("a", "b");
    const derive = async (keyId: string, channel: string, index: string): Promise<string> =>
      Buffer.from(await keys.deriveIndexKey(keyId, indexKeyInfo(keyId, channel, index))).toString(
        "hex",
      );
    const first = await derive("a", "adt", "mrn");
    expect(first).toHaveLength(KEY_BYTES * 2);
    expect(await derive("a", "adt", "mrn")).toBe(first);
    const others = [
      await derive("b", "adt", "mrn"),
      await derive("a", "lab", "mrn"),
      await derive("a", "adt", "accession"),
    ];
    expect(new Set([first, ...others]).size).toBe(4);
    expect(keys.keyIds).toEqual(["a", "b"]);
    await expect(
      keys.deriveIndexKey("gone", indexKeyInfo("gone", "adt", "mrn")),
    ).rejects.toMatchObject({
      code: "ERR_PATHWAYS_UNKNOWN_KEY",
    });
  });

  it("refuses a key provider that cannot derive index keys when a channel has an index", () => {
    const local = keyring("a")("a");
    const kms: KeyProvider = {
      currentKeyId: "a",
      wrapKey: (key) => local.wrapKey(key),
      unwrapKey: (id, wrapped) => local.unwrapKey(id, wrapped),
    };
    expect(() => new MetaIndexer(kms, indexes("adt", { key: "mrn", bits: 12 }))).toThrow(
      ConfigError,
    );
    // With no index, such a provider still runs.
    expect(() => new MetaIndexer(kms, new Map())).not.toThrow();
  });

  it("tries a failed index key derivation again on the next message", async () => {
    const local = keyring("a")("a");
    let calls = 0;
    const flaky: KeyProvider = {
      currentKeyId: "a",
      wrapKey: (key) => local.wrapKey(key),
      unwrapKey: (id, wrapped) => local.unwrapKey(id, wrapped),
      deriveIndexKey: (id, info) => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("the key service did not answer"))
          : local.deriveIndexKey(id, info);
      },
    };
    const indexer = new MetaIndexer(flaky, indexes("adt", { key: "mrn", bits: 12 }));
    await expect(indexer.tagsFor("adt", { mrn: "SYN-1" })).rejects.toThrow("did not answer");
    const [tag] = await indexer.tagsFor("adt", { mrn: "SYN-1" });
    expect(tag).toMatchObject({ index: "mrn", keyId: "a" });
    // Derived once, then kept.
    await indexer.tagsFor("adt", { mrn: "SYN-2" });
    expect(calls).toBe(2);
    // A key that is not in the message gets no tag.
    expect(await indexer.tagsFor("adt", { accession: "ACC-1" })).toEqual([]);
    // A provider that does not list its key ids is searched under its current key alone.
    expect((await indexer.condition("adt", "mrn", "SYN-1"))?.tags).toEqual([
      { keyId: "a", tag: tag?.tag },
    ]);
  });

  it("refuses a search on a store underneath that cannot look up tags", async () => {
    const store = new EncryptedStore(
      new MemoryStore(),
      keyring("a")("a"),
      indexes("adt", { key: "mrn", bits: 12 }),
    );
    await store.receive("adt", bytes("x"), { meta: { mrn: "SYN-1" } });
    await expect(
      store.findByMeta({ channel: "adt", where: [["mrn", "SYN-1"]], limit: 5 }),
    ).rejects.toMatchObject({
      name: "MetaSearchError",
      reason: "unsupported",
      message: "this store cannot be searched by metadata",
    });
  });

  it("names the keys whose values are few or guessable", () => {
    for (const key of ["sex", "Gender", "status", "birth_date", "DateOfBirth", "dob", "zip-code"]) {
      expect(isLowEntropyKey(key)).toBe(true);
    }
    for (const key of ["mrn", "accession", "orderId", "visitNumber"]) {
      expect(isLowEntropyKey(key)).toBe(false);
    }
  });
});

/** A fresh store on `database`: a SQLite file, or a new database on a server. */
async function openRaw(database: TestDatabase): Promise<Store> {
  if (database.kind === "sqlite") {
    return Store.open(join(await makeProject({}), ".pathways/pathways.db"));
  }
  const { storage, env } = await freshDatabase(database);
  return Store.open(storage, { env });
}

// The store-level suites run on every database: SQLite always, each server whose URL is set.
for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`metadata search on ${database.label}`, () => {
    it("stores metadata encrypted, with one tag per index under the current key, and finds by it", async () => {
      const raw = await openRaw(database);
      const keys = keyring("dev")("dev");
      const mrn16: MetaIndexConfig[] = [{ key: "mrn", bits: 16 }];
      const store = new EncryptedStore(
        raw,
        keys,
        new Map([
          ["adt", mrn16],
          ["lab", mrn16],
        ]),
      );
      open.push(store);
      const { id: first } = await store.receive("adt", bytes(ADT_A01), {
        meta: { mrn: "SYN-000123", visit: 2 },
      });
      const { id: second } = await store.receive("adt", bytes(ADT_A01), {
        meta: { mrn: "SYN-000456" },
      });
      await store.receive("adt", bytes(ADT_A01));
      const { id: third } = await store.receive("adt", bytes(ADT_A01), {
        meta: { mrn: "SYN-000123" },
      });

      const stored = await raw.storedMeta(0, 10);
      expect(stored.map((row) => row.id)).toEqual([first, second, third]);
      for (const row of stored) {
        expect(isEncryptedText(row.meta)).toBe(true);
        expect(row.meta).not.toContain("SYN-");
        expect(row.tags).toHaveLength(1);
        expect(row.tags[0]).toMatchObject({ index: "mrn", keyId: "dev" });
        expect(row.tags[0]?.tag).toMatch(/^[0-9a-f]{4}$/);
      }
      expect((await decryptTextWithKeyId(stored[0]?.meta ?? "", keys)).text).toBe(
        JSON.stringify({ mrn: "SYN-000123", visit: 2 }),
      );

      const found = await store.findByMeta({
        channel: "adt",
        where: [["mrn", "SYN-000123"]],
        limit: 50,
      });
      expect(found.items.map((message) => message.id)).toEqual([third, first]);
      expect(found.next).toBeUndefined();
      // The same value tags differently in another channel, and is never found from this one.
      const { id: lab } = await store.receive("lab", bytes(ADT_A01), {
        meta: { mrn: "SYN-000123" },
      });
      const labTag = (await raw.storedMeta(third, 10))[0]?.tags[0]?.tag;
      expect(labTag).not.toBe(stored[0]?.tags[0]?.tag);
      expect(
        (
          await store.findByMeta({ channel: "lab", where: [["mrn", "SYN-000123"]], limit: 50 })
        ).items.map((message) => message.id),
      ).toEqual([lab]);
      expect(
        (
          await store.findByMeta({ channel: "adt", where: [["mrn", "SYN-000123"]], limit: 50 })
        ).items.map((message) => message.id),
      ).toEqual([third, first]);
    });

    it("confirms each tag match by decrypting, so a truncated tag's other values are dropped", async () => {
      const raw = await openRaw(database);
      const keys = keyring("dev")("dev");
      // Four bits: sixteen tags, so among a few dozen values some share the searched one's.
      const index = indexes("adt", { key: "mrn", bits: 4 });
      const store = new EncryptedStore(raw, keys, index);
      open.push(store);
      const indexer = new MetaIndexer(keys, index);
      const tagOf = async (mrn: string): Promise<string | undefined> =>
        (await indexer.tagsFor("adt", { mrn }))[0]?.tag;
      const wanted = await tagOf("SYN-000000");
      let other = 1;
      while ((await tagOf(`SYN-${String(other).padStart(6, "0")}`)) !== wanted) other += 1;
      const { id: a } = await store.receive("adt", bytes("x"), { meta: { mrn: "SYN-000000" } });
      const { id: collides } = await store.receive("adt", bytes("x"), {
        meta: { mrn: `SYN-${String(other).padStart(6, "0")}` },
      });
      const { id: b } = await store.receive("adt", bytes("x"), { meta: { mrn: "SYN-000000" } });
      expect((await raw.storedMeta(0, 10)).map((row) => row.tags[0]?.tag)).toEqual([
        wanted,
        wanted,
        wanted,
      ]);
      const page = await store.findByMeta({
        channel: "adt",
        where: [["mrn", "SYN-000000"]],
        limit: 50,
      });
      // Three rows carry the tag; the one that holds another value is dropped once decrypted.
      expect(page.candidates).toBe(3);
      expect(page.items.map((message) => message.id)).toEqual([b, a]);
      expect(page.items.map((message) => message.id)).not.toContain(collides);
    });

    it("matches every pair, a number as text, and pages by the last id", async () => {
      const raw = await openRaw(database);
      const store = new EncryptedStore(
        raw,
        keyring("dev")("dev"),
        indexes("adt", { key: "mrn", bits: 12 }, { key: "visit", bits: 12 }),
      );
      open.push(store);
      const matching: number[] = [];
      for (let n = 0; n < 5; n += 1) {
        const { id } = await store.receive("adt", bytes("x"), { meta: { mrn: "SYN-1", visit: 7 } });
        matching.push(id);
        await store.receive("adt", bytes("x"), { meta: { mrn: "SYN-1", visit: 8 } });
      }
      const where = [
        ["mrn", "SYN-1"],
        ["visit", "7"],
      ] as const;
      const first = await store.findByMeta({ channel: "adt", where, limit: 2 });
      expect(first.items.map((message) => message.id)).toEqual(matching.slice(3).reverse());
      expect(first.next).toBe(matching[3]);
      const rest = await store.findByMeta({ channel: "adt", where, before: first.next, limit: 5 });
      expect(rest.items.map((message) => message.id)).toEqual(matching.slice(0, 3).reverse());
      expect(rest.next).toBeUndefined();
      // The listing's filters apply too.
      const failed = await store.findByMeta({ channel: "adt", where, state: "failed", limit: 5 });
      expect(failed.items).toEqual([]);
    });

    it("reads at most maxCandidates rows a page, and goes on from where it stopped", async () => {
      const raw = await openRaw(database);
      const store = new EncryptedStore(
        raw,
        keyring("dev")("dev"),
        indexes("adt", { key: "mrn", bits: 12 }),
      );
      open.push(store);
      const ids: number[] = [];
      for (let n = 0; n < 5; n += 1) {
        ids.push((await store.receive("adt", bytes("x"), { meta: { mrn: "SYN-1" } })).id);
      }
      const search = { channel: "adt", where: [["mrn", "SYN-1"]] as const, limit: 50 };
      const first = await store.findByMeta({ ...search, maxCandidates: 3 });
      expect(first.items.map((m) => m.id)).toEqual(ids.slice(2).reverse());
      expect(first).toMatchObject({ candidates: 3, next: ids[2] });
      const rest = await store.findByMeta({ ...search, maxCandidates: 3, before: first.next });
      expect(rest.items.map((m) => m.id)).toEqual(ids.slice(0, 2).reverse());
      expect(rest).toMatchObject({ candidates: 2, next: undefined });
    });

    it("keeps metadata handed to the store itself as JSON, with no tags", async () => {
      const raw = await openRaw(database);
      open.push(raw);
      const { id } = await raw.receive("adt", bytes("x"), { meta: { mrn: "SYN-1", visit: 2 } });
      expect(await raw.storedMeta(0, 10)).toEqual([
        { id, channel: "adt", meta: JSON.stringify({ mrn: "SYN-1", visit: 2 }), tags: [] },
      ]);
    });

    it("refuses a key the channel does not index, and never searches it", async () => {
      const raw = await openRaw(database);
      const store = new EncryptedStore(
        raw,
        keyring("dev")("dev"),
        indexes("adt", { key: "mrn", bits: 12 }),
      );
      open.push(store);
      await store.receive("adt", bytes("x"), { meta: { mrn: "SYN-1", name: "TESTPATIENT" } });
      await expect(
        store.findByMeta({ channel: "adt", where: [["name", "TESTPATIENT"]], limit: 5 }),
      ).rejects.toMatchObject({ reason: "not-indexed", key: "name" });
      const plain = new UnencryptedStore(raw);
      expect(canSearchMeta(plain)).toBe(true);
      await expect(
        plain.findByMeta({ channel: "adt", where: [["mrn", "SYN-1"]], limit: 5 }),
      ).rejects.toBeInstanceOf(MetaSearchError);
    });

    it("finds rows tagged under an older key, and rekey moves their metadata and tags to the current one", async () => {
      const raw = await openRaw(database);
      const ring = keyring("old", "new");
      const index = indexes("adt", { key: "mrn", bits: 12 });
      const before = new EncryptedStore(raw, ring("old"), index);
      const { id: early } = await before.receive("adt", bytes("x"), { meta: { mrn: "SYN-9" } });
      const rotated = new EncryptedStore(raw, ring("new", "old"), index);
      open.push(rotated);
      const { id: late } = await rotated.receive("adt", bytes("x"), { meta: { mrn: "SYN-9" } });
      expect((await raw.storedMeta(0, 10)).map((row) => row.tags[0]?.keyId)).toEqual([
        "old",
        "new",
      ]);

      // The search runs under every configured key id.
      const search = { channel: "adt", where: [["mrn", "SYN-9"]] as const, limit: 10 };
      expect((await rotated.findByMeta(search)).items.map((m) => m.id)).toEqual([late, early]);

      expect(isMetaStore(raw)).toBe(true);
      const counts = await rekey(raw, ring("new", "old"), { indexes: index });
      expect(counts.retagged).toBe(1);
      expect(counts.unreadable).toBe(0);
      const after = await raw.storedMeta(0, 10);
      expect(after.map((row) => row.tags[0]?.keyId)).toEqual(["new", "new"]);
      for (const row of after) {
        expect((await decryptTextWithKeyId(row.meta, ring("new"))).keyId).toBe("new");
      }
      // The old key can go: the search still finds both.
      const retired = new EncryptedStore(raw, ring("new"), index);
      expect((await retired.findByMeta(search)).items.map((m) => m.id)).toEqual([late, early]);
      // A second run has nothing left to do.
      expect((await rekey(raw, ring("new"), { indexes: index })).retagged).toBe(0);
    });

    it("counts metadata it cannot read, stored unencrypted, or changed meanwhile, as it does bodies", async () => {
      const raw = await openRaw(database);
      const ring = keyring("lost", "dev");
      const index = indexes("adt", { key: "mrn", bits: 12 });
      await new EncryptedStore(raw, ring("lost"), index).receive("adt", bytes("x"), {
        meta: { mrn: "SYN-1" },
      });
      await new UnencryptedStore(raw).receive("adt", bytes("y"), { meta: { mrn: "SYN-2" } });
      const keys = ring("dev");
      // The message under the lost key keeps its tags; the plain one gets its tags all the same.
      expect(await rekey(raw, keys, { indexes: index })).toMatchObject({
        unreadable: 2,
        unencrypted: 2,
        retagged: 1,
        changed: 0,
      });
      expect((await raw.storedMeta(0, 10)).map((row) => row.tags[0]?.keyId)).toEqual([
        "lost",
        "dev",
      ]);

      // A row changed between the read and the write is left for the next run.
      const stale = {
        storedMeta: (after: number, limit: number) => raw.storedMeta(after, limit),
        replaceMeta: () => Promise.resolve(false),
        storedContent: () => Promise.resolve([]),
        replaceContent: () => Promise.resolve(false),
      };
      expect(await rekey(stale, keys, { indexes: index, encryptPlaintext: true })).toMatchObject({
        unreadable: 1,
        changed: 1,
      });
      expect(await rekey(raw, keys, { indexes: index, encryptPlaintext: true })).toMatchObject({
        encrypted: 2,
        unreadable: 2,
        retagged: 0,
      });
      const [, plain] = await raw.storedMeta(0, 10);
      expect(isEncryptedText(plain?.meta ?? "")).toBe(true);
      // A key provider's own failure, such as a key service that cannot be reached, stops rekey.
      const down: KeyProvider = {
        currentKeyId: "dev",
        keyIds: ["dev"],
        wrapKey: (key) => keys.wrapKey(key),
        unwrapKey: () => Promise.reject(new Error("the key service did not answer")),
        deriveIndexKey: (id, info) => keys.deriveIndexKey(id, info),
      };
      await expect(rekey(raw, down, { indexes: index })).rejects.toThrow("did not answer");
      // The store replaces metadata only while it is still what was read.
      expect(
        await raw.replaceMeta({ ...(plain as StoredMeta), meta: "{}" }, { meta: "{}", tags: [] }),
      ).toBe(false);
    });

    it("derives tags in rekey for an index added after the messages were stored", async () => {
      const raw = await openRaw(database);
      const keys = keyring("dev")("dev");
      const unindexed = new EncryptedStore(raw, keys);
      const { id } = await unindexed.receive("adt", bytes("x"), { meta: { accession: "ACC-1" } });
      expect((await raw.storedMeta(0, 10))[0]?.tags).toEqual([]);
      const index = indexes("adt", { key: "accession", bits: 12 });
      const counts = await rekey(raw, keys, { indexes: index });
      // The metadata and the body, each already under the current key.
      expect(counts).toMatchObject({ retagged: 1, current: 2 });
      const store = new EncryptedStore(raw, keys, index);
      open.push(store);
      const found = await store.findByMeta({
        channel: "adt",
        where: [["accession", "ACC-1"]],
        limit: 5,
      });
      expect(found.items.map((m) => m.id)).toEqual([id]);
    });

    it("deletes a message's tags with it when retention deletes the message", async () => {
      let now = new Date("2026-11-01T00:00:00.000Z");
      const file = join(await makeProject({}), ".pathways/pathways.db");
      const raw =
        database.kind === "sqlite"
          ? await Store.open(file, { now: () => now })
          : await (async () => {
              const { storage, env } = await freshDatabase(database);
              return Store.open(storage, { env, now: () => now });
            })();
      const store = new EncryptedStore(
        raw,
        keyring("dev")("dev"),
        indexes("adt", { key: "mrn", bits: 12 }),
      );
      open.push(store);
      const { id } = await store.receive("adt", bytes("x"), { meta: { mrn: "SYN-1" } });
      await store.nextToTransform("adt");
      await store.completeTransform(id, [], 1);
      now = new Date("2026-11-09T00:00:00.000Z");
      expect(await store.expire("adt", "2026-11-05T00:00:00.000Z", false)).toEqual({
        messages: 1,
        deliveries: 0,
      });
      expect(await raw.storedMeta(0, 10)).toEqual([]);
      if (database.kind === "sqlite") {
        const db = new SqliteDatabase(file, { readonly: true });
        expect(db.prepare("select count(*) from meta_index").pluck().get()).toBe(0);
        db.close();
      }
    });
  });
}

describe("the index: block of channel.yaml", () => {
  const KEYS = "encryption:\n  keys: [{ id: dev, file: ./dev.key }]\n  current: dev\n";
  const CHANNEL =
    "source:\n  file: { dir: ../../in }\ndestinations:\n  - file: { dir: ../../out }\n";

  it("resolves each key with its bits, 12 by default", async () => {
    const root = await makeProject({
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": `${CHANNEL}index:\n  - mrn\n  - { key: accession, bits: 20 }\n  - { key: visit }\n`,
      "channels/lab/channel.yaml": CHANNEL,
    });
    const project = await loadProject(root);
    expect(project.channels[0]?.indexes).toEqual([
      { key: "mrn", bits: 12 },
      { key: "accession", bits: 20 },
      { key: "visit", bits: 12 },
    ]);
    // A channel without the block has no indexes field at all.
    expect(project.channels[1]).not.toHaveProperty("indexes");
    expect(project.warnings).toBeUndefined();
    expect([...projectIndexes(project).keys()]).toEqual(["adt"]);
  });

  it("warns about a key whose values are few or guessable, and still loads", async () => {
    const root = await makeProject({
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": `${CHANNEL}index: [mrn, sex, birth_date]\n`,
    });
    const project = await loadProject(root);
    expect(project.warnings).toEqual([
      expect.stringMatching(
        /^channels\/adt\/channel\.yaml: index\.1: sex has few or guessable values/,
      ),
      expect.stringMatching(
        /^channels\/adt\/channel\.yaml: index\.2: birth_date has few or guessable values/,
      ),
    ]);
  });

  it("refuses an index under encryption: none, a key indexed twice, and bits out of range", async () => {
    const none = await makeProject({
      "pathways.yaml": "encryption: none\n",
      "channels/adt/channel.yaml": `${CHANNEL}index: [mrn]\n`,
    });
    await expect(loadProject(none)).rejects.toMatchObject({
      problems: [
        "channels/adt/channel.yaml: index.0: an index needs encryption keys, and pathways.yaml sets encryption: none",
      ],
    });
    const twice = await makeProject({
      "pathways.yaml": KEYS,
      "channels/adt/channel.yaml": `${CHANNEL}index: [mrn, { key: mrn, bits: 16 }]\n`,
    });
    await expect(loadProject(twice)).rejects.toBeInstanceOf(ConfigError);
    for (const bits of [3, 33]) {
      const wide = await makeProject({
        "pathways.yaml": KEYS,
        "channels/adt/channel.yaml": `${CHANNEL}index: [{ key: mrn, bits: ${String(bits)} }]\n`,
      });
      await expect(loadProject(wide)).rejects.toBeInstanceOf(ConfigError);
    }
  });
});

/** A key provider over a stand-in key service, for tests only: it flips bits, which protects nothing. */
const KMS = `
const flip = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes, (byte) => byte ^ 0xff);
export default () => ({
  currentKeyId: "kms-1",
  async wrapKey(dataKey: Uint8Array) {
    return { keyId: "kms-1", wrapped: flip(dataKey) };
  },
  async unwrapKey(_keyId: string, wrapped: Uint8Array) {
    return flip(wrapped);
  },
});
`;

describe("pathways messages --where", () => {
  const PROJECT = "encryption:\n  keys: [{ id: dev, file: ./dev.key }]\n  current: dev\n";
  const CHANNEL =
    "source:\n  file: { dir: ../../in }\ndestinations:\n  - file: { dir: ../../out }\nindex: [mrn, sex]\n";

  async function cli(
    argv: readonly string[],
  ): Promise<{ code: number; out: string; err: string; audit: AuditEntry[]; events: LogEvent[] }> {
    let out = "";
    let err = "";
    const audit: AuditEntry[] = [];
    const { logger, events } = captureLogger();
    const code = await run(argv, {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      logger,
      onAudit: (entry) => {
        audit.push(entry);
      },
    });
    return { code, out, err, audit, events };
  }

  /** A project whose channel indexes mrn, with three messages stored through openStore. */
  async function stored(): Promise<{ root: string; ids: number[] }> {
    const root = await makeProject({
      "dev.key": `${generateKey()}\n`,
      "pathways.yaml": PROJECT,
      "channels/adt/channel.yaml": CHANNEL,
    });
    const project = await loadProject(root);
    const { logger } = captureLogger();
    const key = decodeKey(await readFile(join(root, "dev.key"), "utf8")) as Buffer;
    const keys = new LocalKeyProvider([["dev", key]], "dev");
    const store = await openStore(project, { env: {}, logger, keys });
    const ids: number[] = [];
    for (const mrn of ["SYN-000123", "SYN-000456", "SYN-000123"]) {
      ids.push((await store.receive("adt", bytes(ADT_A01), { meta: { mrn, sex: "U" } })).id);
    }
    await store.close();
    return { root, ids };
  }

  it("lists the messages whose metadata holds the value, and audits the key, never the value", async () => {
    const { root, ids } = await stored();
    const result = await cli([
      "messages",
      "--channel",
      "adt",
      "--where",
      "mrn=SYN-000123",
      "--json",
      "-C",
      root,
    ]);
    expect(result).toMatchObject({ code: EXIT.ok, err: "" });
    const printed = JSON.parse(result.out) as { messages: { id: number }[]; next: null };
    expect(printed.messages.map((message) => message.id)).toEqual([ids[2], ids[0]]);
    expect(result.out).not.toContain("SYN-");
    expect(result.audit).toMatchObject([
      { action: "search", channel: "adt", detail: { results: 2, where: "mrn" } },
    ]);
    expect(JSON.stringify(result.audit)).not.toContain("SYN-");

    const both = await cli([
      "messages",
      "--channel",
      "adt",
      "--where",
      "mrn=SYN-000456",
      "--where",
      "sex=U",
      "-C",
      root,
    ]);
    expect(both.code).toBe(EXIT.ok);
    expect(both.out).toMatch(
      new RegExp(`^ID +CHANNEL +STATE.*\\n${String(ids[1])} +adt +received`),
    );
    expect(both.audit[0]?.detail).toMatchObject({ results: 1, where: "mrn,sex" });
  });

  it("is a usage error without --channel, with a key the channel does not index, or with no pair", async () => {
    const { root } = await stored();
    const noChannel = await cli(["messages", "--where", "mrn=SYN-000123", "-C", root]);
    expect(noChannel).toMatchObject({
      code: EXIT.usage,
      err: 'pathways: --where needs --channel. Run "pathways --help" for usage.\n',
    });
    const unindexed = await cli([
      "messages",
      "--channel",
      "adt",
      "--where",
      "name=TESTPATIENT",
      "-C",
      root,
    ]);
    expect(unindexed).toMatchObject({
      code: EXIT.usage,
      err: "pathways: --where takes a key this channel indexes: mrn, sex.\n",
    });
    expect(unindexed.err).not.toContain("TESTPATIENT");
    const bare = await cli(["messages", "--channel", "adt", "--where", "mrn", "-C", root]);
    expect(bare.code).toBe(EXIT.usage);
    const show = await cli(["messages", "show", "1", "--where", "mrn=x", "-C", root]);
    expect(show.code).toBe(EXIT.usage);
  });

  it("derives every tag again in rekey after the key rotates, and still finds by it", async () => {
    const { root, ids } = await stored();
    await writeFile(join(root, "new.key"), `${generateKey()}\n`);
    await writeFile(
      join(root, "pathways.yaml"),
      "encryption:\n  keys: [{ id: new, file: ./new.key }, { id: dev, file: ./dev.key }]\n  current: new\n",
    );
    const rekeyed = await cli(["rekey", "-C", root]);
    expect(rekeyed.code).toBe(EXIT.ok);
    expect(rekeyed.out).toContain("re-encrypted under the current key: 6\n");
    expect(rekeyed.out).toContain("messages whose index tags were derived again: 3\n");
    await writeFile(
      join(root, "pathways.yaml"),
      "encryption:\n  keys: [{ id: new, file: ./new.key }]\n  current: new\n",
    );
    const found = await cli([
      "messages",
      "--channel",
      "adt",
      "--where",
      "mrn=SYN-000456",
      "--json",
      "-C",
      root,
    ]);
    expect(found.code).toBe(EXIT.ok);
    expect(
      (JSON.parse(found.out) as { messages: { id: number }[] }).messages.map((m) => m.id),
    ).toEqual([ids[1]]);
  });

  it("says when the channel is unknown or has no index, and when the store cannot search", async () => {
    const { root } = await stored();
    const unknown = await cli(["messages", "--channel", "lab", "--where", "mrn=x", "-C", root]);
    expect(unknown).toMatchObject({
      code: EXIT.usage,
      err: "pathways: no such channel. The channels are: adt\n",
    });
    await writeFile(
      join(root, "channels/adt/channel.yaml"),
      "source:\n  file: { dir: ../../in }\ndestinations:\n  - file: { dir: ../../out }\n",
    );
    const none = await cli(["messages", "--channel", "adt", "--where", "mrn=x", "-C", root]);
    expect(none).toMatchObject({
      code: EXIT.usage,
      err: "pathways: --where reads a channel's index: block, and this channel has none.\n",
    });

    // A store that cannot search by metadata: the raw store, and a wrapper with no index.
    const project = await loadProject(root);
    const withIndex = {
      ...project,
      channels: project.channels.map((channel) => ({
        ...channel,
        indexes: [{ key: "mrn", bits: 12 }],
      })),
    };
    const raw = await Store.open(project.databaseFile);
    open.push(raw);
    const broken = {
      ...raw,
      findByMeta: () => Promise.reject(new RangeError("the database went away")),
    } as unknown as Store;
    await expect(
      searchCommand(
        {
          project: withIndex,
          store: broken,
          audit: new AuditLog(raw),
          json: false,
          out: () => undefined,
          err: () => undefined,
          now: Date.now,
        },
        { channel: "adt", where: [["mrn", "x"]], limit: 5 },
      ),
    ).rejects.toThrow(RangeError);
    for (const store of [raw, new UnencryptedStore(raw)]) {
      let err = "";
      const code = await searchCommand(
        {
          project: withIndex,
          store,
          audit: new AuditLog(store),
          json: false,
          out: () => undefined,
          err: (text) => {
            err += text;
          },
          now: Date.now,
        },
        { channel: "adt", where: [["mrn", "x"]], limit: 5 },
      );
      expect(code).toBe(EXIT.failed);
      expect(err).toBe("pathways: this store cannot be searched by metadata.\n");
    }
  });

  it("refuses an index under a key provider that cannot derive index keys", async () => {
    const root = await makeProject({
      "pathways.yaml": "encryption:\n  provider:\n    module: ./kms.ts\n",
      "kms.ts": KMS,
      "channels/adt/channel.yaml": CHANNEL,
    });
    const problem =
      "pathways: the configuration is invalid:\n  channels/adt: index: the key provider cannot derive index keys (it has no deriveIndexKey); remove the index: block, or use a provider that has one\n";
    for (const argv of [["messages", "--channel", "adt", "--where", "mrn=x"], ["rekey"]]) {
      const result = await cli([...argv, "-C", root]);
      expect(result).toMatchObject({ code: EXIT.config, err: problem });
    }
  });

  it("names the listing's filters in the audit entry beside the keys", async () => {
    const { root } = await stored();
    const result = await cli([
      "messages",
      "--channel",
      "adt",
      "--where",
      "mrn=SYN-000123",
      "--status",
      "received",
      "--since",
      "2026-01-01",
      "--until",
      "2099-01-01",
      "--limit",
      "1",
      "-C",
      root,
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toMatch(/\nMore: add --before \d+ for the next page\.\n$/);
    expect(result.audit[0]?.detail).toEqual({
      results: 1,
      // The page was full at the first match, so it read no further.
      candidates: 1,
      where: "mrn",
      state: "received",
      since: "2026-01-01T00:00:00.000Z",
      until: "2099-01-01T00:00:00.000Z",
    });
  });

  it("logs the low-entropy warning when the engine starts", async () => {
    const { root } = await stored();
    const result = await cli(["start", "--once", "-C", root]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        event: "config-warning",
        warning: expect.stringMatching(/^channels\/adt\/channel\.yaml: index\.1: sex /) as unknown,
      }),
    );
  });

  it("warns about a low-entropy index in validate, and still passes it", async () => {
    const { root } = await stored();
    const result = await cli(["validate", "-C", root]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.err).toMatch(
      /^pathways: warning: channels\/adt\/channel\.yaml: index\.1: sex has few or guessable values/,
    );
  });
});
