import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type Cipheriv,
  type Decipheriv,
} from "node:crypto";

import { release } from "../storage/ownership.js";
import type { KeyProvider } from "./keys.js";

/**
 * The version of the encrypted format this module writes, and the only one it reads.
 *
 * @example
 * ```ts
 * FORMAT_VERSION; // 1
 * ```
 */
export const FORMAT_VERSION = 1;

/**
 * What every encrypted value starts with: a zero byte, then `PWE` in ASCII. No text format a channel
 * carries starts with a zero byte, so a stored message can be told from an encrypted one.
 */
const MAGIC = Buffer.from([0x00, 0x50, 0x57, 0x45]);

/** An encrypted error text: this prefix, then the encrypted bytes in base64. */
const TEXT_PREFIX = "pwe:";

/** AES-256-GCM: a 32-byte key, a 12-byte nonce and a 16-byte tag. */
const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CIPHER = "aes-256-gcm";

/** A key id in the stored format: 1 to 255 bytes of printable ASCII, with no space. */
const STORED_KEY_ID = /^[\x21-\x7e]{1,255}$/;
const MAX_WRAPPED_BYTES = 0xffff;

/**
 * Why an encrypted value could not be written or read:
 *
 * - `ERR_PATHWAYS_NOT_ENCRYPTED`: the value is not in the encrypted format: it was stored while
 *   encryption was `none`, or its first bytes were changed;
 * - `ERR_PATHWAYS_ENCRYPTED`: the value is encrypted, and encryption is `none`;
 * - `ERR_PATHWAYS_MALFORMED`: the value starts like an encrypted one, but its layout is broken;
 * - `ERR_PATHWAYS_FORMAT_VERSION`: the value is in a format version this Pathways does not read;
 * - `ERR_PATHWAYS_UNKNOWN_KEY`: the master key the value names is not configured;
 * - `ERR_PATHWAYS_INTEGRITY`: the value, or its wrapped data key, failed its integrity check: it was
 *   changed or damaged, or the key configured under its id is not the key that wrote it;
 * - `ERR_PATHWAYS_KEY_PROVIDER`: a key provider returned a key id or a key that cannot be used.
 *
 * @example
 * ```ts
 * const code: EncryptionErrorCode = "ERR_PATHWAYS_INTEGRITY";
 * ```
 */
export type EncryptionErrorCode =
  | "ERR_PATHWAYS_NOT_ENCRYPTED"
  | "ERR_PATHWAYS_ENCRYPTED"
  | "ERR_PATHWAYS_MALFORMED"
  | "ERR_PATHWAYS_FORMAT_VERSION"
  | "ERR_PATHWAYS_UNKNOWN_KEY"
  | "ERR_PATHWAYS_INTEGRITY"
  | "ERR_PATHWAYS_KEY_PROVIDER";

const MESSAGES: Readonly<Record<EncryptionErrorCode, (keyId: string | undefined) => string>> = {
  ERR_PATHWAYS_NOT_ENCRYPTED: () =>
    "a stored value is not encrypted: it was stored while encryption was none, or it was changed",
  ERR_PATHWAYS_ENCRYPTED: () =>
    "a stored value is encrypted and encryption is none: configure the keys that wrote it",
  ERR_PATHWAYS_MALFORMED: () => "a stored value is damaged: its encrypted layout cannot be read",
  ERR_PATHWAYS_FORMAT_VERSION: () =>
    "a stored value is in an encrypted format this version of Pathways does not read",
  ERR_PATHWAYS_UNKNOWN_KEY: (keyId) =>
    `a stored value was encrypted under the key ${String(keyId)}, which is not configured`,
  ERR_PATHWAYS_INTEGRITY: (keyId) =>
    `a stored value failed its integrity check under the key ${String(keyId)}: it was changed or damaged, or that key is not the one that wrote it`,
  ERR_PATHWAYS_KEY_PROVIDER: () =>
    "the key provider returned a key id or a key that cannot be used",
};

/**
 * A value that could not be encrypted or decrypted. Its message is fixed text, with at most the
 * master key's id, which is never secret: never the value, a key, or anything a message holds. A
 * value that fails its integrity check always ends here, never as a garbled message.
 *
 * @example
 * ```ts
 * try {
 *   await decrypt(stored, keys);
 * } catch (error) {
 *   if (error instanceof EncryptionError) console.error(error.code, error.keyId);
 * }
 * ```
 */
export class EncryptionError extends Error {
  readonly code: EncryptionErrorCode;
  /** The master key's id, when the failure concerns one. */
  readonly keyId: string | undefined;

  /**
   * @param code What went wrong.
   * @param keyId The master key's id, when the failure concerns one.
   */
  constructor(code: EncryptionErrorCode, keyId?: string) {
    super(MESSAGES[code](keyId));
    this.name = "EncryptionError";
    this.code = code;
    this.keyId = keyId;
  }
}

