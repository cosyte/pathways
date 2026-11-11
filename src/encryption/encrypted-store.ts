import type {
  AuditEntry,
  AuditInput,
  AuditQuery,
  ClearResult,
  DeliveryStatus,
  ExpireResult,
  MessageQuery,
  MessageStatus,
  MessageStore,
  MessageSummary,
  Page,
  PendingDelivery,
  SendStart,
  PendingMessage,
  ReceivedMessage,
  RequeueRequest,
  RequeueResult,
  RetryingDelivery,
  StoredDelivery,
  StoredMessage,
  StoreReceiveOptions,
} from "../storage/store.js";
import { copiesBodies, markCopiesBodies, release } from "../storage/ownership.js";
import {
  decrypt,
  decryptText,
  encrypt,
  encryptText,
  EncryptionError,
  isEncrypted,
  isEncryptedText,
} from "./envelope.js";
import type { KeyProvider } from "./keys.js";

/** How a wrapper turns what the engine hands it into what storage keeps, and back. */
interface Codec {
  /** A message or delivery body, on its way into storage. */
  storeBody(body: Uint8Array): Promise<Uint8Array>;
  /** A body, on its way out of storage. */
  readBody(stored: Uint8Array): Promise<Uint8Array>;
  /** An error text, on its way into storage. */
  storeText(text: string): Promise<string>;
  /** An error text, on its way out of storage: to an operator command, never to a log. */
  readText(stored: string): Promise<string>;
  /** Whether a stored body is a copy of its own, never the body handed in or read out. */
  readonly copies: boolean;
}

/**
 * The part both wrappers share: every {@link MessageStore} method, passing bodies and error texts
 * through a codec on their way in and out, and everything else straight through. A method added to
 * {@link MessageStore} that carries a body or an error text belongs here too, through the codec.
 */
abstract class CodecStore implements MessageStore {
  readonly #inner: MessageStore;
  readonly #codec: Codec;
  /** Whether the store underneath keeps no body it is handed, and reads each into a buffer of its own. */
  readonly #innerCopies: boolean;

