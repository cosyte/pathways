import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { TLSSocket } from "node:tls";

import { Hl7ParseError, interpretAck, parseHL7, type Hl7Message } from "@cosyte/hl7";
import {
  Connection,
  createClient,
  createServer,
  encodeFrame,
  MllpConnectionError,
  MllpFramingError,
  MllpTimeoutError,
  NetTransport,
  TlsTransport,
  type ConnectionRejectedEvent,
  type MessageMeta,
  type MllpClient,
  type MllpServer,
} from "@cosyte/mllp";

import { DEFAULT_DRAIN_TIMEOUT_MS, type OnStoreFailure } from "../config/schema.js";
import { defaultAckBuilder, type AckBuilder, type AckRequest } from "./ack.js";
import {
  DEFAULT_MLLP_CONNECT_TIMEOUT_MS,
  dial,
  sendOnce,
  type MllpDialError,
  type MllpAddress,
} from "./mllp-dial.js";
import {
  asClientTls,
  mllpClientTlsOptions,
  mllpServerTlsOptions,
  type MllpClientTlsMaterial,
  type MllpServerTlsMaterial,
} from "./mllp-tls.js";
import {
  DeliveryRejected,
  PassFailed,
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
  type SourceConnector,
} from "./types.js";

/**
 * Something an MLLP source reports for the engine to log: an event name, a level, and fields that
 * are ids, counts, codes and error names only. Never message content, error text or key material.
 */
export interface MllpEvent {
  readonly level: "info" | "warn";
  readonly event: string;
  readonly [field: string]: string | number | boolean | null | undefined;
}

/** The header of an inbound message, read: usable when `problem` is `undefined`. */
export interface HeaderReading {
  /** The parsed MSH segment, or `undefined` when there is none that parses. */
  readonly header: Hl7Message | undefined;
  /**
   * Why the header is not usable, as a stable code: a `@cosyte/hl7` parse code (such as
   * `NO_MSH_SEGMENT`), `MULTIPLE_MESSAGES` or `NO_CONTROL_ID`. `undefined` when it is usable.
   */
  readonly problem: string | undefined;
  /** MSH-10 as it arrived, when the header is usable. */
  readonly controlId: string | undefined;
  /** Who sent the message (MSH-3 and MSH-4) and its MSH-10, when the header is usable. */
  readonly duplicateKey: string | undefined;
}

const CR = 0x0d;
const LF = 0x0a;
/** The MLLP start and end bytes, which `@cosyte/hl7` removes wherever they stand before it splits segments. */
const VT = 0x0b;
const FS = 0x1c;
/** The segment ids that open a message (MSH) or a batch (FHS, BHS), as bytes, in upper case. */
const M = 0x4d;
const S = 0x53;
const H = 0x48;
const F = 0x46;
const B = 0x42;

/**
 * Reads the header of an HL7 v2 message: parses its first segment, which must be an MSH with an
 * MSH-10 control ID, and checks that no later segment opens another message or a batch
 * (`MULTIPLE_MESSAGES`): MSH, FHS or BHS in any case, after any CR or LF, as `@cosyte/hl7` would
 * read it. It reads nothing past the header except the first three bytes of each segment.
 *
 * @example
 * ```ts
 * const reading = readHeader(payload);
 * if (reading.problem === undefined) console.log(reading.header?.meta.type);
 * ```
 */
export function readHeader(payload: Uint8Array): HeaderReading {
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  let start = 0;
  while (start < bytes.length && isBreak(bytes[start])) start += 1;
  let end = start;
  while (end < bytes.length && !isBreak(bytes[end])) end += 1;
  const unusable = (header: Hl7Message | undefined, problem: string): HeaderReading => ({
    header,
    problem,
    controlId: undefined,
    duplicateKey: undefined,
  });

  let header: Hl7Message;
  try {
    header = parseHL7(bytes.subarray(start, end));
  } catch (error) {
    return unusable(undefined, error instanceof Hl7ParseError ? error.code : "UNREADABLE_HEADER");
  }
  if (opensLater(bytes, end)) return unusable(header, "MULTIPLE_MESSAGES");
  const msh = header.part("MSH");
  /* v8 ignore next -- the parse found an MSH, and a field it lacks reads as empty text */
  const controlId = msh?.field(10)?.text ?? "";
  if (controlId.trim() === "") return unusable(header, "NO_CONTROL_ID");
  const sender = [3, 4].map((field) => msh?.field(field)?.text).join("|");
  return { header, problem: undefined, controlId, duplicateKey: `${sender}\u0000${controlId}` };
}

