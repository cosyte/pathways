import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "pino";

import {
  DEFAULT_RETRY,
  type ChannelConfig,
  type Format,
  type ProjectConfig,
  type RetryPolicy,
} from "../config/schema.js";
import {
  listenerSecurity,
  listenerWarnings,
  resolveHeaders,
  type Env,
} from "../connectors/endpoint.js";
import { FileDestination, FileSource } from "../connectors/file.js";
import { HttpDestination, HttpSource } from "../connectors/http.js";
import { RedirectHeld, RetryableError } from "../connectors/http-core.js";
import { MllpDestination, MllpSource } from "../connectors/mllp.js";
import { loadClientTls, loadServerTls } from "../connectors/tls.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
  type SourceConnector,
} from "../connectors/types.js";
import { customDestination, customSource, loadAckBuilder } from "../extensions/build.js";
import { faultPoint } from "../fault-points.js";
import type { LifecycleEvent } from "../extensions/events.js";
import { HookSet } from "../extensions/hooks.js";
import type { ChannelContext } from "../extensions/types.js";
import { AuditLog, auditEvent } from "../operator/audit.js";
import { recordRetention, runRetention, type RetentionReport } from "../operator/retention.js";
import { copiesBodies, markCopiesBodies, release } from "../storage/ownership.js";
import type { MessageStore, ReceivedMessage } from "../storage/store.js";
import { ChannelWorker, type TransformOutcome } from "./channel-worker.js";
import type { EngineFence } from "./lease.js";
import { channelStatus, type ChannelHealth, type EngineHealth } from "./health.js";
import type { FailureSummary } from "./worker-entry.js";

/**
 * By default the first retry waits this long, and each later one twice as long as the one before.
 * `retry.first` sets it per project, channel or destination.
 */
export const RETRY_FIRST_MS = DEFAULT_RETRY.firstMs;
/**
 * By default no retry waits longer than this, whatever a server asks, and a held redirect waits this
 * long. `retry.max` sets it per project, channel or destination.
 */
export const RETRY_MAX_MS = DEFAULT_RETRY.maxMs;

/** Liveness allows this long past the poll interval and the longest single step before it says stalled. */
export const LIVE_GRACE_MS = 60_000;

/**
 * How long the engine loop may go without a step before liveness answers `stalled`: 60 seconds,
 * plus the poll interval, plus the longest time limit one step can take. A step is a message taken
 * in by a polled source, one transform, one delivery attempt, a channel's turn in a pass, or one
 * channel of a retention run. The longest step is the longest of each channel's transform timeout, each HTTP
 * destination's timeout, and twice each MLLP destination's ACK timeout (one to connect, one for the
 * ACK) plus a second. A custom destination has no time limit of its own: one that never returns
 * stalls the engine, and liveness says so. Nor has one channel's retention delete: one that takes
 * longer than the bound (a very large backlog past its retention period) makes liveness say stalled
 * until it is done.
 *
 * @example
 * ```ts
 * livenessBoundMs(project); // 95000 with a 1s poll interval and HTTP destinations at 30s
 * ```
 */
export function livenessBoundMs(project: ProjectConfig): number {
  let longest = 0;
  for (const channel of project.channels) {
    longest = Math.max(longest, channel.settings.timeoutMs);
    for (const destination of channel.destinations) {
      if (destination.kind === "http") longest = Math.max(longest, destination.timeoutMs);
      if (destination.kind === "mllp") {
        longest = Math.max(longest, 2 * destination.ackTimeoutMs + 1_000);
      }
    }
  }
  return LIVE_GRACE_MS + project.settings.pollIntervalMs + longest;
}

/** Readiness reads storage at most this often; a probe in between is told the last answer. */
const STORAGE_CHECK_EVERY_MS = 1_000;
/** A storage read for readiness that takes longer than this counts as storage unreachable. */
const STORAGE_CHECK_TIMEOUT_MS = 5_000;

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
 * How long to wait before attempt number `attempts + 1`, after `attempts` failures, with the default
 * retry settings: 1 second, doubling to 5 minutes. A source that cannot listen is tried again on
 * these waits.
 *
 * @example
 * ```ts
 * retryDelay(1); // 1000
 * retryDelay(3); // 4000
 * ```
 */
export function retryDelay(attempts: number): number {
  return retryBackoff(attempts, DEFAULT_RETRY);
}

