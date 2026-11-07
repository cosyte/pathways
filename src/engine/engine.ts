import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "pino";

import { ConfigError } from "../config/load.js";
import {
  HEADER_VALUE,
  type ChannelConfig,
  type Format,
  type ProjectConfig,
} from "../config/schema.js";
import { listenerSecurity, listenerWarnings, readEnv, type Env } from "../connectors/endpoint.js";
import { FileDestination, FileSource } from "../connectors/file.js";
import { HttpDestination, HttpSource } from "../connectors/http.js";
import { loadClientTls } from "../connectors/tls.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
  type SourceConnector,
} from "../connectors/types.js";
import type { MessageStore } from "../storage/store.js";
import { ChannelWorker, type TransformOutcome } from "./channel-worker.js";
import { channelStatus, type ChannelHealth, type HealthReport } from "./health.js";
import type { FailureSummary } from "./worker-entry.js";

/** The first retry waits this long; each later one waits twice as long as the one before. */
export const RETRY_FIRST_MS = 1_000;
/** No retry waits longer than this. */
export const RETRY_MAX_MS = 300_000;

/**
 * The file extension a file destination writes for each format.
 *
 * @example
 * ```ts
 * EXTENSIONS.fhir; // "json"
 * ```
 */
export const EXTENSIONS: Readonly<Record<Format, string>> = {
  hl7v2: "hl7",
  fhir: "json",
  x12: "x12",
  ccda: "xml",
  json: "json",
  text: "txt",
};

/**
 * The `Content-Type` an HTTP destination sends for each format, unless its headers set one.
 *
 * @example
 * ```ts
 * CONTENT_TYPES.fhir; // "application/fhir+json"
 * ```
 */
export const CONTENT_TYPES: Readonly<Record<Format, string>> = {
  hl7v2: "application/hl7-v2",
  fhir: "application/fhir+json",
  x12: "application/edi-x12",
  ccda: "application/xml",
  json: "application/json",
  text: "text/plain",
};

/**
 * How long to wait before attempt number `attempts + 1`, after `attempts` failures.
 *
 * @example
 * ```ts
 * retryDelay(1); // 1000
 * retryDelay(3); // 4000
 * ```
 */
