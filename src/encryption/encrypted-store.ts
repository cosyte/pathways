import type {
  DeliveryStatus,
  MessageStatus,
  MessageStore,
  PendingDelivery,
  PendingMessage,
  ReceivedMessage,
  StoreReceiveOptions,
} from "../storage/store.js";
import { decrypt, encrypt, encryptText, EncryptionError, isEncrypted } from "./envelope.js";
import type { KeyProvider } from "./keys.js";

/** How a wrapper turns what the engine hands it into what storage keeps, and back. */
interface Codec {
  /** A message or delivery body, on its way into storage. */
  storeBody(body: Uint8Array): Promise<Uint8Array>;
  /** A body, on its way out of storage. */
  readBody(stored: Uint8Array): Promise<Uint8Array>;
  /** An error text, on its way into storage. */
  storeText(text: string): Promise<string>;
}

/**
 * The part both wrappers share: every {@link MessageStore} method, passing bodies and error texts
 * through a codec on their way in and out, and everything else straight through. A method added to
 * {@link MessageStore} that carries a body or an error text belongs here too, through the codec.
 */
abstract class CodecStore implements MessageStore {
  readonly #inner: MessageStore;
  readonly #codec: Codec;

  protected constructor(inner: MessageStore, codec: Codec) {
    this.#inner = inner;
    this.#codec = codec;
  }

  /** Stores an incoming message, its body and any failure reason passed through the codec. */
  async receive(
    channel: string,
    body: Uint8Array,
    options: StoreReceiveOptions = {},
  ): Promise<ReceivedMessage> {
    const { failure } = options;
    return this.#inner.receive(channel, await this.#codec.storeBody(body), {
      ...options,
      failure: failure === undefined ? undefined : await this.#codec.storeText(failure),
    });
  }

  /** The oldest message of `channel` waiting for its transform, its body read back. */
  async nextToTransform(channel: string): Promise<PendingMessage | undefined> {
    const next = await this.#inner.nextToTransform(channel);
    return next === undefined
      ? undefined
      : { ...next, body: await this.#codec.readBody(next.body) };
  }

  /** Records a transform's outputs, each passed through the codec once for every destination. */
  async completeTransform(
    messageId: number,
    outputs: readonly Uint8Array[],
    destinations: number,
  ): Promise<void> {
    const stored: Uint8Array[] = [];
    for (const output of outputs) stored.push(await this.#codec.storeBody(output));
    await this.#inner.completeTransform(messageId, stored, destinations);
  }

  /** Marks a message failed, its error passed through the codec. */
  async failTransform(messageId: number, error: string): Promise<void> {
    await this.#inner.failTransform(messageId, await this.#codec.storeText(error));
  }

  /** The oldest pending delivery for one destination, its body read back. */
  async nextDelivery(channel: string, destination: number): Promise<PendingDelivery | undefined> {
    const next = await this.#inner.nextDelivery(channel, destination);
    return next === undefined
      ? undefined
      : { ...next, body: await this.#codec.readBody(next.body) };
  }

  /** Marks a delivery done. */
  markDelivered(deliveryId: number): Promise<void> {
    return this.#inner.markDelivered(deliveryId);
  }

  /** Records a failed attempt, its error passed through the codec. */
  async scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
  ): Promise<void> {
    await this.#inner.scheduleRetry(
      deliveryId,
      attempts,
      nextAttemptAt,
      await this.#codec.storeText(error),
    );
  }

  /** Marks a delivery failed for good, its error passed through the codec. */
  async failDelivery(deliveryId: number, error: string): Promise<void> {
    await this.#inner.failDelivery(deliveryId, await this.#codec.storeText(error));
  }

  /** How many messages of `channel` stand at each status. */
  messageCounts(channel: string): Promise<Record<MessageStatus, number>> {
    return this.#inner.messageCounts(channel);
  }

  /** How many deliveries of `channel` stand at each status. */
  deliveryCounts(channel: string): Promise<Record<DeliveryStatus, number>> {
    return this.#inner.deliveryCounts(channel);
  }

  /** How many of `channel`'s pending deliveries wait for a retry. */
  retryingDeliveries(channel: string): Promise<number> {
    return this.#inner.retryingDeliveries(channel);
  }

  /** Closes the store underneath. */
  close(): Promise<void> {
    return this.#inner.close();
  }
}

/**
 * Encryption at rest around any {@link MessageStore}: every message body, delivery body and error
 * text (which can quote a message) is encrypted on its way in, each with a fresh AES-256-GCM data
 * key that `keys` wraps under its current master key, and decrypted on its way out. The stored
 * values describe themselves (see {@link encrypt}), so the store underneath needs no schema change,
 * and values written under an older master key stay readable while the provider still holds it.
 *
 * A value that fails its integrity check, or names a key the provider does not hold, makes the read
 * reject with an {@link EncryptionError}; a garbled body is never handed on.
 *
 * @example
 * ```ts
 * const store = new EncryptedStore(await Store.open(project.databaseFile), keys);
 * const engine = new Engine({ project, store, logger });
 * ```
 */
export class EncryptedStore extends CodecStore {
  /**
   * @param inner The store that keeps the encrypted values.
   * @param keys Wraps each value's data key under the current master key, and unwraps it again.
   */
  constructor(inner: MessageStore, keys: KeyProvider) {
    super(inner, {
      storeBody: (body) => encrypt(body, keys),
      readBody: (stored) => decrypt(stored, keys),
      storeText: (text) => encryptText(text, keys),
    });
  }
}

/**
 * The store for `encryption: none`: values are kept as they are. A body that was stored encrypted
 * (encryption was on before) is refused with an {@link EncryptionError} `ERR_PATHWAYS_ENCRYPTED`
 * rather than handed on as ciphertext to a transform or a destination.
 *
 * @example
 * ```ts
 * const store = new UnencryptedStore(await Store.open(project.databaseFile));
 * ```
 */
export class UnencryptedStore extends CodecStore {
  /** @param inner The store that keeps the values as they are. */
  constructor(inner: MessageStore) {
    super(inner, {
      storeBody: (body) => Promise.resolve(body),
      readBody: (stored) =>
        isEncrypted(stored)
          ? Promise.reject(new EncryptionError("ERR_PATHWAYS_ENCRYPTED"))
          : Promise.resolve(stored),
      storeText: (text) => Promise.resolve(text),
    });
  }
}
