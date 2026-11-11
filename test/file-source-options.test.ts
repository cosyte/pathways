import { appendFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProject } from "../src/config/load.js";
import type { ChannelConfig } from "../src/config/schema.js";
import {
  CLAIMED_DIR,
  type FileFault,
  FileSource,
  type FileSourceOptions,
  PROCESSED_DIR,
  REGEX_TIME_LIMIT_MS,
} from "../src/connectors/file.js";
import type { MessageSink, ReceiveOptions } from "../src/connectors/types.js";
import { connectorsFor } from "../src/engine/engine.js";
import { captureLogger, cleanUp, dropFile, makeProject, usePlatform } from "./helpers.js";

afterEach(cleanUp);

/** What a sink was handed, in order: each body as text and its idempotency key. */
interface Received {
  readonly body: string;
  readonly key: string | undefined;
}

/** A sink that stores every message, numbering them from 1. */
function sinkOf(): { sink: MessageSink; received: Received[] } {
  const received: Received[] = [];
  const sink: MessageSink = {
    receive(body: Uint8Array, options: ReceiveOptions = {}) {
      received.push({ body: new TextDecoder().decode(body), key: options.idempotencyKey });
      return Promise.resolve(received.length);
    },
  };
  return { sink, received };
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

/** Backdates `path` by `seconds`, so files can be told apart by their change time. */
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

  it("leaves a file a regex runs too long on, says so, and does not run it on that path again", async () => {
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
    const started = performance.now();
    expect(await pass(source)).toEqual(["fast"]);
    expect(await pass(source)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(REGEX_TIME_LIMIT_MS * 20);
    expect(errors).toEqual([expect.objectContaining({ code: "ERR_SCRIPT_EXECUTION_TIMEOUT" })]);
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

  it("claims at most maxPerPoll files a pass, and the rest on the next", async () => {
    const dir = await inbox();
    for (const name of ["a.hl7", "b.hl7", "c.hl7"]) await dropFile(join(dir, name), name);
    const source = sourceOn(dir, { maxPerPoll: 2 });
    expect(await pass(source)).toEqual(["a.hl7", "b.hl7"]);
    expect(await pass(source)).toEqual(["c.hl7"]);
  });

  it("takes files oldest change first with sortBy: mtime, by name when two tie", async () => {
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
        symlinkSync(outside, join(dir, "sub"), "dir");
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
        symlinkSync(outside, join(dir, "sub"), "dir");
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
    await symlink(join(dir, "held"), errorDir, "dir");
    expect(await pass(sourceOn(dir, { recursive: true, errorDir }))).toEqual(["new"]);
    expect(await tree(dir)).toEqual(["held/x.hl7"]);
  });
});

describe("a file source built from channel.yaml", () => {
  it("takes the options the channel names, and logs a file set aside without naming it", async () => {
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
