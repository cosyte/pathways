import {
  connect as netConnect,
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";
import {
  connect as tlsConnect,
  createServer as createTlsServer,
  type ConnectionOptions,
  type TLSSocket,
} from "node:tls";

import { clientTlsOptions, serverTlsOptions } from "./tls.js";
import type { ClientTlsMaterial, ServerTlsMaterial } from "./tls.js";
import { encodeFrame, FrameDecoder, type Framing, type TcpFramingError } from "./tcp-framing.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
  type SourceConnector,
} from "./types.js";

/**
 * What a tcp source's reply builder is given: the id of the message just stored. It runs only once
 * the message is stored.
 *
 * @example
 * ```ts
 * const request: TcpReplyRequest = { messageId: 42 };
 * ```
 */
export interface TcpReplyRequest {
  /** The stored message's id. */
  readonly messageId: number;
}

/**
 * Builds the reply a tcp source sends once a message is stored, named in the channel's YAML as
 * `source: { tcp: { ..., reply: { builder: ./reply.ts } } }` and exported as the module's default.
 * It returns the reply's bytes, or a string sent as UTF-8; the source adds the framing. It runs in
 * the engine's own thread, once per message, under the channel's transform time limit. If it throws,
 * runs past the limit or returns something else, the source logs `tcp-reply-failed` and closes the
 * connection without a reply: the message is stored, and a sender that sends it again stores it twice.
 *
 * @example
 * ```ts
 * // channels/orders-in/reply.ts: answers OK and the stored id, one line.
 * import type { TcpReplyBuilder } from "@cosyte/pathways";
 *
 * export default (({ messageId }) => `OK ${messageId}`) satisfies TcpReplyBuilder;
 * ```
 */
export type TcpReplyBuilder = (
  request: TcpReplyRequest,
) => Uint8Array | string | Promise<Uint8Array | string>;

/**
 * The reply a tcp destination read for one output, for its reply check to judge.
 *
 * @example
 * ```ts
 * const text = (reply: TcpReply): string => Buffer.from(reply.body).toString("latin1");
 * ```
 */
export interface TcpReply {
  /** The reply's bytes, without the framing. Empty for an empty frame. */
  readonly body: Uint8Array;
  /** The id of the stored message the output came from. */
  readonly messageId: number;
  /** Which output of that message's transform it was, from 0. */
  readonly seq: number;
}

/**
 * What a reply check decides: `delivered`, `retry` (the engine tries the same output again, holding
 * later ones behind it), or `rejected` (failed for good; the destination moves on).
 *
 * @example
 * ```ts
 * const verdict: TcpReplyVerdict = "retry";
 * ```
 */
export type TcpReplyVerdict = "delivered" | "retry" | "rejected";

/**
 * Judges the reply a tcp destination with `expectReply: true` read, named in the channel's YAML as
 * `replyCheck: ./check.ts` and exported as the module's default. Without one, any reply means
 * delivered. If it throws, runs past the channel's transform time limit or returns anything but a
 * {@link TcpReplyVerdict}, the delivery is retried with the code `REPLY_CHECK_FAILED`.
 *
 * @example
 * ```ts
 * // channels/orders-out/check.ts: the receiver answers ACK or NAK.
 * import type { TcpReplyCheck } from "@cosyte/pathways";
 *
 * export default ((reply) => {
 *   const text = Buffer.from(reply.body).toString("latin1");
 *   return text === "ACK" ? "delivered" : text === "NAK" ? "rejected" : "retry";
 * }) satisfies TcpReplyCheck;
 * ```
 */
export type TcpReplyCheck = (reply: TcpReply) => TcpReplyVerdict | Promise<TcpReplyVerdict>;

/**
 * Something a tcp source reports for the engine to log: an event name, a level, and fields that are
 * ids, counts, codes and error names only. Never message content, error text or key material.
 */
