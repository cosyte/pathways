import type { MetaIndexConfig } from "../config/schema.js";
import {
  isMetaStore,
  type ContentStore,
  type ContentTable,
  type MetaStore,
} from "../storage/store.js";
import { MetaIndexer, type MessageMeta, type MetaTag } from "./blind-index.js";
import {
  decryptTextWithKeyId,
  decryptWithKeyId,
  encrypt,
  encryptText,
  EncryptionError,
  isEncrypted,
  isEncryptedText,
} from "./envelope.js";
import type { KeyProvider } from "./keys.js";

/**
 * What `pathways rekey` found and did, as counts of stored values: each message body, delivery body
 * and error text is one value.
 *
 * @example
 * ```ts
 * const counts: RekeyCounts = await rekey(store, keys);
 * if (rekeyComplete(counts)) console.log("every value is under the current key");
 * ```
 */
export interface RekeyCounts {
  /** Values that were under an older master key, now re-encrypted under the current one. */
  readonly reencrypted: number;
  /** Values already under the current master key, checked and left as they were. */
  readonly current: number;
  /** Values stored while encryption was `none`, now encrypted (only with `encryptPlaintext`). */
  readonly encrypted: number;
  /** Values stored while encryption was `none`, left so (without `encryptPlaintext`). */
  readonly unencrypted: number;
  /**
   * Values that could not be decrypted, and were left as they were: they name a key that is not
   * configured, or failed their integrity check.
   */
  readonly unreadable: number;
  /** Values the engine changed while rekey ran, left for the next run. */
  readonly changed: number;
  /**
   * Messages whose metadata index tags were derived again from their decrypted metadata, under the
   * current key and the channel's `index:` block as it stands: tags under an older key, or for an
   * index added, changed or removed since the message was stored.
   */
  readonly retagged: number;
}

/**
 * Options for {@link rekey}.
 *
 * @example
 * ```ts
 * await rekey(store, keys, { encryptPlaintext: true });
 * ```
 */
export interface RekeyOptions {
  /**
   * Also encrypt values stored while encryption was `none`. Off by default, so a value whose
   * encrypted marker was damaged is reported, not taken for plaintext and encrypted as it is.
   */
  readonly encryptPlaintext?: boolean;
  /** How many rows to read at a time. */
  readonly pageSize?: number;
  /**
   * Each channel's `index:` entries, by channel name. Each message's metadata tags are derived
   * again to match them; without it, every tag is removed as the metadata is rewritten.
   */
  readonly indexes?: ReadonlyMap<string, readonly MetaIndexConfig[]> | undefined;
}

/**
 * Whether a rekey left every stored value under the current master key. On SQLite, an older key can
 * be retired once `pathways rekey` has also emptied the write-ahead log into the file
 * (`emptySqliteLog`), whose freed space the store zeroes. A database server keeps earlier row
 * versions in its logs, free space, replicas and backups for a while, still under the older key, so
 * there retire it only once the server no longer holds them. On any store, a copy or backup made
 * before the rekey holds every value under the older key: retiring that key while such a copy may
 * be restored loses every stored message in it.
 *
 * @example
 * ```ts
 * process.exitCode = rekeyComplete(await rekey(store, keys)) ? 0 : 1;
 * ```
 */
export function rekeyComplete(counts: RekeyCounts): boolean {
  return counts.unencrypted === 0 && counts.unreadable === 0 && counts.changed === 0;
}

type Outcome<T> =
  | { readonly kind: "current" | "unencrypted" | "unreadable" }
  | { readonly kind: "reencrypted" | "encrypted"; readonly value: T };

const TABLES: readonly ContentTable[] = ["messages", "deliveries"];

/**
 * Re-encrypts every stored body and error text under the provider's current master key. Once this
 * reports nothing left under an older key, that key can be retired on SQLite after the write-ahead
 * log is emptied, and on a database server only once the server no longer keeps earlier row
 * versions, and on either not while a copy made before may be restored ({@link rekeyComplete}). Each
 * value is decrypted first, which also checks its integrity; values already under the current key
 * are left as they were. A row is replaced only if the engine has not changed it meanwhile, so it is
 * safe to run while the engine runs. Returns counts only.
 *
 * @example
 * ```ts
 * const store = await Store.open(project.databaseFile);
 * const counts = await rekey(store, keys);
 * await store.close();
 * ```
 */