function isBreak(byte: number | undefined): boolean {
  return byte === CR || byte === LF;
}

/**
 * Whether an HL7 v2 body holds a second message: its first segment is not a batch header (FHS or
 * BHS), and a later segment opens a message or a batch. Read the way `@cosyte/hl7` reads segments,
 * so every body it would parse as one message with two headers is caught: a segment starts after
 * any CR or LF (CR, LF, CR LF, mixed, blank lines between), the MLLP start and end bytes count for
 * nothing, and a segment id is matched in any case, as the parser upper-cases it. A body that opens
 * with FHS or BHS is a batch, which is not one message either: the parser refuses it with its own
 * code (`NO_MSH_SEGMENT`).
 *
 * @example
 * ```ts
 * holdsSecondMessage(Buffer.from("MSH|^~\\&|A\rPID|1\r")); // false
 * holdsSecondMessage(Buffer.from("MSH|^~\\&|A\rmsh|^~\\&|B\r")); // true
 * ```
 */
export function holdsSecondMessage(payload: Uint8Array): boolean {
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  let start = 0;
  while (start < bytes.length && (isBreak(bytes[start]) || isFraming(bytes[start]))) start += 1;
  if (openerAt(bytes, start) === "batch") return false;
  let end = start;
  while (end < bytes.length && !isBreak(bytes[end])) end += 1;
  return opensLater(bytes, end);
}

/** Whether a segment after `from`, the end of the first segment, opens a message or a batch. */
function opensLater(bytes: Buffer, from: number): boolean {
  for (let at = from; at < bytes.length; at += 1) {
    if (isBreak(bytes[at]) && openerAt(bytes, at + 1) !== undefined) return true;
  }
  return false;
}

/**
 * What the segment starting at `at` opens, matched without regard to case and skipping the MLLP
 * start and end bytes: `message` for MSH, `batch` for FHS or BHS, `undefined` for anything else.
 */
function openerAt(bytes: Buffer, at: number): "message" | "batch" | undefined {
  const a = bytes[at];
  const b = bytes[at + 1];
  const c = bytes[at + 2];
  // The common case, three bytes with no MLLP byte among them, reads them in place.
  if (!isFraming(a) && !isFraming(b) && !isFraming(c)) return opener(a, b, c);
  const id: number[] = [];
  for (let next = at; id.length < 3 && next < bytes.length; next += 1) {
    const byte = bytes[next] as number;
    if (!isFraming(byte)) id.push(byte);
  }
  return opener(id[0], id[1], id[2]);
}

/** What a segment whose id starts with these three bytes opens, matched without regard to case. */
function opener(
  a: number | undefined,
  b: number | undefined,
  c: number | undefined,
): "message" | "batch" | undefined {
  const first = upper(a);
  const second = upper(b);
  const third = upper(c);
  if (first === M && second === S && third === H) return "message";
  if (second === H && third === S && (first === F || first === B)) return "batch";
  return undefined;
}

/** An ASCII letter in upper case; any other byte as it is, and `undefined` past the end. */
function upper(byte: number | undefined): number | undefined {
  return byte !== undefined && byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
}

function isFraming(byte: number | undefined): boolean {
  return byte === VT || byte === FS;
}

/** The most connections an MLLP source holds at once when its block sets no `maxConnections`. */
export const DEFAULT_MLLP_MAX_CONNECTIONS = 100;

/** The largest message an MLLP source takes when its block sets no `maxMessageSize`: 4 MiB. */
export const DEFAULT_MLLP_MAX_MESSAGE_SIZE = 4 * 1_024 * 1_024;

/** The longest an MLLP source that dials out waits before it dials again: 5 minutes. */
const MAX_REDIAL_WAIT_MS = 300_000;

/**
 * How long an MLLP source that dials out waits before dialling again after `failures` failures in a
 * row, when its sink does not say (the engine's sink does, through `sourceDown`): 1 second, doubling
 * with each failure, to 5 minutes. A connection that opens starts the count again.
 *
 * @example
 * ```ts
 * redialWait(1); // 1000
 * redialWait(3); // 4000
 * ```
 */
export function redialWait(failures: number): number {
  return Math.min(1_000 * 2 ** Math.min(failures - 1, 20), MAX_REDIAL_WAIT_MS);
}

