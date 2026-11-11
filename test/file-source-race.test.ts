import { renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
 * after it. With `unsteady`, a file's inode (`ino`) or device (`dev`) number changes once it is in a
 * folder inside `.claimed/`, as FAT and exFAT can change a file's id on a move.
 */
const race = vi.hoisted(() => ({
  when: undefined as ((to: string) => boolean) | undefined,
  then: (): void => undefined,
  after: (): void => undefined,
  unsteady: undefined as "ino" | "dev" | undefined,
  fail: undefined as ((what: string, path: string) => boolean) | undefined,
}));

/** Throws EIO when `race.fail` picks this call: once, as it then clears itself. */
function failing(what: string, path: unknown): void {
  if (race.fail?.(what, String(path)) !== true) return;
  race.fail = undefined;
  throw Object.assign(new Error(`EIO: i/o error, ${what}`), { code: "EIO" });
}

// The move the file source makes after its last check can be raced: just before it, `race.then`
// runs, as a writer in the source folder could between the check and the move, and just after it,
// `race.after`, as one could between the move and the check after it.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      failing("rename", args[1]);
      if (race.when?.(String(args[1])) !== true) {
        await actual.rename(...args);
        return;
      }
      race.when = undefined;
      race.then();
      await actual.rename(...args);
      race.after();
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      failing("unlink", args[0]);
      await actual.unlink(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      failing("writeFile", args[0]);
      await actual.writeFile(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      failing("lstat", args[0]);
      const stats = await actual.lstat(...args);
      // Only in a folder inside .claimed/, where a claim or the check's own file is moved to.
      if (race.unsteady === undefined || !/[\\/]\.claimed[\\/][^\\/]+[\\/]/.test(String(args[0]))) {
        return stats;
      }
      // The file source reads ids with { bigint: true }.
      const part = race.unsteady;
      return Object.assign(stats, { [part]: BigInt(stats[part]) + 1n }) as typeof stats;
    },
  };
});

afterEach(async () => {
  race.when = undefined;
  race.after = () => undefined;
  race.unsteady = undefined;
  race.fail = undefined;
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
      expect(errors).toEqual([
        expect.objectContaining({
          code: "ERR_PATHWAYS_FILE_HELD",
          message: "a refused file could not be moved back, and is held",
        }),
      ]);
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

describe("FileSource when a step of moving a refused file back fails", () => {
  it.skipIf(windows)(
    "keeps its held name, never the claim folder, when the unlink after the link fails",
    async () => {
      const dir = join(await makeProject({}), "inbox");
      const outside = await makeProject({ "x.hl7": "outside" });
      await dropFile(join(dir, "sub", "x.hl7"), "in");
      const { source, errors } = recursiveSource(dir);
      swapBefore(dir, outside, claims);
      race.after = () => {
        race.fail = (what, path) => what === "unlink" && path.includes("refused-");
      };
      expect(await pass(source)).toEqual([]);
      expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
      // Back where it came from, and the second name it had is held, never in the claim folder.
      expect(await readFile(join(outside, "x.hl7"), "utf8")).toBe("outside");
      expect(await heldIn(dir)).toEqual(["outside"]);
      expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
    },
  );

  it.skipIf(windows)(
    "never stores a refused file that could not be held either, while it runs",
    async () => {
      const dir = join(await makeProject({}), "inbox");
      const outside = await makeProject({ "x.hl7": "outside" });
      await dropFile(join(dir, "sub", "x.hl7"), "in");
      const { source, errors } = recursiveSource(dir);
      swapBefore(dir, outside, claims);
      race.after = () => {
        renameSync(join(dir, "sub"), join(dir, "gone"));
        race.fail = (what, path) => what === "rename" && path.includes("refused-");
      };
      expect(await pass(source)).toEqual([]);
      expect(errors).toEqual([expect.objectContaining({ code: "ERR_PATHWAYS_FILE_HELD" })]);
      expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toHaveLength(1);
      // The next pass takes the file that was in the source folder all along, never the claim.
      expect(await pass(source)).toEqual(["in"]);
      // A pass that cannot read the claim's id leaves it too, and still knows it after.
      race.fail = (what, path) => what === "lstat" && path.includes(claims);
      expect(await pass(source)).toEqual([]);
      expect(await pass(source)).toEqual([]);
      expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toHaveLength(1);
      // A claim left by a run that stopped part way is still stored beside it.
      await dropFile(join(dir, claims, "000001700000001.00000000.0000000a-y.hl7"), "unfinished");
      expect(await pass(source)).toEqual(["unfinished"]);
      expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toHaveLength(1);
    },
  );

  it("says a check of the file system that fails, claims nothing, and checks again next pass", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "a.hl7"), "in");
    const { source, errors } = recursiveSource(dir);
    race.fail = (what, path) => what === "writeFile" && path.includes("probe-");
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "EIO" })]);
    expect(await pass(source)).toEqual(["in"]);
  });
});

/**
 * Puts another file at `dir/x.hl7` just before the next move into the claim folder, as a writer in
 * the source folder could between the last check and the move, and keeps the file that was there
 * at `kept`. No folder is renamed, so this runs on Windows too.
 */
async function swapFileBefore(dir: string): Promise<string> {
  const elsewhere = await makeProject({ "swapped.hl7": "swapped" });
  const kept = join(elsewhere, "kept.hl7");
  race.when = (to) => to.includes(claims);
  race.then = () => {
    renameSync(join(dir, "x.hl7"), kept);
    renameSync(join(elsewhere, "swapped.hl7"), join(dir, "x.hl7"));
  };
  return kept;
}

