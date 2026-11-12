import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AzureContainer } from "../src/connectors/azblob.js";
import {
  OBJECT_CLAIMED_DIR,
  ObjectDestination,
  ObjectSource,
  type ObjectStore,
} from "../src/connectors/object-store.js";
import { S3Bucket } from "../src/connectors/s3.js";
import {
  DeliveryRejected,
  type MessageSink,
  type ReceiveOptions,
} from "../src/connectors/types.js";

// The object store source and destination against local emulators: LocalStack's S3, where
// PATHWAYS_TEST_S3_ENDPOINT names it (with the AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY the SDK's
// default chain reads), and Azurite for Azure Blob Storage, where PATHWAYS_TEST_AZURITE holds its
// connection string. .github/workflows/object-stores.yml starts both and sets them. Elsewhere this
// is skipped, and test/object-store.test.ts runs the same source against a store in memory.
//
// Synthetic bodies only. Each test works under a prefix of its own in one bucket or container the
// suite makes.

const S3_ENDPOINT = process.env["PATHWAYS_TEST_S3_ENDPOINT"];
const AZURITE = process.env["PATHWAYS_TEST_AZURITE"];

/** The bucket or container the suite makes, one per run. */
const NAME = `pathways-test-${randomBytes(4).toString("hex")}`;

/** A store on one emulator, and how to make its bucket or container. */
interface Emulator {
  readonly name: string;
  readonly enabled: boolean;
  store(): ObjectStore;
  make(): Promise<void>;
}

const emulators: Emulator[] = [
  {
    name: "S3 on LocalStack",
    enabled: S3_ENDPOINT !== undefined,
    store: () =>
      new S3Bucket({
        bucket: NAME,
        region: "us-east-1",
        endpoint: S3_ENDPOINT,
        pathStyle: true,
        timeoutMs: 10_000,
      }),
    async make() {
      const sdk = await import("@aws-sdk/client-s3");
      const client = new sdk.S3Client({
        region: "us-east-1",
        endpoint: String(S3_ENDPOINT),
        forcePathStyle: true,
      });
      await client.send(new sdk.CreateBucketCommand({ Bucket: NAME }));
      client.destroy();
    },
  },
  {
    name: "Azure Blob on Azurite",
    enabled: AZURITE !== undefined,
    store: () =>
      new AzureContainer({
        account: "devstoreaccount1",
        container: NAME,
        connectionString: AZURITE,
      }),
    async make() {
      const { BlobServiceClient } = await import("@azure/storage-blob");
      await BlobServiceClient.fromConnectionString(String(AZURITE))
        .getContainerClient(NAME)
        .create();
    },
  },
];

const stores: ObjectStore[] = [];

/** A store on `emulator`, closed after the suite. */
function open(emulator: Emulator): ObjectStore {
  const store = emulator.store();
  stores.push(store);
  return store;
}

/** A sink that stores each message once by its idempotency key, as the engine's store does. */
function sinkOf() {
  const stored = new Map<string, string>();
  const calls: ReceiveOptions[] = [];
  const sink: MessageSink = {
    receive(body: Uint8Array, options: ReceiveOptions = {}) {
      calls.push(options);
      const key = String(options.idempotencyKey);
      if (!stored.has(key)) stored.set(key, new TextDecoder().decode(body));
      return Promise.resolve(stored.size);
    },
  };
  return { sink, stored, calls };
}

const bodies = (stored: Map<string, string>): string[] => [...stored.values()].sort();
const names = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `msg-${String(at).padStart(2, "0")}`);
const encode = (text: string) => new TextEncoder().encode(text);

let prefixes = 0;

/** A new prefix holding a synthetic object for each name, each holding its name. */
async function drop(store: ObjectStore, files: readonly string[]): Promise<string> {
  prefixes += 1;
  const prefix = `inbox-${String(prefixes)}`;
  for (const name of files) await store.put(`${prefix}/${name}.hl7`, encode(name));
  return prefix;
}

/** Every key under `prefix`. */
async function keys(store: ObjectStore, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let token: string | undefined;
  do {
    const page = await store.list(`${prefix}/`, undefined, token);
    found.push(...page.objects.map((object) => object.key.slice(prefix.length + 1)));
    token = page.next;
  } while (token !== undefined);
  return found.sort();
}

/** `store` with `method` failing once, on the first call `matches` picks. */
function stopping(
  store: ObjectStore,
  method: keyof ObjectStore,
  matches: (key: string) => boolean,
): { store: ObjectStore; failed: () => boolean } {
  let failed = false;
  const wrapped = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      const bound = (value as (...a: unknown[]) => unknown).bind(target);
      if (key !== method) return bound;
      return (...args: unknown[]) => {
        if (!failed && matches(String(args[0]))) {
          failed = true;
          return Promise.reject(Object.assign(new Error("stopped"), { code: "EIO" }));
        }
        return bound(...args);
      };
    },
  });
  return { store: wrapped, failed: () => failed };
}

