import { appendFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ChannelConfig } from "../src/config/schema.js";
import {
  CLAIMED_DIR,
  type FileFault,
  FileSource,
  type FileSourceOptions,
  PATTERN_TIME_PER_PASS_MS,
  PROCESSED_DIR,
  REGEX_TIME_LIMIT_MS,
} from "../src/connectors/file.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { connectorsFor } from "../src/engine/engine.js";
import { captureLogger, cleanUp, dropFile, makeProject, usePlatform } from "./helpers.js";

afterEach(cleanUp);
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * What a sink was handed, in order: each body as text, its idempotency key, the source facts the file
 * source passed and the body's size in bytes, which the engine adds to them as `size`.
 */
interface Received {
  readonly body: string;
  readonly key: string | undefined;
  readonly source: ReceiveOptions["source"];
  readonly size: number;
}

/** A sink that stores every message, numbering them from 1. */
function sinkOf(): { sink: MessageSink; received: Received[] } {
  const received: Received[] = [];
  const sink: MessageSink = {
    receive(body: Uint8Array, options: ReceiveOptions = {}) {
      received.push({
        body: new TextDecoder().decode(body),
        key: options.idempotencyKey,
        source: options.source,
        size: body.byteLength,
      });
      return Promise.resolve(received.length);
    },
  };
  return { sink, received };
}

/** The facts each file a pass takes carries: its name as the source passed it, and its size. */
async function factsOf(source: FileSource): Promise<{ source: unknown; size: number }[]> {
  const { sink, received } = sinkOf();
  await source.poll(sink);
  return received.map((r) => ({ source: r.source, size: r.size }));
}

async function inbox(): Promise<string> {
  return join(await makeProject({}), "inbox");
}

const channel = "adt";

/** A source on `dir` that takes a file at once, with `options`. */
function sourceOn(dir: string, options: Partial<FileSourceOptions> = {}): FileSource {
  return new FileSource({ dir, channel, minAgeMs: 0, ...options });
}

/** The bodies a pass hands in, in order. */
async function pass(source: FileSource): Promise<string[]> {
  const { sink, received } = sinkOf();
  await source.poll(sink);
  return received.map((r) => r.body);
}

/**
 * Runs every include and exclude pattern with no time limit, for a test that says what one pass
 * takes and is not about the limit. The limit is time on the clock, so a host that leaves the test's
 * thread waiting past it, as a busy Windows runner can, stops a harmless run, and the source leaves
 * that file for the next pass, as it means to: one pass takes one file fewer, for the host's sake.
 * The tests of the limit force their timeouts through node:vm below, and the two that run a pattern
 * built to run long keep the real limit.
 */
function patternsUntimed(): void {
  // The real method, called below on the script it was asked of, so `this` is bound there.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const run = Script.prototype.runInContext;
  vi.spyOn(Script.prototype, "runInContext").mockImplementation(function (
    this: Script,
    context,
    options,
  ): unknown {
    return run.call(this, context, { ...options, timeout: undefined });
  });
}

/** Every file under `dir`, by its path from it with `/`, sorted, `.claimed/` left out. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replaceAll("\\", "/"),
    )
    .filter((rel) => !rel.startsWith(`${CLAIMED_DIR}/`))
    .sort();
}

/** Backdates `path` by `seconds`, so files can be told apart by their modification time. */
async function age(path: string, seconds: number): Promise<void> {
  const when = new Date(Date.now() - seconds * 1_000);
  await utimes(path, when, when);
}

/** Is the test run as root, who can open any file whatever its mode? */
const root = process.getuid?.() === 0;

/** Is the test run on Windows itself, where no mode makes a file unreadable? */
const windows = process.platform === "win32";

