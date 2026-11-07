/**
 * The connector interfaces. Pathways' own connectors implement these, and so can yours: a source
 * brings messages in, a destination sends them out, and the engine does everything in between
 * (storage, ordering, retries, transforms).
 */

/** What a source can tell the engine about a message it hands over. Every field is optional. */
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
}

/** What a source hands each incoming message to. */
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
 * calls on every pass. A source that listens (MLLP, HTTP) implements `start` and `stop`.
 */
export interface SourceConnector {
  poll?(sink: MessageSink): Promise<void>;
  start?(sink: MessageSink): Promise<void>;
  stop?(): Promise<void>;
}

/** One output of one message, on its way to one destination. */
export interface OutgoingMessage {
  /** The id of the stored message this came from. */
  readonly messageId: number;
  /** Which output of that message's transform this is, from 0. */
  readonly seq: number;
  readonly body: Uint8Array;
}

/**
 * Sends messages out. Throw to fail an attempt: by default the engine retries it with growing waits
 * and holds this destination's later messages behind it. Throw a {@link DeliveryRejected} when
 * sending the same message again cannot succeed (the receiver rejected its content), and the engine
 * marks it failed and moves on.
 */
export interface DestinationConnector {
  deliver(message: OutgoingMessage): Promise<void>;
  /** Releases what the destination keeps open between deliveries, such as connections. */
  stop?(): Promise<void>;
}

/**
 * A delivery the receiver rejected for good: retrying the same message will not help.
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
  }
}
