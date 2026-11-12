import {
  Kysely,
  sql,
  type ColumnDataType,
  type ColumnDefinitionBuilder,
  type ColumnType,
  type CreateTableBuilder,
  type Expression,
  type ExpressionBuilder,
  type Generated,
  type Insertable,
  type RawBuilder,
  type Selectable,
  type SelectQueryBuilder,
  type SqlBool,
  type Transaction,
} from "kysely";

import { ConfigError } from "../config/load.js";
import type { DatabaseStorage, StorageKind } from "../config/schema.js";
import type { MessageMeta, MetaCondition, MetaTag } from "../encryption/blind-index.js";
import type { SecretReader } from "../secrets/resolve.js";
import { faultPoint } from "../fault-points.js";
import { dialectFor, type DriverImport } from "./dialects.js";
import {
  ENGINE_LEASE,
  LeaseLostError,
  type LeaseClaim,
  type LeaseClaimant,
  type LeaseHolder,
} from "./lease.js";
import { markCopiesBodies } from "./ownership.js";
import {
  migrateSchema,
  openSchema,
  readSchema,
  recordedSteps,
  SchemaVersionError,
  SCHEMA_INFO_STEP,
  type MigrateOptions,
  type MigrationReport,
  type SchemaMode,
  type SchemaState,
  type SchemaStep,
} from "./schema.js";
import { VERSION } from "../version.js";

export {
  ENGINE_LEASE,
  LeaseLostError,
  type LeaseClaim,
  type LeaseClaimant,
  type LeaseHolder,
} from "./lease.js";

/**
 * Where a stored message stands. `cleared`: it failed, and an operator cleared it with
 * `pathways clear`.
 *
 * @example
 * ```ts
 * const done = (status: MessageStatus): boolean => status === "transformed" || status === "filtered";
 * ```
 */
export type MessageStatus = "received" | "transformed" | "filtered" | "failed" | "cleared";

/**
 * Where one delivery of a message to one destination stands. `cleared`: it failed for good, and an
 * operator cleared it, or replayed its message. `dry-run`: its destination runs dry (`dryRun: true`,
 * or `pathways start --dry-run`), so its output was recorded and never sent. `filtered`: the
 * destination's own transform returned nothing for the message, so nothing goes to it; done, as a
 * delivered one is.
 *
 * @example
 * ```ts
 * const open = (status: DeliveryStatus): boolean => status === "pending";
 * ```
 */
export type DeliveryStatus =
  "pending" | "delivered" | "failed" | "cleared" | "dry-run" | "filtered";

/**
 * Every state a message can be in, as an operator sees it. {@link messageState} says how each is
 * worked out.
 *
 * @example
 * ```ts
 * MESSAGE_STATES.includes("retrying"); // true
 * ```
 */
export const MESSAGE_STATES = [
  "received",
  "queued",
  "retrying",
  "delivered",
  "dry-run",
  "filtered",
  "failed",
  "cleared",
] as const;

/**
 * A message's state as an operator sees it: its status, and for a transformed one, its deliveries.
 *
 * @example
 * ```ts
 * const waiting: readonly MessageState[] = ["received", "queued", "retrying"];
 * ```
 */
export type MessageState = (typeof MESSAGE_STATES)[number];

/**
 * How many deliveries stand at each status. `dry-run` is there only when some delivery ran dry, and
 * `filtered` only when a destination's transform filtered one, so the counts of a project that does
 * neither read as they did before.
 *
 * @example
 * ```ts
 * const recorded = (counts: DeliveryCounts): number => counts.delivered + (counts["dry-run"] ?? 0);
 * ```
 */
export type DeliveryCounts = Readonly<
  Record<Exclude<DeliveryStatus, "dry-run" | "filtered">, number>
> & {
  readonly "dry-run"?: number;
  readonly filtered?: number;
};

/**
 * How many of one message's deliveries stand at each status. `retrying` counts the pending ones
 * that have failed at least once, so it is part of `pending`. `dry-run` is there only when one ran
 * dry.
 *
 * @example
 * ```ts
 * const open = (tally: DeliveryTally): number => tally.pending + tally.failed;
 * ```
 */
export type DeliveryTally = DeliveryCounts & { readonly retrying: number };

/**
 * Retention marks the messages it is about to delete with this status, inside the transaction that
 * deletes them, so a concurrent change takes them out of the batch. It is never committed.
 */
const EXPIRING = "expiring";
type StoredStatus = MessageStatus | typeof EXPIRING;

/**
 * A 64-bit integer column. pg and tedious return one as a string, so every read goes through
 * `Number`; ids and epoch milliseconds stay far below 2^53.
 */
type Int64 = ColumnType<number | string, number, number>;

/** A primary key the database numbers. */
type Id = ColumnType<number | string, never, never>;

interface MessagesTable {
  id: Id;
  channel: string;
  received_at: string;
  body: Uint8Array;
  status: StoredStatus;
  error: string | null;
  updated_at: string;
  /** A hash of who sent the message and its control ID, for spotting a repeat. Since 0002. */
  dedup_key: string | null;
  /** The latest earlier message with the same `dedup_key`: set means a possible duplicate. Since 0002. */
  duplicate_of: ColumnType<number | string | null, number | null, number | null>;
  /** The body's size in bytes, as received. Since 0003; null for messages stored before it. */
  size: ColumnType<number | string | null, number | null, number | null>;
  /** How often the message was replayed or resent: its current deliveries carry this. Since 0003. */
  generation: Generated<number>;
  /** A hash of what names this one message to its source, so it is stored once. Since 0004. */
  idempotency_key: string | null;
  /** The SHA-256 of the body as received, in hex, when the engine passed one. Since 0008. */
  content_hash: string | null;
  /** When the bodies were dropped after the last delivery; null while they are kept. Since 0008. */
  content_dropped_at: string | null;
  /**
   * The message's metadata as JSON, through the codec (encrypted, under encryption): null when it
   * has none. Since 0010.
   */
  meta: string | null;
}

/**
 * The index tags of each message's metadata: one row per message per index, written with the
 * message and deleted with it. Since 0010.
 */
interface MetaIndexTable {
  id: Id;
  message_id: Int64;
  channel: string;
  /** The metadata key the index covers. */
  index_name: string;
  /** The master key id the tag's key was derived under. */
  key_id: string;
  /** The truncated HMAC, in lowercase hex. */
  tag: string;
}

interface DeliveriesTable {
  id: Id;
  message_id: Int64;
  channel: string;
  destination: number;
  seq: number;
  body: Uint8Array;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: Int64;
  last_error: string | null;
  delivered_at: string | null;
  /** The message's generation this delivery was queued for. Since 0003. */
  generation: Generated<number>;
  /**
   * When the attempt in flight was handed to its destination, in epoch milliseconds: set before the
   * send and cleared by its outcome, so a row found with it set was cut off between the two. Since
   * 0005.
   */
  sending_at: ColumnType<number | string | null, number | null, number | null>;
  /** The number of the attempt in flight, beside `sending_at`. Since 0005. */
  sending_attempt: number | null;
  /** The latest attempt found cut off: set means every later send is a possible duplicate. Since 0005. */
  interrupted_attempt: number | null;
}

/** The audit log. Rows are only ever inserted: nothing here updates or deletes one. Since 0003. */
interface AuditLogTable {
  id: Id;
  at: string;
  actor: string;
  action: AuditAction;
  outcome: AuditOutcome;
  channel: string | null;
  message_id: ColumnType<number | string | null, number | null, never>;
  /** JSON: counts, statuses, codes and hashes. Never content. */
  detail: string | null;
}

/**
 * The leases: one row per lease, named. The engine takes the `engine` lease. Every time is in epoch
 * milliseconds by the database's clock, never a node's. Since 0006.
 */
interface LeasesTable {
  name: string;
  /** The node that took it last: an id each engine process draws at start. Empty until taken. */
  owner: string;
  /** The host name of that node. */
  host: string;
  /** Rises by one on every acquisition; a fenced write carries the epoch it was taken under. */
  epoch: Int64;
  /** When it was taken. */
  since: Int64;
  /** When it lapses unless renewed; 0 once released. */
  expires_at: Int64;
}

/**
 * Each channel an operator paused or stopped, one row per channel: a channel with no row runs.
 * Every engine on the database reads it at the top of each pass. Since 0009.
 */
interface ChannelStatesTable {
  channel: string;
  state: ChannelRunState;
  /** When it was set, in epoch milliseconds by the database's clock. */
  changed_at: Int64;
}

interface Tables {
  messages: MessagesTable;
  deliveries: DeliveriesTable;
  audit_log: AuditLogTable;
  leases: LeasesTable;
  channel_states: ChannelStatesTable;
  meta_index: MetaIndexTable;
}

/**
 * What an operator set a channel to: `running` (the default), `paused` (its source takes nothing
 * in, while stored messages go on through the transform and delivery) or `stopped` (nothing of it
 * runs). Kept in storage, so a restart, and every engine on the same database, honours it.
 *
 * @example
 * ```ts
 * const state: ChannelRunState = "paused";
 * ```
 */
export type ChannelRunState = "running" | "paused" | "stopped";

/**
 * What the engine tells storage about an incoming message. Every field is optional.
 *
 * @example
 * ```ts
 * await store.receive("adt", body, { duplicateKey: hashOfSenderAndControlId });
 * ```
 */
export interface StoreReceiveOptions {
  /**
   * An opaque key for who sent the message and its control ID (the engine passes a hash). When an
   * earlier message of the channel has the same key, this one is stored flagged as a possible
   * duplicate of it.
   */
  readonly duplicateKey?: string | undefined;
  /** Stores the message as `failed`, with this reason, so it is kept but never transformed. */
  readonly failure?: string | undefined;
  /**
   * An opaque key that names this one message to its source (the engine passes a hash), stored
   * with the message. With `resumed`, when a message of the channel was already stored with the
   * same key, nothing is stored and that message's id comes back with `alreadyStored`: a source
   * that stored a message and then stopped before it could acknowledge it hands it in again on
   * restart, and it is stored once.
   */
  readonly idempotencyKey?: string | undefined;
  /**
   * True when the message may have been stored already under `idempotencyKey`, by an earlier run:
   * only then is the key looked up.
   */
  readonly resumed?: boolean | undefined;
  /**
   * The body's size in bytes as it arrived; defaults to `body.byteLength`. A storage layer that
   * changes the body on its way in, such as encryption, passes the original size along.
   */
  readonly size?: number | undefined;
  /**
   * A hash of the body as it arrived (the engine passes its SHA-256 in hex, for a channel that drops
   * content after delivery), kept with the message's metadata after its body is dropped.
   */
  readonly contentHash?: string | undefined;
  /**
   * The message's metadata. A store wrapper (encryption at rest) turns it into `storedMeta` and
   * `metaTags` before it reaches the store underneath; a store given it bare keeps it as JSON.
   */
  readonly meta?: MessageMeta | undefined;
  /** The metadata as the store keeps it: JSON, encrypted under encryption. Set by a wrapper. */
  readonly storedMeta?: string | undefined;
  /** The metadata's index tags, stored with the message in the same transaction. Set by a wrapper. */
  readonly metaTags?: readonly MetaTag[] | undefined;
}

/**
 * An incoming message, stored.
 *
 * @example
 * ```ts
 * const { id, duplicateOf } = await store.receive("adt", body);
 * ```
 */
export interface ReceivedMessage {
  readonly id: number;
  /** The latest earlier message of the channel with the same duplicate key, when there is one. */
  readonly duplicateOf: number | undefined;
  /**
   * True when a message of the channel was already stored with the same idempotency key: `id` is
   * that message's, and nothing new was stored.
   */
  readonly alreadyStored?: boolean;
}

/**
 * What storage holds about one message, without its body or its error: safe to list.
 *
 * @example
 * ```ts
 * const { items } = await store.listMessages({ state: "failed", limit: 20 });
 * const ids = items.map((message: MessageSummary) => message.id);
 * ```
 */
export interface MessageSummary {
  readonly id: number;
  readonly channel: string;
  readonly status: MessageStatus;
  /** The status and the current deliveries, as an operator sees them. */
  readonly state: MessageState;
  readonly receivedAt: string;
  /** When the message last changed: transformed, failed, replayed or cleared. */
  readonly updatedAt: string;
  /** The body's size in bytes, or null for a message stored before sizes were kept. */
  readonly size: number | null;
  /** The latest earlier message with the same sender and control ID, when there is one. */
  readonly duplicateOf: number | null;
  /** 0 until the message is first replayed or resent; one more each time. */
  readonly generation: number;
  /** The deliveries of the current generation, by status. */
  readonly deliveries: DeliveryTally;
  /** The hash of the body as received, when one was stored with it: see {@link StoreReceiveOptions}. */
  readonly contentHash?: string | undefined;
  /**
   * When the message's body and its deliveries' bodies were dropped, once its last delivery was
   * delivered (`storage.content: dropAfterDelivery`). Undefined while they are kept. Such a
   * message cannot be replayed or resent, and its content cannot be shown.
   */
  readonly contentDroppedAt?: string | undefined;
}

/**
 * What storage holds about one message, without its body.
 *
 * @example
 * ```ts
 * const message: StoredMessage | undefined = await store.message(12);
 * ```
 */
export interface StoredMessage extends MessageSummary {
  /**
   * Why the message failed, as stored. The part after the second `": "` is the error's own text,
   * which can quote the message: never print it.
   */
  readonly error: string | null;
}

/**
 * One delivery of a message, without its body.
 *
 * @example
 * ```ts
 * const waiting = (await store.deliveries(12)).filter((d: StoredDelivery) => d.status === "pending");
 * ```
 */
export interface StoredDelivery {
  readonly id: number;
  readonly destination: number;
  /**
   * Which output of the transform this is, from 0; -1 for a delivery with no output, which its
   * destination's own transform filtered (`filtered`) or failed (`failed`, then `cleared`).
   */
  readonly seq: number;
  readonly generation: number;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  /** Epoch milliseconds before which it is not tried again; 0 when due at once. */
  readonly nextAttemptAt: number;
  readonly deliveredAt: string | null;
  /** The last failure, as stored: a stage and a code, such as `delivery: ECONNREFUSED`. */
  readonly error: string | null;
  /**
   * Set when an attempt of this delivery was cut off, its outcome never recorded, so the receiver
   * may have it more than once: the number of the latest such attempt. Every later send of it is
   * flagged as a possible duplicate.
   */
  readonly interruptedAttempt?: number | undefined;
}

/**
 * The marker written on a delivery before it is handed to its destination: which attempt it is and
 * when it started. The outcome write clears it, so a delivery found still marked was cut off between
 * the send and the record of it, and the receiver may have it.
 *
 * @example
 * ```ts
 * await store.markSending(delivery.id, { attempt: delivery.attempts + 1, at: Date.now() });
 * ```
 */
