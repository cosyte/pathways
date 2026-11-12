import { randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
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
import { basename, dirname, join, resolve, sep } from "node:path";

import { ownsBuffer } from "../storage/ownership.js";

/** How much of a file {@link LocalFolder.chunks} reads at a time: 64 KiB. */
const CHUNK_BYTES = 65_536;

/**
 * What a location's file system promises, which decides the claim rule a file source can run there.
 * The file source claims a file by renaming it to a name of its own, so it runs only where
 * `atomicRename` holds.
 */
export interface FileCapabilities {
  /**
   * A rename happens whole or not at all: the file is under its old name or its new one, never both
   * and never neither, and of two renames of one file only one succeeds.
   */
  readonly atomicRename: boolean;
  /** A rename onto a name that is taken fails, rather than replacing the file there. */
  readonly noClobberRename: boolean;
  /** A listing made after a write, rename or removal shows it. */
  readonly listingConsistent: boolean;
}

/** One entry of a folder's listing: a regular file, a folder, or anything else (a link, a pipe). */
export interface FileEntry {
  readonly name: string;
  readonly kind: "file" | "folder" | "other";
}

/**
 * A file's size, modification time and id, read without following a link. The id names the file itself,
 * not its path: it stays the same when the file is renamed within the location, and two files never
 * share one at the same time.
 */
export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly id: string;
}

/** A file held open before it is claimed, so one that cannot be read is never moved. */
export interface OpenFile {
  /** The open file's own size and id, which a swap of its path since it was opened cannot change. */
  stat(): Promise<FileStat>;
  close(): Promise<void>;
}

/**
 * The file system a file source or destination runs over: a local folder, or a remote one. Paths are
 * the location's own, built with {@link FileSystem.join}. Every operation acts on the path given and
 * never follows a link in its last part.
 */
export interface FileSystem {
  readonly capabilities: FileCapabilities;
  /** The character between the parts of a path, as the location writes paths. */
  readonly sep: string;
  /** `parts` joined into one path, as the location writes paths. */
  join(...parts: string[]): string;
  /** The folder that holds `path`. */
  dirname(path: string): string;
  /** The entries of `folder`, in no set order. */
  list(folder: string): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
  /** The whole file, in a buffer of its own. */
  read(path: string): Promise<Uint8Array>;
  /**
   * The file a chunk at a time, read only as each is asked for, so a batch is read without holding
   * the whole file. A location without it is read whole, with {@link FileSystem.read}.
   */
  chunks?(path: string): AsyncIterable<Uint8Array>;
  /**
   * Writes `body` to a hidden temporary name beside `path`, then renames it to `path`, so a reader
   * never sees half a file.
   */
  writeTemp(path: string, body: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Makes `path` and each folder above it that is missing. */
  mkdir(path: string): Promise<void>;
  /** Ends the location's connection, where it has one; the next operation connects again. */
  close?(): Promise<void>;
}

/**
 * The steps a location takes around each claim's rename: its claim rule. A file source holds every
 * open and move to the source folder through these, and flushes a pass's moves through
 * {@link ClaimRule.durable} before anything it claimed is stored.
 */
export interface ClaimRule {
  /**
   * Whether a file keeps its id when it moves from `folder` into a folder inside it. The check after
   * each move compares ids, so where they change no claim is made. Asked once, before the first claim.
   */
  keepsIds(folder: string): Promise<boolean>;
  /**
   * `dir` as every check holds a path to: with each link on the way resolved. {@link inside} reads
   * the folder of each file it checks through this too.
   */
  root(dir: string): Promise<string>;
  /** `path` as {@link ClaimRule.root} gives it, or as written when it is not there. */
  canonical(path: string): Promise<string>;
  /**
   * Opens `path` to read it, and to write it too where {@link ClaimRule.durable} must. Never through
   * a link in the last part of `path`: a link there is refused, not followed, whatever it points to.
   * A location whose protocol cannot refuse one when it opens (SFTP) reads the path's own entry
   * first, refuses a link, and checks after the open that the open file is that entry.
   */
  open(path: string): Promise<OpenFile>;
  /** Puts the file at `from` back at `to` without replacing a file there; fails if one is. */
  restore(from: string, to: string): Promise<void>;
  /**
   * Makes a pass's moves last past a power cut: `files` are the claimed files under their new names,
   * `folders` every folder a file moved into or out of. Nothing to do when no file moved.
   */
  durable(files: readonly string[], folders: readonly string[]): Promise<void>;
}

/** A location a file source can claim from: its file system and its claim rule. */
export interface Location extends FileSystem, ClaimRule {}

/**
 * An error that says a location cannot be reached at all (a remote server down, a connection lost or
 * too slow), rather than that one file failed. It carries `down: true`. A file source ends its pass
 * on one, says the source is down, and tries again later; it never counts one against a file.
 */
export interface LocationDownError extends Error {
  readonly code: string;
  readonly down: true;
}

/**
 * Whether `error` is a {@link LocationDownError}.
 *
 * @example
 * ```ts
 * if (isLocationDown(error)) sink.sourceDown?.(error.code);
 * ```
 */
export function isLocationDown(error: unknown): error is LocationDownError {
  return (error as { down?: unknown } | undefined)?.down === true;
}

/**
 * Whether `path`, as `location` writes paths, is `root` itself or a path below it. Lexical: it reads
 * nothing, so the caller hands it paths with every link already resolved.
 *
 * @example
 * ```ts
 * within(new LocalFolder(), "/srv/inbox/a", "/srv/inbox"); // true
 * ```
 */
export function within(location: FileSystem, path: string, root: string): boolean {
  return path === root || path.startsWith(location.join(root, location.sep));
}

/**
 * The check every claim, move and set-aside runs before it touches a file, on every kind of location:
 * whether `path`'s folder, with each link on the way resolved by the location, is `root` or under
 * it, and `path` itself, read without following a link, is still the file `id` names. A link in the
 * last part is refused when the file is opened, so a folder on the way swapped for a link since the
 * pass found the file is caught here. Any failure to read either answers false.
 *
 * It is here, not in each location, so a location cannot leave it out: each one only resolves a
 * folder ({@link ClaimRule.root}) and reads a file's id ({@link FileSystem.stat}).
 *
 * @example
 * ```ts
 * if (!(await inside(location, file.path, root, id))) throw moved();
 * ```
 */
export async function inside(
  location: Location,
  path: string,
  root: string,
  id: string,
): Promise<boolean> {
  try {
    const folder = await location.root(location.dirname(path));
    if (!within(location, folder, root)) return false;
    return (await location.stat(path)).id === id;
  } catch {
    return false;
  }
}

/** A local file's device and inode as one id. */
function localId(stats: { readonly dev: bigint; readonly ino: bigint }): string {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

/** A local file's size, modification time and id, from a `stat` read with `bigint`. */
function localStat(stats: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}): FileStat {
  return {
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeNs) / 1e6,
    id: localId(stats),
  };
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

/**
 * A folder on this machine. Its claim rule: a rename to a unique claim name, checked after the move
 * by the file's device and inode, with each folder on the way resolved, so a folder swapped for a
 * link never leads a claim outside the source folder; moves flushed to disk before anything is
 * stored. A rename replaces a file at its destination, so `noClobberRename` is false: the claim names
 * are unique instead, and {@link LocalFolder.restore} links rather than renames.
 *
 * @example
 * ```ts
 * const source = new FileSource({ dir: "./inbox", channel: "adt", minAgeMs: 0, location: new LocalFolder() });
 * ```
 */
export class LocalFolder implements Location {
  /** A rename is whole and replaces a file at its destination; a listing is current. */
  readonly capabilities: FileCapabilities = {
    atomicRename: true,
    noClobberRename: false,
    listingConsistent: true,
  };

