import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import { NEVER_CONTEXT_HEADERS } from "../config/schema.js";
import type { JsonValue } from "../transform.js";
import { ackCharset, defaultAckBuilder, type AckRequest } from "./ack.js";
import { Endpoint, refuse, refuseText, reply, replyText } from "./endpoint.js";
import { failureOf, transientError } from "./http-core.js";
import { hl7MediaType, normalisePath } from "./http-path.js";
import { readHeader } from "./mllp.js";
import { clientTlsOptions, type ClientTlsMaterial, type ServerTlsMaterial } from "./tls.js";
import {
  DeliveryRejected,
  PassFailed,
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
  type SourceConnector,
} from "./types.js";
import {
  MAX_XML_ACK_BYTES,
  MISFIT,
  readXmlAck,
  REFUSED,
  SENT_XML_NO_CONTROL_ID,
  SENT_XML_UNREADABLE,
  settleXmlAck,
  xmlControlId,
} from "./xml-ack.js";

/** A method an HTTP source can take a message by. */
export type HttpSourceMethod = "POST" | "PUT";

/**
 * How an HTTP source answers a message it stored:
 *
 * - `id`: 202 with `{"id": <message id>}` as JSON (the default);
 * - `ack`: HL7 over HTTP, 200 with the HL7 ACK in the request's media type;
 * - `fixed`: the configured status, content type, headers and body, the same for every message.
 */
export type HttpSourceResponse =
  | { readonly kind: "id" }
  | { readonly kind: "ack" }
  | {
      readonly kind: "fixed";
      /** A 2xx status. */
      readonly status: number;
      /** The `Content-Type` sent, or undefined to send none. */
      readonly contentType: string | undefined;
      /** Headers sent with every answer, already resolved from the environment. */
      readonly headers: Readonly<Record<string, string>>;
      /** The body sent with every answer, written in the configuration; never the message. */
      readonly body: string;
    };

/** Options for an {@link HttpSource}. */
export interface HttpSourceOptions {
  readonly host: string;
  /** The port to listen on; 0 picks a free one, which {@link HttpSource.port} then reports. */
  readonly port: number;
  /**
   * The paths that take messages, each as {@link normalisePath} reads it. A request's path is read
   * by the same rule and compared exactly; a path that breaks the rule answers 400, any other 404.
   */
  readonly paths: readonly string[];
  /** The methods that take a message. Defaults to POST alone; `ack` mode takes POST alone. */
  readonly methods?: readonly HttpSourceMethod[];
  /** How a stored message is answered. Defaults to `id`. */
  readonly response?: HttpSourceResponse;
  /** The largest body taken, in bytes. A larger one answers 413. */
  readonly maxBytes: number;
  /**
   * The request headers, by lower-case name, passed to the transform in `ctx.source.headers`.
   * `authorization`, `proxy-authorization` and `cookie` are never passed, even when named here.
   * Defaults to none.
   */
  readonly contextHeaders?: readonly string[];
  /** TLS, or undefined for plaintext HTTP. */
  readonly tls: ServerTlsMaterial | undefined;
  /** The bearer token every request must carry, or undefined to require none. */
  readonly token: string | undefined;
  /** Told the status of each request refused before storing (400, 401, 404, 405, 413, 415). */
  readonly onRefused?: (status: number) => void;
  /**
   * In `ack` mode, told of each message stored as failed because its header could not be used:
   * its id and the problem's code, never its content.
   */
  readonly onUnreadable?: (messageId: number, problem: string) => void;
}

const STORE_FAILED = "the message could not be stored; send it again";
const PASS_DEFERRED = "the message could not be passed on yet; send it again";
const PASS_REJECTED = "the message was not accepted; sending it again will not help";

/** The `Retry-After` of a 503 for a pass that may succeed later: whole seconds, at least 1. */
function retryAfter(error: PassFailed): OutgoingHttpHeaders {
  return { "Retry-After": String(Math.max(1, Math.ceil((error.retryAfterMs ?? 1_000) / 1_000))) };
}

