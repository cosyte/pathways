import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLAIMED_DIR, FileDestination, FileSource } from "../src/connectors/file.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { FakeLocation } from "./fake-location.js";
import { cleanUp, dropFile, makeProject } from "./helpers.js";

afterEach(cleanUp);

/**
 * A sink that stores each message once by its idempotency key, as the engine's store does: a resumed
 * message whose key it holds gets the id it already has. `stored` maps each key to its body.
 */
function store(): { sink: MessageSink; stored: Map<string, string>; resumed: string[] } {
  const stored = new Map<string, string>();
  const ids = new Map<string, number>();
  const resumed: string[] = [];
  const sink: MessageSink = {
    receive(body: Uint8Array, options: ReceiveOptions = {}) {
      const key = String(options.idempotencyKey);
      if (options.resumed === true) resumed.push(key);
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(key, id);
        stored.set(key, new TextDecoder().decode(body));
      }
      return Promise.resolve(id);
    },
  };
  return { sink, stored, resumed };
}

/** The bodies stored, sorted, so a body stored twice shows twice. */
const bodies = (stored: Map<string, string>): string[] => [...stored.values()].sort();

/** `count` synthetic bodies, `msg-00` and on. */
const names = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `msg-${String(at).padStart(2, "0")}`);

describe("FileSource over a location", () => {
  it("refuses a location that cannot rename a file in one step", () => {
    const location = new FakeLocation({ atomicRename: false });
    expect(() => new FileSource({ dir: "/inbox", channel: "adt", minAgeMs: 0, location })).toThrow(
      expect.objectContaining({ code: "ERR_PATHWAYS_FILE_NO_ATOMIC_RENAME" }),
    );
  });

  it("claims, stores and deletes each file on a fake file system, and makes the claims durable first", async () => {
    const location = new FakeLocation();
    location.put("/inbox/b.hl7", "second");
    location.put("/inbox/a.hl7", "first");
    const { sink, stored } = store();
    const order: string[] = [];
    const source = new FileSource({ dir: "/inbox", channel: "adt", minAgeMs: 0, location });
    await source.poll({
      receive: (body, options) => {
        order.push(new TextDecoder().decode(body));
        expect(location.flushed).toHaveLength(1);
        return sink.receive(body, options);
      },
    });
    expect(order).toEqual(["first", "second"]);
    expect(bodies(stored)).toEqual(["first", "second"]);
    expect(location.under("/inbox")).toEqual([]);
    expect(location.flushed[0]).toEqual([
      expect.stringMatching(/^\/inbox\/\.claimed\/adt\/\d{15}\.00000000\.[0-9a-f]{8}-a\.hl7$/),
      expect.stringMatching(/^\/inbox\/\.claimed\/adt\/\d{15}\.00000001\.[0-9a-f]{8}-b\.hl7$/),
    ]);
  });

  it("reads subfolders and keeps processed files on a fake file system", async () => {
    const location = new FakeLocation();
    location.put("/inbox/wards/east/a.hl7", "east");
    const { sink } = store();
    const source = new FileSource({
      dir: "/inbox",
      channel: "adt",
      minAgeMs: 0,
      recursive: true,
      keepProcessed: true,
      location,
    });
    await source.poll(sink);
    expect(location.under("/inbox")).toEqual(["/inbox/processed/wards/east/1-a.hl7"]);
  });

  it("sets a file larger than maxSize aside into errorDir on a fake file system", async () => {
    const location = new FakeLocation();
    location.put("/inbox/big.hl7", "too large");
    const faults: unknown[] = [];
    const { sink, stored } = store();
    const source = new FileSource({
      dir: "/inbox",
      channel: "adt",
      minAgeMs: 0,
      maxSize: 4,
      errorDir: "/errors",
      onFileFault: (fault) => faults.push(fault),
      location,
    });
    await source.poll(sink);
    expect(stored.size).toBe(0);
    expect(faults).toEqual([{ reason: "too-large", moved: true }]);
    expect(location.under("/errors")).toEqual(["/errors/big.hl7"]);
  });

  it("refuses a file whose folder the location resolves outside the source folder, on any location", async () => {
    // The shared check runs on every location: this one resolves a subfolder somewhere else, as a
    // folder swapped for a link would be, and has no check of its own.
    class Escaping extends FakeLocation {
      override async root(dir: string): Promise<string> {
        const resolved = await super.root(dir);
        return resolved === "/inbox/wards" ? "/elsewhere/wards" : resolved;
      }
    }
    const location = new Escaping();
    location.put("/inbox/wards/a.hl7", "first");
    const errors: unknown[] = [];
    const { sink, stored } = store();
    const source = new FileSource({
      dir: "/inbox",
      channel: "adt",
      minAgeMs: 0,
      recursive: true,
      onReadError: (error) => errors.push(error),
      location,
    });
    await source.poll(sink);
    expect(stored.size).toBe(0);
    expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
    expect(location.under("/inbox")).toEqual(["/inbox/wards/a.hl7"]);
  });

  it("claims nothing where a file's id changes when it moves", async () => {
    const location = new FakeLocation();
    location.steady = false;
    location.put("/inbox/a.hl7", "first");
    const errors: unknown[] = [];
    const { sink, stored } = store();
    const source = new FileSource({
      dir: "/inbox",
      channel: "adt",
      minAgeMs: 0,
      onReadError: (error) => errors.push(error),
      location,
    });
    await source.poll(sink);
    expect(stored.size).toBe(0);
    expect(errors).toEqual([expect.objectContaining({ code: "ERR_PATHWAYS_FILE_ID_UNSTEADY" })]);
    expect(location.under("/inbox")).toEqual(["/inbox/a.hl7"]);
  });
});

