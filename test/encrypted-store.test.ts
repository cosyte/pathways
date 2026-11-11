import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ChannelConfig } from "../src/config/schema.js";
import { FileDestination, FileSource } from "../src/connectors/file.js";
import { DeliveryRejected, type DestinationConnector } from "../src/connectors/types.js";
import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import {
  decryptTextWithKeyId,
  decryptWithKeyId,
  encrypt,
  EncryptionError,
  isEncrypted,
  isEncryptedText,
} from "../src/encryption/envelope.js";
import { KEY_BYTES, LocalKeyProvider, type KeyProvider } from "../src/encryption/keys.js";
import { rekey, rekeyComplete, type RekeyCounts } from "../src/encryption/rekey.js";
import { Engine } from "../src/engine/engine.js";
import { Store, type ContentStore, type StoredContent } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  freshDatabase,
  TEST_DATABASES,
  type TestDatabase,
} from "./databases.js";
import { ADT_A01, ADT_A08, captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((closable) => closable.close()));
  await dropDatabases();
  await cleanUp();
});
afterAll(closeAdmins);

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");
const text = (body: Uint8Array): string => Buffer.from(body).toString("utf8");

/** Master keys by id, each 32 fresh bytes, and providers over any of them. */
function keyring(...ids: string[]): (current: string, ...others: string[]) => LocalKeyProvider {
  const raw = new Map(ids.map((id) => [id, randomBytes(KEY_BYTES)] as const));
  return (current, ...others) =>
    new LocalKeyProvider(
      [current, ...others].map((id) => [id, raw.get(id) as Buffer] as const),
      current,
    );
}

/** A fresh store on `database`: a SQLite file, or a new database on a server. */
async function openRaw(database: TestDatabase): Promise<{ store: Store }> {
  if (database.kind === "sqlite") {
    return { store: await Store.open(join(await makeProject({}), ".pathways/pathways.db")) };
  }
  const { storage, env } = await freshDatabase(database);
  return { store: await Store.open(storage, { env }) };
}

/** Every stored row's content, as the database holds it. */
async function everything(store: ContentStore): Promise<StoredContent[]> {
  return [
    ...(await store.storedContent("messages", 0, 1_000)),
    ...(await store.storedContent("deliveries", 0, 1_000)),
  ];
}

/** Every key id the stored values name. */
async function keyIds(store: ContentStore, keys: KeyProvider): Promise<string[]> {
  const ids: string[] = [];
  for (const row of await everything(store)) {
    ids.push((await decryptWithKeyId(row.body, keys)).keyId);
    if (row.error !== null) ids.push((await decryptTextWithKeyId(row.error, keys)).keyId);
  }
  return ids;
}

/**
 * Fills a store through `store`: a message transformed into two outputs for two destinations, one
 * delivered, one retried, one rejected; a message whose transform failed; a message stored failed.
 */
async function fill(store: EncryptedStore | UnencryptedStore): Promise<void> {
  const { id } = await store.receive("adt", bytes(ADT_A01));
  await store.nextToTransform("adt");
  await store.completeTransform(id, [bytes(`${ADT_A01}one`), bytes(`${ADT_A01}two`)], 2);
  const first = await store.nextDelivery("adt", 0);
  await store.markDelivered(first?.id ?? -1);
  const second = await store.nextDelivery("adt", 0);
  await store.scheduleRetry(second?.id ?? -1, 1, 5_000, `delivery: ECONNREFUSED ${ADT_A01}`);
  const other = await store.nextDelivery("adt", 1);
  await store.failDelivery(other?.id ?? -1, `rejected: AE ${ADT_A01}`);
  const { id: failing } = await store.receive("adt", bytes(ADT_A08));
  await store.failTransform(failing, `transform: TypeError: cannot route ${ADT_A08}`);
  await store.receive("adt", bytes("not hl7"), { failure: "inbound: NO_MSH" });
}

