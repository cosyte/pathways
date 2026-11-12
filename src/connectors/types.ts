import type { JsonValue } from "../transform.js";

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
 * await sink.receive(body, { source: { queue: "inbound", deliveryTag } });
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
  /**
   * What the source knows about the message, which the channel's transform reads as
   * `ctx.source.facts`: a map of plain JSON values (strings, finite numbers, booleans, null, lists
   * and maps). Anything else is refused with the code `INVALID_SOURCE_FACTS` before the message is
   * stored. The engine keeps a copy taken at the call, so the source may reuse or change its object
   * afterwards. It is never logged, sent to a hook or stored: the engine holds it in memory until the
   * message is transformed, so a message taken in before the engine restarts is transformed
   * without it.
   */
  readonly source?: Readonly<Record<string, JsonValue>> | undefined;
}

/**
 * What a source hands each incoming message to, and tells when its connection drops and comes back.
 *
 * @example
 * ```ts
 * const id = await sink.receive(body); // durable once this resolves
 * await acknowledge(id);
 *
 * socket.on("close", () => {
 *   const wait = sink.sourceDown?.("ECONNRESET") ?? 1_000;
 *   setTimeout(reconnect, wait);
 * });
 * socket.on("ready", () => sink.sourceUp?.());
 * ```
 */
export interface MessageSink {
  /**
   * Stores the message and resolves with its id once it is durable. Acknowledge the sender (move
   * the file, send the ACK) only after this resolves: that ordering is what keeps a crash from
   * losing a message. If it rejects, do not acknowledge; the sender should send again.
   *
   * `options` is optional, so a source that passes only `body` keeps working unchanged.
   *
   * On a channel that stores nothing (`storage.content: none`), nothing is stored: this resolves
   * once the message was transformed and every destination accepted it, with its pass id (the
   * time it came in, in microseconds since 1970, never given twice), and rejects with a {@link PassFailed} that says whether the sender should send again.
   */
  receive(body: Uint8Array, options?: ReceiveOptions): Promise<number>;
  /**
   * Says the source lost what it reads from (a broker, a remote server, a socket it dialled) and
   * cannot take messages in until it is back. Until {@link sourceUp}, the health endpoint shows
   * the channel's source `down` and answers 503, readiness fails, and the hooks are sent a
   * `source-down` event with `name: "SourceDown"`. `code` is a short code such as `ECONNRESET`
   * (letters, digits and `_.:-`, at most 64 characters), never an error's text: anything else is
   * kept as `UNSPECIFIED`.
   *
   * Returns how long to wait before trying to connect again, in milliseconds: 1 second, doubling
   * with each report in a row, to 5 minutes. The engine's own sink always has this method; it is
   * optional so a sink a test builds by hand need not.
   */
  sourceDown?(code: string): number;
  /**
   * Says a source that reported {@link sourceDown} is connected again: health shows it `up`, and
   * the hooks are sent a `source-up` event. Nothing happens when it was not down.
   */
  sourceUp?(): void;
}

/**
 * Brings messages in. A source that polls (a folder, an inbox) implements `poll`, which the engine
 * calls on each pass its schedule makes due (the channel's `poll:`, or the engine-wide
 * `pollInterval`). A source that listens (MLLP, HTTP) implements `start` and `stop`. A custom
 * source's module builds one with a `SourceFactory`.
 *
 * @example
 * ```ts
 * const source: SourceConnector = {
 *   async poll(sink, signal) {
 *     for (const body of await takeWaiting({ signal })) await sink.receive(body);
 *   },
 * };
 * ```
 */
export interface SourceConnector {
  /**
   * One pass: takes in what is waiting, each message through `sink`. The engine never starts a pass
   * while the last one's call has not returned. At the pass's deadline (`poll: { deadline }`, 5
   * minutes by default) the engine stops waiting: `signal` aborts, which a source may pass to its
   * client to give up a hung listing or query, and `sink.receive` refuses every later message with
   * the code `POLL_DEADLINE`, so the source keeps it for the next pass.
   */
  poll?(sink: MessageSink, signal?: AbortSignal): Promise<void>;
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
  /**
   * The id of the stored message this came from; on a channel that stores nothing, the message's
   * pass id: the time it came in, in microseconds since 1970, never given twice, so outputs named by
   * it stay apart across restarts.
   */
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
  /**
   * Aborted when an operator halts the channel (`pathways channel halt`) while this send is in
   * flight. A destination that honours it gives up the send at once; the engine stops waiting
   * either way, records no outcome, and sends the message again after the channel resumes, flagged
   * as a possible duplicate when the send was marked.
   */
  readonly signal?: AbortSignal | undefined;
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

/** Marks a {@link PassFailed}, shared by every copy of Pathways loaded in one process. */
const PASS_FAILED = Symbol.for("@cosyte/pathways/PassFailed");

/**
 * Why `sink.receive` refused a message of a channel that stores nothing (`storage.content: none`),
 * where each message is transformed and delivered before `receive` resolves. `permanent` says
 * whether the sender should send it again:
 *
 * - `false`: a destination failed in a way that may pass (it was down, it timed out, the pass ran
 *   past `passTimeout`), so the sender should send again. `retryAfterMs` is how long it might wait.
 *   An MLLP source closes without an ACK and an HTTP source answers 503 with `Retry-After`.
 * - `true`: sending the same message again cannot help (the transform failed, or a destination
 *   rejected it). An MLLP source answers `AE`, an HTTP source 422, and a file source moves the file
 *   into its `errorDir`.
 *
 * A source that does not know this class treats it as any failed `receive`: it does not
 * acknowledge, and the sender sends again. `instanceof PassFailed` holds for one made by any copy
 * of Pathways in the process.
 *
 * @example
 * ```ts
 * try {
 *   await sink.receive(body);
 * } catch (error) {
 *   if (error instanceof PassFailed && error.permanent) answer("AE");
 *   else closeWithoutAnswer();
 * }
 * ```
 */
export class PassFailed extends Error {
  /** Whether sending the same message again cannot help. */
  readonly permanent: boolean;
  /** A short, stable code, such as `PASS_TIMEOUT` or `DESTINATION_REJECTED`. Never message content. */
  readonly code: string;
  /** For a failure that may pass: how long the sender might wait before it sends again. */
  readonly retryAfterMs: number | undefined;

  /**
   * @param code A short, stable code. Never message content.
   * @param permanent Whether sending the same message again cannot help.
   * @param retryAfterMs For a failure that may pass, how long the sender might wait.
   */
  constructor(code: string, permanent: boolean, retryAfterMs?: number) {
    super(
      permanent
        ? `the message was not accepted (${code}); sending it again will not help`
        : `the message was not accepted (${code}); send it again`,
    );
    this.name = "PassFailed";
    this.code = code;
    this.permanent = permanent;
    this.retryAfterMs = permanent ? undefined : retryAfterMs;
    Object.defineProperty(this, PASS_FAILED, { value: true });
  }

  /** Whether `value` is a PassFailed from any copy of Pathways; a subclass checks as usual. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== PassFailed) return Function.prototype[Symbol.hasInstance].call(this, value);
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { readonly [PASS_FAILED]?: unknown })[PASS_FAILED] === true
    );
  }
}
