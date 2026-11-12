import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type { MessageMeta } from "../encryption/blind-index.js";
import { decrypt, encrypt } from "../encryption/envelope.js";
import type { KeyProvider } from "../encryption/keys.js";
import type {
  DeliveryStatus,
  MessageStatus,
  RetentionStep,
  RetentionStore,
} from "../storage/store.js";

/**
 * The version of the archive layout this module writes, and the only one it reads.
 *
 * @example
 * ```ts
 * ARCHIVE_FORMAT_VERSION; // 1
 * ```
 */
export const ARCHIVE_FORMAT_VERSION = 1;

/** What every archive's header names itself as. */
const ARCHIVE_FORMAT = "pathways-archive";

/** What an archive file's name ends with. */
export const ARCHIVE_EXTENSION = ".pwa";

/**
 * The first line of an archive: what it is, which channel's messages it holds, the master key it is
 * sealed under, when it was written and which retention step wrote it. `mac` is the trailer's HMAC
 * key, wrapped under that master key, in base64.
 *
 * @example
 * ```ts
 * const header: ArchiveHeader = { format: "pathways-archive", version: 1, channel: "adt", keyId: "dev", created: "2026-11-11T00:00:00.000Z", step: "metadata", mac: "..." };
 * ```
 */
export interface ArchiveHeader {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly version: typeof ARCHIVE_FORMAT_VERSION;
  readonly channel: string;
  readonly keyId: string;
  /** ISO 8601, UTC. */
  readonly created: string;
  readonly step: RetentionStep;
  readonly mac: string;
}

/**
 * One delivery of an archived message, of any generation, as storage held it: every column of its
 * row but its message's id and channel, which the record it sits in holds.
 *
 * @example
 * ```ts
 * const sent = (d: ArchivedDelivery): boolean => d.status === "delivered";
 * ```
 */
export interface ArchivedDelivery {
  readonly id: number;
  readonly destination: number;
  readonly seq: number;
  readonly generation: number;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  /** Epoch milliseconds before which it was not to be tried again; 0 when due at once. */
  readonly nextAttemptAt: number;
  readonly deliveredAt: string | null;
  /** Its last error text, which can quote the message. */
  readonly error: string | null;
  /** The output it carried, in base64; `null` once its message's content was dropped. */
  readonly body: string | null;
  /** When an attempt in flight was handed to its destination, in epoch milliseconds. */
  readonly sendingAt: number | null;
  /** The number of the attempt in flight, beside `sendingAt`. */
  readonly sendingAttempt: number | null;
  /** The latest attempt found cut off, when one was. */
  readonly interruptedAttempt: number | null;
  /**
   * The key of the destination it was made for; null when it records none. An archive written
   * before deliveries recorded one leaves it out.
   */
  readonly destinationKey: string | null;
  /** When it failed for good, when it did and the store recorded it. */
  readonly failedAt: string | null;
}

/**
 * One message in an archive: everything storage held about it when retention reached it, every
 * column of its row and of each delivery row, every generation. Bodies are base64, and `null`
 * (with no outputs) once its content was dropped. The index tags of its metadata are not kept:
 * they are derived from `meta` under the master keys.
 *
 * @example
 * ```ts
 * const body = (record: ArchivedMessage): Buffer | undefined =>
 *   record.body === null ? undefined : Buffer.from(record.body, "base64");
 * ```
 */
