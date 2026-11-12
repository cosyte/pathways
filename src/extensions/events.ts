// The events a lifecycle hook receives. Types and one list of names only: the package entry exports
// them, so this module imports nothing, not even a type: a type from the worker's entry would make
// the package's declarations depend on the worker's.

/**
 * Every lifecycle event's `type`, in the order a message meets them. A hook entry's `events:` list in
 * the YAML names some of these to receive only those.
 *
 * @example
 * ```ts
 * LIFECYCLE_EVENTS.includes("delivered"); // true
 * ```
 */
export const LIFECYCLE_EVENTS = [
  "received",
  "receive-failed",
  "transformed",
  "filtered",
  "transform-failed",
  "delivered",
  "delivery-retry",
  "delivery-redirected",
  "delivery-rejected",
  "delivery-exhausted",
  "source-down",
  "source-up",
  "audit",
] as const;

/**
 * The name of one lifecycle event: one of {@link LIFECYCLE_EVENTS}.
 *
 * @example
 * ```ts
 * const paged: readonly LifecycleEventType[] = ["delivery-rejected", "transform-failed"];
 * ```
 */
export type LifecycleEventType = (typeof LIFECYCLE_EVENTS)[number];

/**
 * What every lifecycle event about a channel carries: its type, when it happened and the channel it
 * happened on. An {@link AuditEvent} can concern no one channel, so it stands on its own.
 * Events carry ids, counts, error names, codes and times, never message content and never an
 * error's own text, so a hook can send them anywhere.
 *
 * @example
 * ```ts
 * const line = (event: LifecycleEventBase): string => `${event.at} ${event.channel} ${event.type}`;
 * ```
 */
export interface LifecycleEventBase {
  readonly type: LifecycleEventType;
  /** When it happened, as an ISO 8601 time in UTC, such as `2026-11-07T12:00:00.000Z`. */
  readonly at: string;
  /** The channel's name. */
  readonly channel: string;
}

/**
 * A message was stored, before its source acknowledged it.
 *
 * @example
 * ```ts
 * if (event.type === "received" && event.duplicateOf !== undefined) flagDuplicate(event.messageId);
 * ```
 */
export interface ReceivedEvent extends LifecycleEventBase {
  readonly type: "received";
  readonly messageId: number;
  /** The message's size in bytes. */
  readonly bytes: number;
  /** True when the source stored it as failed, such as an MLLP message with no usable header. */
  readonly failed: boolean;
  /** The earlier message this one may repeat (same sender and control ID), when there is one. */
  readonly duplicateOf: number | undefined;
}

/**
 * A message could not be stored, so its source did not acknowledge it and its sender should send it
 * again. Storage being unreachable shows up here first.
 *
 * @example
 * ```ts
 * if (event.type === "receive-failed") page(`storage refused a message on ${event.channel}`);
 * ```
 */
export interface ReceiveFailedEvent extends LifecycleEventBase {
  readonly type: "receive-failed";
  /** The error's name, such as `SqliteError`. */
  readonly name: string;
  /** The error's code, when it has one, such as `SQLITE_FULL`. */
  readonly code: string | undefined;
}

/**
 * A message's transform returned one or more outputs, each now queued for every destination.
 *
 * @example
 * ```ts
 * if (event.type === "transformed") count("outputs", event.outputs);
 * ```
 */
export interface TransformedEvent extends LifecycleEventBase {
  readonly type: "transformed";
  readonly messageId: number;
  /** How many outputs the transform returned. */
  readonly outputs: number;
}

/**
 * A message's transform returned no output, so nothing is delivered.
 *
 * @example
 * ```ts
 * if (event.type === "filtered") count("filtered", 1);
 * ```
 */
export interface FilteredEvent extends LifecycleEventBase {
  readonly type: "filtered";
  readonly messageId: number;
}

/**
 * The stage a message's transform failed in: `load` (the transform would not load), `parse` (the
 * message could not be read in the channel's format), `transform` (the transform threw), `output`
 * (what it returned could not be written), `timeout`, `memory` or `crash` (its worker died). Kept
 * equal to the worker's own list by a test.
 *
 * @example
 * ```ts
 * const yourFix = (kind: TransformFailureKind): boolean => kind === "transform" || kind === "output";
 * ```
 */
export type TransformFailureKind =
  "load" | "parse" | "transform" | "output" | "timeout" | "memory" | "crash";

/**
 * A message's transform threw, timed out or ran out of memory, or its input or output could not be
 * read. The message is marked failed and the channel moves on.
 *
 * @example
 * ```ts
 * if (event.type === "transform-failed") page(`${event.channel}: ${event.name} at ${event.where ?? "?"}`);
 * ```
 */
export interface TransformFailedEvent extends LifecycleEventBase {
  readonly type: "transform-failed";
  readonly messageId: number;
  /** The stage that failed. */
  readonly kind: TransformFailureKind;
  /** The error's name, such as `TypeError`. */
  readonly name: string;
  /** The error's code, when it has one, such as a parser's `NO_MSH_SEGMENT`. */
  readonly code: string | undefined;
  /** Where in the transform it was thrown, as `file:line:column`, when it was. */
  readonly where: string | undefined;
}