  /** This platform's separator. */
  readonly sep: string = sep;

  /** `parts` joined with this platform's separator. */
  join(...parts: string[]): string {
    return join(...parts);
  }

  /** The folder that holds `path`. */
  dirname(path: string): string {
    return dirname(path);
  }

  /** The entries of `folder`; a symbolic link is `other`, whatever it points to. */
  async list(folder: string): Promise<FileEntry[]> {
    return (await readdir(folder, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "folder" : entry.isFile() ? "file" : "other",
    }));
  }

  /** `path`'s size, modification time, device and inode, by `lstat`, never through a link. */
  async stat(path: string): Promise<FileStat> {
    return localStat(await lstat(path, { bigint: true }));
  }

  /** The whole file. */
  async read(path: string): Promise<Uint8Array> {
    // A plain Uint8Array over a buffer of its own, without copying a file Node already read into
    // one (a small file comes back as a slice of Node's shared pool, and is copied).
    const read = await readFile(path);
    return ownsBuffer(read) ? new Uint8Array(read.buffer) : new Uint8Array(read);
  }

  /** The file at `path`, 64 KiB at a time. */
  chunks(path: string): AsyncIterable<Uint8Array> {
    return createReadStream(path, { highWaterMark: CHUNK_BYTES }) as AsyncIterable<Buffer>;
  }

  /** Writes `.<name>.partial` beside `path`, then renames it to `path`. */
  async writeTemp(path: string, body: Uint8Array): Promise<void> {
    const temporary = join(dirname(path), `.${basename(path)}.partial`);
    await writeFile(temporary, body);
    await rename(temporary, path);
  }

  /** Renames `from` to `to`, replacing a file there. */
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  /** Deletes the file at `path`. */
  async remove(path: string): Promise<void> {
    await unlink(path);
  }

  /** Makes `path` and each missing folder above it. */
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  /** Moves an empty file of its own into a folder inside `folder` to find out, and removes both. */
  async keepsIds(folder: string): Promise<boolean> {
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

  /** `dir` with each link on the way resolved. */
  root(dir: string): Promise<string> {
    return realpath(dir);
  }

  /** `path` with each link on the way resolved, or made absolute when it is missing. */
  canonical(path: string): Promise<string> {
    return realpath(path).catch(() => resolve(path));
  }

  /**
   * Never through a symbolic link: `O_NOFOLLOW` refuses one put in the file's place since it was
   * found. Windows has no such flag, and Node gives it as undefined there; there the file is opened
   * to write as well, as flushing it needs, so a file that cannot be flushed is never claimed.
   */
  async open(path: string): Promise<OpenFile> {
    // Read on each open, not at load, so the Windows path can be driven from any platform's tests.
    const windows = process.platform === "win32";
    const flags = windows ? constants.O_RDWR : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(path, flags);
    return {
      stat: async () => localStat(await handle.stat({ bigint: true })),
      close: () => handle.close(),
    };
  }

  /** A hard link, never a rename, which would replace a file put at `to` since. */
  async restore(from: string, to: string): Promise<void> {
    await link(from, to);
  }

  /**
   * On Linux and macOS, flushes each folder. On Windows a folder cannot be flushed that way: Node's
   * `fsync` there is `FlushFileBuffers`, which needs a handle opened to write, and so refuses a
   * folder opened to read. So on Windows each claimed file is flushed under its new name instead,
   * which writes the file's metadata, the rename among it, as PostgreSQL's `durable_rename` does.
   */
  async durable(files: readonly string[], folders: readonly string[]): Promise<void> {
    if (process.platform === "win32") {
      for (const file of files) await flush(file, "r+");
    } else if (files.length > 0) {
      for (const folder of folders) await flush(folder, "r");
    }
  }
}