/** An encrypted value, taken apart. Every field is a view into the stored bytes. */
interface Envelope {
  /** The bytes from the start to the end of the wrapped key: authenticated with the ciphertext. */
  readonly header: Buffer;
  readonly keyId: string;
  readonly wrapped: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Whether `value` is in the encrypted format: whether it starts with the format's marker. It says
 * nothing about whether the rest is intact; only decrypting checks that.
 *
 * @example
 * ```ts
 * isEncrypted(await encrypt(body, keys)); // true
 * isEncrypted(new TextEncoder().encode("MSH|^~\\&|")); // false
 * ```
 */
export function isEncrypted(value: Uint8Array): boolean {
  return value.byteLength >= MAGIC.length && MAGIC.equals(value.subarray(0, MAGIC.length));
}

/**
 * Whether a stored text is in the encrypted text format.
 *
 * @example
 * ```ts
 * isEncryptedText(await encryptText("transform: TypeError", keys)); // true
 * ```
 */
export function isEncryptedText(value: string): boolean {
  return value.startsWith(TEXT_PREFIX);
}

/**
 * Encrypts `plaintext` with a fresh AES-256-GCM data key, which the provider wraps under its current
 * master key. The result describes itself, in this layout:
 *
 * | Bytes | Field |
 * |---|---|
 * | 4 | the marker: a zero byte, then `PWE` |
 * | 1 | the format version, 1 |
 * | 1 | the key id's length, n |
 * | n | the master key's id, in ASCII |
 * | 2 | the wrapped data key's length, w, big-endian |
 * | w | the wrapped data key, in the provider's own layout |
 * | 12 | the nonce |
 * | 16 | the GCM tag |
 * | the rest | the ciphertext |
 *
 * Everything before the nonce is authenticated with the ciphertext, so a change to any byte fails
 * decryption. The data key is overwritten with zeros once it has been used.
 *
 * @throws {EncryptionError} `ERR_PATHWAYS_KEY_PROVIDER` when the provider returns an unusable key id.
 * @example
 * ```ts
 * const stored = await encrypt(new TextEncoder().encode(message), keys);
 * ```
 */
export async function encrypt(plaintext: Uint8Array, keys: KeyProvider): Promise<Buffer> {
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const { keyId, wrapped } = await keys.wrapKey(dataKey);
    if (
      !STORED_KEY_ID.test(keyId) ||
      wrapped.byteLength === 0 ||
      wrapped.byteLength > MAX_WRAPPED_BYTES
    ) {
      throw new EncryptionError("ERR_PATHWAYS_KEY_PROVIDER");
    }
    const lengths = Buffer.alloc(2);
    lengths.writeUInt16BE(wrapped.byteLength);
    const header = Buffer.concat([
      MAGIC,
      Buffer.from([FORMAT_VERSION, keyId.length]),
      Buffer.from(keyId, "latin1"),
      lengths,
      wrapped,
    ]);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, dataKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    // One buffer for the whole value, the ciphertext written into it a chunk at a time.
    const at = header.length + NONCE_BYTES + TAG_BYTES;
    const out = Buffer.allocUnsafeSlow(at + plaintext.byteLength);
    header.copy(out, 0);
    nonce.copy(out, header.length);
    stream(cipher, plaintext, out, at);
    cipher.getAuthTag().copy(out, header.length + NONCE_BYTES);
    return out;
  } finally {
    dataKey.fill(0);
  }
}

/** How much of a value a cipher reads at a time, so no stage of it holds a second whole copy. */
const CHUNK_BYTES = 64 * 1024;

/**
 * Runs `input` through an AES-GCM cipher or decipher into `out` from `at`, a chunk at a time, and
 * ends it. Each chunk the cipher hands back is copied in, overwritten with zeros (it can hold
 * plaintext) and freed at once. GCM writes exactly as many bytes as it reads, so `out` is filled to
 * its end; anything else is a broken cipher, and fails.
 */
function stream(cipher: Cipheriv | Decipheriv, input: Uint8Array, out: Buffer, at: number): void {
  let written = at;
  for (let from = 0; from < input.byteLength; from += CHUNK_BYTES) {
    const chunk = cipher.update(
      input.subarray(from, Math.min(from + CHUNK_BYTES, input.byteLength)),
    );
    written += chunk.copy(out, written);
    chunk.fill(0);
    release(chunk);
  }
  const last = cipher.final();
  written += last.copy(out, written);
  /* v8 ignore next -- GCM writes as many bytes as it reads */
  if (written !== out.length) throw new Error("the cipher did not write the whole value");
}

/**
 * Decrypts a value {@link encrypt} wrote, under whichever configured master key wrapped its data key,
 * and says which one that was.
 *
 * @throws {EncryptionError} when the value is not encrypted, is damaged, names a key that is not
 *   configured, or fails its integrity check. Never returns a value that failed the check.
 * @example
 * ```ts
 * const { plaintext, keyId } = await decryptWithKeyId(stored, keys);
 * ```
 */
