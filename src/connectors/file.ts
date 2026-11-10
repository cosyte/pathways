import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
 * The hidden folder inside a file source where a file waits while it is being stored. A file is
 * moved here before it is read, and deleted (or moved into `processed/`) once it is stored, so a
 * file found here at start was taken in by a run that stopped part way.
 */
export const CLAIMED_DIR = ".claimed";

/**
 * A claimed file's name: the claim's time in epoch milliseconds, 15 digits so names sort by it, a
 * random part, then the file's own name.
 */
const CLAIM_NAME = /^\d{15}\.[0-9a-f]{12}-(.+)$/s;

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

/** Options for a {@link FileSource}. */
export interface FileSourceOptions {
  readonly dir: string;
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
 * Each ready file is opened, moved into the hidden `.claimed/` folder under a name of its own, read,
 * and stored with that name as its idempotency key, then deleted. A file that cannot be opened stays
 * where it is. A run that stops after the store and before the delete leaves the file in
 * `.claimed/`; the next pass hands it in again under the same key, marked `resumed`, the store
 * answers with the message it already holds, and the file is deleted. So nothing is lost and
 * nothing is stored twice. With `keepProcessed`, the file moves into `processed/`, prefixed with
 * the message id, instead of being deleted.
 *
 * @example
 * ```ts
 * const source = new FileSource({ dir: "./inbox", minAgeMs: 1_000 });
 * await source.poll({ receive: async (body, options) => store.receive("adt-to-lab", body, options) });
 * ```
 */
export class FileSource implements SourceConnector {
  private readonly options: FileSourceOptions;

  /** @param options The folder to read, how long a file must sit before it is read, and what to keep. */
  constructor(options: FileSourceOptions) {
    this.options = options;
  }

  /**
   * Stores what an earlier run claimed and did not finish, then every ready file, each through
   * `sink`. A file is deleted (or moved into `processed/`) only once `sink` has stored it.
   */
  async poll(sink: MessageSink): Promise<void> {
    const { dir, minAgeMs, now = Date.now, onReadError } = this.options;
    const claimed = join(dir, CLAIMED_DIR);
    await mkdir(claimed, { recursive: true });
    const unfinished = (await readdir(claimed, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, path: join(claimed, entry.name) }));
    for (const file of byName(unfinished)) {
      let body: Uint8Array;
      try {
        body = new Uint8Array(await readFile(file.path));
      } catch (error) {
        onReadError?.(error);
        continue;
      }
      // An earlier run may have stored it before it stopped: the store looks its key up.
      await this.store(file, body, sink, true);
    }
    for (const file of await readyFiles(dir, minAgeMs, now())) {
      const at = String(now()).padStart(15, "0");
      const name = `${at}.${randomBytes(6).toString("hex")}-${file.name}`;
      const path = join(claimed, name);
      let body: Uint8Array;
      try {
        // Opened before the move, so a file that cannot be read stays where it is; read through
        // the open handle after it, so what is stored is what sits in .claimed/.
        const handle = await open(file.path, "r");
        try {
          await rename(file.path, path);
          body = new Uint8Array(await handle.readFile());
        } finally {
          await handle.close();
        }
      } catch (error) {
        onReadError?.(error);
        continue;
      }
      await this.store({ name, path }, body, sink, false);
    }
  }

  /** Stores a claimed file under its claimed name, then deletes it or moves it into processed/. */
  private async store(
    file: SourceFile,
    body: Uint8Array,
    sink: MessageSink,
    resumed: boolean,
  ): Promise<void> {
    const { dir, keepProcessed = false } = this.options;
    const id = await sink.receive(body, { idempotencyKey: `file:${file.name}`, resumed });
    if (!keepProcessed) {
      await unlink(file.path);
      return;
    }
    const processed = join(dir, PROCESSED_DIR);
    await mkdir(processed, { recursive: true });
    const original = CLAIM_NAME.exec(file.name)?.[1] ?? file.name;
    await rename(file.path, join(processed, `${String(id)}-${original}`));
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
