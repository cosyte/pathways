import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
 * A claimed file's name: the claim's id, then a hyphen and the file's own name. The id is the pass's
 * time in epoch milliseconds, 15 digits, the file's place in the pass, 8 digits, so claims sort in
 * the order they were made, and a random part: 33 bytes. When the whole name does not fit in
 * {@link NAME_MAX} bytes, the claim keeps as much of the end of the file's name as fits.
 */
const CLAIM_NAME = /^\d{15}\.\d{8}\.[0-9a-f]{8}-(.+)$/s;

/** The longest file name, in bytes, that the common Linux file systems take. */
const NAME_MAX = 255;

/** A file in a file source, ready to be read. */
export interface SourceFile {
  readonly name: string;
  readonly path: string;
}

/**
 * The files in `dir` ready to be read, oldest name first: regular files, not hidden, untouched for at
 * least `minAgeMs` so a file still being written is left for a later pass. Creates `dir` if missing.
 *
 * @example
 * ```ts
 * const files = await readyFiles("./inbox", 1_000, Date.now());
 * ```
 */
export async function readyFiles(
  dir: string,
  minAgeMs: number,
  now: number,
): Promise<SourceFile[]> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const ready: SourceFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    const { mtimeMs } = await stat(path);
    if (now - mtimeMs >= minAgeMs) ready.push({ name: entry.name, path });
  }
  return byName(ready);
}

/** Sorts files by name, as code units compare (not by locale), oldest claim or name first. */
function byName<T extends { readonly name: string }>(files: T[]): T[] {
  return files.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name));
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
 * the file moves into `processed/`, prefixed with the message id, instead of being deleted.
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

  /**
   * @param options The folder to read, the channel it is read for, how long a file must sit before
   * it is read, and what to keep.
   */
  constructor(options: FileSourceOptions) {
    this.options = options;
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
    // An earlier run may have stored these before it stopped: the store looks each key up.
    for (const file of byName(unfinished)) await this.store(file, sink, true);
    for (const file of await this.claim(claims)) await this.store(file, sink, false);
  }

  /**
   * Moves each ready file into the channel's claim folder, then flushes the moves to disk, once a
   * pass that claims anything: on Linux and macOS the claim folder, `.claimed/` and the source
   * folder; on Windows each claimed file, under its claimed name.
   */
  private async claim(claims: string): Promise<SourceFile[]> {
    const { dir, minAgeMs, now = Date.now, onReadError } = this.options;
    // Read on each pass, not at load, so the Windows path can be driven from any platform's tests.
    const windows = process.platform === "win32";
    const at = String(now()).padStart(15, "0");
    const taken: SourceFile[] = [];
    for (const file of await readyFiles(dir, minAgeMs, now())) {
      const place = String(taken.length).padStart(8, "0");
      const name = fitted(`${at}.${place}.${randomBytes(4).toString("hex")}-`, file.name);
      const path = join(claims, name);
      try {
        // Opened before the move, so a file that cannot be read stays where it is. On Windows it is
        // opened to write too, as flushing it below needs, so a file that cannot be flushed stays.
        const handle = await open(file.path, windows ? "r+" : "r");
        try {
          await rename(file.path, path);
        } finally {
          await handle.close();
        }
      } catch (error) {
        onReadError?.(error);
        continue;
      }
      taken.push({ name, path });
    }
    if (windows) {
      for (const file of taken) await flush(file.path, "r+");
    } else if (taken.length > 0) {
      await flush(claims, "r");
      await flush(join(dir, CLAIMED_DIR), "r");
      await flush(dir, "r");
    }
    return taken;
  }

  /** Stores a claimed file under its claimed name, then deletes it or moves it into processed/. */
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
    const id = await sink.receive(body, { idempotencyKey: `file:${file.name}`, resumed });
    // A sink that copied the body keeps none of it, and this source is done with it.
    if (copiesBodies(sink)) release(body);
    if (!keepProcessed) {
      await unlink(file.path);
      return;
    }
    const processed = join(dir, PROCESSED_DIR);
    await mkdir(processed, { recursive: true });
    const original = CLAIM_NAME.exec(file.name)?.[1] ?? file.name;
    await rename(file.path, join(processed, fitted(`${String(id)}-`, original)));
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