export interface TcpEvent {
  readonly level: "info" | "warn";
  readonly event: string;
  readonly [field: string]: string | number | boolean | null | undefined;
}

/** Options for a {@link TcpSource}. */
export interface TcpSourceOptions {
  readonly host: string;
  /** The port to listen on; 0 picks a free one, which {@link TcpSource.port} then reports. */
  readonly port: number;
  /**
   * TLS, or undefined for plain TCP. With a `ca`, every client must present a certificate it signed,
   * and a client without one fails the handshake (mutual TLS).
   */
  readonly tls: ServerTlsMaterial | undefined;
  readonly framing: Framing;
  /** The most bytes one message may hold. A longer frame closes the connection, unstored. */
  readonly maxMessageSize: number;
  /** How long a connection may go with no frame begun before it is closed, in milliseconds. */
  readonly idleTimeoutMs: number;
  /** How long a frame begun may go without a byte before the connection is closed, in milliseconds. */
  readonly stallTimeoutMs: number;
  /** The reply sent once each message is stored: fixed bytes, or a builder. Undefined sends none. */
  readonly reply?: Uint8Array | TcpReplyBuilder | undefined;
  /** Told what happens, for the engine to log: ids, counts, codes and error names only. */
  readonly onEvent?: (event: TcpEvent) => void;
}

/** One connection a {@link TcpSource} reads. */
interface Connection {
  readonly socket: Socket;
  readonly decoder: FrameDecoder;
  /** What the transform reads in `ctx.source` about each message on this connection. */
  readonly facts: Readonly<Record<string, string>>;
  /** The message being handled, so the next waits behind it. */
  tail: Promise<void>;
  /** How many messages are waiting or being handled. */
  busy: number;
  /** Set once the connection takes no more frames: it closes when those before are handled. */
  closing: boolean;
  /** Set once nothing more is stored or answered on it. */
  dead: boolean;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Listens for messages over TCP, over TLS when it is given TLS material, framed as its framing says.
 * Each message is stored through the sink first, and only then, when a reply is set, answered:
 *
 * - stored: the reply, framed as messages are, or nothing when no reply is set;
 * - not stored: no reply, and the connection closes, so the sender sends again;
 * - an empty frame: skipped, neither stored nor answered;
 * - a frame longer than `maxMessageSize`, an unreadable length prefix, or a frame that stalls: the
 *   connection closes once the messages before it are stored and answered, the frame unstored;
 * - a connection that closes or idles out mid-frame: the part frame is dropped.
 *
 * Raw framing reads one message per connection, all the bytes until the sender closes its side;
 * the reply, when set, is sent before the source closes its own. Messages on one connection are
 * handled one at a time, in order.
 *
 * @example
 * ```ts
 * const source = new TcpSource({
 *   host: "127.0.0.1",
 *   port: 7001,
 *   tls,
 *   framing: { kind: "delimiter", delimiter: Buffer.from("0a", "hex") },
 *   maxMessageSize: 1_048_576,
 *   idleTimeoutMs: 300_000,
 *   stallTimeoutMs: 30_000,
 * });
 * await source.start(sink);
 * await source.stop();
 * ```
 */
export class TcpSource implements SourceConnector {
  private readonly options: TcpSourceOptions;
  private server: Server | undefined;
  private readonly connections = new Set<Connection>();
  /** Every socket open, a TLS one still in its handshake too, so a stop closes each. */
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Set<Promise<void>>();
  private stopping = false;

  /** @param options Where to listen, TLS, framing, limits and the reply. */
  constructor(options: TcpSourceOptions) {
    this.options = options;
  }

  /** The port the source listens on, or undefined when it is not listening. */
  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address.port : undefined;
  }

