/**
 * The connector interfaces. Pathways' own connectors implement these, and so can yours: a source
 * brings messages in, a destination sends them out, and the engine does everything in between
 * (storage, ordering, retries, transforms).
 */

/**
 * What a source can tell the engine about a message it hands over. Every field is optional.
 *
 * @example
 * ```ts
 * await sink.receive(body, { duplicateKey: `${sender}|${controlId}` });
 * await sink.receive(body, { failure: "inbound: NO_MSH_SEGMENT" });
 * await sink.receive(body, { idempotencyKey: `queue|${deliveryTag}` });
 * await sink.receive(body, { idempotencyKey: `queue|${deliveryTag}`, resumed: true });
 * ```
 */
export interface ReceiveOptions {
  /**
   * What identifies the message to its sender, such as the sender and its MSH-10 control ID. When
   * an earlier message of the channel carried the same key, this one is stored and processed as
   * usual, flagged as a possible duplicate: never dropped. The engine keeps a hash of the key,
   * never the key itself.
   */
  readonly duplicateKey?: string | undefined;
  /**
   * Stores the message as failed, with this reason, instead of handing it to the transform: for a
   * message the source received but could not accept, such as one with no usable header. A short
   * code, never message content.
   */
  readonly failure?: string | undefined;
  /**
   * What names this one message to the source, the same every time the source hands it in. It is
   * stored with the message, so that when the source hands the message in again with `resumed`,
   * after a stop between storing it and acknowledging it, it is stored once. The engine keeps a
   * hash of the key, never the key itself. A custom store may ignore it, and then stores such a
   * message twice.
   */
  readonly idempotencyKey?: string | undefined;
  /**
   * True when the source hands in again, under the same `idempotencyKey`, a message that an earlier
   * run may have stored already: one it took in and never acknowledged. When a message of the
   * channel was stored with that key, nothing new is stored and that message's id comes back. Only
   * these messages are looked up, so a message handed in for the first time costs no lookup.
   */
  readonly resumed?: boolean | undefined;
}

/**
 * What a source hands each incoming message to.
 *
 * @example
 * ```ts
 * const id = await sink.receive(body); // durable once this resolves
 * await acknowledge(id);
 * ```
 */
export interface MessageSink {
  /**
   * Stores the message and resolves with its id once it is durable. Acknowledge the sender (move
   * the file, send the ACK) only after this resolves: that ordering is what keeps a crash from
   * losing a message. If it rejects, do not acknowledge; the sender should send again.
   *
   * `options` is optional, so a source that passes only `body` keeps working unchanged.
   */
  receive(body: Uint8Array, options?: ReceiveOptions): Promise<number>;
}

/**
 * Brings messages in. A source that polls (a folder, an inbox) implements `poll`, which the engine
 * calls on every pass. A source that listens (MLLP, HTTP) implements `start` and `stop`. A custom
 * source's module builds one with a `SourceFactory`.
 *
 * @example
 * ```ts
 * const source: SourceConnector = {
 *   async poll(sink) {
 *     for (const body of await takeWaiting()) await sink.receive(body);
 *   },
 * };
 * ```
 */
export interface SourceConnector {
  poll?(sink: MessageSink): Promise<void>;
  start?(sink: MessageSink): Promise<void>;
  stop?(): Promise<void>;
}

/**
 * Set on a message that is being sent again after an attempt was cut off: the engine stopped after
 * handing it to the destination and before it recorded the outcome, so the receiver may have it
 * already. The message is the same; only the flag tells it apart.
 *
 * @example
 * ```ts
 * const header = (resend: Resend | undefined): string | undefined =>
 *   resend === undefined ? undefined : String(resend.previousAttempts);
 * ```
 */
export interface Resend {
  /** How many attempts were made before this one, the one cut off among them. */
  readonly previousAttempts: number;
}

/**
 * One output of one message, on its way to one destination.
 *
 * @example
 * ```ts
 * const name = (message: OutgoingMessage): string => `${message.messageId}-${message.seq}.hl7`;
 * ```
 */
export interface OutgoingMessage {
  /** The id of the stored message this came from. */
  readonly messageId: number;
  /** Which output of that message's transform this is, from 0. */
  readonly seq: number;
  readonly body: Uint8Array;
  /**
   * Set when this is a possible duplicate: an earlier attempt was cut off after the send, so the
   * receiver may have it already. A destination may tell the receiver so (an HTTP destination's
   * `resendHeader`); it sends the message either way. Undefined on every other send.
   */
  readonly resend?: Resend | undefined;
}

/**
 * Sends messages out. Throw to fail an attempt: by default the engine retries it with growing waits
 * and holds this destination's later messages behind it. Throw a {@link DeliveryRejected} when
 * sending the same message again cannot succeed (the receiver rejected its content), and the engine
 * marks it failed and moves on. A custom destination's module builds one with a
 * `DestinationFactory`.
 *
 * @example
 * ```ts
 * const destination: DestinationConnector = {
 *   async deliver(message) {
 *     await upload(`${message.messageId}-${message.seq}`, message.body);
 *   },
 * };
 * ```
 */
export interface DestinationConnector {
  deliver(message: OutgoingMessage): Promise<void>;
  /** Releases what the destination keeps open between deliveries, such as connections. */
  stop?(): Promise<void>;
}

/** Marks a {@link DeliveryRejected}, shared by every copy of Pathways loaded in one process. */
const REJECTED = Symbol.for("@cosyte/pathways/DeliveryRejected");

/**
 * A delivery the receiver rejected for good: retrying the same message will not help.
 *
 * `instanceof DeliveryRejected` holds for one made by any copy of Pathways in the process: the
 * `pathways` command bundles its own copy of this class, and a custom destination imports another
 * from the package entry, so the check goes by a shared mark rather than by class identity.
 *
 * @example
 * ```ts
 * if (ack.code === "AE") throw new DeliveryRejected("AE");
 * ```
 */
export class DeliveryRejected extends Error {
  /** A short, stable reason, such as an ACK code. Never message content. */
  readonly reason: string;

  /** @param reason A short, stable reason, such as an ACK code. Never message content. */
  constructor(reason: string) {
    super(`the destination rejected the message (${reason})`);
    this.name = "DeliveryRejected";
    this.reason = reason;
    Object.defineProperty(this, REJECTED, { value: true });
  }

  /** Whether `value` is a DeliveryRejected from any copy of Pathways; a subclass checks as usual. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== DeliveryRejected) return Function.prototype[Symbol.hasInstance].call(this, value);
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { readonly [REJECTED]?: unknown })[REJECTED] === true
    );
  }
}