/**
 * Takes messages over HTTPS: each request body to one of `paths` is one message. Once the message
 * is stored it answers as `response` says, by default 202 with the stored message's id as JSON. It
 * never echoes the body.
 *
 * - 400 for a path that breaks the path rule, or an empty body;
 * - 401 without the bearer token, 404 on another path, 405 for another method, with `Allow`;
 * - 413 for a body over `maxBytes`, 415 for a compressed body;
 * - 503 when the message could not be stored, so the sender sends it again;
 * - on a channel that stores nothing, where a message is answered once every destination accepted
 *   it: 503 with `Retry-After` when it could not be passed on yet, and 422 (in `ack` mode, an `AE`
 *   ACK) when sending it again will not help.
 *
 * In `ack` mode it follows HL7 over HTTP: POST only, a `Content-Type` of `x-application/hl7-v2+er7`
 * or `application/hl7-v2` (others answer 415), and once the message is stored, 200 with the ACK
 * {@link defaultAckBuilder} builds, `AA`, or `AE` for a message whose header cannot be used, which
 * is stored as failed. Every answer that is not 2xx is plain text, and a store failure gets no ACK.
 *
 * @example
 * ```ts
 * const source = new HttpSource({
 *   host: "127.0.0.1", port: 8443, paths: ["/"], maxBytes: 10_485_760, tls, token,
 * });
 * await source.start({ receive: async (body) => store.receive("adt", body) });
 * await source.stop();
 * ```
 */
export class HttpSource implements SourceConnector {
  private readonly options: HttpSourceOptions;
  private endpoint: Endpoint | undefined;

  /** @param options Where to listen, what to take, how to answer, TLS and the token. */
  constructor(options: HttpSourceOptions) {
    this.options = options;
  }

  /** The port the source listens on, or undefined when it is not listening. */
  get port(): number | undefined {
    return this.endpoint?.port;
  }

  /** Starts listening, storing each message through `sink`. Rejects when the port cannot be had. */
  async start(sink: MessageSink): Promise<void> {
    const { host, port, tls, token, onRefused } = this.options;
    const endpoint = new Endpoint(
      {
        host,
        port,
        tls,
        token,
        plainText: this.options.response?.kind === "ack",
        ...(onRefused === undefined ? {} : { onRefused }),
      },
      (request, response) => this.handle(request, response, sink),
    );
    await endpoint.listen();
    this.endpoint = endpoint;
  }

  /** Stops listening, letting requests in flight finish first. */
  async stop(): Promise<void> {
    const endpoint = this.endpoint;
    this.endpoint = undefined;
    await endpoint?.close();
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    sink: MessageSink,
  ): Promise<void> {
    const { paths, maxBytes, onRefused } = this.options;
    const answer = this.options.response ?? { kind: "id" };
    const ack = answer.kind === "ack";
    const refused = (status: number, headers?: OutgoingHttpHeaders): void => {
      (ack ? refuseText : refuse)(response, status, headers);
      onRefused?.(status);
    };
    const pathname = normalisePath(String(request.url));
    if (pathname === undefined) return refused(400);
    if (!paths.includes(pathname)) return refused(404);
    const methods: readonly string[] = ack ? ["POST"] : (this.options.methods ?? ["POST"]);
    if (!methods.includes(String(request.method))) {
      return refused(405, { Allow: methods.join(", ") });
    }
    const encoding = request.headers["content-encoding"];
    if (encoding !== undefined && encoding.toLowerCase() !== "identity") return refused(415);
    const mediaType = hl7MediaType(request.headers["content-type"]);
    if (ack && mediaType === undefined) return refused(415);
    if (Number(request.headers["content-length"]) > maxBytes) return refused(413);

    const body = await readBody(request, maxBytes);
    if (body === "too-large") return refused(413);
    // The sender went away mid-body: there is no one to answer and nothing whole to store.
    if (body === undefined) return;
    if (body.byteLength === 0) return refused(400);

    const source = this.facts(request, pathname);
    if (answer.kind === "ack") {
      return this.acknowledge(body, String(mediaType), response, sink, source);
    }
    let id: number;
    try {
      id = await sink.receive(body, { source });
    } catch (error) {
      if (error instanceof PassFailed) {
        if (error.permanent) reply(response, 422, { error: PASS_REJECTED, code: error.code });
        else reply(response, 503, { error: PASS_DEFERRED, code: error.code }, retryAfter(error));
        return;
      }
      reply(response, 503, { error: STORE_FAILED });
      return;
    }
    if (answer.kind === "id") return reply(response, 202, { id });
    response.writeHead(answer.status, {
      "Cache-Control": "no-store",
      ...(answer.contentType === undefined ? {} : { "Content-Type": answer.contentType }),
      ...answer.headers,
      "Content-Length": Buffer.byteLength(answer.body),
    });
    response.end(answer.body);
  }