  /** Starts listening, storing each message through `sink`. Rejects when the port cannot be had. */
  async start(sink: MessageSink): Promise<void> {
    const { tls: material, port, host } = this.options;
    // Half-open, so a raw sender that closes its side still gets the reply on ours.
    const server =
      material === undefined
        ? createNetServer({ allowHalfOpen: true }, (socket) => this.open(sink, socket))
        : createTlsServer({ ...serverTlsOptions(material), allowHalfOpen: true }, (socket) =>
            this.open(sink, socket),
          );
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    server.on("tlsClientError", (error: unknown) => {
      this.report("warn", "tcp-tls-refused", { code: codeOf(error) });
    });
    this.stopping = false;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (error: unknown) => {
      this.report("warn", "tcp-source-error", describeError(error));
    });
    this.server = server;
    this.report("info", "tcp-listening", { port: this.port, tls: material !== undefined });
  }

  /**
   * Stops taking messages, lets those being stored finish and be answered, then closes every
   * connection. A message that arrives meanwhile is neither stored nor answered, so its sender
   * sends it again.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const server = this.server;
    this.server = undefined;
    const closed =
      server === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(this.pending);
    for (const connection of this.connections) this.shut(connection);
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }

  private open(sink: MessageSink, socket: Socket): void {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    const { framing, maxMessageSize } = this.options;
    const subject = peerSubject(socket);
    const connection: Connection = {
      socket,
      decoder: new FrameDecoder(framing, maxMessageSize),
      facts: {
        /* v8 ignore next: a connection just accepted has the address it came from */
        ...(socket.remoteAddress === undefined ? {} : { remoteAddress: socket.remoteAddress }),
        ...(subject === undefined ? {} : { tlsPeerSubject: subject }),
      },
      tail: Promise.resolve(),
      busy: 0,
      closing: false,
      dead: false,
      timer: undefined,
    };
    this.connections.add(connection);
    this.arm(connection);
    socket.on("data", (chunk: Buffer) => {
      this.take(sink, connection, connection.decoder.push(chunk));
      this.arm(connection);
    });
    socket.on("end", () => {
      // Closing already, it takes nothing more: what it held was reported as it closed.
      if (connection.closing) return;
      const { events, cut } = connection.decoder.end();
      this.take(sink, connection, events);
      if (cut > 0) this.report("warn", "tcp-partial-frame", { bytes: cut });
      this.close(connection);
    });
    // The close that follows says what is lost; a reset's own code is all the error adds.
    socket.on("error", (error: unknown) => {
      this.report("info", "tcp-connection-error", { code: codeOf(error) });
    });
    socket.on("close", () => {
      clearTimeout(connection.timer);
      this.connections.delete(connection);
      connection.dead = true;
      // Ended cleanly, the decoder has handed over what it held; otherwise a frame was cut off.
      const cut = connection.decoder.pending;
      if (cut > 0 && !connection.closing) this.report("warn", "tcp-partial-frame", { bytes: cut });
    });
  }

  /** Handles what the decoder found, in order. */
  private take(
    sink: MessageSink,
    connection: Connection,
    events: readonly ReturnType<FrameDecoder["push"]>[number][],
  ): void {
    for (const event of events) {
      switch (event.type) {
        case "frame":
          this.queue(sink, connection, event.body);
          break;
        case "empty":
          this.report("info", "tcp-empty-frame", {});
          break;
        case "discarded":
          this.report("warn", "tcp-discarded-bytes", { bytes: event.bytes });
          break;
        case "oversize":
          this.report("warn", "tcp-oversize", { maxMessageSize: this.options.maxMessageSize });
          this.close(connection);
          break;
        case "bad-length":
          this.report("warn", "tcp-bad-length", {});
          this.close(connection);
          break;
      }
    }
  }

  private queue(sink: MessageSink, connection: Connection, body: Buffer): void {
    if (this.stopping || connection.closing) return;
    connection.busy += 1;
    const task = connection.tail.then(() => this.handle(sink, connection, body));
    connection.tail = task;
    this.pending.add(task);
    void task.then(() => {
      this.pending.delete(task);
      connection.busy -= 1;
      this.arm(connection);
    });
  }

  /** Stores one message and answers it. Never rejects: whatever goes wrong is reported. */
  private async handle(sink: MessageSink, connection: Connection, body: Buffer): Promise<void> {
    if (connection.dead) return;
    let messageId: number;
    try {
      messageId = await sink.receive(body, { source: connection.facts });
    } catch (error) {
      this.report("warn", "tcp-store-failed", describeError(error));
      this.shut(connection);
      return;
    }
    const { reply, framing } = this.options;
    if (reply === undefined) return;
    let bytes: Uint8Array;
    try {
      const built: unknown = typeof reply === "function" ? await reply({ messageId }) : reply;
      if (typeof built === "string") bytes = Buffer.from(built, "utf8");
      else if (built instanceof Uint8Array) bytes = built;
      else throw new TypeError("the reply builder returned neither bytes nor a string");
    } catch (error) {
      this.report("warn", "tcp-reply-failed", {
        message: messageId,
        name: describeError(error).name,
      });
      this.shut(connection);
      return;
    }
    let frame: Buffer;
    try {
      frame = encodeFrame(framing, bytes);
    } catch (error) {
      // The reply holds the delimiter or end bytes, or is too long for the prefix.
      this.report("warn", "tcp-reply-unsendable", {
        message: messageId,
        code: (error as TcpFramingError).code,
      });
      this.shut(connection);
      return;
    }
    if (!connection.socket.destroyed) connection.socket.write(frame);
  }

  /**
   * Sets the connection's one timer: the stall timeout while a frame is part read, otherwise the
   * idle timeout. An idle connection whose messages are still being handled is not idle.
   */
  private arm(connection: Connection): void {
    clearTimeout(connection.timer);
    connection.timer = undefined;
    if (connection.closing || connection.dead) return;
    const stalled = connection.decoder.midFrame;
    const { stallTimeoutMs, idleTimeoutMs } = this.options;
    connection.timer = setTimeout(
      () => {
        if (!stalled && connection.busy > 0) {
          this.arm(connection);
          return;
        }
        this.report(stalled ? "warn" : "info", stalled ? "tcp-stalled" : "tcp-idle", {});
        this.close(connection);
      },
      stalled ? stallTimeoutMs : idleTimeoutMs,
    );
  }

  /**
   * Takes no more frames on the connection, and closes it once the messages before are handled: its
   * write side ends, so a reply already written is still sent.
   */
  private close(connection: Connection): void {
    connection.closing = true;
    clearTimeout(connection.timer);
    // Ends the write side once the reply is written, without waiting on a peer that never closes.
    void connection.tail.then(() => connection.socket.destroySoon());
  }

  /** Closes the connection at once: nothing more on it is stored or answered. */
  private shut(connection: Connection): void {
    connection.closing = true;
    connection.dead = true;
    clearTimeout(connection.timer);
    connection.socket.destroy();
  }

  private report(
    level: TcpEvent["level"],
    event: string,
    fields: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): void {
    this.options.onEvent?.({ ...fields, level, event });
  }
}

