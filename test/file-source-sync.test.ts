import type * as fs from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSource } from "../src/connectors/file.js";
import type { MessageSink } from "../src/connectors/types.js";
import { cleanUp, dropFile, makeProject } from "./helpers.js";

/** Each folder flushed to disk and each message handed in, in order. */
const events = vi.hoisted((): string[] => []);

// Every handle the file source opens notes when it is flushed to disk.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(`sync ${String(args[0])}`);
        await sync();
      };
      return handle;
    },
  };
});

afterEach(cleanUp);

describe("FileSource on disk", () => {
  it("flushes every move of a pass to disk before it stores a file, so a power cut cannot undo a stored claim", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "a.hl7"), "first");
    await dropFile(join(dir, "b.hl7"), "second");
    const sink: MessageSink = {
      receive(body) {
        events.push(`receive ${new TextDecoder().decode(body)}`);
        return Promise.resolve(events.length);
      },
    };
    events.length = 0;
    const source = new FileSource({ dir, channel: "adt", minAgeMs: 0 });
    await source.poll(sink);

    const claims = join(dir, ".claimed", "adt");
    expect(events).toEqual([
      // Once a pass, before anything is stored: the folder the files moved into, the folder that
      // holds it, and the folder they moved out of.
      `sync ${claims}`,
      `sync ${join(dir, ".claimed")}`,
      `sync ${dir}`,
      "receive first",
      "receive second",
    ]);

    // A pass that claims nothing flushes nothing.
    events.length = 0;
    await source.poll(sink);
    expect(events).toEqual([]);
  });
});
