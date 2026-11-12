import type {
  MessageState,
  AuditEntry,
  AuditInput,
  AuditQuery,
  ChannelRunState,
  ClearResult,
  DeliveryCounts,
  DestinationQueue,
  ExpireResult,
  LeaseClaim,
  LeaseClaimant,
  LeaseHolder,
  MessageQuery,
  MessageStatus,
  MessageStore,
  MessageSummary,
  NextDeliveryOptions,
  Page,
  PendingDelivery,
  SendStart,
  PendingMessage,
  ReceivedMessage,
  RequeueRequest,
  RequeueResult,
  RetryingDelivery,
  MessageRows,
  StoredDelivery,
  StoredDeliveryRow,
  StoredMessage,
  StoreReceiveOptions,
} from "../storage/store.js";
import {
  channelStateStore,
  leaseStore,
  retentionStore,
  type RetentionStore,
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
import type { MetaIndexConfig } from "../config/schema.js";
import { MetaIndexer, metaText, type MessageMeta, type MetaCondition } from "./blind-index.js";

/**
 * A metadata search: the messages of `channel` whose metadata holds every `where` pair, newest
 * first, with the other filters of a listing. Each key must be one of the channel's indexes.
 *
 * @example
 * ```ts
 * const search: MetaSearch = { channel: "adt", where: [["mrn", "SYN-000123"]], limit: 50 };
 * ```
 */
export interface MetaSearch {
  readonly channel: string;
  /** Each pair a `ctx.meta` key and the value it must hold, compared as text. */
  readonly where: readonly (readonly [string, string])[];
  readonly state?: MessageState | undefined;
  /** Received at or after this time (ISO 8601, UTC). */
  readonly since?: string | undefined;
  /** Received before this time (ISO 8601, UTC). */
  readonly until?: string | undefined;
  /** Only ids below this one: the `next` of the page before. */
  readonly before?: number | undefined;
  readonly limit: number;
  /**
   * The most rows the page reads and decrypts: {@link META_SEARCH_MAX_CANDIDATES} when not given.
   * A page that reaches it ends there, with `next` set to go on. A whole number of 1 or more:
   * anything else is refused with a `RangeError`.
   */
  readonly maxCandidates?: number | undefined;
}

/**
 * One page of a metadata search. `candidates` counts the rows whose tags matched and whose metadata
 * was decrypted to confirm them, the matches among them; `next` continues the search.
 *
 * @example
 * ```ts
 * const { items, next, candidates }: MetaSearchPage = await store.findByMeta(search);
 * ```
 */
export interface MetaSearchPage extends Page<MessageSummary> {
  readonly candidates: number;
}

/**
 * The most rows one page of a metadata search reads and decrypts. A page that reaches it ends
 * early, with `next` set to go on from where it stopped, so a search is never unbounded.
 *
 * @example
 * ```ts
 * const most = META_SEARCH_MAX_CANDIDATES; // 10,000
 * ```
 */
export const META_SEARCH_MAX_CANDIDATES = 10_000;

/** How many candidate rows a metadata search reads at a time. */
const META_SEARCH_BATCH = 200;

/**
 * A metadata search that cannot run: `not-indexed` when a key is not one of the channel's indexes
 * (`key` names it), `unsupported` when the store underneath cannot be searched by tag.
 *
 * @example
 * ```ts
 * if (error instanceof MetaSearchError && error.reason === "not-indexed") console.error(error.key);
 * ```
 */
export class MetaSearchError extends Error {
  readonly reason: "not-indexed" | "unsupported";
  readonly key: string | undefined;

  /**
   * @param reason Why the search cannot run.
   * @param key The key that is not indexed, for `not-indexed`.
   */
  constructor(reason: "not-indexed" | "unsupported", key?: string) {
    super(
      reason === "not-indexed"
        ? `the channel has no index on the ctx.meta key ${String(key)}`
        : "this store cannot be searched by metadata",
    );
    this.name = "MetaSearchError";
    this.reason = reason;
    this.key = key;
  }
}

/**
 * The search method a store opened by `openStore` has: {@link EncryptedStore} and
 * {@link UnencryptedStore} both.
 *
 * @example
 * ```ts
 * if (canSearchMeta(store)) await store.findByMeta(search);
 * ```
 */
export interface MetaSearchStore {
  findByMeta(search: MetaSearch): Promise<MetaSearchPage>;
}

/**
 * Whether `store` can run a metadata search.
 *
 * @example
 * ```ts
 * if (!canSearchMeta(store)) throw new Error("no metadata search");
 * ```
 */
export function canSearchMeta(store: object): store is MetaSearchStore {
  return typeof (store as Partial<MetaSearchStore>).findByMeta === "function";
}

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
abstract class CodecStore implements MessageStore, MetaSearchStore {
  readonly #inner: MessageStore;
  readonly #codec: Codec;
  /** Computes the index tags of each message's metadata; undefined when nothing is indexed. */
  readonly #indexer: MetaIndexer | undefined;
  /** Whether the store underneath keeps no body it is handed, and reads each into a buffer of its own. */
  readonly #innerCopies: boolean;

  /** The lease methods, straight through, present only when the store underneath has all four. */
  readonly acquireLease?: (
    name: string,
    claimant: LeaseClaimant,
    ttlMs: number,
  ) => Promise<LeaseClaim>;
  readonly renewLease?: (name: string, epoch: number, ttlMs: number) => Promise<boolean>;
  readonly releaseLease?: (name: string, epoch?: number) => Promise<boolean>;
  readonly leaseHolder?: (name: string) => Promise<LeaseHolder | undefined>;
  /**
   * Marks a delivery done and drops the message's bodies after its last one: no body passes, so
   * straight through, and present only when the store underneath has it.
   */
  readonly markDeliveredAndDropContent?: (deliveryId: number, epoch?: number) => Promise<boolean>;
  /** The channel state methods, straight through, present only when the store underneath has both. */
  readonly channelStates?: () => Promise<Record<string, ChannelRunState>>;
  readonly setChannelState?: (channel: string, state: ChannelRunState) => Promise<void>;
  /** Straight through, present only when the store underneath has it. */
  readonly markDryRun?: (deliveryId: number, epoch?: number) => Promise<void>;
  /** Counts and a time, no content, so straight through, present only when the store underneath has it. */
  readonly destinationQueues?: (channel: string) => Promise<DestinationQueue[]>;
  /**
   * The retention steps: ids and counts, and rows changed whole or emptied, so straight through,
   * present only when the store underneath has all four; the rows an archive holds come back
   * through the codec.
   */
  readonly countExpiring?: RetentionStore["countExpiring"];
  readonly listExpiring?: RetentionStore["listExpiring"];
  readonly applyExpiry?: RetentionStore["applyExpiry"];
  /** Every column of a message and its deliveries, each body, error text and metadata read back. */
  readonly archiveRows?: RetentionStore["archiveRows"];

  protected constructor(inner: MessageStore, codec: Codec, indexer?: MetaIndexer) {
    this.#inner = inner;
    this.#codec = codec;
    this.#indexer = indexer;
    const leases = leaseStore(inner);
    if (leases !== undefined) {
      this.acquireLease = leases.acquireLease;
      this.renewLease = leases.renewLease;
      this.releaseLease = leases.releaseLease;
      this.leaseHolder = leases.leaseHolder;
    }
    if (typeof inner.markDeliveredAndDropContent === "function") {
      const drop = inner.markDeliveredAndDropContent.bind(inner);
      this.markDeliveredAndDropContent = (deliveryId, epoch) => drop(deliveryId, epoch);
    }
    const states = channelStateStore(inner);
    if (states !== undefined) {
      this.channelStates = states.channelStates;
      this.setChannelState = states.setChannelState;
    }
    if (inner.markDryRun !== undefined) this.markDryRun = inner.markDryRun.bind(inner);
    if (inner.destinationQueues !== undefined) {
      this.destinationQueues = inner.destinationQueues.bind(inner);
    }
    const steps = retentionStore(inner);
    if (steps !== undefined) {
      this.countExpiring = (channel, query) => steps.countExpiring(channel, query);
      this.listExpiring = (channel, query, limit, after) =>
        steps.listExpiring(channel, query, limit, after);
      this.applyExpiry = (channel, ids, query) => steps.applyExpiry(channel, ids, query);
      this.archiveRows = (id) => this.#archiveRows(steps, id);
    }
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

  /** One message's rows, each body, error text and the metadata read back through the codec. */
  async #archiveRows(steps: RetentionStore, id: number): Promise<MessageRows | undefined> {
    const rows = await steps.archiveRows(id);
    if (rows === undefined) return undefined;
    const { message } = rows;
    const deliveries: StoredDeliveryRow[] = [];
    for (const delivery of rows.deliveries) {
      deliveries.push({
        ...delivery,
        body: delivery.body === null ? null : await this.#read(delivery.body),
        error: await this.#readText(delivery.error),
      });
    }
    return {
      message: {
        ...message,
        body: message.body === null ? null : await this.#read(message.body),
        error: await this.#readText(message.error),
        meta: await this.#readText(message.meta),
      },
      deliveries,
    };
  }

  /** Reads a stored body back through the codec, then frees the stored copy when it is this store's own. */
  async #read(stored: Uint8Array): Promise<Uint8Array> {
    const body = await this.#codec.readBody(stored);
    if (this.#codec.copies && this.#innerCopies) release(stored);
    return body;
  }

  /**
   * Stores an incoming message, its body, any failure reason and its metadata passed through the
   * codec, and its metadata's index tags beside it.
   */
  async receive(
    channel: string,
    body: Uint8Array,
    options: StoreReceiveOptions = {},
  ): Promise<ReceivedMessage> {
    const { failure, meta } = options;
    return this.#stored([body], async ([stored]) =>
      this.#inner.receive(channel, stored as Uint8Array, {
        ...options,
        failure: failure === undefined ? undefined : await this.#codec.storeText(failure),
        ...(meta === undefined
          ? {}
          : {
              meta: undefined,
              storedMeta: await this.#codec.storeText(JSON.stringify(meta)),
              metaTags: (await this.#indexer?.tagsFor(channel, meta)) ?? [],
            }),
      }),
    );
  }

  /**
   * The messages of a channel whose metadata holds every pair of `search.where`, newest first. Each
   * key must be one of the channel's indexes: the search looks up the value's tag under every master
   * key id, then decrypts each row it finds and keeps only those that hold the value, since a
   * truncated tag is shared by many values. It reads at most {@link META_SEARCH_MAX_CANDIDATES} rows
   * a page; a page can hold fewer than `limit` messages and still have a `next`.
   *
   * @throws {MetaSearchError} when a key is not indexed, or the store underneath cannot be searched.
   * @throws {RangeError} when `maxCandidates` is below 1 or not a whole number.
   */
  async findByMeta(search: MetaSearch): Promise<MetaSearchPage> {
    const { channel, where, state, since, until, limit } = search;
    const most = search.maxCandidates ?? META_SEARCH_MAX_CANDIDATES;
    // A cap below one would read no row and never end the page.
    if (!Number.isInteger(most) || most < 1) {
      throw new RangeError("maxCandidates must be a whole number of 1 or more");
    }
    const batch = Math.min(META_SEARCH_BATCH, most);
    const conditions: MetaCondition[] = [];
    for (const [key, value] of where) {
      const condition = await this.#indexer?.condition(channel, key, value);
      if (condition === undefined) throw new MetaSearchError("not-indexed", key);
      conditions.push(condition);
    }
    const inner = this.#inner;
    if (typeof inner.metaCandidates !== "function") throw new MetaSearchError("unsupported");
    const confirmed: number[] = [];
    let candidates = 0;
    let before = search.before;
    let next: number | undefined;
    scan: for (;;) {
      const rows = await inner.metaCandidates({
        channel,
        conditions,
        state,
        since,
        until,
        before,
        limit: batch,
      });
      for (const row of rows) {
        if (confirmed.length === limit) {
          next = confirmed.at(-1);
          break scan;
        }
        if (candidates === most) {
          next = before;
          break scan;
        }
        candidates += 1;
        before = row.id;
        if (await this.#holds(row.meta, where)) confirmed.push(row.id);
      }
      if (rows.length < batch) break;
    }
    const page = await inner.listMessages({ ids: confirmed, limit: Math.max(confirmed.length, 1) });
    return { items: page.items, next, candidates };
  }

  /** Whether stored metadata, read back through the codec, holds every pair. */
  async #holds(stored: string, where: MetaSearch["where"]): Promise<boolean> {
    // Stored by receive() from a MessageMeta: flat values only.
    const meta = JSON.parse(await this.#codec.readText(stored)) as MessageMeta;
    return where.every(([key, value]) => {
      const held = meta[key];
      return held !== undefined && metaText(held) === value;
    });
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
    epoch?: number,
  ): Promise<void> {
    await this.#stored(outputs, (stored) =>
      this.#inner.completeTransform(messageId, stored, destinations, epoch),
    );
  }

  /** Marks a message failed, its error passed through the codec. */
  async failTransform(messageId: number, error: string, epoch?: number): Promise<void> {
    await this.#inner.failTransform(messageId, await this.#codec.storeText(error), epoch);
  }

  /** The oldest pending delivery for one destination, its body read back. */
  async nextDelivery(
    channel: string,
    destination: number,
    options?: NextDeliveryOptions,
  ): Promise<PendingDelivery | undefined> {
    const next = await this.#inner.nextDelivery(channel, destination, options);
    return next === undefined ? undefined : { ...next, body: await this.#read(next.body) };
  }

  /** Writes the marker before a send: no body and no error, so straight through. */
  markSending(deliveryId: number, start: SendStart, epoch?: number): Promise<void> {
    return this.#inner.markSending(deliveryId, start, epoch);
  }

  /** Marks a delivery done. */
  markDelivered(deliveryId: number, epoch?: number): Promise<void> {
    return this.#inner.markDelivered(deliveryId, epoch);
  }

  /** Records a failed attempt, its error passed through the codec. */
  async scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
    epoch?: number,
  ): Promise<void> {
    await this.#inner.scheduleRetry(
      deliveryId,
      attempts,
      nextAttemptAt,
      await this.#codec.storeText(error),
      epoch,
    );
  }

  /** Marks a delivery failed for good, its error passed through the codec. */
  async failDelivery(deliveryId: number, error: string, epoch?: number): Promise<void> {
    await this.#inner.failDelivery(deliveryId, await this.#codec.storeText(error), epoch);
  }

  /** How many messages of `channel` stand at each status. */
  messageCounts(channel: string): Promise<Record<MessageStatus, number>> {
    return this.#inner.messageCounts(channel);
  }

  /** How many deliveries of `channel` stand at each status. */
  deliveryCounts(channel: string): Promise<DeliveryCounts> {
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

  /** One message's body as it arrived, read back; `undefined` once it was dropped. */
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
   * @param indexes Each channel's `index:` entries, by channel name: their keys of each message's
   *   metadata are stored as index tags too.
   * @throws {ConfigError} when a channel has an index and `keys` cannot derive index keys.
   */
  constructor(
    inner: MessageStore,
    keys: KeyProvider,
    indexes: ReadonlyMap<string, readonly MetaIndexConfig[]> = new Map(),
  ) {
    super(
      inner,
      {
        storeBody: (body) => encrypt(body, keys),
        readBody: (stored) => decrypt(stored, keys),
        storeText: (text) => encryptText(text, keys),
        readText: (stored) => decryptText(stored, keys),
        copies: true,
      },
      new MetaIndexer(keys, indexes),
    );
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
