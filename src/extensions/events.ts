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
  "delivery-rejected",
  "source-down",
  "source-up",
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
 * What every lifecycle event carries: its type, when it happened and the channel it happened on.
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
  | "load"
  | "parse"
  | "transform"
  | "output"
  | "timeout"
  | "memory"
  | "crash";

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
 * HTTP 5xx). The destination retries it after `retryInMs`, and its later deliveries wait behind it.
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
 * A source could not start listening (its port is taken, say). The engine tries again after
 * `retryInMs` and reports this again on each failed try, counting up `attempt`.
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
  /** The error's name, such as `Error`. */
  readonly name: string;
  /** The error's code, such as `EADDRINUSE`. */
  readonly code: string | undefined;
}

/**
 * A source that was down is listening again. A source that starts on the first try reports nothing.
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
 * Any lifecycle event: switch on `type` to narrow it. Engine-wide hooks receive every channel's
 * events; a channel's own hooks receive that channel's.
 *
 * The operator-commands slice adds audit entries to this union once its audit log lands; until then,
 * hooks see message, delivery and source events only.
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
  | DeliveryRejectedEvent
  | SourceDownEvent
  | SourceUpEvent;
