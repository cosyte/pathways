import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import type * as fs from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAIMED_DIR,
  type FileFault,
  FileSource,
  type FileSourceOptions,
} from "../src/connectors/file.js";
import type { MessageSink } from "../src/connectors/types.js";
import { cleanUp, dropFile, makeProject } from "./helpers.js";

/**
 * `then` runs once, just before the next move whose destination passes `when`, and `after` just
 * after it. With `unsteady`, a file's id changes once it is in a folder inside `.claimed/`, as FAT and exFAT can
 * change one on a move.
 */
const race = vi.hoisted(() => ({
  when: undefined as ((to: string) => boolean) | undefined,
  then: (): void => undefined,
  after: (): void => undefined,
  unsteady: false,
}));

// The move the file source makes after its last check can be raced: just before it, `race.then`
// runs, as a writer in the source folder could between the check and the move, and just after it,
// `race.after`, as one could between the move and the check after it.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (race.when?.(String(args[1])) !== true) {
        await actual.rename(...args);
        return;
      }
      race.when = undefined;
      race.then();
      await actual.rename(...args);
      race.after();
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args);
      // Only in a folder inside .claimed/, where a claim or the check's own file is moved to.
      if (!race.unsteady || !/[\\/]\.claimed[\\/][^\\/]+[\\/]/.test(String(args[0]))) {
        return stats;
      }
      // The file source reads ids with { bigint: true }.
      return Object.assign(stats, { ino: BigInt(stats.ino) + 1n }) as typeof stats;
    },
  };
});

afterEach(async () => {
  race.when = undefined;
  race.after = () => undefined;
  race.unsteady = false;
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

/** The claim folder of the channel these tests read for, `adt`. */
const claims = join(CLAIMED_DIR, "adt");

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
    swapBefore(dir, outside, claims);
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
    race.when = (to) => to.includes(claims);
    race.then = () => unlinkSync(join(dir, "m.hl7.done"));
    expect(await pass(source)).toEqual(["in"]);
    expect(errors).toEqual([]);
    expect(await readdir(dir)).toEqual([CLAIMED_DIR]);
  });
});

/** Puts the real `dir/sub` back where the link to outside was: a second race, won after the move. */
function swapBack(dir: string): void {
  // A rename, not an unlink: Windows renames a junction as it renames a folder.
  renameSync(join(dir, "sub"), join(dir, "gone"));
  renameSync(join(dir, "was-sub"), join(dir, "sub"));
}

/** The files held in `.claimed/`, as their text. */
async function heldIn(dir: string): Promise<string[]> {
  const names = await readdir(join(dir, CLAIMED_DIR));
  const held = names.filter((name) => name.startsWith("refused-"));
  return Promise.all(held.map((name) => readFile(join(dir, CLAIMED_DIR, name), "utf8")));
}

/** A source on `dir` that reads its subfolders, with `options`, and the errors it says. */
function recursiveSource(dir: string, options: Partial<FileSourceOptions> = {}) {
  const errors: unknown[] = [];
  const source = new FileSource({
    dir,
    channel: "adt",
    minAgeMs: 0,
    recursive: true,
    onReadError: (error) => errors.push(error),
    ...options,
  });
  return { source, errors };
}