/** The common name in the subject of the certificate a TLS client presented, when it did. */
function peerSubject(socket: Socket): string | undefined {
  const tls = socket as Partial<TLSSocket>;
  if (typeof tls.getPeerCertificate !== "function") return undefined;
  const name: unknown = tls.getPeerCertificate().subject?.CN;
  return typeof name === "string" ? name : undefined;
}

/** Options for a {@link TcpDestination}. */
export interface TcpDestinationOptions {
  readonly host: string;
  readonly port: number;
  /**
   * TLS, or undefined for plain TCP. The server's certificate is always verified, against `ca` when
   * set and Node's built-in roots otherwise; `cert` and `key` present a client certificate.
   */
  readonly tls: ClientTlsMaterial | undefined;
  readonly framing: Framing;
  /** The most bytes a reply may hold. */
  readonly maxMessageSize: number;
  /** How long to wait to connect, and then for the send and its reply, in milliseconds. */
  readonly timeoutMs: number;
  /** True reads one framed reply for each output. */
  readonly expectReply: boolean;
  /** Judges each reply; without one, any reply means delivered. */
  readonly replyCheck?: TcpReplyCheck | undefined;
}

/**
 * A tcp delivery that did not complete and is worth trying again: no connection, no reply in time,
 * a reply that could not be read, or a reply check that said `retry` or failed. `code` says which; it
 * is stable and holds no message content.
 *
 * @example
 * ```ts
 * throw new TcpDeliveryError("REPLY_TIMEOUT");
 * ```
 */