export interface ArchivedMessage {
  readonly id: number;
  readonly channel: string;
  readonly status: MessageStatus;
  readonly receivedAt: string;
  readonly updatedAt: string;
  readonly size: number | null;
  readonly generation: number;
  readonly duplicateOf: number | null;
  readonly contentHash: string | null;
  readonly contentDroppedAt: string | null;
  /**
   * The generation whose settled event was recorded, when one was and the store recorded it; null
   * otherwise, and in an archive written before Pathways recorded it. Read back, it is always set.
   */
  readonly settledGeneration?: number | null;
  /** The hash of who sent it and its control ID, for spotting a repeat. */
  readonly dedupKey: string | null;
  /** The hash that names it to its source, so it is stored once. */
  readonly idempotencyKey: string | null;
  /**
   * The same hash when it held its channel's claim to the key, the one message stored under it;
   * `null` when it did not. Absent from an archive an older Pathways wrote.
   */
  readonly idempotencyClaim?: string | null;
  /** Why it failed, as stored: can quote the message. */
  readonly error: string | null;
  /** Its `ctx.meta`, which can hold identifiers; `null` when it had none or it was dropped. */
  readonly meta: MessageMeta | null;
  /**
   * The channel that handed it over, the message there, the channel destination's delivery and
   * that message's generation, and how many hand-offs in a row brought it: `null` for a message
   * a source took in, and absent from an archive written before channels could hand over.
   */
  readonly parentChannel?: string | null;
  readonly parentMessage?: number | null;
  readonly parentDelivery?: number | null;
  readonly parentGeneration?: number | null;
  readonly hops?: number | null;
  /** The body as it arrived, in base64; `null` once dropped. */
  readonly body: string | null;
  /** The outputs of its current generation, in order, in base64: those of its first destination. */
  readonly outputs: readonly string[];
  /** Every delivery, every generation, oldest first, each with its body. */
  readonly deliveries: readonly ArchivedDelivery[];
}

/**
 * An archive, opened and checked.
 *
 * @example
 * ```ts
 * const { header, messages }: OpenedArchive = await openArchive(bytes, keys);
 * ```
 */
export interface OpenedArchive {
  readonly header: ArchiveHeader;
  readonly messages: readonly ArchivedMessage[];
}

/**
 * Why an archive could not be written or read:
 *
 * - `ERR_PATHWAYS_ARCHIVE_FORMAT`: it is not an archive in a layout this Pathways reads;
 * - `ERR_PATHWAYS_ARCHIVE_INTEGRITY`: its trailer does not match its records (count or HMAC), or a
 *   record names another channel than its header;
 * - `ERR_PATHWAYS_ARCHIVE_TOO_LARGE`: the file, its decompressed size or one record passes a limit
 *   of {@link ArchiveLimits}.
 *
 * Decrypting it can also fail with an `EncryptionError`, `ERR_PATHWAYS_UNKNOWN_KEY` among them.
 *
 * @example
 * ```ts
 * const code: ArchiveErrorCode = "ERR_PATHWAYS_ARCHIVE_INTEGRITY";
 * ```
 */
export type ArchiveErrorCode =
  | "ERR_PATHWAYS_ARCHIVE_FORMAT"
  | "ERR_PATHWAYS_ARCHIVE_INTEGRITY"
  | "ERR_PATHWAYS_ARCHIVE_TOO_LARGE";

const ARCHIVE_MESSAGES: Readonly<Record<ArchiveErrorCode, string>> = {
  ERR_PATHWAYS_ARCHIVE_FORMAT: "the file is not a Pathways archive this version reads",
  ERR_PATHWAYS_ARCHIVE_INTEGRITY: "the archive's trailer does not match its records",
  ERR_PATHWAYS_ARCHIVE_TOO_LARGE: "the archive passes a size limit",
};

/**
 * An archive that could not be written or read. Its message is fixed text: never a record, a key
 * or a file's content.
 *
 * @example
 * ```ts
 * try {
 *   await openArchive(bytes, keys);
 * } catch (error) {
 *   if (error instanceof ArchiveError) console.error(error.code);
 * }
 * ```
 */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;

  /** @param code Why, as {@link ArchiveErrorCode} says. */
  constructor(code: ArchiveErrorCode) {
    super(ARCHIVE_MESSAGES[code]);
    this.name = "ArchiveError";
    this.code = code;
  }
}

/**
 * The most an archive may hold when it is opened: input is untrusted until its trailer is checked.
 *
 * @example
 * ```ts
 * const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, maxRecordBytes: 1_048_576 };
 * ```
 */
export interface ArchiveLimits {
  /** The file, sealed and compressed, in bytes. */
  readonly maxFileBytes: number;
  /** The file once decompressed, in bytes. */
  readonly maxDecompressedBytes: number;
  /** One line (a record, the header or the trailer), in bytes. */
  readonly maxRecordBytes: number;
}