/** Options for an {@link MllpSource}. */
export interface MllpSourceOptions {
  /** The address to listen on. Unused when the source dials out with `connect`. */
  readonly host: string;
  /**
   * The port to listen on; 0 picks a free one, which {@link MllpSource.port} then reports. Unused when
   * the source dials out with `connect`.
   */
  readonly port: number;
  /**
   * TLS, or undefined for plaintext MLLP. With a `ca`, every client must present a certificate it
   * signed, and a client without one fails the handshake (mutual TLS).
   *
   * On a connection the source opens itself (`connect`, `replyTo`) the source is the TLS client: the
   * peer's certificate is verified against `ca`, or Node's built-in roots when it is unset, and the
   * certificate and key (or pfx), when set, are presented as a client certificate.
   */
  readonly tls: MllpServerTlsMaterial | undefined;
  /**
   * Dial out to this sender and read messages from that connection, in place of listening. Each is
   * stored and then answered on that connection, as on a connection a sender opened. A connection that
   * fails or drops is dialled again, after the wait the sink's `sourceDown` gives (or
   * {@link redialWait} when it has none).
   */
  readonly connect?: MllpAddress | undefined;
  /**
   * Send each ACK on a new connection to this address, in place of the connection the message came
   * on. It comes from the channel's configuration only, never from the message. A reply that cannot be
   * sent is logged as `mllp-reply-failed` with the message id and a code; the message stays stored.
   */
  readonly replyTo?: MllpAddress | undefined;
  /**
   * How long a connection the source opens itself (`connect`, `replyTo`) may take to open, its TLS
   * handshake included, in milliseconds; a `replyTo` connection then has as long again to write its
   * ACK. Defaults to {@link DEFAULT_MLLP_CONNECT_TIMEOUT_MS}.
   */
  readonly connectTimeoutMs?: number | undefined;
  /**
   * The most connections held at once; one that arrives over it is closed at accept, before any byte
   * is read, and counted in {@link MllpSource.refusedConnections}. Defaults to
   * {@link DEFAULT_MLLP_MAX_CONNECTIONS}.
   */
  readonly maxConnections?: number | undefined;
  /**
   * How long a connection may go without a whole message, in milliseconds, before it is closed: an
   * idle connection, and one that stalls partway through a frame. Undefined for no limit.
   */
  readonly receiveTimeoutMs?: number | undefined;
  /**
   * How old a connection may grow, in milliseconds: once it is older, it is closed after the
   * message it brings has been stored and answered, so the sender connects again (through a load
   * balancer, to any node behind it). Undefined for no limit.
   */
  readonly maxConnectionAgeMs?: number | undefined;
  /**
   * How long {@link MllpSource.stop} lets each connection finish the message it is handling and
   * send its ACK, in milliseconds, before it cuts off what is left. Defaults to
   * {@link DEFAULT_DRAIN_TIMEOUT_MS}.
   */
  readonly drainTimeoutMs?: number | undefined;
  /**
   * The largest message taken, in bytes. A frame that grows past it closes the connection, and
   * nothing of it is stored. Defaults to {@link DEFAULT_MLLP_MAX_MESSAGE_SIZE}.
   */
  readonly maxMessageSize?: number | undefined;
  /**
   * `false` closes each connection once the ACKs of the messages it brought have been written out,
   * for a sender that opens one connection per message. Defaults to `true`.
   */
  readonly keepOpen?: boolean | undefined;
  /** What to do when a message cannot be stored. Defaults to `close`. */
  readonly onStoreFailure?: OnStoreFailure;
  /** Builds each ACK. Defaults to {@link defaultAckBuilder}. */
  readonly ackBuilder?: AckBuilder;
  /** Told what happens, for the engine to log: ids, codes and error names only. */
  readonly onEvent?: (event: MllpEvent) => void;
}

interface ConnectionState {
  /** The message being handled on this connection, so the next waits behind it. */
  tail: Promise<void>;
  /** Set once this source closes the connection: nothing queued behind is stored or answered. */
  closed: boolean;
  /** How many messages on this connection are queued or being handled. */
  queued: number;
  /** What the transform reads in `ctx.source` about each message on this connection. */
  readonly facts: Readonly<Record<string, string>>;
}

/** The most TLS peers a source remembers for connections that have sent nothing yet. */
const MAX_WAITING_PEERS = 1_024;

/**
 * Listens for HL7 v2 messages over MLLP, over TLS when it is given TLS material. Each message is
 * stored through the sink first, and only then acknowledged:
 *
 * - stored: `AA`;
 * - not stored: by default no ACK, and the connection closes so the sender sends again; or `AE` or
 *   `AR`, as `onStoreFailure` says;
 * - on a channel that stores nothing, refused for good (a {@link PassFailed} that is permanent):
 *   `AE`;
 * - no usable MSH header (none, no MSH-10, or more than one message in the frame): stored, marked
 *   failed, and answered `AR`;
 * - damaged in transit (the framing discarded bytes of it): stored, marked failed, and answered
 *   `AE`, so the sender sends it again.
 *
 * Messages on one connection are handled one at a time, in order. A message whose sender (MSH-3 and
 * MSH-4) and MSH-10 repeat an earlier one is passed on with a duplicate key, for the engine to flag.
 *
 * @example
 * ```ts
 * const source = new MllpSource({ host: "127.0.0.1", port: 2575, tls });
 * await source.start(sink);
 * await source.stop();
 * ```
 */