// A writer who wins the race before the move and another after it decides what is at the path the
// refused file came from when the source moves it back.
describe("FileSource moving a refused file back", () => {
  // Windows will not rename a folder that holds a file the source has open, as it does here.
  it.skipIf(windows)(
    "never moves it over a file put where it came from, and holds it",
    async () => {
      const dir = join(await makeProject({}), "inbox");
      const outside = await makeProject({ "x.hl7": "outside" });
      await dropFile(join(dir, "sub", "x.hl7"), "in");
      const { source, errors } = recursiveSource(dir);
      swapBefore(dir, outside, claims);
      race.after = () => swapBack(dir);
      expect(await pass(source)).toEqual([]);
      expect(errors).toEqual([expect.objectContaining({ code: "ERR_PATHWAYS_FILE_HELD" })]);
      // The file in the source folder is the one that was there, and the outside one is held.
      expect(await readFile(join(dir, "sub", "x.hl7"), "utf8")).toBe("in");
      expect(await heldIn(dir)).toEqual(["outside"]);
      expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
      // The next pass takes the file that was always there, and nothing held.
      expect(await pass(source)).toEqual(["in"]);
    },
  );

  it.skipIf(windows)("holds it when it cannot go back, and never stores it", async () => {
    const dir = join(await makeProject({}), "inbox");
    const outside = await makeProject({ "x.hl7": "outside" });
    await dropFile(join(dir, "sub", "x.hl7"), "in");
    const { source, errors } = recursiveSource(dir);
    swapBefore(dir, outside, claims);
    // The link is gone, so the path it came from is too.
    race.after = () => renameSync(join(dir, "sub"), join(dir, "gone"));
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ERR_PATHWAYS_FILE_HELD" })]);
    expect(await heldIn(dir)).toEqual(["outside"]);
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
    // Neither the next pass nor a new run stores it; the next pass takes only the file that was
    // in the source folder all along, in the folder the writer moved.
    expect(await pass(source)).toEqual(["in"]);
    expect(await pass(recursiveSource(dir).source)).toEqual([]);
    expect(await heldIn(dir)).toEqual(["outside"]);
  });

  it.skipIf(windows)(
    "never takes it once a later swap leaves it in the source folder",
    async () => {
      const dir = join(await makeProject({}), "inbox");
      const outside = await makeProject({ "x.hl7": "outside" });
      await dropFile(join(dir, "sub", "x.hl7"), "in");
      const { source, errors } = recursiveSource(dir);
      swapBefore(dir, outside, claims);
      // The real folder is back, with no file at the name: the move back lands inside the source folder.
      race.after = () => {
        swapBack(dir);
        unlinkSync(join(dir, "sub", "x.hl7"));
      };
      expect(await pass(source)).toEqual([]);
      expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
      expect(await readFile(join(dir, "sub", "x.hl7"), "utf8")).toBe("outside");
      for (let index = 0; index < 3; index += 1) expect(await pass(source)).toEqual([]);
      expect(await readFile(join(dir, "sub", "x.hl7"), "utf8")).toBe("outside");
      // Once it is gone, a new file at that path is taken as any other.
      unlinkSync(join(dir, "sub", "x.hl7"));
      expect(await pass(source)).toEqual([]);
      await dropFile(join(dir, "sub", "x.hl7"), "new");
      expect(await pass(source)).toEqual(["new"]);
    },
  );

  it("never moves a file set aside over one put where it came from", async () => {
    const dir = join(await makeProject({}), "inbox");
    const errorDir = join(await makeProject({}), "errors");
    const outside = await makeProject({ "x.hl7": "outside" });
    await dropFile(join(dir, "sub", "x.hl7"), "in big");
    const faults: FileFault[] = [];
    const { source } = recursiveSource(dir, {
      maxSize: 2,
      errorDir,
      onFileFault: (fault) => faults.push(fault),
    });
    swapBefore(dir, outside, errorDir);
    race.after = () => swapBack(dir);
    expect(await pass(source)).toEqual([]);
    expect(faults).toEqual([
      {
        reason: "too-large",
        moved: false,
        error: expect.objectContaining({ code: "ERR_PATHWAYS_FILE_HELD" }) as unknown,
      },
    ]);
    expect(await readFile(join(dir, "sub", "x.hl7"), "utf8")).toBe("in big");
    expect(await heldIn(dir)).toEqual(["outside"]);
  });
});

describe("FileSource on a file system that changes a file's id when it moves", () => {
  it("claims nothing, moves nothing, and says why on each pass", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "a.hl7"), "in");
    const { source, errors } = recursiveSource(dir);
    race.unsteady = true;
    expect(await pass(source)).toEqual([]);
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ code: "ERR_PATHWAYS_FILE_ID_UNSTEADY" }),
      expect.objectContaining({ code: "ERR_PATHWAYS_FILE_ID_UNSTEADY" }),
    ]);
    expect(await readFile(join(dir, "a.hl7"), "utf8")).toBe("in");
    // The check leaves nothing behind.
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual(["adt"]);
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
  });

  it("checks once, on the first pass with a file to claim, and leaves nothing behind", async () => {
    const dir = join(await makeProject({}), "inbox");
    const { source, errors } = recursiveSource(dir);
    expect(await pass(source)).toEqual([]);
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual(["adt"]);
    await dropFile(join(dir, "a.hl7"), "in");
    expect(await pass(source)).toEqual(["in"]);
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual(["adt"]);
    // Not asked again: an id that changes now fails the check after the move instead.
    race.unsteady = true;
    await dropFile(join(dir, "b.hl7"), "in too");
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
  });
});