/**
 * The limits {@link openArchive} applies when given none: 512 MiB sealed, 1 GiB decompressed and
 * 64 MiB a record. Retention starts a new file once one holds 256 MiB, so every archive it writes
 * opens within them.
 *
 * @example
 * ```ts
 * DEFAULT_ARCHIVE_LIMITS.maxRecordBytes; // 67108864
 * ```
 */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFileBytes: 512 * 1_048_576,
  maxDecompressedBytes: 1_024 * 1_048_576,
  maxRecordBytes: 64 * 1_048_576,
};

/** How much plaintext retention puts in one archive before it starts the next, in bytes. */
export const ARCHIVE_TARGET_BYTES = 256 * 1_048_576;

/** The trailer's HMAC over the header line and every record line, each with its newline. */
function mac(key: Uint8Array, lines: readonly string[]): Buffer {
  const hmac = createHmac("sha256", key);
  for (const line of lines) hmac.update(`${line}\n`, "utf8");
  return hmac.digest();
}

/**
 * Seals messages into an archive: NDJSON with a header line, one line a message and a trailer (the
 * count, and an HMAC-SHA-256 over the header and the records under a fresh key wrapped by `keys`),
 * gzipped, then encrypted with the envelope every stored body uses, under one fresh data key.
 *
 * @example
 * ```ts
 * const bytes = await sealArchive({ channel: "adt", step: "metadata", created: new Date().toISOString(), messages }, keys);
 * ```
 */
export async function sealArchive(
  archive: {
    readonly channel: string;
    readonly step: RetentionStep;
    readonly created: string;
    readonly messages: readonly ArchivedMessage[];
  },
  keys: KeyProvider,
): Promise<Buffer> {
  const macKey = randomBytes(32);
  try {
    const wrapped = await keys.wrapKey(macKey);
    const header: ArchiveHeader = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_FORMAT_VERSION,
      channel: archive.channel,
      keyId: wrapped.keyId,
      created: archive.created,
      step: archive.step,
      mac: Buffer.from(wrapped.wrapped).toString("base64"),
    };
    const lines = [JSON.stringify(header), ...archive.messages.map((m) => JSON.stringify(m))];
    const trailer = {
      trailer: true,
      count: archive.messages.length,
      hmac: mac(macKey, lines).toString("hex"),
    };
    lines.push(JSON.stringify(trailer));
    const plain = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const packed = gzipSync(plain);
    plain.fill(0);
    return await encrypt(packed, keys);
  } finally {
    macKey.fill(0);
  }
}

/**
 * Opens an archive {@link sealArchive} wrote, checking everything before it returns a record: the
 * sizes against `limits`, the envelope, the header, each record's shape and channel, and the
 * trailer's count and HMAC.
 *
 * @throws {ArchiveError} as {@link ArchiveErrorCode} says.
 * @throws {EncryptionError} when the envelope fails, `ERR_PATHWAYS_UNKNOWN_KEY` for a master key
 *   `keys` does not hold.
 * @example
 * ```ts
 * const { header, messages } = await openArchive(await readFile(file), keys);
 * ```
 */
export async function openArchive(
  bytes: Uint8Array,
  keys: KeyProvider,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<OpenedArchive> {
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_TOO_LARGE");
  }
  const packed = await decrypt(bytes, keys);
  let plain: Buffer;
  try {
    plain = gunzipSync(packed, { maxOutputLength: limits.maxDecompressedBytes });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_TOO_LARGE");
    }
    throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_FORMAT");
  } finally {
    packed.fill(0);
  }
  try {
    return await readLines(plain, keys, limits);
  } finally {
    plain.fill(0);
  }
}

/** The archive's lines, parsed and checked. */
async function readLines(
  plain: Buffer,
  keys: KeyProvider,
  limits: ArchiveLimits,
): Promise<OpenedArchive> {
  const lines: string[] = [];
  let start = 0;
  while (start < plain.length) {
    let end = plain.indexOf(0x0a, start);
    if (end === -1) end = plain.length;
    if (end - start > limits.maxRecordBytes)
      throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_TOO_LARGE");
    lines.push(plain.toString("utf8", start, end));
    start = end + 1;
  }
  if (lines.length < 2) throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_FORMAT");
  const header = asHeader(parse(lines[0] as string));
  const trailer = asTrailer(parse(lines.at(-1) as string));
  const body = lines.slice(1, -1);
  const macKey = await keys.unwrapKey(header.keyId, Buffer.from(header.mac, "base64"));
  let expected: Buffer;
  try {
    expected = mac(macKey, [lines[0] as string, ...body]);
  } finally {
    macKey.fill(0);
  }
  const given = Buffer.from(trailer.hmac, "hex");
  if (
    trailer.count !== body.length ||
    given.length !== expected.length ||
    !timingSafeEqual(given, expected)
  ) {
    throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_INTEGRITY");
  }
  const messages = body.map((line) => asMessage(parse(line)));
  if (messages.some((message) => message.channel !== header.channel)) {
    throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_INTEGRITY");
  }
  return { header, messages };
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_FORMAT");
  }
}