// Each behavior holds on the file source's two paths: the one it takes on this platform, and the
// one it takes on Windows, which flushes each claimed file in place of the folders.
describe.each([
  ["on this platform", process.platform],
  ["on Windows", "win32"],
] as const)("FileSource options %s", (_, platform) => {
  beforeEach(() => usePlatform(platform));

  it("takes only files whose path matches include and none of exclude, by glob", async () => {
    patternsUntimed();
    const dir = await inbox();
    for (const name of ["a.hl7", "b.txt", "sub/c.hl7", "sub/deep/d.hl7", "sub/skip.hl7"]) {
      await dropFile(join(dir, name), name);
    }
    const source = sourceOn(dir, {
      recursive: true,
      include: [{ glob: "**/*.hl7" }],
      exclude: [{ glob: "sub/skip.*" }],
    });
    expect(await pass(source)).toEqual(["a.hl7", "sub/c.hl7", "sub/deep/d.hl7"]);
    expect(await tree(dir)).toEqual(["b.txt", "sub/skip.hl7"]);
  });

  it("matches a regex on the path with / on every platform, and needs only one include to match", async () => {
    patternsUntimed();
    const dir = await inbox();
    for (const name of ["ADT_1.hl7", "ADT_x.hl7", "in/ADT_2.hl7", "ORU_3.hl7", "keep.me"]) {
      await dropFile(join(dir, name), name);
    }
    const source = sourceOn(dir, {
      recursive: true,
      include: [{ regex: "^(in/)?ADT_\\d+\\.hl7$" }, { glob: "*.me" }],
      exclude: [{ regex: "^keep" }],
    });
    expect(await pass(source)).toEqual(["ADT_1.hl7", "in/ADT_2.hl7"]);
    expect(await tree(dir)).toEqual(["ADT_x.hl7", "ORU_3.hl7", "keep.me"]);
  });

  it("reads only dir itself unless recursive", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "top");
    await dropFile(join(dir, "sub", "b.hl7"), "below");
    expect(await pass(sourceOn(dir))).toEqual(["top"]);
    expect(await tree(dir)).toEqual(["sub/b.hl7"]);
  });

  it("keys and keeps two files of one name in different subfolders apart", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "x", "a.hl7"), "from x");
    await dropFile(join(dir, "y", "a.hl7"), "from y");
    await dropFile(join(dir, "100%.hl7"), "percent");
    const { sink, received } = sinkOf();
    await sourceOn(dir, { recursive: true, keepProcessed: true }).poll(sink);
    expect(received.map((r) => r.body)).toEqual(["percent", "from x", "from y"]);
    // Each key carries the file's path, written as one name, as its claim does.
    expect(received.map((r) => String(r.key).slice(39))).toEqual([
      "100%25.hl7",
      "x%2Fa.hl7",
      "y%2Fa.hl7",
    ]);
    // Each copy keeps its path under processed/, prefixed with its message id.
    expect(await tree(join(dir, PROCESSED_DIR))).toEqual(["1-100%.hl7", "x/2-a.hl7", "y/3-a.hl7"]);
    expect(await readFile(join(dir, PROCESSED_DIR, "y", "3-a.hl7"), "utf8")).toBe("from y");
  });

  it("never reads .claimed, processed or the error folder, even with dot files read", async () => {
    const dir = await inbox();
    const errorDir = join(dir, "errors");
    await dropFile(join(dir, PROCESSED_DIR, "1-old.hl7"), "kept");
    await dropFile(join(errorDir, "big.hl7"), "set aside");
    await dropFile(join(dir, CLAIMED_DIR, "other", "x.hl7"), "another channel's");
    await dropFile(join(dir, "sub", PROCESSED_DIR, "c.hl7"), "a folder of that name lower down");
    const source = sourceOn(dir, { recursive: true, ignoreDot: false, errorDir });
    expect(await pass(source)).toEqual(["a folder of that name lower down"]);
    expect(await tree(dir)).toEqual(["errors/big.hl7", "processed/1-old.hl7"]);
  });

  it("leaves dot files and dot folders unless ignoreDot is false", async () => {
    const dir = await inbox();
    await dropFile(join(dir, ".hidden.hl7"), "hidden");
    await dropFile(join(dir, ".dot", "a.hl7"), "in a dot folder");
    await dropFile(join(dir, "a.hl7"), "plain");
    expect(await pass(sourceOn(dir, { recursive: true }))).toEqual(["plain"]);
    expect(await pass(sourceOn(dir, { recursive: true, ignoreDot: false }))).toEqual([
      "in a dot folder",
      "hidden",
    ]);
  });

  it("leaves an empty file by default, and a file under minSize", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "empty.hl7"), "");
    await dropFile(join(dir, "one.hl7"), "1");
    await dropFile(join(dir, "three.hl7"), "333");
    expect(await pass(sourceOn(dir, { minSize: 2 }))).toEqual(["333"]);
    expect(await pass(sourceOn(dir))).toEqual(["1"]);
    expect(await pass(sourceOn(dir, { minSize: 0 }))).toEqual([""]);
  });

  it("leaves a file over maxSize where it is without errorDir, and says so", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "big.hl7"), "12345");
    await dropFile(join(dir, "fits.hl7"), "1234");
    const faults: FileFault[] = [];
    const source = sourceOn(dir, { maxSize: 4, onFileFault: (fault) => faults.push(fault) });
    expect(await pass(source)).toEqual(["1234"]);
    expect(faults).toEqual([{ reason: "too-large", moved: false }]);
    expect(await tree(dir)).toEqual(["big.hl7"]);
  });

  it("moves a file over maxSize into errorDir as it arrived, under its path", async () => {
    const dir = await inbox();
    const errorDir = join(await makeProject({}), "errors");
    await dropFile(join(dir, "sub", "big.hl7"), "12345");
    const faults: FileFault[] = [];
    const source = sourceOn(dir, {
      recursive: true,
      maxSize: 4,
      errorDir,
      onFileFault: (fault) => faults.push(fault),
    });
    expect(await pass(source)).toEqual([]);
    expect(faults).toEqual([{ reason: "too-large", moved: true }]);
    expect(await tree(dir)).toEqual([]);
    expect(await readFile(join(errorDir, "sub", "big.hl7"), "utf8")).toBe("12345");
  });

  it("holds a file that grew past maxSize since it was found to maxSize by the open file", async () => {
    const dir = await inbox();
    const errorDir = join(dir, "errors");
    await dropFile(join(dir, "a.hl7"), "12345");
    await dropFile(join(dir, "b.hl7"), "1234");
    const faults: FileFault[] = [];
    const source = sourceOn(dir, {
      maxSize: 4,
      errorDir,
      // a.hl7 is set aside before b.hl7 is opened: b.hl7 grows now, after the pass found it.
      onFileFault: (fault) => {
        faults.push(fault);
        if (faults.length === 1) appendFileSync(join(dir, "b.hl7"), "5");
      },
    });
    expect(await pass(source)).toEqual([]);
    expect(faults).toEqual([
      { reason: "too-large", moved: true },
      { reason: "too-large", moved: true },
    ]);
    expect(await tree(dir)).toEqual(["errors/a.hl7", "errors/b.hl7"]);
    expect(await readFile(join(errorDir, "b.hl7"), "utf8")).toBe("12345");
  });

  it("never moves a file over one already in errorDir, and says why", async () => {
    const dir = await inbox();
    const errorDir = join(dir, "errors");
    await dropFile(join(errorDir, "big.hl7"), "first");
    await dropFile(join(dir, "big.hl7"), "second");
    const faults: FileFault[] = [];
    const source = sourceOn(dir, { maxSize: 1, errorDir, onFileFault: (f) => faults.push(f) });
    expect(await pass(source)).toEqual([]);
    expect(faults).toEqual([
      {
        reason: "too-large",
        moved: false,
        error: expect.objectContaining({ code: "EEXIST" }) as unknown,
      },
    ]);
    expect(await readFile(join(errorDir, "big.hl7"), "utf8")).toBe("first");
    expect(await readFile(join(dir, "big.hl7"), "utf8")).toBe("second");
  });

  it("leaves a file a regex runs too long on, says so, and sets it aside after three passes", async () => {
    const dir = await inbox();
    // A name built to make ^(a+)+$ backtrack: unguarded, one test of it takes many seconds.
    const name = `${"a".repeat(30)}!`;
    await dropFile(join(dir, name), "slow");
    await dropFile(join(dir, "aaa"), "fast");
    const errors: unknown[] = [];
    const source = sourceOn(dir, {
      include: [{ regex: "^(a+)+$" }],
      onReadError: (error) => errors.push(error),
    });
    expect(await pass(source)).toEqual(["fast"]);
    expect(errors).toHaveLength(1);
    // Tried on three passes in a row, each stopped and said; the fourth pass passes it over. Each
    // pass is judged by what it said, never by the clock: a pass also reads the folder, which a
    // busy Windows runner can make slow.
    for (const said of [2, 3, 3]) {
      expect(await pass(source)).toEqual([]);
      expect(errors).toHaveLength(said);
    }
    expect(errors).toEqual(
      Array.from(
        { length: 3 },
        (): unknown => expect.objectContaining({ code: "ERR_SCRIPT_EXECUTION_TIMEOUT" }) as unknown,
      ),
    );
    expect(await tree(dir)).toEqual([name]);
    // An exclude that runs too long leaves the file too, never takes it.
    const excluded: unknown[] = [];
    const other = sourceOn(dir, {
      exclude: [{ regex: "^(a+)+$" }],
      onReadError: (error) => excluded.push(error),
    });
    expect(await pass(other)).toEqual([]);
    expect(excluded).toHaveLength(1);
    expect(await tree(dir)).toEqual([name]);
  });

  it("leaves a file a glob runs too long on, says so, and sets it aside after three passes", async () => {
    const dir = await inbox();
    // A name built to make a glob of several * in one segment backtrack: unguarded, one test of
    // it takes seconds, and longer names take minutes.
    const glob = "*_*_*_*_*.hl7";
    const name = "_".repeat(200);
    await dropFile(join(dir, name), "slow");
    await dropFile(join(dir, "FAC_ADT_A01_20261111_0001.hl7"), "fast");
    const errors: unknown[] = [];
    const source = sourceOn(dir, { include: [{ glob }], onReadError: (e) => errors.push(e) });
    expect(await pass(source)).toEqual(["fast"]);
    expect(errors).toHaveLength(1);
    // Tried on three passes in a row, each stopped and said; the fourth pass passes it over. Each
    // pass is judged by what it said, never by the clock: a pass also reads the folder, which a
    // busy Windows runner can make slow.
    for (const said of [2, 3, 3]) {
      expect(await pass(source)).toEqual([]);
      expect(errors).toHaveLength(said);
    }
    expect(errors).toEqual(
      Array.from(
        { length: 3 },
        (): unknown => expect.objectContaining({ code: "ERR_SCRIPT_EXECUTION_TIMEOUT" }) as unknown,
      ),
    );
    expect(await tree(dir)).toEqual([name]);
    // An exclude glob that runs too long leaves the file too, never takes it.
    const excluded: unknown[] = [];
    const other = sourceOn(dir, { exclude: [{ glob }], onReadError: (e) => excluded.push(e) });
    expect(await pass(other)).toEqual([]);
    expect(excluded).toEqual([expect.objectContaining({ code: "ERR_SCRIPT_EXECUTION_TIMEOUT" })]);
    expect(await tree(dir)).toEqual([name]);
  });

  it("never moves a file into errorDir once it is gone from where the pass found it", async () => {
    const dir = await inbox();
    const errorDir = join(dir, "errors");
    await dropFile(join(dir, "a.hl7"), "12345");
    await dropFile(join(dir, "b.hl7"), "12345");
    const faults: FileFault[] = [];
    const source = sourceOn(dir, {
      maxSize: 4,
      errorDir,
      // b.hl7 goes after the pass found it and before it is set aside.
      onFileFault: (fault) => {
        faults.push(fault);
        if (faults.length === 1) unlinkSync(join(dir, "b.hl7"));
      },
    });
    expect(await pass(source)).toEqual([]);
    expect(faults).toEqual([
      { reason: "too-large", moved: true },
      {
        reason: "too-large",
        moved: false,
        error: expect.objectContaining({ code: "ESTALE" }) as unknown,
      },
    ]);
    expect(await tree(dir)).toEqual(["errors/a.hl7"]);
  });

  it("sets aside a file that cannot be opened only while it is still where the pass found it", async () => {
    const dir = await inbox();
    const errorDir = join(dir, "errors");
    await dropFile(join(dir, "a.hl7"), "12345");
    await dropFile(join(dir, "b.hl7"), "1");
    const faults: FileFault[] = [];
    const errors: unknown[] = [];
    const source = sourceOn(dir, {
      maxSize: 4,
      errorDir,
      readTries: 1,
      onReadError: (error) => errors.push(error),
      // b.hl7 goes after the pass found it, so it cannot be opened, and is gone when it is set aside.
      onFileFault: (fault) => {
        faults.push(fault);
        if (faults.length === 1) unlinkSync(join(dir, "b.hl7"));
      },
    });
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ENOENT" })]);
    expect(faults).toEqual([
      { reason: "too-large", moved: true },
      {
        reason: "unreadable",
        moved: false,
        error: expect.objectContaining({ code: "ESTALE" }) as unknown,
      },
    ]);
    expect(await tree(dir)).toEqual(["errors/a.hl7"]);
  });

  it("claims at most maxPerPoll files a pass, and the rest on the next", async () => {
    const dir = await inbox();
    for (const name of ["a.hl7", "b.hl7", "c.hl7"]) await dropFile(join(dir, name), name);
    const source = sourceOn(dir, { maxPerPoll: 2 });
    expect(await pass(source)).toEqual(["a.hl7", "b.hl7"]);
    expect(await pass(source)).toEqual(["c.hl7"]);
  });

  it("takes files least recently modified first with sortBy: mtime, by name when two tie", async () => {
    const dir = await inbox();
    for (const [name, seconds] of [
      ["a.hl7", 10],
      ["b.hl7", 30],
      ["c.hl7", 20],
      ["d.hl7", 30],
    ] as const) {
      await dropFile(join(dir, name), name);
      await age(join(dir, name), seconds);
    }
    expect(await pass(sourceOn(dir, { sortBy: "mtime" }))).toEqual([
      "b.hl7",
      "d.hl7",
      "c.hl7",
      "a.hl7",
    ]);
  });

  it("takes a file only once two passes in a row find it unchanged, with stable", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "a");
    await dropFile(join(dir, "b.hl7"), "b");
    const source = sourceOn(dir, { stable: true });
    // The first pass has nothing to compare with.
    expect(await pass(source)).toEqual([]);
    await appendFile(join(dir, "b.hl7"), "b");
    await age(join(dir, "b.hl7"), 60);
    expect(await pass(source)).toEqual(["a"]);
    expect(await pass(source)).toEqual(["bb"]);
  });

  it("waits for each file's marker with doneFile, and deletes the marker once it is claimed", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "marked");
    await dropFile(join(dir, "a.hl7.done"), "");
    await dropFile(join(dir, "b.hl7"), "unmarked");
    await dropFile(join(dir, "sub", "c.hl7"), "marked below");
    await dropFile(join(dir, "sub", "c.hl7.done"), "");
    await dropFile(join(dir, "orphan.hl7.done"), "");
    const source = sourceOn(dir, { recursive: true, doneFile: ".done" });
    expect(await pass(source)).toEqual(["marked", "marked below"]);
    expect(await tree(dir)).toEqual(["b.hl7", "orphan.hl7.done"]);
  });

  // Skipped as root, who can read any file, and on Windows, where no mode makes a file unreadable.
  it.skipIf(root || windows)(
    "moves a file that fails to open readTries passes in a row into errorDir, never sooner",
    async () => {
      const dir = await inbox();
      const errorDir = join(dir, "errors");
      await dropFile(join(dir, "a.hl7"), "unreadable");
      await dropFile(join(dir, "b.hl7"), "unreadable once");
      await chmod(join(dir, "a.hl7"), 0o000);
      await chmod(join(dir, "b.hl7"), 0o000);
      const faults: FileFault[] = [];
      const errors: unknown[] = [];
      const source = sourceOn(dir, {
        errorDir,
        readTries: 2,
        onFileFault: (fault) => faults.push(fault),
        onReadError: (error) => errors.push(error),
      });
      expect(await pass(source)).toEqual([]);
      expect(faults).toEqual([]);
      // b.hl7 opens on the second pass, so its count starts again; a.hl7 fails a second time.
      await chmod(join(dir, "b.hl7"), 0o644);
      expect(await pass(source)).toEqual(["unreadable once"]);
      expect(faults).toEqual([{ reason: "unreadable", moved: true }]);
      expect(errors).toHaveLength(3);
      await chmod(join(errorDir, "a.hl7"), 0o644);
      expect(await tree(dir)).toEqual(["errors/a.hl7"]);
    },
  );

  // Skipped as root, who can read any file, and on Windows, where no mode makes a file unreadable.
  it.skipIf(root || windows)(
    "keeps trying a file that fails to open when there is no errorDir",
    async () => {
      const dir = await inbox();
      await dropFile(join(dir, "a.hl7"), "unreadable");
      await chmod(join(dir, "a.hl7"), 0o000);
      const faults: FileFault[] = [];
      const source = sourceOn(dir, { readTries: 1, onFileFault: (fault) => faults.push(fault) });
      expect(await pass(source)).toEqual([]);
      expect(await pass(source)).toEqual([]);
      expect(faults).toEqual([]);
      await chmod(join(dir, "a.hl7"), 0o644);
      expect(await pass(source)).toEqual(["unreadable"]);
    },
  );

  // Skipped as root, who can read any folder, and on Windows, where no mode makes one unreadable.
  it.skipIf(root || windows)(
    "says so of a subfolder it cannot read, and reads the rest",
    async () => {
      const dir = await inbox();
      await dropFile(join(dir, "locked", "a.hl7"), "locked away");
      await dropFile(join(dir, "open", "b.hl7"), "open");
      await chmod(join(dir, "locked"), 0o000);
      const errors: unknown[] = [];
      const source = sourceOn(dir, { recursive: true, onReadError: (e) => errors.push(e) });
      try {
        expect(await pass(source)).toEqual(["open"]);
      } finally {
        await chmod(join(dir, "locked"), 0o755);
      }
      expect((errors as { code?: unknown }[]).map((e) => e.code)).toEqual(["EACCES"]);
      // With no onReadError, the failure is passed over quietly.
      await chmod(join(dir, "locked"), 0o000);
      try {
        expect(await pass(sourceOn(dir, { recursive: true }))).toEqual([]);
      } finally {
        await chmod(join(dir, "locked"), 0o755);
      }
    },
  );

  it("passes each file it takes its path from dir and its size, through each option that takes one", async () => {
    patternsUntimed();
    const dir = await inbox();
    const errors: unknown[] = [];
    for (const [name, body] of [
      ["a.hl7", "1"],
      ["sub/b.hl7", "22"],
      ["sub/deep/c.hl7", "333"],
      [".dot/d.hl7", "4444"],
      ["x/100%.hl7", "55555"],
      ["x/a%2Fb.hl7", "666666"],
      ["skip/e.hl7", "7"],
      ["f.txt", "8"],
    ] as const) {
      await dropFile(join(dir, name), body);
    }
    const source = sourceOn(dir, {
      recursive: true,
      ignoreDot: false,
      include: [{ glob: "**/*.hl7" }, { regex: "^\\.dot/" }],
      exclude: [{ glob: "skip/**" }],
      minSize: 1,
      maxSize: 6,
      keepProcessed: true,
      onReadError: (error) => errors.push(error),
    });
    const facts = await factsOf(source);
    // First, so a file a pass left for a reason of the host's fails with that reason's code.
    expect(errors).toEqual([]);
    expect(facts).toEqual([
      { source: { name: ".dot/d.hl7" }, size: 4 },
      { source: { name: "a.hl7" }, size: 1 },
      { source: { name: "sub/b.hl7" }, size: 2 },
      { source: { name: "sub/deep/c.hl7" }, size: 3 },
      { source: { name: "x/100%.hl7" }, size: 5 },
      { source: { name: "x/a%2Fb.hl7" }, size: 6 },
    ]);
    // Without recursion a name is the file's own, as before.
    const flat = await inbox();
    await dropFile(join(flat, "100%.hl7"), "flat");
    expect(await factsOf(sourceOn(flat))).toEqual([{ source: { name: "100%.hl7" }, size: 4 }]);
  });

  it("passes the same facts through stable, doneFile, maxPerPoll and sortBy: mtime", async () => {
    const dir = await inbox();
    for (const [name, seconds] of [
      ["sub/a.hl7", 10],
      ["sub/b.hl7", 30],
      ["c.hl7", 20],
    ] as const) {
      await dropFile(join(dir, name), name);
      await dropFile(join(dir, `${name}.done`), "");
      await age(join(dir, name), seconds);
    }
    const source = sourceOn(dir, {
      recursive: true,
      stable: true,
      doneFile: ".done",
      maxPerPoll: 2,
      sortBy: "mtime",
    });
    // The first pass has nothing to compare with.
    expect(await factsOf(source)).toEqual([]);
    expect(await factsOf(source)).toEqual([
      { source: { name: "sub/b.hl7" }, size: 9 },
      { source: { name: "c.hl7" }, size: 5 },
    ]);
    expect(await factsOf(source)).toEqual([{ source: { name: "sub/a.hl7" }, size: 9 }]);
  });

  it("hands in nothing, so no facts, for a file it sets aside or leaves", async () => {
    patternsUntimed();
    const dir = await inbox();
    const errorDir = join(dir, "errors");
    await dropFile(join(dir, "a", "big.hl7"), "12345");
    await dropFile(join(dir, "empty.hl7"), "");
    await dropFile(join(dir, "fits.hl7"), "1");
    await dropFile(join(dir, "grows.hl7"), "1234");
    await dropFile(join(dir, "skip", "x.hl7"), "x");
    const faults: FileFault[] = [];
    const options: Partial<FileSourceOptions> = {
      recursive: true,
      maxSize: 4,
      exclude: [{ glob: "skip/**" }],
      onFileFault: (fault) => {
        faults.push(fault);
        // grows.hl7 grows past maxSize after the pass found it, and is held to it by the open file.
        if (faults.length === 1) appendFileSync(join(dir, "grows.hl7"), "5");
      },
    };
    // Without errorDir the large files are left; only fits.hl7 is taken.
    expect(await factsOf(sourceOn(dir, options))).toEqual([
      { source: { name: "fits.hl7" }, size: 1 },
    ]);
    expect(faults).toEqual([
      { reason: "too-large", moved: false },
      { reason: "too-large", moved: false },
    ]);
    faults.length = 0;
    await dropFile(join(dir, "grows.hl7"), "1234");
    // With errorDir they are set aside, and nothing is handed in.
    expect(await factsOf(sourceOn(dir, { ...options, errorDir }))).toEqual([]);
    expect(faults).toEqual([
      { reason: "too-large", moved: true },
      { reason: "too-large", moved: true },
    ]);
    expect(await tree(dir)).toEqual([
      "empty.hl7",
      "errors/a/big.hl7",
      "errors/grows.hl7",
      "skip/x.hl7",
    ]);
    // A file with no marker yet, or seen once by a stable source, is left too.
    await dropFile(join(dir, "waiting.hl7"), "w");
    expect(await factsOf(sourceOn(dir, { doneFile: ".ok" }))).toEqual([]);
    expect(await factsOf(sourceOn(dir, { stable: true }))).toEqual([]);
    expect(await tree(dir)).toContain("waiting.hl7");
  });

  it("passes a claim's path from dir as its name when it resumes one, and a flat one as it is", async () => {
    const dir = await inbox();
    const claims = join(dir, CLAIMED_DIR, channel);
    await mkdir(claims, { recursive: true });
    await dropFile(join(claims, "000001700000001.00000000.0000000a-sub%2F100%25.hl7"), "nested");
    await dropFile(join(claims, "000001700000001.00000001.0000000a-..%2Fout.hl7"), "climber");
    expect(await factsOf(sourceOn(dir))).toEqual([
      { source: { name: "sub/100%.hl7" }, size: 6 },
      { source: { name: "..%2Fout.hl7" }, size: 7 },
    ]);
  });

  it("keeps a hand-made claim whose path would leave processed/ flat, under its own name", async () => {
    const dir = await inbox();
    const claims = join(dir, CLAIMED_DIR, channel);
    await mkdir(claims, { recursive: true });
    await dropFile(join(claims, "000001700000001.00000000.0000000a-..%2Fout.hl7"), "climber");
    await dropFile(join(claims, "000001700000001.00000001.0000000a-x%2F.%2Fy.hl7"), "dot");
    await dropFile(join(claims, "000001700000001.00000002.0000000a-x%2F"), "empty");
    expect(await pass(sourceOn(dir, { keepProcessed: true }))).toEqual(["climber", "dot", "empty"]);
    expect(await tree(join(dir, PROCESSED_DIR))).toEqual([
      "1-..%2Fout.hl7",
      "2-x%2F.%2Fy.hl7",
      "3-x%2F",
    ]);
  });
});

