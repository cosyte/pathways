import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { createContext, Script } from "node:vm";

import { DEFAULT_READ_TRIES, type PathPattern } from "../config/schema.js";
import { faultPoint } from "../fault-points.js";
import { copiesBodies, markCopiesBodies, ownsBuffer, release } from "../storage/ownership.js";
import type {
  DestinationConnector,
  MessageSink,
  OutgoingMessage,
  SourceConnector,
} from "./types.js";

/**
 * The folder inside a file source where files go once stored, when the channel keeps a plaintext
 * copy of each (`keepProcessed: true`).
 */
export const PROCESSED_DIR = "processed";

/**
 * The hidden folder inside a file source where a file waits while it is being stored, in a folder of
 * its channel's own: `.claimed/<channel>/`. A file is moved here before it is read, and deleted (or
 * moved into `processed/`) once it is stored, so a file found here at start was taken in by a run
 * that stopped part way. Each channel has its own folder, so two channels that read one folder never
 * finish each other's files.
 */
export const CLAIMED_DIR = ".claimed";

/**
 * A claimed file's name: the claim's id, then a hyphen and the file's path from the source folder,
 * with each `%` written `%25` and each `/` written `%2F`, so the name is one segment and two files
 * of one name in different subfolders never share a claim. The id is the pass's time in epoch
 * milliseconds, 15 digits, the file's place in the pass, 8 digits, so claims sort in the order they
 * were made, and a random part: 33 bytes. When the whole name does not fit in {@link NAME_MAX}
 * bytes, the claim keeps as much of the end of the path as fits.
 */
const CLAIM_NAME = /^\d{15}\.\d{8}\.[0-9a-f]{8}-(.+)$/s;

/** The longest file name, in bytes, that the common Linux file systems take. */
const NAME_MAX = 255;

/** A file in a file source, claimed or ready to be claimed. */
export interface SourceFile {
  readonly name: string;
  readonly path: string;
}

/** Why a file source set a file aside, or would have with an error folder. */
export type FileFaultReason = "too-large" | "unreadable";

/**
 * A file a source will not store: larger than `maxSize`, or one it failed to open on `readTries`
 * passes in a row. `moved` says whether it went into `errorDir`; `error` is why it could not, when
 * a move was tried and failed.
 */
export interface FileFault {
  readonly reason: FileFaultReason;
  readonly moved: boolean;
  readonly error?: unknown;
}

/** A file found in a pass: its path from the source folder, with `/`, and where it is. */
interface Found {
  readonly rel: string;
  readonly path: string;
}

/** A found file that is ready to be claimed, with its size, change time and id when found. */
interface Ready extends Found {
  readonly size: number;
  readonly mtimeMs: number;
  readonly id: FileId;
}

/** A claimed file, with its path from the source folder when it was claimed. */
interface Claimed extends SourceFile {
  readonly rel: string;
}

/** Sorts files by name, as code units compare (not by locale), oldest claim or name first. */
function byName<T extends { readonly name: string }>(files: T[]): T[] {
  return files.sort((a, b) => compare(a.name, b.name));
}

