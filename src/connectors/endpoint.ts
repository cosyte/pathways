import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  STATUS_CODES,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { ConfigError } from "../config/load.js";
import { HEADER_VALUE, type HeaderValue, type ListenerConfig } from "../config/schema.js";
import { loadServerTls, serverTlsOptions, type ServerTlsMaterial } from "./tls.js";

/** The environment Pathways reads secrets from: `process.env`, or a stand-in in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The shortest bearer token an endpoint accepts. */
export const MIN_TOKEN_LENGTH = 16;

/** RFC 6750's token characters: letters, digits and `-._~+/`, with `=` padding at the end. */
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** How long a closing endpoint waits for requests in flight before cutting their connections. */
const CLOSE_GRACE_MS = 5_000;

/**
 * Reads the environment variable `name`. `where` names the file and key that asked for it.
 *
 * @throws {ConfigError} when the variable is not set or is empty.
 * @example
 * ```ts
 * const token = readEnv(process.env, "LAB_TOKEN", "channels/adt/channel.yaml: source.http.auth");
 * ```
 */
export function readEnv(env: Env, name: string, where: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ConfigError([`${where}: the environment variable ${name} is not set`]);
  }
  return value;
}

/**
 * The headers an HTTP client sends: `defaults` first, then each configured header, read from the
 * environment when it says `{ env: NAME }`. A configured header replaces a default of the same name,
 * whatever its case. `where` names the file and key, such as
 * `channels/adt/channel.yaml: destinations.0.http`. Errors name the header and the variable, never a
 * value.
 *
 * @throws {ConfigError} when a variable is not set, or holds characters a header cannot carry.
 * @example
 * ```ts
 * const headers = resolveHeaders({ "Content-Type": "application/json" }, config.headers, process.env, where);
 * ```
 */
export function resolveHeaders(
  defaults: Readonly<Record<string, string>>,
  configured: Readonly<Record<string, HeaderValue>>,
  env: Env,
  where: string,
): Record<string, string> {
  const headers: Record<string, string> = { ...defaults };
  for (const [name, value] of Object.entries(configured)) {
    const lower = name.toLowerCase();
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing];
    }
    headers[name] =
      "env" in value ? readHeaderEnv(env, value.env, `${where}.headers.${name}`) : value.value;
  }
  return headers;
}

function readHeaderEnv(env: Env, name: string, where: string): string {
  const value = readEnv(env, name, where);
  if (!HEADER_VALUE.test(value)) {
    throw new ConfigError([
      `${where}: the environment variable ${name} holds characters a header cannot carry`,
    ]);
  }
  return value;
}

/**
 * What a listening endpoint needs at startup: its TLS read from disk (undefined with
 * `plaintext: true`) and its bearer token read from the environment (undefined with `auth: none`).
 * `where` names the file and key, such as `channels/adt/channel.yaml: source.http`.
 *
 * @throws {ConfigError} when a TLS file cannot be read or loaded, or the token is missing or weak.
 * @example
 * ```ts
 * const { tls, token } = listenerSecurity(project.health, process.env, "pathways.yaml: health");
 * ```
 */
export function listenerSecurity(
  config: ListenerConfig,
  env: Env,
  where: string,
): { tls: ServerTlsMaterial | undefined; token: string | undefined } {
  const tls = config.tls === undefined ? undefined : loadServerTls(config.tls, `${where}.tls`);
  if (config.auth.kind === "none") return { tls, token: undefined };
  const token = readEnv(env, config.auth.env, `${where}.auth`);
  if (token.length < MIN_TOKEN_LENGTH || !TOKEN.test(token)) {
    throw new ConfigError([
      `${where}.auth: the token in ${config.auth.env} must be at least ${MIN_TOKEN_LENGTH} characters of letters, digits and -._~+/`,
    ]);
  }
  return { tls, token };
}

/**
 * What a listening endpoint's configuration leaves open: `plaintext` without TLS, and
 * `unauthenticated` with neither a bearer token nor mutual TLS. Each is logged once at startup.
 *
 * @example
 * ```ts
 * for (const warning of listenerWarnings(project.health)) logger.warn({ event: warning });
 * ```
 */
export function listenerWarnings(
  config: ListenerConfig,
): readonly ("plaintext" | "unauthenticated")[] {
  const warnings: ("plaintext" | "unauthenticated")[] = [];
  if (config.plaintext) warnings.push("plaintext");
  if (config.auth.kind === "none" && config.tls?.ca === undefined) warnings.push("unauthenticated");
  return warnings;
}