/** The error node:vm throws when a script runs past its timeout. */
function timedOut(): Error {
  return Object.assign(new Error("Script execution timed out after 50ms"), {
    code: "ERR_SCRIPT_EXECUTION_TIMEOUT",
  });
}

// The limit is time on the clock, so a pause of the host can stop a harmless run: these force a
// timeout through node:vm, where a real one could come from a busy runner at any moment.
describe("FileSource and a pattern run that times out", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes the file on the next pass after one run of its pattern timed out", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "ADT_1.hl7"), "first");
    const errors: unknown[] = [];
    const source = sourceOn(dir, {
      include: [{ regex: "^ADT_\\d+\\.hl7$" }],
      onReadError: (error) => errors.push(error),
    });
    vi.spyOn(Script.prototype, "runInContext").mockImplementationOnce(() => {
      throw timedOut();
    });
    expect(await pass(source)).toEqual([]);
    expect(await tree(dir)).toEqual(["ADT_1.hl7"]);
    expect(await pass(source)).toEqual(["first"]);
    expect(errors).toEqual([expect.objectContaining({ code: "ERR_SCRIPT_EXECUTION_TIMEOUT" })]);
  });

  it("tries a path again on each pass until three runs in a row time out, and keeps a match", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "body");
    const errors: unknown[] = [];
    const source = sourceOn(dir, {
      include: [{ glob: "*.hl7" }],
      onReadError: (error) => errors.push(error),
    });
    const run = vi.spyOn(Script.prototype, "runInContext");
    run.mockImplementationOnce(() => {
      throw timedOut();
    });
    run.mockImplementationOnce(() => {
      throw timedOut();
    });
    expect(await pass(source)).toEqual([]);
    expect(await pass(source)).toEqual([]);
    expect(await pass(source)).toEqual(["body"]);
    expect(errors).toHaveLength(2);
    // A match is kept while a pass finds the path, so a file dropped at it again is taken with no
    // run, and the timeouts before the match count for nothing.
    await dropFile(join(dir, "a.hl7"), "again");
    const runs = run.mock.calls.length;
    expect(await pass(source)).toEqual(["again"]);
    expect(run).toHaveBeenCalledTimes(runs);
    expect(errors).toHaveLength(2);
  });

  it("sets a path aside after three timeouts in a row, then tries it at doubling waits up to 64 passes, saying each timeout", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "body");
    const said: number[] = [];
    let passes = 0;
    const source = sourceOn(dir, {
      include: [{ glob: "*.hl7" }],
      exclude: [{ glob: "*.txt" }],
      onReadError: () => said.push(passes),
    });
    const run = vi.spyOn(Script.prototype, "runInContext").mockImplementation(() => {
      throw timedOut();
    });
    for (passes = 1; passes <= 210; passes += 1) expect(await pass(source)).toEqual([]);
    // Passes 1 to 3 try it; then it waits 1, 2, 4, 8, 16, 32 and 64 passes, and 64 again.
    expect(said).toEqual([1, 2, 3, 5, 8, 13, 22, 39, 72, 137, 202]);
    // A pass it waits runs no pattern on it at all.
    expect(run).toHaveBeenCalledTimes(said.length);
    // Once a run matches, the file is taken at its next try, and forgotten.
    run.mockRestore();
    for (passes = 211; passes < 267; passes += 1) expect(await pass(source)).toEqual([]);
    expect(await pass(source)).toEqual(["body"]);
    expect(said).toHaveLength(11);
  });

  it("forgets a set-aside path once its file is gone", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "a.hl7"), "first");
    const source = sourceOn(dir, { include: [{ glob: "*.hl7" }] });
    const run = vi.spyOn(Script.prototype, "runInContext").mockImplementation(() => {
      throw timedOut();
    });
    for (let index = 0; index < 3; index += 1) expect(await pass(source)).toEqual([]);
    unlinkSync(join(dir, "a.hl7"));
    expect(await pass(source)).toEqual([]);
    run.mockRestore();
    await dropFile(join(dir, "a.hl7"), "second");
    expect(await pass(source)).toEqual(["second"]);
  });

  it("runs each pattern once when the source is built, so the first real run is not a cold one", () => {
    const run = vi.spyOn(Script.prototype, "runInContext").mockImplementation(() => {
      throw timedOut();
    });
    // A warm run that times out is no fault of any file, and is not said.
    const errors: unknown[] = [];
    sourceOn("unused", {
      include: [{ glob: "*.hl7" }, { regex: "^ADT" }],
      exclude: [{ glob: "*.tmp" }],
      onReadError: (error) => errors.push(error),
    });
    expect(run).toHaveBeenCalledTimes(3);
    expect(errors).toEqual([]);
  });

  it("runs the patterns on a path once while its file is there, not on every pass", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "draft.tmp"), "left");
    const source = sourceOn(dir, { exclude: [{ glob: "*.tmp" }] });
    const run = vi.spyOn(Script.prototype, "runInContext");
    for (let index = 0; index < 3; index += 1) expect(await pass(source)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    // Once the file is gone the result is forgotten, and a file of that name is judged again.
    unlinkSync(join(dir, "draft.tmp"));
    expect(await pass(source)).toEqual([]);
    await dropFile(join(dir, "draft.tmp"), "left again");
    expect(await pass(source)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps the count of a path the pass had no time for, so it is set aside after three timeouts all the same", async () => {
    const dir = await inbox();
    for (let index = 0; index < 7; index += 1)
      await dropFile(join(dir, `slow-${index}.hl7`), "slow");
    const said: number[] = [];
    let passes = 0;
    const source = sourceOn(dir, {
      include: [{ glob: "*.hl7" }],
      onReadError: () => said.push(passes),
    });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(Script.prototype, "runInContext").mockImplementation(() => {
      clock += 100;
      throw timedOut();
    });
    for (passes = 1; passes <= 12; passes += 1) expect(await pass(source)).toEqual([]);
    // Five runs a pass at most. Each path times out three times in a row, whichever passes it waits
    // through for want of time, then waits 1 pass, then 2: the same counts whatever the walk's order.
    const perPass = Array.from({ length: 12 }, (_, at) => said.filter((p) => p === at + 1).length);
    expect(perPass).toEqual([5, 5, 5, 4, 5, 2, 2, 3, 2, 2, 0, 0]);
  });

  it("spends at most the pass's time on pattern runs, and runs the paths that waited longest first", async () => {
    const dir = await inbox();
    for (let index = 0; index < 20; index += 1) {
      await dropFile(join(dir, `slow-${String(index).padStart(2, "0")}.hl7`), "slow");
    }
    const said: number[] = [];
    let passes = 0;
    const source = sourceOn(dir, {
      include: [{ glob: "*.hl7" }],
      onReadError: () => said.push(passes),
    });
    // Each run on a slow name takes 100 ms on this clock and times out; any other is free, and
    // matches, as *.hl7 matches late.hl7.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(Script.prototype, "runInContext").mockImplementation((context) => {
      if (!String(context["path"]).startsWith("slow-")) return true;
      clock += 100;
      throw timedOut();
    });
    passes = 1;
    expect(await pass(source)).toEqual([]);
    // A file dropped after the slow names waits behind the 15 that were never run.
    await dropFile(join(dir, "late.hl7"), "late");
    const taken: number[] = [];
    for (passes = 2; passes <= 8; passes += 1) {
      if ((await pass(source)).includes("late")) taken.push(passes);
    }
    // 500 ms a pass is five runs of 100 ms: never more in one pass.
    const perPass = new Map<number, number>();
    for (const at of said) perPass.set(at, (perPass.get(at) ?? 0) + 1);
    expect(Math.max(...perPass.values())).toBe(PATTERN_TIME_PER_PASS_MS / 100);
    // The 15 that waited from the first pass go first, five a pass; then the line of the second
    // pass, the late file and the five that timed out on the first, in the order the walk found
    // them, so the late file is taken on the fifth pass or the sixth.
    expect(taken).toHaveLength(1);
    expect(taken[0]).toBeGreaterThanOrEqual(5);
    expect(taken[0]).toBeLessThanOrEqual(6);
  });
});

