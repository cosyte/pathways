// Who holds a body's memory: what may be freed or moved, and what never is.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import { FileSource } from "../src/connectors/file.js";
import type { MessageSink } from "../src/connectors/types.js";
import { EncryptedStore, UnencryptedStore } from "../src/encryption/encrypted-store.js";
import { KEY_BYTES, LocalKeyProvider } from "../src/encryption/keys.js";
import { Engine } from "../src/engine/engine.js";
import { transferable } from "../src/engine/worker-entry.js";
import { copiesBodies, markCopiesBodies, ownsBuffer, release } from "../src/storage/ownership.js";
import { Store } from "../src/storage/store.js";
import { captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";
import { MemoryStore } from "./memory-store.js";

afterEach(cleanUp);

describe("ownsBuffer and release", () => {
  it("frees a view over the whole of its own buffer", () => {
    const bytes = new Uint8Array(16).fill(7);
    expect(ownsBuffer(bytes)).toBe(true);
    release(bytes);
    expect(bytes.byteLength).toBe(0);
    expect(ownsBuffer(bytes)).toBe(false);
    release(bytes);
  });

  it("never touches a slice, a pooled Buffer, shared memory or an empty buffer", () => {
    const whole = new Uint8Array(16).fill(1);
    const slice = whole.subarray(4);
    const pooled = Buffer.from("ab");
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    const empty = new Uint8Array(0);
    for (const bytes of [slice, pooled, shared, empty]) {
      const length = bytes.byteLength;
      expect(ownsBuffer(bytes)).toBe(false);
      release(bytes);
      expect(bytes.byteLength).toBe(length);
    }
    expect(Buffer.from(slice).toString("hex")).toBe("01".repeat(12));
    expect(pooled.toString()).toBe("ab");
  });

  it("marks what keeps no body", () => {
    const target = {};
    expect(copiesBodies(target)).toBe(false);
    expect(markCopiesBodies(target)).toBe(target);
    expect(copiesBodies(target)).toBe(true);
  });
});

describe("which stores copy bodies", () => {
  it("the SQL store, any store under encryption, and no other", async () => {
    const root = await makeProject({});
    const sql = await Store.open(join(root, "pathways.db"));
    try {
      const keys = new LocalKeyProvider([["k", new Uint8Array(KEY_BYTES).fill(3)]], "k");
      const memory = new MemoryStore();
      expect(copiesBodies(sql)).toBe(true);
      expect(copiesBodies(memory)).toBe(false);
      expect(copiesBodies(new UnencryptedStore(sql))).toBe(true);
      expect(copiesBodies(new UnencryptedStore(memory))).toBe(false);
      expect(copiesBodies(new EncryptedStore(sql, keys))).toBe(true);
      expect(copiesBodies(new EncryptedStore(memory, keys))).toBe(true);
    } finally {
      await sql.close();
    }
  });

  it("an encrypted store frees only its own copies, never a body a store underneath keeps", async () => {
    const keys = new LocalKeyProvider([["k", new Uint8Array(KEY_BYTES).fill(3)]], "k");
    const memory = new MemoryStore();
    const store = new EncryptedStore(memory, keys);
    const body = new Uint8Array(Buffer.from("synthetic body"));
    const { id } = await store.receive("own", body);
    expect(Buffer.from(body).toString()).toBe("synthetic body");
    const next = await store.nextToTransform("own");
    expect(next?.id).toBe(id);
    expect(Buffer.from(next?.body ?? []).toString()).toBe("synthetic body");
    // What the memory store keeps is still whole, and reads back again.
    expect(Buffer.from((await store.messageBody(id)) ?? []).toString()).toBe("synthetic body");
  });
});

describe("the worker's replies", () => {
  it("move each output's buffer once, and only a buffer it owns whole", () => {
    const one = new TextEncoder().encode("one");
    const two = new TextEncoder().encode("two");
    const pooled = Buffer.from("three");
    const part = new Uint8Array(8).subarray(2);
    expect(transferable([one, two, one, pooled, part])).toEqual([one.buffer, two.buffer]);
    expect(transferable([])).toEqual([]);
  });
});

describe("a file source", () => {
  it("hands an empty file over as an empty body of its own", async () => {
    const root = await makeProject({});
    const dir = join(root, "in");
    await dropFile(join(dir, "empty.txt"), "");
    const bodies: Uint8Array[] = [];
    const sink: MessageSink = {
      receive: (body) => {
        bodies.push(body);
        return Promise.resolve(bodies.length);
      },
    };
    await new FileSource({ dir, channel: "own", minAgeMs: 0 }).poll(sink);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBeInstanceOf(Uint8Array);
    expect(bodies[0]?.byteLength).toBe(0);
  });

  it("frees a body once a sink that copies it has stored it, and keeps it for any other", async () => {
    const root = await makeProject({});
    const dir = join(root, "in");
    await dropFile(join(dir, "a.txt"), "synthetic a");
    const kept: Uint8Array[] = [];
    const keeping: MessageSink = {
      receive: (body) => {
        kept.push(body);
        return Promise.resolve(1);
      },
    };
    await new FileSource({ dir, channel: "own", minAgeMs: 0 }).poll(keeping);
    expect(Buffer.from(kept[0] ?? []).toString()).toBe("synthetic a");

    await dropFile(join(dir, "b.txt"), "synthetic b");
    const copied: string[] = [];
    const seen: Uint8Array[] = [];
    const copying = markCopiesBodies<MessageSink>({
      receive: (body) => {
        copied.push(Buffer.from(body).toString());
        seen.push(body);
        return Promise.resolve(2);
      },
    });
    await new FileSource({ dir, channel: "own", minAgeMs: 0 }).poll(copying);
    expect(copied).toEqual(["synthetic b"]);
    expect(seen[0]?.byteLength).toBe(0);
  });
});

describe("an engine pass", () => {
  it("leaves every body a store keeps whole, when the store does not copy", async () => {
    const payload = "synthetic text ".repeat(5_000);
    const root = await makeProject({
      "pathways.yaml": "",
      "channels/keep/channel.yaml": [
        "name: keep",
        "format: text",
        "source:",
        "  file: { dir: ../../data/in, minAge: 0 }",
        "destinations:",
        "  - file: { dir: ../../data/out }",
        "",
      ].join("\n"),
      "data/in/payload.txt": payload,
    });
    const project = await loadProject(root);
    const store = new UnencryptedStore(new MemoryStore());
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    try {
      await engine.start();
      await engine.tick();
    } finally {
      await engine.stop();
    }
    const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString();
    expect(text(await readFile(join(root, "data", "out", "1-1.txt"))) === payload).toBe(true);
    expect(text(await store.messageBody(1)) === payload).toBe(true);
    expect((await store.outputs(1)).map(text)).toEqual([payload]);
  });
});