type Fields = Readonly<Record<string, unknown>>;

function object(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_FORMAT");
  }
  return value as Fields;
}

function check(ok: boolean): void {
  if (!ok) throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_FORMAT");
}

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === "string";
const isWhole = (value: unknown): value is number => Number.isSafeInteger(value);
const isWholeOrNull = (value: unknown): boolean => value === null || Number.isSafeInteger(value);
const isMetaValue = (value: unknown): boolean =>
  typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);
const isMetaOrNull = (value: unknown): boolean =>
  value === null ||
  (typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isMetaValue));
const STEPS: readonly unknown[] = ["content", "metadata", "failed"];

function asHeader(value: unknown): ArchiveHeader {
  const fields = object(value);
  check(fields["format"] === ARCHIVE_FORMAT && fields["version"] === ARCHIVE_FORMAT_VERSION);
  check(isText(fields["channel"]) && isText(fields["keyId"]) && isText(fields["created"]));
  check(STEPS.includes(fields["step"]) && isText(fields["mac"]));
  return fields as unknown as ArchiveHeader;
}

function asTrailer(value: unknown): { readonly count: number; readonly hmac: string } {
  const fields = object(value);
  check(fields["trailer"] === true && isWhole(fields["count"]) && isText(fields["hmac"]));
  return fields as unknown as { count: number; hmac: string };
}

function asMessage(value: unknown): ArchivedMessage {
  const fields = object(value);
  check(isWhole(fields["id"]) && isText(fields["channel"]) && isText(fields["status"]));
  check(isText(fields["receivedAt"]) && isText(fields["updatedAt"]));
  check(isWholeOrNull(fields["size"]) && isWhole(fields["generation"]));
  check(isWholeOrNull(fields["duplicateOf"]) && isTextOrNull(fields["contentHash"]));
  check(isTextOrNull(fields["contentDroppedAt"]) && isTextOrNull(fields["error"]));
  check(fields["settledGeneration"] === undefined || isWholeOrNull(fields["settledGeneration"]));
  check(isTextOrNull(fields["dedupKey"]) && isTextOrNull(fields["idempotencyKey"]));
  check(isTextOrNull(fields["body"]) && isMetaOrNull(fields["meta"]));
  check(fields["parentChannel"] === undefined || isTextOrNull(fields["parentChannel"]));
  for (const key of ["parentMessage", "parentDelivery", "parentGeneration", "hops"]) {
    check(fields[key] === undefined || isWholeOrNull(fields[key]));
  }
  check(fields["idempotencyClaim"] === undefined || isTextOrNull(fields["idempotencyClaim"]));
  const outputs = fields["outputs"];
  check(Array.isArray(outputs) && outputs.every(isText));
  const deliveries = fields["deliveries"];
  check(Array.isArray(deliveries));
  for (const delivery of deliveries as unknown[]) {
    const d = object(delivery);
    check(isWhole(d["id"]) && isWhole(d["destination"]) && isWhole(d["seq"]));
    check(isWhole(d["generation"]) && isText(d["status"]) && isWhole(d["attempts"]));
    check(isTextOrNull(d["deliveredAt"]) && isTextOrNull(d["error"]));
    check(isWhole(d["nextAttemptAt"]) && isTextOrNull(d["body"]));
    check(isWholeOrNull(d["sendingAt"]) && isWholeOrNull(d["sendingAttempt"]));
    check(isWholeOrNull(d["interruptedAttempt"]));
    check(d["destinationKey"] === undefined || isTextOrNull(d["destinationKey"]));
    check(d["failedAt"] === undefined || isTextOrNull(d["failedAt"]));
  }
  return { settledGeneration: null, ...fields } as unknown as ArchivedMessage;
}