/**
 * What every event about one delivery carries: the message, the destination and the delivery.
 *
 * @example
 * ```ts
 * const key = (event: DeliveryEventBase): string => `${event.channel}/${event.destination}/${event.deliveryId}`;
 * ```
 */
export interface DeliveryEventBase extends LifecycleEventBase {
  readonly messageId: number;
  /** The destination's place in the channel's `destinations:` list, from 0. */
  readonly destination: number;
  readonly deliveryId: number;
  /** Which attempt this was, from 1. */
  readonly attempt: number;
  /**
   * Set when this attempt was a possible duplicate: an earlier one was cut off after the send, so
   * the receiver may have the message already. `previousAttempts` counts the attempts before it.
   * Absent otherwise.
   */
  readonly resend?: { readonly previousAttempts: number } | undefined;
}

/**
 * A destination accepted an output.
 *
 * @example
 * ```ts
 * if (event.type === "delivered" && event.attempt > 1) resolveIncident(event.channel, event.destination);
 * ```
 */
export interface DeliveredEvent extends DeliveryEventBase {
  readonly type: "delivered";
}

/**
 * A delivery failed in a way worth trying again (a refused connection, a timeout, an MLLP `AR`, an
 * HTTP 408, 425, 429 or 5xx). The destination retries it after `retryInMs`, and its later deliveries
 * wait behind it. `retryInMs` is the backoff, or the wait a 429's or a 503's Retry-After asked for
 * when that is longer, up to five minutes.
 *
 * @example
 * ```ts
 * if (event.type === "delivery-retry" && event.attempt === 5) page(`${event.channel} is retrying`);
 * ```
 */
export interface DeliveryRetryEvent extends DeliveryEventBase {
  readonly type: "delivery-retry";
  /** How long until the next attempt, in milliseconds. */
  readonly retryInMs: number;
  /** When the next attempt is due, as an ISO 8601 time in UTC. */
  readonly retryAt: string;
  /** The error's name, such as `MllpDeliveryError`. */
  readonly name: string;
  /** The error's code, such as `ECONNREFUSED`, `ACK_TIMEOUT` or `HTTP_503`. */
  readonly code: string | undefined;
}

/**
 * An HTTP destination answered with a redirect (a 3xx). Redirects are never followed, since
 * following one could send a message to a host nobody configured: the delivery is held and tried
 * again after the longest wait, five minutes, and its later deliveries wait behind it, until the
 * destination's URL is fixed. It names the Location's host only, never its path or query.
 *
 * @example
 * ```ts
 * if (event.type === "delivery-redirected") page(`${event.channel} moved to ${event.locationHost}`);
 * ```
 */
export interface DeliveryRedirectedEvent extends DeliveryEventBase {
  readonly type: "delivery-redirected";
  /** How long until the next attempt, in milliseconds. */
  readonly retryInMs: number;
  /** When the next attempt is due, as an ISO 8601 time in UTC. */
  readonly retryAt: string;
  /** The 3xx status, such as 301 or 308. */
  readonly status: number;
  /** The host the Location names, with its port when it has one, or undefined when it names none. */
  readonly locationHost: string | undefined;
}

/**
 * A destination rejected an output for good (an MLLP `AE`, an HTTP 4xx): it is marked failed and the
 * destination moves on to the next.
 *
 * @example
 * ```ts
 * if (event.type === "delivery-rejected") page(`${event.channel}: rejected (${event.reason})`);
 * ```
 */
export interface DeliveryRejectedEvent extends DeliveryEventBase {
  readonly type: "delivery-rejected";
  /** The destination's short, stable reason, such as `AE` or `HTTP 400`. */
  readonly reason: string;
}

/**
 * A delivery ran out of retries: it had its `retry.limit` of attempts, or its next attempt would come
 * later than `retry.maxAge` after it was queued. It is marked failed, its body kept for an operator
 * to resend, and the destination moves on to the next. Only a destination whose retry settings set
 * a limit or an age sends this.
 *
 * @example
 * ```ts
 * if (event.type === "delivery-exhausted") page(`${event.channel}: gave up after ${event.attempt}`);
 * ```
 */
export interface DeliveryExhaustedEvent extends DeliveryEventBase {
  readonly type: "delivery-exhausted";
  /** `limit` when it had its attempts, `maxAge` when it was too old to wait for another. */
  readonly reason: "limit" | "maxAge";
  /** The last error's name, such as `MllpDeliveryError`. */
  readonly name: string;
  /** The last error's code, such as `ECONNREFUSED` or `HTTP_503`. */
  readonly code: string | undefined;
}