// The store-level suites run on every database: SQLite always, each server whose URL is set.
for (const database of TEST_DATABASES) {
  describe.skipIf(!available(database))(`on ${database.label}`, () => {
    const rawStore = (): Promise<{ store: Store }> => openRaw(database);

    describe("EncryptedStore", () => {
      it("hands the engine back what it stored, and keeps only ciphertext underneath", async () => {
        const { store: raw } = await rawStore();
        const keys = keyring("dev")("dev");
        const store = new EncryptedStore(raw, keys);
        open.push(store);

        const { id } = await store.receive("adt", bytes(ADT_A01), { duplicateKey: "k1" });
        const repeat = await store.receive("adt", bytes(ADT_A01), { duplicateKey: "k1" });
        expect(repeat.duplicateOf).toBe(id);
        const next = await store.nextToTransform("adt");
        expect(next?.id).toBe(id);
        expect(text(next?.body ?? new Uint8Array())).toBe(ADT_A01);
        await store.completeTransform(id, [bytes("out-1"), bytes("out-2")], 2);
        for (const destination of [0, 1]) {
          const delivery = await store.nextDelivery("adt", destination);
          expect(delivery).toMatchObject({ messageId: id, seq: 0, attempts: 0, nextAttemptAt: 0 });
          expect(text(delivery?.body ?? new Uint8Array())).toBe("out-1");
        }
        // Asked for one due by a time, it passes the question on: a retry waiting is passed over.
        const waiting = await store.nextDelivery("adt", 0);
        await store.scheduleRetry(waiting?.id ?? -1, 1, 5_000, "delivery: ECONNRESET");
        const due = await store.nextDelivery("adt", 0, { dueBy: 4_999 });
        expect(due).toMatchObject({ messageId: id, seq: 1, attempts: 0 });
        expect(text(due?.body ?? new Uint8Array())).toBe("out-2");
        await store.scheduleRetry(waiting?.id ?? -1, 0, 0, "delivery: ECONNRESET");
        expect(await store.messageCounts("adt")).toMatchObject({ received: 1, transformed: 1 });
        expect(await store.deliveryCounts("adt")).toEqual({
          pending: 4,
          delivered: 0,
          failed: 0,
          cleared: 0,
        });
        expect(await store.retryingDeliveries("adt")).toBe(0);

        // Two copies of one body are two different ciphertexts.
        const [first, second] = await raw.storedContent("messages", 0, 10);
        expect(first && second && Buffer.from(first.body).equals(Buffer.from(second.body))).toBe(
          false,
        );
        for (const row of await everything(raw)) {
          expect(isEncrypted(row.body)).toBe(true);
          expect(Buffer.from(row.body).toString("latin1")).not.toContain("TESTPATIENT");
        }
      });

      it("encrypts every error text, each of which can quote a message", async () => {
        const { store: raw } = await rawStore();
        const keys = keyring("dev")("dev");
        const store = new EncryptedStore(raw, keys);
        open.push(store);
        await fill(store);

        const errors = (await everything(raw)).flatMap((row) =>
          row.error === null ? [] : [row.error],
        );
        expect(errors).toHaveLength(4);
        const plain: string[] = [];
        for (const error of errors) {
          expect(isEncryptedText(error)).toBe(true);
          expect(error).not.toContain("TESTPATIENT");
          plain.push((await decryptTextWithKeyId(error, keys)).text);
        }
        expect(plain.sort()).toEqual(
          [
            `transform: TypeError: cannot route ${ADT_A08}`,
            "inbound: NO_MSH",
            `delivery: ECONNREFUSED ${ADT_A01}`,
            `rejected: AE ${ADT_A01}`,
          ].sort(),
        );
        expect(await store.retryingDeliveries("adt")).toBe(1);
        expect(await store.deliveryCounts("adt")).toEqual({
          pending: 2,
          delivered: 1,
          failed: 1,
          cleared: 0,
        });
      });

      it("refuses a body that was changed underneath, with a typed error and never the bytes", async () => {
        const { store: raw } = await rawStore();
        const keys = keyring("dev")("dev");
        const store = new EncryptedStore(raw, keys);
        open.push(store);
        await store.receive("adt", bytes(ADT_A01));
        const [row] = await raw.storedContent("messages", 0, 1);
        const tampered = Buffer.from(row?.body ?? []);
        tampered[tampered.length - 5] = (tampered[tampered.length - 5] as number) ^ 0x01;
        expect(
          await raw.replaceContent(row as StoredContent, { body: tampered, error: null }),
        ).toBe(true);
        await expect(store.nextToTransform("adt")).rejects.toMatchObject({
          name: "EncryptionError",
          code: "ERR_PATHWAYS_INTEGRITY",
          keyId: "dev",
        });
      });

      it("reads values under an older key after rotation, and writes new ones under the current key", async () => {
        const { store: raw } = await rawStore();
        const ring = keyring("old", "new");
        const before = new EncryptedStore(raw, ring("old"));
        const { id } = await before.receive("adt", bytes(ADT_A01));

        const rotated = ring("new", "old");
        const after = new EncryptedStore(raw, rotated);
        open.push(after);
        expect(text((await after.nextToTransform("adt"))?.body ?? new Uint8Array())).toBe(ADT_A01);
        await after.completeTransform(id, [bytes("out")], 1);
        expect(await keyIds(raw, rotated)).toEqual(["old", "new"]);

        // With the old key gone, what it wrapped can no longer be read.
        const { id: next } = await before.receive("adt", bytes(ADT_A08));
        const withoutOld = new EncryptedStore(raw, ring("new"));
        expect(text((await withoutOld.nextDelivery("adt", 0))?.body ?? new Uint8Array())).toBe(
          "out",
        );
        await expect(withoutOld.nextToTransform("adt")).rejects.toMatchObject({
          code: "ERR_PATHWAYS_UNKNOWN_KEY",
          keyId: "old",
        });
        expect(next).toBeGreaterThan(id);
      });
    });

    describe("UnencryptedStore", () => {
      it("keeps values as they are for encryption: none", async () => {
        const { store: raw } = await rawStore();
        const store = new UnencryptedStore(raw);
        open.push(store);
        await fill(store);
        const rows = await everything(raw);
        expect(rows.some((row) => text(row.body).includes("TESTPATIENT"))).toBe(true);
        expect(rows.some((row) => row.error === "inbound: NO_MSH")).toBe(true);
        expect(await store.retryingDeliveries("adt")).toBe(1);
      });

      it("refuses a body that was stored encrypted rather than hand on ciphertext", async () => {
        const { store: raw } = await rawStore();
        const keys = keyring("dev")("dev");
        const { id } = await new EncryptedStore(raw, keys).receive("adt", bytes(ADT_A01));
        const store = new UnencryptedStore(raw);
        open.push(store);
        await expect(store.nextToTransform("adt")).rejects.toMatchObject({
          name: "EncryptionError",
          code: "ERR_PATHWAYS_ENCRYPTED",
        });
        await raw.completeTransform(id, [await encrypt(bytes("out"), keys)], 1);
        await expect(store.nextDelivery("adt", 0)).rejects.toBeInstanceOf(EncryptionError);
      });
    });

    describe("Store content for rekey", () => {
      it("lists rows of each table in id order, a page at a time, as stored", async () => {
        const { store } = await rawStore();
        open.push(store);
        for (const body of ["a", "b", "c"]) await store.receive("adt", bytes(body));
        await store.failTransform(2, "transform: Error");
        await store.completeTransform(1, [bytes("x"), bytes("y")], 1);
        const page = await store.storedContent("messages", 1, 1);
        expect(page.map((row) => [row.table, row.id, text(row.body), row.error])).toEqual([
          ["messages", 2, "b", "transform: Error"],
        ]);
        const deliveries = await store.storedContent("deliveries", 0, 10);
        expect(deliveries.map((row) => [row.table, row.id, text(row.body), row.error])).toEqual([
          ["deliveries", 1, "x", null],
          ["deliveries", 2, "y", null],
        ]);
      });

      it("replaces a row only while it still holds what was read", async () => {
        const { store } = await rawStore();
        open.push(store);
        await store.receive("adt", bytes("in"));
        await store.completeTransform(1, [bytes("out")], 1);
        const [delivery] = await store.storedContent("deliveries", 0, 1);
        const read = delivery as StoredContent;
        // The engine records a retry after the row was read: replacing it now would lose that error.
        await store.scheduleRetry(read.id, 1, 5_000, "delivery: ETIMEDOUT");
        expect(await store.replaceContent(read, { body: bytes("new"), error: null })).toBe(false);
        const [now] = await store.storedContent("deliveries", 0, 1);
        expect(now?.error).toBe("delivery: ETIMEDOUT");
        expect(
          await store.replaceContent(now as StoredContent, { body: bytes("new"), error: "e2" }),
        ).toBe(true);

        const [message] = await store.storedContent("messages", 0, 1);
        expect(
          await store.replaceContent(message as StoredContent, { body: bytes("m"), error: "e" }),
        ).toBe(true);
        expect(
          await store.replaceContent(message as StoredContent, { body: bytes("m2"), error: null }),
        ).toBe(false);
        const [replaced] = await store.storedContent("messages", 0, 1);
        expect([text(replaced?.body ?? new Uint8Array()), replaced?.error]).toEqual(["m", "e"]);
      });
    });

    describe("rekey", () => {
      const none: RekeyCounts = {
        reencrypted: 0,
        current: 0,
        encrypted: 0,
        unencrypted: 0,
        unreadable: 0,
        changed: 0,
        retagged: 0,
      };

      it("re-encrypts every value under the current key, so the old key can be retired", async () => {
        const { store: raw } = await rawStore();
        open.push(raw);
        const ring = keyring("old", "new");
        await fill(new EncryptedStore(raw, ring("old")));
        // 3 messages and 4 deliveries hold 7 bodies and 4 error texts.
        const rotated = ring("new", "old");
        const counts = await rekey(raw, rotated, { pageSize: 2 });
        expect(counts).toEqual({ ...none, reencrypted: 11 });
        expect(rekeyComplete(counts)).toBe(true);
        expect(new Set(await keyIds(raw, rotated))).toEqual(new Set(["new"]));

        expect(await rekey(raw, rotated)).toEqual({ ...none, current: 11 });
        const retired = new EncryptedStore(raw, ring("new"));
        expect(text((await retired.nextDelivery("adt", 0))?.body ?? new Uint8Array())).toBe(
          `${ADT_A01}two`,
        );
        const errors = (await everything(raw)).flatMap((row) =>
          row.error === null ? [] : [row.error],
        );
        for (const error of errors) {
          await expect(decryptTextWithKeyId(error, ring("new"))).resolves.toMatchObject({
            keyId: "new",
          });
        }
      });

      it("counts values it cannot decrypt and leaves them, so no key is retired too early", async () => {
        const { store: raw } = await rawStore();
        open.push(raw);
        const ring = keyring("lost", "old", "new");
        await new EncryptedStore(raw, ring("lost")).receive("adt", bytes(ADT_A01));
        await new EncryptedStore(raw, ring("old")).receive("adt", bytes(ADT_A08));
        const [, row] = await raw.storedContent("messages", 0, 10);
        const tampered = Buffer.from(row?.body ?? []);
        tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x01;
        await raw.replaceContent(row as StoredContent, { body: tampered, error: null });
        await new EncryptedStore(raw, ring("old")).receive("adt", bytes("third"), {
          failure: "inbound: NO_MSH",
        });

        const before = await everything(raw);
        const counts = await rekey(raw, ring("new", "old"));
        expect(counts).toEqual({ ...none, reencrypted: 2, unreadable: 2 });
        expect(rekeyComplete(counts)).toBe(false);
        const after = await everything(raw);
        expect(after[0]).toEqual(before[0]);
        expect(after[1]).toEqual(before[1]);
      });

      it("leaves values stored while encryption was none, unless told to encrypt them", async () => {
        const { store: raw } = await rawStore();
        open.push(raw);
        await fill(new UnencryptedStore(raw));
        const keys = keyring("dev")("dev");

        const left = await rekey(raw, keys);
        expect(left).toEqual({ ...none, unencrypted: 11 });
        expect(rekeyComplete(left)).toBe(false);

        expect(await rekey(raw, keys, { encryptPlaintext: true })).toEqual({
          ...none,
          encrypted: 11,
        });
        for (const row of await everything(raw)) {
          expect(Buffer.from(row.body).toString("latin1")).not.toContain("TESTPATIENT");
        }
        const store = new EncryptedStore(raw, keys);
        expect(text((await store.nextDelivery("adt", 0))?.body ?? new Uint8Array())).toBe(
          `${ADT_A01}two`,
        );
      });

      it("leaves a row the engine changed meanwhile for the next run", async () => {
        const { store: raw } = await rawStore();
        open.push(raw);
        const ring = keyring("old", "new");
        await new EncryptedStore(raw, ring("old")).receive("adt", bytes(ADT_A01), {
          failure: "inbound: NO_MSH",
        });
        const busy: ContentStore = {
          storedContent: (table, after, limit) => raw.storedContent(table, after, limit),
          replaceContent: () => Promise.resolve(false),
        };
        const counts = await rekey(busy, ring("new", "old"));
        expect(counts).toEqual({ ...none, changed: 2 });
        expect(rekeyComplete(counts)).toBe(false);
      });

      it("passes on a key provider's own failure, such as a key service that cannot be reached", async () => {
        const { store: raw } = await rawStore();
        open.push(raw);
        const keys = keyring("dev")("dev");
        await new EncryptedStore(raw, keys).receive("adt", bytes("x"), { failure: "inbound: X" });
        const unreachable: KeyProvider = {
          currentKeyId: "dev",
          wrapKey: (dataKey) => keys.wrapKey(dataKey),
          unwrapKey: () => Promise.reject(Object.assign(new Error("down"), { code: "ECONNRESET" })),
        };
        await expect(rekey(raw, unreachable)).rejects.toMatchObject({ code: "ECONNRESET" });
        const [row] = await raw.storedContent("messages", 0, 1);
        const errorOnly: ContentStore = {
          storedContent: (table, after) =>
            Promise.resolve(
              table === "messages" && after === 0
                ? [{ ...(row as StoredContent), body: Buffer.from("plain") }]
                : [],
            ),
          replaceContent: () => Promise.resolve(true),
        };
        await expect(
          rekey(errorOnly, unreachable, { encryptPlaintext: true }),
        ).rejects.toMatchObject({
          code: "ECONNRESET",
        });
      });
    });
  });
}