/**
 * The capped exponential wait before attempt number `attempts + 1`, after `attempts` failures:
 * `policy.firstMs` times `policy.factor` to the power `attempts - 1`, never past `policy.maxMs`,
 * rounded to a whole millisecond.
 *
 * @example
 * ```ts
 * retryBackoff(3, DEFAULT_RETRY); // 4000
 * retryBackoff(3, { ...DEFAULT_RETRY, firstMs: 500, factor: 3 }); // 4500
 * ```
 */
export function retryBackoff(attempts: number, policy: RetryPolicy): number {
  const { firstMs, factor, maxMs } = policy;
  return Math.round(Math.min(firstMs * factor ** Math.max(0, attempts - 1), maxMs));
}

/**
 * How long a delivery waits before attempt number `attempts + 1`: the backoff, or the wait the
 * server asked for (`hintMs`, from a Retry-After) when that is longer, never past `policy.maxMs`
 * ({@link RETRY_MAX_MS} by default). With `jitter: "full"` the backoff is a random time between 0
 * and {@link retryBackoff}, drawn from `random` (a number from 0 up to 1, as `Math.random` gives).
 *
 * @example
 * ```ts
 * retryWait(1, undefined); // 1000
 * retryWait(1, 120_000); // 120000
 * retryWait(1, 3_600_000); // 300000
 * retryWait(3, undefined, { ...DEFAULT_RETRY, jitter: "full" }, () => 0.5); // 2000
 * ```
 */
export function retryWait(
  attempts: number,
  hintMs: number | undefined,
  policy: RetryPolicy = DEFAULT_RETRY,
  random: () => number = Math.random,
): number {
  const capped = retryBackoff(attempts, policy);
  const backoff = policy.jitter === "full" ? Math.round(random() * capped) : capped;
  return Math.min(Math.max(backoff, hintMs ?? 0), policy.maxMs);
}

/**
 * Why a delivery's retries ran out: it had its `limit` of attempts, or its next attempt would come
 * later than `maxAge` after it was queued.
 */
export type RetryExhaustion = "limit" | "maxAge";

/**
 * Whether a delivery that just failed attempt number `attempt` has run out of retries under
 * `policy`, and why: `undefined` while it may be tried again after `waitMs`. `ageMs` is how long
 * ago it was queued, or `undefined` when that is not known, which no `maxAge` can then fail.
 *
 * @example
 * ```ts
 * retryExhausted(3, 4_000, undefined, { ...DEFAULT_RETRY, limit: 3 }); // "limit"
 * retryExhausted(1, 1_000, 59_500, { ...DEFAULT_RETRY, maxAgeMs: 60_000 }); // "maxAge"
 * ```
 */