export async function decryptWithKeyId(
  value: Uint8Array,
  keys: KeyProvider,
): Promise<{ plaintext: Buffer; keyId: string }> {
  const envelope = parse(value);
  const { keyId } = envelope;
  const dataKey = await keys.unwrapKey(keyId, envelope.wrapped);
  try {
    if (dataKey.byteLength !== DATA_KEY_BYTES) {
      throw new EncryptionError("ERR_PATHWAYS_KEY_PROVIDER", keyId);
    }
    const decipher = createDecipheriv(CIPHER, dataKey, envelope.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(envelope.header);
    decipher.setAuthTag(envelope.tag);
    const plaintext = Buffer.allocUnsafeSlow(envelope.ciphertext.length);
    try {
      stream(decipher, envelope.ciphertext, plaintext, 0);
      return { plaintext, keyId };
    } catch {
      // Bytes from a value that failed its check never leave here, not even as a partial result.
      plaintext.fill(0);
      release(plaintext);
      throw new EncryptionError("ERR_PATHWAYS_INTEGRITY", keyId);
    }
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Decrypts a value {@link encrypt} wrote.
 *
 * @throws {EncryptionError} as {@link decryptWithKeyId} does.
 * @example
 * ```ts
 * const body = await decrypt(stored, keys);
 * ```
 */
export async function decrypt(value: Uint8Array, keys: KeyProvider): Promise<Buffer> {
  return (await decryptWithKeyId(value, keys)).plaintext;
}

/**
 * Encrypts a text, such as a stored error, which can quote a message: the same format as
 * {@link encrypt}, in base64 after the prefix `pwe:`, so it fits a text column in any database.
 *
 * @example
 * ```ts
 * const stored = await encryptText("transform: TypeError at transform.ts:4:9: ...", keys);
 * ```
 */
export async function encryptText(text: string, keys: KeyProvider): Promise<string> {
  return TEXT_PREFIX + (await encrypt(Buffer.from(text, "utf8"), keys)).toString("base64");
}

/**
 * Decrypts a text {@link encryptText} wrote, and says which master key wrapped it.
 *
 * @throws {EncryptionError} as {@link decryptWithKeyId} does; `ERR_PATHWAYS_MALFORMED` when the base64
 *   is not exactly what {@link encryptText} writes.
 * @example
 * ```ts
 * const { text, keyId } = await decryptTextWithKeyId(stored, keys);
 * ```
 */
export async function decryptTextWithKeyId(
  value: string,
  keys: KeyProvider,
): Promise<{ text: string; keyId: string }> {
  if (!isEncryptedText(value)) throw new EncryptionError("ERR_PATHWAYS_NOT_ENCRYPTED");
  const encoded = value.slice(TEXT_PREFIX.length);
  const bytes = Buffer.from(encoded, "base64");
  // Node's base64 decoder skips what it does not understand; anything but the exact encoding is damage.
  if (bytes.toString("base64") !== encoded) throw new EncryptionError("ERR_PATHWAYS_MALFORMED");
  const { plaintext, keyId } = await decryptWithKeyId(bytes, keys);
  return { text: plaintext.toString("utf8"), keyId };
}

/**
 * Decrypts a text {@link encryptText} wrote.
 *
 * @throws {EncryptionError} as {@link decryptTextWithKeyId} does.
 * @example
 * ```ts
 * const error = await decryptText(stored, keys);
 * ```
 */
export async function decryptText(value: string, keys: KeyProvider): Promise<string> {
  return (await decryptTextWithKeyId(value, keys)).text;
}

function parse(value: Uint8Array): Envelope {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (!isEncrypted(bytes)) throw new EncryptionError("ERR_PATHWAYS_NOT_ENCRYPTED");
  let at = MAGIC.length;
  if (bytes.length < at + 2) throw new EncryptionError("ERR_PATHWAYS_MALFORMED");
  if (bytes[at] !== FORMAT_VERSION) throw new EncryptionError("ERR_PATHWAYS_FORMAT_VERSION");
  const idLength = bytes[at + 1] as number;
  at += 2;
  if (bytes.length < at + idLength + 2) throw new EncryptionError("ERR_PATHWAYS_MALFORMED");
  const keyId = bytes.toString("latin1", at, at + idLength);
  if (!STORED_KEY_ID.test(keyId)) throw new EncryptionError("ERR_PATHWAYS_MALFORMED");
  at += idLength;
  const wrappedLength = bytes.readUInt16BE(at);
  at += 2;
  if (wrappedLength === 0 || bytes.length < at + wrappedLength + NONCE_BYTES + TAG_BYTES) {
    throw new EncryptionError("ERR_PATHWAYS_MALFORMED");
  }
  const wrapped = bytes.subarray(at, at + wrappedLength);
  at += wrappedLength;
  return {
    header: bytes.subarray(0, at),
    keyId,
    wrapped,
    nonce: bytes.subarray(at, at + NONCE_BYTES),
    tag: bytes.subarray(at + NONCE_BYTES, at + NONCE_BYTES + TAG_BYTES),
    ciphertext: bytes.subarray(at + NONCE_BYTES + TAG_BYTES),
  };
}