export interface SendingMarker {
  /** The attempt's number, from 1. */
  readonly attempt: number;
  /** When it started, in epoch milliseconds. */
  readonly at: number;
}

/**
 * What {@link MessageStore.markSending} writes: the marker, and, when the delivery was found marked,
 * the number of the attempt that was cut off.
 *
 * @example
 * ```ts
 * const start: SendStart = { attempt: 2, at: Date.now(), interruptedAttempt: 1 };
 * ```
 */
export interface SendStart extends SendingMarker {
  /** The attempt found cut off, kept on the delivery so every later send of it is flagged. */
  readonly interruptedAttempt?: number | undefined;
}

/**
 * A pending delivery that has failed at least once and waits to be tried again.
 *
 * @example
 * ```ts
 * const late = (d: RetryingDelivery): boolean => d.nextAttemptAt > Date.now() + 60_000;
 * ```
 */
export interface RetryingDelivery {
  readonly id: number;
  readonly messageId: number;
  readonly destination: number;
  readonly attempts: number;
  /** Epoch milliseconds of the next try. */
  readonly nextAttemptAt: number;
}

/**
 * A stored message waiting for its transform.
 *
 * @example
 * ```ts
 * const next: PendingMessage | undefined = await store.nextToTransform("adt");
 * ```
 */
export interface PendingMessage {
  readonly id: number;
  readonly body: Uint8Array;
}

/**
 * The oldest delivery still pending for one destination of one channel.
 *
 * @example
 * ```ts
 * const due = (delivery: PendingDelivery): boolean => delivery.nextAttemptAt <= Date.now();
 * ```
 */
export interface PendingDelivery {
  readonly id: number;
  readonly messageId: number;
  readonly seq: number;
  readonly body: Uint8Array;
  readonly attempts: number;
  /** Epoch milliseconds before which this delivery must not be tried again. */
  readonly nextAttemptAt: number;
  /**
   * The marker of an attempt whose outcome was never recorded: set means it was cut off after it
   * was handed to the destination, which may have it. Undefined when there is none, and from a
   * store that keeps no marker.
   */
  readonly sending?: SendingMarker | undefined;
  /** The latest attempt found cut off, kept after it: see {@link StoredDelivery.interruptedAttempt}. */
  readonly interruptedAttempt?: number | undefined;
}

/**
 * What {@link MessageStore.nextDelivery} looks for. Without `dueBy` it returns the oldest pending
 * delivery, due or not, which keeps a destination in order.
 *
 * @example
 * ```ts
 * const due = await store.nextDelivery("adt", 0, { dueBy: Date.now() });
 * ```
 */
export interface NextDeliveryOptions {
  /**
   * Only a delivery due by this time, in epoch milliseconds: the oldest whose `nextAttemptAt` is at
   * or before it, passing over any still waiting for a retry. The engine asks this for a destination
   * with `retry.rotate: true`. A store that ignores it keeps that destination in order.
   */
  readonly dueBy?: number | undefined;
}

/**
 * Which messages {@link MessageStore.listMessages} returns: newest first, every filter optional.
 *
 * @example
 * ```ts
 * const query: MessageQuery = { channel: "adt", state: "failed", since: "2026-11-01T00:00:00.000Z", limit: 50 };
 * ```
 */
export interface MessageQuery {
  readonly channel?: string | undefined;
  readonly state?: MessageState | undefined;
  /** Received at or after this time (ISO 8601, UTC). */
  readonly since?: string | undefined;
  /** Received before this time (ISO 8601, UTC). */
  readonly until?: string | undefined;
  /** Only ids below this one: the `next` of the page before. */
  readonly before?: number | undefined;
  /** Only these messages, by id. */
  readonly ids?: readonly number[] | undefined;
  readonly limit: number;
}

/**
 * Which messages {@link MessageStore.metaCandidates} returns: those of `channel` that carry, for
 * every condition, one of its tags, newest first, with the other filters of a listing.
 *
 * @example
 * ```ts
 * const query: MetaCandidateQuery = { channel: "adt", conditions: [condition], limit: 100 };
 * ```
 */
export interface MetaCandidateQuery {
  readonly channel: string;
  readonly conditions: readonly MetaCondition[];
  readonly state?: MessageState | undefined;
  /** Received at or after this time (ISO 8601, UTC). */
  readonly since?: string | undefined;
  /** Received before this time (ISO 8601, UTC). */
  readonly until?: string | undefined;
  /** Only ids below this one. */
  readonly before?: number | undefined;
  readonly limit: number;
}

/**
 * A message whose index tags match a search, and its metadata as stored, which the search decrypts
 * to confirm the match: tags are truncated, so a row can carry a tag and hold another value.
 *
 * @example
 * ```ts
 * const candidate: MetaCandidate = { id: 12, meta: storedJson };
 * ```
 */
export interface MetaCandidate {
  readonly id: number;
  readonly meta: string;
}

/**
 * One message's metadata and its index tags, as stored: what `pathways rekey` reads to re-encrypt
 * the metadata and derive its tags again under the current key.
 *
 * @example
 * ```ts
 * const row: StoredMeta = { id: 12, channel: "adt", meta: storedJson, tags: [] };
 * ```
 */
export interface StoredMeta {
  readonly id: number;
  readonly channel: string;
  readonly meta: string;
  readonly tags: readonly MetaTag[];
}

/**
 * What `pathways rekey` needs from storage to rewrite metadata: every message's metadata and tags,
 * and a way to replace them. {@link Store} implements it.
 *
 * @example
 * ```ts
 * for (const row of await store.storedMeta(0, 100)) await store.replaceMeta(row, next(row));
 * ```
 */
export interface MetaStore {
  /** Up to `limit` messages with metadata and an id above `after`, oldest first, as stored. */
  storedMeta(after: number, limit: number): Promise<StoredMeta[]>;
  /**
   * Replaces a message's metadata and all its tags with `next`, in one transaction, only while the
   * metadata is still what `current` read. Returns whether it did.
   */
  replaceMeta(
    current: StoredMeta,
    next: { readonly meta: string; readonly tags: readonly MetaTag[] },
  ): Promise<boolean>;
}

/**
 * Whether `store` also implements {@link MetaStore}, so `pathways rekey` can rewrite its metadata.
 *
 * @example
 * ```ts
 * if (isMetaStore(raw)) await rekey(raw, keys, { indexes });
 * ```
 */
export function isMetaStore(store: object): store is MetaStore {
  const candidate = store as Partial<MetaStore>;
  return typeof candidate.storedMeta === "function" && typeof candidate.replaceMeta === "function";
}

/**
 * One page of results, newest first. `next` is the `before` that fetches the page after it.
 *
 * @example
 * ```ts
 * const first: Page<MessageSummary> = await store.listMessages({ limit: 50 });
 * const second = await store.listMessages({ limit: 50, before: first.next });
 * ```
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly next: number | undefined;
}

/**
 * What one destination's transform gave for a message, as storage records it: its outputs, in
 * order, none meaning it filtered the message for that destination; or why it failed, as stored,
 * which fails that destination's delivery only.
 *
 * @example
 * ```ts
 * const results: DestinationOutcome[] = [{ outputs: [body] }, { outputs: [] }, { failure: "transform: TypeError: ..." }];
 * ```
 */
export type DestinationOutcome = (
  { readonly outputs: readonly Uint8Array[] } | { readonly failure: string }
) & {
  /**
   * For a destination with no output: the body its one delivery row holds, as the store keeps it.
   * A layer that encodes every body on its way in (encryption at rest) passes its encoding of an
   * empty body here, so no row holds a body that did not pass through it. Empty when not given.
   */
  readonly emptyBody?: Uint8Array | undefined;
};

/**
 * What a transform gave, as {@link MessageStore.completeTransform} records it: the same outputs for
 * every destination, or, on a channel with destination transforms, one {@link DestinationOutcome}
 * per destination, in order.
 *
 * @example
 * ```ts
 * const same: TransformOutputs = [body];
 * const each: TransformOutputs = { byDestination: [{ outputs: [body] }, { outputs: [] }] };
 * ```
 */
export type TransformOutputs =
  readonly Uint8Array[] | { readonly byDestination: readonly DestinationOutcome[] };

/**
 * Whether a transform's outputs were given one destination at a time.
 *
 * @example
 * ```ts
 * isByDestination({ byDestination: [] }); // true
 * ```
 */
export function isByDestination(
  outputs: TransformOutputs,
): outputs is { readonly byDestination: readonly DestinationOutcome[] } {
  return !Array.isArray(outputs);
}

/**
 * The status a message takes from what its transform gave: `filtered` when no destination has an
 * output or a failure, else `transformed`.
 */
function transformedStatus(outputs: TransformOutputs): MessageStatus {
  if (!isByDestination(outputs)) return outputs.length === 0 ? "filtered" : "transformed";
  const filtered = outputs.byDestination.every(
    (outcome) => "outputs" in outcome && outcome.outputs.length === 0,
  );
  return filtered ? "filtered" : "transformed";
}

/**
 * What a replay or a resend asks storage to record. Storage checks the message still stands where
 * the caller found it, and changes nothing otherwise.
 *
 * @example
 * ```ts
 * const request: RequeueRequest = { mode: "resend", expected: "transformed", outputs, destinations: 2 };
 * ```
 */
export interface RequeueRequest {
  /** `replay` ran the transform again; `resend` queues the stored outputs again. */
  readonly mode: "replay" | "resend";
  /** The status the caller read before transforming. */
  readonly expected: MessageStatus;
  /**
   * The outputs to queue, in order, for each of `destinations`. None, without a `failure`, means the
   * transform filtered the message out.
   */
  readonly outputs: readonly Uint8Array[];
  /** What the replayed transform failed with, as stored; the message is marked failed. */
  readonly failure?: string | undefined;
  /** How many destinations the channel has now. */
  readonly destinations: number;
  /**
   * On a channel with destination transforms: what each destination gets, in order, in place of
   * `outputs` for every one. A destination's failure is recorded as its failed delivery.
   */
  readonly byDestination?: readonly DestinationOutcome[] | undefined;
}

/**
 * Why storage did not record a replay or a clear. `content-dropped`: the message's content was
 * dropped after delivery, so there is nothing to replay or resend.
 *
 * @example
 * ```ts
 * const retryable = (reason: RefusalReason): boolean => reason === "changed" || reason === "pending";
 * ```
 */
export type RefusalReason = "not-found" | "changed" | "pending" | "not-failed" | "content-dropped";

/**
 * What a replay or a resend did, with the audit entry written in the same transaction.
 *
 * @example
 * ```ts
 * const result: RequeueResult = await store.requeue(12, request, "noah");
 * if (!result.done) console.log(result.reason);
 * ```
 */
export type RequeueResult =
  | {
      readonly done: true;
      readonly status: MessageStatus;
      /** Deliveries queued, at the back of each destination's queue. */
      readonly queued: number;
      /** Earlier deliveries that had failed for good, now cleared. */
      readonly superseded: number;
      readonly generation: number;
      readonly entry: AuditEntry;
    }
  | {
      readonly done: false;
      readonly reason: Extract<
        RefusalReason,
        "not-found" | "changed" | "pending" | "content-dropped"
      >;
      readonly entry: AuditEntry;
    };

/**
 * What a clear did, with the audit entry written in the same transaction.
 *
 * @example
 * ```ts
 * const result: ClearResult = await store.clear(12, "noah");
 * if (result.done) console.log(result.messages, result.deliveries);
 * ```
 */
export type ClearResult =
  | {
      readonly done: true;
      /** 1 when the message itself had failed, else 0. */
      readonly messages: number;
      /** Its deliveries that had failed for good. */
      readonly deliveries: number;
      readonly entry: AuditEntry;
    }
  | {
      readonly done: false;
      readonly reason: Extract<RefusalReason, "not-found" | "not-failed">;
      readonly entry: AuditEntry;
    };

/**
 * What retention deleted, or would delete, from one channel.
 *
 * @example
 * ```ts
 * const { messages, deliveries }: ExpireResult = await store.expire("adt", cutoff, true);
 * ```
 */
export interface ExpireResult {
  readonly messages: number;
  readonly deliveries: number;
}

/**
 * Every action the audit log records:
 *
 * - `search`: messages listed; `view`: one message's details shown, without content;
 * - `content-view`: a message's content shown;
 * - `replay`, `resend`, `clear`: what the commands of the same names did;
 * - `retention`: a retention run and what it deleted;
 * - `config`: a change to the configuration, seen when the engine started.
 * - `lease-release`: `pathways lease release --force` freed the engine lease.
 * - `migrate`: `pathways migrate` applied schema steps, or said which it would apply.
 * - `channel-pause`, `channel-resume`, `channel-stop`, `channel-halt` and `channel-reload`: what
 *   the `pathways channel` commands of the same names asked, with the user the client named.
 * - `verify`: `pathways verify` read a stored message's content, to run it through a candidate
 *   project's transform; written before the content is read.
 *
 * @example
 * ```ts
 * AUDIT_ACTIONS.includes("content-view"); // true
 * ```
 */
export const AUDIT_ACTIONS = [
  "search",
  "view",
  "content-view",
  "replay",
  "resend",
  "clear",
  "retention",
  "config",
  "lease-release",
  "migrate",
  "channel-pause",
  "channel-resume",
  "channel-stop",
  "channel-halt",
  "channel-reload",
  "verify",
] as const;

/**
 * One of {@link AUDIT_ACTIONS}.
 *
 * @example
 * ```ts
 * const action: AuditAction = "content-view";
 * ```
 */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * How an audited action ended: done, refused (its `detail.reason` says why), or no such message.
 *
 * @example
 * ```ts
 * const failed = (outcome: AuditOutcome): boolean => outcome !== "ok";
 * ```
 */
export type AuditOutcome = "ok" | "refused" | "not-found";

/**
 * An audit entry's particulars: counts, statuses, codes and hashes. Never content.
 *
 * @example
 * ```ts
 * const detail: AuditDetail = { status: "transformed", queued: 2 };
 * ```
 */
export type AuditDetail = Readonly<Record<string, string | number | boolean>>;

/**
 * An audit entry to append. The store adds the time and the actor.
 *
 * @example
 * ```ts
 * await store.appendAudit("noah", [{ action: "content-view", channel: "adt", messageId: 12 }]);
 * ```
 */
export interface AuditInput {
  readonly action: AuditAction;
  /** Defaults to `ok`. */
  readonly outcome?: AuditOutcome | undefined;
  readonly channel?: string | undefined;
  readonly messageId?: number | undefined;
  readonly detail?: AuditDetail | undefined;
}

/**
 * One entry of the audit log, as stored.
 *
 * @example
 * ```ts
 * const line = (entry: AuditEntry): string => `${entry.at} ${entry.actor} ${entry.action}`;
 * ```
 */
