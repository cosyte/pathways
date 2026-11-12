import { describe, expect, it } from "vitest";

import {
  NO_CONDITIONAL_WRITE,
  OBJECT_CLAIMED_DIR,
  ObjectDestination,
  objectFailure,
  ObjectSource,
  type ObjectSourceOptions,
} from "../src/connectors/object-store.js";
import {
  DeliveryRejected,
  type MessageSink,
  type ReceiveOptions,
} from "../src/connectors/types.js";
import { markCopiesBodies } from "../src/storage/ownership.js";
import { FakeObjectStore } from "./fake-object-store.js";

// The object store source and destination over a store held in memory (test/fake-object-store.ts),
// which keeps S3's and Azure Blob's rules: a new entity tag on each write, and conditional writes,
// reads and deletes checked against it. The same source runs against LocalStack and Azurite in
// test/object-store-server.test.ts.

/** A sink that stores each message once by its idempotency key, as the engine's store does. */
function store() {
  const stored = new Map<string, string>();
  const ids = new Map<string, number>();
  const calls: ReceiveOptions[] = [];
  const down: string[] = [];
  let up = 0;
  let fail: Error | undefined;
  const sink: MessageSink = {
    receive(body: Uint8Array, options: ReceiveOptions = {}) {
      calls.push(options);
      if (fail !== undefined) {
        const error = fail;
        fail = undefined;
        return Promise.reject(error);
      }
      const key = String(options.idempotencyKey);
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(key, id);
        stored.set(key, new TextDecoder().decode(body));
      }
      return Promise.resolve(id);
    },
    sourceDown(code) {
      down.push(code);
      return 5_000;
    },
    sourceUp() {
      up += 1;
    },
  };
  return {
    sink,
    stored,
    calls,
    down,
    get up() {
      return up;
    },
    failNext(error: Error) {
      fail = error;
    },
  };
}

const bodies = (stored: Map<string, string>): string[] => [...stored.values()].sort();

/** A source on `objects` under `inbox`, for the channel `adt`, taking objects of any age. */
function source(objects: FakeObjectStore, options: Partial<ObjectSourceOptions> = {}) {
  return new ObjectSource({
    store: objects,
    prefix: "inbox",
    channel: "adt",
    minAgeMs: 0,
    now: () => objects.now,
    ...options,
  });
}

const markerOf = (rel: string): string =>
  `inbox/${OBJECT_CLAIMED_DIR}/${rel.replaceAll("/", "%2F")}`;