describe.each(emulators.filter((emulator) => emulator.enabled))(
  "the object store source and destination on $name",
  { timeout: 60_000 },
  (emulator) => {
    beforeAll(async () => {
      await emulator.make();
    });

    afterAll(async () => {
      for (const store of stores.splice(0)) await store.close?.();
    });

    it("honours If-None-Match: a second create of one key is refused", async () => {
      const store = open(emulator);
      const key = `probe-${randomBytes(4).toString("hex")}`;
      expect(await store.create(key, encode("a"))).toBe(true);
      expect(await store.create(key, encode("b"))).toBe(false);
      await store.remove(key);
      expect(await store.head(key)).toBeUndefined();
    });

    it("claims, stores and deletes each object, and writes each output only where none is", async () => {
      const store = open(emulator);
      const prefix = await drop(store, names(3));
      const { sink, stored, calls } = sinkOf();
      await new ObjectSource({ store, prefix, channel: "adt", minAgeMs: 0 }).poll(sink);
      expect(bodies(stored)).toEqual(names(3));
      expect(calls.every((call) => call.resumed === false)).toBe(true);
      expect(await keys(store, prefix)).toEqual([]);
      const out = new ObjectDestination({ store, prefix: `out-${prefix}`, extension: "hl7" });
      await out.deliver({ messageId: 3, seq: 0, body: encode("out") });
      await out.deliver({ messageId: 3, seq: 0, body: encode("out") });
      await expect(
        out.deliver({ messageId: 3, seq: 0, body: encode("other") }),
      ).rejects.toBeInstanceOf(DeliveryRejected);
      const written = await store.head(`out-${prefix}/3-1.hl7`);
      expect(
        new TextDecoder().decode(await store.get(`out-${prefix}/3-1.hl7`, String(written?.etag))),
      ).toBe("out");
    });

    it("stores each object once with two engines polling one prefix", async () => {
      const store = open(emulator);
      const prefix = await drop(store, names(20));
      const { sink, stored, calls } = sinkOf();
      const engines = ["adt", "lab"].map(
        (channel) =>
          new ObjectSource({
            store: open(emulator),
            prefix,
            channel,
            minAgeMs: 0,
            maxPerPoll: 5,
          }),
      );
      for (let pass = 0; pass < 6; pass += 1) {
        await Promise.all(engines.map((engine) => engine.poll(sink)));
      }
      expect(bodies(stored)).toEqual(names(20));
      expect(calls).toHaveLength(20);
      expect(await keys(store, prefix)).toEqual([]);
    });

    it("leaves an object larger than maxSize where it is", async () => {
      const store = open(emulator);
      const prefix = await drop(store, ["msg-big-message"]);
      const faults: unknown[] = [];
      const { sink, stored } = sinkOf();
      await new ObjectSource({
        store,
        prefix,
        channel: "adt",
        minAgeMs: 0,
        maxSize: 4,
        onFileFault: (fault) => faults.push(fault),
      }).poll(sink);
      expect(stored.size).toBe(0);
      expect(faults).toEqual([{ reason: "too-large", moved: false }]);
      expect(await keys(store, prefix)).toEqual(["msg-big-message.hl7"]);
    });

    // A run stopped at each step of a claim: the next run stores what it left, each object once.
    const steps: [string, keyof ObjectStore, (prefix: string) => (key: string) => boolean][] = [
      [
        "the marker's write",
        "create",
        (p) => (key) => key === `${p}/${OBJECT_CLAIMED_DIR}/msg-01.hl7`,
      ],
      ["the read", "get", (p) => (key) => key === `${p}/msg-01.hl7`],
      ["the delete of the object", "remove", (p) => (key) => key === `${p}/msg-01.hl7`],
      [
        "the delete of the marker",
        "remove",
        (p) => (key) => key === `${p}/${OBJECT_CLAIMED_DIR}/msg-01.hl7`,
      ],
    ];

    it.each(steps)("stores each object once after a stop at %s", async (_, method, matches) => {
      const store = open(emulator);
      const prefix = await drop(store, names(3));
      const { sink, stored, calls } = sinkOf();
      const stopped = stopping(store, method, matches(prefix));
      await new ObjectSource({
        store: stopped.store,
        prefix,
        channel: "adt",
        minAgeMs: 0,
        onReadError: () => undefined,
      })
        .poll(sink)
        .catch(() => undefined);
      expect(stopped.failed()).toBe(true);
      const restarted = new ObjectSource({ store, prefix, channel: "adt", minAgeMs: 0 });
      await restarted.poll(sink);
      await restarted.poll(sink);
      expect(bodies(stored)).toEqual(names(3));
      expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(3);
      expect(await keys(store, prefix)).toEqual([]);
    });
  },
);

describe.skipIf(emulators.some((emulator) => emulator.enabled))(
  "the object store emulators",
  () => {
    it("are not set here: test/object-store.test.ts runs the source in memory", () => {
      expect(S3_ENDPOINT ?? AZURITE).toBeUndefined();
    });
  },
);
