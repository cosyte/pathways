import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "pino";

import type { ChannelConfig, Format, ProjectConfig } from "../config/schema.js";
import { FileDestination, FileSource } from "../connectors/file.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type SourceConnector,
} from "../connectors/types.js";
import type { MessageStore } from "../storage/store.js";
import { ChannelWorker, type TransformOutcome } from "./channel-worker.js";
import type { FailureSummary } from "./worker-entry.js";

/** The first retry waits this long; each later one waits twice as long as the one before. */
export const RETRY_FIRST_MS = 1_000;
/** No retry waits longer than this. */
export const RETRY_MAX_MS = 300_000;

/** The file extension a file destination writes for each format. */
export const EXTENSIONS: Readonly<Record<Format, string>> = { hl7v2: "hl7", text: "txt" };

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

/**
 * Builds the connectors a channel's configuration names.
 *
 * @example
 * ```ts
 * const { source, destinations } = connectorsFor(channel, Date.now, () => undefined);
 * ```
 */
export function connectorsFor(
  channel: ChannelConfig,
  now: () => number,
  onReadError: (error: unknown) => void,
): ChannelConnectors {
  return {
    source: new FileSource({
      dir: channel.source.dir,
      minAgeMs: channel.source.minAgeMs,
      now,
      onReadError,
    }),
    destinations: channel.destinations.map(
      (destination) =>
        new FileDestination({ dir: destination.dir, extension: EXTENSIONS[channel.format] }),
    ),
  };
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
}

interface RunningChannel {
  readonly config: ChannelConfig;
  readonly worker: ChannelWorker;
  readonly connectors: ChannelConnectors;
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

  /** Starts every channel. Rejects, having stopped any it started, if a transform will not load. */
  async start(): Promise<void> {
    const { project, logger } = this.options;
    try {
      for (const config of project.channels) {
        const worker = new ChannelWorker({
          channel: config.name,
          transformFile: config.transform,
          format: config.format,
          timeoutMs: config.settings.timeoutMs,
          memoryMb: config.settings.memoryMb,
        });
        const onReadError = (error: unknown): void => {
          logger.warn({
            event: "source-read-failed",
            channel: config.name,
            code: errorCode(error),
          });
        };
        const connectors =
          this.options.connectors?.(config) ?? connectorsFor(config, this.now, onReadError);
        const channel = { config, worker, connectors };
        this.channels.push(channel);
        await worker.start();
        await connectors.source.start?.(this.sinkFor(config));
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** One pass over every channel: take in, transform, deliver. */
  async tick(): Promise<void> {
    for (const channel of this.channels) {
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

  /** Stops every source that listens, then every worker. */
  async stop(): Promise<void> {
    const channels = this.channels.splice(0);
    await Promise.all(
      channels.map(async (channel) => {
        await channel.connectors.source.stop?.();
      }),
    );
    await Promise.all(channels.map((channel) => channel.worker.stop()));
  }

  private sinkFor(config: ChannelConfig): { receive(body: Uint8Array): Promise<number> } {
    const { store, logger } = this.options;
    return {
      receive: async (body) => {
        const id = await store.receive(config.name, body);
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

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