  /**
   * Stores an HL7 v2 message, then answers with its ACK: `AA`, or `AE` when its header cannot be
   * used and it was stored as failed. When it cannot be stored, 503 in plain text and no ACK.
   */
  private async acknowledge(
    body: Buffer,
    mediaType: string,
    response: ServerResponse,
    sink: MessageSink,
    source: Readonly<Record<string, JsonValue>>,
  ): Promise<void> {
    const { header, problem, duplicateKey } = readHeader(body);
    let messageId: number | undefined;
    try {
      messageId = await sink.receive(
        body,
        problem === undefined ? { duplicateKey, source } : { failure: `inbound: ${problem}` },
      );
    } catch (error) {
      if (error instanceof PassFailed && !error.permanent) {
        replyText(response, 503, PASS_DEFERRED, retryAfter(error));
        return;
      }
      if (!(error instanceof PassFailed)) {
        replyText(response, 503, STORE_FAILED);
        return;
      }
      // A channel that stores nothing could not pass it on, and sending it again will not help.
      messageId = undefined;
    }
    if (problem !== undefined && messageId !== undefined) {
      this.options.onUnreadable?.(messageId, problem);
    }
    const request: AckRequest =
      messageId === undefined
        ? { code: "AE", reason: "rejected", problem, header, messageId }
        : problem === undefined
          ? { code: "AA", reason: "stored", problem, header, messageId }
          : { code: "AE", reason: "unreadable", problem, header, messageId };
    const ack = defaultAckBuilder(request);
    response.writeHead(200, {
      "Content-Type": `${mediaType}; charset=${ackCharset(request)}`,
      "Content-Length": ack.byteLength,
      "Cache-Control": "no-store",
    });
    response.end(ack);
  }

  /**
   * What the transform reads in `ctx.source` about a request: its method, its path as matched, the
   * sender's address, and the headers `contextHeaders` names, never one that carries a credential.
   */
  private facts(request: IncomingMessage, path: string): Readonly<Record<string, JsonValue>> {
    const headers: Record<string, string> = {};
    for (const name of this.options.contextHeaders ?? []) {
      const lower = name.toLowerCase();
      const values = request.headersDistinct[lower];
      if (values === undefined || NEVER_CONTEXT_HEADERS.has(lower)) continue;
      headers[lower] = values.join(", ");
    }
    const { remoteAddress } = request.socket;
    return {
      method: String(request.method),
      path,
      /* v8 ignore next: the socket keeps its address until it closes, and the body was just read */
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
      headers,
    };
  }
}

/** Reads a request body of at most `maxBytes`: the bytes, `too-large`, or undefined if cut short. */
function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | "too-large" | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        request.off("data", onData);
        request.pause();
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", onData);
    request.once("end", () => resolve(Buffer.concat(chunks, size)));
    // An aborted request emits an error, then close; either way it settles as cut short. After a
    // whole body, close comes once the promise has already settled.
    request.on("error", () => undefined);
    request.once("close", () => resolve(undefined));
  });
}

const NO_TLS: ClientTlsMaterial = { ca: undefined, cert: undefined, key: undefined };

