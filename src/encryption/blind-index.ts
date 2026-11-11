import { createHmac, createSecretKey, type KeyObject } from "node:crypto";

import { ConfigError } from "../config/load.js";
import type { MetaIndexConfig, ProjectConfig } from "../config/schema.js";
import type { KeyProvider } from "./keys.js";

export {
  DEFAULT_INDEX_BITS,
  isLowEntropyKey,
  MAX_INDEX_BITS,
  MIN_INDEX_BITS,
} from "../config/meta-index.js";

/**
 * A message's metadata: flat values by key, as `ctx.meta` holds them. Stored encrypted with the
 * message; the keys a channel's `index:` block names are also stored as truncated index tags, so a
 * search can find them without decrypting every row.
 *
 * @example
 * ```ts
 * const meta: MessageMeta = { mrn: "SYN-000123", visit: 2 };
 * ```
 */
export type MessageMeta = Readonly<Record<string, string | number | boolean>>;

/**
 * One index tag, as storage keeps it: the index (the metadata key it covers), the master key id it
 * was derived under, and the tag, the first `bits` bits of an HMAC-SHA-256 in lowercase hex.
 *
 * @example
 * ```ts
 * const tag: MetaTag = { index: "mrn", keyId: "prod-2026", tag: "a3f0" };
 * ```
 */
export interface MetaTag {
  readonly index: string;
  readonly keyId: string;
  readonly tag: string;
}

/**
 * What a metadata search looks up for one condition: the index, and its tag under each master key
 * id the provider holds. A row matches the condition when it carries any of them.
 *
 * @example
 * ```ts
 * const condition: MetaCondition = { index: "mrn", tags: [{ keyId: "prod-2026", tag: "a3f0" }] };
 * ```
 */
export interface MetaCondition {
  readonly index: string;
  readonly tags: readonly { readonly keyId: string; readonly tag: string }[];
}

/**
 * The HKDF `info` of one index's key: a fixed label, then the master key id, the channel and the
 * index, each ended by a zero byte, so no two indexes, channels or master keys share a key.
 *
 * @example
 * ```ts
 * const info = indexKeyInfo("prod-2026", "adt", "mrn");
 * ```
 */
export function indexKeyInfo(keyId: string, channel: string, index: string): Buffer {
  return Buffer.from(`pathways index v1\0${keyId}\0${channel}\0${index}\0`, "utf8");
}

/**
 * The value an index tags: the metadata value as text, so `42` and `"42"` tag alike, and a search
 * typed on the command line finds a number.
 *
 * @example
 * ```ts
 * metaText(42); // "42"
 * ```
 */
export function metaText(value: string | number | boolean): string {
  return String(value);
}

/**
 * The tag of `value` under one index key: its HMAC-SHA-256, cut to its first `bits` bits, in
 * lowercase hex (the bits past `bits` in the last byte are zero).
 *
 * @example
 * ```ts
 * indexTag(key, "SYN-000123", 12).length; // 4
 * ```
 */
export function indexTag(key: KeyObject, value: string, bits: number): string {
  const mac = createHmac("sha256", key).update(value, "utf8").digest();
  const bytes = Math.ceil(bits / 8);
  const cut = mac.subarray(0, bytes);
  const spare = bytes * 8 - bits;
  // The last byte keeps its top bits only.
  cut[bytes - 1] = (cut[bytes - 1] as number) & ((0xff << spare) & 0xff);
  return cut.toString("hex");
}

/**
 * Each channel's indexes, by channel name, from a loaded project: only the channels that have any.
 *
 * @example
 * ```ts
 * const indexes = projectIndexes(project);
 * ```
 */
export function projectIndexes(
  project: Pick<ProjectConfig, "channels">,
): ReadonlyMap<string, readonly MetaIndexConfig[]> {
  const indexes = new Map<string, readonly MetaIndexConfig[]>();
  for (const channel of project.channels) {
    if (channel.indexes !== undefined && channel.indexes.length > 0) {
      indexes.set(channel.name, channel.indexes);
    }
  }
  return indexes;
}

/**
 * Checks that `keys` can derive index keys when any channel has an index: a provider whose master
 * keys never leave a key service may not.
 *
 * @throws {ConfigError} naming each channel with an index when it cannot.
 * @example
 * ```ts
 * checkIndexKeys(keys, projectIndexes(project));
 * ```
 */