export interface AuditEntry {
  readonly id: number;
  /** When, in ISO 8601 UTC. */
  readonly at: string;
  /** The operating system user who acted. */
  readonly actor: string;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly channel: string | null;
  readonly messageId: number | null;
  readonly detail: AuditDetail;
}

/**
 * Which audit entries {@link MessageStore.auditEntries} returns: newest first, filters optional.
 *
 * @example
 * ```ts
 * const views = await store.auditEntries({ action: "content-view", since: "2026-11-01", limit: 100 });
 * ```
 */
export interface AuditQuery {
  readonly action?: AuditAction | undefined;
  readonly channel?: string | undefined;
  readonly messageId?: number | undefined;
  /** At or after this time (ISO 8601, UTC). */
  readonly since?: string | undefined;
  /** Before this time (ISO 8601, UTC). */
  readonly until?: string | undefined;
  /** Only ids below this one: the `next` of the page before. */
  readonly before?: number | undefined;
  readonly limit: number;
}

/**
 * What the engine and the operator commands need from storage. {@link Store} implements it on
 * SQLite, PostgreSQL, MySQL or MariaDB, and SQL Server; a storage adapter for anything else
 * implements the same methods, and its module's `StoreFactory` returns it. A layer around a store
 * (encryption at rest) wraps them: every method that takes or returns a body or an error's text is
 * here, so a wrapping layer sees them all.
 *
 * Every method is the engine's only path to that data, so an adapter keeps these promises: `receive`
 * is durable before it resolves; `completeTransform` writes all its deliveries and the message's new
 * status, or none of them; `nextDelivery` returns the lowest pending id for that destination, so
 * deliveries stay in order; a new delivery is due at once (`nextAttemptAt` 0); `markSending` is
 * durable before it resolves, `nextDelivery` returns the marker it wrote, and `markDelivered`,
 * `scheduleRetry` and `failDelivery` clear it in the same write as their outcome. For the operator
 * commands: `requeue` and `clear` change nothing unless the message still stands where the caller
 * found it, and write their audit entry in the same transaction as their change; `expire` deletes
 * only done messages, with their deliveries, and never an audit entry. A message whose content was
 * dropped (`markDeliveredAndDropContent`) is never replayed, resent or expired.
 *
 * The audit log has two methods, append and read, and no way to change or remove an entry.
 *
 * The lease methods are optional. A store with `acquireLease`, `renewLease`, `releaseLease` and
 * `leaseHolder` lets `pathways start` refuse a second engine and run a standby; each judges expiry
 * by one clock, the database's, in the same statement as its change. Given an `epoch`, the fenced
 * writes (`completeTransform`, `failTransform`, `markSending`, `markDelivered`, `scheduleRetry` and
 * `failDelivery`) change their row only while the engine lease still carries that epoch, in the
 * same statement, and reject with a {@link LeaseLostError} when they change nothing. A store
 * without the lease methods runs as before, with a warning at start, and cannot run a standby.
 *
 * @example
 * ```ts
 * class PoolStore implements MessageStore {
 *   async receive(channel: string, body: Uint8Array, options?: StoreReceiveOptions) {
 *     const id = await this.pool.insertMessage(channel, body, options?.failure);
 *     return { id, duplicateOf: undefined };
 *   }
 *   // ...and the other methods, each against the same database.
 * }
 * ```
 */
export interface MessageStore {
  /**
   * Stores an incoming message, durably, before its source acknowledges it: as `received`, or as
   * `failed` when `options.failure` is set. Flags it as a possible duplicate when an earlier
   * message of the channel has the same `options.duplicateKey`. Given `options.resumed`, when a
   * message of the channel was already stored with the same `options.idempotencyKey`, stores
   * nothing and returns that message's id with `alreadyStored: true`. A store that ignores the key
   * still works, and a source that stops between storing and acknowledging then stores that
   * message twice.
   */
  receive(
    channel: string,
    body: Uint8Array,
    options?: StoreReceiveOptions,
  ): Promise<ReceivedMessage>;
  nextToTransform(channel: string): Promise<PendingMessage | undefined>;
  /**
   * Records a transform's outputs and the message's new status, all or nothing: given a list, one
   * pending delivery per output per destination, and the message `filtered` when the list is
   * empty; given `{ byDestination }`, each destination's own outputs as pending deliveries, a
   * destination with none as one `filtered` delivery and one that failed as one `failed` delivery
   * with its error, and the message `filtered` only when every destination filtered it. Fenced by
   * `epoch` when it is given: see the lease methods above.
   */
  completeTransform(
    messageId: number,
    outputs: TransformOutputs,
    destinations: number,
    epoch?: number,
  ): Promise<void>;
  /** Fenced by `epoch` when it is given. */
  failTransform(messageId: number, error: string, epoch?: number): Promise<void>;
  nextDelivery(
    channel: string,
    destination: number,
    options?: NextDeliveryOptions,
  ): Promise<PendingDelivery | undefined>;
  /**
   * Writes the marker before a delivery is handed to its destination, in one write: the attempt and
   * its start, and the attempt found cut off when `start.interruptedAttempt` is set. A delivery
   * {@link nextDelivery} returns still marked was cut off, and its next send is flagged. Fenced by
   * `epoch` when it is given.
   */
  markSending(deliveryId: number, start: SendStart, epoch?: number): Promise<void>;
  /** Fenced by `epoch` when it is given. */
  markDelivered(deliveryId: number, epoch?: number): Promise<void>;
  /**
   * {@link markDelivered}, and when that was the last delivery of the message's current generation
   * still to be delivered, also drops the bodies of the message and of all its deliveries in the
   * same transaction, keeping its metadata: ids, times, statuses, sizes, the content hash and the
   * possible-duplicate flag. Its `ctx.meta` and that metadata's index tags go with the bodies, since
   * they hold identifiers. Keeps every body while any delivery of the current generation has
   * failed or waits to be tried again. Resolves to whether it dropped them. Fenced by `epoch` when
   * it is given. Optional: a channel with `storage.content: dropAfterDelivery` needs it, and the
   * engine refuses to start such a channel on a store without it.
   */
  markDeliveredAndDropContent?(deliveryId: number, epoch?: number): Promise<boolean>;
  /**
   * Marks a delivery `dry-run`: its output stays recorded, it was never sent, and its destination
   * moves on to the next. Clears the marker. Fenced by `epoch` when it is given. Optional: an engine
   * with a destination that runs dry refuses to start on a store without it.
   */
  markDryRun?(deliveryId: number, epoch?: number): Promise<void>;
  /** Fenced by `epoch` when it is given. */
  scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
    epoch?: number,
  ): Promise<void>;
  /** Fenced by `epoch` when it is given. */
  failDelivery(deliveryId: number, error: string, epoch?: number): Promise<void>;
  /**
   * Takes the lease `name` for `ttlMs` when it is free or has lapsed by the database's clock,
   * raising its epoch by one, in one statement; else answers with its holder. Optional.
   */
  acquireLease?(name: string, claimant: LeaseClaimant, ttlMs: number): Promise<LeaseClaim>;
  /**
   * Extends the lease `name` to `ttlMs` from now, by the database's clock, while it still carries
   * `epoch` and has not lapsed. Returns whether it did. Optional, with {@link acquireLease}.
   */
  renewLease?(name: string, epoch: number, ttlMs: number): Promise<boolean>;
  /**
   * Frees the lease `name`, so the next acquisition takes it at once: only while it carries `epoch`
   * when that is given, whoever holds it when not (`pathways lease release --force`). Returns
   * whether it freed it. Optional, with {@link acquireLease}.
   */
  releaseLease?(name: string, epoch?: number): Promise<boolean>;
  /** The lease's last holder, or `undefined` when it was never taken. Optional, with {@link acquireLease}. */
  leaseHolder?(name: string): Promise<LeaseHolder | undefined>;
  /**
   * Every channel an operator paused or stopped, by name; a channel missing from it runs. Optional,
   * with {@link setChannelState}: a store without them keeps a channel's state in the engine only,
   * so a restart forgets it.
   */
  channelStates?(): Promise<Record<string, ChannelRunState>>;
  /** Sets a channel's state; `running` removes its row. Optional, with {@link channelStates}. */
  setChannelState?(channel: string, state: ChannelRunState): Promise<void>;
  /** How many messages of a channel stand at each status. The health endpoint reports these. */
  messageCounts(channel: string): Promise<Record<MessageStatus, number>>;
  /** How many deliveries of a channel stand at each status; `dry-run` only when some ran dry. */
  deliveryCounts(channel: string): Promise<DeliveryCounts>;
  /** How many of a channel's pending deliveries have failed at least once and wait for a retry. */
  retryingDeliveries(channel: string): Promise<number>;

  /** Every channel with a stored message, by name. */
  channels(): Promise<string[]>;
  /** One message, without its body, or `undefined` if there is none. Its `error` is raw: see there. */
  message(id: number): Promise<StoredMessage | undefined>;
  /** One message's body as it arrived, or `undefined` if there is none or it was dropped. */
  messageBody(id: number): Promise<Uint8Array | undefined>;
  /** A message's deliveries, every generation, oldest first, without bodies. */
  deliveries(messageId: number): Promise<StoredDelivery[]>;
  /**
   * The outputs of a message's current generation, in order; none when it has none or they were
   * dropped. Those of `destination` when it is given, else those of the first destination that has
   * any.
   */
  outputs(messageId: number, destination?: number): Promise<Uint8Array[]>;
  /** A page of messages, newest first, without bodies or errors. */
  listMessages(query: MessageQuery): Promise<Page<MessageSummary>>;
  /**
   * Up to `query.limit` messages that carry the tags `query` names, newest first, each with its
   * metadata as stored, for a metadata search to confirm. Optional: a store without it cannot be
   * searched by metadata.
   */
  metaCandidates?(query: MetaCandidateQuery): Promise<MetaCandidate[]>;
  /** A channel's retrying deliveries, oldest first, at most `limit`. */
  listRetrying(channel: string, limit: number): Promise<RetryingDelivery[]>;
  /**
   * Records a replay or a resend: the message's new status, a new generation, and fresh deliveries
   * at the back of each destination's queue. Refuses, changing nothing, when the message has moved
   * since the caller read it or has deliveries still pending. The audit entry is written in the
   * same transaction, whichever way it goes.
   */
  requeue(messageId: number, request: RequeueRequest, actor: string): Promise<RequeueResult>;
  /**
   * Marks a failed message, and its deliveries that failed for good, `cleared`. Refuses when there
   * is nothing failed. The audit entry is written in the same transaction.
   */
  clear(messageId: number, actor: string): Promise<ClearResult>;
  /**
   * Deletes a channel's messages that are done (delivered, dry-run, filtered or cleared) and whose
   * last activity is before `cutoff` (ISO 8601), with their deliveries, leaving those whose content
   * was dropped. With `dryRun`, counts them only.
   */
  expire(channel: string, cutoff: string, dryRun: boolean): Promise<ExpireResult>;
  /** Appends entries to the audit log, stamped with the time and `actor`. */
  appendAudit(actor: string, entries: readonly AuditInput[]): Promise<AuditEntry[]>;
  /** A page of the audit log, newest first. */
  auditEntries(query: AuditQuery): Promise<Page<AuditEntry>>;
  close(): Promise<void>;
}

/**
 * Which table a {@link StoredContent} row is from.
 *
 * @example
 * ```ts
 * const table: ContentTable = "deliveries";
 * ```
 */
export type ContentTable = "messages" | "deliveries";

/**
 * One row's content, exactly as storage holds it: a message's body and error, or a delivery's body
 * and last error. With encryption on, these are the encrypted values.
 *
 * @example
 * ```ts
 * const row: StoredContent = { table: "messages", id: 1, body, error: null };
 * ```
 */
export interface StoredContent {
  readonly table: ContentTable;
  readonly id: number;
  readonly body: Uint8Array;
  readonly error: string | null;
}

/**
 * What `pathways rekey` needs from storage beyond {@link MessageStore}: every stored body and error
 * text as stored, and a way to replace them. The engine never uses it. {@link Store} implements it;
 * a storage adapter that implements it can be rekeyed.
 *
 * @example
 * ```ts
 * for (const row of await store.storedContent("messages", 0, 100)) {
 *   await store.replaceContent(row, { body: reencrypted(row.body), error: row.error });
 * }
 * ```
 */
export interface ContentStore {
  /**
   * Up to `limit` rows of `table` with an id above `after`, oldest first, as stored, leaving out the
   * rows of a message whose content was dropped: they hold none.
   */
  storedContent(table: ContentTable, after: number, limit: number): Promise<StoredContent[]>;
  /**
   * Replaces a row's body and error with `next`, but only while the row still holds what `current`
   * read, so a change made meanwhile (a retry's new error) is never overwritten. Returns whether it
   * replaced them.
   */
  replaceContent(
    current: StoredContent,
    next: { readonly body: Uint8Array; readonly error: string | null },
  ): Promise<boolean>;
}

/**
 * Whether `store` also implements {@link ContentStore}, so `pathways rekey` can rewrite what it
 * holds. {@link Store} does; a custom store may.
 *
 * @example
 * ```ts
 * if (!isContentStore(raw)) throw new Error("this store cannot be rekeyed");
 * ```
 */
export function isContentStore(store: MessageStore): store is MessageStore & ContentStore {
  const candidate = store as Partial<ContentStore>;
  return (
    typeof candidate.storedContent === "function" && typeof candidate.replaceContent === "function"
  );
}

/**
 * The lease methods of {@link MessageStore}, all four present.
 *
 * @example
 * ```ts
 * const leases: LeaseStore | undefined = leaseStore(store);
 * ```
 */
export type LeaseStore = Required<
  Pick<MessageStore, "acquireLease" | "renewLease" | "releaseLease" | "leaseHolder">
>;

/**
 * `store`'s lease methods, or `undefined` when it lacks any of the four: such a store runs one
 * engine without a lease, and cannot run a standby. {@link Store} has them; a custom store may.
 *
 * @example
 * ```ts
 * if (leaseStore(store) === undefined) logger.warn({ event: "lease-unsupported" });
 * ```
 */
export function leaseStore(store: MessageStore): LeaseStore | undefined {
  if (
    typeof store.acquireLease !== "function" ||
    typeof store.renewLease !== "function" ||
    typeof store.releaseLease !== "function" ||
    typeof store.leaseHolder !== "function"
  ) {
    return undefined;
  }
  const leases = store as MessageStore & LeaseStore;
  return {
    acquireLease: (name, claimant, ttlMs) => leases.acquireLease(name, claimant, ttlMs),
    renewLease: (name, epoch, ttlMs) => leases.renewLease(name, epoch, ttlMs),
    releaseLease: (name, epoch) => leases.releaseLease(name, epoch),
    leaseHolder: (name) => leases.leaseHolder(name),
  };
}

/**
 * The channel state methods of {@link MessageStore}, both present.
 *
 * @example
 * ```ts
 * const states: ChannelStateStore | undefined = channelStateStore(store);
 * ```
 */