describe("the engine with encryption on", () => {
  const CHANNEL = `
format: text
source:
  file: { dir: ../../data/inbox, minAge: 0 }
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/out }
  - file: { dir: ../../data/unused }
`;
  /** Routes A01s, and throws on anything else with an error that quotes the whole message. */
  const QUOTING_TRANSFORM = `
export default (msg: string): string => {
  if (!msg.includes("ADT^A01")) throw new Error("cannot route " + msg);
  return msg.replace("|LAB|", "|LAB2|");
};
`;

  /** A destination that rejects every delivery for good. */
  class Rejecter implements DestinationConnector {
    deliver(): Promise<void> {
      return Promise.reject(new DeliveryRejected("AE"));
    }
  }

  async function run(encrypted: boolean): Promise<{ root: string; raw: string }> {
    const root = await makeProject({
      "channels/adt/channel.yaml": CHANNEL,
      "channels/adt/transform.ts": QUOTING_TRANSFORM,
    });
    const project = await loadProject(root);
    const store = await Store.open(project.databaseFile);
    const keys = keyring("dev")("dev");
    const wrapped = encrypted ? new EncryptedStore(store, keys) : new UnencryptedStore(store);
    const { logger, lines } = captureLogger();
    const engine = new Engine({
      project,
      store: wrapped,
      logger,
      connectors: (channel: ChannelConfig) => ({
        source: new FileSource({
          dir: join(root, "data/inbox"),
          channel: channel.name,
          minAgeMs: 0,
          now: Date.now,
        }),
        destinations: [
          new FileDestination({ dir: join(root, "data/out"), extension: "hl7" }),
          new Rejecter(),
        ].slice(0, channel.destinations.length),
      }),
    });
    await engine.start();
    await dropFile(join(root, "data/inbox/1.hl7"), ADT_A01);
    await dropFile(join(root, "data/inbox/2.hl7"), ADT_A08);
    try {
      await engine.tick();
    } finally {
      await engine.stop();
    }
    expect(await wrapped.messageCounts("adt")).toEqual({
      received: 0,
      transformed: 1,
      filtered: 0,
      failed: 1,
      cleared: 0,
    });
    expect(await wrapped.deliveryCounts("adt")).toEqual({
      pending: 0,
      delivered: 1,
      failed: 1,
      cleared: 0,
    });
    expect(lines.join("")).not.toContain("TESTPATIENT");
    await store.close();

    // The database and anything beside it (its write-ahead log), byte for byte.
    let raw = "";
    for (const file of await readdir(join(root, ".pathways"))) {
      raw += (await readFile(join(root, ".pathways", file))).toString("latin1");
    }
    return { root, raw };
  }

  it("delivers as before, and the database file holds no plaintext of the messages", async () => {
    const { root, raw } = await run(true);
    expect(await readFile(join(root, "data/out/1-1.hl7"), "utf8")).toBe(
      ADT_A01.replace("|LAB|", "|LAB2|"),
    );
    expect(raw.length).toBeGreaterThan(0);
    for (const plain of [
      "TESTPATIENT",
      "TEST000001",
      "MSG00001",
      "MSG00002",
      "ADT^A0",
      "MSH|",
      "cannot route",
      "WARD1",
    ]) {
      expect(raw).not.toContain(plain);
    }
  });

  it("is what keeps them out: with encryption none the same run leaves them in the file", async () => {
    const { raw } = await run(false);
    for (const plain of ["TESTPATIENT", "MSG00002", "cannot route"]) {
      expect(raw).toContain(plain);
    }
  });
});