export function checkIndexKeys(
  keys: KeyProvider,
  indexes: ReadonlyMap<string, readonly MetaIndexConfig[]>,
): void {
  if (indexes.size > 0 && typeof keys.deriveIndexKey !== "function") {
    throw new ConfigError([
      `channels/${[...indexes.keys()].join(", channels/")}: index: the key provider cannot derive index keys (it has no deriveIndexKey); remove the index: block, or use a provider that has one`,
    ]);
  }
}

/**
 * Computes the index tags of a message's metadata, and the tags a search looks for. Each index has
 * a key of its own, derived from a master key by its id, the channel and the index name with
 * HKDF-SHA-256 (the provider's {@link KeyProvider.deriveIndexKey}), so a tag of one index says
 * nothing about another's, and the same value tags differently in two channels.
 *
 * Tags are truncated to the index's `bits`, so many values share each tag: two rows with the same
 * tag may hold different values, and a search confirms every row it finds by decrypting its
 * metadata. With `bits` set to `b`, a row that does not match carries the searched tag with chance
 * 1 in 2^b, so a search over `n` rows reads about `n / 2^b` rows that it then drops.
 *
 * @example
 * ```ts
 * const indexer = new MetaIndexer(keys, projectIndexes(project));
 * const tags = await indexer.tagsFor("adt", { mrn: "SYN-000123" });
 * ```
 */
export class MetaIndexer {
  readonly #keys: KeyProvider;
  readonly #indexes: ReadonlyMap<string, readonly MetaIndexConfig[]>;
  readonly #derived = new Map<string, Promise<KeyObject>>();

  /**
   * @param keys The master keys the index keys are derived from.
   * @param indexes Each channel's indexes, by channel name.
   * @throws {ConfigError} when a channel has an index and `keys` cannot derive index keys.
   */
  constructor(keys: KeyProvider, indexes: ReadonlyMap<string, readonly MetaIndexConfig[]>) {
    checkIndexKeys(keys, indexes);
    this.#keys = keys;
    this.#indexes = indexes;
  }

  /** The indexes of `channel`, none when it has none. */
  indexesOf(channel: string): readonly MetaIndexConfig[] {
    return this.#indexes.get(channel) ?? [];
  }

  /**
   * The tags of `meta` under the current master key: one for each index of `channel` whose key
   * `meta` holds.
   */
  async tagsFor(channel: string, meta: MessageMeta): Promise<MetaTag[]> {
    const keyId = this.#keys.currentKeyId;
    const tags: MetaTag[] = [];
    for (const index of this.indexesOf(channel)) {
      const value = meta[index.key];
      if (value === undefined) continue;
      const key = await this.#indexKey(keyId, channel, index.key);
      tags.push({ index: index.key, keyId, tag: indexTag(key, metaText(value), index.bits) });
    }
    return tags;
  }

  /**
   * What a search for `value` under the index `index` of `channel` looks for: its tag under every
   * master key id the provider holds. Undefined when `channel` has no such index.
   */
  async condition(
    channel: string,
    index: string,
    value: string,
  ): Promise<MetaCondition | undefined> {
    const config = this.indexesOf(channel).find((candidate) => candidate.key === index);
    if (config === undefined) return undefined;
    const ids = this.#keys.keyIds ?? [this.#keys.currentKeyId];
    const tags: { keyId: string; tag: string }[] = [];
    for (const keyId of ids) {
      const key = await this.#indexKey(keyId, channel, index);
      tags.push({ keyId, tag: indexTag(key, value, config.bits) });
    }
    return { index, tags };
  }

  /** One index's key, derived once and kept as a `KeyObject`, which never prints its bytes. */
  #indexKey(keyId: string, channel: string, index: string): Promise<KeyObject> {
    const name = `${keyId}\0${channel}\0${index}`;
    let key = this.#derived.get(name);
    if (key === undefined) {
      key = this.#derive(keyId, channel, index);
      this.#derived.set(name, key);
      // A failure is not kept, so the next call tries again.
      void key.catch(() => this.#derived.delete(name));
    }
    return key;
  }

  async #derive(keyId: string, channel: string, index: string): Promise<KeyObject> {
    // The constructor checked the provider has it whenever there is an index to derive a key for.
    const keys = this.#keys as Required<Pick<KeyProvider, "deriveIndexKey">>;
    const bytes = await keys.deriveIndexKey(keyId, indexKeyInfo(keyId, channel, index));
    try {
      return createSecretKey(bytes);
    } finally {
      bytes.fill(0);
    }
  }
}