export type ChannelStateStore = Required<Pick<MessageStore, "channelStates" | "setChannelState">>;

/**
 * `store`'s channel state methods, or `undefined` when it lacks either: such a store keeps a paused
 * or stopped channel in the engine only. {@link Store} has them; a custom store may.
 *
 * @example
 * ```ts
 * const paused = (await channelStateStore(store)?.channelStates()) ?? {};
 * ```
 */
export function channelStateStore(store: MessageStore): ChannelStateStore | undefined {
  if (typeof store.channelStates !== "function" || typeof store.setChannelState !== "function") {
    return undefined;
  }
  const states = store as MessageStore & ChannelStateStore;
  return {
    channelStates: () => states.channelStates(),
    setChannelState: (channel, state) => states.setChannelState(channel, state),
  };
}

/** A column type: one Kysely knows by name, or raw SQL. */
type DataTypeExpression = ColumnDataType | Expression<unknown>;

/**
 * The column types each database spells differently. SQLite's are the types the store first wrote,
 * so a database it made then still matches.
 *
 * - Keys and epoch milliseconds are 64-bit on the servers; SQLite's `integer` already is.
 * - Names, statuses and duplicate keys are indexed, so MySQL and SQL Server need a bounded length.
 * - Text compares by code point everywhere: MySQL's tables and SQL Server's text columns take a
 *   binary collation, since their defaults ignore case and would let channel `ADT` read channel
 *   `adt`, or let rekey take one error text for another.
 * - Bodies take up to 4 GB on MySQL (`longblob`) and 2 GB on SQL Server; a plain MySQL `blob` holds
 *   64 KB.
 */

interface ColumnTypes {
  readonly key: DataTypeExpression;
  readonly int64: DataTypeExpression;
  readonly name: DataTypeExpression;
  readonly status: DataTypeExpression;
  readonly time: DataTypeExpression;
  readonly body: DataTypeExpression;
  readonly detail: DataTypeExpression;
  /** Makes `key` a primary key the database numbers. */
  readonly numbered: (col: ColumnDefinitionBuilder) => ColumnDefinitionBuilder;
  /** Ends a `create table`: MySQL's engine and collation. */
  readonly table: <T extends string, C extends string>(
    table: CreateTableBuilder<T, C>,
  ) => CreateTableBuilder<T, C>;
}

const SQL_SERVER_BINARY = sql.raw("collate Latin1_General_100_BIN2");

const COLUMN_TYPES: Readonly<Record<StorageKind, ColumnTypes>> = {
  sqlite: {
    key: "integer",
    int64: "integer",
    name: "text",
    status: "text",
    time: "text",
    body: "blob",
    detail: "text",
    numbered: (col) => col.primaryKey().autoIncrement(),
    table: (table) => table,
  },
  postgres: {
    key: "bigint",
    int64: "bigint",
    name: "text",
    status: "text",
    time: "text",
    body: "bytea",
    detail: "text",
    numbered: (col) => col.primaryKey().generatedByDefaultAsIdentity(),
    table: (table) => table,
  },
  mysql: {
    key: "bigint",
    int64: "bigint",
    name: "varchar(255)",
    status: "varchar(32)",
    time: "varchar(32)",
    body: sql`longblob`,
    detail: sql`mediumtext`,
    numbered: (col) => col.primaryKey().autoIncrement(),
    table: (table) =>
      table.modifyEnd(sql`engine = InnoDB default character set utf8mb4 collate utf8mb4_bin`),
  },
  sqlserver: {
    key: "bigint",
    int64: "bigint",
    name: sql`nvarchar(255) ${SQL_SERVER_BINARY}`,
    status: sql`nvarchar(32) ${SQL_SERVER_BINARY}`,
    time: sql`nvarchar(32)`,
    body: sql`varbinary(max)`,
    detail: sql`nvarchar(max) ${SQL_SERVER_BINARY}`,
    numbered: (col) => col.primaryKey().identity(),
    table: (table) => table,
  },
};

/**
 * The schema step that adds the audit log: a database without it has none to write to.
 *
 * @example
 * ```ts
 * const audited = state.applied.some((step) => step.name === AUDIT_LOG_STEP);
 * ```
 */
export const AUDIT_LOG_STEP = "0003-operator-and-audit";

/**
 * The schema's steps, in the column types of `kind`, each tagged `expand` or `contract`. One
 * portable set: each database runs the same steps under the same names, so the migration table
 * reads the same everywhere.
 *
 * Every step carries a tag. An expand step only adds, so the Pathways before it runs on the schema
 * after it, and it is applied at start. A contract step removes or changes what an older Pathways
 * reads, names the oldest Pathways that runs once it is applied, and waits for
 * `pathways migrate --contract`. A release's code runs on its schema both before and after its own
 * contract steps.
 *
 * @example
 * ```ts
 * const provider = { getMigrations: () => Promise.resolve(migrations("postgres")) };
 * ```
 */
export function migrations(kind: StorageKind): Record<string, SchemaStep> {
  const t = COLUMN_TYPES[kind];
  return {
    "0001-messages-and-deliveries": {
      tag: "expand",
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema
          .createTable("messages")
          .addColumn("id", t.key, t.numbered)
          .addColumn("channel", t.name, (col) => col.notNull())
          .addColumn("received_at", t.time, (col) => col.notNull())
          .addColumn("body", t.body, (col) => col.notNull())
          .addColumn("status", t.status, (col) => col.notNull())
          .addColumn("error", t.detail)
          .addColumn("updated_at", t.time, (col) => col.notNull())
          .$call(t.table)
          .execute();
        await db.schema
          .createIndex("messages_by_channel_status")
          .on("messages")
          .columns(["channel", "status", "id"])
          .execute();
        await db.schema
          .createTable("deliveries")
          .addColumn("id", t.key, t.numbered)
          .addColumn("message_id", t.int64, (col) => col.notNull().references("messages.id"))
          .addColumn("channel", t.name, (col) => col.notNull())
          .addColumn("destination", "integer", (col) => col.notNull())
          .addColumn("seq", "integer", (col) => col.notNull())
          .addColumn("body", t.body, (col) => col.notNull())
          .addColumn("status", t.status, (col) => col.notNull())
          .addColumn("attempts", "integer", (col) => col.notNull())
          .addColumn("next_attempt_at", t.int64, (col) => col.notNull())
          .addColumn("last_error", t.detail)
          .addColumn("delivered_at", t.time)
          .$call(t.table)
          .execute();
        await db.schema
          .createIndex("deliveries_by_destination_status")
          .on("deliveries")
          .columns(["channel", "destination", "status", "id"])
          .execute();
      },
    },
    "0002-possible-duplicates": {
      tag: "expand",
      async up(db: Kysely<unknown>): Promise<void> {
        // One column per statement: SQLite adds only one column per ALTER TABLE.
        await db.schema.alterTable("messages").addColumn("dedup_key", t.name).execute();
        await db.schema.alterTable("messages").addColumn("duplicate_of", t.int64).execute();
        await db.schema
          .createIndex("messages_by_channel_dedup_key")
          .on("messages")
          .columns(["channel", "dedup_key", "id"])
          .execute();
      },
    },
    [AUDIT_LOG_STEP]: {
      tag: "expand",
      async up(db: Kysely<unknown>): Promise<void> {
        // Sizes are kept from now on; a message stored before has none, rather than a guess.
        await db.schema.alterTable("messages").addColumn("size", t.int64).execute();
        await db.schema
          .alterTable("messages")
          .addColumn("generation", "integer", (col) => col.notNull().defaultTo(0))
          .execute();
        await db.schema
          .alterTable("deliveries")
          .addColumn("generation", "integer", (col) => col.notNull().defaultTo(0))
          .execute();
        // A message's deliveries, for its state, a replay's checks and retention.
        await db.schema
          .createIndex("deliveries_by_message")
          .on("deliveries")
          .columns(["message_id", "status"])
          .execute();
        // Append-only: nothing in Pathways updates or deletes a row of it.
        await db.schema
          .createTable("audit_log")
          .addColumn("id", t.key, t.numbered)
          .addColumn("at", t.time, (col) => col.notNull())
          .addColumn("actor", t.name, (col) => col.notNull())
          .addColumn("action", t.status, (col) => col.notNull())
          .addColumn("outcome", t.status, (col) => col.notNull())
          .addColumn("channel", t.name)
          .addColumn("message_id", t.int64)
          .addColumn("detail", t.detail)
          .$call(t.table)
          .execute();
        await db.schema
          .createIndex("audit_log_by_message")
          .on("audit_log")
          .columns(["message_id", "id"])
          .execute();
      },
    },
    "0004-idempotency-keys": {
      tag: "expand",
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema.alterTable("messages").addColumn("idempotency_key", t.name).execute();
        await db.schema
          .createIndex("messages_by_channel_idempotency_key")
          .on("messages")
          .columns(["channel", "idempotency_key", "id"])
          .execute();
      },
    },
    "0005-send-markers": {
      tag: "expand",
      // Expand only: three columns that may be null, which an older Pathways never reads.
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema.alterTable("deliveries").addColumn("sending_at", t.int64).execute();
        await db.schema.alterTable("deliveries").addColumn("sending_attempt", "integer").execute();
        await db.schema
          .alterTable("deliveries")
          .addColumn("interrupted_attempt", "integer")
          .execute();
      },
    },
    "0006-leases": {
      tag: "expand",
      // Expand only: a new table, which an older Pathways never reads, and no change to a row of
      // the others, so it is safe while deliveries are in flight. Its first row is written by the
      // first engine that asks for the lease. To roll it back, stop every engine and drop the
      // table; nothing else refers to it.
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema
          .createTable("leases")
          .addColumn("name", t.name, (col) => col.primaryKey())
          .addColumn("owner", t.name, (col) => col.notNull())
          .addColumn("host", t.name, (col) => col.notNull())
          .addColumn("epoch", t.int64, (col) => col.notNull())
          .addColumn("since", t.int64, (col) => col.notNull())
          .addColumn("expires_at", t.int64, (col) => col.notNull())
          .$call(t.table)
          .execute();
      },
    },
    [SCHEMA_INFO_STEP]: {
      // Expand only: a new table, which an older Pathways never reads. One row per applied step,
      // written in the step's own transaction: its generation, its tag, the oldest Pathways that
      // runs on the schema once it is applied, and the Pathways that applied it. This step writes
      // its own row and those of every step before it.
      tag: "expand",
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema
          .createTable("schema_info")
          .addColumn("step", t.name, (col) => col.primaryKey())
          .addColumn("generation", "integer", (col) => col.notNull())
          .addColumn("tag", t.status, (col) => col.notNull())
          .addColumn("min_engine", t.status, (col) => col.notNull())
          .addColumn("applied_by", t.status, (col) => col.notNull())
          .addColumn("applied_at", t.time, (col) => col.notNull())
          .$call(t.table)
          .execute();
      },
    },
    "0008-content-drop": {
      tag: "expand",
      // Expand only: two columns that may be null, which an older Pathways never reads, so it is
      // safe while deliveries are in flight. To roll it back, stop every engine and drop the two
      // columns; a message whose content was dropped then reads as one with an empty body.
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema.alterTable("messages").addColumn("content_hash", t.name).execute();
        await db.schema.alterTable("messages").addColumn("content_dropped_at", t.time).execute();
      },
    },
    "0009-channel-states": {
      // Expand only: a new table, which an older Pathways never reads. A channel with no row runs,
      // so the table starts empty. To roll it back, stop every engine and drop the table; every
      // channel then runs, and nothing else refers to it.
      tag: "expand",
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema
          .createTable("channel_states")
          .addColumn("channel", t.name, (col) => col.primaryKey())
          .addColumn("state", t.status, (col) => col.notNull())
          .addColumn("changed_at", t.int64, (col) => col.notNull())
          .$call(t.table)
          .execute();
      },
    },
    "0010-message-meta": {
      // Expand only: a column that may be null and a new table, which an older Pathways never
      // reads. An older Pathways that deletes a message leaves its tags behind; they name no
      // message, so a search finds nothing by them. To roll it back, stop every engine and drop
      // the table and the column; nothing else refers to them.
      tag: "expand",
      async up(db: Kysely<unknown>): Promise<void> {
        await db.schema.alterTable("messages").addColumn("meta", t.detail).execute();
        await db.schema
          .createTable("meta_index")
          .addColumn("id", t.key, t.numbered)
          .addColumn("message_id", t.int64, (col) => col.notNull())
          .addColumn("channel", t.name, (col) => col.notNull())
          .addColumn("index_name", t.name, (col) => col.notNull())
          .addColumn("key_id", t.name, (col) => col.notNull())
          .addColumn("tag", t.status, (col) => col.notNull())
          .$call(t.table)
          .execute();
        await db.schema
          .createIndex("meta_index_by_tag")
          .on("meta_index")
          .columns(["channel", "index_name", "tag", "message_id"])
          .execute();
        await db.schema
          .createIndex("meta_index_by_message")
          .on("meta_index")
          .columns(["message_id"])
          .execute();
      },
    },
  };
}

/**
 * Now, in epoch milliseconds, by each database's own clock: every lease decision reads it inside
 * the statement that makes the change, so no node's clock, skewed or not, takes part.
 */
const DATABASE_NOW: Readonly<Record<StorageKind, RawBuilder<number>>> = {
  sqlite: sql<number>`cast((julianday('now') - 2440587.5) * 86400000 as integer)`,
  postgres: sql<number>`cast(floor(extract(epoch from statement_timestamp()) * 1000) as bigint)`,
  mysql: sql<number>`cast(floor(unix_timestamp(current_timestamp(3)) * 1000) as signed)`,
  sqlserver: sql<number>`datediff_big(millisecond, cast('1970-01-01' as datetime2), sysutcdatetime())`,
};

/** How many messages retention deletes in one transaction, so the engine is never held up long. */
const EXPIRE_BATCH = 500;

/**
 * A message's state from its status and its current deliveries: a transformed message is `failed`
 * if a delivery failed for good, else `retrying` if one waits to be tried again, else `queued` if
 * one waits its first try, else `cleared` if an operator cleared one, else `dry-run` if one was
 * recorded and never sent, else `delivered`. Any other status is its own state.
 *
 * @example
 * ```ts
 * messageState("transformed", { pending: 1, retrying: 1, delivered: 0, failed: 0, cleared: 0 }); // "retrying"
 * ```
 */
export function messageState(status: MessageStatus, deliveries: DeliveryTally): MessageState {
  if (status !== "transformed") return status;
  if (deliveries.failed > 0) return "failed";
  if (deliveries.retrying > 0) return "retrying";
  if (deliveries.pending > 0) return "queued";
  if (deliveries.cleared > 0) return "cleared";
  if ((deliveries["dry-run"] ?? 0) > 0) return "dry-run";
  return "delivered";
}