// A file swapped for another in the source folder itself, between the last check and the move: the
// move takes the other one, which goes to a held name in .claimed/ and back from there.
describe("FileSource moving a swapped file back, on every system", () => {
  it("moves it back by way of its held name, and never takes it while it runs", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "x.hl7"), "in");
    const { source, errors } = recursiveSource(dir);
    const kept = await swapFileBefore(dir);
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
    expect(await readFile(join(dir, "x.hl7"), "utf8")).toBe("swapped");
    expect(await readFile(kept, "utf8")).toBe("in");
    // Its held name is gone, and nothing waits in the claim folder.
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual(["adt"]);
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
    for (let index = 0; index < 2; index += 1) expect(await pass(source)).toEqual([]);
    expect(await readFile(join(dir, "x.hl7"), "utf8")).toBe("swapped");
  });

  it("keeps its held name when the unlink after the link fails, and says it went back", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "x.hl7"), "in");
    const { source, errors } = recursiveSource(dir);
    await swapFileBefore(dir);
    race.after = () => {
      race.fail = (what, path) => what === "unlink" && path.includes("refused-");
    };
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
    expect(await readFile(join(dir, "x.hl7"), "utf8")).toBe("swapped");
    expect(await heldIn(dir)).toEqual(["swapped"]);
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
    expect(await pass(source)).toEqual([]);
  });

  it("holds it when a file was put where it came from since", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "x.hl7"), "in");
    const { source, errors } = recursiveSource(dir);
    await swapFileBefore(dir);
    race.after = () => {
      writeFileSync(join(dir, "x.hl7"), "newer");
      // Backdated, as dropFile does: a time in this millisecond can read as later than the pass's.
      const past = new Date(Date.now() - 60_000);
      utimesSync(join(dir, "x.hl7"), past, past);
    };
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ERR_PATHWAYS_FILE_HELD" })]);
    expect(await heldIn(dir)).toEqual(["swapped"]);
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
    expect(await pass(source)).toEqual(["newer"]);
    expect(await heldIn(dir)).toEqual(["swapped"]);
  });

  it("leaves it in the claim folder when the move to its held name fails: never stored by this run", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "x.hl7"), "in");
    const { source, errors } = recursiveSource(dir);
    await swapFileBefore(dir);
    race.after = () => {
      race.fail = (what, path) => what === "rename" && path.includes("refused-");
    };
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ERR_PATHWAYS_FILE_HELD" })]);
    expect(await heldIn(dir)).toEqual([]);
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toHaveLength(1);
    expect(await pass(source)).toEqual([]);
    // A pass that cannot read the claim's id leaves it too, and still knows it after.
    race.fail = (what, path) => what === "lstat" && path.includes(claims);
    expect(await pass(source)).toEqual([]);
    expect(await pass(source)).toEqual([]);
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toHaveLength(1);
    // A later run knows nothing of the refusal, and stores what waits in the claim folder.
    expect(await pass(recursiveSource(dir).source)).toEqual(["swapped"]);
  });
});

describe("FileSource on a file system that changes a file's id when it moves", () => {
  it("claims nothing, moves nothing, and says why on each pass", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "a.hl7"), "in");
    const { source, errors } = recursiveSource(dir);
    race.unsteady = "ino";
    expect(await pass(source)).toEqual([]);
    expect(await pass(source)).toEqual([]);
    const said = expect.objectContaining({
      code: "ERR_PATHWAYS_FILE_ID_UNSTEADY",
      message: "this file system changes a file's id when it moves",
    }) as unknown;
    expect(errors).toEqual([said, said]);
    expect(await readFile(join(dir, "a.hl7"), "utf8")).toBe("in");
    // The check leaves nothing behind.
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual(["adt"]);
    expect(await readdir(join(dir, CLAIMED_DIR, "adt"))).toEqual([]);
  });

  it("says so by its device number too, and with no onReadError, still claims nothing", async () => {
    const dir = join(await makeProject({}), "inbox");
    await dropFile(join(dir, "a.hl7"), "in");
    race.unsteady = "dev";
    const { source, errors } = recursiveSource(dir);
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ERR_PATHWAYS_FILE_ID_UNSTEADY" })]);
    const quiet = new FileSource({ dir, channel: "adt", minAgeMs: 0 });
    expect(await pass(quiet)).toEqual([]);
    expect(await readFile(join(dir, "a.hl7"), "utf8")).toBe("in");
  });

  it("checks once, on the first pass with a file to claim, and leaves nothing behind", async () => {
    const dir = join(await makeProject({}), "inbox");
    const { source, errors } = recursiveSource(dir);
    // A pass with nothing to claim writes nothing: a check that would fail is never made.
    race.fail = (what, path) => what === "writeFile" && path.includes("probe-");
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([]);
    race.fail = undefined;
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual(["adt"]);
    await dropFile(join(dir, "a.hl7"), "in");
    expect(await pass(source)).toEqual(["in"]);
    expect(await readdir(join(dir, CLAIMED_DIR))).toEqual(["adt"]);
    // Not asked again: an id that changes now fails the check after the move instead, by its
    // device number as well as its inode number.
    race.unsteady = "dev";
    await dropFile(join(dir, "b.hl7"), "in too");
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
  });
});