describe("ObjectSource", () => {
  it("stores each object under the prefix, then deletes it and its marker", async () => {
    const objects = new FakeObjectStore();
    for (const name of ["a", "b", "c", "d", "e"]) objects.drop(`inbox/${name}.hl7`, `msg-${name}`);
    objects.drop("other/x.hl7", "not under the prefix");
    const { sink, stored, calls } = store();
    await source(objects).poll(sink);
    expect(bodies(stored)).toEqual(["msg-a", "msg-b", "msg-c", "msg-d", "msg-e"]);
    expect(objects.keys()).toEqual(["other/x.hl7"]);
    expect(calls[0]).toEqual({
      idempotencyKey: 'fake:bucket/inbox/a.hl7@"e1"@940000',
      resumed: false,
      source: { name: "a.hl7" },
    });
    // The claim is a conditional write of a marker, made before the read.
    const order = objects.calls.filter((call) => call.endsWith("a.hl7"));
    expect(order).toEqual([
      "head inbox/a.hl7",
      `create ${markerOf("a.hl7")}`,
      "get inbox/a.hl7",
      "remove inbox/a.hl7",
      `remove ${markerOf("a.hl7")}`,
    ]);
  });

  it("writes in its marker the channel and the version it claims", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    const seen: string[] = [];
    objects.trap("get", (key) => {
      if (key === "inbox/a.hl7") seen.push(String(objects.text(markerOf("a.hl7"))));
      return undefined;
    });
    await source(objects).poll(store().sink);
    expect(seen).toEqual(['{"channel":"adt","etag":"\\"e1\\"","modifiedMs":940000}']);
  });

  it("reads the whole bucket with an empty prefix, and claims under .claimed/ at its root", async () => {
    const objects = new FakeObjectStore();
    objects.drop("a.hl7", "msg-a");
    const { sink, stored } = store();
    await source(objects, { prefix: "" }).poll(sink);
    expect(bodies(stored)).toEqual(["msg-a"]);
    expect(objects.calls).toContain(`create ${OBJECT_CLAIMED_DIR}/a.hl7`);
    expect(objects.keys()).toEqual([]);
  });

  it("reads only the prefix's own level unless recursive, and never .claimed/ or a folder key", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.drop("inbox/sub/b.hl7", "msg-b");
    objects.drop("inbox/sub/", "");
    objects.drop(`inbox/${OBJECT_CLAIMED_DIR}/.probe/x`, "");
    const flat = store();
    await source(objects).poll(flat.sink);
    expect(bodies(flat.stored)).toEqual(["msg-a"]);
    const deep = store();
    await source(objects, { recursive: true, ignoreDot: false, minSize: 0 }).poll(deep.sink);
    expect(bodies(deep.stored)).toEqual(["msg-b"]);
    expect(deep.calls[0]?.source).toEqual({ name: "sub/b.hl7" });
    expect(objects.keys()).toEqual(["inbox/.claimed/.probe/x", "inbox/sub/"]);
  });

  it("leaves a path with a dot segment unless ignoreDot is false", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/.hidden", "msg-hidden");
    objects.drop("inbox/.dir/a.hl7", "msg-a");
    objects.drop("inbox/b.hl7", "msg-b");
    const first = store();
    await source(objects, { recursive: true }).poll(first.sink);
    expect(bodies(first.stored)).toEqual(["msg-b"]);
    const second = store();
    await source(objects, { recursive: true, ignoreDot: false }).poll(second.sink);
    expect(bodies(second.stored)).toEqual(["msg-a", "msg-hidden"]);
  });

  it("takes an object only once it is minAge old and minSize long", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/young.hl7", "msg-young", 500);
    objects.drop("inbox/old.hl7", "msg-old", 1_000);
    objects.drop("inbox/small.hl7", "x", 5_000);
    const { sink, stored } = store();
    await source(objects, { minAgeMs: 1_000, minSize: 2 }).poll(sink);
    expect(bodies(stored)).toEqual(["msg-old"]);
    expect(objects.keys()).toEqual(["inbox/small.hl7", "inbox/young.hl7"]);
  });

  it("claims at most maxPerPoll a pass, by name or least recently modified first", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a", 1_000);
    objects.drop("inbox/b.hl7", "msg-b", 3_000);
    objects.drop("inbox/c.hl7", "msg-c", 2_000);
    const byName = store();
    await source(objects, { maxPerPoll: 1 }).poll(byName.sink);
    expect(bodies(byName.stored)).toEqual(["msg-a"]);
    const byTime = store();
    await source(objects, { maxPerPoll: 1, sortBy: "mtime" }).poll(byTime.sink);
    expect(bodies(byTime.stored)).toEqual(["msg-b"]);
  });

  it("counts toward maxPerPoll only what it claims", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.drop("inbox/b.hl7", "msg-b");
    objects.objects.set(markerOf("a.hl7"), {
      body: new TextEncoder().encode('{"channel":"lab","etag":"x","modifiedMs":1}'),
      etag: '"m"',
      modifiedMs: 1,
    });
    const { sink, stored } = store();
    await source(objects, { maxPerPoll: 1 }).poll(sink);
    expect(bodies(stored)).toEqual(["msg-b"]);
  });

  it("with stable, takes an object once two passes find it the same", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    const { sink, stored } = store();
    const stable = source(objects, { stable: true });
    await stable.poll(sink);
    expect(stored.size).toBe(0);
    objects.drop("inbox/a.hl7", "msg-a2", 30_000);
    await stable.poll(sink);
    expect(stored.size).toBe(0);
    await stable.poll(sink);
    expect(bodies(stored)).toEqual(["msg-a2"]);
  });

  it("takes only what include lets in and exclude leaves", async () => {
    const objects = new FakeObjectStore();
    for (const name of ["a.hl7", "b.txt", "skip.hl7"]) objects.drop(`inbox/${name}`, name);
    const { sink, stored } = store();
    await source(objects, {
      include: [{ glob: "*.hl7" }],
      exclude: [{ regex: "^skip" }],
    }).poll(sink);
    expect(bodies(stored)).toEqual(["a.hl7"]);
  });

  it("leaves a path a pattern runs too long on, and says so", async () => {
    const objects = new FakeObjectStore();
    const slow = `${"a".repeat(40)}!`;
    objects.drop(`inbox/${slow}`, "msg-slow");
    objects.drop("inbox/aaa", "msg-fast");
    const errors: unknown[] = [];
    const { sink, stored } = store();
    await source(objects, {
      exclude: [{ regex: "^(a+)+$" }, { regex: "^(a|a)+$" }],
      onReadError: (error) => errors.push(error),
    }).poll(sink);
    expect(stored.size).toBe(0);
    expect(errors.map((error) => (error as { code?: unknown }).code)).toEqual([
      "ERR_SCRIPT_EXECUTION_TIMEOUT",
    ]);
    expect(objects.keys()).toEqual([`inbox/${slow}`, "inbox/aaa"].sort());
  });

  it("sets aside nothing larger than maxSize by the size a HEAD reads now, and says so", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "1234");
    objects.drop("inbox/b.hl7", "12");
    // The listing said 2 bytes; by the HEAD just before the claim it has grown.
    objects.trap("head", (key) => {
      if (key === "inbox/b.hl7") objects.drop("inbox/b.hl7", "123456");
      return undefined;
    });
    const faults: unknown[] = [];
    const { sink, stored } = store();
    await source(objects, { maxSize: 3, onFileFault: (fault) => faults.push(fault) }).poll(sink);
    expect(stored.size).toBe(0);
    expect(faults).toEqual([
      { reason: "too-large", moved: false },
      { reason: "too-large", moved: false },
    ]);
    expect(objects.keys()).toEqual(["inbox/a.hl7", "inbox/b.hl7"]);
  });

  it("takes an object exactly maxSize long", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "123");
    const { sink, stored } = store();
    await source(objects, { maxSize: 3 }).poll(sink);
    expect(bodies(stored)).toEqual(["123"]);
  });

  it("passes over an object gone between the listing and the HEAD", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.trap("head", (key) => {
      objects.objects.delete(key);
      return undefined;
    });
    const { sink, stored } = store();
    await source(objects).poll(sink);
    expect(stored.size).toBe(0);
    expect(objects.calls).not.toContain(`create ${markerOf("a.hl7")}`);
  });

  it("leaves an object another engine claimed first", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.objects.set(markerOf("a.hl7"), {
      body: new TextEncoder().encode('{"channel":"lab","etag":"\\"e1\\"","modifiedMs":940000}'),
      etag: '"m"',
      modifiedMs: 1,
    });
    const { sink, stored } = store();
    await source(objects).poll(sink);
    expect(stored.size).toBe(0);
    expect(objects.keys()).toEqual([markerOf("a.hl7"), "inbox/a.hl7"].sort());
  });

  it("stores each object once with two engines polling one prefix", async () => {
    const objects = new FakeObjectStore();
    const names = Array.from({ length: 20 }, (_, at) => `msg-${String(at).padStart(2, "0")}`);
    for (const name of names) objects.drop(`inbox/${name}.hl7`, name);
    const { sink, stored, calls } = store();
    const engines = ["adt", "lab"].map((channel) => source(objects, { channel, maxPerPoll: 5 }));
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.all(engines.map((engine) => engine.poll(sink)));
    }
    expect(bodies(stored)).toEqual(names);
    expect(calls).toHaveLength(20);
    expect(objects.keys()).toEqual([]);
  });

  it("finishes its own channel's marker: hands the object in again, then deletes both", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.objects.set(markerOf("a.hl7"), {
      body: new TextEncoder().encode('{"channel":"adt","etag":"\\"e1\\"","modifiedMs":940000}'),
      etag: '"m"',
      modifiedMs: 1,
    });
    const { sink, stored, calls } = store();
    await source(objects).poll(sink);
    expect(bodies(stored)).toEqual(["msg-a"]);
    expect(calls).toEqual([
      {
        idempotencyKey: 'fake:bucket/inbox/a.hl7@"e1"@940000',
        resumed: true,
        source: { name: "a.hl7" },
      },
    ]);
    expect(objects.keys()).toEqual([]);
  });

  it("finishes a marker of a path from a subfolder", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/sub/a.hl7", "msg-a");
    objects.objects.set(markerOf("sub/a.hl7"), {
      body: new TextEncoder().encode('{"channel":"adt","etag":"\\"e1\\"","modifiedMs":940000}'),
      etag: '"m"',
      modifiedMs: 1,
    });
    const { sink, calls } = store();
    await source(objects).poll(sink);
    expect(calls[0]?.source).toEqual({ name: "sub/a.hl7" });
    expect(objects.keys()).toEqual([]);
  });

  it("deletes its marker without storing when the object is gone or replaced, and takes a replacement", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/b.hl7", "msg-b-new");
    for (const name of ["a.hl7", "b.hl7"]) {
      objects.objects.set(markerOf(name), {
        body: new TextEncoder().encode('{"channel":"adt","etag":"\\"old\\"","modifiedMs":940000}'),
        etag: '"m"',
        modifiedMs: 1,
      });
    }
    const { sink, calls } = store();
    await source(objects).poll(sink);
    expect(calls).toEqual([
      {
        idempotencyKey: 'fake:bucket/inbox/b.hl7@"e1"@940000',
        resumed: false,
        source: { name: "b.hl7" },
      },
    ]);
    expect(objects.keys()).toEqual([]);
  });

  it("does not finish a marker of the same tag and another time", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.objects.set(markerOf("a.hl7"), {
      body: new TextEncoder().encode('{"channel":"adt","etag":"\\"e1\\"","modifiedMs":1}'),
      etag: '"m"',
      modifiedMs: 1,
    });
    const { sink, calls } = store();
    await source(objects).poll(sink);
    expect(calls.map((call) => call.resumed)).toEqual([false]);
  });

  it("leaves a marker that is not one it wrote, or another channel's", async () => {
    const objects = new FakeObjectStore();
    const odd = [
      "not json",
      "null",
      '{"channel":"adt"}',
      '{"channel":"adt","etag":"x"}',
      '{"channel":"adt","etag":1,"modifiedMs":1}',
      '{"channel":"lab","etag":"x","modifiedMs":1}',
    ];
    for (const [at, text] of odd.entries()) {
      objects.objects.set(markerOf(`m${String(at)}`), {
        body: new TextEncoder().encode(text),
        etag: '"m"',
        modifiedMs: 1,
      });
    }
    const { sink, calls } = store();
    await source(objects).poll(sink);
    expect(calls).toEqual([]);
    expect(objects.keys()).toHaveLength(odd.length);
  });

  it("says each marker it could not finish, and goes on with the next", async () => {
    const objects = new FakeObjectStore();
    for (const name of ["a.hl7", "b.hl7"]) {
      objects.drop(`inbox/${name}`, name);
      objects.objects.set(markerOf(name), {
        body: new TextEncoder().encode('{"channel":"adt","etag":"x","modifiedMs":1}'),
        etag: '"m"',
        modifiedMs: 1,
      });
    }
    let once = true;
    objects.trap("head", () => {
      if (!once) return undefined;
      once = false;
      return objectFailure("EIO", "failed");
    });
    const errors: unknown[] = [];
    await source(objects, { onReadError: (error) => errors.push(error) }).poll(store().sink);
    expect(errors).toHaveLength(1);
    expect(objects.keys()).toEqual([markerOf("a.hl7"), "inbox/a.hl7"].sort());
  });

  it("keeps its marker when the object cannot be read on a resume, and says so", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.objects.set(markerOf("a.hl7"), {
      body: new TextEncoder().encode('{"channel":"adt","etag":"\\"e1\\"","modifiedMs":940000}'),
      etag: '"m"',
      modifiedMs: 1,
    });
    objects.trap("get", (key) => (key === "inbox/a.hl7" ? objectFailure("EIO", "no") : undefined));
    const errors: unknown[] = [];
    const { sink, stored } = store();
    await source(objects, { onReadError: (error) => errors.push(error) }).poll(sink);
    expect(stored.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(objects.keys()).toEqual([markerOf("a.hl7"), "inbox/a.hl7"].sort());
    // With no one to tell, the same.
    await source(objects).poll(sink);
    expect(objects.keys()).toEqual([markerOf("a.hl7"), "inbox/a.hl7"].sort());
  });

  it("stores nothing when the object changes between the claim and the read, and drops the marker", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.trap("create", (key) => {
      if (key === markerOf("a.hl7")) objects.drop("inbox/a.hl7", "msg-a2");
      return undefined;
    });
    const errors: unknown[] = [];
    const { sink, stored } = store();
    await source(objects, { onReadError: (error) => errors.push(error) }).poll(sink);
    expect(stored.size).toBe(0);
    expect(errors).toEqual([]);
    expect(objects.keys()).toEqual(["inbox/a.hl7"]);
  });

  // A run stopped at each step of a claim: the next run stores what it left, each object once.
  // A failed delete ends the pass; a failed claim or read is said, and the pass goes on.
  const steps: [string, string, (key: string) => boolean, boolean][] = [
    ["the marker's write", "create", (key) => key === markerOf("msg-1.hl7"), false],
    ["the read", "get", (key) => key === "inbox/msg-1.hl7", false],
    ["the delete of the object", "remove", (key) => key === "inbox/msg-1.hl7", true],
    ["the delete of the marker", "remove", (key) => key === markerOf("msg-1.hl7"), true],
  ];

  it.each(steps)("stores each object once after a stop at %s", async (_, method, matches, ends) => {
    const objects = new FakeObjectStore();
    for (const name of ["msg-0", "msg-1", "msg-2"]) objects.drop(`inbox/${name}.hl7`, name);
    let failed = false;
    objects.trap(method, (key) => {
      if (failed || !matches(key)) return undefined;
      failed = true;
      return objectFailure("EIO", "stopped");
    });
    const { sink, stored } = store();
    const errors: unknown[] = [];
    const pass = source(objects, { onReadError: (error) => errors.push(error) }).poll(sink);
    if (ends) await expect(pass).rejects.toMatchObject({ code: "EIO" });
    else await pass;
    expect(failed).toBe(true);
    expect(errors).toHaveLength(ends ? 0 : 1);
    await source(objects).poll(sink);
    expect(bodies(stored)).toEqual(["msg-0", "msg-1", "msg-2"]);
    expect(objects.keys()).toEqual([]);
  });

  it("stores each object once after the store refused it, handing it in again as resumed", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    const kept = store();
    const { sink, stored, calls } = kept;
    kept.failNext(new Error("store down"));
    await expect(source(objects).poll(sink)).rejects.toThrow("store down");
    expect(objects.keys()).toEqual([markerOf("a.hl7"), "inbox/a.hl7"].sort());
    await source(objects).poll(sink);
    expect(bodies(stored)).toEqual(["msg-a"]);
    expect(calls.map((call) => call.resumed)).toEqual([false, true]);
    expect(objects.keys()).toEqual([]);
  });

  it("says the source is down while the store is, waits, and says it is up once a pass runs", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    let down = true;
    objects.trap("list", () =>
      down ? objectFailure("ERR_PATHWAYS_S3_UNREACHABLE", "down", true) : undefined,
    );
    const sink = store();
    const reader = source(objects);
    await reader.poll(sink.sink);
    expect(sink.down).toEqual(["ERR_PATHWAYS_S3_UNREACHABLE"]);
    down = false;
    objects.now += 4_999;
    await reader.poll(sink.sink);
    expect(sink.stored.size).toBe(0);
    expect(sink.up).toBe(0);
    objects.now += 1;
    await reader.poll(sink.sink);
    expect(bodies(sink.stored)).toEqual(["msg-a"]);
    expect(sink.up).toBe(1);
    await reader.poll(sink.sink);
    expect(sink.up).toBe(1);
  });

  it("waits a second when the sink gives no wait", async () => {
    const objects = new FakeObjectStore();
    let down = true;
    objects.trap("list", () => (down ? objectFailure("E_DOWN", "down", true) : undefined));
    let lists = 0;
    objects.trap("list", () => {
      lists += 1;
      return undefined;
    });
    const reader = source(objects);
    const sink: MessageSink = { receive: () => Promise.resolve(1) };
    await reader.poll(sink);
    down = false;
    const before = lists;
    objects.now += 999;
    await reader.poll(sink);
    expect(lists).toBe(before);
    objects.now += 1;
    await reader.poll(sink);
    expect(lists).toBeGreaterThan(before);
  });

  it("ends the pass when the store goes down mid-claim or mid-resume", async () => {
    for (const method of ["head", "get"]) {
      const objects = new FakeObjectStore();
      objects.drop("inbox/a.hl7", "msg-a");
      objects.objects.set(markerOf("b.hl7"), {
        body: new TextEncoder().encode('{"channel":"adt","etag":"x","modifiedMs":1}'),
        etag: '"m"',
        modifiedMs: 1,
      });
      objects.trap(method, () => objectFailure("E_DOWN", "down", true));
      const sink = store();
      await source(objects).poll(sink.sink);
      expect(sink.down).toEqual(["E_DOWN"]);
    }
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    objects.trap("create", (key) =>
      key.includes(".probe") ? undefined : objectFailure("E_DOWN", "down", true),
    );
    const sink = store();
    await source(objects).poll(sink.sink);
    expect(sink.down).toEqual(["E_DOWN"]);
    const reading = new FakeObjectStore();
    reading.drop("inbox/a.hl7", "msg-a");
    reading.trap("get", (key) =>
      key === "inbox/a.hl7" ? objectFailure("E_DOWN", "down", true) : undefined,
    );
    const readSink = store();
    await source(reading).poll(readSink.sink);
    expect(readSink.down).toEqual(["E_DOWN"]);
    expect(reading.keys()).toEqual([markerOf("a.hl7"), "inbox/a.hl7"].sort());
  });

  it("throws an error from the store that is not a down one out of the pass when it is not one object's", async () => {
    const objects = new FakeObjectStore();
    objects.trap("list", () => objectFailure("EINVAL", "bad"));
    await expect(source(objects).poll(store().sink)).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("checks once that the store honours If-None-Match, with a probe it deletes", async () => {
    const objects = new FakeObjectStore();
    const reader = source(objects);
    await reader.poll(store().sink);
    await reader.poll(store().sink);
    const probes = objects.calls.filter((call) => call.includes("/.claimed/.probe/"));
    expect(probes).toHaveLength(3);
    expect(probes[0]).toMatch(/^create inbox\/\.claimed\/\.probe\/[0-9a-f]{16}$/);
    expect(probes[2]).toBe(probes[0]?.replace("create", "remove"));
    expect(objects.keys()).toEqual([]);
  });

  it("refuses a store without conditional writes unless singleNode, and deletes its probe", async () => {
    const objects = new FakeObjectStore();
    objects.conditional = false;
    objects.drop("inbox/a.hl7", "msg-a");
    const reader = source(objects);
    await expect(reader.poll(store().sink)).rejects.toMatchObject({ code: NO_CONDITIONAL_WRITE });
    await expect(reader.poll(store().sink)).rejects.toMatchObject({ code: NO_CONDITIONAL_WRITE });
    expect(objects.keys()).toEqual(["inbox/a.hl7"]);
  });

  it("with singleNode on such a store, claims nothing and stores each object as resumed", async () => {
    const objects = new FakeObjectStore();
    objects.conditional = false;
    objects.drop("inbox/a.hl7", "msg-a");
    objects.objects.set(markerOf("b.hl7"), {
      body: new TextEncoder().encode('{"channel":"adt","etag":"x","modifiedMs":1}'),
      etag: '"m"',
      modifiedMs: 1,
    });
    const { sink, stored, calls } = store();
    await source(objects, { singleNode: true }).poll(sink);
    expect(bodies(stored)).toEqual(["msg-a"]);
    expect(calls[0]?.resumed).toBe(true);
    expect(objects.calls.filter((call) => call.startsWith("create"))).toHaveLength(2);
    expect(objects.keys()).toEqual([markerOf("b.hl7")]);
  });

  it("takes only a second create that succeeds, or a NOT_IMPLEMENTED code, as no conditional write", async () => {
    const failing = new FakeObjectStore();
    failing.trap("create", () => objectFailure("ERR_PATHWAYS_S3_NOT_IMPLEMENTED", "no"));
    await expect(source(failing).poll(store().sink)).rejects.toMatchObject({
      code: NO_CONDITIONAL_WRITE,
    });
    // A store that refuses even the first create kept the condition: it is not one without.
    const taken = new FakeObjectStore();
    taken.drop("inbox/a.hl7", "msg-a");
    taken.trap("create", (key) => {
      if (key.includes(".probe")) {
        taken.objects.set(key, { body: new Uint8Array(0), etag: '"p"', modifiedMs: 1 });
      }
      return undefined;
    });
    const { sink, stored } = store();
    await source(taken).poll(sink);
    expect(bodies(stored)).toEqual(["msg-a"]);
  });

  it("throws any other error the probe meets with its own code, and asks again on the next pass", async () => {
    for (const code of [
      "ERR_PATHWAYS_S3_NOT_INSTALLED",
      "ERR_PATHWAYS_AZBLOB_NOT_INSTALLED",
      "ERR_PATHWAYS_S3_NO_SUCH_BUCKET",
      "ERR_PATHWAYS_AZBLOB_NO_SUCH_CONTAINER",
      "ENOENT",
    ]) {
      for (const call of [1, 2]) {
        const objects = new FakeObjectStore();
        objects.drop("inbox/a.hl7", "msg-a");
        let creates = 0;
        let failing = true;
        objects.trap("create", () => {
          creates += 1;
          return failing && creates === call ? objectFailure(code, "no") : undefined;
        });
        const reader = source(objects);
        const { sink, stored } = store();
        await expect(reader.poll(sink)).rejects.toMatchObject({ code });
        expect(stored.size).toBe(0);
        failing = false;
        await reader.poll(sink);
        expect(bodies(stored)).toEqual(["msg-a"]);
      }
    }
    const bare = new Error("no code");
    const plain = new FakeObjectStore();
    plain.trap("create", () => bare);
    await expect(source(plain).poll(store().sink)).rejects.toBe(bare);
  });

  it("says a probe the store is down for as down, and still tries to delete it", async () => {
    const objects = new FakeObjectStore();
    objects.trap("create", () => objectFailure("E_DOWN", "down", true));
    objects.trap("remove", () => objectFailure("E_DOWN", "down", true));
    const sink = store();
    await source(objects).poll(sink.sink);
    expect(sink.down).toEqual(["E_DOWN"]);
    expect(objects.calls.filter((call) => call.startsWith("remove"))).toHaveLength(1);
  });

  it("frees each body once a sink that copies it has stored it", async () => {
    const objects = new FakeObjectStore();
    objects.drop("inbox/a.hl7", "msg-a");
    const held: Uint8Array[] = [];
    const sink = markCopiesBodies({
      receive(body: Uint8Array) {
        held.push(body);
        return Promise.resolve(1);
      },
    });
    await source(objects).poll(sink);
    expect(held[0]?.byteLength).toBe(0);
    const plain = new FakeObjectStore();
    plain.drop("inbox/a.hl7", "msg-a");
    const kept: Uint8Array[] = [];
    await source(plain).poll({
      receive(body: Uint8Array) {
        kept.push(body);
        return Promise.resolve(1);
      },
    });
    expect(kept[0]?.byteLength).toBe(5);
  });

  it("closes the store's client on stop, where it has one", async () => {
    const objects = new FakeObjectStore();
    await source(objects).stop();
    expect(objects.closed).toBe(1);
    const bare = new FakeObjectStore();
    const store = Object.assign(Object.create(bare) as FakeObjectStore, { close: undefined });
    await expect(source(store).stop()).resolves.toBeUndefined();
  });
});

