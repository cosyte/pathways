import type { ContentStore, ContentTable } from "../storage/store.js";
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
}

/**
 * Whether a rekey left every stored value under the current master key, so every older key can be
 * retired.
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
 * Re-encrypts every stored body and error text under the provider's current master key, so an older
 * key can be retired once this reports nothing left under it. Each value is decrypted first, which
 * also checks its integrity; values already under the current key are left as they were. A row is
 * replaced only if the engine has not changed it meanwhile, so it is safe to run while the engine
 * runs. Returns counts only.
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
  };
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