/** Compares two strings as code units, not by locale. */
function compare(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/**
 * `prefix`, then as much of the end of `name` as fits in {@link NAME_MAX} bytes, in whole
 * characters: the end, so the extension stays.
 */
function fitted(prefix: string, name: string): string {
  let room = NAME_MAX - Buffer.byteLength(prefix);
  const kept: string[] = [];
  for (const character of [...name].reverse()) {
    room -= Buffer.byteLength(character);
    if (room < 0) break;
    kept.push(character);
  }
  return prefix + kept.reverse().join("");
}

/** A path from the source folder as one name: `%` as `%25`, then `/` as `%2F`. */
function encodePath(rel: string): string {
  return rel.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/** The path {@link encodePath} wrote. */
function decodePath(name: string): string {
  return name.replace(/%(25|2F)/g, (_, code: string) => (code === "25" ? "%" : "/"));
}

/**
 * The longest one pattern, a glob or a `{ regex }`, may run on one path, in milliseconds. A file's
 * name is chosen by whoever writes it, and a pattern can backtrack on a name built for it: a regex
 * with nested repeats, such as `^(a+)+$`, or a glob with several `*` in one segment, such as
 * `*_*_*_*_*.hl7`, which Node compiles to a regex of as many lazy repeats. Either can take minutes
 * on such a name, holding the whole engine meanwhile. A path that takes longer is left where it is
 * and said, with the code `ERR_SCRIPT_EXECUTION_TIMEOUT`. The limit is time on the clock, not work
 * done, so a pause of the host can stop a harmless run too: see {@link SLOW_TRIES}.
 */
export const REGEX_TIME_LIMIT_MS = 50;

/**
 * Passes in a row a pattern may run too long on one path before the path is set aside. A single
 * timeout is never final, since a busy host or a garbage collection can stop a harmless run: the path
 * is tried again on the next pass, and taken once a run finishes. Set aside, it is tried again after
 * 1 pass, then 2, 4 and so on up to {@link SLOW_WAIT_MAX}, and each run that times out is said again.
 */
const SLOW_TRIES = 3;

/** The most passes a path set aside by {@link SLOW_TRIES} waits before it is tried again. */
const SLOW_WAIT_MAX = 64;

/**
 * The most time the pattern runs of one pass may take together, in milliseconds. Without it, a writer
 * who drops many names built to run long costs {@link REGEX_TIME_LIMIT_MS} each, on every pass. Once
 * a pass has spent this long, the paths it has not run yet wait for the next pass, and each pass runs
 * the paths that have waited longest first, so a file dropped among such names is still reached. A
 * path's result is kept while its file is there, so a run is spent on each path once, not each pass.
 */
export const PATTERN_TIME_PER_PASS_MS = 500;

/** A path a pattern ran too long on: the runs in a row that did, and the passes left to wait. */
interface Slow {
  readonly runs: number;
  readonly wait: number;
}

/**
 * The one script each pattern runs through, so a run can be stopped at {@link REGEX_TIME_LIMIT_MS}.
 * Its text is fixed and its context holds only the pattern, the path and, for a glob, Node's own
 * matcher, so neither a pattern nor a name can run code of its own. The timeout stops the matcher
 * too, though it comes from the main realm.
 */
const TEST_SCRIPT = new Script("glob === undefined ? expression.test(path) : matches(path, glob)");

/**
 * A test of a path against one {@link PathPattern}; a pattern that runs too long throws. The test is
 * run once here, on an empty path, so the first run on a real one is not also the script's first run
 * in its context, which is slower.
 */
function matcher(pattern: PathPattern): (rel: string) => boolean {
  // Node loads its glob matcher on the first call. Loaded inside a timed run, a slow host could
  // stop the load part way and leave every later glob failing, so it loads here, untimed, on a
  // fixed pattern that costs nothing.
  if ("glob" in pattern) posix.matchesGlob("", "*");
  const context =
    "glob" in pattern
      ? {
          glob: pattern.glob,
          matches: (path: string, glob: string) => posix.matchesGlob(path, glob),
          path: "",
        }
      : { glob: undefined, expression: new RegExp(pattern.regex, "u"), path: "" };
  createContext(context);
  const test = (rel: string): boolean => {
    context.path = rel;
    return TEST_SCRIPT.runInContext(context, { timeout: REGEX_TIME_LIMIT_MS }) === true;
  };
  try {
    test("");
  } catch {
    // A warm run stopped by a pause is no file's fault; a real path's run says its own.
  }
  return test;
}

/** A file's device and inode, as `lstat` and the open file's `stat` give them. */
interface FileId {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** A file id as one string, for a set. */
function idKey(id: FileId): string {
  return `${String(id.dev)}:${String(id.ino)}`;
}

/** The error a claim gives for a file no longer inside the source folder, or no longer the same. */
function moved(): Error {
  return Object.assign(new Error("the file left the source folder or was replaced"), {
    code: "ESTALE",
  });
}

/**
 * The error for a file a move took in that is not the one checked, and that could not be moved back
 * where it came from: it waits in `.claimed/` under a `refused-` name, never stored. When even the
 * move to that name failed, it waits where the move took it, and this run never stores it; a later
 * run that finds it in the claim folder does.
 */
function held(): Error {
  return Object.assign(new Error("a refused file could not be moved back, and is held"), {
    code: "ERR_PATHWAYS_FILE_HELD",
  });
}

/**
 * The error for a folder whose file system gives a file a new id when it moves between folders, as
 * FAT and exFAT can: the check after each move could not tell a file from another, so nothing is
 * claimed.
 */
function unsteady(): Error {
  return Object.assign(new Error("this file system changes a file's id when it moves"), {
    code: "ERR_PATHWAYS_FILE_ID_UNSTEADY",
  });
}

/**
 * Whether a file keeps its device and inode when it moves from `folder` into a folder inside it, on
 * the file system that holds `folder`. Moves an empty file of its own to find out, and removes both.
 */
async function steadyIds(folder: string): Promise<boolean> {
  const name = `probe-${randomBytes(8).toString("hex")}`;
  const file = join(folder, name);
  const inner = join(folder, `${name}.d`);
  try {
    await writeFile(file, "", { flag: "wx" });
    const before = await lstat(file, { bigint: true });
    await mkdir(inner);
    await rename(file, join(inner, "probe"));
    const after = await lstat(join(inner, "probe"), { bigint: true });
    return before.dev === after.dev && before.ino === after.ino;
  } finally {
    await rm(file, { force: true });
    await rm(inner, { recursive: true, force: true });
  }
}

/**
 * Opens `path` with `flags` and flushes it to disk. On Linux and macOS the path is a folder, opened
 * to read, and `fsync` writes its entries, so a file moved into or out of it stays moved after a
 * power cut, not only after the process stops. On Windows it is a claimed file, opened to write:
 * Node's `fsync` there is `FlushFileBuffers`, which needs a handle with write access and writes the
 * file's metadata, its name among them, as well as its data.
 */
async function flush(path: string, flags: "r" | "r+"): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Options for a {@link FileSource}. */
export interface FileSourceOptions {
  readonly dir: string;
  /** The channel the source reads for: its claims wait in `.claimed/<channel>/`. */
  readonly channel: string;
  readonly minAgeMs: number;
  /** Epoch milliseconds now. */
  readonly now?: () => number;
  /** Told when a ready file cannot be claimed or read; it stays where it is for the next pass. */
  readonly onReadError?: (error: unknown) => void;
  /**
   * Moves each file into `processed/` once it is stored, instead of deleting it. That copy is the
   * message in plaintext, outside the encrypted store, so it is off by default.
   */
  readonly keepProcessed?: boolean;
  /**
   * Only files whose path from `dir`, written with `/` on every platform, matches one of these are
   * taken. A glob's `*` never matches a leading dot. Default: every file.
   */
  readonly include?: readonly PathPattern[];
  /** Files whose path matches one of these are left. Default: none. */
  readonly exclude?: readonly PathPattern[];
  /**
   * Reads the subfolders too, but never `.claimed/`, `processed/` or `errorDir`. Default false.
   * Symbolic links, to files or folders, are never followed.
   */
  readonly recursive?: boolean;
  /** Leaves files and folders whose name starts with a dot. Default true. */
  readonly ignoreDot?: boolean;
  /** The smallest file taken, in bytes; a smaller one is left. Default 1: an empty file is left. */
  readonly minSize?: number;
  /** The largest file taken, in bytes; a larger one is set aside. Default: no limit. */
  readonly maxSize?: number | undefined;
  /** The most files claimed in one pass. Default: no limit. */
  readonly maxPerPoll?: number | undefined;
  /** The order files are claimed in: by path (the default) or oldest change first. */
  readonly sortBy?: "name" | "mtime";
  /**
   * Takes a file only once a pass finds the size and change time the pass before it found, as well
   * as `minAgeMs` old. Held in memory, so the first pass after a start takes nothing. Default false.
   */
  readonly stable?: boolean;
  /**
   * Takes a file only once a file of the same path plus this suffix is there (`a.hl7.done` for
   * `a.hl7` with `.done`), and deletes that marker once the file is claimed. Default: none.
   */
  readonly doneFile?: string | undefined;
  /**
   * Where a file goes, under its path from `dir`, when it is larger than `maxSize` or fails to open
   * on `readTries` passes in a row. Never a message that fails later. Default: none, so it stays.
   */
  readonly errorDir?: string | undefined;
  /** How many passes in a row a file fails to open before it goes into `errorDir`. Default 3. */
  readonly readTries?: number;
  /** Told of each file set aside, or that would have been with an `errorDir`. */
  readonly onFileFault?: (fault: FileFault) => void;
}

/**
 * Reads each file that lands in a folder as one message, and deletes it once the message is stored.
 *
 * Each pass first finishes what an earlier run claimed, then claims every ready file: it opens the
 * file, so one that cannot be read stays where it is, and moves it into `.claimed/<channel>/` under
 * a name of its own. Once the pass's moves are flushed to disk, it reads and stores each file with
 * that name as its idempotency key, then deletes it. A run that stops after the store and before the
 * delete leaves the file claimed; the next pass hands it in again under the same key, marked
 * `resumed`, the store answers with the message it already holds, and the file is deleted. Because
 * the moves are on disk before anything is stored, a power cut cannot put a stored file back in the
 * folder to be claimed again. So nothing is lost and nothing is stored twice. With `keepProcessed`,
 * the file moves into `processed/`, under its path from the folder, prefixed with the message id,
 * instead of being deleted.
 *
 * A file is ready when it is a regular file (never a symbolic link), its path passes `include` and
 * `exclude`, it has sat for `minAgeMs`, it holds at least `minSize` bytes, and, as set, it was the
 * same at the pass before (`stable`) and its marker is there (`doneFile`). A ready file larger than
 * `maxSize`, by the size read before the claim or by the open file's own, is not claimed: it moves
 * into `errorDir` when one is set and otherwise stays where it is. So does one that fails to open on
 * `readTries` passes in a row.
 *
 * How the moves reach the disk depends on the platform. On Linux and macOS the pass flushes the
 * folders the files moved between. On Windows a folder cannot be flushed that way: Node's `fsync`
 * there is `FlushFileBuffers`, which needs a handle opened to write, and so refuses a folder opened
 * to read. So on Windows the pass flushes each claimed file under its new name instead, which
 * writes the file's metadata, the rename among it, as PostgreSQL's `durable_rename` does there. A file is therefore
 * opened to write as well as to read before it is claimed on Windows, and one that cannot be (a
 * read-only file, or one another program holds open without sharing write or delete access)
 * stays where it is; a writer that shares that access does not stop the claim, and `minAgeMs` is
 * what keeps a file still being written from being taken.
 *
 * @example
 * ```ts
 * const source = new FileSource({ dir: "./inbox", channel: "adt-to-lab", minAgeMs: 1_000 });
 * await source.poll({ receive: async (body, options) => store.receive("adt-to-lab", body, options) });
 * ```
 */
export class FileSource implements SourceConnector {
  private readonly options: FileSourceOptions;
  private readonly include: readonly ((rel: string) => boolean)[];
  private readonly exclude: readonly ((rel: string) => boolean)[];
  /** The size and change time of each file the last pass found, for `stable`. */
  private seen = new Map<string, string>();
  /** How many passes in a row each file has failed to open, for `readTries`. */
  private tries = new Map<string, number>();
  /** Paths a pattern ran too long on, so one set aside costs a run only now and then. */
  private slow = new Map<string, Slow>();
  /** Whether each path found last pass passes `include` and `exclude`, once a run has said. */
  private known = new Map<string, boolean>();
  /** The pass each path still waiting for a run joined the line in, for {@link PATTERN_TIME_PER_PASS_MS}. */
  private turns = new Map<string, number>();
  /** The passes made, to number each pass's place in the line. */
  private passes = 0;
  /**
   * The ids of files a move took in that were not the ones checked: never claimed or stored by this
   * source while a pass still finds them, wherever a later race leaves them.
   */
  private refused = new Set<string>();
  /** Whether the folder's file system keeps a file's id when it moves, once a claim has asked. */
  private steady: boolean | undefined;

  /**
   * @param options The folder to read, the channel it is read for, how long a file must sit before
   * it is read, which files to take, and what to keep.
   */
  constructor(options: FileSourceOptions) {
    this.options = options;
    this.include = (options.include ?? []).map(matcher);
    this.exclude = (options.exclude ?? []).map(matcher);
  }

  /**
   * Stores what an earlier run claimed and did not finish, then every ready file, each through
   * `sink`. A file is deleted (or moved into `processed/`) only once `sink` has stored it.
   */
  async poll(sink: MessageSink): Promise<void> {
    const claims = join(this.options.dir, CLAIMED_DIR, this.options.channel);
    await mkdir(claims, { recursive: true });
    const unfinished = (await readdir(claims, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, path: join(claims, entry.name) }));
    // The refused files this pass still finds, claimed or not; the rest are forgotten.
    const refused = new Set<string>();
    // An earlier run may have stored these before it stopped: the store looks each key up.
    for (const file of byName(unfinished)) {
      if (await this.isRefused(file.path, refused)) continue;
      await this.store(file, sink, true);
    }
    for (const file of await this.claim(claims, refused)) await this.store(file, sink, false);
  }

  /**
   * Whether the file at `path` is one a move refused; if so, it is kept in `refused`. A claim whose
   * id cannot be read while any file is refused waits for a later pass, and every refused id is
   * kept meanwhile.
   */
  private async isRefused(path: string, refused: Set<string>): Promise<boolean> {
    if (this.refused.size === 0) return false;
    let key: string;
    try {
      key = idKey(await lstat(path, { bigint: true }));
    } catch {
      for (const kept of this.refused) refused.add(kept);
      return true;
    }
    if (!this.refused.has(key)) return false;
    refused.add(key);
    return true;
  }

  /**
   * Moves the file `id` names from `from` to `to`, and checks after the move that the file now at
   * `to` is that one. A folder on `from` swapped for a link between the last check and the move
   * would move a file from outside the source folder: then the move is refused, with
   * {@link moved}'s error. The file first moves into `.claimed/` under a `refused-` name, out of
   * every folder a pass reads, and goes back to `from` from there by a hard link and an unlink,
   * never by a rename, which would replace a file put at `from` since. So a crash at any step
   * leaves it under at most one name a pass reads: `to` (when the crash comes before the move to
   * the held name), or `from`, never both. A file that cannot go back (one is there, or the folder
   * is gone) stays under its held name, with {@link held}'s error. Either way its id is noted in
   * `refused`, so a file a later swap leaves in the source folder is never taken.
   */
  private async relocate(from: string, to: string, id: FileId): Promise<void> {
    await rename(from, to);
    const now = await lstat(to, { bigint: true });
    if (now.dev === id.dev && now.ino === id.ino) return;
    this.refused.add(idKey(now));
    const name = `refused-${randomBytes(8).toString("hex")}`;
    const holding = join(this.options.dir, CLAIMED_DIR, name);
    try {
      await rename(to, holding);
    } catch {
      // Left at to, where its noted id keeps this run from storing it. A later run that finds it in
      // the claim folder stores it.
      throw held();
    }
    try {
      await link(holding, from);
    } catch {
      throw held();
    }
    faultPoint("mid-move-back");
    try {
      await unlink(holding);
    } catch {
      // Back at from, and still under its held name, which no pass reads.
    }
    throw moved();
  }

  /**
   * The found files whose path passes `include` and `exclude`, at most
   * {@link PATTERN_TIME_PER_PASS_MS} of runs a pass. A path's result is kept while its file is
   * there. A path a pattern ran too long on passes neither this pass, so it is left, and is noted in
   * `slow`: it is tried again on the next pass, and after {@link SLOW_TRIES} timeouts in a row only
   * after a wait, as that says. Paths the pass had no time left for wait for the next, in the order
   * they joined the line.
   */
  private judge(candidates: readonly Found[]): Found[] {
    if (this.include.length === 0 && this.exclude.length === 0) return [...candidates];
    this.passes += 1;
    const pass = this.passes;
    const known = new Map<string, boolean>();
    const turns = new Map<string, number>();
    const slow = new Map<string, Slow>();
    const found: Found[] = [];
    const line: Found[] = [];
    for (const file of candidates) {
      const result = this.known.get(file.rel);
      if (result !== undefined) {
        known.set(file.rel, result);
        if (result) found.push(file);
        continue;
      }
      turns.set(file.rel, this.turns.get(file.rel) ?? pass);
      const last = this.slow.get(file.rel);
      if (last !== undefined && last.wait > 0) {
        slow.set(file.rel, { runs: last.runs, wait: last.wait - 1 });
        continue;
      }
      line.push(file);
    }
    // Sorting is stable, so paths that joined in one pass keep the order the walk found them in.
    line.sort((a, b) => Number(turns.get(a.rel)) - Number(turns.get(b.rel)));
    let spent = 0;
    for (const file of line) {
      const last = this.slow.get(file.rel);
      if (spent >= PATTERN_TIME_PER_PASS_MS) {
        if (last !== undefined) slow.set(file.rel, last);
        continue;
      }
      const started = performance.now();
      try {
        const included = this.include.length === 0 || this.include.some((test) => test(file.rel));
        const result = included && !this.exclude.some((test) => test(file.rel));
        known.set(file.rel, result);
        turns.delete(file.rel);
        if (result) found.push(file);
      } catch (error) {
        this.options.onReadError?.(error);
        const runs = (last?.runs ?? 0) + 1;
        const wait = runs < SLOW_TRIES ? 0 : Math.min(2 ** (runs - SLOW_TRIES), SLOW_WAIT_MAX);
        slow.set(file.rel, { runs, wait });
        // To the back of the line, behind every path waiting now: those go first next pass.
        turns.set(file.rel, pass + 1);
      } finally {
        spent += performance.now() - started;
      }
    }
    // Only paths found this pass are remembered, as with `seen`.
    this.known = known;
    this.turns = turns;
    this.slow = slow;
    return found;
  }

  /**
   * Whether `path` is in a folder that is `root` or under it once every link on the way is
   * resolved, and is still the file `id` names. A folder on a file's path swapped for
   * a link since the pass found it would otherwise lead an open or a move outside the source folder:
   * `O_NOFOLLOW` refuses a link only in a path's last part. Each move is checked again after it is
   * made, by {@link FileSource.relocate}, for a swap between this check and the move.
   */
  private async inside(path: string, root: string, id: FileId): Promise<boolean> {
    try {
      const folder = await realpath(dirname(path));
      if (folder !== root && !folder.startsWith(join(root, sep))) return false;
      const now = await lstat(path, { bigint: true });
      return now.dev === id.dev && now.ino === id.ino;
    } catch {
      return false;
    }
  }

  /**
   * The files the pass finds: regular files whose path matches, in `dir` and, with `recursive`, its
   * subfolders, never `.claimed/`, `processed/` or `errorDir`. With `doneFile`, the markers found
   * are returned apart. Creates `dir` if missing.
   */
  private async find(): Promise<{ found: Found[]; markers: Set<string> }> {
    const {
      dir,
      recursive = false,
      ignoreDot = true,
      doneFile,
      errorDir,
      onReadError,
    } = this.options;
    await mkdir(dir, { recursive: true });
    // Both with every link resolved, so an errorDir reached through a link into dir is passed over.
    const root = await realpath(dir);
    const errors =
      errorDir === undefined ? undefined : await realpath(errorDir).catch(() => resolve(errorDir));
    const candidates: Found[] = [];
    const markers = new Set<string>();
    const walk = async (folder: string, under: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const rel = `${under}${entry.name}`;
        const path = join(folder, entry.name);
        // The claim folder is passed over even when dot files are read.
        if (rel === CLAIMED_DIR || (ignoreDot && entry.name.startsWith("."))) continue;
        if (entry.isDirectory()) {
          // A folder the walk enters is a real one, never a link, so its real path is root's plus rel.
          if (!recursive || rel === PROCESSED_DIR || join(root, ...rel.split("/")) === errors) {
            continue;
          }
          // A subfolder that cannot be read is said, and the rest of the pass goes on.
          // A try, not a catch callback: on Windows no mode makes a folder unreadable, so a
          // function here would go uncalled there.
          try {
            await walk(path, `${rel}/`);
          } catch (error) {
            onReadError?.(error);
          }
        } else if (!entry.isFile()) {
          // A symbolic link, to a file or a folder, a pipe or a device: never read.
        } else if (doneFile !== undefined && rel.endsWith(doneFile)) {
          markers.add(rel);
        } else {
          candidates.push({ rel, path });
        }
      }
    };
    await walk(dir, "");
    return { found: this.judge(candidates), markers };
  }

  /** The files ready to be claimed this pass, in the order they are to be claimed. */
  private async ready(now: number, refused: Set<string>): Promise<Ready[]> {
    const { minAgeMs, minSize = 1, stable = false, doneFile, sortBy = "name" } = this.options;
    const { found, markers } = await this.find();
    const seen = new Map<string, string>();
    const tries = new Map<string, number>();
    const ready: Ready[] = [];
    for (const file of found) {
      // lstat, not stat: a file swapped for a link meanwhile is refused when it is opened below.
      const stats = await lstat(file.path, { bigint: true });
      const size = Number(stats.size);
      const mtimeMs = Number(stats.mtimeNs) / 1e6;
      const id = { dev: stats.dev, ino: stats.ino };
      // A file a move refused, left here by a later swap: said when it was refused, never taken.
      if (this.refused.has(idKey(id))) {
        refused.add(idKey(id));
        continue;
      }
      const state = `${String(size)}:${String(mtimeMs)}`;
      const unchanged = this.seen.get(file.rel) === state;
      seen.set(file.rel, state);
      const tried = this.tries.get(file.rel);
      if (tried !== undefined) tries.set(file.rel, tried);
      if (now - mtimeMs < minAgeMs || size < minSize || (stable && !unchanged)) continue;
      if (doneFile !== undefined && !markers.has(`${file.rel}${doneFile}`)) continue;
      ready.push({ ...file, size, mtimeMs, id });
    }
    // Only files found this pass are remembered, so a file that left is forgotten.
    this.seen = seen;
    this.tries = tries;
    this.refused = refused;
    return ready.sort(
      (a, b) => (sortBy === "mtime" ? a.mtimeMs - b.mtimeMs : 0) || compare(a.rel, b.rel),
    );
  }

  /**
   * Moves each ready file into the channel's claim folder, then flushes the moves to disk, once a
   * pass that claims anything: on Linux and macOS the claim folder, `.claimed/`, the source folder
   * and each subfolder a file left; on Windows each claimed file, under its claimed name.
   */
  private async claim(claims: string, refused: Set<string>): Promise<Claimed[]> {
    const { dir, now = Date.now, onReadError, doneFile } = this.options;
    const { maxSize = Infinity, maxPerPoll = Infinity } = this.options;
    // Read on each pass, not at load, so the Windows path can be driven from any platform's tests.
    const windows = process.platform === "win32";
    // Never through a symbolic link: O_NOFOLLOW refuses one put in a file's place since it was found.
    // Windows has no such flag, and Node gives it as undefined there.
    const flags = windows ? constants.O_RDWR : constants.O_RDONLY | constants.O_NOFOLLOW;
    const at = String(now()).padStart(15, "0");
    const taken: Claimed[] = [];
    const ready = await this.ready(now(), refused);
    if (ready.length === 0) return taken;
    // The check after each move compares file ids: on a file system that changes a file's id when
    // it moves (FAT and exFAT can), every claim would be refused, so none is tried. Asked once.
    if (this.steady === undefined) {
      try {
        this.steady = await steadyIds(join(dir, CLAIMED_DIR));
      } catch (error) {
        onReadError?.(error);
        return taken;
      }
    }
    if (!this.steady) {
      onReadError?.(unsteady());
      return taken;
    }
    // After the walk, which made dir: every open and move is held to this folder.
    const root = await realpath(dir);
    for (const file of ready) {
      if (taken.length >= maxPerPoll) break;
      if (file.size > maxSize) {
        await this.setAside(file, "too-large", file.id, root);
        continue;
      }
      const place = String(taken.length).padStart(8, "0");
      const name = fitted(
        `${at}.${place}.${randomBytes(4).toString("hex")}-`,
        encodePath(file.rel),
      );
      const path = join(claims, name);
      let handle;
      try {
        // Opened before the move, so a file that cannot be read stays where it is. On Windows it is
        // opened to write too, as flushing it below needs, so a file that cannot be flushed stays.
        handle = await open(file.path, flags);
      } catch (error) {
        onReadError?.(error);
        await this.unreadable(file, root);
        continue;
      }
      this.tries.delete(file.rel);
      let grown: boolean;
      let id: FileId;
      try {
        const stats = await handle.stat({ bigint: true });
        id = { dev: stats.dev, ino: stats.ino };
        // The open file must be the one at its path, under dir with no link on the way: a folder
        // swapped for a link would otherwise lead the open and the move outside dir.
        if (!(await this.inside(file.path, root, id))) throw moved();
        // The open file's own size: a file that grew since it was found is held to maxSize too.
        grown = Number(stats.size) > maxSize;
        if (!grown) {
          faultPoint("before-claim-move");
          await this.relocate(file.path, path, id);
        }
      } catch (error) {
        onReadError?.(error);
        continue;
      } finally {
        await handle.close();
      }
      if (grown) {
        await this.setAside(file, "too-large", id, root);
        continue;
      }
      taken.push({ name, path, rel: file.rel });
    }
    if (windows) {
      for (const file of taken) await flush(file.path, "r+");
    } else if (taken.length > 0) {
      await flush(claims, "r");
      await flush(join(dir, CLAIMED_DIR), "r");
      const left = new Set<string>();
      for (const file of taken) left.add(dirname(join(dir, ...file.rel.split("/"))));
      for (const folder of left) await flush(folder, "r");
    }
    // Each marker goes once its file's claim is on disk, so a power cut cannot leave a file unmarked.
    // Never through a folder swapped for a link since: a marker outside dir is not ours to delete.
    // So it is moved into .claimed/ first, where the move is checked, and deleted only from there.
    if (doneFile !== undefined) {
      for (const file of taken) {
        const marker = join(dir, `${file.rel}${doneFile}`);
        const found = await lstat(marker, { bigint: true }).catch(() => undefined);
        if (found === undefined) continue;
        const id = { dev: found.dev, ino: found.ino };
        if (!(await this.inside(marker, root, id))) continue;
        const doomed = join(dir, CLAIMED_DIR, `marker-${randomBytes(8).toString("hex")}`);
        try {
          await this.relocate(marker, doomed, id);
        } catch (error) {
          onReadError?.(error);
          continue;
        }
        await rm(doomed);
      }
    }
    return taken;
  }

  /** Counts a pass that failed to open `file`, and sets it aside after `readTries` in a row. */
  private async unreadable(file: Ready, root: string): Promise<void> {
    const { errorDir, readTries = DEFAULT_READ_TRIES } = this.options;
    const tries = (this.tries.get(file.rel) ?? 0) + 1;
    this.tries.set(file.rel, tries);
    if (errorDir !== undefined && tries >= readTries) {
      await this.setAside(file, "unreadable", file.id, root);
    }
  }

  /**
   * Moves `file` into `errorDir` under its path from the source folder, as it arrived, never over a
   * file already there; or, with no `errorDir`, leaves it. Either way says so. Only while `file` is
   * still the file `id` names, inside `root`: never one reached through a folder swapped for a link.
   */
  private async setAside(
    file: Found,
    reason: FileFaultReason,
    id: FileId,
    root: string,
  ): Promise<void> {
    const { errorDir, onFileFault } = this.options;
    if (errorDir === undefined) {
      onFileFault?.({ reason, moved: false });
      return;
    }
    const target = join(errorDir, ...file.rel.split("/"));
    try {
      await mkdir(dirname(target), { recursive: true });
      const taken = await lstat(target).then(
        () => true,
        () => false,
      );
      if (taken) throw Object.assign(new Error("a file is already there"), { code: "EEXIST" });
      if (!(await this.inside(file.path, root, id))) throw moved();
      await this.relocate(file.path, target, id);
    } catch (error) {
      onFileFault?.({ reason, moved: false, error });
      return;
    }
    this.tries.delete(file.rel);
    onFileFault?.({ reason, moved: true });
  }

  /**
   * Stores a claimed file under its claimed name, then deletes it or moves it into `processed/`,
   * under its path from the source folder.
   */
  private async store(file: SourceFile, sink: MessageSink, resumed: boolean): Promise<void> {
    const { dir, keepProcessed = false, onReadError } = this.options;
    let body: Uint8Array;
    try {
      // A plain Uint8Array over a buffer of its own, as before, without copying a file Node already
      // read into one (a small file comes back as a slice of Node's shared pool, and is copied).
      const read = await readFile(file.path);
      body = ownsBuffer(read) ? new Uint8Array(read.buffer) : new Uint8Array(read);
    } catch (error) {
      onReadError?.(error);
      return;
    }
    // The name as it was dropped, as its path from the source folder, which the transform reads in
    // ctx.source and nothing logs.
    const original = CLAIM_NAME.exec(file.name)?.[1] ?? file.name;
    const segments = decodePath(original).split("/");
    // A claim made by hand could name a path that leaves processed/: it keeps its name, flat.
    const parts = segments.some((part) => part === "" || part === "." || part === "..")
      ? [original]
      : segments;
    const id = await sink.receive(body, {
      idempotencyKey: `file:${file.name}`,
      resumed,
      source: { name: parts.join("/") },
    });
    // A sink that copied the body keeps none of it, and this source is done with it.
    if (copiesBodies(sink)) release(body);
    if (!keepProcessed) {
      await unlink(file.path);
      return;
    }
    const folder = join(dir, PROCESSED_DIR, ...parts.slice(0, -1));
    await mkdir(folder, { recursive: true });
    await rename(file.path, join(folder, fitted(`${String(id)}-`, String(parts.at(-1)))));
  }
}

/** Options for a {@link FileDestination}. */
export interface FileDestinationOptions {
  readonly dir: string;
  /** The extension of the files written, without the dot. */
  readonly extension: string;
}

/**
 * Writes each output as `<message id>-<output number>.<extension>` in a folder. It writes to a hidden
 * temporary name and renames, so a reader never sees half a file. Any failure is worth a retry (a
 * full disk, a permission fixed later), so none is a `DeliveryRejected`.
 *
 * @example
 * ```ts
 * const destination = new FileDestination({ dir: "./outbox", extension: "hl7" });
 * await destination.deliver({ messageId: 1, seq: 0, body });
 * ```
 */
export class FileDestination implements DestinationConnector {
  private readonly options: FileDestinationOptions;

  /** @param options The folder to write into and the extension of each file. */
  constructor(options: FileDestinationOptions) {
    this.options = options;
    // The file is written before `deliver` resolves, and the body is not kept.
    markCopiesBodies(this);
  }

  /** Writes one output as a file. */
  async deliver(message: OutgoingMessage): Promise<void> {
    const { dir, extension } = this.options;
    await mkdir(dir, { recursive: true });
    const name = `${message.messageId}-${message.seq + 1}.${extension}`;
    const temporary = join(dir, `.${name}.partial`);
    await writeFile(temporary, message.body);
    await rename(temporary, join(dir, name));
  }
}