export class MllpSource implements SourceConnector {
  private readonly options: MllpSourceOptions;
  private server: MllpServer | undefined;
  private readonly states = new WeakMap<Connection, ConnectionState>();
  private readonly pending = new Set<Promise<void>>();
  /**
   * The common name in each TLS client certificate, by connection id, from the moment the
   * connection opens until its first message: the connection's state takes it from there.
   */
  private readonly peers = new Map<string, string>();
  private stopping = false;
  private refused = 0;
  /** Aborted at stop, to end the dial loop of a source that dials out. */
  private dialling: AbortController | undefined;
  /** The dial loop of a source that dials out, settled once it has ended. */
  private dialLoop: Promise<void> | undefined;

  /** @param options Where to listen, TLS, and how to answer. */
  constructor(options: MllpSourceOptions) {
    this.options = options;
  }

  /**
   * How many connections this source has closed at accept because it already held
   * `maxConnections`, since it was made. A count only: never who connected.
   */
  get refusedConnections(): number {
    return this.refused;
  }

  /** The port the source listens on, or undefined when it is not listening. */
  get port(): number | undefined {
    return this.server?.getStats().port ?? undefined;
  }

  /**
   * Starts listening, storing each message through `sink`; rejects when the port cannot be had. A
   * source with `connect` starts dialling instead, and resolves at once: until a connection opens,
   * it tells the sink through `sourceDown`.
   */
  async start(sink: MessageSink): Promise<void> {
    const { tls: material, port, host, receiveTimeoutMs, connect } = this.options;
    this.stopping = false;
    if (connect !== undefined) {
      const dialling = new AbortController();
      this.dialling = dialling;
      this.dialLoop = this.redial(sink, connect, dialling.signal);
      return;
    }
    const server = createServer({
      onMessage: (payload, meta, conn) => {
        this.accept(sink, payload, meta, conn);
      },
      // The host is the operator's own setting, so binding every interface is theirs to choose.
      allowWildcardBind: true,
      maxConnections: this.options.maxConnections ?? DEFAULT_MLLP_MAX_CONNECTIONS,
      framing: { maxFrameSizeBytes: this.options.maxMessageSize ?? DEFAULT_MLLP_MAX_MESSAGE_SIZE },
      // The library's idle timer restarts only when a whole message arrives, so it also ends a
      // connection that sent part of a frame and stalled.
      ...(receiveTimeoutMs === undefined ? {} : { deadPeerTimeoutMs: receiveTimeoutMs }),
      ...(material === undefined ? {} : { tls: mllpServerTlsOptions(material) }),
    });
    server.on("error", (error: unknown) => {
      this.report("warn", "mllp-source-error", describeError(error));
    });
    server.on("tlsClientError", (event: { readonly code: string | null }) => {
      this.report("warn", "mllp-tls-refused", { code: event.code });
    });
    server.on(
      "connection",
      (event: {
        readonly connectionId: string;
        readonly peerCertificate: { readonly subjectCN: string | null } | null;
      }) => {
        const subject = event.peerCertificate?.subjectCN;
        if (typeof subject !== "string") return;
        // A connection that never sends a message would leave its entry, so the map is bounded.
        rememberPeer(this.peers, event.connectionId, subject, MAX_WAITING_PEERS);
      },
    );
    server.on("connectionRejected", (event: ConnectionRejectedEvent) => {
      this.refused += 1;
      // The cap and the code only: who connected stays out of the log.
      this.report("warn", "mllp-connection-refused", {
        code: event.code,
        maxConnections: event.maxConnections,
      });
    });
    server.on("securityWarning", (warning: { readonly code: string }) => {
      this.report("warn", "mllp-security-warning", { code: warning.code });
    });
    await server.listen(port, host);
    this.server = server;
    this.report("info", "mllp-listening", { port: this.port, tls: material !== undefined });
  }