export class TcpDeliveryError extends Error {
  /** A stable code, such as `REPLY_TIMEOUT`, `REPLY_RETRY` or `ECONNREFUSED`. */
  readonly code: string;

  /** @param code A stable code. Never message content. */
  constructor(code: string) {
    super(`the tcp delivery did not complete (${code})`);
    this.name = "TcpDeliveryError";
    this.code = code;
  }
}

/**
 * Sends each output over TCP, over TLS when it is given TLS material, as one frame on a connection
 * of its own, so a late reply can never answer the wrong output. Raw framing marks the end of the
 * output by closing the write side. Without `expectReply`, an output is delivered once it is written;
 * with it, the destination reads one framed reply, and any reply means delivered unless the reply
 * check says otherwise:
 *
 * - `delivered`: delivered;
 * - `rejected`: a {@link DeliveryRejected}, so the engine marks the delivery failed and moves on;
 * - `retry`, no reply in time, a reply too long or unreadable, a connection that fails or closes
 *   first, or a check that throws: a {@link TcpDeliveryError}, which the engine retries.
 *
 * An output that holds the delimiter or the end bytes, or is too long for the length prefix, can
 * never be sent, so it is a `DeliveryRejected` too.
 *
 * @example
 * ```ts
 * const destination = new TcpDestination({
 *   host: "lab.example.test",
 *   port: 7002,
 *   tls,
 *   framing: { kind: "lengthPrefix", size: 4, endian: "big", inclusive: false },
 *   maxMessageSize: 65_536,
 *   timeoutMs: 10_000,
 *   expectReply: true,
 * });
 * await destination.deliver({ messageId: 1, seq: 0, body });
 * ```
 */
export class TcpDestination implements DestinationConnector {
  private readonly options: TcpDestinationOptions;

  /** @param options Where to send, TLS, framing, and how long to wait. */
  constructor(options: TcpDestinationOptions) {
    this.options = options;
  }

  /** Sends one output, and with `expectReply` reads and judges its reply. */
  async deliver(message: OutgoingMessage): Promise<void> {
    let frame: Buffer;
    try {
      frame = encodeFrame(this.options.framing, message.body);
    } catch (error) {
      throw new DeliveryRejected((error as TcpFramingError).code);
    }
    const socket = await this.connect(message.signal);
    let reply: Buffer | undefined;
    try {
      reply = await this.exchange(socket, frame, message.signal);
    } finally {
      socket.destroy();
    }
    if (reply !== undefined) await this.judge(reply, message);
  }

  /** Nothing is kept open between deliveries. */
  stop(): Promise<void> {
    return Promise.resolve();
  }

