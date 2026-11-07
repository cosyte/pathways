import type { Logger } from "pino";

import type { HealthConfig } from "../config/schema.js";
import {
  Endpoint,
  listenerSecurity,
  listenerWarnings,
  refuse,
  reply,
  type Env,
} from "../connectors/endpoint.js";
import type { ServerTlsMaterial } from "../connectors/tls.js";
import type { DeliveryStatus, MessageStatus } from "../storage/store.js";

/**
 * One channel's state: `retrying` while a delivery waits to be tried again, else `failed` while it
 * holds failed messages or deliveries, else `ok`; `unknown` when storage could not be read.
 */
export type ChannelStatus = "ok" | "retrying" | "failed" | "unknown";

/** One channel on the health endpoint: states and counts, never content. */
export interface ChannelHealth {
  readonly status: ChannelStatus;
  /** `down` when the channel's source could not listen; the engine keeps trying. */
  readonly source: "up" | "down";
  /** Absent when storage could not be read. */
  readonly messages?: Readonly<Record<MessageStatus, number>>;
  /** Absent when storage could not be read. `retrying` counts pending deliveries that failed once. */
  readonly deliveries?: Readonly<Record<DeliveryStatus | "retrying", number>>;
}

/**
 * The health endpoint's body. `status` is `unavailable` (and the answer 503) only when the engine
 * itself is broken: storage cannot be read, or a source cannot listen. A destination that is down
 * shows as a channel `retrying`, with the answer still 200, because restarting the engine would not
 * bring it back.
 */
export interface HealthReport {
  readonly status: "ok" | "unavailable";
  readonly storage: "ok" | "unreachable";
  readonly channels: Readonly<Record<string, ChannelHealth>>;
}

/**
 * A channel's status from its counts.
 *
 * @example
 * ```ts
 * channelStatus({ failed: 0 }, { retrying: 1, failed: 0 }); // "retrying"
 * ```
 */
export function channelStatus(
  messages: { readonly failed: number },
  deliveries: { readonly retrying: number; readonly failed: number },
): ChannelStatus {
  if (deliveries.retrying > 0) return "retrying";
  if (messages.failed > 0 || deliveries.failed > 0) return "failed";
  return "ok";
}

/** Options for a {@link HealthEndpoint}. */
export interface HealthEndpointOptions {
  readonly host: string;
  /** The port to listen on; 0 picks a free one, which {@link HealthEndpoint.port} then reports. */
  readonly port: number;
  /** TLS, or undefined for plaintext HTTP. */
  readonly tls: ServerTlsMaterial | undefined;
  /** The bearer token every request must carry, or undefined to require none. */
  readonly token: string | undefined;
  /** Builds the report each request answers with. */
  readonly report: () => Promise<HealthReport>;
  /** Told the status of each request refused (401, 405). */
  readonly onRefused?: (status: number) => void;
}

/**
 * The health endpoint: `GET` (or `HEAD`) on any path answers 200 with a {@link HealthReport}, or
 * 503 when the engine itself is broken. It is authenticated like an HTTP source: a bearer token by
 * default, or mutual TLS.
 *
 * @example
 * ```ts
 * const health = new HealthEndpoint({
 *   host: "127.0.0.1", port: 9090, tls, token, report: () => engine.health(),
 * });
 * await health.start();
 * await health.stop();
 * ```
 */
export class HealthEndpoint {
  private readonly endpoint: Endpoint;

  /** @param options Where to listen, TLS, the token, and where the report comes from. */
  constructor(options: HealthEndpointOptions) {
    const { host, port, tls, token, report, onRefused } = options;
    this.endpoint = new Endpoint(
      { host, port, tls, token, ...(onRefused === undefined ? {} : { onRefused }) },
      async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          refuse(response, 405, { Allow: "GET, HEAD" });
          onRefused?.(405);
          return;
        }
        const body = await report();
        reply(response, body.status === "ok" ? 200 : 503, body);
      },
    );
  }

  /** The port the endpoint listens on, or undefined when it is not listening. */
  get port(): number | undefined {
    return this.endpoint.port;
  }

  /** Starts listening. Rejects when the port cannot be had. */
  start(): Promise<void> {
    return this.endpoint.listen();
  }

  /** Stops listening. */
  stop(): Promise<void> {
    return this.endpoint.close();
  }
}

/**
 * Builds the health endpoint `pathways.yaml` configures, reading its TLS files and token, and logs
 * once if it runs without TLS or without authentication.
 *
 * @throws {ConfigError} when a TLS file cannot be read or loaded, or the token is missing or weak.
 * @example
 * ```ts
 * const health = healthEndpointFor(project.health, () => engine.health(), process.env, logger);
 * await health.start();
 * ```
 */
export function healthEndpointFor(
  config: HealthConfig,
  report: () => Promise<HealthReport>,
  env: Env,
  logger: Logger,
): HealthEndpoint {
  const { tls, token } = listenerSecurity(config, env, "pathways.yaml: health");
  for (const warning of listenerWarnings(config)) {
    logger.warn({ event: warning, endpoint: "health" });
  }
  return new HealthEndpoint({
    host: config.host,
    port: config.port,
    tls,
    token,
    report,
    onRefused: (status) => logger.warn({ event: "http-refused", endpoint: "health", status }),
  });
}