export function retryDelay(attempts: number): number {
  return Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/**
 * How a failure is kept in storage: its stage, name, code and location, then the error's own text.
 *
 * @example
 * ```ts
 * storedFailure({ kind: "transform", name: "TypeError", where: "transform.ts:4:9", detail: "..." });
 * ```
 */
export function storedFailure(failure: FailureSummary): string {
  const code = failure.code === undefined ? "" : ` ${failure.code}`;
  const where = failure.where === undefined ? "" : ` at ${failure.where}`;
  return `${failure.kind}: ${failure.name}${code}${where}: ${failure.detail}`;
}

/** A channel's connectors. */
export interface ChannelConnectors {
  readonly source: SourceConnector;
  readonly destinations: readonly DestinationConnector[];
}

/** What {@link connectorsFor} builds connectors with. */
export interface ConnectorContext {
  /** Epoch milliseconds now. */
  readonly now: () => number;
  readonly logger: Logger;
  /** Where tokens and secret headers are read from. */
  readonly env: Env;
}

/**
 * Builds the connectors a channel's configuration names, reading TLS files and secrets from the
 * environment as it goes. Logs carry the channel, statuses and codes, never content.
 *
 * @throws {ConfigError} when a TLS file, a token or a secret header cannot be had.
 * @example
 * ```ts
 * const { source, destinations } = connectorsFor(channel, { now: Date.now, logger, env: process.env });
 * ```
 */
export function connectorsFor(
  channel: ChannelConfig,
  context: ConnectorContext,
): ChannelConnectors {
  const { now, logger, env } = context;
  const file = `channels/${channel.name}/channel.yaml`;
  const { source } = channel;
  let sourceConnector: SourceConnector;
  switch (source.kind) {
    case "file":
      sourceConnector = new FileSource({
        dir: source.dir,
        minAgeMs: source.minAgeMs,
        now,
        onReadError: (error) => {
          logger.warn({
            event: "source-read-failed",
            channel: channel.name,
            code: errorCode(error),
          });
        },
      });
      break;
    case "http": {
      const { tls, token } = listenerSecurity(source, env, `${file}: source.http`);
      sourceConnector = new HttpSource({
        host: source.host,
        port: source.port,
        path: source.path,
        maxBytes: source.maxBytes,
        tls,
        token,
        onRefused: (status) => {
          logger.warn({ event: "http-refused", channel: channel.name, status });
        },
      });
      break;
    }
  }
  const destinations = channel.destinations.map((destination, index): DestinationConnector => {
    switch (destination.kind) {
      case "file":
        return new FileDestination({ dir: destination.dir, extension: EXTENSIONS[channel.format] });
      case "http": {
        const where = `${file}: destinations.${index}.http`;
        const headers: Record<string, string> = { "Content-Type": CONTENT_TYPES[channel.format] };
        for (const [name, value] of Object.entries(destination.headers)) {
          // A header the YAML sets replaces the default, whatever its case.
          if (name.toLowerCase() === "content-type") delete headers["Content-Type"];
          headers[name] =
            "env" in value
              ? readHeaderEnv(env, value.env, `${where}.headers.${name}`)
              : value.value;
        }
        return new HttpDestination({
          url: destination.url,
          headers,
          timeoutMs: destination.timeoutMs,
          ...(destination.tls === undefined
            ? {}
            : { tls: loadClientTls(destination.tls, `${where}.tls`) }),
        });
      }
    }
  });
  return { source: sourceConnector, destinations };
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

/** What the engine runs on. */
export interface EngineOptions {
  readonly project: ProjectConfig;
  readonly store: MessageStore;
  readonly logger: Logger;
  /** Epoch milliseconds now. Tests pass their own clock. */
  readonly now?: () => number;
  /** Builds a channel's connectors; by default, from its configuration. */
  readonly connectors?: (channel: ChannelConfig) => ChannelConnectors;
  /** Where tokens and secret headers are read from. Defaults to `process.env`. */
  readonly env?: Env;
}

interface RunningChannel {
  readonly config: ChannelConfig;
  readonly worker: ChannelWorker;
  readonly connectors: ChannelConnectors;
  /** Set while the channel's source cannot listen: how often it has failed and when to try next. */
  down: { readonly attempts: number; readonly nextAt: number } | undefined;
}

/**
 * The engine: for each channel, takes in new messages, runs them through the channel's transform,
 * and delivers the outputs, in that order on every pass.
 *
 * - A message is stored before its source acknowledges it, so a crash never loses one; it can at
 *   worst take a message in twice (at least once).
 * - Each destination delivers its messages in order. When a delivery fails, that destination retries
 *   it with growing waits, and later deliveries wait behind it; other destinations carry on. A
 *   delivery the receiver rejects for good is marked failed and the destination moves on.
 * - A message whose transform fails is marked failed, and the channel moves on to the next.
 * - A source that cannot listen (its port is taken) is tried again with the same growing waits,
 *   while the rest of the engine runs and the health endpoint answers 503.
 *
 * Logs carry ids, counts and error names only: never a message's content, and never a file name,
 * which can carry a patient's name.
 *
 * @example
 * ```ts
 * const engine = new Engine({ project, store, logger });
 * await engine.start();
 * await engine.tick();
 * await engine.stop();
 * ```
 */
export class Engine {
  private readonly options: EngineOptions;
  private readonly now: () => number;
  private readonly channels: RunningChannel[] = [];

  /** @param options The project, the store, the logger and, for tests, a clock and connectors. */
  constructor(options: EngineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Starts every channel. Rejects, having stopped any it started, if a transform will not load or a
   * connector's TLS files or secrets cannot be had (a `ConfigError`). A source that cannot listen
   * does not stop the start: it is logged, reported on the health endpoint, and tried again.
   */
  async start(): Promise<void> {
    const { project, logger } = this.options;
    const env = this.options.env ?? process.env;
    try {
      for (const config of project.channels) {
        const worker = new ChannelWorker({
          channel: config.name,
          transformFile: config.transform,
          format: config.format,
          timeoutMs: config.settings.timeoutMs,
          memoryMb: config.settings.memoryMb,
        });
        const connectors =
          this.options.connectors?.(config) ??
          connectorsFor(config, { now: this.now, logger, env });
        const channel: RunningChannel = { config, worker, connectors, down: undefined };
        this.channels.push(channel);
        this.warnInsecure(config);
        await worker.start();
        await this.startSource(channel);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** One pass over every channel: take in, transform, deliver. */
  async tick(): Promise<void> {
    for (const channel of this.channels) {
      if (channel.down !== undefined && channel.down.nextAt <= this.now()) {
        await this.startSource(channel);
      }
      await channel.connectors.source.poll?.(this.sinkFor(channel.config));
      await this.transformAll(channel);
      await this.deliverAll(channel);
    }
  }

  /** Runs passes until `signal` aborts, waiting the poll interval between them. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await sleep(this.options.project.settings.pollIntervalMs, undefined, { signal }).catch(
        () => undefined,
      );
    }
  }

  /** Stops every source that listens, then every worker and every destination's connections. */
  async stop(): Promise<void> {
    const channels = this.channels.splice(0);
    await Promise.all(
      channels.map(async (channel) => {
        await channel.connectors.source.stop?.();
      }),
    );
    await Promise.all(
      channels.flatMap((channel) => [
        channel.worker.stop(),
        ...channel.connectors.destinations.map(async (destination) => {
          await destination.stop?.();
        }),
      ]),
    );
  }

  /**
   * Each channel's status and counts, for the health endpoint. Its `status` is `unavailable` only
   * when storage cannot be read or a source cannot listen. Holds counts and states, never content.
   */
  async health(): Promise<HealthReport> {
    const { project, store } = this.options;
    const down = new Set(
      this.channels.filter((channel) => channel.down !== undefined).map((c) => c.config.name),
    );
    const source = (name: string): "up" | "down" => (down.has(name) ? "down" : "up");
    const channels: Record<string, ChannelHealth> = {};
    let storage: HealthReport["storage"] = "ok";
    try {
      for (const { name } of project.channels) {
        const [messages, counts, retrying] = await Promise.all([
          store.messageCounts(name),
          store.deliveryCounts(name),
          store.retryingDeliveries(name),
        ]);
        const deliveries = { ...counts, retrying };
        channels[name] = {
          status: channelStatus(messages, deliveries),
          source: source(name),
          messages,
          deliveries,
        };
      }
    } catch {
      storage = "unreachable";
      for (const { name } of project.channels) {
        channels[name] = { status: "unknown", source: source(name) };
      }
    }
    const broken = storage !== "ok" || down.size > 0;
    return { status: broken ? "unavailable" : "ok", storage, channels };
  }

  private warnInsecure(config: ChannelConfig): void {
    const { logger } = this.options;
    const { source } = config;
    if (source.kind !== "file") {
      for (const warning of listenerWarnings(source)) {
        logger.warn({ event: warning, channel: config.name, endpoint: "source" });
      }
    }
    for (const [index, destination] of config.destinations.entries()) {
      if (destination.kind !== "file" && destination.plaintext) {
        logger.warn({
          event: "plaintext",
          channel: config.name,
          endpoint: "destination",
          destination: index,
        });
      }
    }
  }

  private async startSource(channel: RunningChannel): Promise<void> {
    const { source } = channel.connectors;
    if (source.start === undefined) return;
    const { logger } = this.options;
    try {
      await source.start(this.sinkFor(channel.config));
    } catch (error) {
      const attempts = (channel.down?.attempts ?? 0) + 1;
      const wait = retryDelay(attempts);
      channel.down = { attempts, nextAt: this.now() + wait };
      logger.error({
        event: "source-start-failed",
        channel: channel.config.name,
        attempt: attempts,
        retryInMs: wait,
        code: errorCode(error),
      });
      return;
    }
    if (channel.down !== undefined) {
      channel.down = undefined;
      logger.info({ event: "source-started", channel: channel.config.name });
    }
  }

  private sinkFor(config: ChannelConfig): MessageSink {
    const { store, logger } = this.options;
    return {
      receive: async (body) => {
        let id: number;
        try {
          id = await store.receive(config.name, body);
        } catch (error) {
          logger.error({ event: "receive-failed", channel: config.name, code: errorCode(error) });
          throw error;
        }
        logger.info({
          event: "received",
          channel: config.name,
          message: id,
          bytes: body.byteLength,
        });
        return id;
      },
    };
  }

  private async transformAll({ config, worker }: RunningChannel): Promise<void> {
    const { store, logger } = this.options;
    for (;;) {
      const next = await store.nextToTransform(config.name);
      if (next === undefined) return;
      const outcome: TransformOutcome = await worker.run(next.body);
      if (outcome.ok) {
        await store.completeTransform(next.id, outcome.outputs, config.destinations.length);
        logger.info({
          event: outcome.outputs.length === 0 ? "filtered" : "transformed",
          channel: config.name,
          message: next.id,
          outputs: outcome.outputs.length,
        });
      } else {
        await store.failTransform(next.id, storedFailure(outcome.failure));
        const { kind, name, code, where } = outcome.failure;
        logger.warn({
          event: "transform-failed",
          channel: config.name,
          message: next.id,
          kind,
          name,
          code,
          where,
        });
      }
    }
  }

  private async deliverAll({ config, connectors }: RunningChannel): Promise<void> {
    const { store, logger } = this.options;
    for (const [index, destination] of connectors.destinations.entries()) {
      for (;;) {
        const delivery = await store.nextDelivery(config.name, index);
        if (delivery === undefined || delivery.nextAttemptAt > this.now()) break;
        try {
          await destination.deliver({
            messageId: delivery.messageId,
            seq: delivery.seq,
            body: delivery.body,
          });
        } catch (error) {
          if (error instanceof DeliveryRejected) {
            await store.failDelivery(delivery.id, `rejected: ${error.reason}`);
            logger.warn({
              event: "delivery-rejected",
              channel: config.name,
              destination: index,
              delivery: delivery.id,
              reason: error.reason,
            });
            continue;
          }
          const attempts = delivery.attempts + 1;
          const wait = retryDelay(attempts);
          const code = errorCode(error);
          await store.scheduleRetry(
            delivery.id,
            attempts,
            this.now() + wait,
            `delivery: ${code ?? "error"}`,
          );
          logger.warn({
            event: "delivery-retry",
            channel: config.name,
            destination: index,
            delivery: delivery.id,
            attempt: attempts,
            retryInMs: wait,
            code,
          });
          break;
        }
        await store.markDelivered(delivery.id);
        logger.info({
          event: "delivered",
          channel: config.name,
          destination: index,
          delivery: delivery.id,
        });
      }
    }
  }
}

/**
 * An error's `code`, when it has a string one: the only part of an error that is safe to log.
 *
 * @example
 * ```ts
 * errorCode(Object.assign(new Error("..."), { code: "EADDRINUSE" })); // "EADDRINUSE"
 * ```
 */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