/**
 * Whether an `Authorization` header carries `Bearer <token>`. The two are compared as SHA-256
 * digests with `timingSafeEqual`, so the time taken says nothing about how much of the token was
 * right, nor how long it is.
 *
 * @example
 * ```ts
 * bearerMatches(request.headers.authorization, token);
 * ```
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer +(\S+) *$/i.exec(header ?? "")?.[1];
  // Always compare, even with nothing presented, so a missing header takes the same path.
  const same = timingSafeEqual(digest(presented ?? ""), digest(token));
  return presented !== undefined && same;
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/**
 * Answers with a small JSON body. The body is built by Pathways (ids, counts, states), never from a
 * request or a message.
 *
 * @example
 * ```ts
 * reply(response, 202, { id: 42 });
 * ```
 */
export function reply(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(text);
}

/**
 * Refuses a request with `status` and closes the connection, so a body nobody read is not read
 * either.
 *
 * @example
 * ```ts
 * refuse(response, 405, { Allow: "POST" });
 * ```
 */
export function refuse(
  response: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders = {},
): void {
  reply(response, status, { error: STATUS_CODES[status] }, { Connection: "close", ...headers });
}

/**
 * Answers with a short plain-text body, for an endpoint whose callers read HL7 over HTTP: there,
 * every answer that is not 2xx is plain text, never JSON and never HL7. The text is Pathways' own,
 * never from a request or a message.
 *
 * @example
 * ```ts
 * replyText(response, 503, "the message could not be stored; send it again");
 * ```
 */
export function replyText(
  response: ServerResponse,
  status: number,
  text: string,
  headers: OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(text);
}

/**
 * {@link refuse}, with the status's own name as a plain-text body.
 *
 * @example
 * ```ts
 * refuseText(response, 415);
 * ```
 */
export function refuseText(
  response: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders = {},
): void {
  replyText(response, status, String(STATUS_CODES[status]), { Connection: "close", ...headers });
}

/** Options for an {@link Endpoint}. */
export interface EndpointOptions {
  readonly host: string;
  /** The port to listen on; 0 picks a free one, which {@link Endpoint.port} then reports. */
  readonly port: number;
  /** TLS, or undefined for plaintext HTTP. */
  readonly tls: ServerTlsMaterial | undefined;
  /** The bearer token every request must carry, or undefined to require none. */
  readonly token: string | undefined;
  /** Told the status of each request the endpoint itself refuses (401). */
  readonly onRefused?: (status: number) => void;
  /** How long `close` lets requests in flight finish, in milliseconds. */
  readonly closeGraceMs?: number;
  /** True answers the endpoint's own refusals (401, 500) in plain text rather than JSON. */
  readonly plainText?: boolean;
}

/** Handles one authenticated request. */
export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/**
 * An HTTPS (or, with no TLS, HTTP) server on `node:http`, shared by the HTTP source and the health
 * endpoint. It refuses a request without the bearer token with 401 before the handler sees it, and
 * with mutual TLS a client without a trusted certificate never gets past the handshake.
 *
 * @example
 * ```ts
 * const endpoint = new Endpoint({ host: "127.0.0.1", port: 8443, tls, token }, async (req, res) => {
 *   reply(res, 200, { ok: true });
 * });
 * await endpoint.listen();
 * await endpoint.close();
 * ```
 */
export class Endpoint {
  private readonly options: EndpointOptions;
  private readonly handler: RequestHandler;
  private server: Server | undefined;

  /**
   * @param options Where to listen, TLS and the token.
   * @param handler Answers each request that passed authentication.
   */
  constructor(options: EndpointOptions, handler: RequestHandler) {
    this.options = options;
    this.handler = handler;
  }

  /** The port the endpoint listens on, or undefined when it is not listening. */
  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address.port : undefined;
  }

  /** Starts listening. Rejects, listening on nothing, when the port cannot be had. */
  async listen(): Promise<void> {
    if (this.server !== undefined) return;
    const { host, port, tls } = this.options;
    const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
      this.onRequest(request, response);
    };
    const server =
      tls === undefined
        ? createHttpServer(onRequest)
        : createHttpsServer(serverTlsOptions(tls), onRequest);
    await new Promise<void>((resolve, reject) => {
      // Kept for the server's life: a later server error settles nothing and is dropped.
      server.on("error", reject);
      server.listen(port, host, resolve);
    });
    this.server = server;
  }

  /**
   * Stops listening. Requests in flight get a short grace to finish before their connections are
   * cut; idle connections close at once.
   */
  async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    const grace = setTimeout(
      () => server.closeAllConnections(),
      this.options.closeGraceMs ?? CLOSE_GRACE_MS,
    );
    await closed;
    clearTimeout(grace);
  }

  private onRequest(request: IncomingMessage, response: ServerResponse): void {
    const { token, onRefused, plainText } = this.options;
    const refusal = plainText === true ? refuseText : refuse;
    if (token !== undefined && !bearerMatches(request.headers.authorization, token)) {
      refusal(response, 401, { "WWW-Authenticate": "Bearer" });
      onRefused?.(401);
      return;
    }
    this.handler(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else refusal(response, 500);
    });
  }
}