/**
 * Reads one message as an archive record, every column of its row and of each delivery row,
 * through `store`, so its bodies, texts and metadata come back decrypted; `undefined` when it is
 * gone.
 *
 * @example
 * ```ts
 * const record = await archivedMessage(store, 12);
 * ```
 */
export async function archivedMessage(
  store: Pick<RetentionStore, "archiveRows">,
  id: number,
): Promise<ArchivedMessage | undefined> {
  const rows = await store.archiveRows(id);
  if (rows === undefined) return undefined;
  const { message } = rows;
  const base64 = (bytes: Uint8Array | null): string | null =>
    bytes === null
      ? null
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  // The current generation's outputs, as storage reads them: the first destination's, in order.
  const current = rows.deliveries.filter(
    (delivery) => delivery.generation === message.generation && delivery.body !== null,
  );
  const first = Math.min(...current.map((delivery) => delivery.destination));
  return {
    id: message.id,
    channel: message.channel,
    status: message.status,
    receivedAt: message.receivedAt,
    updatedAt: message.updatedAt,
    size: message.size,
    generation: message.generation,
    duplicateOf: message.duplicateOf,
    contentHash: message.contentHash,
    contentDroppedAt: message.contentDroppedAt,
    settledGeneration: message.settledGeneration ?? null,
    dedupKey: message.dedupKey,
    idempotencyKey: message.idempotencyKey,
    idempotencyClaim: message.idempotencyClaim,
    error: message.error,
    meta: message.meta === null ? null : (JSON.parse(message.meta) as MessageMeta),
    parentChannel: message.parentChannel ?? null,
    parentMessage: message.parentMessage ?? null,
    parentDelivery: message.parentDelivery ?? null,
    parentGeneration: message.parentGeneration ?? null,
    hops: message.hops ?? null,
    body: base64(message.body),
    outputs: current
      .filter((delivery) => delivery.destination === first)
      .sort((a, b) => a.seq - b.seq)
      .map((delivery) => base64(delivery.body) as string),
    deliveries: rows.deliveries.map((delivery) => ({
      id: delivery.id,
      destination: delivery.destination,
      seq: delivery.seq,
      generation: delivery.generation,
      status: delivery.status,
      attempts: delivery.attempts,
      nextAttemptAt: delivery.nextAttemptAt,
      deliveredAt: delivery.deliveredAt,
      error: delivery.error,
      body: base64(delivery.body),
      sendingAt: delivery.sendingAt,
      sendingAttempt: delivery.sendingAttempt,
      interruptedAttempt: delivery.interruptedAttempt,
      destinationKey: delivery.destinationKey,
      failedAt: delivery.failedAt ?? null,
    })),
  };
}

/**
 * The file operations writing an archive takes, each a step of its own so a test can fail it:
 * {@link LOCAL_ARCHIVE_FILES} on this machine.
 *
 * @example
 * ```ts
 * const files: ArchiveFiles = { ...LOCAL_ARCHIVE_FILES, sync: () => Promise.reject(new Error("EIO")) };
 * ```
 */
export interface ArchiveFiles {
  /** Makes the folder, and those above it, readable by this user alone. */
  makeDir(dir: string): Promise<void>;
  /** Creates `path`, which must not exist, readable by this user alone, and writes `bytes`. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Flushes the file `path` to disk. */
  sync(path: string): Promise<void>;
  /** Renames `from` to `to`. */
  rename(from: string, to: string): Promise<void>;
  /** Flushes the folder `dir` to disk, so a file renamed into it stays there after a power cut. */
  syncDir(dir: string): Promise<void>;
  /** Reads `path` back whole. */
  read(path: string): Promise<Uint8Array>;
  /** Removes `path` when it is there. */
  remove(path: string): Promise<void>;
}

/** How a file is opened to flush it: on Windows, `fsync` needs a handle that can write. */
/* v8 ignore next */
const FILE_FLUSH = process.platform === "win32" ? "r+" : "r";