  protected constructor(inner: MessageStore, codec: Codec) {
    this.#inner = inner;
    this.#codec = codec;
    this.#innerCopies = copiesBodies(inner);
    // A codec that copies keeps no body it is handed and reads each into a new buffer; one that does
    // not passes bodies straight through, so this store copies when the one underneath does.
    if (codec.copies || this.#innerCopies) markCopiesBodies(this);
  }

  /**
   * Passes a body through the codec on its way in, runs `write` with what is to be stored, then
   * frees that copy when the store underneath has kept none of it.
   */
  async #stored<T>(
    bodies: readonly Uint8Array[],
    write: (stored: Uint8Array[]) => Promise<T>,
  ): Promise<T> {
    const stored: Uint8Array[] = [];
    for (const body of bodies) stored.push(await this.#codec.storeBody(body));
    const result = await write(stored);
    if (this.#codec.copies && this.#innerCopies) for (const copy of stored) release(copy);
    return result;
  }

  /** Reads a stored body back through the codec, then frees the stored copy when it is this store's own. */
  async #read(stored: Uint8Array): Promise<Uint8Array> {
    const body = await this.#codec.readBody(stored);
    if (this.#codec.copies && this.#innerCopies) release(stored);
    return body;
  }

  /** Stores an incoming message, its body and any failure reason passed through the codec. */
  async receive(
    channel: string,
    body: Uint8Array,
    options: StoreReceiveOptions = {},
  ): Promise<ReceivedMessage> {
    const { failure } = options;
    return this.#stored([body], async ([stored]) =>
      this.#inner.receive(channel, stored as Uint8Array, {
        ...options,
        failure: failure === undefined ? undefined : await this.#codec.storeText(failure),
      }),
    );
  }

  /** The oldest message of `channel` waiting for its transform, its body read back. */
  async nextToTransform(channel: string): Promise<PendingMessage | undefined> {
    const next = await this.#inner.nextToTransform(channel);
    return next === undefined ? undefined : { ...next, body: await this.#read(next.body) };
  }

  /** Records a transform's outputs, each passed through the codec once for every destination. */
  async completeTransform(
    messageId: number,
    outputs: readonly Uint8Array[],
    destinations: number,
  ): Promise<void> {
    await this.#stored(outputs, (stored) =>
      this.#inner.completeTransform(messageId, stored, destinations),
    );
  }

  /** Marks a message failed, its error passed through the codec. */
  async failTransform(messageId: number, error: string): Promise<void> {
    await this.#inner.failTransform(messageId, await this.#codec.storeText(error));
  }

  /** The oldest pending delivery for one destination, its body read back. */
  async nextDelivery(channel: string, destination: number): Promise<PendingDelivery | undefined> {
    const next = await this.#inner.nextDelivery(channel, destination);
    return next === undefined ? undefined : { ...next, body: await this.#read(next.body) };
  }

  /** Writes the marker before a send: no body and no error, so straight through. */
  markSending(deliveryId: number, start: SendStart): Promise<void> {
    return this.#inner.markSending(deliveryId, start);
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

  /** Every channel with a stored message. */
  channels(): Promise<string[]> {
    return this.#inner.channels();
  }

  /** One message, without its body, its error text read back. */
  async message(id: number): Promise<StoredMessage | undefined> {
    const message = await this.#inner.message(id);
    if (message === undefined) return undefined;
    return { ...message, error: await this.#readText(message.error) };
  }

  /** One message's body as it arrived, read back. */
  async messageBody(id: number): Promise<Uint8Array | undefined> {
    const body = await this.#inner.messageBody(id);
    return body === undefined ? undefined : this.#read(body);
  }

  /** A message's deliveries, without bodies, each error text read back. */
  async deliveries(messageId: number): Promise<StoredDelivery[]> {
    const deliveries = await this.#inner.deliveries(messageId);
    const read: StoredDelivery[] = [];
    for (const delivery of deliveries) {
      read.push({ ...delivery, error: await this.#readText(delivery.error) });
    }
    return read;
  }

  /** The outputs of a message's current generation, each read back. */
  async outputs(messageId: number): Promise<Uint8Array[]> {
    const read: Uint8Array[] = [];
    for (const output of await this.#inner.outputs(messageId)) read.push(await this.#read(output));
    return read;
  }

  /** A page of messages: no bodies and no errors, so straight through. */
  listMessages(query: MessageQuery): Promise<Page<MessageSummary>> {
    return this.#inner.listMessages(query);
  }

  /** A channel's retrying deliveries: ids, counts and times only. */
  listRetrying(channel: string, limit: number): Promise<RetryingDelivery[]> {
    return this.#inner.listRetrying(channel, limit);
  }

  /**
   * Records a replay or a resend, its outputs (each once, for every destination) and any failure
   * passed through the codec.
   */
  async requeue(messageId: number, request: RequeueRequest, actor: string): Promise<RequeueResult> {
    const { failure } = request;
    return this.#stored(request.outputs, async (outputs) =>
      this.#inner.requeue(
        messageId,
        {
          ...request,
          outputs,
          failure: failure === undefined ? undefined : await this.#codec.storeText(failure),
        },
        actor,
      ),
    );
  }

  /** Clears a failed message: statuses only. */
  clear(messageId: number, actor: string): Promise<ClearResult> {
    return this.#inner.clear(messageId, actor);
  }

  /** Deletes done messages past the cutoff: rows go whole, so nothing to decrypt. */
  expire(channel: string, cutoff: string, dryRun: boolean): Promise<ExpireResult> {
    return this.#inner.expire(channel, cutoff, dryRun);
  }

  /** Appends audit entries, which hold ids, counts and codes, never content. */
  appendAudit(actor: string, entries: readonly AuditInput[]): Promise<AuditEntry[]> {
    return this.#inner.appendAudit(actor, entries);
  }

  /** A page of the audit log. */
  auditEntries(query: AuditQuery): Promise<Page<AuditEntry>> {
    return this.#inner.auditEntries(query);
  }

  /** Closes the store underneath. */
  close(): Promise<void> {
    return this.#inner.close();
  }

  async #readText(stored: string | null): Promise<string | null> {
    return stored === null ? null : this.#codec.readText(stored);
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
 * reject with an {@link EncryptionError}; a garbled body is never handed on. The operator commands
 * read bodies and error texts back through it too (`messages show --content`, `replay`).
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
      readText: (stored) => decryptText(stored, keys),
      copies: true,
    });
  }
}

/**
 * The store for `encryption: none`: values are kept as they are. A body or error text that was
 * stored encrypted (encryption was on before) is refused with an {@link EncryptionError}
 * `ERR_PATHWAYS_ENCRYPTED` rather than handed on as ciphertext to a transform, a destination or an
 * operator.
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
      readText: (stored) =>
        isEncryptedText(stored)
          ? Promise.reject(new EncryptionError("ERR_PATHWAYS_ENCRYPTED"))
          : Promise.resolve(stored),
      copies: false,
    });
  }
}