/** Options for an {@link HttpDestination}. */
export interface HttpDestinationOptions {
  /** Where each output is POSTed: `https://`, or `http://` only when plaintext was allowed. */
  readonly url: string;
  /** Headers sent with every request, already resolved from the environment. */
  readonly headers: Readonly<Record<string, string>>;
  /** How long one attempt may take, connection to response, in milliseconds. */
  readonly timeoutMs: number;
  /** The CA to trust and a client certificate to present, for an `https://` url. */
  readonly tls?: ClientTlsMaterial;
  /** Epoch milliseconds now, which a Retry-After date is read against. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * The header that flags a possible duplicate: sent only on a resend after an attempt was cut
   * off, its value the number of attempts before. Undefined sends none.
   */
  readonly resendHeader?: string | undefined;
  /**
   * How a 2xx answer's body is read: undefined to drop it, or `xml` to read it as an HL7 v2 XML
   * acknowledgement and settle the delivery by its code, as an MLLP ACK settles one.
   */
  readonly ack?: "xml" | undefined;
}

/**
 * POSTs each output to a URL. The server's certificate is always verified. The answer is read by
 * the shared status table (`classifyStatus`): a 2xx is delivered; a 408, 425, 429, 5xx, a network
 * error or a timeout throws a `RetryableError` with a `code`, and on a 429 or a 503 the wait its
 * Retry-After asks for; a 3xx throws a `RedirectHeld`, never followed; a 101 or any other 4xx throws
 * a `DeliveryRejected` whose reason is the status. Node waits past any other 1xx for the final
 * answer, so one with nothing after it ends as a timeout or a network error. The response body is read and dropped,
 * never logged.
 *
 * With `ack: "xml"`, a 2xx answer's body is read, up to 1 MiB and within the same time limit, as an
 * HL7 v2 XML acknowledgement, the way a web service that takes v2 XML answers on the same connection:
 * `AA` or `CA` is delivered; `AR` or `CR` a `DeliveryRejected`; `AE` or `CE`, an answer that is not
 * exactly one acknowledgement, a larger one, or one that answers another `MSH.10` than the message
 * sent, a `RetryableError` coded `ACK_AE`, `ACK_CE`, `ACK_UNREADABLE` or `ACK_CONTROL_ID_MISMATCH`.
 * The message sent is read once per delivery, before its first POST; when it is XML the hardened
 * reader refuses, or XML that is not one `MSH` with one `MSH.10`, nothing is sent and the delivery
 * fails at once, a `DeliveryRejected` whose reason is `SENT_XML_UNREADABLE` or
 * `SENT_XML_NO_CONTROL_ID`: the same body goes on every attempt, so a retry could only post it
 * again. Only
 * the code and the control ID are read; the rest is dropped, never logged.
 *
 * @example
 * ```ts
 * const destination = new HttpDestination({
 *   url: "https://lab.example.test/hl7",
 *   headers: { "Content-Type": "application/hl7-v2" },
 *   timeoutMs: 30_000,
 * });
 * await destination.deliver({ messageId: 1, seq: 0, body });
 * ```
 */
export class HttpDestination implements DestinationConnector {
  private readonly options: HttpDestinationOptions;
  private readonly url: URL;
  private readonly agent: HttpAgent;
  private readonly send: typeof httpRequest;
  private readonly now: () => number;
  /**
   * The control ID read from the last message delivered with `ack: xml`, kept so the attempts after
   * the first one of a delivery do not read the message again: its id, output and bytes.
   */
  private lastSent:
    | {
        readonly messageId: number;
        readonly seq: number;
        readonly body: Buffer;
        readonly controlId: string | typeof REFUSED | typeof MISFIT | undefined;
      }
    | undefined;

  /** @param options The URL, headers, timeout, TLS and, for tests, a clock. */
  constructor(options: HttpDestinationOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.url = new URL(options.url);
    if (this.url.protocol === "https:") {
      this.agent = new HttpsAgent({ keepAlive: true, ...clientTlsOptions(options.tls ?? NO_TLS) });
      this.send = httpsRequest;
    } else {
      this.agent = new HttpAgent({ keepAlive: true });
      this.send = httpRequest;
    }
  }

  /** Sends one output. */
  deliver(message: OutgoingMessage): Promise<void> {
    if (this.options.ack !== "xml") return this.post(message, undefined);
    return this.sentControlId(message).then((sent) => {
      if (sent === REFUSED) throw new DeliveryRejected(SENT_XML_UNREADABLE);
      if (sent === MISFIT) throw new DeliveryRejected(SENT_XML_NO_CONTROL_ID);
      return this.post(message, sent);
    });
  }