  /**
   * Stops listening at once, then closes each connection: an idle one at once, and a busy one once
   * the message it is handling has been stored and answered. A message that arrives meanwhile is
   * neither stored nor answered, so its sender sends it again. A connection still busy at
   * `drainTimeoutMs` is cut off: a message not yet answered then gets no ACK, and its sender sends
   * it again.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.peers.clear();
    const timeoutMs = this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const server = this.server;
    this.server = undefined;
    // A dialled connection closes the same way: its close waits for its own work, cut off at the
    // timeout (the abort handler in `read`).
    this.dialling?.abort();
    // Each connection's close waits for its own work (`beforeClose`, set when it brings its first
    // message), and the server cuts off whatever is still open at the timeout.
    await server?.close({ drainTimeoutMs: timeoutMs });
    // A store cut off at the timeout may still be under way: it is waited for no longer than that.
    const waited = new AbortController();
    await Promise.race([
      Promise.all(this.pending),
      sleep(timeoutMs, undefined, { signal: waited.signal }).catch(() => undefined),
    ]);
    waited.abort();
    await this.dialLoop;
    this.dialLoop = undefined;
  }

  /**
   * Dials `address` until `signal` aborts: reads each connection until it ends, then waits as the
   * sink says (or {@link redialWait}) and dials again. Never rejects.
   */
  private async redial(
    sink: MessageSink,
    address: MllpAddress,
    signal: AbortSignal,
  ): Promise<void> {
    const { tls: material, connectTimeoutMs } = this.options;
    const tls = material === undefined ? undefined : asClientTls(material);
    let failures = 0;
    while (!signal.aborted) {
      let code: string;
      try {
        const socket = await dial(
          address,
          tls,
          connectTimeoutMs ?? DEFAULT_MLLP_CONNECT_TIMEOUT_MS,
          signal,
        );
        failures = 0;
        code = await this.read(sink, socket, tls !== undefined, signal);
      } catch (error) {
        code = (error as MllpDialError).code;
      }
      if (signal.aborted) return;
      failures += 1;
      const wait = sink.sourceDown?.(code) ?? redialWait(failures);
      await sleep(wait, undefined, { signal }).catch(() => undefined);
    }
  }