  private connect(signal: AbortSignal | undefined): Promise<Socket> {
    const { host, port, tls, timeoutMs } = this.options;
    // Half-open, so a raw output's end can be sent and the reply still read. Node's TLS client takes
    // allowHalfOpen as its plain one does, though its types leave it out.
    const half = { host, port, allowHalfOpen: true };
    const secure: ConnectionOptions =
      tls === undefined ? half : { ...half, ...clientTlsOptions(tls) };
    const socket = tls === undefined ? netConnect(half) : tlsConnect(secure);
    return new Promise((resolve, reject) => {
      const settle = (error: TcpDeliveryError | undefined): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        socket.off("error", failed);
        if (error === undefined) {
          resolve(socket);
          return;
        }
        socket.destroy();
        reject(error);
      };
      const failed = (error: unknown): void => {
        settle(new TcpDeliveryError(codeOf(error) ?? "TCP_CONNECTION"));
      };
      const aborted = (): void => settle(new TcpDeliveryError("ABORTED"));
      const timer = setTimeout(() => settle(new TcpDeliveryError("CONNECT_TIMEOUT")), timeoutMs);
      socket.once("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted === true) aborted();
      socket.once(tls === undefined ? "connect" : "secureConnect", () => settle(undefined));
    });
  }

  /** Writes the frame and, with `expectReply`, reads one framed reply. */
  private exchange(
    socket: Socket,
    frame: Buffer,
    signal: AbortSignal | undefined,
  ): Promise<Buffer | undefined> {
    const { framing, maxMessageSize, timeoutMs, expectReply } = this.options;
    return new Promise((resolve, reject) => {
      let settled = false;
      // The first outcome stands: what the socket says after it is dropped, as it is destroyed next.
      const settle = (outcome: Buffer | undefined | TcpDeliveryError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        if (outcome instanceof TcpDeliveryError) reject(outcome);
        else resolve(outcome);
      };
      const fail = (code: string): void => settle(new TcpDeliveryError(code));
      const aborted = (): void => fail("ABORTED");
      const timer = setTimeout(
        () => fail(expectReply ? "REPLY_TIMEOUT" : "WRITE_TIMEOUT"),
        timeoutMs,
      );
      signal?.addEventListener("abort", aborted, { once: true });
      socket.on("error", (error: unknown) => fail(codeOf(error) ?? "TCP_CONNECTION"));
      if (!expectReply) {
        // Delivered once every byte is handed to the system to send.
        socket.end(frame, () => settle(undefined));
        return;
      }
      const decoder = new FrameDecoder(framing, maxMessageSize);
      const read = (events: ReturnType<FrameDecoder["push"]>): boolean => {
        for (const event of events) {
          if (event.type === "frame") settle(event.body);
          else if (event.type === "empty") settle(Buffer.alloc(0));
          else if (event.type === "oversize") fail("REPLY_OVERSIZE");
          else if (event.type === "bad-length") fail("REPLY_BAD_LENGTH");
          else continue;
          return true;
        }
        return false;
      };
      socket.on("data", (chunk: Buffer) => {
        read(decoder.push(chunk));
      });
      socket.on("end", () => {
        if (!read(decoder.end().events)) fail("CONNECTION_CLOSED");
      });
      if (framing.kind === "raw") socket.end(frame);
      else socket.write(frame);
    });
  }

  private async judge(body: Buffer, message: OutgoingMessage): Promise<void> {
    const { replyCheck } = this.options;
    if (replyCheck === undefined) return;
    let verdict: unknown;
    try {
      verdict = await replyCheck({ body, messageId: message.messageId, seq: message.seq });
    } catch {
      throw new TcpDeliveryError("REPLY_CHECK_FAILED");
    }
    switch (verdict) {
      case "delivered":
        return;
      case "rejected":
        throw new DeliveryRejected("REPLY_REJECTED");
      case "retry":
        throw new TcpDeliveryError("REPLY_RETRY");
      default:
        throw new TcpDeliveryError("REPLY_CHECK_FAILED");
    }
  }
}

/** A string property of an error, such as its `code` or `name`; never its text. */
function textOf(error: unknown, key: "code" | "name"): string | undefined {
  const value = (error as Partial<Record<typeof key, unknown>> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function codeOf(error: unknown): string | undefined {
  return textOf(error, "code");
}

/** An error's name and code, for a log line. */
function describeError(error: unknown): { name: string | undefined; code: string | undefined } {
  return { name: textOf(error, "name"), code: codeOf(error) };
}