/**
 * A source could not start listening (its port is taken, say), or a running source said it lost its
 * connection (`MessageSink.sourceDown`; then `name` is `SourceDown`). A listener is tried again after
 * `retryInMs`; a source that lost its connection is told to wait that long. Each is reported again
 * on each failure in a row, counting up `attempt`.
 *
 * @example
 * ```ts
 * if (event.type === "source-down" && event.attempt === 1) page(`${event.channel} cannot listen`);
 * ```
 */
export interface SourceDownEvent extends LifecycleEventBase {
  readonly type: "source-down";
  /** How many tries have failed in a row, from 1. */
  readonly attempt: number;
  readonly retryInMs: number;
  /** When the next try is due, as an ISO 8601 time in UTC. */
  readonly retryAt: string;
  /** The error's name, such as `Error`, or `SourceDown` when the source said it lost its connection. */
  readonly name: string;
  /** The error's code, such as `EADDRINUSE`, or the code the source passed, such as `ECONNRESET`. */
  readonly code: string | undefined;
}

/**
 * A source that was down is listening, or connected, again. A source that starts on the first try reports nothing.
 *
 * @example
 * ```ts
 * if (event.type === "source-up") resolveIncident(event.channel, "source");
 * ```
 */
export interface SourceUpEvent extends LifecycleEventBase {
  readonly type: "source-up";
}

/**
 * Every action the audit log records, as an {@link AuditEvent}'s `action`: `search` (messages
 * listed), `view` (one message's details, without content), `content-view`, `replay`, `resend`,
 * `clear`, `retention` (a run, with what it deleted), `config` (a configuration change seen when
 * the engine started), `lease-release` (the engine lease freed by force), `migrate` (schema steps
 * applied by `pathways migrate`), `channel-pause`, `channel-resume`, `channel-stop`,
 * `channel-halt` and `channel-reload` (a `pathways channel` command), `verify` (a stored
 * message read by `pathways verify`), `bulk-replay` (a run of `pathways replay --status failed`:
 * its scope, each batch and a summary), `archive` (a sealed archive retention wrote and checked
 * before changing what it holds), and `node-forget` (a stale node's row removed by
 * `pathways nodes forget`). Kept equal to the audit log's own list by a test.
 *
 * @example
 * ```ts
 * const sensitive = (action: AuditEventAction): boolean => action === "content-view";
 * ```
 */
export type AuditEventAction =
  | "search"
  | "view"
  | "content-view"
  | "replay"
  | "resend"
  | "clear"
  | "retention"
  | "config"
  | "lease-release"
  | "migrate"
  | "channel-pause"
  | "channel-resume"
  | "channel-stop"
  | "channel-halt"
  | "channel-reload"
  | "verify"
  | "bulk-replay"
  | "archive"
  | "batch"
  | "node-forget";

/**
 * An entry of the audit log, once it is stored: who did what, to which message, and how it ended.
 * The operator commands (and the engine's retention runs and configuration checks) write them;
 * engine-wide hooks receive them, and channels' own hooks do not. Like every event it carries ids,
 * counts, statuses, codes and hashes, never content, so a hook can forward the audit log to a file
 * or a SIEM.
 *
 * @example
 * ```ts
 * if (event.type === "audit" && event.action === "content-view") {
 *   siem.send({ at: event.at, user: event.actor, message: event.messageId });
 * }
 * ```
 */
export interface AuditEvent {
  readonly type: "audit";
  /** When it happened, as an ISO 8601 time in UTC. */
  readonly at: string;
  /** The channel acted on, or `undefined` for an entry about no one channel. */
  readonly channel: string | undefined;
  /** The entry's id in the audit log, which only grows. */
  readonly entryId: number;
  /** The operating system user who acted. */
  readonly actor: string;
  readonly action: AuditEventAction;
  /** `ok`; `refused`, with `detail.reason` saying why; or `not-found`. */
  readonly outcome: "ok" | "refused" | "not-found";
  /** The message acted on, when there is one. */
  readonly messageId: number | undefined;
  /** Counts, statuses, codes and hashes, such as `{ status: "transformed", queued: 2 }`. */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Any lifecycle event: switch on `type` to narrow it. Engine-wide hooks receive every channel's
 * events and the audit log's; a channel's own hooks receive that channel's events.
 *
 * @example
 * ```ts
 * function describe(event: LifecycleEvent): string {
 *   switch (event.type) {
 *     case "delivery-rejected":
 *       return `delivery ${event.deliveryId} rejected (${event.reason})`;
 *     case "source-down":
 *       return `source down, try ${event.attempt}`;
 *     default:
 *       return event.type;
 *   }
 * }
 * ```
 */
export type LifecycleEvent =
  | ReceivedEvent
  | ReceiveFailedEvent
  | TransformedEvent
  | FilteredEvent
  | TransformFailedEvent
  | DeliveredEvent
  | DeliveryRetryEvent
  | DeliveryRedirectedEvent
  | DeliveryRejectedEvent
  | DeliveryExhaustedEvent
  | SourceDownEvent
  | SourceUpEvent
  | AuditEvent;