describe("FileSource and many names a pattern runs too long on", () => {
  it("stops running patterns for a pass once the pass has spent its time, and takes the others later", async () => {
    const dir = await inbox();
    // Names built to make ^(a+)+$ backtrack: unguarded, each test of one takes many seconds.
    for (let index = 0; index < 16; index += 1) {
      await dropFile(join(dir, `${"a".repeat(28 + index)}!`), "slow");
    }
    await dropFile(join(dir, "aaa"), "fast");
    const said: number[] = [];
    let passes = 0;
    const source = sourceOn(dir, {
      include: [{ regex: "^(a+)+$" }],
      onReadError: () => said.push(passes),
    });
    const bodies: string[] = [];
    for (passes = 1; passes <= 4; passes += 1) bodies.push(...(await pass(source)));
    expect(bodies).toEqual(["fast"]);
    // Each timed-out run takes at least the limit, so a pass holds at most this many, and one more
    // that started just before the pass's time ran out.
    const most = PATTERN_TIME_PER_PASS_MS / REGEX_TIME_LIMIT_MS + 1;
    for (let at = 1; at <= 4; at += 1) {
      expect(said.filter((value) => value === at).length).toBeLessThanOrEqual(most);
    }
    expect(said.length).toBeGreaterThanOrEqual(16);
  });
});