  /**
   * Reads messages from a connection this source dialled, storing and answering each as on one a
   * sender opened, and resolves with a code for why it ended once it closes.
   */
  private read(
    sink: MessageSink,
    socket: Socket,
    tls: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    const transport = tls ? new TlsTransport(socket as TLSSocket) : new NetTransport(socket);
    const conn = new Connection({
      transport,
      framing: { maxFrameSizeBytes: this.options.maxMessageSize ?? DEFAULT_MLLP_MAX_MESSAGE_SIZE },
    });
    let code = "MLLP_CONNECTION_CLOSED";
    conn.on("error", (error: unknown) => {
      code = describeError(error).code ?? code;
    });
    conn.on("message", (event: MessageMeta & { readonly payload: Buffer }) => {
      this.accept(sink, event.payload, event, conn);
    });
    const { receiveTimeoutMs } = this.options;
    let idle: NodeJS.Timeout | undefined;
    const arm = (): void => {
      if (receiveTimeoutMs === undefined) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        code = "MLLP_RECEIVE_TIMEOUT";
        conn.destroy();
      }, receiveTimeoutMs);
    };
    conn.on("message", arm);
    arm();
    const closed = new Promise<string>((resolve) => {
      socket.once("close", () => {
        clearTimeout(idle);
        signal.removeEventListener("abort", onAbort);
        resolve(code);
      });
    });
    // A stop closes the connection once the message it is handling has been stored and answered
    // (`beforeClose`), and cuts it off at `drainTimeoutMs`. One that came as the stop began is
    // closed at once.
    const onAbort = (): void => {
      void conn.close({
        drainTimeoutMs: this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      });
    };
    /* v8 ignore next: a stop that lands between the connection opening and this line */
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    /* v8 ignore next: a connected socket has its peer's address and port */
    conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null);
    sink.sourceUp?.();
    this.report("info", "mllp-connected", { tls });
    return closed;
  }

  private accept(sink: MessageSink, payload: Buffer, meta: MessageMeta, conn: Connection): void {
    if (this.stopping) return;
    let state = this.states.get(conn);
    if (state === undefined) {
      const { remoteAddress } = conn.getStats();
      const subject = this.peers.get(meta.connectionId);
      this.peers.delete(meta.connectionId);
      state = {
        tail: Promise.resolve(),
        closed: false,
        queued: 0,
        facts: {
          /* v8 ignore next: a connection that delivered a message has the address it came from */
          ...(remoteAddress === null ? {} : { remoteAddress }),
          ...(subject === undefined ? {} : { tlsPeerSubject: subject }),
        },
      };
      this.states.set(conn, state);
      // A close (the source stopping) waits for the message this connection is handling to be
      // stored and answered; the connection's own drain timeout cuts that wait off.
      const waitFor = state;
      conn.beforeClose = () => waitFor.tail;
    }
    const current = state;
    current.queued += 1;
    const task = current.tail
      .then(() => this.handle(sink, payload, meta, conn, current))
      .then(() => {
        current.queued -= 1;
        if (this.options.keepOpen === false && current.queued === 0) finish(conn, current);
        else if (this.aged(conn)) {
          this.report("info", "mllp-connection-aged", {
            maxConnectionAgeMs: this.options.maxConnectionAgeMs,
          });
          finish(conn, current);
        }
      });
    current.tail = task;
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }

  /** Whether `conn` is older than `maxConnectionAgeMs`, when one is set. */
  private aged(conn: Connection): boolean {
    const { maxConnectionAgeMs } = this.options;
    if (maxConnectionAgeMs === undefined) return false;
    const connectedAt = conn.getStats().connectedAt;
    /* v8 ignore next: a connection that brought a message has connected */
    if (connectedAt === null) return false;
    return Date.now() - connectedAt.getTime() >= maxConnectionAgeMs;
  }

  /** Stores one message and answers it. Never rejects: whatever goes wrong is reported. */
  private async handle(
    sink: MessageSink,
    payload: Buffer,
    meta: MessageMeta,
    conn: Connection,
    state: ConnectionState,
  ): Promise<void> {
    if (state.closed) return;
    try {
      const reading = readHeader(payload);
      const damaged = meta.warnings.some((warning) => warning.code === "MLLP_TRAILING_BYTES");
      const problem = damaged ? "MLLP_TRAILING_BYTES" : reading.problem;
      const header = reading.header;

      let messageId: number;
      try {
        messageId = await sink.receive(
          payload,
          problem === undefined
            ? { duplicateKey: reading.duplicateKey, source: state.facts }
            : { failure: `inbound: ${problem}` },
        );
      } catch (error) {
        if (error instanceof PassFailed && error.permanent) {
          // A channel that stores nothing could not pass it on, and sending it again will not help.
          this.report("warn", "mllp-pass-rejected", { code: error.code });
          await this.answer(conn, state, {
            code: "AE",
            reason: "rejected",
            problem,
            header,
            messageId: undefined,
          });
          return;
        }
        const onStoreFailure = this.options.onStoreFailure ?? "close";
        this.report("warn", "mllp-store-failed", { ...describeError(error), onStoreFailure });
        if (onStoreFailure === "close") {
          close(conn, state);
          return;
        }
        const request: AckRequest = {
          code: onStoreFailure,
          reason: "store-failed",
          problem,
          header,
          messageId: undefined,
        };
        await this.answer(conn, state, request);
        return;
      }

      if (problem !== undefined) {
        this.report("warn", "mllp-unreadable", { message: messageId, problem });
      }
      const request: AckRequest =
        problem === undefined
          ? { code: "AA", reason: "stored", problem, header, messageId }
          : { code: damaged ? "AE" : "AR", reason: "unreadable", problem, header, messageId };
      await this.answer(conn, state, request);
    } catch (error) {
      // Unreachable by design; if it happens, the sender gets no ACK and sends again.
      this.report("warn", "mllp-source-failed", describeError(error));
      close(conn, state);
    }
  }

  private async answer(
    conn: Connection,
    state: ConnectionState,
    request: AckRequest,
  ): Promise<void> {
    let ack: Uint8Array;
    try {
      ack = await (this.options.ackBuilder ?? defaultAckBuilder)(request);
    } catch (error) {
      this.report("warn", "mllp-ack-builder-failed", { name: describeError(error).name });
      ack = defaultAckBuilder(request);
    }
    let frame: Buffer;
    try {
      frame = encodeFrame(Buffer.from(ack));
    } catch (error) {
      // The ACK holds a framing byte, so it cannot be sent; the sender times out and sends again.
      this.report("warn", "mllp-ack-unsendable", describeError(error));
      close(conn, state);
      return;
    }
    const { replyTo } = this.options;
    if (replyTo === undefined) {
      conn.send(frame);
      return;
    }
    await this.reply(replyTo, frame, request.messageId);
  }

  /**
   * Sends an ACK on a new connection to `replyTo`. A reply that cannot be sent is reported by the
   * message's id and a code: the message stays stored, and the sender, with no ACK, sends it again.
   */
  private async reply(
    replyTo: MllpAddress,
    frame: Buffer,
    messageId: number | undefined,
  ): Promise<void> {
    const { tls, connectTimeoutMs } = this.options;
    try {
      await sendOnce(
        replyTo,
        tls === undefined ? undefined : asClientTls(tls),
        connectTimeoutMs ?? DEFAULT_MLLP_CONNECT_TIMEOUT_MS,
        frame,
      );
    } catch (error) {
      this.report("warn", "mllp-reply-failed", {
        message: messageId ?? null,
        code: (error as MllpDialError).code,
      });
    }
  }

  private report(
    level: MllpEvent["level"],
    event: string,
    fields: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): void {
    this.options.onEvent?.({ ...fields, level, event });
  }
}

