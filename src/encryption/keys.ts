import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { ConfigError } from "../config/load.js";
import type { EncryptionConfig } from "../config/schema.js";
import { secretPlace, secretsOf, type SecretReader } from "../secrets/resolve.js";
import { EncryptionError } from "./envelope.js";

/**
 * A data key, wrapped by a master key.
 *
 * @example
 * ```ts
 * const { keyId, wrapped }: WrappedKey = await keys.wrapKey(dataKey);
 * ```
 */
export interface WrappedKey {
  /**
   * The id of the master key that wrapped it, stored beside the value so the value can still be
   * read after another key becomes current. Printable ASCII with no space, 1 to 255 characters.
   */
  readonly keyId: string;
  /** The data key, encrypted by that master key, in the provider's own layout: 1 to 65,535 bytes. */
  readonly wrapped: Uint8Array;
}

/**
 * Where master keys live. Pathways encrypts each stored value with a fresh data key and asks the
 * provider to wrap that key under its current master key; to read the value back, it asks the
 * provider to unwrap it. A master key never has to leave the provider, so a cloud key service (AWS
 * KMS, Azure Key Vault, Google Cloud KMS) can implement this interface by calling its own encrypt
 * and decrypt. The built-in provider holds keys read from files or environment variables.
 *
 * Rotation is the provider's to offer: it keeps unwrapping data keys under its older master keys
 * while it wraps new ones under the current key.
 *
 * Pathways overwrites a data key with zeros once it is done with it: `wrapKey` must not keep the
 * key it is given, and `unwrapKey` must return a buffer of its own.
 *
 * @example
 * ```ts
 * const kms: KeyProvider = {
 *   currentKeyId: "kms-2026-11",
 *   wrapKey: async (dataKey) => ({ keyId: "kms-2026-11", wrapped: await myKms.encrypt(dataKey) }),
 *   unwrapKey: async (_keyId, wrapped) => myKms.decrypt(wrapped),
 * };
 * ```
 */
export interface KeyProvider {
  /** The id of the master key that wraps new data keys. */
  readonly currentKeyId: string;
  /** Wraps a 32-byte data key under the current master key. */
  wrapKey(dataKey: Uint8Array): Promise<WrappedKey>;
  /**
   * Unwraps a data key that the master key `keyId` wrapped, returning its 32 bytes. Rejects with an
   * {@link EncryptionError}: `ERR_PATHWAYS_UNKNOWN_KEY` when it holds no key `keyId`,
   * `ERR_PATHWAYS_INTEGRITY` when the wrapped key fails its check.
   */
  unwrapKey(keyId: string, wrapped: Uint8Array): Promise<Uint8Array>;
}

/**
 * How long a master key is: 32 bytes, for AES-256.
 *
 * @example
 * ```ts
 * randomBytes(KEY_BYTES);
 * ```
 */
export const KEY_BYTES = 32;

/** 32 bytes in standard base64: 43 characters and one `=`. */
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;

/** The built-in provider wraps each data key with AES-256-GCM: a 12-byte nonce, then the key, then the tag. */
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const WRAPPED_BYTES = WRAP_NONCE_BYTES + KEY_BYTES + WRAP_TAG_BYTES;

/**
 * A new master key: 32 random bytes in base64, as a key file or environment variable holds one.
 * `openssl rand -base64 32` makes the same.
 *
 * @example
 * ```ts
 * await writeFile(".pathways/dev.key", `${generateKey()}\n`, { mode: 0o600 });
 * ```
 */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * Reads a master key from the text of a key file or environment variable: 32 bytes in base64, with
 * any whitespace around it ignored. Returns undefined for anything else.
 *
 * @example
 * ```ts
 * decodeKey(generateKey())?.byteLength; // 32
 * decodeKey("not a key"); // undefined
 * ```
 */
export function decodeKey(text: string): Buffer | undefined {
  const trimmed = text.trim();
  return BASE64_KEY.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined;
}

/**
 * The built-in {@link KeyProvider}: master keys held in memory, read from files or environment
 * variables when the engine starts. Each data key is wrapped with AES-256-GCM under the current key,
 * with the key's id authenticated alongside. The keys sit in `KeyObject`s, which never print their
 * bytes.
 *
 * @example
 * ```ts
 * const keys = new LocalKeyProvider([["dev", decodeKey(await readFile(".pathways/dev.key", "utf8"))!]], "dev");
 * ```
 */
export class LocalKeyProvider implements KeyProvider {
  readonly currentKeyId: string;
  readonly #keys: ReadonlyMap<string, KeyObject>;

  /**
   * @param keys Each master key's id and its 32 bytes. The bytes are copied, so the caller can
   *   overwrite its own.
   * @param current The id of the key that wraps new data keys.
   * @throws {RangeError} when a key is not 32 bytes or `current` names no key.
   */
  constructor(keys: Iterable<readonly [string, Uint8Array]>, current: string) {
    const map = new Map<string, KeyObject>();
    for (const [id, bytes] of keys) {
      if (bytes.byteLength !== KEY_BYTES) {
        throw new RangeError(`the master key ${id} is not ${KEY_BYTES} bytes`);
      }
      map.set(id, createSecretKey(bytes));
    }
    if (!map.has(current)) throw new RangeError(`no master key has the id ${current}`);
    this.#keys = map;
    this.currentKeyId = current;
  }