// Symbolic links need a privilege on Windows that CI's runner does not grant to every process.
describe.skipIf(windows)("FileSource and symbolic links", () => {
  it("never follows a link to a file or to a folder", async () => {
    const dir = await inbox();
    const outside = await makeProject({ "secret.hl7": "outside", "folder/b.hl7": "outside too" });
    await dropFile(join(dir, "a.hl7"), "inside");
    await symlink(join(outside, "secret.hl7"), join(dir, "link.hl7"));
    await symlink(join(outside, "folder"), join(dir, "linked-folder"), "dir");
    expect(await pass(sourceOn(dir, { recursive: true, ignoreDot: false }))).toEqual(["inside"]);
    expect((await readdir(dir)).sort()).toEqual([CLAIMED_DIR, "link.hl7", "linked-folder"]);
    expect(await readFile(join(outside, "secret.hl7"), "utf8")).toBe("outside");
  });
});

// The link is a junction on Windows, which needs no privilege, so this runs there too; elsewhere a
// symbolic link to the folder.
describe("FileSource and a link to a folder", () => {
  it("never follows it, on every system", async () => {
    const dir = await inbox();
    const outside = await makeProject({ "folder/b.hl7": "outside" });
    await dropFile(join(dir, "a.hl7"), "inside");
    await symlink(join(outside, "folder"), join(dir, "linked-folder"), "junction");
    expect(await pass(sourceOn(dir, { recursive: true }))).toEqual(["inside"]);
    expect((await readdir(dir)).sort()).toEqual([CLAIMED_DIR, "linked-folder"]);
    expect(await readFile(join(outside, "folder", "b.hl7"), "utf8")).toBe("outside");
  });
});

