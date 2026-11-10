import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLAIMED_DIR, FileSource, PROCESSED_DIR } from "../src/connectors/file.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { cleanUp, dropFile, makeProject } from "./helpers.js";

afterEach(cleanUp);

const text = (body: Uint8Array): string => new TextDecoder().decode(body);

/** What a sink was handed, in order. */
interface Received {
  readonly body: string;
  readonly key: string | undefined;
  readonly resumed: boolean | undefined;
}

/**
 * A sink that looks a resumed message's idempotency key up, as the engine's store does, and stores
 * it once. With `crash.afterStore`, it stores the next message and then throws, as a process that
 * stops between storing a message and acknowledging it; with `crash.beforeStore`, it throws first.
 */
function idempotentSink(): {
  sink: MessageSink;
  received: Received[];
  stored: Map<string, number>;
  crash: { afterStore: boolean; beforeStore: boolean };
} {
  const received: Received[] = [];
  const stored = new Map<string, number>();
  const crash = { afterStore: false, beforeStore: false };
  let next = 1;
  const sink: MessageSink = {
    receive(body: Uint8Array, options: ReceiveOptions = {}) {
      received.push({ body: text(body), key: options.idempotencyKey, resumed: options.resumed });
      if (crash.beforeStore) {
        crash.beforeStore = false;
        return Promise.reject(new Error("stopped before storing"));
      }
      const key = options.idempotencyKey ?? `unkeyed-${String(next)}`;
      let id = options.resumed === true ? stored.get(key) : undefined;
      if (id === undefined) {
        id = next++;
        stored.set(key, id);
      }
      if (crash.afterStore) {
        crash.afterStore = false;
        return Promise.reject(new Error("stopped after storing"));
      }
      return Promise.resolve(id);
    },
  };
  return { sink, received, stored, crash };
}

async function inbox(): Promise<string> {
  return join(await makeProject({}), "inbox");
}