type MessagesBuilder = ExpressionBuilder<Tables, "messages">;

/** Whether the message has a delivery of its current generation at one of `statuses`. */
function hasCurrent(
  eb: MessagesBuilder,
  statuses: readonly DeliveryStatus[],
  retried?: boolean,
): Expression<SqlBool> {
  let query = eb
    .selectFrom("deliveries")
    .select("deliveries.id")
    .whereRef("deliveries.message_id", "=", "messages.id")
    .whereRef("deliveries.generation", "=", "messages.generation")
    .where("deliveries.status", "in", statuses);
  if (retried === true) query = query.where("deliveries.attempts", ">", 0);
  return eb.exists(query);
}

/** {@link messageState}, as a condition. The two must agree; the tests hold them to it. */
function stateIs(eb: MessagesBuilder, state: MessageState): Expression<SqlBool> {
  if (state === "received" || state === "filtered") return eb("messages.status", "=", state);
  const transformed = eb("messages.status", "=", "transformed");
  const failed = hasCurrent(eb, ["failed"]);
  const retrying = hasCurrent(eb, ["pending"], true);
  const pending = hasCurrent(eb, ["pending"]);
  const cleared = hasCurrent(eb, ["cleared"]);
  const dryRun = hasCurrent(eb, ["dry-run"]);
  switch (state) {
    case "failed":
      return eb.or([eb("messages.status", "=", "failed"), eb.and([transformed, failed])]);
    case "retrying":
      return eb.and([transformed, eb.not(failed), retrying]);
    case "queued":
      return eb.and([transformed, eb.not(failed), eb.not(retrying), pending]);
    case "cleared":
      return eb.or([
        eb("messages.status", "=", "cleared"),
        eb.and([transformed, eb.not(failed), eb.not(pending), cleared]),
      ]);
    case "dry-run":
      return eb.and([transformed, eb.not(failed), eb.not(pending), eb.not(cleared), dryRun]);
    case "delivered":
      return eb.and([
        transformed,
        eb.not(failed),
        eb.not(pending),
        eb.not(cleared),
        eb.not(dryRun),
      ]);
  }
}

/**
 * Whether retention may delete the message: done (filtered, cleared, or transformed with every
 * delivery delivered, dry-run or cleared), nothing about it happened since `cutoff`, and its
 * content was not dropped.
 */
function expirable(eb: MessagesBuilder, cutoff: string): Expression<SqlBool> {
  return eb.and([
    eb("messages.updated_at", "<", cutoff),
    // A message whose content was dropped keeps its metadata: retention leaves it.
    eb("messages.content_dropped_at", "is", null),
    eb.or([
      eb("messages.status", "in", ["filtered", "cleared"]),
      eb.and([
        eb("messages.status", "=", "transformed"),
        eb.not(
          eb.exists(
            eb
              .selectFrom("deliveries")
              .select("deliveries.id")
              .whereRef("deliveries.message_id", "=", "messages.id")
              .where((d) =>
                d.or([
                  d("deliveries.status", "in", ["pending", "failed"]),
                  d("deliveries.delivered_at", ">=", cutoff),
                ]),
              ),
          ),
        ),
      ]),
    ]),
  ]);
}

/** A status read back. Retention's `expiring` is never committed, so it is never read. */
function readStatus(status: StoredStatus): MessageStatus {
  /* v8 ignore start: retention's transaction deletes every row it marks before it commits */
  if (status === EXPIRING) {
    throw new Error("a message retention was deleting was read");
  }
  /* v8 ignore stop */
  return status;
}

/** A tally being counted: `dry-run` is added by the first delivery that ran dry. */
type Tallying = Record<Exclude<DeliveryStatus, "dry-run" | "filtered"> | "retrying", number> & {
  "dry-run"?: number;
  filtered?: number;
};

function emptyTally(): Tallying {
  return { pending: 0, retrying: 0, delivered: 0, failed: 0, cleared: 0 };
}

/** Counts one more delivery at `status`. */
function countOne(tally: Tallying, status: DeliveryStatus): void {
  tally[status] = (tally[status] ?? 0) + 1;
}

/** Thrown inside a transaction to roll it back and say why. */
class Refusal extends Error {
  constructor(readonly reason: RefusalReason) {
    super(reason);
    this.name = "Refusal";
  }
}

type MessageRow = Pick<
  Selectable<MessagesTable>,
  | "id"
  | "channel"
  | "status"
  | "received_at"
  | "updated_at"
  | "size"
  | "duplicate_of"
  | "generation"
  | "content_hash"
  | "content_dropped_at"
>;

/** The columns a message's summary is read from. */
const SUMMARY_COLUMNS = [
  "id",
  "channel",
  "status",
  "received_at",
  "updated_at",
  "size",
  "duplicate_of",
  "generation",
  "content_hash",
  "content_dropped_at",
] as const;

/** A nullable 64-bit column, read as a number. */
function int64OrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * What {@link Store.open} runs with. Every field is optional.
 *
 * @example
 * ```ts
 * const store = await Store.open(project.storage, { env: process.env });
 * ```
 */
export interface StoreOptions {
  /** The clock for the times a store records. Tests pass their own. */
  readonly now?: () => Date;
  /**
   * Where a database server's connection URL is read from: the environment, or the secrets a start
   * resolved. Defaults to `process.env`.
   */
  readonly env?: SecretReader;
  /** Imports a driver package. Tests pass their own, to stand in for one that is not installed. */
  readonly importDriver?: DriverImport;
  /**
   * How the store treats its schema when it opens: `expand` (the default) applies the expand steps
   * it lacks under the migration lock; `none` applies nothing and refuses a schema that lacks one
   * (`pathways start --no-migrate`); `inspect` applies and refuses nothing (`pathways migrate`).
   * Contract steps are applied only by {@link Store.migrate}.
   */
  readonly migrate?: SchemaMode;
}

/**
 * Storage that could not be opened: `open` when the database could not be reached or opened (a
 * refused connection, a login it refused, a file it could not create), `schema` when its schema
 * could not be brought up to date. `code` is the driver's code, such as `ECONNREFUSED`, `28P01` or
 * `ELOGIN`; the driver's own error, which can name the server, the login or the file, is kept as
 * `cause` and never shown.
 *
 * @example
 * ```ts
 * try {
 *   await Store.open(project.databaseFile);
 * } catch (error) {
 *   if (error instanceof StorageError) console.error(error.reason, error.code);
 * }
 * ```
 */
export class StorageError extends Error {
  readonly reason: "open" | "schema";
  readonly code: string | undefined;

  /**
   * @param reason What could not be done.
   * @param cause The driver's error, kept and never shown.
   */
  constructor(reason: "open" | "schema", cause: unknown) {
    super(
      reason === "open"
        ? "the database could not be opened"
        : "the database schema could not be brought up to date",
      { cause },
    );
    this.name = "StorageError";
    this.reason = reason;
    const code = (cause as { code?: unknown } | undefined)?.code;
    this.code = typeof code === "string" ? code : undefined;
  }
}

/**
 * Where Pathways keeps every message and every delivery, so a restart loses nothing, and the audit
 * log of what operators did with them: SQLite, PostgreSQL, MySQL or MariaDB, or SQL Server, through
 * Kysely.
 *
 * Every database runs the same queries but three. SQL Server writes `TOP` where the others write
 * `LIMIT`, and each returns a new row's id its own way (`RETURNING`, `OUTPUT`, or MySQL's insert id).
 * Nothing claims rows: one engine process owns a database, by the engine lease (`acquireLease`), and
 * reads the head of each queue in order; each of its writes carries the lease's epoch.
 * The operator commands write beside it (a replay, a clear, retention), each change in one
 * transaction that writes first and re-checks what it read, so it never undoes the engine's work.
 *
 * @example
 * ```ts
 * const store = await Store.open(".pathways/pathways.db");
 * const { id } = await store.receive("adt-to-lab", body);
 * await store.close();
 * ```
 */
export class Store implements MessageStore, ContentStore, MetaStore {
  private constructor(
    private readonly db: Kysely<Tables>,
    private readonly kind: StorageKind,
    private readonly now: () => Date,
  ) {
    // Every driver copies a body it binds before the query resolves, and reads each body into a
    // buffer of its own (a small one may be a slice of a shared buffer, which is never freed).
    markCopiesBodies(this);
  }

  /**
   * Opens the database `storage` names (a path is a SQLite file), connects once to check it can,
   * and brings its schema up to date. A SQLite file and its folder are created if needed.
   *
   * @throws {ConfigError} when the connection URL's environment variable, a TLS file or the driver
   *   package cannot be had.
   * @throws {StorageError} when the database cannot be opened or its schema brought up to date.
   * @example
   * ```ts
   * const store = await Store.open(project.storage, { env: process.env });
   * ```
   */
  static async open(storage: string | DatabaseStorage, options: StoreOptions = {}): Promise<Store> {
    const config: DatabaseStorage =
      typeof storage === "string" ? { kind: "sqlite", file: storage } : storage;
    const { importDriver } = options;
    let db: Kysely<Tables>;
    try {
      const dialect = await dialectFor(config, {
        env: options.env ?? process.env,
        ...(importDriver === undefined ? {} : { importDriver }),
      });
      db = new Kysely<Tables>({ dialect });
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new StorageError("open", error);
    }
    try {
      await sql`select 1`.execute(db);
    } catch (error) {
      await db.destroy();
      throw new StorageError("open", error);
    }
    const now = options.now ?? (() => new Date());
    const store = new Store(db, config.kind, now);
    let error: unknown;
    try {
      ({ error } = await openSchema(
        db as Kysely<unknown>,
        config.kind,
        store.steps(),
        VERSION,
        options.migrate ?? "expand",
      ));
    } catch (thrown) {
      await db.destroy();
      if (thrown instanceof SchemaVersionError) throw thrown;
      throw new StorageError("schema", thrown);
    }
    if (error !== undefined) {
      await db.destroy();
      throw new StorageError("schema", error);
    }
    return store;
  }

  /** This version's schema steps, as they run here: each records itself in `schema_info`. */
  private steps(): Record<string, SchemaStep> {
    return recordedSteps(migrations(this.kind), VERSION, this.now);
  }

  /**
   * The database's schema as it stands, read against this version's steps: its generation, the
   * oldest Pathways it allows, who last changed it, and the steps applied and still to apply.
   *
   * @example
   * ```ts
   * const { generation, pending } = await store.schema();
   * ```
   */
  async schema(): Promise<SchemaState> {
    return readSchema(this.db as Kysely<unknown>, this.steps());
  }

  /**
   * Applies this version's pending expand steps, and with `contract` its pending contract steps,
   * under the migration lock, as `pathways migrate` does. Contract steps wait while the schema
   * changed within `rollbackWindowMs`. A schema a newer Pathways moved forward is left as it is.
   *
   * @throws {SchemaVersionError} when this version cannot run on the schema.
   * @throws {SchemaStepError} when a step fails.
   * @example
   * ```ts
   * const report = await store.migrate({ contract: true, dryRun: true });
   * ```
   */
  async migrate(options: MigrateOptions = {}): Promise<MigrationReport> {
    return migrateSchema(this.db as Kysely<unknown>, this.kind, this.steps(), VERSION, options);
  }

  /** Closes the database, and every pooled connection to it. */
  async close(): Promise<void> {
    await this.db.destroy();
  }

  /**
   * Stores an incoming message as `received` (or `failed`, given `options.failure`) and returns its
   * id, with the earlier message it may duplicate. With a duplicate key, or an idempotency key
   * that is `resumed`, the insert, the lookups and the flag are one transaction; otherwise, the
   * insert alone, which stores an idempotency key without looking it up. When a resumed message's
   * idempotency key is already stored on the channel, the new row is deleted again and that
   * message's id is returned with `alreadyStored`.
   *
   * Every transaction here writes before it reads. On SQLite, a transaction that reads first cannot
   * write once another process (an operator command beside the engine) has written meanwhile, and
   * fails at once rather than waiting its turn.
   */
  async receive(
    channel: string,
    body: Uint8Array,
    options: StoreReceiveOptions = {},
  ): Promise<ReceivedMessage> {
    const at = this.now().toISOString();
    const { duplicateKey, idempotencyKey, resumed, failure, size, contentHash } = options;
    const meta =
      options.storedMeta ?? (options.meta === undefined ? null : JSON.stringify(options.meta));
    const tags = options.metaTags ?? [];
    const insertOnly = (db: Kysely<Tables>): Promise<number> =>
      this.insertMessage(db, {
        channel,
        received_at: at,
        body: blob(body),
        status: failure === undefined ? "received" : "failed",
        error: failure ?? null,
        updated_at: at,
        dedup_key: duplicateKey ?? null,
        duplicate_of: null,
        size: size ?? body.byteLength,
        idempotency_key: idempotencyKey ?? null,
        content_hash: contentHash ?? null,
        content_dropped_at: null,
        meta,
      });
    // The tags go in with the message, in the same transaction.
    const insert = async (db: Kysely<Tables>): Promise<number> => {
      const id = await insertOnly(db);
      await this.insertTags(db, id, channel, tags);
      return id;
    };
    // A message handed in for the first time cannot have been stored: its key is only recorded.
    const lookUp = resumed === true ? idempotencyKey : undefined;
    if (duplicateKey === undefined && lookUp === undefined) {
      if (tags.length === 0) return { id: await insertOnly(this.db), duplicateOf: undefined };
      return { id: await this.db.transaction().execute(insert), duplicateOf: undefined };
    }
    return this.db.transaction().execute(async (tx) => {
      const id = await insert(tx);
      if (lookUp !== undefined) {
        const stored = await tx
          .selectFrom("messages")
          .select(["id", "duplicate_of"])
          .where("channel", "=", channel)
          .where("idempotency_key", "=", lookUp)
          .where("id", "<", id)
          .orderBy("id")
          .$call((query) => this.first(query))
          .executeTakeFirst();
        if (stored !== undefined) {
          await tx.deleteFrom("meta_index").where("message_id", "=", id).execute();
          await tx.deleteFrom("messages").where("id", "=", id).execute();
          return {
            id: Number(stored.id),
            duplicateOf: int64OrNull(stored.duplicate_of) ?? undefined,
            alreadyStored: true,
          };
        }
      }
      if (duplicateKey === undefined) return { id, duplicateOf: undefined };
      const earlier = await tx
        .selectFrom("messages")
        .select("id")
        .where("channel", "=", channel)
        .where("dedup_key", "=", duplicateKey)
        .where("id", "<", id)
        .orderBy("id", "desc")
        .$call((query) => this.first(query))
        .executeTakeFirst();
      const duplicateOf = earlier === undefined ? undefined : Number(earlier.id);
      if (duplicateOf !== undefined) {
        await tx
          .updateTable("messages")
          .set({ duplicate_of: duplicateOf })
          .where("id", "=", id)
          .execute();
      }
      return { id, duplicateOf };
    });
  }