// A folder link here is a junction on Windows, which needs no privilege; elsewhere a symbolic link.
describe("FileSource and a folder swapped for a link", () => {
  /**
   * A source on `dir` whose first file, `a.hl7`, is too large: once it is set aside, after the pass
   * found every file, the subfolder `sub` is swapped for a link to `outside`.
   */
  function swapping(dir: string, outside: string, options: Partial<FileSourceOptions> = {}) {
    const faults: FileFault[] = [];
    const errors: unknown[] = [];
    const source = sourceOn(dir, {
      recursive: true,
      maxSize: 4,
      onReadError: (error) => errors.push(error),
      onFileFault: (fault) => {
        faults.push(fault);
        if (faults.length > 1) return;
        renameSync(join(dir, "sub"), join(dir, "was-sub"));
        symlinkSync(outside, join(dir, "sub"), "junction");
      },
      ...options,
    });
    return { source, faults, errors };
  }

  it("never claims a file through a folder swapped for a link after the pass found it", async () => {
    const dir = await inbox();
    const outside = await makeProject({ "x.hl7": "outside" });
    await dropFile(join(dir, "a.hl7"), "12345");
    await dropFile(join(dir, "sub", "x.hl7"), "in");
    const { source, errors } = swapping(dir, outside);
    expect(await pass(source)).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ESTALE" })]);
    expect(await readFile(join(outside, "x.hl7"), "utf8")).toBe("outside");
    expect(await readFile(join(dir, "was-sub", "x.hl7"), "utf8")).toBe("in");
  });

  it("never sets a file aside through a folder swapped for a link after the pass found it", async () => {
    const dir = await inbox();
    const errorDir = join(await makeProject({}), "errors");
    const outside = await makeProject({ "x.hl7": "outside!" });
    await dropFile(join(dir, "a.hl7"), "12345");
    await dropFile(join(dir, "sub", "x.hl7"), "in big");
    const { source, faults } = swapping(dir, outside, { errorDir });
    expect(await pass(source)).toEqual([]);
    expect(faults).toEqual([
      { reason: "too-large", moved: true },
      {
        reason: "too-large",
        moved: false,
        error: expect.objectContaining({ code: "ESTALE" }) as unknown,
      },
    ]);
    expect(await readFile(join(outside, "x.hl7"), "utf8")).toBe("outside!");
    expect(await tree(errorDir)).toEqual(["a.hl7"]);
  });

  it("never deletes a marker through a folder swapped for a link after its file was claimed", async () => {
    const dir = await inbox();
    const outside = await makeProject({ "m.hl7.done": "" });
    await dropFile(join(dir, "sub", "m.hl7"), "in");
    await dropFile(join(dir, "sub", "m.hl7.done"), "");
    // sub/m.hl7 is claimed first, by path; then z.hl7 is set aside and sub swapped, before the
    // markers go.
    await dropFile(join(dir, "z.hl7"), "12345");
    await dropFile(join(dir, "z.hl7.done"), "");
    const faults: FileFault[] = [];
    const source = sourceOn(dir, {
      recursive: true,
      maxSize: 4,
      doneFile: ".done",
      onFileFault: (fault) => {
        faults.push(fault);
        renameSync(join(dir, "sub"), join(dir, "was-sub"));
        symlinkSync(outside, join(dir, "sub"), "junction");
      },
    });
    expect(await pass(source)).toEqual(["in"]);
    expect(faults).toHaveLength(1);
    expect((await readdir(outside)).sort()).toEqual(["m.hl7.done"]);
  });

  it("never reads errorDir when it is reached through a link into dir", async () => {
    const dir = await inbox();
    await dropFile(join(dir, "held", "x.hl7"), "set aside before");
    await dropFile(join(dir, "a.hl7"), "new");
    const errorDir = join(await makeProject({}), "errors");
    await symlink(join(dir, "held"), errorDir, "junction");
    expect(await pass(sourceOn(dir, { recursive: true, errorDir }))).toEqual(["new"]);
    expect(await tree(dir)).toEqual(["held/x.hl7"]);
  });
});

