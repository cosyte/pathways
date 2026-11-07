import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DestinationConnector,
  MessageSink,
  OutgoingMessage,
  SourceConnector,
} from "./types.js";

/** The folder inside a file source where files go once stored. */
export const PROCESSED_DIR = "processed";

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
  return ready.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Options for a {@link FileSource}. */
export interface FileSourceOptions {
  readonly dir: string;
  readonly minAgeMs: number;
  /** Epoch milliseconds now. */
  readonly now?: () => number;
  /** Told when a ready file cannot be read; it stays where it is for the next pass. */
  readonly onReadError?: (error: unknown) => void;
}

/**
 * Reads each file that lands in a folder as one message. Once a message is stored, its file moves
 * into the folder's `processed/` subfolder, prefixed with the message id so names never collide.
 *
 * @example
 * ```ts
 * const source = new FileSource({ dir: "./inbox", minAgeMs: 1_000 });
 * await source.poll({ receive: async (body) => store.receive("adt-to-lab", body) });
 * ```
 */
export class FileSource implements SourceConnector {
  private readonly options: FileSourceOptions;

  /** @param options The folder to read and how long a file must sit before it is read. */
  constructor(options: FileSourceOptions) {
    this.options = options;
  }

  /** Stores every ready file through `sink`, moving each into `processed/` once it is stored. */
  async poll(sink: MessageSink): Promise<void> {
    const { dir, minAgeMs, now = Date.now, onReadError } = this.options;
    for (const file of await readyFiles(dir, minAgeMs, now())) {
      let body: Uint8Array;
      try {
        body = new Uint8Array(await readFile(file.path));
      } catch (error) {
        onReadError?.(error);
        continue;
      }
      const id = await sink.receive(body);
      const processed = join(dir, PROCESSED_DIR);
      await mkdir(processed, { recursive: true });
      await rename(file.path, join(processed, `${id}-${file.name}`));
    }
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