export async function rekey(
  store: ContentStore,
  keys: KeyProvider,
  options: RekeyOptions = {},
): Promise<RekeyCounts> {
  const encryptPlaintext = options.encryptPlaintext === true;
  const pageSize = options.pageSize ?? 100;
  const counts = {
    reencrypted: 0,
    current: 0,
    encrypted: 0,
    unencrypted: 0,
    unreadable: 0,
    changed: 0,
    retagged: 0,
  };
  if (isMetaStore(store)) {
    const indexer = new MetaIndexer(keys, options.indexes ?? new Map());
    await rekeyMeta(store, keys, indexer, { encryptPlaintext, pageSize }, counts);
  }
  for (const table of TABLES) {
    let after = 0;
    for (;;) {
      const rows = await store.storedContent(table, after, pageSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        after = row.id;
        const outcomes: Outcome<unknown>[] = [];
        const body = await rekeyBody(row.body, keys, encryptPlaintext);
        outcomes.push(body);
        let error: Outcome<string> | undefined;
        if (row.error !== null) {
          error = await rekeyText(row.error, keys, encryptPlaintext);
          outcomes.push(error);
        }
        const written = outcomes.filter((o) => o.kind === "reencrypted" || o.kind === "encrypted");
        const replaced =
          written.length > 0 &&
          (await store.replaceContent(row, {
            body: "value" in body ? body.value : row.body,
            error: error !== undefined && "value" in error ? error.value : row.error,
          }));
        for (const outcome of outcomes) {
          const writes = outcome.kind === "reencrypted" || outcome.kind === "encrypted";
          counts[writes && !replaced ? "changed" : outcome.kind] += 1;
        }
      }
    }
  }
  return counts;
}

/**
 * Re-encrypts each message's metadata under the current key, and derives its index tags again
 * when they differ from what the current key and indexes give. A message whose metadata cannot be
 * read keeps its tags.
 */
async function rekeyMeta(
  store: MetaStore,
  keys: KeyProvider,
  indexer: MetaIndexer,
  options: { readonly encryptPlaintext: boolean; readonly pageSize: number },
  counts: Record<keyof RekeyCounts, number>,
): Promise<void> {
  let after = 0;
  for (;;) {
    const rows = await store.storedMeta(after, options.pageSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.id;
      const opened = await openMeta(row.meta, keys, options.encryptPlaintext);
      if (opened.kind === "unreadable") {
        counts.unreadable += 1;
        continue;
      }
      const tags = await indexer.tagsFor(row.channel, JSON.parse(opened.text) as MessageMeta);
      const retag = !sameTags(row.tags, tags);
      const rewrite = "value" in opened;
      if (!rewrite && !retag) {
        counts[opened.kind] += 1;
        continue;
      }
      const replaced = await store.replaceMeta(row, {
        meta: rewrite ? opened.value : row.meta,
        tags,
      });
      counts[replaced ? opened.kind : "changed"] += 1;
      if (replaced && retag) counts.retagged += 1;
    }
  }
}

/** Stored metadata, decrypted, with what rekey does with its value. */
type OpenedMeta =
  | { readonly kind: "unreadable" }
  | { readonly kind: "current" | "unencrypted"; readonly text: string }
  | { readonly kind: "reencrypted" | "encrypted"; readonly text: string; readonly value: string };

async function openMeta(
  value: string,
  keys: KeyProvider,
  encryptPlaintext: boolean,
): Promise<OpenedMeta> {
  if (!isEncryptedText(value)) {
    return encryptPlaintext
      ? { kind: "encrypted", text: value, value: await encryptText(value, keys) }
      : { kind: "unencrypted", text: value };
  }
  let opened: { text: string; keyId: string };
  try {
    opened = await decryptTextWithKeyId(value, keys);
  } catch (error) {
    if (error instanceof EncryptionError) return { kind: "unreadable" };
    throw error;
  }
  if (opened.keyId === keys.currentKeyId) return { kind: "current", text: opened.text };
  return {
    kind: "reencrypted",
    text: opened.text,
    value: await encryptText(opened.text, keys),
  };
}

/** Whether two sets of tags are the same, in any order. */
function sameTags(stored: readonly MetaTag[], wanted: readonly MetaTag[]): boolean {
  const key = (tag: MetaTag): string => `${tag.index}\0${tag.keyId}\0${tag.tag}`;
  const have = new Set(stored.map(key));
  return stored.length === wanted.length && wanted.every((tag) => have.has(key(tag)));
}

async function rekeyBody(
  value: Uint8Array,
  keys: KeyProvider,
  encryptPlaintext: boolean,
): Promise<Outcome<Uint8Array>> {
  if (!isEncrypted(value)) {
    return encryptPlaintext
      ? { kind: "encrypted", value: await encrypt(value, keys) }
      : { kind: "unencrypted" };
  }
  let opened: { plaintext: Buffer; keyId: string };
  try {
    opened = await decryptWithKeyId(value, keys);
  } catch (error) {
    if (error instanceof EncryptionError) return { kind: "unreadable" };
    throw error;
  }
  const { plaintext, keyId } = opened;
  try {
    if (keyId === keys.currentKeyId) return { kind: "current" };
    return { kind: "reencrypted", value: await encrypt(plaintext, keys) };
  } finally {
    plaintext.fill(0);
  }
}

async function rekeyText(
  value: string,
  keys: KeyProvider,
  encryptPlaintext: boolean,
): Promise<Outcome<string>> {
  if (!isEncryptedText(value)) {
    return encryptPlaintext
      ? { kind: "encrypted", value: await encryptText(value, keys) }
      : { kind: "unencrypted" };
  }
  let opened: { text: string; keyId: string };
  try {
    opened = await decryptTextWithKeyId(value, keys);
  } catch (error) {
    if (error instanceof EncryptionError) return { kind: "unreadable" };
    throw error;
  }
  if (opened.keyId === keys.currentKeyId) return { kind: "current" };
  return { kind: "reencrypted", value: await encryptText(opened.text, keys) };
}