describe("ObjectDestination", () => {
  const body = (text: string) => new TextEncoder().encode(text);

  it("writes each output only where no object is", async () => {
    const objects = new FakeObjectStore();
    const destination = new ObjectDestination({
      store: objects,
      prefix: "outbox",
      extension: "hl7",
    });
    await destination.deliver({ messageId: 7, seq: 0, body: body("out") });
    expect(objects.text("outbox/7-1.hl7")).toBe("out");
    expect(objects.calls).toEqual(["create outbox/7-1.hl7"]);
  });

  it("counts an object of the same bytes as an earlier attempt, and rejects one of others", async () => {
    const objects = new FakeObjectStore();
    const destination = new ObjectDestination({
      store: objects,
      prefix: "outbox",
      extension: "hl7",
    });
    await destination.deliver({ messageId: 7, seq: 1, body: body("out") });
    await destination.deliver({ messageId: 7, seq: 1, body: body("out") });
    const error = await destination
      .deliver({ messageId: 7, seq: 1, body: body("other") })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeliveryRejected);
    expect((error as DeliveryRejected).reason).toBe("OBJECT_EXISTS");
    expect(objects.text("outbox/7-2.hl7")).toBe("out");
    const shorter = await destination
      .deliver({ messageId: 7, seq: 1, body: body("ou") })
      .catch((caught: unknown) => caught);
    expect(shorter).toBeInstanceOf(DeliveryRejected);
  });

  it("rejects when the object it was refused for is gone by the time it looks", async () => {
    const objects = new FakeObjectStore();
    objects.drop("outbox/7-1.hl7", "out");
    objects.trap("head", (key) => {
      objects.objects.delete(key);
      return undefined;
    });
    const destination = new ObjectDestination({
      store: objects,
      prefix: "outbox",
      extension: "hl7",
    });
    await expect(
      destination.deliver({ messageId: 7, seq: 0, body: body("out") }),
    ).rejects.toBeInstanceOf(DeliveryRejected);
  });

  it("replaces an object in overwrite mode, and writes at the root with an empty prefix", async () => {
    const objects = new FakeObjectStore();
    objects.drop("7-1.x12", "old");
    const destination = new ObjectDestination({
      store: objects,
      prefix: "",
      extension: "x12",
      mode: "overwrite",
    });
    await destination.deliver({ messageId: 7, seq: 0, body: body("new") });
    expect(objects.text("7-1.x12")).toBe("new");
    expect(objects.calls).toEqual(["put 7-1.x12"]);
  });

  it("closes the store's client on stop", async () => {
    const objects = new FakeObjectStore();
    await new ObjectDestination({ store: objects, prefix: "o", extension: "hl7" }).stop();
    expect(objects.closed).toBe(1);
  });
});