export function retryExhausted(
  attempt: number,
  waitMs: number,
  ageMs: number | undefined,
  policy: RetryPolicy,
): RetryExhaustion | undefined {
  if (policy.limit !== undefined && attempt >= policy.limit) return "limit";
  if (policy.maxAgeMs !== undefined && ageMs !== undefined && ageMs + waitMs > policy.maxAgeMs) {
    return "maxAge";
  }
  return undefined;
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
 * environment as it goes, and loading the modules it names: a custom source or destination, or an
 * MLLP source's ACK builder. Logs carry the channel, statuses and codes, never content.
 *
 * @throws {ConfigError} when a TLS file, a token or a secret header cannot be had.
 * @throws {ExtensionLoadError} when a module, its factory or what it returns is wrong.
 * @example
 * ```ts
 * const { source, destinations } = await connectorsFor(channel, { now: Date.now, logger, env: process.env });
 * ```
 */
export async function connectorsFor(
  channel: ChannelConfig,
  context: ConnectorContext,
): Promise<ChannelConnectors> {
  const { now, logger, env } = context;
  const file = `channels/${channel.name}/channel.yaml`;
  const extension = (fields: Readonly<Record<string, string | number>>): ChannelContext => ({
    channel: channel.name,
    format: channel.format,
    dir: channel.dir,
    env,
    logger: logger.child({ channel: channel.name, ...fields }),
  });
  const { source } = channel;
  let sourceConnector: SourceConnector;
  switch (source.kind) {
    case "file":
      sourceConnector = new FileSource({
        ...source,
        channel: channel.name,
        now,
        onReadError: (error) => {
          logger.warn({
            event: "source-read-failed",
            channel: channel.name,
            code: errorCode(error),
          });
        },
        // The reason and a code, never the file's name: a name can carry an identifier.
        onFileFault: ({ reason, moved, error }) => {
          logger.warn({
            event: "source-file-set-aside",
            channel: channel.name,
            reason,
            moved,
            code: errorCode(error),
          });
        },
      });
      break;
    case "http": {
      const { tls, token } = listenerSecurity(source, env, `${file}: source.http`);
      const { response } = source;
      sourceConnector = new HttpSource({
        host: source.host,
        port: source.port,
        paths: source.paths,
        methods: source.methods,
        response:
          response.kind === "fixed"
            ? {
                ...response,
                headers: resolveHeaders({}, response.headers, env, `${file}: source.http.response`),
              }
            : response,
        maxBytes: source.maxBytes,
        tls,
        token,
        onRefused: (status) => {
          logger.warn({ event: "http-refused", channel: channel.name, status });
        },
        onUnreadable: (message, problem) => {
          logger.warn({ event: "http-unreadable", channel: channel.name, message, problem });
        },
      });
      break;
    }
    case "mllp":
      sourceConnector = new MllpSource({
        host: source.host,
        port: source.port,
        tls:
          source.tls === undefined
            ? undefined
            : loadServerTls(source.tls, `${file}: source.mllp.tls`),
        onStoreFailure: source.onStoreFailure,
        ...(source.ackBuilder === undefined
          ? {}
          : {
              ackBuilder: await loadAckBuilder(
                source.ackBuilder,
                `${file}: source.mllp.ackBuilder`,
                channel.settings.timeoutMs,
              ),
            }),
        onEvent: ({ level, event, ...fields }) => {
          logger[level]({ event, channel: channel.name, ...fields });
        },
      });
      break;
    case "module":
      sourceConnector = await customSource(
        source,
        extension({ extension: "source" }),
        `${file}: source.module`,
      );
      break;
  }
  const destinations: DestinationConnector[] = [];
  for (const [index, destination] of channel.destinations.entries()) {
    switch (destination.kind) {
      case "file":
        destinations.push(
          new FileDestination({ dir: destination.dir, extension: EXTENSIONS[channel.format] }),
        );
        break;
      case "http": {
        const where = `${file}: destinations.${index}.http`;
        destinations.push(
          new HttpDestination({
            url: destination.url,
            headers: resolveHeaders(
              { "Content-Type": CONTENT_TYPES[channel.format] },
              destination.headers,
              env,
              where,
            ),
            timeoutMs: destination.timeoutMs,
            resendHeader: destination.resendHeader,
            now,
            ...(destination.tls === undefined
              ? {}
              : { tls: loadClientTls(destination.tls, `${where}.tls`) }),
          }),
        );
        break;
      }
      case "mllp":
        destinations.push(
          new MllpDestination({
            host: destination.host,
            port: destination.port,
            tls:
              destination.tls === undefined
                ? undefined
                : loadClientTls(destination.tls, `${file}: destinations.${index}.mllp.tls`),
            ackTimeoutMs: destination.ackTimeoutMs,
          }),
        );
        break;
      case "module":
        destinations.push(
          await customDestination(
            destination,
            extension({ extension: "destination", destination: index }),
            `${file}: destinations.${index}.module`,
          ),
        );
        break;
    }
  }
  return { source: sourceConnector, destinations };
}

/** What the engine runs on. */
export interface EngineOptions {
  readonly project: ProjectConfig;
  readonly store: MessageStore;
  readonly logger: Logger;
  /** Epoch milliseconds now. Tests pass their own clock. */
  readonly now?: () => number;
  /** A monotonic clock in milliseconds, for liveness. Defaults to `performance.now`. */
  readonly monotonic?: () => number;
  /** Builds a channel's connectors; by default, from its configuration. */
  readonly connectors?: (channel: ChannelConfig) => ChannelConnectors | Promise<ChannelConnectors>;
  /** Where tokens and secret headers are read from. Defaults to `process.env`. */
  readonly env?: Env;
  /**
   * The audit log the engine records retention runs in. Defaults to one over `store`, naming the
   * operating system user; pass one to share it, and its listeners, with other callers.
   */
  readonly audit?: AuditLog;
  /**
   * The engine lease this engine holds, when its store has leases: checked before each message is
   * taken in, transformed or sent, and its epoch carried by every write that records an outcome.
   * Without one the engine runs unfenced, as with a store that has no lease methods.
   */
  readonly fence?: EngineFence;
  /**
   * A number from 0 up to 1 for each retry with `jitter: "full"`. Defaults to `Math.random`; tests
   * pass their own.
   */
  readonly random?: () => number;
}

interface RunningChannel {
  readonly config: ChannelConfig;
  readonly worker: ChannelWorker;
  readonly connectors: ChannelConnectors;
  /** The channel's own hooks. */
  readonly hooks: HookSet;
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
 * - Each destination's retry settings (its own, its channel's, or the project's) set those waits,
 *   and may set a limit or an age past which the delivery is marked failed, its body kept, and the
 *   destination moves on; `rotate` lets later deliveries go ahead of one waiting, breaking order.
 * - Before each send, the delivery is marked with its attempt and start time; the outcome clears
 *   the mark. A delivery found still marked was cut off after the send, so it is sent again flagged
 *   as a possible duplicate (`OutgoingMessage.resend`), as is every later send of it.
 * - A message whose transform fails is marked failed, and the channel moves on to the next.
 * - A source that cannot listen (its port is taken) is tried again with the same growing waits,
 *   while the rest of the engine runs and the health endpoint answers 503.
 * - While it runs, retention deletes done messages past their channel's retention period, at
 *   start and then every `retentionInterval`, and records each run in the audit log.
 * - Given a fence (the engine lease), it checks the lease before it takes, transforms or sends a
 *   message, and every write of an outcome carries the lease's epoch: once the lease is lost, the
 *   next check or write throws a `LeaseLostError` and nothing more is taken or sent.
 *
 * Logs carry ids, counts and error names only: never a message's content, and never a file name,
 * which can carry a patient's name.
 *
 * Each step is also an event for the lifecycle hooks: the engine-wide ones in `pathways.yaml` and
 * the channel's own. Hooks never hold the engine up: each has its own queue and time limit.
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
  /**
   * The audit log the engine records in. Each entry, once stored, goes to the engine-wide hooks as
   * an `audit` event; subscribe to it to see them directly.
   */
  readonly audit: AuditLog;
  private readonly options: EngineOptions;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly channels: RunningChannel[] = [];
  /** When the engine loop last made a step, by the monotonic clock, while {@link run} runs. */
  private steppedAt: number | undefined;
  /** The last storage check for readiness: when it started and what it found. */
  private storageCheck: { readonly at: number; readonly reachable: Promise<boolean> } | undefined;
  /** The engine-wide hooks, from `pathways.yaml`, once started. */
  private hooks: HookSet | undefined;

  /** @param options The project, the store, the logger and, for tests, a clock and connectors. */
  constructor(options: EngineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.audit =
      options.audit ??
      new AuditLog(options.store, {
        onListenerError: (error) => {
          options.logger.warn({ event: "audit-listener-failed", code: errorCode(error) });
        },
      });
    // Every entry, the engine's own and those of whoever shares this log, goes to the engine-wide
    // hooks once they have started. Emitting only queues, so it never holds the engine up.
    this.audit.subscribe((entry) => {
      this.hooks?.emit(auditEvent(entry));
    });
  }

  /**
   * Starts the hooks and every channel. Rejects, having stopped any it started, if a transform will
   * not load, a connector's TLS files or secrets cannot be had (a `ConfigError`), or an extension
   * module is wrong (an `ExtensionLoadError`). A source that cannot listen does not stop the start:
   * it is logged, reported on the health endpoint, and tried again.
   */
  async start(): Promise<void> {
    const { project, logger } = this.options;
    const env = this.options.env ?? process.env;
    try {
      this.hooks = await HookSet.open(project.hooks, {
        file: "pathways.yaml",
        channel: undefined,
        dir: project.root,
        env,
        logger,
      });
      for (const config of project.channels) {
        const worker = new ChannelWorker({
          channel: config.name,
          transformFile: config.transform,
          format: config.format,
          timeoutMs: config.settings.timeoutMs,
          memoryMb: config.settings.memoryMb,
        });
        const hooks = await HookSet.open(config.hooks, {
          file: `channels/${config.name}/channel.yaml`,
          channel: config.name,
          dir: config.dir,
          env,
          logger,
        });
        let connectors: ChannelConnectors;
        try {
          connectors = await (this.options.connectors?.(config) ??
            connectorsFor(config, { now: this.now, logger, env }));
        } catch (error) {
          await hooks.stop();
          throw error;
        }
        const channel: RunningChannel = { config, worker, connectors, hooks, down: undefined };
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
      this.step();
      this.options.fence?.check();
      if (channel.down !== undefined && channel.down.nextAt <= this.now()) {
        await this.startSource(channel);
      }
      await channel.connectors.source.poll?.(this.sinkFor(channel));
      await this.transformAll(channel);
      await this.deliverAll(channel);
    }
  }

  /**
   * Runs passes until `signal` aborts, waiting the poll interval between them. Retention runs after
   * the first pass and then once every `retentionInterval`.
   */
  async run(signal: AbortSignal): Promise<void> {
    const { pollIntervalMs, retentionIntervalMs } = this.options.project.settings;
    let retentionAt = this.now();
    this.steppedAt = this.monotonic();
    try {
      while (!signal.aborted) {
        await this.tick();
        this.step();
        if (this.now() >= retentionAt) {
          await this.retention();
          this.step();
          retentionAt = this.now() + retentionIntervalMs;
        }
        await sleep(pollIntervalMs, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      this.steppedAt = undefined;
    }
  }

  /**
   * Liveness: false only while {@link run} runs and its loop has made no step for longer than
   * {@link livenessBoundMs}. Never false because a source cannot listen or a destination is down:
   * those are retried by the loop, which keeps stepping, and a restart would not fix them.
   */
  live(): boolean {
    if (this.steppedAt === undefined) return true;
    return this.monotonic() - this.steppedAt <= livenessBoundMs(this.options.project);
  }

  /**
   * Readiness, as far as the engine knows: false while a source cannot listen, or when storage
   * cannot be read. Storage is read at most once a second however often this is asked, and a read
   * that takes over 5 seconds counts as unreachable.
   */
  async ready(): Promise<boolean> {
    if (this.channels.some((channel) => channel.down !== undefined)) return false;
    const now = this.monotonic();
    if (this.storageCheck === undefined || now - this.storageCheck.at >= STORAGE_CHECK_EVERY_MS) {
      this.storageCheck = { at: now, reachable: this.readStorage() };
    }
    return this.storageCheck.reachable;
  }

  /** One cheap read: message 0, which no store numbers, by its key. True when it answers in time. */
  private async readStorage(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), STORAGE_CHECK_TIMEOUT_MS);
      timer.unref();
    });
    const read = this.options.store.message(0).then(
      () => true,
      () => false,
    );
    try {
      return await Promise.race([read, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Notes that the engine loop made a step, for liveness. */
  private step(): void {
    if (this.steppedAt !== undefined) this.steppedAt = this.monotonic();
  }

  /**
   * Runs retention once, records the run in the audit log, and logs the counts. A failure is logged
   * by its code and does not stop the engine; the next run tries again.
   */
  async retention(): Promise<RetentionReport | undefined> {
    const { store, project, logger } = this.options;
    try {
      // Each channel deleted is a step: a run over many channels is not a stall.
      const report = await runRetention(store, project, {
        now: this.now(),
        dryRun: false,
        onChannel: () => {
          this.step();
        },
      });
      await recordRetention(this.audit, report);
      logger.info({
        event: "retention",
        messages: report.messages,
        deliveries: report.deliveries,
      });
      return report;
    } catch (error) {
      logger.error({ event: "retention-failed", code: errorCode(error) });
      return undefined;
    }
  }

  /**
   * Stops every source that listens, then every worker and every destination's connections, then
   * the hooks, once each has had its time limit to work through the events still queued.
   */
  async stop(): Promise<void> {
    const channels = this.channels.splice(0);
    const hooks = this.hooks;
    this.hooks = undefined;
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
    await Promise.all([...channels.map((channel) => channel.hooks.stop()), hooks?.stop()]);
  }

  /**
   * Each channel's status and counts, for the health endpoint. Its `status` is `unavailable` only
   * when storage cannot be read or a source cannot listen. Holds counts and states, never content.
   */
  async health(): Promise<EngineHealth> {
    const { project, store } = this.options;
    const down = new Set(
      this.channels.filter((channel) => channel.down !== undefined).map((c) => c.config.name),
    );
    const source = (name: string): "up" | "down" => (down.has(name) ? "down" : "up");
    const channels: Record<string, ChannelHealth> = {};
    let storage: EngineHealth["storage"] = "ok";
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
    if (source.kind === "http") {
      for (const warning of listenerWarnings(source)) {
        logger.warn({ event: warning, channel: config.name, endpoint: "source" });
      }
    } else if (source.kind === "mllp" && source.plaintext) {
      // MLLP carries no credentials of its own: mutual TLS (tls.ca) is how a source checks who sends.
      logger.warn({ event: "plaintext", channel: config.name, endpoint: "source" });
    } else if (source.kind === "file" && source.keepProcessed) {
      // Each stored file stays in processed/ as it arrived: patient data outside the encrypted store.
      logger.warn({ event: "plaintext-copies", channel: config.name, endpoint: "source" });
    }
    for (const [index, destination] of config.destinations.entries()) {
      if ((destination.kind === "http" || destination.kind === "mllp") && destination.plaintext) {
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
      await source.start(this.sinkFor(channel));
    } catch (error) {
      const attempts = (channel.down?.attempts ?? 0) + 1;
      const wait = retryDelay(attempts);
      const code = errorCode(error);
      channel.down = { attempts, nextAt: this.now() + wait };
      logger.error({
        event: "source-start-failed",
        channel: channel.config.name,
        attempt: attempts,
        retryInMs: wait,
        code,
      });
      this.emit(channel, () => ({
        type: "source-down",
        at: this.at(),
        channel: channel.config.name,
        attempt: attempts,
        retryInMs: wait,
        retryAt: this.at(wait),
        name: errorName(error),
        code,
      }));
      return;
    }
    if (channel.down !== undefined) {
      channel.down = undefined;
      logger.info({ event: "source-started", channel: channel.config.name });
      this.emit(channel, () => ({
        type: "source-up",
        at: this.at(),
        channel: channel.config.name,
      }));
    }
  }

  /**
   * Hands an event to the channel's hooks and the engine-wide ones. Never waits, never throws. The
   * event is built only when some hook will be handed it.
   */
  private emit(channel: RunningChannel, event: () => LifecycleEvent): void {
    if (channel.hooks.empty && (this.hooks?.empty ?? true)) return;
    const built = event();
    channel.hooks.emit(built);
    this.hooks?.emit(built);
  }

  /** The epoch a write carries, as its last argument: none when the engine holds no lease. */
  private epoch(): [] | [number] {
    const epoch = this.options.fence?.epoch;
    return epoch === undefined ? [] : [epoch];
  }

  /** Now, or `inMs` from now, as an ISO 8601 time for an event. */
  private at(inMs = 0): string {
    return new Date(this.now() + inMs).toISOString();
  }

  private sinkFor(channel: RunningChannel): MessageSink {
    const { config } = channel;
    const { store, logger } = this.options;
    const sink: MessageSink = {
      receive: async (body, options = {}) => {
        const { duplicateKey, idempotencyKey, resumed, failure } = options;
        let received: ReceivedMessage;
        try {
          // An engine that lost its lease takes nothing more in: the source answers as it does
          // when a message cannot be stored, so the sender keeps it.
          this.options.fence?.check();
          received = await store.receive(config.name, body, {
            // Storage keeps a hash of each key, so a sender's identifiers and a file's name are not
            // stored.
            duplicateKey: hashed(duplicateKey),
            idempotencyKey: hashed(idempotencyKey),
            resumed,
            failure,
            size: body.byteLength,
          });
        } catch (error) {
          const code = errorCode(error);
          logger.error({ event: "receive-failed", channel: config.name, code });
          this.emit(channel, () => ({
            type: "receive-failed",
            at: this.at(),
            channel: config.name,
            name: errorName(error),
            code,
          }));
          throw error;
        }
        faultPoint("after-store-before-ack");
        this.step();
        if (received.alreadyStored === true) {
          // Handed in again after a stop between storing and acknowledging: stored once already.
          logger.info({ event: "already-stored", channel: config.name, message: received.id });
          return received.id;
        }
        logger.info({
          event: "received",
          channel: config.name,
          message: received.id,
          bytes: body.byteLength,
          ...(failure === undefined ? {} : { failed: true }),
        });
        this.emit(channel, () => ({
          type: "received",
          at: this.at(),
          channel: config.name,
          messageId: received.id,
          bytes: body.byteLength,
          failed: failure !== undefined,
          duplicateOf: received.duplicateOf,
        }));
        if (received.duplicateOf !== undefined) {
          logger.warn({
            event: "possible-duplicate",
            channel: config.name,
            message: received.id,
            duplicateOf: received.duplicateOf,
          });
        }
        return received.id;
      },
    };
    // A store that copies each body it stores makes a sink that keeps none, so a source may free a
    // body it is done with once it is stored.
    return copiesBodies(store) ? markCopiesBodies(sink) : sink;
  }

  private async transformAll(channel: RunningChannel): Promise<void> {
    const { config, worker } = channel;
    const { store, logger } = this.options;
    // A store that copies bodies hands each one over to whoever reads it, and keeps none it stores:
    // the body moves to the worker rather than being copied, and the outputs are freed once stored.
    const owned = copiesBodies(store);
    for (;;) {
      this.options.fence?.check();
      this.step();
      const next = await store.nextToTransform(config.name);
      if (next === undefined) return;
      const outcome: TransformOutcome = await worker.run(next.body, { transfer: owned });
      if (outcome.ok) {
        faultPoint("after-transform-before-complete");
        await store.completeTransform(
          next.id,
          outcome.outputs,
          config.destinations.length,
          ...this.epoch(),
        );
        if (owned) for (const output of outcome.outputs) release(output);
        const outputs = outcome.outputs.length;
        logger.info({
          event: outputs === 0 ? "filtered" : "transformed",
          channel: config.name,
          message: next.id,
          outputs,
        });
        const messageId = next.id;
        this.emit(channel, () => {
          const base = { at: this.at(), channel: config.name, messageId };
          return outputs === 0
            ? { type: "filtered", ...base }
            : { type: "transformed", ...base, outputs };
        });
      } else {
        await store.failTransform(next.id, storedFailure(outcome.failure), ...this.epoch());
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
        this.emit(channel, () => ({
          type: "transform-failed",
          at: this.at(),
          channel: config.name,
          messageId: next.id,
          kind,
          name,
          code,
          where,
        }));
      }
    }
  }

  /**
   * How long ago a message's current deliveries were queued (its transform, replay or resend), when
   * `policy` has a `maxAge` and the store says; otherwise `undefined`. Read only after a failure.
   */
  private async ageOf(messageId: number, policy: RetryPolicy): Promise<number | undefined> {
    if (policy.maxAgeMs === undefined) return undefined;
    const message = await this.options.store.message(messageId);
    const queued = message === undefined ? Number.NaN : Date.parse(message.updatedAt);
    return Number.isNaN(queued) ? undefined : Math.max(0, this.now() - queued);
  }

  private async deliverAll(channel: RunningChannel): Promise<void> {
    const { config, connectors } = channel;
    const { store, logger } = this.options;
    for (const [index, destination] of connectors.destinations.entries()) {
      const policy = config.destinations[index]?.retry ?? config.settings.retry;
      // With rotate, a delivery waiting for a retry steps aside for the due ones behind it; each is
      // tried once a pass, so a retry due at once waits for the next pass.
      const tried = new Set<number>();
      for (;;) {
        this.step();
        const delivery = await (policy.rotate
          ? store.nextDelivery(config.name, index, { dueBy: this.now() })
          : store.nextDelivery(config.name, index));
        if (delivery === undefined || delivery.nextAttemptAt > this.now()) break;
        if (tried.has(delivery.id)) break;
        tried.add(delivery.id);
        // Still marked: an attempt was handed over and its outcome never recorded, so it counts.
        const interrupted = delivery.sending?.attempt;
        const attempt = (interrupted ?? delivery.attempts) + 1;
        const flagged = interrupted ?? delivery.interruptedAttempt;
        const resend = flagged === undefined ? undefined : { previousAttempts: attempt - 1 };
        const about = {
          channel: config.name,
          messageId: delivery.messageId,
          destination: index,
          deliveryId: delivery.id,
          attempt,
          ...(resend === undefined ? {} : { resend }),
        };
        if (interrupted !== undefined) {
          logger.warn({
            event: "possible-duplicate",
            channel: config.name,
            message: delivery.messageId,
            delivery: delivery.id,
            destination: index,
            reason: "send-interrupted",
            interruptedAttempt: interrupted,
          });
        }
        // An engine that lost its lease, or was paused past it, sends nothing more.
        this.options.fence?.check();
        // With `resendFlag: false` no marker is written, so a crash after this send goes unflagged;
        // the one cut off is still noted, so a delivery already found marked keeps its flag.
        if (config.settings.resendFlag || interrupted !== undefined) {
          await store.markSending(
            delivery.id,
            {
              attempt,
              at: this.now(),
              ...(interrupted === undefined ? {} : { interruptedAttempt: interrupted }),
            },
            ...this.epoch(),
          );
        }
        try {
          await destination.deliver({
            messageId: delivery.messageId,
            seq: delivery.seq,
            body: delivery.body,
            ...(resend === undefined ? {} : { resend }),
          });
        } catch (error) {
          if (error instanceof DeliveryRejected) {
            await store.failDelivery(delivery.id, `rejected: ${error.reason}`, ...this.epoch());
            logger.warn({
              event: "delivery-rejected",
              channel: config.name,
              destination: index,
              delivery: delivery.id,
              reason: error.reason,
            });
            this.emit(channel, () => ({
              type: "delivery-rejected",
              at: this.at(),
              ...about,
              reason: error.reason,
            }));
            continue;
          }
          const attempts = attempt;
          const code = errorCode(error);
          const held = error instanceof RedirectHeld ? error : undefined;
          const hint = error instanceof RetryableError ? error.retryAfterMs : undefined;
          // Held, never followed: tried again at the longest wait, while an operator fixes the URL.
          const wait =
            held === undefined
              ? retryWait(attempts, hint, policy, this.options.random)
              : policy.maxMs;
          const failure = `delivery: ${code ?? "error"}`;
          const exhausted = retryExhausted(
            attempts,
            wait,
            await this.ageOf(delivery.messageId, policy),
            policy,
          );
          if (exhausted !== undefined) {
            // Out of retries: failed, its body kept for an operator to resend, and the queue moves on.
            await store.failDelivery(
              delivery.id,
              `exhausted (${exhausted}, ${String(attempts)} attempts): ${failure}`,
              ...this.epoch(),
            );
            logger.warn({
              event: "delivery-exhausted",
              channel: config.name,
              destination: index,
              delivery: delivery.id,
              attempt: attempts,
              reason: exhausted,
              code,
            });
            this.emit(channel, () => ({
              type: "delivery-exhausted",
              at: this.at(),
              ...about,
              reason: exhausted,
              name: errorName(error),
              code,
            }));
            continue;
          }
          await store.scheduleRetry(
            delivery.id,
            attempts,
            this.now() + wait,
            failure,
            ...this.epoch(),
          );
          if (held !== undefined) {
            const { status, locationHost } = held;
            logger.warn({
              event: "delivery-redirected",
              channel: config.name,
              destination: index,
              delivery: delivery.id,
              attempt: attempts,
              retryInMs: wait,
              status,
              locationHost,
            });
            this.emit(channel, () => ({
              type: "delivery-redirected",
              at: this.at(),
              ...about,
              retryInMs: wait,
              retryAt: this.at(wait),
              status,
              locationHost,
            }));
          } else {
            logger.warn({
              event: "delivery-retry",
              channel: config.name,
              destination: index,
              delivery: delivery.id,
              attempt: attempts,
              retryInMs: wait,
              code,
            });
            this.emit(channel, () => ({
              type: "delivery-retry",
              at: this.at(),
              ...about,
              retryInMs: wait,
              retryAt: this.at(wait),
              name: errorName(error),
              code,
            }));
          }
          // In order, later deliveries wait behind this one; with rotate they go ahead of it.
          if (policy.rotate) continue;
          break;
        }
        // Delivered: freed now when the store handed it over and the destination kept none of it.
        if (copiesBodies(store) && copiesBodies(destination)) release(delivery.body);
        faultPoint("after-send-before-record");
        await store.markDelivered(delivery.id, ...this.epoch());
        logger.info({
          event: "delivered",
          channel: config.name,
          destination: index,
          delivery: delivery.id,
          ...(resend === undefined ? {} : { resend }),
        });
        this.emit(channel, () => ({ type: "delivered", at: this.at(), ...about }));
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

/** An error's name, or the type of what was thrown when it is not an error: never its text. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A key's SHA-256 in hex, as storage keeps it, or undefined when there is no key. */
function hashed(key: string | undefined): string | undefined {
  return key === undefined ? undefined : createHash("sha256").update(key).digest("hex");
}