describe("FileSource", () => {
  it("stores each file and deletes it, keeping no copy, by default", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "b.hl7"), "second");
    await dropFile(join(dir, "a.hl7"), "first");
    const { sink, received } = idempotentSink();
    await new FileSource({ dir, minAgeMs: 0 }).poll(sink);

    expect(received.map((r) => r.body)).toEqual(["first", "second"]);
    // Each message carries a key of its own, so storing it again after a restart stores nothing. A
    // file taken in for the first time is not resumed: it cannot have been stored before.
    expect(received.map((r) => r.resumed)).toEqual([false, false]);
    const keys = received.map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toMatch(/^file:/);
    expect(await readdir(dir)).toEqual([CLAIMED_DIR]);
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual([]);
  });

  it("keeps a plaintext copy in processed/, named by message id, only when told to", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "first");
    await dropFile(join(dir, "b.hl7"), "second");
    const { sink } = idempotentSink();
    await new FileSource({ dir, minAgeMs: 0, keepProcessed: true }).poll(sink);

    expect((await readdir(dir)).sort()).toEqual([CLAIMED_DIR, PROCESSED_DIR]);
    expect((await readdir(join(dir, PROCESSED_DIR))).sort()).toEqual(["1-a.hl7", "2-b.hl7"]);
    expect(await readFile(join(dir, PROCESSED_DIR, "2-b.hl7"), "utf8")).toBe("second");
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual([]);
  });

  it("stores a file once when it stops between storing and deleting it, and deletes it on restart", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "first");
    await dropFile(join(dir, "b.hl7"), "second");
    const { sink, received, stored, crash } = idempotentSink();
    crash.afterStore = true;
    await expect(new FileSource({ dir, minAgeMs: 0 }).poll(sink)).rejects.toThrow(
      "stopped after storing",
    );
    // Stored, not yet deleted: it waits in the claimed folder, and b.hl7 was never touched.
    expect(stored.size).toBe(1);
    expect(await readdir(join(dir, CLAIMED_DIR))).toHaveLength(1);
    expect(await readdir(dir)).toEqual([CLAIMED_DIR, "b.hl7"]);

    // The restart: a new source on the same folder.
    await new FileSource({ dir, minAgeMs: 0 }).poll(sink);
    expect(received.map((r) => r.body)).toEqual(["first", "first", "second"]);
    // The first file came back under the same key, resumed, so it was stored once.
    expect(received[1]?.key).toBe(received[0]?.key);
    expect(received.map((r) => r.resumed)).toEqual([false, true, false]);
    expect([...stored.values()]).toEqual([1, 2]);
    expect(await readdir(dir)).toEqual([CLAIMED_DIR]);
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual([]);
  });

  it("loses nothing when it stops before a file is stored, and stores it on restart", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "first");
    const { sink, stored, crash } = idempotentSink();
    crash.beforeStore = true;
    await expect(
      new FileSource({ dir, minAgeMs: 0, keepProcessed: true }).poll(sink),
    ).rejects.toThrow("stopped before storing");
    expect(stored.size).toBe(0);
    expect(await readdir(join(dir, CLAIMED_DIR))).toHaveLength(1);

    await new FileSource({ dir, minAgeMs: 0, keepProcessed: true }).poll(sink);
    expect(stored.size).toBe(1);
    expect(await readdir(join(dir, PROCESSED_DIR))).toEqual(["1-a.hl7"]);
    expect(await readFile(join(dir, PROCESSED_DIR, "1-a.hl7"), "utf8")).toBe("first");
  });

  it("finishes files claimed by an earlier run first, oldest claim first, before new ones", async () => {
    const dir = await inbox();
    const claimed = join(dir, CLAIMED_DIR);
    await mkdir(claimed, { recursive: true });
    await writeFile(join(claimed, "000001700000002.00000000000b-later.hl7"), "claimed second");
    await writeFile(join(claimed, "000001700000001.00000000000a-earlier.hl7"), "claimed first");
    // A file someone put there by hand keeps its whole name.
    await writeFile(join(claimed, "loose.hl7"), "loose");
    await dropFile(join(dir, "new.hl7"), "new");
    const { sink, received } = idempotentSink();
    await new FileSource({ dir, minAgeMs: 0, keepProcessed: true }).poll(sink);

    expect(received.map((r) => r.body)).toEqual([
      "claimed first",
      "claimed second",
      "loose",
      "new",
    ]);
    expect(received[0]?.key).toBe("file:000001700000001.00000000000a-earlier.hl7");
    expect(received.map((r) => r.resumed)).toEqual([true, true, true, false]);
    expect((await readdir(join(dir, PROCESSED_DIR))).sort()).toEqual([
      "1-earlier.hl7",
      "2-later.hl7",
      "3-loose.hl7",
      "4-new.hl7",
    ]);
  });

  it("names each claim by the time it was taken, so claims sort in the order they were made", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "first");
    const { sink, received, crash } = idempotentSink();
    crash.afterStore = true;
    await expect(
      new FileSource({ dir, minAgeMs: 0, now: () => 9_000_000_000_123 }).poll(sink),
    ).rejects.toThrow();
    const [name] = await readdir(join(dir, CLAIMED_DIR));
    expect(name).toMatch(/^009000000000123\.[0-9a-f]{12}-a\.hl7$/);
    expect(received[0]?.key).toBe(`file:${String(name)}`);
  });

  it.skipIf(process.getuid?.() === 0)(
    "leaves a file it cannot claim where it is, and says so, then carries on",
    async () => {
      const dir = await inbox();
      await mkdir(join(dir, CLAIMED_DIR), { recursive: true });
      await dropFile(join(dir, "a.hl7"), "first");
      const errors: unknown[] = [];
      const { sink, received } = idempotentSink();
      // A folder the engine can read but not change: the file cannot be moved out of it.
      await chmod(dir, 0o555);
      try {
        await new FileSource({
          dir,
          minAgeMs: 0,
          onReadError: (error) => errors.push(error),
        }).poll(sink);
      } finally {
        await chmod(dir, 0o755);
      }
      expect(received).toEqual([]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as { code?: unknown }).code).toBe("EACCES");
      expect((await readdir(dir)).sort()).toEqual([CLAIMED_DIR, "a.hl7"]);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "leaves a file it cannot read where it is, and says so, then carries on",
    async () => {
      const dir = await inbox();
      await dropFile(join(dir, "a.hl7"), "unreadable");
      await dropFile(join(dir, "b.hl7"), "readable");
      await chmod(join(dir, "a.hl7"), 0o000);
      const errors: unknown[] = [];
      const { sink, received } = idempotentSink();
      const source = new FileSource({ dir, minAgeMs: 0, onReadError: (e) => errors.push(e) });
      await source.poll(sink);
      expect(received.map((r) => r.body)).toEqual(["readable"]);
      expect((errors as { code?: unknown }[]).map((e) => e.code)).toEqual(["EACCES"]);
      expect(await readdir(dir)).toEqual([CLAIMED_DIR, "a.hl7"]);

      // Once it can be read, the next pass stores it.
      await chmod(join(dir, "a.hl7"), 0o644);
      await source.poll(sink);
      expect(received.map((r) => r.body)).toEqual(["readable", "unreadable"]);
      expect(await readdir(dir)).toEqual([CLAIMED_DIR]);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "keeps a claimed file it cannot read for the next pass, and says so, then carries on",
    async () => {
      const dir = await inbox();
      const claimed = join(dir, CLAIMED_DIR);
      await mkdir(claimed, { recursive: true });
      const name = "000001700000001.00000000000a-a.hl7";
      await writeFile(join(claimed, name), "claimed");
      await chmod(join(claimed, name), 0o000);
      await dropFile(join(dir, "b.hl7"), "new");
      const { sink, received } = idempotentSink();
      // With no onReadError, the failure is passed over quietly.
      const source = new FileSource({ dir, minAgeMs: 0 });
      await source.poll(sink);
      expect(received.map((r) => r.body)).toEqual(["new"]);
      expect(await readdir(claimed)).toEqual([name]);

      await chmod(join(claimed, name), 0o644);
      await source.poll(sink);
      expect(received.map((r) => r.body)).toEqual(["new", "claimed"]);
      expect(await readdir(claimed)).toEqual([]);
    },
  );

  it("takes files oldest name first, and leaves a file that has not sat for minAge, and hidden files", async () => {
    const dir = await inbox();
    for (const name of ["c.hl7", "a.hl7", "d.hl7", "b.hl7"]) await dropFile(join(dir, name), name);
    // Just written, so still being written as far as the source can tell.
    await writeFile(join(dir, "e.hl7"), "e.hl7");
    await dropFile(join(dir, ".hidden.hl7"), "hidden");
    const { sink, received } = idempotentSink();
    await new FileSource({ dir, minAgeMs: 30_000 }).poll(sink);
    expect(received.map((r) => r.body)).toEqual(["a.hl7", "b.hl7", "c.hl7", "d.hl7"]);
    expect((await readdir(dir)).sort()).toEqual([".claimed", ".hidden.hl7", "e.hl7"]);
  });

  it("passes over a folder in the claimed folder", async () => {
    const dir = await inbox();
    await mkdir(join(dir, CLAIMED_DIR, "a-folder"), { recursive: true });
    const { sink, received } = idempotentSink();
    // A folder in the claimed folder is not a file: it is passed over.
    await new FileSource({ dir, minAgeMs: 0 }).poll(sink);
    expect(received).toEqual([]);
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual(["a-folder"]);
  });
});