describe("a file source built from channel.yaml", () => {
  it("reads each of its options from the environment, as every setting can be", async () => {
    const root = await makeProject({
      "channels/adt/channel.yaml": [
        "source:",
        "  file:",
        "    dir: in",
        "    include: [{ env: GLOB }, { regex: { env: REGEX } }]",
        "    recursive: { env: RECURSIVE }",
        "    ignoreDot: { env: IGNORE_DOT }",
        "    minSize: { env: MIN_SIZE }",
        "    maxSize: { env: MAX_SIZE }",
        "    maxPerPoll: { env: MAX_PER_POLL }",
        "    sortBy: { env: SORT_BY }",
        "    stable: { env: STABLE }",
        "    doneFile: { env: DONE_FILE }",
        "    errorDir: { env: ERROR_DIR }",
        "    readTries: { env: READ_TRIES, default: 5 }",
        "destinations:",
        "  - file: { dir: out }",
        "",
      ].join("\n"),
    });
    const env = {
      GLOB: "**/*.hl7",
      REGEX: "^ADT_",
      RECURSIVE: "true",
      IGNORE_DOT: "false",
      MIN_SIZE: "0",
      MAX_SIZE: "2KB",
      MAX_PER_POLL: "7",
      SORT_BY: "mtime",
      STABLE: "true",
      DONE_FILE: ".done",
      ERROR_DIR: "errors",
    };
    const [config] = (await loadProject(root, { env })).channels;
    expect(config?.source).toMatchObject({
      kind: "file",
      include: [{ glob: "**/*.hl7" }, { regex: "^ADT_" }],
      recursive: true,
      ignoreDot: false,
      minSize: 0,
      maxSize: 2_048,
      maxPerPoll: 7,
      sortBy: "mtime",
      stable: true,
      doneFile: ".done",
      errorDir: join(root, "channels", "adt", "errors"),
      readTries: 5,
    });
  });

  it("takes the options the channel names, and logs a file set aside without naming it", async () => {
    patternsUntimed();
    const root = await makeProject({
      "channels/adt/channel.yaml": [
        "source:",
        "  file:",
        "    dir: in",
        "    minAge: 0",
        "    recursive: true",
        "    include: ['**/*.hl7', { regex: '^x' }]",
        "    exclude: ['skip/**']",
        "    maxSize: 4B",
        "    minSize: 0",
        "    errorDir: errors",
        "destinations:",
        "  - file: { dir: out }",
        "",
      ].join("\n"),
    });
    const dir = join(root, "channels", "adt", "in");
    await dropFile(join(dir, "sub", "TESTPATIENT.hl7"), "12345");
    await dropFile(join(dir, "sub", "a.hl7"), "");
    await dropFile(join(dir, "skip", "b.hl7"), "1");
    await dropFile(join(dir, "c.txt"), "1");
    const [config] = (await loadProject(root)).channels;
    const { logger, events } = captureLogger();
    const { source } = await connectorsFor(config as ChannelConfig, {
      now: Date.now,
      logger,
      env: {},
    });
    const { sink, received } = sinkOf();
    await (source as FileSource).poll(sink);
    expect(received.map((r) => r.body)).toEqual([""]);
    expect(await tree(dir)).toEqual(["c.txt", "skip/b.hl7"]);
    const errors = join(root, "channels", "adt", "errors");
    expect(await readFile(join(errors, "sub", "TESTPATIENT.hl7"), "utf8")).toBe("12345");
    const warning = events.find((e) => e.event === "source-file-set-aside");
    expect(warning).toMatchObject({ channel: "adt", reason: "too-large", moved: true });
    expect(JSON.stringify(events)).not.toContain("TESTPATIENT");
  });
});
