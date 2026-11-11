import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import { Endpoint, refuse, reply } from "./endpoint.js";
import { failureOf, transientError } from "./http-core.js";
import { clientTlsOptions, type ClientTlsMaterial, type ServerTlsMaterial } from "./tls.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
  type SourceConnector,
} from "./types.js";

/** Options for an {@link HttpSource}. */
export interface HttpSourceOptions {
  readonly host: string;
  /** The port to listen on; 0 picks a free one, which {@link HttpSource.port} then reports. */
  readonly port: number;
  /** The path that takes messages. Any other path answers 404. */
  readonly path: string;
  /** The largest body taken, in bytes. A larger one answers 413. */
  readonly maxBytes: number;
  /** TLS, or undefined for plaintext HTTP. */
  readonly tls: ServerTlsMaterial | undefined;
  /** The bearer token every request must carry, or undefined to require none. */
  readonly token: string | undefined;
  /** Told the status of each request refused before storing (400, 401, 404, 405, 413, 415). */
  readonly onRefused?: (status: number) => void;
}

/**
 * Takes messages over HTTPS: each POST body to `path` is one message. It answers 202 with the
 * stored message's id as JSON once the message is stored, and never echoes the body.
 *
 * - 401 without the bearer token, 404 on another path, 405 for another method;
 * - 413 for a body over `maxBytes`, 415 for a compressed body, 400 for an empty one;
 * - 503 when the message could not be stored, so the sender sends it again.
 *
 * @example
 * ```ts
 * const source = new HttpSource({
 *   host: "127.0.0.1", port: 8443, path: "/", maxBytes: 10_485_760, tls, token,
 * });
 * await source.start({ receive: async (body) => store.receive("adt", body) });
 * await source.stop();
 * ```
 */
export class HttpSource implements SourceConnector {
  private readonly options: HttpSourceOptions;
  private endpoint: Endpoint | undefined;

  /** @param options Where to listen, what to take, TLS and the token. */
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
      { host, port, tls, token, ...(onRefused === undefined ? {} : { onRefused }) },
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
    const { path, maxBytes, onRefused } = this.options;
    const refused = (status: number, headers?: OutgoingHttpHeaders): void => {
      refuse(response, status, headers);
      onRefused?.(status);
    };
    const [pathname] = String(request.url).split("?");
    if (pathname !== path) return refused(404);
    if (request.method !== "POST") return refused(405, { Allow: "POST" });
    const encoding = request.headers["content-encoding"];
    if (encoding !== undefined && encoding.toLowerCase() !== "identity") return refused(415);
    if (Number(request.headers["content-length"]) > maxBytes) return refused(413);

    const body = await readBody(request, maxBytes);
    if (body === "too-large") return refused(413);
    // The sender went away mid-body: there is no one to answer and nothing whole to store.
    if (body === undefined) return;
    if (body.byteLength === 0) return refused(400);

    let id: number;
    try {
      id = await sink.receive(body);
    } catch {
      reply(response, 503, { error: "the message could not be stored; send it again" });
      return;
    }
    reply(response, 202, { id });
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
