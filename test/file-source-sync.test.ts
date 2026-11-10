import type * as fs from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { FileSource } from "../src/connectors/file.js";
import type { MessageSink } from "../src/connectors/types.js";
import { cleanUp, dropFile, makeProject, usePlatform } from "./helpers.js";

/**
 * Each move, each flush to disk and each message handed in, in order, and whether a flush of a
 * folder fails as it does on Windows.
 */
const disk = vi.hoisted(() => ({
  events: [] as (readonly [what: string, path: string])[],
  windowsFolders: false,
}));

// Every move the file source makes notes itself, and every handle it opens notes when it is flushed
// to disk, with the flags it was opened with. With `windowsFolders`, flushing a folder fails as it
// does on Windows: `FlushFileBuffers` refuses the handle, and Node reports EPERM.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      disk.events.push(["rename", String(args[0])]);
      await actual.rename(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const folder = (await handle.stat()).isDirectory();
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        disk.events.push([`sync ${String(args[1])}`, String(args[0])]);
        if (folder && disk.windowsFolders) {
          throw Object.assign(new Error("EPERM: operation not permitted, fsync"), {
            code: "EPERM",
          });
        }
        await sync();
      };
      return handle;
    },
  };
});

/** Runs the file source as it runs on `platform`, whatever this test runs on. */
function onPlatform(platform: NodeJS.Platform): void {
  onTestFinished(usePlatform(platform));
}

afterEach(async () => {
  disk.events.length = 0;
  disk.windowsFolders = false;
  await cleanUp();
});

/** A sink that notes each message it is handed. */
const sink: MessageSink = {
  receive(body) {
    disk.events.push(["receive", new TextDecoder().decode(body)]);
    return Promise.resolve(disk.events.length);
  },
};

/** An inbox holding a.hl7 and b.hl7. */
async function inbox(): Promise<string> {
  const dir = join(await makeProject({}), "inbox");
  await dropFile(join(dir, "a.hl7"), "first");
  await dropFile(join(dir, "b.hl7"), "second");
  return dir;
}

/** The events, each path relative to `dir` (`.` for `dir` itself) with any claim id left out. */
function eventsIn(dir: string): string[] {
  return disk.events.map(([what, arg]) => {
    if (what === "receive") return `${what} ${arg}`;
    const path = relative(dir, arg).split(sep).join("/");
    return `${what} ${path.replace(/\d{15}\.\d{8}\.[0-9a-f]{8}-/, "<claim>-") || "."}`;
  });
}

describe("FileSource on disk", () => {
  it("flushes every move of a pass to disk before it stores a file, so a power cut cannot undo a stored claim", async () => {
    onPlatform("linux");
    const dir = await inbox();
    const source = new FileSource({ dir, channel: "adt", minAgeMs: 0 });
    await source.poll(sink);

    expect(eventsIn(dir)).toEqual([
      "rename a.hl7",
      "rename b.hl7",
      // Once a pass, before anything is stored: the folder the files moved into, the folder that
      // holds it, and the folder they moved out of.
      "sync r .claimed/adt",
      "sync r .claimed",
      "sync r .",
      "receive first",
      "receive second",
    ]);

    // A pass that claims nothing flushes nothing.
    disk.events.length = 0;
    await source.poll(sink);
    expect(disk.events).toEqual([]);
  });

  it("on Windows, flushes each claimed file under its claimed name before it stores a file, and no folder", async () => {
    onPlatform("win32");
    const dir = await inbox();
    const source = new FileSource({ dir, channel: "adt", minAgeMs: 0 });
    await source.poll(sink);

    expect(eventsIn(dir)).toEqual([
      "rename a.hl7",
      "rename b.hl7",
      // Each file opened to write, as FlushFileBuffers needs, under the name it was moved to.
      "sync r+ .claimed/adt/<claim>-a.hl7",
      "sync r+ .claimed/adt/<claim>-b.hl7",
      "receive first",
      "receive second",
    ]);

    // A pass that claims nothing flushes nothing.
    disk.events.length = 0;
    await source.poll(sink);
    expect(disk.events).toEqual([]);
  });

  it("on Windows, where a folder cannot be flushed, claims, stores and deletes every file", async () => {
    disk.windowsFolders = true;

    // The folder flush that Linux and macOS use fails here, as it did on Windows before.
    onPlatform("linux");
    const before = await inbox();
    await expect(
      new FileSource({ dir: before, channel: "adt", minAgeMs: 0 }).poll(sink),
    ).rejects.toMatchObject({ code: "EPERM" });

    disk.events.length = 0;
    onPlatform("win32");
    const dir = await inbox();
    await new FileSource({ dir, channel: "adt", minAgeMs: 0 }).poll(sink);
    expect(eventsIn(dir).filter((event) => event.startsWith("receive"))).toEqual([
      "receive first",
      "receive second",
    ]);
    expect(await readdir(dir)).toEqual([".claimed"]);
    expect(await readdir(join(dir, ".claimed", "adt"))).toEqual([]);
  });
});