  /** What is stored about one message, without its body, or `undefined` if there is none. */
  async message(id: number): Promise<StoredMessage | undefined> {
    const row = await this.db
      .selectFrom("messages")
      .select([...SUMMARY_COLUMNS, "error"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const [summary] = await this.summarize([row]);
    /* v8 ignore next: summarize returns one summary per row */
    if (summary === undefined) return undefined;
    return { ...summary, error: row.error };
  }

  /** The body of one message as it arrived, or `undefined` if there is none or it was dropped. */
  async messageBody(id: number): Promise<Uint8Array | undefined> {
    const row = await this.db
      .selectFrom("messages")
      .select("body")
      .where("id", "=", id)
      .where("content_dropped_at", "is", null)
      .executeTakeFirst();
    return row?.body;
  }

  /** Every delivery of a message, oldest first, without bodies. */
  async deliveries(messageId: number): Promise<StoredDelivery[]> {
    const rows = await this.db
      .selectFrom("deliveries")
      .select([
        "id",
        "destination",
        "seq",
        "generation",
        "status",
        "attempts",
        "next_attempt_at",
        "delivered_at",
        "last_error",
        "interrupted_attempt",
      ])
      .where("message_id", "=", messageId)
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      id: Number(row.id),
      destination: row.destination,
      seq: row.seq,
      generation: row.generation,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: Number(row.next_attempt_at),
      deliveredAt: row.delivered_at,
      error: row.last_error,
      ...(row.interrupted_attempt === null ? {} : { interruptedAttempt: row.interrupted_attempt }),
    }));
  }

  /**
   * The outputs of a message's current generation, in order, or none once they were dropped: those
   * of `destination`, or else of the first destination with any. Without destination transforms,
   * each destination was queued the same outputs. A delivery with no output (`seq` -1) is none.
   */
  async outputs(messageId: number, destination?: number): Promise<Uint8Array[]> {
    const rows = await this.db
      .selectFrom("deliveries")
      .innerJoin("messages", "messages.id", "deliveries.message_id")
      .select(["deliveries.destination", "deliveries.body"])
      .where("deliveries.message_id", "=", messageId)
      .whereRef("deliveries.generation", "=", "messages.generation")
      .where("messages.content_dropped_at", "is", null)
      .where("deliveries.seq", ">=", 0)
      .$if(destination !== undefined, (q) =>
        q.where("deliveries.destination", "=", destination as number),
      )
      .orderBy("deliveries.destination")
      .orderBy("deliveries.seq")
      .execute();
    const first = rows[0]?.destination;
    return rows.filter((row) => row.destination === first).map((row) => row.body);
  }

  /** Every channel with a stored message, by name. */
  async channels(): Promise<string[]> {
    const rows = await this.db
      .selectFrom("messages")
      .select("channel")
      .distinct()
      .orderBy("channel")
      .execute();
    return rows.map((row) => row.channel);
  }

  /** A page of messages, newest first, without bodies or errors. */
  async listMessages(query: MessageQuery): Promise<Page<MessageSummary>> {
    const { channel, state, since, until, before, ids, limit } = query;
    if (ids?.length === 0) return { items: [], next: undefined };
    let select = this.db.selectFrom("messages").select(SUMMARY_COLUMNS);
    if (ids !== undefined) select = select.where("id", "in", [...ids]);
    if (channel !== undefined) select = select.where("channel", "=", channel);
    if (state !== undefined) select = select.where((eb) => stateIs(eb, state));
    if (since !== undefined) select = select.where("received_at", ">=", since);
    if (until !== undefined) select = select.where("received_at", "<", until);
    if (before !== undefined) select = select.where("id", "<", before);
    const rows = await select
      .orderBy("id", "desc")
      .$call((q) => this.take(q, limit + 1))
      .execute();
    const items = await this.summarize(rows.slice(0, limit));
    return { items, next: rows.length > limit ? items.at(-1)?.id : undefined };
  }

  /**
   * Up to `query.limit` messages of the channel that carry, for each condition, one of its tags,
   * newest first, each with its metadata as stored.
   */
  async metaCandidates(query: MetaCandidateQuery): Promise<MetaCandidate[]> {
    const { channel, conditions, state, since, until, before, limit } = query;
    let select = this.db
      .selectFrom("messages")
      .select(["id", "meta"])
      .where("channel", "=", channel)
      .where("meta", "is not", null);
    for (const { index, tags } of conditions) {
      select = select.where((eb) =>
        eb.exists(
          eb
            .selectFrom("meta_index")
            .select("meta_index.id")
            .whereRef("meta_index.message_id", "=", "messages.id")
            .where("meta_index.channel", "=", channel)
            .where("meta_index.index_name", "=", index)
            .where((m) =>
              m.or(
                tags.map(({ keyId, tag }) =>
                  m.and([m("meta_index.key_id", "=", keyId), m("meta_index.tag", "=", tag)]),
                ),
              ),
            ),
        ),
      );
    }
    if (state !== undefined) select = select.where((eb) => stateIs(eb, state));
    if (since !== undefined) select = select.where("received_at", ">=", since);
    if (until !== undefined) select = select.where("received_at", "<", until);
    if (before !== undefined) select = select.where("id", "<", before);
    const rows = await select
      .orderBy("id", "desc")
      .$call((q) => this.take(q, limit))
      .execute();
    // Selected where it is not null.
    return rows.map((row) => ({ id: Number(row.id), meta: row.meta as string }));
  }

  /** Up to `limit` messages with metadata and an id above `after`, oldest first, with their tags. */
  async storedMeta(after: number, limit: number): Promise<StoredMeta[]> {
    const rows = await this.db
      .selectFrom("messages")
      .select(["id", "channel", "meta"])
      .where("id", ">", after)
      .where("meta", "is not", null)
      .orderBy("id")
      .$call((q) => this.take(q, limit))
      .execute();
    if (rows.length === 0) return [];
    const tags = await this.db
      .selectFrom("meta_index")
      .select(["message_id", "index_name", "key_id", "tag"])
      .where(
        "message_id",
        "in",
        rows.map((row) => Number(row.id)),
      )
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      id: Number(row.id),
      channel: row.channel,
      // Selected where it is not null.
      meta: row.meta as string,
      tags: tags
        .filter((tag) => Number(tag.message_id) === Number(row.id))
        .map((tag) => ({ index: tag.index_name, keyId: tag.key_id, tag: tag.tag })),
    }));
  }

  /**
   * Replaces a message's metadata and every tag of it, in one transaction, only while the metadata
   * is still what `current` read. The update comes first: see receive() for why.
   */
  async replaceMeta(
    current: StoredMeta,
    next: { readonly meta: string; readonly tags: readonly MetaTag[] },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const updated = await tx
        .updateTable("messages")
        .set({ meta: next.meta })
        .where("id", "=", current.id)
        .where(sql<boolean>`${this.same("meta", current.meta)}`)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return false;
      await tx.deleteFrom("meta_index").where("message_id", "=", current.id).execute();
      await this.insertTags(tx, current.id, current.channel, next.tags);
      return true;
    });
  }

  /** A channel's retrying deliveries, oldest first, at most `limit`. */
  async listRetrying(channel: string, limit: number): Promise<RetryingDelivery[]> {
    const rows = await this.db
      .selectFrom("deliveries")
      .select(["id", "message_id", "destination", "attempts", "next_attempt_at"])
      .where("channel", "=", channel)
      .where("status", "=", "pending")
      .where("attempts", ">", 0)
      .orderBy("id")
      .$call((q) => this.take(q, limit))
      .execute();
    return rows.map((row) => ({
      id: Number(row.id),
      messageId: Number(row.message_id),
      destination: row.destination,
      attempts: row.attempts,
      nextAttemptAt: Number(row.next_attempt_at),
    }));
  }

  /** The oldest message of `channel` still waiting for its transform, if any. */
  async nextToTransform(channel: string): Promise<PendingMessage | undefined> {
    const row = await this.db
      .selectFrom("messages")
      .select(["id", "body"])
      .where("channel", "=", channel)
      .where("status", "=", "received")
      .orderBy("id")
      .$call((query) => this.first(query))
      .executeTakeFirst();
    return row === undefined ? undefined : { id: Number(row.id), body: row.body };
  }

  /**
   * Records a transform's outputs: one pending delivery per output per destination, in order, or
   * each destination's own (see {@link MessageStore.completeTransform}), and the message as
   * `transformed`, or as `filtered` when no destination has anything. All or nothing.
   */
  async completeTransform(
    messageId: number,
    outputs: TransformOutputs,
    destinations: number,
    epoch?: number,
  ): Promise<void> {
    const at = this.now();
    await this.db.transaction().execute(async (tx) => {
      // The update first: see receive() for why every transaction here writes before it reads.
      const updated = await tx
        .updateTable("messages")
        .set({
          status: transformedStatus(outputs),
          updated_at: at.toISOString(),
        })
        .where("id", "=", messageId)
        .$if(epoch !== undefined, (q) => q.where(this.fence("received", epoch)))
        .executeTakeFirst();
      // Thrown inside the transaction, so nothing of it is kept.
      if (epoch !== undefined && updated.numUpdatedRows === 0n) throw new LeaseLostError();
      const message = await tx
        .selectFrom("messages")
        .select(["channel", "generation"])
        .where("id", "=", messageId)
        .executeTakeFirstOrThrow();
      await this.queue(tx, messageId, message, outputs, destinations);
    });
  }

  /** Marks a message `failed`, with its error, so the channel moves on to the next. */
  async failTransform(messageId: number, error: string, epoch?: number): Promise<void> {
    const updated = await this.db
      .updateTable("messages")
      .set({ status: "failed", error, updated_at: this.now().toISOString() })
      .where("id", "=", messageId)
      .$if(epoch !== undefined, (q) => q.where(this.fence("received", epoch)))
      .executeTakeFirst();
    fenced(epoch, updated);
  }

  /**
   * The oldest pending delivery for one destination of one channel. Later deliveries wait behind it,
   * which is what keeps a destination's messages in order. With `options.dueBy`, the oldest due by
   * then, passing over any still waiting for a retry.
   */
  async nextDelivery(
    channel: string,
    destination: number,
    options: NextDeliveryOptions = {},
  ): Promise<PendingDelivery | undefined> {
    const { dueBy } = options;
    const row = await this.db
      .selectFrom("deliveries")
      .select([
        "id",
        "message_id",
        "seq",
        "body",
        "attempts",
        "next_attempt_at",
        "sending_at",
        "sending_attempt",
        "interrupted_attempt",
      ])
      .where("channel", "=", channel)
      .where("destination", "=", destination)
      .where("status", "=", "pending")
      .$if(dueBy !== undefined, (q) => q.where("next_attempt_at", "<=", dueBy as number))
      .orderBy("id")
      .$call((query) => this.first(query))
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const sendingAt = int64OrNull(row.sending_at);
    return {
      id: Number(row.id),
      messageId: Number(row.message_id),
      seq: row.seq,
      body: row.body,
      attempts: row.attempts,
      nextAttemptAt: Number(row.next_attempt_at),
      ...(sendingAt === null || row.sending_attempt === null
        ? {}
        : { sending: { attempt: row.sending_attempt, at: sendingAt } }),
      ...(row.interrupted_attempt === null ? {} : { interruptedAttempt: row.interrupted_attempt }),
    };
  }

  /** Writes the marker before a send, in one UPDATE: see {@link MessageStore.markSending}. */
  async markSending(deliveryId: number, start: SendStart, epoch?: number): Promise<void> {
    const { attempt, at, interruptedAttempt } = start;
    const updated = await this.db
      .updateTable("deliveries")
      .set({
        sending_at: at,
        sending_attempt: attempt,
        ...(interruptedAttempt === undefined ? {} : { interrupted_attempt: interruptedAttempt }),
      })
      .where("id", "=", deliveryId)
      .$if(epoch !== undefined, (q) => q.where(this.fence("pending", epoch)))
      .executeTakeFirst();
    fenced(epoch, updated);
  }

  /** Marks a delivery done, and clears its marker. */
  async markDelivered(deliveryId: number, epoch?: number): Promise<void> {
    const updated = await this.db
      .updateTable("deliveries")
      .set({
        status: "delivered",
        delivered_at: this.now().toISOString(),
        sending_at: null,
        sending_attempt: null,
      })
      .where("id", "=", deliveryId)
      .$if(epoch !== undefined, (q) => q.where(this.fence("pending", epoch)))
      .executeTakeFirst();
    fenced(epoch, updated);
  }

  /**
   * Marks a delivery done and clears its marker, then, when no delivery of the message's current
   * generation is left undelivered, drops the bodies of the message and of every one of its
   * deliveries, all in one transaction: see {@link MessageStore.markDeliveredAndDropContent}. A body
   * is emptied in place rather than its row deleted, so the ids, states and times stay, and each
   * delivery's last error text goes with it, since encryption at rest treats that as content too.
   * The message's `ctx.meta` and its index tags go too: they hold identifiers such as an MRN, so a
   * message whose content is dropped can no longer be found by its metadata. Every delivery of
   * an earlier generation is done by then: a replay or a resend is refused while one is pending,
   * and clears those that failed.
   */
  async markDeliveredAndDropContent(deliveryId: number, epoch?: number): Promise<boolean> {
    const at = this.now().toISOString();
    return this.db.transaction().execute(async (tx) => {
      // The update first: see receive() for why every transaction here writes before it reads.
      const updated = await tx
        .updateTable("deliveries")
        .set({ status: "delivered", delivered_at: at, sending_at: null, sending_attempt: null })
        .where("id", "=", deliveryId)
        .$if(epoch !== undefined, (q) => q.where(this.fence("pending", epoch)))
        .executeTakeFirst();
      // Thrown inside the transaction, so nothing of it is kept.
      fenced(epoch, updated);
      const delivery = await tx
        .selectFrom("deliveries")
        .select("message_id")
        .where("id", "=", deliveryId)
        .executeTakeFirst();
      if (delivery === undefined) return false;
      const messageId = Number(delivery.message_id);
      const dropped = await tx
        .updateTable("messages")
        .set({ body: EMPTY_BODY[this.kind], error: null, meta: null, content_dropped_at: at })
        .where("id", "=", messageId)
        .where("status", "=", "transformed")
        .where("content_dropped_at", "is", null)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("deliveries")
                .select("deliveries.id")
                .whereRef("deliveries.message_id", "=", "messages.id")
                .whereRef("deliveries.generation", "=", "messages.generation")
                .where("deliveries.status", "not in", ["delivered", "filtered"]),
            ),
          ),
        )
        .executeTakeFirst();
      if (dropped.numUpdatedRows === 0n) return false;
      await tx
        .updateTable("deliveries")
        .set({ body: EMPTY_BODY[this.kind], last_error: null })
        .where("message_id", "=", messageId)
        .execute();
      await tx.deleteFrom("meta_index").where("message_id", "=", messageId).execute();
      return true;
    });
  }

  /** Marks a delivery `dry-run`, recorded and never sent, and clears its marker. */
  async markDryRun(deliveryId: number, epoch?: number): Promise<void> {
    const updated = await this.db
      .updateTable("deliveries")
      .set({ status: "dry-run", sending_at: null, sending_attempt: null })
      .where("id", "=", deliveryId)
      .$if(epoch !== undefined, (q) => q.where(this.fence("pending", epoch)))
      .executeTakeFirst();
    fenced(epoch, updated);
  }

  /** Records a failed attempt and when to try again, and clears the marker. */
  async scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
    epoch?: number,
  ): Promise<void> {
    const updated = await this.db
      .updateTable("deliveries")
      .set({
        attempts,
        next_attempt_at: nextAttemptAt,
        last_error: error,
        sending_at: null,
        sending_attempt: null,
      })
      .where("id", "=", deliveryId)
      .$if(epoch !== undefined, (q) => q.where(this.fence("pending", epoch)))
      .executeTakeFirst();
    fenced(epoch, updated);
  }

  /** Marks a delivery `failed` for good, so its destination moves on to the next; clears the marker. */
  async failDelivery(deliveryId: number, error: string, epoch?: number): Promise<void> {
    const updated = await this.db
      .updateTable("deliveries")
      .set({ status: "failed", last_error: error, sending_at: null, sending_attempt: null })
      .where("id", "=", deliveryId)
      .$if(epoch !== undefined, (q) => q.where(this.fence("pending", epoch)))
      .executeTakeFirst();
    fenced(epoch, updated);
  }

  /**
   * Takes the lease when it is free or has lapsed, in one UPDATE that reads the database's clock
   * and raises the epoch: of two engines asking at once, the database lets one change the row and
   * the other change nothing, on every database at its default isolation level. The row is made
   * on the first request; two first requests at once both try, and one insert is refused.
   */
  async acquireLease(name: string, claimant: LeaseClaimant, ttlMs: number): Promise<LeaseClaim> {
    const now = DATABASE_NOW[this.kind];
    const take = (): Promise<{ numUpdatedRows: bigint }> =>
      this.db
        .updateTable("leases")
        .set({
          owner: claimant.node,
          host: claimant.host,
          epoch: sql<number>`${sql.ref("epoch")} + 1`,
          since: now,
          expires_at: sql<number>`${now} + ${ttlMs}`,
        })
        .where("name", "=", name)
        .where("expires_at", "<=", now)
        .executeTakeFirst();
    for (let round = 0; round < 2; round += 1) {
      if ((await take()).numUpdatedRows > 0n) {
        const row = await this.db
          .selectFrom("leases")
          .select("epoch")
          .where("name", "=", name)
          .where("owner", "=", claimant.node)
          .executeTakeFirstOrThrow();
        return { acquired: true, epoch: Number(row.epoch) };
      }
      const holder = await this.leaseHolder(name);
      if (holder !== undefined) return { acquired: false, holder };
      // The first request for this lease: make its row, lapsed, and take it. Another engine asking
      // at the same moment may make it first, and then this insert is refused, which is fine.
      await this.db
        .insertInto("leases")
        .values({ name, owner: "", host: "", epoch: 0, since: 0, expires_at: 0 })
        .execute()
        .catch(() => undefined);
    }
    /* v8 ignore next 2: the row exists after the first round, so the second takes or refuses */
    throw new Error("the lease could not be taken or read");
  }

  /** Extends the lease while it carries `epoch` and has not lapsed, by the database's clock. */
  async renewLease(name: string, epoch: number, ttlMs: number): Promise<boolean> {
    const now = DATABASE_NOW[this.kind];
    const renewed = await this.db
      .updateTable("leases")
      .set({ expires_at: sql<number>`${now} + ${ttlMs}` })
      .where("name", "=", name)
      .where("epoch", "=", epoch)
      .where("expires_at", ">", now)
      .executeTakeFirst();
    return renewed.numUpdatedRows > 0n;
  }

  /** Frees the lease: under `epoch` only when it is given, whoever holds it when not. */
  async releaseLease(name: string, epoch?: number): Promise<boolean> {
    const released = await this.db
      .updateTable("leases")
      .set({ expires_at: 0 })
      .where("name", "=", name)
      .where("owner", "<>", "")
      .$if(epoch !== undefined, (q) => q.where("epoch", "=", epoch as number))
      .executeTakeFirst();
    return released.numUpdatedRows > 0n;
  }

  /** The lease's last holder and its time left, by the database's clock. */
  async leaseHolder(name: string): Promise<LeaseHolder | undefined> {
    const row = await this.db
      .selectFrom("leases")
      .select(["owner", "host", "epoch", "since", "expires_at"])
      .select(DATABASE_NOW[this.kind].as("now"))
      .where("name", "=", name)
      .executeTakeFirst();
    if (row === undefined || row.owner === "") return undefined;
    return {
      node: row.owner,
      host: row.host,
      since: new Date(Number(row.since)).toISOString(),
      epoch: Number(row.epoch),
      expiresInMs: Number(row.expires_at) - Number(row.now),
    };
  }

  /** Every channel an operator paused or stopped. */
  async channelStates(): Promise<Record<string, ChannelRunState>> {
    const rows = await this.db.selectFrom("channel_states").select(["channel", "state"]).execute();
    const states: Record<string, ChannelRunState> = {};
    for (const row of rows) {
      if (row.state === "paused" || row.state === "stopped") states[row.channel] = row.state;
    }
    return states;
  }

  /**
   * Sets a channel's state in one transaction that writes before it reads: `running` deletes its
   * row; else the row is changed, or made when there was none.
   */
  async setChannelState(channel: string, state: ChannelRunState): Promise<void> {
    const now = DATABASE_NOW[this.kind];
    await this.db.transaction().execute(async (tx) => {
      if (state === "running") {
        await tx.deleteFrom("channel_states").where("channel", "=", channel).execute();
        return;
      }
      const changed = await tx
        .updateTable("channel_states")
        .set({ state, changed_at: now })
        .where("channel", "=", channel)
        .executeTakeFirst();
      if (changed.numUpdatedRows > 0n) return;
      await tx.insertInto("channel_states").values({ channel, state, changed_at: now }).execute();
    });
  }

  /** How many messages of `channel` stand at each status. */
  async messageCounts(channel: string): Promise<Record<MessageStatus, number>> {
    const rows = await this.db
      .selectFrom("messages")
      .select(["status", (eb) => eb.fn.countAll<number | string>().as("count")])
      .where("channel", "=", channel)
      .groupBy("status")
      .execute();
    const counts: Record<MessageStatus, number> = {
      received: 0,
      transformed: 0,
      filtered: 0,
      failed: 0,
      cleared: 0,
    };
    for (const row of rows) counts[readStatus(row.status)] = Number(row.count);
    return counts;
  }

  /** How many deliveries of `channel` stand at each status. */
  async deliveryCounts(channel: string): Promise<DeliveryCounts> {
    const rows = await this.db
      .selectFrom("deliveries")
      .select(["status", (eb) => eb.fn.countAll<number | string>().as("count")])
      .where("channel", "=", channel)
      .groupBy("status")
      .execute();
    // `dry-run` is set only by a row of it, so a channel that never ran dry reads as before.
    const counts: { -readonly [S in keyof DeliveryCounts]: DeliveryCounts[S] } = {
      pending: 0,
      delivered: 0,
      failed: 0,
      cleared: 0,
    };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /**
   * Up to `limit` rows of `table` with an id above `after`, oldest first, as stored. The rows of a
   * message whose content was dropped hold none, so they are left out.
   */
  async storedContent(table: ContentTable, after: number, limit: number): Promise<StoredContent[]> {
    const rows =
      table === "messages"
        ? await this.db
            .selectFrom("messages")
            .select(["id", "body", "error"])
            .where("id", ">", after)
            .where("content_dropped_at", "is", null)
            .orderBy("id")
            .$call((query) => this.take(query, limit))
            .execute()
        : await this.db
            .selectFrom("deliveries")
            .select(["id", "body", "last_error as error"])
            .where("id", ">", after)
            .where("message_id", "not in", (eb) =>
              eb
                .selectFrom("messages")
                .select("messages.id")
                .where("messages.content_dropped_at", "is not", null),
            )
            .orderBy("id")
            .$call((query) => this.take(query, limit))
            .execute();
    return rows.map(({ id, body, error }) => ({ table, id: Number(id), body, error }));
  }

  /**
   * Replaces a row's body and error with `next`, only while the row still holds `current`'s body
   * and error, byte for byte. Returns whether it did.
   *
   * SQL Server's `=` ignores trailing zero bytes and trailing spaces, and MySQL's ignores trailing
   * spaces in text, so on those two the lengths are compared as well.
   *
   * The old values are overwritten in place, but a database server keeps earlier row versions for
   * a while: PostgreSQL until VACUUM, and even then in free space and its WAL; MySQL in its undo
   * log and binary log; SQL Server in its transaction log and freed pages; and every server in its
   * replicas and backups. Under encryption those versions are ciphertext under the older master key,
   * so that key is what keeps them unreadable: retire it once the server no longer holds them, not as
   * soon as rekey reports nothing left under it. SQLite, opened with `secure_delete`, zeroes them in
   * its file, but its write-ahead log keeps them until `pathways rekey` empties it
   * (`emptySqliteLog`). On any database, a copy or backup made before still holds them.
   */
  async replaceContent(
    current: StoredContent,
    next: { readonly body: Uint8Array; readonly error: string | null },
  ): Promise<boolean> {
    const body = blob(current.body);
    const result =
      current.table === "messages"
        ? await this.db
            .updateTable("messages")
            .set({ body: blob(next.body), error: next.error })
            .where("id", "=", current.id)
            .where(sql<boolean>`${this.same("body", body)}`)
            .where(sql<boolean>`${this.same("error", current.error)}`)
            .executeTakeFirst()
        : await this.db
            .updateTable("deliveries")
            .set({ body: blob(next.body), last_error: next.error })
            .where("id", "=", current.id)
            .where(sql<boolean>`${this.same("body", body)}`)
            .where(sql<boolean>`${this.same("last_error", current.error)}`)
            .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** How many of `channel`'s pending deliveries have failed at least once and wait for a retry. */
  async retryingDeliveries(channel: string): Promise<number> {
    const row = await this.db
      .selectFrom("deliveries")
      .select((eb) => eb.fn.countAll<number | string>().as("count"))
      .where("channel", "=", channel)
      .where("status", "=", "pending")
      .where("attempts", ">", 0)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Records a replay or a resend. The guarded update of the message comes first, so on SQLite the
   * transaction holds the write lock before it reads anything, and on a server it holds the
   * message's row: nothing the engine writes can come between the checks and the inserts. The new
   * deliveries take new ids, which puts them at the back of each destination's queue. A message
   * whose content was dropped is refused: there is nothing to replay or resend.
   */
  async requeue(messageId: number, request: RequeueRequest, actor: string): Promise<RequeueResult> {
    const at = this.now().toISOString();
    const { mode, expected, failure, destinations, byDestination } = request;
    const outputs: TransformOutputs =
      byDestination === undefined ? request.outputs : { byDestination };
    const status: MessageStatus = failure === undefined ? transformedStatus(outputs) : "failed";
    try {
      return await this.db.transaction().execute(async (tx) => {
        const moved = await tx
          .updateTable("messages")
          .set((eb) => ({
            status,
            error: failure ?? null,
            updated_at: at,
            generation: eb("generation", "+", 1),
          }))
          .where("id", "=", messageId)
          .where("status", "=", expected)
          .where("content_dropped_at", "is", null)
          .executeTakeFirst();
        const message = await tx
          .selectFrom("messages")
          .select(["channel", "generation", "content_dropped_at"])
          .where("id", "=", messageId)
          .executeTakeFirst();
        if (message === undefined) throw new Refusal("not-found");
        if (message.content_dropped_at !== null) throw new Refusal("content-dropped");
        if (moved.numUpdatedRows === 0n) throw new Refusal("changed");
        const pending = await tx
          .selectFrom("deliveries")
          .select("id")
          .where("message_id", "=", messageId)
          .where("status", "=", "pending")
          .$call((q) => this.first(q))
          .executeTakeFirst();
        if (pending !== undefined) throw new Refusal("pending");
        const superseded = await tx
          .updateTable("deliveries")
          .set({ status: "cleared" })
          .where("message_id", "=", messageId)
          .where("status", "=", "failed")
          .executeTakeFirst();
        const queued =
          failure === undefined
            ? await this.queue(tx, messageId, message, outputs, destinations)
            : 0;
        const done = {
          status,
          queued,
          superseded: Number(superseded.numUpdatedRows),
          generation: message.generation,
        };
        faultPoint("mid-requeue");
        const [entry] = await this.insertAudit(tx, actor, at, [
          { action: mode, channel: message.channel, messageId, detail: done },
        ]);
        /* v8 ignore next: insertAudit returns one entry per input */
        if (entry === undefined) throw new Error("the audit entry was not written");
        return { done: true, ...done, entry };
      });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const reason = error.reason as Extract<
        RefusalReason,
        "not-found" | "changed" | "pending" | "content-dropped"
      >;
      const entry = await this.refusal(actor, mode, messageId, reason);
      return { done: false, reason, entry };
    }
  }

  /** Clears a failed message and its failed deliveries; the audit entry is in the same transaction. */
  async clear(messageId: number, actor: string): Promise<ClearResult> {
    const at = this.now().toISOString();
    try {
      return await this.db.transaction().execute(async (tx) => {
        // Writes first, so on SQLite the transaction holds the write lock before it reads.
        const messages = await tx
          .updateTable("messages")
          .set({ status: "cleared", updated_at: at })
          .where("id", "=", messageId)
          .where("status", "=", "failed")
          .executeTakeFirst();
        const deliveries = await tx
          .updateTable("deliveries")
          .set({ status: "cleared" })
          .where("message_id", "=", messageId)
          .where("status", "=", "failed")
          .executeTakeFirst();
        const message = await tx
          .selectFrom("messages")
          .select("channel")
          .where("id", "=", messageId)
          .executeTakeFirst();
        if (message === undefined) throw new Refusal("not-found");
        const done = {
          messages: Number(messages.numUpdatedRows),
          deliveries: Number(deliveries.numUpdatedRows),
        };
        if (done.messages + done.deliveries === 0) throw new Refusal("not-failed");
        // Clearing is activity: retention counts its period from now.
        await tx
          .updateTable("messages")
          .set({ updated_at: at })
          .where("id", "=", messageId)
          .execute();
        const [entry] = await this.insertAudit(tx, actor, at, [
          { action: "clear", channel: message.channel, messageId, detail: done },
        ]);
        /* v8 ignore next: insertAudit returns one entry per input */
        if (entry === undefined) throw new Error("the audit entry was not written");
        return { done: true, ...done, entry };
      });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const reason = error.reason as Extract<RefusalReason, "not-found" | "not-failed">;
      const entry = await this.refusal(actor, "clear", messageId, reason);
      return { done: false, reason, entry };
    }
  }

  /**
   * Deletes a channel's done messages whose last activity is before `cutoff`, with their
   * deliveries, a batch at a time. Each batch is one transaction that first marks the messages it
   * will delete, re-checking that each is still done and still old, so a message replayed or given
   * a new delivery meanwhile is left alone. Every statement runs on every database: the batch is a
   * list of ids, since MySQL takes no `LIMIT` in a subquery and no subquery on the table it deletes
   * from.
   */
  async expire(channel: string, cutoff: string, dryRun: boolean): Promise<ExpireResult> {
    if (dryRun) {
      const messages = await this.db
        .selectFrom("messages")
        .select((eb) => eb.fn.countAll<number | string>().as("count"))
        .where("channel", "=", channel)
        .where((eb) => expirable(eb, cutoff))
        .executeTakeFirstOrThrow();
      const deliveries = await this.db
        .selectFrom("deliveries")
        .select((eb) => eb.fn.countAll<number | string>().as("count"))
        .where("message_id", "in", (eb) =>
          eb
            .selectFrom("messages")
            .select("messages.id")
            .where("messages.channel", "=", channel)
            .where((m) => expirable(m, cutoff)),
        )
        .executeTakeFirstOrThrow();
      return { messages: Number(messages.count), deliveries: Number(deliveries.count) };
    }

    let messages = 0;
    let deliveries = 0;
    for (;;) {
      const ids = (
        await this.db
          .selectFrom("messages")
          .select("id")
          .where("channel", "=", channel)
          .where((eb) => expirable(eb, cutoff))
          .orderBy("id")
          .$call((q) => this.take(q, EXPIRE_BATCH))
          .execute()
      ).map((row) => Number(row.id));
      if (ids.length === 0) break;
      const removed = await this.db.transaction().execute(async (tx) => {
        await tx
          .updateTable("messages")
          .set({ status: EXPIRING })
          .where("id", "in", ids)
          .where((eb) => expirable(eb, cutoff))
          .execute();
        await tx
          .deleteFrom("meta_index")
          .where("message_id", "in", (eb) =>
            eb
              .selectFrom("messages")
              .select("messages.id")
              .where("messages.id", "in", ids)
              .where("messages.status", "=", EXPIRING),
          )
          .execute();
        const gone = await tx
          .deleteFrom("deliveries")
          .where("message_id", "in", (eb) =>
            eb
              .selectFrom("messages")
              .select("messages.id")
              .where("messages.id", "in", ids)
              .where("messages.status", "=", EXPIRING),
          )
          .executeTakeFirst();
        const deleted = await tx
          .deleteFrom("messages")
          .where("id", "in", ids)
          .where("status", "=", EXPIRING)
          .executeTakeFirst();
        return {
          messages: Number(deleted.numDeletedRows),
          deliveries: Number(gone.numDeletedRows),
        };
      });
      messages += removed.messages;
      deliveries += removed.deliveries;
      // A short batch was the last; an empty one means the rest changed under us.
      if (ids.length < EXPIRE_BATCH || removed.messages === 0) break;
    }
    return { messages, deliveries };
  }

  /** Appends entries to the audit log, in one transaction, stamped with the time and `actor`. */
  async appendAudit(actor: string, entries: readonly AuditInput[]): Promise<AuditEntry[]> {
    const at = this.now().toISOString();
    return this.db.transaction().execute((tx) => this.insertAudit(tx, actor, at, entries));
  }

  /** A page of the audit log, newest first. */
  async auditEntries(query: AuditQuery): Promise<Page<AuditEntry>> {
    const { action, channel, messageId, since, until, before, limit } = query;
    let select = this.db.selectFrom("audit_log").selectAll();
    if (action !== undefined) select = select.where("action", "=", action);
    if (channel !== undefined) select = select.where("channel", "=", channel);
    if (messageId !== undefined) select = select.where("message_id", "=", messageId);
    if (since !== undefined) select = select.where("at", ">=", since);
    if (until !== undefined) select = select.where("at", "<", until);
    if (before !== undefined) select = select.where("id", "<", before);
    const rows = await select
      .orderBy("id", "desc")
      .$call((q) => this.take(q, limit + 1))
      .execute();
    const items = rows.slice(0, limit).map((row): AuditEntry => ({
      id: Number(row.id),
      at: row.at,
      actor: row.actor,
      action: row.action,
      outcome: row.outcome,
      channel: row.channel,
      messageId: int64OrNull(row.message_id),
      detail: row.detail === null ? {} : (JSON.parse(row.detail) as AuditDetail),
    }));
    return { items, next: rows.length > limit ? items.at(-1)?.id : undefined };
  }

  /** Inserts a message's index tags. */
  private async insertTags(
    db: Kysely<Tables>,
    messageId: number,
    channel: string,
    tags: readonly MetaTag[],
  ): Promise<void> {
    for (const { index, keyId, tag } of tags) {
      await db
        .insertInto("meta_index")
        .values({ message_id: messageId, channel, index_name: index, key_id: keyId, tag })
        .execute();
    }
  }

  /**
   * Inserts one pending delivery per output per destination, in order, or each destination's own
   * outputs, and one row for a destination with none (`filtered`) or that failed (`failed`, with its
   * error); returns how many deliveries were queued to be sent.
   */
  private async queue(
    tx: Transaction<Tables>,
    messageId: number,
    message: { readonly channel: string; readonly generation: number },
    given: TransformOutputs,
    destinations: number,
  ): Promise<number> {
    // The same outputs for every destination, and none: the message was filtered, with no rows.
    if (!isByDestination(given) && given.length === 0) return 0;
    const outcomes: readonly DestinationOutcome[] = isByDestination(given)
      ? given.byDestination
      : Array.from({ length: destinations }, () => ({ outputs: given }));
    let queued = 0;
    for (const [destination, outcome] of outcomes.entries()) {
      if ("failure" in outcome || outcome.outputs.length === 0) {
        // No output: one row says why, so the message settles and shows what this destination got.
        // Its body is empty, never read: only a delivery with an output (seq 0 and up) is sent.
        await tx
          .insertInto("deliveries")
          .values({
            message_id: messageId,
            channel: message.channel,
            destination,
            seq: -1,
            // An empty value goes in as each database takes one: see EMPTY_BODY.
            body:
              outcome.emptyBody === undefined || outcome.emptyBody.byteLength === 0
                ? EMPTY_BODY[this.kind]
                : blob(outcome.emptyBody),
            status: "failure" in outcome ? "failed" : "filtered",
            attempts: 0,
            next_attempt_at: 0,
            last_error: "failure" in outcome ? outcome.failure : null,
            delivered_at: null,
            generation: message.generation,
          })
          .execute();
        continue;
      }
      for (const [seq, body] of outcome.outputs.entries()) {
        await tx
          .insertInto("deliveries")
          .values({
            message_id: messageId,
            channel: message.channel,
            destination,
            seq,
            body: blob(body),
            status: "pending",
            attempts: 0,
            // Due at once, whatever the reader's clock: only a retry sets a time in the future.
            next_attempt_at: 0,
            last_error: null,
            delivered_at: null,
            generation: message.generation,
          })
          .execute();
        queued += 1;
      }
    }
    return queued;
  }

  /** Records a refused replay, resend or clear, naming the message's channel when it exists. */
  private async refusal(
    actor: string,
    action: AuditAction,
    messageId: number,
    reason: RefusalReason,
  ): Promise<AuditEntry> {
    const row = await this.db
      .selectFrom("messages")
      .select("channel")
      .where("id", "=", messageId)
      .executeTakeFirst();
    const [entry] = await this.appendAudit(actor, [
      {
        action,
        outcome: reason === "not-found" ? "not-found" : "refused",
        channel: row?.channel,
        messageId,
        detail: reason === "not-found" ? {} : { reason },
      },
    ]);
    /* v8 ignore next: appendAudit returns one entry per input */
    if (entry === undefined) throw new Error("the audit entry was not written");
    return entry;
  }

  private async insertAudit(
    db: Kysely<Tables>,
    actor: string,
    at: string,
    entries: readonly AuditInput[],
  ): Promise<AuditEntry[]> {
    const written: AuditEntry[] = [];
    for (const input of entries) {
      const detail = input.detail ?? {};
      const entry = {
        at,
        actor,
        action: input.action,
        outcome: input.outcome ?? "ok",
        channel: input.channel ?? null,
        message_id: input.messageId ?? null,
        detail: Object.keys(detail).length === 0 ? null : JSON.stringify(detail),
      };
      written.push({
        id: await this.insertAuditRow(db, entry),
        at,
        actor,
        action: entry.action,
        outcome: entry.outcome,
        channel: entry.channel,
        messageId: entry.message_id,
        detail,
      });
    }
    return written;
  }

  /** Inserts an audit row and returns its id, which each database hands back its own way. */
  private async insertAuditRow(
    db: Kysely<Tables>,
    values: Insertable<AuditLogTable>,
  ): Promise<number> {
    const insert = db.insertInto("audit_log").values(values);
    switch (this.kind) {
      case "mysql":
        return Number((await insert.executeTakeFirstOrThrow()).insertId);
      case "sqlserver":
        return Number((await insert.output("inserted.id").executeTakeFirstOrThrow()).id);
      case "postgres":
      case "sqlite":
        return Number((await insert.returning("id").executeTakeFirstOrThrow()).id);
    }
  }

  /** Adds each message's state and its current deliveries' tally. */
  private async summarize(rows: readonly MessageRow[]): Promise<MessageSummary[]> {
    const tallies = new Map<number, Tallying>();
    if (rows.length > 0) {
      const generation = new Map(rows.map((row) => [Number(row.id), row.generation]));
      const deliveries = await this.db
        .selectFrom("deliveries")
        .select(["message_id", "generation", "status", "attempts"])
        .where(
          "message_id",
          "in",
          rows.map((row) => Number(row.id)),
        )
        .execute();
      for (const delivery of deliveries) {
        const messageId = Number(delivery.message_id);
        if (delivery.generation !== generation.get(messageId)) continue;
        const tally = tallies.get(messageId) ?? emptyTally();
        countOne(tally, delivery.status);
        if (delivery.status === "pending" && delivery.attempts > 0) tally.retrying += 1;
        tallies.set(messageId, tally);
      }
    }
    return rows.map((row) => {
      const id = Number(row.id);
      const status = readStatus(row.status);
      const deliveries = tallies.get(id) ?? emptyTally();
      return {
        id,
        channel: row.channel,
        status,
        state: messageState(status, deliveries),
        receivedAt: row.received_at,
        updatedAt: row.updated_at,
        size: int64OrNull(row.size),
        duplicateOf: int64OrNull(row.duplicate_of),
        generation: row.generation,
        deliveries,
        ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
        ...(row.content_dropped_at === null ? {} : { contentDroppedAt: row.content_dropped_at }),
      };
    });
  }

  /**
   * The fence on an engine write: the row still stands at `status`, where only the engine moves
   * it from, and the engine lease still carries `epoch`. Both are read in the statement that
   * writes, so a write from an engine whose lease another has taken since changes nothing.
   */
  private fence(status: "received" | "pending", epoch: number | undefined): RawBuilder<SqlBool> {
    const lease = sql<SqlBool>`exists (select 1 from ${sql.table("leases")} where ${sql.ref("leases.name")} = ${ENGINE_LEASE} and ${sql.ref("leases.epoch")} = ${epoch})`;
    return sql<SqlBool>`(${sql.ref("status")} = ${status} and ${lease})`;
  }

  /** Keeps a query's first row. */
  private first<TB extends keyof Tables, O>(
    query: SelectQueryBuilder<Tables, TB, O>,
  ): SelectQueryBuilder<Tables, TB, O> {
    return this.take(query, 1);
  }

  /** Keeps a query's first `count` rows: SQL Server writes `TOP`, the others `LIMIT`. */
  private take<TB extends keyof Tables, O>(
    query: SelectQueryBuilder<Tables, TB, O>,
    count: number,
  ): SelectQueryBuilder<Tables, TB, O> {
    return this.kind === "sqlserver" ? query.top(count) : query.limit(count);
  }

  /**
   * A condition that `column` holds exactly `value`, or is null when `value` is. On SQL Server and
   * MySQL it also compares lengths, since their `=` pads the shorter value.
   */
  private same(column: string, value: Uint8Array | string | null): RawBuilder<boolean> {
    const ref = sql.ref(column);
    if (value === null) return sql<boolean>`${ref} is null`;
    if (this.kind !== "sqlserver" && this.kind !== "mysql") return sql<boolean>`${ref} = ${value}`;
    const length = sql.raw(this.kind === "sqlserver" ? "datalength" : "octet_length");
    return sql<boolean>`(${ref} = ${value} and ${length}(${ref}) = ${length}(${value}))`;
  }

  /** Inserts a message and returns its id, which each database hands back its own way. */
  private async insertMessage(
    db: Kysely<Tables>,
    values: Insertable<MessagesTable>,
  ): Promise<number> {
    const insert = db.insertInto("messages").values(values);
    switch (this.kind) {
      case "mysql":
        // MySQL has no RETURNING; the driver reports the id it assigned.
        return Number((await insert.executeTakeFirstOrThrow()).insertId);
      case "sqlserver":
        return Number((await insert.output("inserted.id").executeTakeFirstOrThrow()).id);
      case "postgres":
      case "sqlite":
        return Number((await insert.returning("id").executeTakeFirstOrThrow()).id);
    }
  }
}

/** What a dropped body is emptied to: the column holds no nulls, and an empty value holds nothing. */
const EMPTY = Buffer.alloc(0);

/**
 * An empty body, as each database takes one. On SQL Server it is a literal: tedious declares a
 * bound empty buffer with a maximum length of 0, which the server refuses, and the refusal ends the
 * transaction.
 */
const EMPTY_BODY: Readonly<Record<StorageKind, Uint8Array | RawBuilder<Uint8Array>>> = {
  sqlite: EMPTY,
  postgres: EMPTY,
  mysql: EMPTY,
  sqlserver: sql<Uint8Array>`0x`,
};

/**
 * A body as every driver binds it. mysql2 and Kysely's SQL Server driver recognise a `Buffer` as
 * binary, not a bare `Uint8Array`; the view shares the body's memory, so nothing is copied.
 */
function blob(body: Uint8Array): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

/** Rejects with a {@link LeaseLostError} when a fenced write, given `epoch`, changed nothing. */
function fenced(epoch: number | undefined, result: { readonly numUpdatedRows: bigint }): void {
  if (epoch !== undefined && result.numUpdatedRows === 0n) throw new LeaseLostError();
}