/**
 * Sets the certificate name of connection `id` in `peers`, so the map never holds more than `max`.
 * When it is full, the oldest entry of the name that holds the most entries goes, the newcomer's own
 * name first on a tie, so a peer that opens many idle connections pushes out only its own entries,
 * never another peer's. When every name holds one entry, the newcomer is not remembered.
 *
 * @example
 * ```ts
 * const peers = new Map([["1", "lab"], ["2", "lab"], ["3", "ehr"]]);
 * rememberPeer(peers, "4", "lab", 3); // drops "1": peers is now { 2: lab, 3: ehr, 4: lab }
 * ```
 */
export function rememberPeer(
  peers: Map<string, string>,
  id: string,
  subject: string,
  max: number,
): void {
  while (peers.size >= max) {
    const counts = new Map<string, number>([[subject, 1]]);
    for (const name of peers.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
    // Counting the newcomer, so on a tie its own name gives way first: it is counted first, and a
    // later name takes its place only by holding more.
    let most = subject;
    let top = 0;
    for (const [name, count] of counts) {
      if (count > top) {
        most = name;
        top = count;
      }
    }
    // Every name holds one and the newcomer's none yet: it is not remembered, and pushes out none.
    if (most === subject && counts.get(subject) === 1) return;
    for (const [key, name] of peers) {
      if (name !== most) continue;
      peers.delete(key);
      break;
    }
  }
  peers.set(id, subject);
}

function close(conn: Connection, state: ConnectionState): void {
  state.closed = true;
  conn.destroy();
}

/**
 * Closes a connection once every message it brought has been answered: what was sent is written
 * out before the connection ends, so no ACK is cut off. A message that arrives after this is neither
 * stored nor answered, so its sender sends it again.
 */
function finish(conn: Connection, state: ConnectionState): void {
  if (state.closed) return;
  state.closed = true;
  void conn.close({ drainTimeoutMs: 1_000 });
}

/** How much longer than its ACK timeout a send may take in all, to cover a write that never flushes. */
const SEND_GRACE_MS = 1_000;

/** Options for an {@link MllpDestination}. */
export interface MllpDestinationOptions {
  readonly host: string;
  readonly port: number;
  /**
   * TLS, or undefined for plaintext MLLP. The server's certificate is always verified, against `ca`
   * when set and Node's built-in roots otherwise; `cert` and `key` present a client certificate.
   */
  readonly tls: MllpClientTlsMaterial | undefined;
  /** How long to wait to connect, and then for each ACK, in milliseconds. */
  readonly ackTimeoutMs: number;
}

/**
 * An MLLP delivery that did not complete and is worth trying again: no connection, no ACK in time,
 * an `AR` or `CR`, or an ACK that could not be read or did not match. `code` says which; it is
 * stable and holds no message content.
 *
 * @example
 * ```ts
 * throw new MllpDeliveryError("ACK_TIMEOUT");
 * ```
 */
export class MllpDeliveryError extends Error {
  /** A stable code, such as `ACK_TIMEOUT`, `ACK_AR` or `ECONNREFUSED`. */
  readonly code: string;

  /** @param code A stable code. Never message content. */
  constructor(code: string) {
    super(`the MLLP delivery did not complete (${code})`);
    this.name = "MllpDeliveryError";
    this.code = code;
  }
}

/**
 * Sends each output over MLLP, over TLS when it is given TLS material, and waits for its ACK. It keeps
 * one connection open and reuses it, opening a new one after any failure so a late ACK can never
 * answer the wrong message. The ACK decides the outcome:
 *
 * - `AA` or `CA`: delivered;
 * - `AE` or `CE`: a {@link DeliveryRejected}, so the engine marks the delivery failed and moves on;
 * - `AR` or `CR`, no ACK in time, an ACK that cannot be read or answers another control ID, or a
 *   connection that fails: an {@link MllpDeliveryError}, which the engine retries, holding later
 *   deliveries behind it.
 *
 * An output that holds an MLLP framing byte can never be sent, so it is a `DeliveryRejected` too.
 *
 * @example
 * ```ts
 * const destination = new MllpDestination({ host: "lab.local", port: 2576, tls, ackTimeoutMs: 10_000 });
 * await destination.deliver({ messageId: 1, seq: 0, body });
 * await destination.stop();
 * ```
 */
export class MllpDestination implements DestinationConnector {
  private readonly options: MllpDestinationOptions;
  private client: MllpClient | undefined;

  /** @param options Where to send, TLS, and how long to wait. It connects at the first delivery. */
  constructor(options: MllpDestinationOptions) {
    this.options = options;
  }

  /** Sends one output and waits for its ACK. */
  async deliver(message: OutgoingMessage): Promise<void> {
    const { body } = message;
    const payload = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const client = await this.connect();
    let reply: Buffer;
    try {
      // The library times the ACK from when the write flushes. This deadline, a little later,
      // also covers a write that never flushes because the receiver stopped reading.
      const deadline = AbortSignal.timeout(this.options.ackTimeoutMs + SEND_GRACE_MS);
      reply = await client.send(payload, {
        signal:
          message.signal === undefined ? deadline : AbortSignal.any([deadline, message.signal]),
      });
    } catch (error) {
      this.reset();
      if (error instanceof MllpFramingError && error.code.startsWith("MLLP_PAYLOAD_CONTAINS_")) {
        throw new DeliveryRejected(error.code);
      }
      throw new MllpDeliveryError(failureCode(error, "ACK_TIMEOUT"));
    }
    this.settle(reply, readHeader(payload).controlId);
  }

  /** Closes the connection, if one is open. The engine stops only between deliveries. */
  stop(): Promise<void> {
    this.reset();
    return Promise.resolve();
  }

  private async connect(): Promise<MllpClient> {
    if (this.client?.state === "CONNECTED") return this.client;
    this.reset();
    const { host, port, tls, ackTimeoutMs } = this.options;
    const client = createClient({
      host,
      port,
      ackTimeoutMs,
      pipeline: false,
      ...(tls === undefined ? {} : { tls: mllpClientTlsOptions(tls, host) }),
    });
    // A failure surfaces on the send it breaks; this keeps the client from reporting it twice.
    client.on("error", () => undefined);
    try {
      await client.connect({ signal: AbortSignal.timeout(ackTimeoutMs) });
    } catch (error) {
      client.destroy();
      throw new MllpDeliveryError(failureCode(error, "CONNECT_TIMEOUT"));
    }
    this.client = client;
    return client;
  }

  private settle(reply: Buffer, controlId: string | undefined): void {
    let code: string | undefined;
    let answers: string | undefined;
    try {
      const ack = interpretAck(parseHL7(reply));
      code = ack.code;
      answers = ack.controlId;
    } catch {
      code = undefined;
    }
    if (controlId !== undefined && code !== undefined && answers !== controlId) {
      this.reset();
      throw new MllpDeliveryError("ACK_CONTROL_ID_MISMATCH");
    }
    switch (code) {
      case "AA":
      case "CA":
        return;
      case "AE":
      case "CE":
        throw new DeliveryRejected(code);
      case "AR":
      case "CR":
        throw new MllpDeliveryError(`ACK_${code}`);
      case undefined:
      default:
        this.reset();
        throw new MllpDeliveryError("ACK_UNREADABLE");
    }
  }

  private reset(): void {
    this.client?.destroy();
    this.client = undefined;
  }
}

/**
 * A stable code for an MLLP failure: `timeout` when no answer came in time, otherwise the operating
 * system's or the TLS layer's code (such as `ECONNREFUSED`), or `MLLP_CONNECTION` for a connection
 * that ended without one. Never the error's text.
 */
function failureCode(error: unknown, timeout: string): string {
  if (error instanceof MllpTimeoutError || error instanceof DOMException) return timeout;
  const cause = error instanceof MllpConnectionError ? error.cause : error;
  return codeOf(cause) ?? "MLLP_CONNECTION";
}

/** A string property of an error, such as its `code` or `name`; never its text. */
function textOf(error: unknown, key: "code" | "name"): string | undefined {
  const value = (error as Partial<Record<typeof key, unknown>> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function codeOf(error: unknown): string | undefined {
  return textOf(error, "code");
}

/** An error's name and code, for a log line. The server wraps a connection's error with its id. */
function describeError(value: unknown): { name: string | undefined; code: string | undefined } {
  const error = (value as { error?: unknown } | undefined)?.error ?? value;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return { name: textOf(error, "name"), code: codeOf(error) ?? codeOf(cause) };
}
