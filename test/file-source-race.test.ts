import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import type * as fs from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CLAIMED_DIR, type FileFault, FileSource } from "../src/connectors/file.js";
import type { MessageSink } from "../src/connectors/types.js";
import { cleanUp, dropFile, makeProject } from "./helpers.js";

/** Run once, just before the next move whose destination passes `when`. */
const race = vi.hoisted(() => ({
  when: undefined as ((to: string) => boolean) | undefined,
  then: (): void => undefined,
}));

// The move the file source makes after its last check can be raced: just before it, `race.then`
// runs, as a writer in the source folder could between the check and the move.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (race.when?.(String(args[1])) === true) {
        race.when = undefined;
        race.then();
      }
      await actual.rename(...args);
    },
  };
});

afterEach(async () => {
  race.when = undefined;
  await cleanUp();
});

/** Is the test run on Windows itself? */
const windows = process.platform === "win32";

/** The bodies a pass hands in, in order. */
async function pass(source: FileSource): Promise<string[]> {
  const bodies: string[] = [];
  const sink: MessageSink = {
    receive(body: Uint8Array) {
      bodies.push(new TextDecoder().decode(body));
      return Promise.resolve(bodies.length);
    },
  };
  await source.poll(sink);
  return bodies;
}

/** Swaps `dir/sub` for a link to `outside` just before the next move into a path that has `into`. */
function swapBefore(dir: string, outside: string, into: string): void {
  race.when = (to) => to.includes(into);
  race.then = () => {
    renameSync(join(dir, "sub"), join(dir, "was-sub"));
    // A junction on Windows, which needs no privilege; elsewhere a symbolic link.
    symlinkSync(outside, join(dir, "sub"), "junction");
  };
}

// A folder link here is a junction on Windows, which needs no privilege; elsewhere a symbolic link.
describe("FileSource and a folder swapped for a link between the last check and the move", () => {
  // Windows will not rename a folder that holds a file the source has open, as it does here.
  it.skipIf(windows)("moves a file claimed from outside back, and refuses it", async () => {
    const dir = join(await makeProject({}), "inbox");
    const outside = await makeProject({ "x.hl7": "outside" });
    await dropFile(join(dir, "sub", "x.hl7"), "in");
    const errors: unknown[] = [];
    const source = new FileSource({
      dir,
      channel: "adt",
      minAgeMs: 0,
      recursive: true,
      onReadError: (error) => errors.push(error),
    });
    swapBefore(dir, outside, CLAIMED_DIR);
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
    expect(await readFile(join(outside, "x.hl7"), "utf8")).toBe("outside");
    expect(await readFile(join(dir, "was-sub", "x.hl7"), "utf8")).toBe("in");
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
  });

  it("moves a file set aside from outside back, and says it was not moved", async () => {
    const dir = join(await makeProject({}), "inbox");
    const errorDir = join(await makeProject({}), "errors");
    const outside = await makeProject({ "x.hl7": "outside" });
    await dropFile(join(dir, "sub", "x.hl7"), "in big");
    const faults: FileFault[] = [];
    const source = new FileSource({
      dir,
      channel: "adt",
      minAgeMs: 0,
      recursive: true,
      maxSize: 2,
      errorDir,
      onFileFault: (fault) => faults.push(fault),
    });
    swapBefore(dir, outside, errorDir);
    expect(await pass(source)).toEqual([]);
    expect(faults).toEqual([
      {
        reason: "too-large",
        moved: false,
        error: expect.objectContaining({ code: "ESTALE" }) as unknown,
      },
    ]);
    expect(await readFile(join(outside, "x.hl7"), "utf8")).toBe("outside");
    expect(await readFile(join(dir, "was-sub", "x.hl7"), "utf8")).toBe("in big");
    expect(await readdir(join(errorDir, "sub"))).toEqual([]);
  });

  it("moves a marker from outside back, keeps it, and says so", async () => {
    const dir = join(await makeProject({}), "inbox");
    const outside = await makeProject({ "m.hl7.done": "outside" });
    await dropFile(join(dir, "sub", "m.hl7"), "in");
    await dropFile(join(dir, "sub", "m.hl7.done"), "");
    const errors: unknown[] = [];
    const source = new FileSource({
      dir,
      channel: "adt",
      minAgeMs: 0,
      recursive: true,
      doneFile: ".done",
      onReadError: (error) => errors.push(error),
    });
    swapBefore(dir, outside, "marker-");
    expect(await pass(source)).toEqual(["in"]);
    expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
    expect(await readFile(join(outside, "m.hl7.done"), "utf8")).toBe("outside");
    expect(await readdir(join(dir, "was-sub"))).toEqual(["m.hl7.done"]);
    expect((await readdir(join(dir, CLAIMED_DIR))).sort()).toEqual(["adt"]);
  });

  it("passes over a marker its writer deleted before the source did", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "m.hl7"), "in");
    await dropFile(join(dir, "m.hl7.done"), "");
    const errors: unknown[] = [];
    const source = new FileSource({
      dir,
      channel: "adt",
      minAgeMs: 0,
      doneFile: ".done",
      onReadError: (error) => errors.push(error),
    });
    race.when = (to) => to.includes(CLAIMED_DIR);
    race.then = () => unlinkSync(join(dir, "m.hl7.done"));
    expect(await pass(source)).toEqual(["in"]);
    expect(errors).toEqual([]);
    expect(await readdir(dir)).toEqual([CLAIMED_DIR]);
  });
});