/** Opens `path` with `flags` and flushes it to disk. */
async function flush(path: string, flags: "r" | "r+"): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The archive file operations on this machine's disk. A folder is not flushed on Windows, which
 * cannot open one to flush it; there the file, opened to write, is flushed with its name.
 *
 * @example
 * ```ts
 * await writeArchive({ dir, channel: "adt", step: "metadata", messages, keys, now: new Date(), files: LOCAL_ARCHIVE_FILES });
 * ```
 */
export const LOCAL_ARCHIVE_FILES: ArchiveFiles = {
  /** Makes the folder, readable by this user alone. */
  makeDir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  /** Creates the file, readable by this user alone, refusing one already there. */
  write: async (path, bytes) => {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  },
  /** Flushes the file: on Windows, `fsync` needs a handle that can write. */
  sync: (path) => flush(path, FILE_FLUSH),
  /** Renames the file. */
  rename: (from, to) => rename(from, to),
  /** Flushes the folder, except on Windows. */
  syncDir: async (dir) => {
    /* v8 ignore next: Windows cannot open a folder to flush it */
    if (process.platform === "win32") return;
    await flush(dir, "r");
  },
  /** Reads the file whole. */
  read: (path) => readFile(path),
  /** Removes the file, when it is there. */
  remove: (path) => rm(path, { force: true }),
};

/**
 * An archive written and checked: its path and how many messages it holds.
 *
 * @example
 * ```ts
 * const line = (written: WrittenArchive): string => `${written.messages} in ${written.file}`;
 * ```
 */
export interface WrittenArchive {
  readonly file: string;
  readonly messages: number;
}

/**
 * A channel name as one folder name: every character but letters, digits, `_` and `-` escaped, a
 * dot among them, so no name walks out of the archive folder.
 */
function folderName(channel: string): string {
  return channel.replaceAll(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
}

/**
 * Writes messages to a new archive under `dir/<channel>/` and proves it before anyone relies on it:
 * sealed ({@link sealArchive}), written to a `.partial` file, flushed, renamed to its name, the
 * folder flushed, then read back and opened, its trailer checked and its message ids compared with
 * what was written. A failure at any step removes what it wrote and rejects, so a caller deletes
 * nothing.
 *
 * @throws {ArchiveError} when the file read back does not hold what was written.
 * @example
 * ```ts
 * const { file } = await writeArchive({ dir, channel: "adt", step: "metadata", messages, keys, now: new Date() });
 * ```
 */
export async function writeArchive(options: {
  readonly dir: string;
  readonly channel: string;
  readonly step: RetentionStep;
  readonly messages: readonly ArchivedMessage[];
  readonly keys: KeyProvider;
  readonly now: Date;
  readonly files?: ArchiveFiles | undefined;
}): Promise<WrittenArchive> {
  const { dir, channel, step, messages, keys, now } = options;
  const files = options.files ?? LOCAL_ARCHIVE_FILES;
  const created = now.toISOString();
  const folder = join(dir, folderName(channel));
  // Named by the ids it holds, lowest and highest: retention lists them in order.
  const first = String(messages[0]?.id);
  const last = String(messages.at(-1)?.id);
  const stamp = created.replaceAll(/[-:.]/g, "");
  const name = `${stamp}-${step}-${first}-${last}-${randomBytes(4).toString("hex")}`;
  const file = join(folder, `${name}${ARCHIVE_EXTENSION}`);
  const partial = `${file}.partial`;
  const sealed = await sealArchive({ channel, step, created, messages }, keys);
  await files.makeDir(folder);
  try {
    await files.write(partial, sealed);
    await files.sync(partial);
    await files.rename(partial, file);
    await files.syncDir(folder);
    const back = await openArchive(await files.read(file), keys);
    const ids = back.messages.map((message) => message.id);
    if (
      back.header.channel !== channel ||
      ids.length !== messages.length ||
      ids.some((id, index) => id !== messages[index]?.id)
    ) {
      throw new ArchiveError("ERR_PATHWAYS_ARCHIVE_INTEGRITY");
    }
  } catch (error) {
    // An archive that did not prove itself is not one: nothing is deleted on its strength.
    await files.remove(partial).catch(() => undefined);
    await files.remove(file).catch(() => undefined);
    throw error;
  }
  return { file, messages: messages.length };
}