  /**
   * The control ID of `message`, read once per delivery: an attempt that sends the same output of the
   * same message, byte for byte, as the one before takes what was read then.
   */
  private async sentControlId(
    message: OutgoingMessage,
  ): Promise<string | typeof REFUSED | typeof MISFIT | undefined> {
    const body = Buffer.from(message.body.buffer, message.body.byteOffset, message.body.byteLength);
    const last = this.lastSent;
    if (
      last?.messageId === message.messageId &&
      last.seq === message.seq &&
      last.body.equals(body)
    ) {
      return last.controlId;
    }
    const controlId = await xmlControlId(message.body);
    this.lastSent = {
      messageId: message.messageId,
      seq: message.seq,
      body: Buffer.from(body),
      controlId,
    };
    return controlId;
  }

  /** POSTs one output, and with `ack: xml` settles it by the answer matched to `sent`. */
  private post(message: OutgoingMessage, sent: string | undefined): Promise<void> {
    const { headers, timeoutMs, resendHeader } = this.options;
    const flag =
      resendHeader === undefined || message.resend === undefined
        ? {}
        : { [resendHeader]: String(message.resend.previousAttempts) };
    return new Promise((resolve, reject) => {
      const request = this.send(this.url, {
        method: "POST",
        agent: this.agent,
        headers: { ...headers, ...flag, "Content-Length": message.body.byteLength },
        ...(message.signal === undefined ? {} : { signal: message.signal }),
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        request.destroy(transientError("ETIMEDOUT"));
      }, timeoutMs);
      request.once("response", (response) => {
        response.on("error", () => undefined);
        const failure = failureOf(response, this.url, this.now());
        if (failure === undefined && this.options.ack === "xml") {
          // The acknowledgement is the answer: read it within the attempt's time limit.
          readAnswer(response).then(
            (answer) => {
              clearTimeout(timer);
              this.settle(answer, sent).then(resolve, reject);
            },
            () => {
              clearTimeout(timer);
              request.destroy();
              reject(transientError(timedOut ? "ETIMEDOUT" : "ACK_UNREADABLE"));
            },
          );
          return;
        }
        clearTimeout(timer);
        // Drain and drop the body, so the connection can be reused and nothing of it is kept.
        response.resume();
        if (failure === undefined) resolve();
        else reject(failure);
      });
      // A 101 that names an upgrade comes here, never to `response`, and with no listener Node left
      // the attempt unsettled past its time limit. We never ask to switch protocols, so it is a
      // rejection, as the status table reads every 101, and the connection is dropped.
      request.once("upgrade", (response: IncomingMessage, socket: Duplex) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new DeliveryRejected(`HTTP ${String(response.statusCode)}`));
      });
      request.on("error", (error: Error & { code?: unknown }) => {
        clearTimeout(timer);
        /* v8 ignore next: Node's request errors (and the timeout's) all carry a code */
        const code = typeof error.code === "string" ? error.code : "EHTTP";
        reject(transientError(code));
      });
      request.end(message.body);
    });
  }

  /** Settles a delivery by the XML acknowledgement `answer`, matched to the control ID `sent`. */
  private async settle(answer: Buffer | "too-large", sent: string | undefined): Promise<void> {
    if (answer === "too-large") throw transientError("ACK_UNREADABLE");
    settleXmlAck(await readXmlAck(answer), sent);
  }

  /** Closes the connections kept open between deliveries. */
  stop(): Promise<void> {
    this.agent.destroy();
    return Promise.resolve();
  }
}

/**
 * Reads an answer's body of at most {@link MAX_XML_ACK_BYTES}: the bytes, or `too-large`, after
 * which the rest is drained and dropped. Rejects when the body breaks off.
 */
function readAnswer(response: IncomingMessage): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= MAX_XML_ACK_BYTES) chunks.push(chunk);
    });
    response.once("end", () =>
      resolve(size > MAX_XML_ACK_BYTES ? "too-large" : Buffer.concat(chunks, size)),
    );
    response.once("close", () => {
      if (!response.complete) reject(new Error("the answer broke off"));
    });
  });
}