  /** Wraps `dataKey` under the current master key. */
  wrapKey(dataKey: Uint8Array): Promise<WrappedKey> {
    // The work is synchronous; a Promise turns anything it throws into a rejection.
    return new Promise((resolve) => resolve(this.wrapNow(dataKey)));
  }

  /** Unwraps a data key that the master key `keyId` wrapped. */
  unwrapKey(keyId: string, wrapped: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve) => resolve(this.unwrapNow(keyId, wrapped)));
  }

  private wrapNow(dataKey: Uint8Array): WrappedKey {
    const keyId = this.currentKeyId;
    const nonce = randomBytes(WRAP_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key(keyId), nonce, {
      authTagLength: WRAP_TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(keyId, "latin1"));
    const sealed = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return { keyId, wrapped: Buffer.concat([nonce, sealed, cipher.getAuthTag()]) };
  }

  private unwrapNow(keyId: string, wrapped: Uint8Array): Buffer {
    const key = this.#keys.get(keyId);
    if (key === undefined) throw new EncryptionError("ERR_PATHWAYS_UNKNOWN_KEY", keyId);
    if (wrapped.byteLength !== WRAPPED_BYTES) {
      throw new EncryptionError("ERR_PATHWAYS_INTEGRITY", keyId);
    }
    const decipher = createDecipheriv("aes-256-gcm", key, wrapped.subarray(0, WRAP_NONCE_BYTES), {
      authTagLength: WRAP_TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(keyId, "latin1"));
    decipher.setAuthTag(wrapped.subarray(WRAPPED_BYTES - WRAP_TAG_BYTES));
    const dataKey = decipher.update(
      wrapped.subarray(WRAP_NONCE_BYTES, WRAP_NONCE_BYTES + KEY_BYTES),
    );
    try {
      return Buffer.concat([dataKey, decipher.final()]);
    } catch {
      dataKey.fill(0);
      throw new EncryptionError("ERR_PATHWAYS_INTEGRITY", keyId);
    }
  }

  private key(id: string): KeyObject {
    // The constructor checked that the current key is there.
    return this.#keys.get(id) as KeyObject;
  }
}

/** What `start` and `validate` say when `pathways.yaml` does not set `encryption`. */
export const ENCRYPTION_REQUIRED =
  "pathways.yaml: encryption: required to start the engine: set encryption: { keys: [{ id, env: NAME }, { id, file: path } or { id, secret: { provider, name } }], current: id } or { provider: { module: path } } to encrypt stored messages, or encryption: none to store them unencrypted";

/**
 * The master keys `pathways start` encrypts with: read now, at startup, from each key's environment
 * variable, file or secret provider. Undefined for `encryption: none`. A custom provider (`encryption: { provider }`)
 * is loaded by `startingKeys` in `src/storage/open.ts` instead.
 *
 * @throws {ConfigError} when `pathways.yaml` does not set `encryption`, or a key cannot be read (see
 *   {@link readMasterKeys}).
 * @example
 * ```ts
 * const keys = keysToStart(project.encryption, process.env);
 * const store = keys === undefined ? new UnencryptedStore(raw) : new EncryptedStore(raw, keys);
 * ```
 */
export function keysToStart(
  encryption: Exclude<EncryptionConfig, { readonly kind: "provider" }> | undefined,
  env: SecretReader,
): LocalKeyProvider | undefined {
  if (encryption === undefined) throw new ConfigError([ENCRYPTION_REQUIRED]);
  return encryption.kind === "none" ? undefined : readMasterKeys(encryption, env);
}

/**
 * Reads every master key the configuration names, each where its reference says (an environment
 * variable, a file, or a secret a provider resolved at start), through the same resolver as every
 * other secret, and returns them as a {@link LocalKeyProvider}. Every key is read, not only the current one, so a
 * missing old key shows at startup rather than at the first value it wrapped.
 *
 * @throws {ConfigError} naming the key's id and where it is read from for each key that is missing
 *   or is not 32 bytes in base64. Never the value.
 * @example
 * ```ts
 * const keys = readMasterKeys(
 *   { kind: "keys", keys: [{ id: "prod", env: "PATHWAYS_KEY" }], current: "prod" },
 *   process.env,
 * );
 * ```
 */
export function readMasterKeys(
  encryption: Extract<EncryptionConfig, { kind: "keys" }>,
  env: SecretReader,
): LocalKeyProvider {
  const secrets = secretsOf(env);
  const problems: string[] = [];
  const keys: [string, Buffer][] = [];
  for (const [index, source] of encryption.keys.entries()) {
    const where = `pathways.yaml: encryption.keys.${index}: the key ${source.id}`;
    let text: string;
    try {
      text = secrets.read(source, where);
    } catch (error) {
      // The resolver throws only ConfigError, whose problems name the key and never its value.
      problems.push(...(error as ConfigError).problems);
      continue;
    }
    const key = decodeKey(text);
    if (key === undefined) {
      problems.push(
        `${where}: ${secretPlace(source)} does not hold a key; a key is 32 random bytes in base64, as openssl rand -base64 32 makes`,
      );
      continue;
    }
    keys.push([source.id, key]);
  }
  if (problems.length > 0) throw new ConfigError(problems);
  try {
    return new LocalKeyProvider(keys, encryption.current);
  } finally {
    for (const [, key] of keys) key.fill(0);
  }
}