/** An error's code. */
const code = (error: unknown): unknown => (error as { code?: unknown }).code;

/**
 * Polls every engine at once, ten times. Returns each pass that stopped: one engine's pass stops
 * when a file it listed is claimed by the other before it reads the file's size, and the next pass
 * goes on.
 */
async function together(engines: readonly FileSource[], sink: MessageSink): Promise<unknown[]> {
  const stops: unknown[] = [];
  for (let pass = 0; pass < 10; pass += 1) {
    for (const result of await Promise.allSettled(engines.map((engine) => engine.poll(sink)))) {
      if (result.status === "rejected") stops.push(result.reason);
    }
  }
  return stops;
}

// The claim rule of each scheme, held to one property: two engines polling one location at once
// store each file once. Each reads for a channel of its own, as two engines on one folder do, and
// the rename to a unique claim name is what gives each file to one of them.
describe("the rename claim rule, with two engines polling one location", () => {
  it("stores each file once on a fake file system", async () => {
    const location = new FakeLocation();
    for (const name of names(30)) location.put(`/inbox/${name}.hl7`, name);
    const { sink, stored } = store();
    const errors: unknown[] = [];
    const engines = ["adt", "lab"].map(
      (channel) =>
        new FileSource({
          dir: "/inbox",
          channel,
          minAgeMs: 0,
          maxPerPoll: 7,
          onReadError: (error) => errors.push(error),
          location,
        }),
    );
    const stops = await together(engines, sink);
    expect(bodies(stored)).toEqual(names(30));
    expect(location.under("/inbox")).toEqual([]);
    // A file the other engine took first is gone when this one opens, reads or renames it.
    const failures = [...errors, ...stops];
    expect(failures.map(code)).toEqual(failures.map(() => "ENOENT"));
  });

  it("stores each file once in a local folder", async () => {
    const dir = join(await makeProject({}), "inbox");
    for (const name of names(30)) await dropFile(join(dir, `${name}.hl7`), name);
    const { sink, stored } = store();
    const engines = ["adt", "lab"].map(
      (channel) => new FileSource({ dir, channel, minAgeMs: 0, maxPerPoll: 7 }),
    );
    const stops = await together(engines, sink);
    expect(stops.map(code)).toEqual(stops.map(() => "ENOENT"));
    expect(bodies(stored)).toEqual(names(30));
    expect((await readdir(dir)).filter((name) => name !== CLAIMED_DIR)).toEqual([]);
  });
});

// A run stopped at each step of a pass, on a fake file system: the next run (a new source on the
// same location) stores what the stopped one left, each file once, and leaves the folder empty.
describe("FileSource stopped part way on a fake file system", () => {
  const steps: [string, (op: string, path: string) => boolean][] = [
    ["the claim's rename", (op, path) => op === "rename" && path.includes("/.claimed/adt/")],
    ["the flush of the claims", (op) => op === "durable"],
    ["the read of a claimed file", (op) => op === "read"],
    ["the delete after the store", (op) => op === "remove"],
  ];

  it.each(steps)("at %s", async (_, step) => {
    const location = new FakeLocation();
    for (const name of names(3)) location.put(`/inbox/${name}.hl7`, name);
    const { sink, stored } = store();
    const options = { dir: "/inbox", channel: "adt", minAgeMs: 0, location };
    location.fail = step;
    // A failure the pass reports goes to onReadError; one it cannot goes out of poll, as a stop.
    await new FileSource({ ...options, onReadError: () => undefined })
      .poll(sink)
      .catch(() => undefined);
    expect(location.fail).toBeUndefined();
    const restarted = new FileSource(options);
    await restarted.poll(sink);
    await restarted.poll(sink);
    expect(bodies(stored)).toEqual(names(3));
    expect(location.under("/inbox")).toEqual([]);
  });

  it("hands a file stored before the stop in again under its key, marked resumed", async () => {
    const location = new FakeLocation();
    location.put("/inbox/a.hl7", "first");
    const { sink, stored, resumed } = store();
    const options = { dir: "/inbox", channel: "adt", minAgeMs: 0, location };
    location.fail = (op) => op === "remove";
    await expect(new FileSource(options).poll(sink)).rejects.toThrow("EIO");
    await new FileSource(options).poll(sink);
    expect([...stored.keys()]).toEqual(resumed);
    expect(bodies(stored)).toEqual(["first"]);
  });
});

describe("FileDestination over a location", () => {
  it("writes each output through a temporary name on a fake file system", async () => {
    const location = new FakeLocation();
    const destination = new FileDestination({ dir: "/outbox", extension: "hl7", location });
    await destination.deliver({ messageId: 7, seq: 0, body: new TextEncoder().encode("out") });
    expect(location.under("/outbox")).toEqual(["/outbox/7-1.hl7"]);
    expect(new TextDecoder().decode(await location.read("/outbox/7-1.hl7"))).toBe("out");
  });
});
