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
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
  type SourceConnector,
} from "./types.js";

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

/**
 * Takes messages over HTTPS: each request body to one of `paths` is one message. Once the message
 * is stored it answers as `response` says, by default 202 with the stored message's id as JSON. It
 * never echoes the body.
 *
 * - 400 for a path that breaks the path rule, or an empty body;
 * - 401 without the bearer token, 404 on another path, 405 for another method, with `Allow`;
 * - 413 for a body over `maxBytes`, 415 for a compressed body;
 * - 503 when the message could not be stored, so the sender sends it again.
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
    } catch {
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
    let messageId: number;
    try {
      messageId = await sink.receive(
        body,
        problem === undefined ? { duplicateKey, source } : { failure: `inbound: ${problem}` },
      );
    } catch {
      replyText(response, 503, STORE_FAILED);
      return;
    }
    if (problem !== undefined) this.options.onUnreadable?.(messageId, problem);
    const request: AckRequest =
      problem === undefined
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
      });
      const timer = setTimeout(() => request.destroy(transientError("ETIMEDOUT")), timeoutMs);
      request.once("response", (response) => {
        clearTimeout(timer);
        // Drain and drop the body, so the connection can be reused and nothing of it is kept.
        response.on("error", () => undefined);
        response.resume();
        const failure = failureOf(response, this.url, this.now());
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

  /** Closes the connections kept open between deliveries. */
  stop(): Promise<void> {
    this.agent.destroy();
    return Promise.resolve();
  }
}
