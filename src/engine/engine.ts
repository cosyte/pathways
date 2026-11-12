import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "pino";

import { ConfigError } from "../config/load.js";
import {
  DEFAULT_DELIVERY_TIMEOUT_MS,
  DEFAULT_RETRY,
  type ChannelConfig,
  type DestinationConfig,
  type Format,
  type ProjectConfig,
  type RetryPolicy,
  type SftpConfig,
  type TransformConfigBlock,
} from "../config/schema.js";
import { resolveTransformConfig } from "../config/transform-config.js";
import {
  listenerSecurity,
  listenerWarnings,
  resolveHeaders,
  type Env,
} from "../connectors/endpoint.js";
import { FileDestination, FileSource } from "../connectors/file.js";
import { KnownHosts, pinnedKey } from "../connectors/known-hosts.js";
import { SftpLocation } from "../connectors/sftp.js";
import { HttpDestination, HttpSource } from "../connectors/http.js";
import { RedirectHeld, RetryableError } from "../connectors/http-core.js";
import { MllpDestination, MllpSource } from "../connectors/mllp.js";
import { loadMllpClientTls, loadMllpServerTls } from "../connectors/mllp-tls.js";
import {
  TcpDestination,
  TcpSource,
  type TcpReplyBuilder,
  type TcpReplyCheck,
} from "../connectors/tcp.js";
import { framingOf } from "../connectors/tcp-framing.js";
import { loadClientTls, loadServerTls } from "../connectors/tls.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
  type SourceConnector,
} from "../connectors/types.js";
import {
  customDestination,
  customSource,
  loadAckBuilder,
  loadTcpFunction,
} from "../extensions/build.js";
import { faultPoint } from "../fault-points.js";
import type { LifecycleEvent } from "../extensions/events.js";
import { HookSet } from "../extensions/hooks.js";
import type { ChannelContext } from "../extensions/types.js";
import { AuditLog, auditEvent } from "../operator/audit.js";
import { resolveSecrets, type Secrets, secretsOf } from "../secrets/resolve.js";
import type { KeyProvider } from "../encryption/keys.js";
import { recordRetention, runRetention, type RetentionReport } from "../operator/retention.js";
import { copiesBodies, markCopiesBodies, release } from "../storage/ownership.js";
import {
  channelStateStore,
  type AuditAction,
  type ChannelRunState,
  type MessageStore,
  type ReceivedMessage,
} from "../storage/store.js";
import type { SourceFacts } from "../transform.js";
import { ChannelWorker, TransformLoadError, type TransformOutcome } from "./channel-worker.js";
import type { EngineFence } from "./lease.js";
import { channelStatus, type ChannelHealth, type EngineHealth } from "./health.js";
import { formatTable, type FailureSummary } from "./worker-entry.js";
import { DeadlineTimer } from "./deadline.js";
import { nextPollAt, pollOf } from "./schedule.js";
import { copyFacts, keepFacts, sourceFacts } from "./source-facts.js";

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
 * How long one delivery to `destination` may take in all (connecting, sending and waiting for the
 * receiver to confirm) before the engine cuts it off and counts the attempt as failed, to be
 * retried: an HTTP destination's `timeout` plus a second, twice an MLLP destination's `ackTimeout`
 * (one to connect, one for the ACK) plus a second, twice a tcp destination's `timeout` (one to
 * connect, one for the send and its reply) plus a second, and a file or module destination's `timeout`,
 * 30 seconds by default. The second of grace lets the destination's own timeout, with its code,
 * come first.
 *
 * @example
 * ```ts
 * deliveryDeadlineMs({ kind: "file", dir: "/srv/out" }); // 30000
 * ```
 */
export function deliveryDeadlineMs(destination: DestinationConfig | undefined): number {
  if (destination?.kind === "http") return destination.timeoutMs + 1_000;
  if (destination?.kind === "mllp") return 2 * destination.ackTimeoutMs + 1_000;
  if (destination?.kind === "tcp") return 2 * destination.timeoutMs + 1_000;
  return destination?.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
}

/**
 * How long the engine loop may go without a step before liveness answers `stalled`: 60 seconds,
 * plus the poll interval, plus the longest time limit one step can take. A step is a message taken
 * in by a polled source, one transform, one delivery attempt, a channel's turn in a pass, or one
 * channel of a retention run. The longest step is the longest of each channel's transform timeout
 * and each destination's {@link deliveryDeadlineMs}. A polled source's pass runs beside the loop,
 * cut off at its own deadline, so it holds no step up. One channel's retention delete has no time
 * limit: one that takes longer than the bound (a very large backlog past its retention period)
 * makes liveness say stalled until it is done.
 *
 * @example
 * ```ts
 * livenessBoundMs(project); // 92000 with a 1s poll interval and HTTP destinations at 30s
 * ```
 */
export function livenessBoundMs(project: ProjectConfig): number {
  let longest = 0;
  for (const channel of project.channels) {
    longest = Math.max(longest, channel.settings.timeoutMs);
    for (const destination of channel.destinations) {
      longest = Math.max(longest, deliveryDeadlineMs(destination));
    }
  }
  return LIVE_GRACE_MS + project.settings.pollIntervalMs + longest;
}

/**
 * Waits `ms`, or until `signal` aborts, whichever comes first; never rejects. The engine waits with
 * one for its loop, a pass's deadline and a delivery's; tests pass their own clock's.
 *
 * @example
 * ```ts
 * const wait: EngineWait = (ms, signal) => clock.sleep(ms, signal);
 * ```
 */
export type EngineWait = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * {@link EngineWait} on Node's timers, a longer wait than one holds cut to the longest it does. A
 * delivery's deadline is kept in full all the same: its {@link DeadlineTimer} arms again until the
 * deadline is due, so a `timeout` longer than 24 days cuts an attempt off at that time, not at 24.
 */
const realWait: EngineWait = (ms, signal) =>
  sleep(Math.min(ms, MAX_STOP_DEADLINE_MS), undefined, { signal }).catch(() => undefined);

/** A code a source reports with `sourceDown`, kept only when it is shaped as a code. */
const SOURCE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Why a delivery was cut off at its deadline: its code, `DELIVERY_TIMEOUT`, is what the retry
 * records and logs.
 */
class DeliveryTimeout extends Error {
  readonly code = "DELIVERY_TIMEOUT";

  constructor(ms: number) {
    super(`the delivery took longer than ${String(ms)}ms`);
    this.name = "DeliveryTimeout";
  }
}

/** What a sink refuses a message with once its pass was cut off at its deadline. */
class PassCut extends Error {
  readonly code = "POLL_DEADLINE";

  constructor() {
    super("the pass was cut off at its deadline");
    this.name = "PassCut";
  }
}

/** Readiness reads storage at most this often; a probe in between is told the last answer. */
const STORAGE_CHECK_EVERY_MS = 1_000;
/** A storage read for readiness that takes longer than this counts as storage unreachable. */
const STORAGE_CHECK_TIMEOUT_MS = 5_000;

/**
 * The file extension a file destination writes for each format, from the format registry.
 *
 * @example
 * ```ts
 * EXTENSIONS.fhir; // "json"
 * ```
 */
export const EXTENSIONS: Readonly<Record<Format, string>> = formatTable("extension");

/**
 * The `Content-Type` an HTTP destination sends for each format, unless its headers set one, from
 * the format registry.
 *
 * @example
 * ```ts
 * CONTENT_TYPES.fhir; // "application/fhir+json"
 * ```
 */
export const CONTENT_TYPES: Readonly<Record<Format, string>> = formatTable("contentType");

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
  /** Where tokens and secret headers are read from, and what extensions are given as `env`. */
  readonly env: Env;
  /** Every destination runs dry, as `pathways start --dry-run` asks, whatever its block says. */
  readonly dryRun?: boolean | undefined;
  /** The secrets a start resolved; `env` alone without them. */
  readonly secrets?: Secrets | undefined;
}

/**
 * The connector a destination that runs dry gets in place of its own: nothing is built for it, so no
 * TLS file, secret or module is read and no connection is opened. The engine never hands it a
 * message; a send that reached it would be a defect, so it rejects rather than drop one quietly.
 */
const DRY_RUN_CONNECTOR: DestinationConnector = {
  deliver: () => Promise.reject(new Error("a destination that runs dry was handed a message")),
};

/**
 * Whether destination `index` of `channel` runs dry: its block sets `dryRun: true`, or the engine
 * runs every destination dry.
 *
 * @example
 * ```ts
 * runsDry(channel, 0, false); // true when channel.yaml's first destination sets dryRun: true
 * ```
 */
export function runsDry(channel: ChannelConfig, index: number, all: boolean): boolean {
  return all || channel.destinations[index]?.dryRun === true;
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
  const secrets = context.secrets ?? env;
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
        ...(source.sftp === undefined
          ? {}
          : {
              location: sftpLocation(source.sftp, secretsOf(secrets), `${file}: source.file.sftp`),
            }),
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
      const { tls, token } = listenerSecurity(source, secrets, `${file}: source.http`);
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
                headers: resolveHeaders(
                  {},
                  response.headers,
                  secrets,
                  `${file}: source.http.response`,
                ),
              }
            : response,
        maxBytes: source.maxBytes,
        contextHeaders: source.contextHeaders,
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
            : loadMllpServerTls(source.tls, secretsOf(secrets), `${file}: source.mllp.tls`),
        maxConnections: source.maxConnections,
        receiveTimeoutMs: source.receiveTimeoutMs,
        maxMessageSize: source.maxMessageSize,
        keepOpen: source.keepOpen,
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
    case "tcp": {
      const { reply } = source;
      sourceConnector = new TcpSource({
        host: source.host,
        port: source.port,
        tls:
          source.tls === undefined
            ? undefined
            : loadServerTls(source.tls, `${file}: source.tcp.tls`),
        framing: framingOf(source.framing),
        maxConnections: source.maxConnections,
        maxMessageSize: source.maxMessageSize,
        idleTimeoutMs: source.idleTimeoutMs,
        stallTimeoutMs: source.stallTimeoutMs,
        reply:
          reply === undefined
            ? undefined
            : reply.kind === "fixed"
              ? Buffer.from(reply.hex, "hex")
              : await loadTcpFunction<TcpReplyBuilder>(
                  reply.module,
                  `${file}: source.tcp.reply.builder`,
                  "a reply builder",
                  channel.settings.timeoutMs,
                ),
        onEvent: ({ level, event, ...fields }) => {
          logger[level]({ event, channel: channel.name, ...fields });
        },
      });
      break;
    }
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
    if (runsDry(channel, index, context.dryRun === true)) {
      destinations.push(DRY_RUN_CONNECTOR);
      continue;
    }
    switch (destination.kind) {
      case "file":
        destinations.push(
          new FileDestination({
            dir: destination.dir,
            extension: EXTENSIONS[channel.format],
            ...(destination.sftp === undefined
              ? {}
              : {
                  location: sftpLocation(
                    destination.sftp,
                    secretsOf(secrets),
                    `${file}: destinations.${index}.file.sftp`,
                  ),
                }),
          }),
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
              secrets,
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
                : loadMllpClientTls(
                    destination.tls,
                    secretsOf(secrets),
                    `${file}: destinations.${index}.mllp.tls`,
                  ),
            ackTimeoutMs: destination.ackTimeoutMs,
          }),
        );
        break;
      case "tcp": {
        const where = `${file}: destinations.${index}.tcp`;
        destinations.push(
          new TcpDestination({
            host: destination.host,
            port: destination.port,
            tls:
              destination.tls === undefined
                ? undefined
                : loadClientTls(destination.tls, `${where}.tls`),
            framing: framingOf(destination.framing),
            maxMessageSize: destination.maxMessageSize,
            timeoutMs: destination.timeoutMs,
            expectReply: destination.expectReply,
            ...(destination.replyCheck === undefined
              ? {}
              : {
                  replyCheck: await loadTcpFunction<TcpReplyCheck>(
                    destination.replyCheck,
                    `${where}.replyCheck`,
                    "a reply check",
                    channel.settings.timeoutMs,
                  ),
                }),
          }),
        );
        break;
      }
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
   * The secrets a start resolved, which tokens and secret headers are read from. Without them, the
   * engine resolves its project's at start.
   */
  readonly secrets?: Secrets | undefined;
  /**
   * The project's encryption keys, which seal retention's archives when `retention.archive` is set.
   * Without them, a channel retention would archive is left alone, and its code logged.
   */
  readonly keys?: KeyProvider | undefined;
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
   * Runs every destination dry, as `pathways start --dry-run` does: each output is transformed and
   * recorded, its delivery marked `dry-run`, and nothing is sent. A destination whose block sets
   * `dryRun: true` runs dry without it.
   */
  readonly dryRun?: boolean;
  /**
   * A number from 0 up to 1 for each retry with `jitter: "full"`. Defaults to `Math.random`; tests
   * pass their own.
   */
  readonly random?: () => number;
  /**
   * How the engine waits: between passes, and for a pass's or a delivery's deadline. Defaults to
   * Node's timers; tests pass their own clock's, with `now` from the same clock.
   */
  readonly wait?: EngineWait;
}

interface RunningChannel {
  /** Replaced by a reload, between messages. */
  config: ChannelConfig;
  /** Replaced by a reload, between messages. */
  worker: ChannelWorker;
  readonly connectors: ChannelConnectors;
  /** The channel's own hooks. */
  readonly hooks: HookSet;
  /** Set while the channel's source cannot listen: how often it has failed and when to try next. */
  down: { readonly attempts: number; readonly nextAt: number } | undefined;
  /** What an operator set it to: a paused or stopped channel's source is closed. */
  state: ChannelRunState;
  /** The state storage last held, as far as this engine knows: what a failed write goes back to. */
  stored: ChannelRunState;
  /** This engine's state writes under way: a pass applies no state it read meanwhile. */
  writing: number;
  /** Counts this engine's state changes, so a pass can tell its read is older than one of them. */
  changes: number;
  /** The state writes, one after another, so storage ends on the last state set here. */
  writes: Promise<unknown>;
  /** Whether its listening source was started and not closed since. */
  open: boolean;
  /**
   * Its source's starts and stops, one after another, each matching the source to the state as it
   * is when that one runs: two commands at once never leave a paused source listening.
   */
  sourcing: Promise<unknown>;
  /** Set while its source polls, until the pass ends or is cut off, so a pause can wait for it. */
  polling: Promise<void> | undefined;
  /**
   * Set while the source's own `poll` call has not returned, a pass cut off at its deadline among
   * them: no pass starts meanwhile, so a pass never overlaps itself.
   */
  inFlight: Promise<void> | undefined;
  /** Aborted to cut the source's pass under way off, and set while it runs. */
  cut: AbortController | undefined;
  /** While {@link Engine.run} runs: when the source's next pass is due, `Infinity` for never. */
  nextPollAt: number;
  /** Set while a running source says it lost its connection: how often in a row, and the code. */
  lost: { readonly attempts: number; readonly code: string } | undefined;
  /** Set while a pass works on this channel, so a stop can wait for it. */
  busy: Promise<void> | undefined;
  /** Aborted by a halt, to cut off the delivery in flight; replaced once used. */
  halt: AbortController;
  /** Set while a stop waits for the channel's work in flight: a reload is refused meanwhile. */
  draining: boolean;
  /** The reloads, one after another. */
  reloads: Promise<unknown>;
  /**
   * What the source knew about each message it took in that waits for its transform, by message id:
   * in memory only, dropped once the message is transformed, and bounded: past the bound the oldest
   * go, and those messages are transformed with no source facts.
   */
  readonly facts: Map<number, SourceFacts>;
  /**
   * Each `sink.receive` under way, settled once its message's facts are set or it failed: a pass that
   * takes a message whose facts are not set yet waits for these before it runs the transform.
   */
  readonly receiving: Set<Promise<void>>;
}

/**
 * The commands `pathways channel` gives a running engine through its control socket.
 *
 * @example
 * ```ts
 * const command: ChannelCommand = "pause";
 * ```
 */
export type ChannelCommand = "pause" | "resume" | "stop" | "halt" | "reload";

/**
 * What a channel command did: the channel's state after it and, for `stop` and `halt`, what it
 * left. States and counts only, never content.
 *
 * - `drained`: `stop` and `halt` only, whether the work in flight ended within the deadline.
 * - `left`: messages still to transform and deliveries still to send, which run after a resume.
 * - `refused`: why nothing was done: `no-such-channel`, `draining` (a stop is under way, for a
 *   reload), `invalid-config` (the configuration does not load, or a `config:` value names an
 *   environment variable that is not set), `not-configured` (the channel is gone from the
 *   configuration),
 *   `needs-restart` (with `changed`: the settings a reload cannot apply, such as `source`),
 *   `transform-load-failed` (with `failure`: the error's name, never its text), or
 *   `state-not-stored` (a pause, resume, stop or halt the database did not store: the channel was
 *   put back to the state storage holds, given in `state`; a halt's cut-off delivery stays
 *   pending).
 *
 * @example
 * ```ts
 * const report: ChannelCommandReport = { channel: "adt", state: "paused" };
 * ```
 */
export interface ChannelCommandReport {
  readonly channel: string;
  readonly state?: ChannelRunState;
  readonly drained?: boolean;
  readonly left?: { readonly toTransform: number; readonly toDeliver: number };
  readonly refused?:
    | "no-such-channel"
    | "draining"
    | "invalid-config"
    | "not-configured"
    | "needs-restart"
    | "transform-load-failed"
    | "state-not-stored";
  readonly changed?: readonly string[];
  readonly failure?: string;
}

/** How long `stop` waits for a channel's work in flight, unless told otherwise. */
export const STOP_DEADLINE_MS = 30_000;

/**
 * The longest a `stop` waits for a channel's work in flight: 24 days, inside the longest wait a
 * Node timer holds (2^31 - 1 ms, about 24.8 days). A longer one is waited as this.
 */
export const MAX_STOP_DEADLINE_MS = 24 * 24 * 60 * 60 * 1000;

/** The parts of a channel's configuration a reload cannot change: they need the engine restarted. */
const RESTART_ONLY = ["source", "destinations", "format", "hooks"] as const;

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
 * - A destination that runs dry (`dryRun: true` in its block, or the `dryRun` option for all) gets
 *   each output transformed and recorded as any other, and its delivery is marked `dry-run` in
 *   place of the send: no connector is built for it and no connection is opened.
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
  /** The environment the engine started with: a reload reads the transform's configuration from it. */
  private env: Env = process.env;
  private readonly wait: EngineWait;
  /**
   * Set while {@link run} runs: aborted to wake its loop when a pass ends, and the first failure of
   * a pass that ran beside it, which ends the run.
   */
  private schedule: { wake: AbortController; failure: { error: unknown } | undefined } | undefined;

  /** @param options The project, the store, the logger and, for tests, a clock and connectors. */
  constructor(options: EngineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.wait = options.wait ?? realWait;
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
   * not load, its configuration names an environment variable that is not set, a connector's TLS
   * files or secrets cannot be had (each a `ConfigError`), or an extension module is wrong (an
   * `ExtensionLoadError`). A source that cannot listen does not stop the start:
   * it is logged, reported on the health endpoint, and tried again.
   */
  async start(): Promise<void> {
    const { project, logger } = this.options;
    const env = this.options.env ?? process.env;
    this.env = env;
    const dryRun = this.options.dryRun === true;
    if (this.options.store.markDryRun === undefined) {
      const dry = project.channels.filter((channel) =>
        channel.destinations.some((_, index) => runsDry(channel, index, dryRun)),
      );
      if (dry.length > 0) {
        throw new ConfigError([
          `${dry.map((channel) => `channels/${channel.name}/channel.yaml`).join(", ")}: a destination runs dry, and the store has no markDryRun to record it`,
        ]);
      }
    }
    this.logDryDestinations(dryRun);
    try {
      const stored = await this.readStates();
      const secrets =
        this.options.secrets ??
        (await resolveSecrets(project, { env, logger, skipDry: dryRun ? "all" : "each" }, "all"));
      this.hooks = await HookSet.open(project.hooks, {
        file: "pathways.yaml",
        channel: undefined,
        dir: project.root,
        env,
        logger,
        secrets,
      });
      this.checkContentPolicies();
      for (const config of project.channels) {
        const worker = new ChannelWorker({
          channel: config.name,
          transformFile: config.transform,
          format: config.format,
          csv: config.csv,
          timeoutMs: config.settings.timeoutMs,
          memoryMb: config.settings.memoryMb,
          // Read here, in the engine's process, so a worker never sees the environment.
          config: resolveTransformConfig(project.config, config, env),
        });
        const hooks = await HookSet.open(config.hooks, {
          file: `channels/${config.name}/channel.yaml`,
          channel: config.name,
          dir: config.dir,
          env,
          logger,
          secrets,
        });
        let connectors: ChannelConnectors;
        try {
          connectors = await (this.options.connectors?.(config) ??
            connectorsFor(config, { now: this.now, logger, env, secrets, dryRun }));
        } catch (error) {
          await hooks.stop();
          throw error;
        }
        const channel: RunningChannel = {
          config,
          worker,
          connectors,
          hooks,
          down: undefined,
          state: stored?.[config.name] ?? "running",
          stored: stored?.[config.name] ?? "running",
          writing: 0,
          changes: 0,
          writes: Promise.resolve(),
          open: false,
          sourcing: Promise.resolve(),
          polling: undefined,
          inFlight: undefined,
          cut: undefined,
          nextPollAt: 0,
          lost: undefined,
          busy: undefined,
          halt: new AbortController(),
          draining: false,
          reloads: Promise.resolve(),
          facts: new Map(),
          receiving: new Set(),
        };
        this.channels.push(channel);
        this.warnInsecure(config);
        await this.warnDryBacklog(config);
        await worker.start();
        // A channel paused or stopped before this start stays so: its source is not opened.
        if (channel.state === "running") await this.matchSource(channel);
        else logger.info({ event: "channel-state", channel: config.name, state: channel.state });
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /**
   * Refuses to start when a channel drops content after delivery and the store cannot: it would
   * keep every body the channel's configuration says it drops.
   */
  private checkContentPolicies(): void {
    const { project, store } = this.options;
    if (typeof store.markDeliveredAndDropContent === "function") return;
    const problems = project.channels
      .filter((channel) => channel.settings.content === "dropAfterDelivery")
      .map(
        (channel) =>
          `channels/${channel.name}/channel.yaml: storage.content: dropAfterDelivery needs a store that can drop content after delivery (markDeliveredAndDropContent), and this one cannot`,
      );
    if (problems.length > 0) throw new ConfigError(problems);
  }

  /**
   * Says once at start which destinations of each channel run dry, by index, so a destination left
   * out of the line is one that sends. Nothing is said when none runs dry.
   */
  private logDryDestinations(all: boolean): void {
    const channels: Record<string, number[]> = {};
    for (const channel of this.options.project.channels) {
      const dry = channel.destinations.flatMap((_, index) =>
        runsDry(channel, index, all) ? [index] : [],
      );
      if (dry.length > 0) channels[channel.name] = dry;
    }
    if (Object.keys(channels).length === 0) return;
    this.options.logger.warn({ event: "dry-run-destinations", channels });
  }

  /**
   * Warns when a channel with a destination that runs dry already has pending deliveries: each one of
   * a dry destination is marked `dry-run` at its next pass, those queued, retrying or cut off
   * mid-send before dry run was turned on too, and is not sent until `pathways replay --resend`.
   * `pending` counts the channel's pending deliveries, of every destination.
   */
  private async warnDryBacklog(config: ChannelConfig): Promise<void> {
    const all = this.options.dryRun === true;
    const destinations = config.destinations.flatMap((_, index) =>
      runsDry(config, index, all) ? [index] : [],
    );
    if (destinations.length === 0) return;
    const { pending } = await this.options.store.deliveryCounts(config.name);
    if (pending === 0) return;
    this.options.logger.warn({
      event: "dry-run-pending",
      channel: config.name,
      destinations,
      pending,
    });
  }

  /**
   * One pass over every channel: take in, transform, deliver. It first reads each channel's state
   * from storage, so a pause, a resume or a stop given to another engine on the same database
   * takes effect here within one pass. A paused channel's source takes nothing in while its stored
   * messages go on through the transform and delivery; a stopped channel does nothing.
   */
  async tick(): Promise<void> {
    await this.passes("all");
  }

  /**
   * One pass over every channel. With `all` (a {@link tick}), each polled source is polled and its
   * pass waited for, up to its deadline; with `due` (in {@link run}), a source is polled only when
   * its pass is due, and the pass runs beside the loop; with `none` (the end of a run), no source is
   * polled, and what was taken in goes on through the transform and delivery.
   */
  private async passes(polls: "all" | "due" | "none"): Promise<void> {
    await this.syncStates();
    for (const channel of this.channels) {
      this.step();
      this.options.fence?.check();
      if (channel.state === "stopped") continue;
      const pass = this.pass(channel, polls);
      channel.busy = settled(pass);
      try {
        await pass;
      } finally {
        channel.busy = undefined;
      }
    }
  }

  /** The state of each running channel, by name. */
  channelStates(): Record<string, ChannelRunState> {
    return Object.fromEntries(this.channels.map((c) => [c.config.name, c.state]));
  }

  /**
   * Gives one channel a command, records it in the audit log naming `actor`, and says what it did.
   *
   * - `pause`: the source stops taking messages in (a listening one closes); stored messages go on
   *   through the transform and delivery.
   * - `resume`: the channel runs again, its source reopened.
   * - `stop`: pauses, stops transforming and delivering after the message in hand, waits up to
   *   `deadlineMs` for that, and reports what it left.
   * - `halt`: as `stop`, but cuts off the delivery in flight at once, leaving it pending to be
   *   sent again after a resume.
   * - `reload`: swaps in `config`'s transform and settings, between messages, once a fresh worker
   *   has loaded it; see {@link ChannelCommandReport} for when it is refused.
   *
   * The state is kept in storage when the store can, so a restart and every engine on the same
   * database honour it.
   */
  async command(
    command: ChannelCommand,
    name: string,
    options: {
      readonly actor: string;
      readonly deadlineMs?: number;
      /** For `reload`: the channel's new configuration, or why there is none. */
      readonly config?: ChannelConfig | "invalid-config" | "not-configured";
      /**
       * For `reload`: the project's `config:` block as the reload read it, under the channel's own;
       * the one the engine started with when not given.
       */
      readonly transformConfig?: TransformConfigBlock;
    },
  ): Promise<ChannelCommandReport> {
    const channel = this.channels.find((c) => c.config.name === name);
    const report =
      channel === undefined
        ? { channel: name, refused: "no-such-channel" as const }
        : await this.commandOn(channel, command, options);
    // A refusal is recorded too, the command for a channel this engine does not run among them.
    await this.audit.recordAs(options.actor, {
      action: `channel-${command}` satisfies AuditAction,
      outcome: report.refused === undefined ? "ok" : "refused",
      channel: name,
      detail: auditDetail(report),
    });
    return report;
  }

  private async commandOn(
    channel: RunningChannel,
    command: ChannelCommand,
    options: Parameters<Engine["command"]>[2],
  ): Promise<ChannelCommandReport> {
    const name = channel.config.name;
    let report: ChannelCommandReport;
    switch (command) {
      case "pause":
      case "resume":
        report = (await this.setState(channel, command === "pause" ? "paused" : "running"))
          ? { channel: name, state: channel.state }
          : { channel: name, state: channel.state, refused: "state-not-stored" };
        break;
      case "stop":
      case "halt":
        report = await this.drain(channel, command, options.deadlineMs ?? STOP_DEADLINE_MS);
        break;
      case "reload":
        report = await this.reload(
          channel,
          options.config ?? "not-configured",
          options.transformConfig ?? this.options.project.config,
        );
        break;
    }
    return report;
  }

  /**
   * Runs passes until `signal` aborts. Each pass transforms and delivers what every channel has
   * waiting, and polls each polled source whose pass is due, by its own schedule (its `poll:`, or
   * the engine-wide `pollInterval`). A source's pass runs beside the loop, so one that hangs holds
   * up no other channel: it is cut off at its deadline, and no pass of that source starts while its
   * last `poll` call has not returned. A pass due while the engine was down is not made up. The loop
   * waits the poll interval between passes, or less when a source's pass is due sooner or one
   * ends. Retention runs after the first pass and then once every `retentionInterval`. A source's
   * `poll` that rejects before its deadline ends the run with that error, as it would a tick. Once
   * `signal` aborts, a source's pass under way is cut off after what it is storing is stored, its
   * `poll` call is waited for up to its deadline, and a last pass takes what the sources took in
   * through the transform and delivery, as the end of a tick does.
   */
  async run(signal: AbortSignal): Promise<void> {
    const { pollIntervalMs, retentionIntervalMs } = this.options.project.settings;
    let retentionAt = this.now();
    this.steppedAt = this.monotonic();
    const schedule = { wake: new AbortController(), failure: undefined };
    this.schedule = schedule;
    const started = this.now();
    for (const channel of this.channels) {
      channel.nextPollAt = nextPollAt(this.pollOf(channel).schedule, started, true);
    }
    let ended = false;
    try {
      while (!signal.aborted) {
        await this.passes("due");
        this.step();
        if (this.now() >= retentionAt) {
          await this.retention();
          this.step();
          retentionAt = this.now() + retentionIntervalMs;
        }
        this.raise(schedule);
        if (schedule.wake.signal.aborted) schedule.wake = new AbortController();
        await this.wait(
          this.untilDue(pollIntervalMs),
          AbortSignal.any([signal, schedule.wake.signal]),
        );
        this.raise(schedule);
      }
      ended = true;
      await this.endPasses();
      this.raise(schedule);
      await this.passes("none");
    } finally {
      this.steppedAt = undefined;
      this.schedule = undefined;
      if (!ended) await this.endPasses();
    }
  }

  /**
   * Cuts each source's pass under way off, once what it is storing is stored, and waits for its
   * `poll` call to return, which the cut makes it do at its next message, up to its deadline.
   */
  private async endPasses(): Promise<void> {
    for (const channel of this.channels) channel.cut?.abort();
    await Promise.all(this.channels.map((channel) => channel.polling ?? Promise.resolve()));
    await Promise.all(this.channels.flatMap((channel) => [...channel.receiving]));
    const done = new AbortController();
    await Promise.all(
      this.channels.map((channel) =>
        Promise.race([
          channel.inFlight ?? Promise.resolve(),
          this.wait(this.pollOf(channel).deadlineMs, done.signal),
        ]),
      ),
    );
    done.abort();
  }

  /** Throws the failure of a pass that ran beside {@link run}'s loop, if one failed. */
  private raise(schedule: NonNullable<Engine["schedule"]>): void {
    if (schedule.failure !== undefined) throw schedule.failure.error;
  }

  /**
   * How long {@link run}'s loop waits: the poll interval, or less when a running channel's source
   * has a pass due sooner; 0 when one is due already.
   */
  private untilDue(pollIntervalMs: number): number {
    let soonest = this.now() + pollIntervalMs;
    for (const channel of this.channels) {
      if (channel.state !== "running" || channel.connectors.source.poll === undefined) continue;
      soonest = Math.min(soonest, channel.nextPollAt);
    }
    return Math.max(0, soonest - this.now());
  }

  /** The channel's poll settings: its own, or the engine-wide interval with the default deadline. */
  private pollOf(channel: RunningChannel): ReturnType<typeof pollOf> {
    return pollOf(channel.config, this.options.project.settings.pollIntervalMs);
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
    if (this.channels.some(isDown)) return false;
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
        onSkip: (channel, code) => {
          logger.error({ event: "retention-skipped", channel, code });
        },
        keys: this.options.keys,
        audit: this.audit,
      });
      await recordRetention(this.audit, report);
      logger.info({
        event: "retention",
        messages: report.messages,
        deliveries: report.deliveries,
        ...(report.pruned === undefined ? {} : { pruned: report.pruned }),
        ...(report.archives === undefined ? {} : { archives: report.archives }),
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
    const states = this.channelStates();
    const down = new Set(this.channels.filter(isDown).map((c) => c.config.name));
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
          /* v8 ignore next: a channel not started yet, or stopped with the engine, runs by default */
          state: states[name] ?? "running",
          messages,
          deliveries,
          ...this.connectionCounts(name),
        };
      }
    } catch {
      storage = "unreachable";
      for (const { name } of project.channels) {
        channels[name] = {
          status: "unknown",
          source: source(name),
          /* v8 ignore next: as above */
          state: states[name] ?? "running",
        };
      }
    }
    const broken = storage !== "ok" || down.size > 0;
    return { status: broken ? "unavailable" : "ok", storage, channels };
  }

  /**
   * How many connections a channel's MLLP or tcp source closed at accept for being over its cap, for
   * the health body; nothing for any other source. A count only, never who connected.
   */
  private connectionCounts(name: string): Pick<ChannelHealth, "connections"> {
    const source = this.channels.find((channel) => channel.config.name === name)?.connectors.source;
    return source instanceof MllpSource || source instanceof TcpSource
      ? { connections: { refused: source.refusedConnections } }
      : {};
  }

  private warnInsecure(config: ChannelConfig): void {
    const { logger } = this.options;
    const { source } = config;
    if (source.kind === "http") {
      for (const warning of listenerWarnings(source)) {
        logger.warn({ event: warning, channel: config.name, endpoint: "source" });
      }
    } else if ((source.kind === "mllp" || source.kind === "tcp") && source.plaintext) {
      // MLLP and tcp carry no credentials of their own: mutual TLS (tls.ca) is how a source checks
      // who sends.
      logger.warn({ event: "plaintext", channel: config.name, endpoint: "source" });
    } else if (source.kind === "file" && source.keepProcessed) {
      // Each stored file stays in processed/ as it arrived: patient data outside the encrypted store.
      logger.warn({ event: "plaintext-copies", channel: config.name, endpoint: "source" });
    }
    for (const [index, destination] of config.destinations.entries()) {
      const connects =
        destination.kind === "http" || destination.kind === "mllp" || destination.kind === "tcp";
      if (connects && destination.plaintext) {
        logger.warn({
          event: "plaintext",
          channel: config.name,
          endpoint: "destination",
          destination: index,
        });
      }
    }
  }

  /** One channel's part of a pass. */
  private async pass(channel: RunningChannel, polls: "all" | "due" | "none"): Promise<void> {
    if (channel.state === "running" && polls !== "none") {
      if (channel.down !== undefined && channel.down.nextAt <= this.now()) {
        await this.syncSource(channel);
      }
      if (channel.connectors.source.poll !== undefined) {
        if (polls === "all") await this.poll(channel);
        else if (channel.nextPollAt <= this.now()) this.pollBeside(channel);
      }
    }
    await this.transformAll(channel);
    await this.deliverAll(channel);
  }

  /**
   * Starts a due pass of the channel's source beside {@link run}'s loop. Once it ends the next is
   * scheduled from then and the loop is woken to transform what it took in; a pass that rejects
   * before its deadline ends the run.
   */
  private pollBeside(channel: RunningChannel): void {
    const schedule = this.schedule;
    /* v8 ignore next: only run() schedules, and it sets the schedule first */
    if (schedule === undefined) return;
    channel.nextPollAt = Number.POSITIVE_INFINITY;
    this.poll(channel).then(
      () => {
        channel.nextPollAt = nextPollAt(this.pollOf(channel).schedule, this.now(), false);
        schedule.wake.abort();
      },
      (error: unknown) => {
        schedule.failure ??= { error };
        schedule.wake.abort();
      },
    );
  }

  /**
   * One pass of the channel's source, settled when its `poll` returns or at the pass's deadline,
   * whichever is first. At the deadline, or when {@link run} ends, the pass is cut off: its sink
   * takes nothing more in (each later `receive` rejects with the code `POLL_DEADLINE`, so the source
   * keeps the message), the signal handed to `poll` aborts, and no pass starts until that `poll`
   * call returns. A pass asked for while one is still in flight is refused, and logged. Rejects as
   * the source's `poll` does before the pass is cut off; a rejection after it is part of the cut.
   */
  private async poll(channel: RunningChannel): Promise<void> {
    const { logger } = this.options;
    const name = channel.config.name;
    if (channel.inFlight !== undefined) {
      logger.warn({ event: "poll-overlap", channel: name });
      return;
    }
    const { deadlineMs } = this.pollOf(channel);
    const cut = new AbortController();
    channel.cut = cut;
    const ended = new AbortController();
    const call = (async () => {
      // A poll method is set: pass() checks before it calls this.
      await (channel.connectors.source.poll as NonNullable<SourceConnector["poll"]>)(
        this.sinkFor(channel, cut.signal),
        cut.signal,
      );
    })();
    // No other pass starts while this is set, so the one that clears it is this pass's own.
    channel.inFlight = settled(call).then(() => {
      channel.inFlight = undefined;
    });
    const deadline = this.wait(deadlineMs, AbortSignal.any([ended.signal, cut.signal])).then(
      () => !ended.signal.aborted,
    );
    // Once the pass is cut, a rejection from its poll call (a source that hands the signal on to
    // its client gets an AbortError) is part of the cut, not a failure of the pass. One that is
    // not the cut's own is still logged, by its code: never its text.
    const pass = Promise.race([
      call.then(
        () => false,
        (error: unknown) => {
          if (!cut.signal.aborted) throw error;
          if (!isCutError(error, cut.signal)) {
            logger.warn({ event: "poll-failed-after-cut", channel: name, code: errorCode(error) });
          }
          return true;
        },
      ),
      deadline,
    ]);
    channel.polling = settled(pass);
    try {
      if ((await pass) && !cut.signal.aborted) {
        cut.abort();
        logger.warn({ event: "poll-deadline", channel: name, deadlineMs });
      }
    } finally {
      ended.abort();
      channel.polling = undefined;
      channel.cut = undefined;
    }
  }

  /** Every channel's stored state, or `undefined` when the store keeps none. */
  private async readStates(): Promise<Record<string, ChannelRunState> | undefined> {
    return channelStateStore(this.options.store)?.channelStates();
  }

  /**
   * Brings each channel to its stored state. A store that cannot be read leaves them as they are,
   * and so does a read that a state change of this engine's own overtook: the change wins.
   */
  private async syncStates(): Promise<void> {
    const changes = new Map(this.channels.map((channel) => [channel, channel.changes]));
    let stored: Record<string, ChannelRunState> | undefined;
    try {
      stored = await this.readStates();
    } catch (error) {
      this.options.logger.warn({ event: "channel-states-unread", code: errorCode(error) });
      return;
    }
    if (stored === undefined) return;
    for (const channel of this.channels) {
      if (channel.writing > 0 || changes.get(channel) !== channel.changes) continue;
      const state = stored[channel.config.name] ?? "running";
      channel.stored = state;
      await this.applyState(channel, state);
    }
  }

  /**
   * Sets a channel's state here, then stores it when the store keeps states, and says whether it
   * was stored. The channel takes the state before the write starts, so the pass under way sees a
   * stop at its next message however slow the database is. When the write fails, the channel goes
   * back to the state storage still holds, the failure is logged by its code, and the caller tells
   * the operator: a state never stays set here while storage, and every other engine, says
   * otherwise.
   */
  private async setState(channel: RunningChannel, state: ChannelRunState): Promise<boolean> {
    const states = channelStateStore(this.options.store);
    const name = channel.config.name;
    channel.changes += 1;
    // applyState sets channel.state before its first await, so the change holds from here on.
    const applied = this.applyState(channel, state);
    if (states === undefined) {
      await applied;
      channel.stored = state;
      return true;
    }
    channel.writing += 1;
    const write = channel.writes.then(() => states.setChannelState(name, state));
    channel.writes = settled(write);
    const [apply, written] = await Promise.allSettled([applied, write]);
    channel.writing -= 1;
    if (written.status === "fulfilled") channel.stored = state;
    else {
      this.options.logger.error({
        event: "channel-state-unstored",
        channel: name,
        state,
        code: errorCode(written.reason),
      });
      // Back to what storage holds, unless a later command has set the channel since.
      if (channel.state === state && channel.writing === 0) {
        channel.changes += 1;
        await this.applyState(channel, channel.stored);
      }
    }
    if (apply.status === "rejected") throw apply.reason;
    return written.status === "fulfilled";
  }

  /**
   * Sets the channel's state at once, then opens or closes its source to match, after any start or
   * stop of it already under way.
   */
  private applyState(channel: RunningChannel, state: ChannelRunState): Promise<void> {
    if (channel.state === state) return Promise.resolve();
    channel.state = state;
    this.options.logger.info({ event: "channel-state", channel: channel.config.name, state });
    // A running loop looks at once: a resumed source's pass may be due already.
    this.schedule?.wake.abort();
    return this.syncSource(channel);
  }

  /** Matches the channel's source to its state, after any start or stop of it under way. */
  private syncSource(channel: RunningChannel): Promise<void> {
    const run = channel.sourcing.then(() => this.matchSource(channel));
    channel.sourcing = settled(run);
    return run;
  }

  /** Opens or closes the channel's source to match its state as it is now. */
  private async matchSource(channel: RunningChannel): Promise<void> {
    if (channel.state === "running") {
      if (!channel.open) await this.startSource(channel);
      return;
    }
    // Paused or stopped: the source takes nothing more in. One that could not listen is not down
    // any more, only paused, and is not tried again until a resume.
    channel.down = undefined;
    channel.lost = undefined;
    if (channel.open) {
      channel.open = false;
      await channel.connectors.source.stop?.();
    }
    // A poll under way finishes what it took in; none starts after it.
    await channel.polling;
  }

  /**
   * Stops a channel: closes its source, ends its pass after the message in hand (cutting off the
   * delivery in flight for a halt), waits up to `deadlineMs` for that, and counts what is left.
   */
  private async drain(
    channel: RunningChannel,
    how: "stop" | "halt",
    deadlineMs: number,
  ): Promise<ChannelCommandReport> {
    const { config } = channel;
    channel.draining = true;
    try {
      // The channel is stopped here before the write starts, and a halt cuts off the delivery in
      // flight at once: a cut-off delivery stays pending, so even a failed write loses nothing.
      const storing = this.setState(channel, "stopped");
      if (how === "halt") {
        channel.halt.abort();
        channel.halt = new AbortController();
      }
      if (!(await storing)) {
        return { channel: config.name, state: channel.state, refused: "state-not-stored" };
      }
      const busy = channel.busy;
      let drained = true;
      if (busy !== undefined) {
        const deadline = new AbortController();
        drained = await Promise.race([
          busy.then(() => true),
          sleep(Math.min(deadlineMs, MAX_STOP_DEADLINE_MS), false, {
            signal: deadline.signal,
          }).catch(() => false),
        ]);
        deadline.abort();
      }
      const { store } = this.options;
      const [messages, deliveries] = await Promise.all([
        store.messageCounts(config.name),
        store.deliveryCounts(config.name),
      ]);
      const left = { toTransform: messages.received, toDeliver: deliveries.pending };
      return { channel: config.name, state: channel.state, drained, left };
    } finally {
      channel.draining = false;
    }
  }

  /** Reloads a channel's transform and settings, one reload at a time. */
  private reload(
    channel: RunningChannel,
    next: ChannelConfig | "invalid-config" | "not-configured",
    projectConfig: TransformConfigBlock,
  ): Promise<ChannelCommandReport> {
    const name = channel.config.name;
    if (channel.draining) return Promise.resolve({ channel: name, refused: "draining" });
    const run = channel.reloads.then(() => this.reloadNow(channel, next, projectConfig));
    channel.reloads = settled(run);
    return run;
  }

  private async reloadNow(
    channel: RunningChannel,
    next: ChannelConfig | "invalid-config" | "not-configured",
    projectConfig: TransformConfigBlock,
  ): Promise<ChannelCommandReport> {
    const name = channel.config.name;
    // A reload queued behind another is refused too when a stop began while it waited.
    if (channel.draining) return { channel: name, refused: "draining" };
    if (typeof next === "string") return { channel: name, refused: next };
    const changed = RESTART_ONLY.filter(
      (key) => JSON.stringify(channel.config[key]) !== JSON.stringify(next[key]),
    );
    if (changed.length > 0) return { channel: name, refused: "needs-restart", changed };
    let config: ReturnType<typeof resolveTransformConfig>;
    try {
      // Read here, in the engine's process, as at start, so a worker never sees the environment.
      config = resolveTransformConfig(projectConfig, next, this.env);
    } catch (error) {
      /* v8 ignore next: resolveTransformConfig throws only ConfigError */
      if (!(error instanceof ConfigError)) throw error;
      return { channel: name, refused: "invalid-config" };
    }
    const worker = new ChannelWorker({
      channel: name,
      transformFile: next.transform,
      format: next.format,
      csv: next.csv,
      timeoutMs: next.settings.timeoutMs,
      memoryMb: next.settings.memoryMb,
      config,
    });
    try {
      // A fresh worker, so the transform's module and every module it imports are read anew.
      await worker.start();
    } catch (error) {
      await worker.stop();
      /* v8 ignore next: start rejects only with TransformLoadError */
      if (!(error instanceof TransformLoadError)) throw error;
      return { channel: name, refused: "transform-load-failed", failure: error.failure.name };
    }
    if (channel.draining) {
      // A stop began while the new transform loaded: the old one stays, as for a reload asked then.
      await worker.stop();
      return { channel: name, refused: "draining" };
    }
    // Swapped between messages: the pass reads the worker afresh for each one, and the old worker
    // finishes the message it holds before it stops.
    const old = channel.worker;
    channel.worker = worker;
    channel.config = next;
    await old.stop();
    this.options.logger.info({ event: "channel-reloaded", channel: name });
    return { channel: name, state: channel.state };
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
    if (channel.state !== "running") {
      // A pause or stop came while the source started: it closes again before it takes anything in.
      await source.stop?.();
      return;
    }
    channel.open = true;
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

  /**
   * Marks a delivery `dry-run`. `start` refuses a store without `markDryRun` when a destination runs
   * dry, so this never finds it missing; if it did, it throws rather than let the send go ahead.
   */
  private async markDryRun(deliveryId: number): Promise<void> {
    const { store } = this.options;
    /* v8 ignore next 3: start refuses a store without markDryRun when a destination runs dry */
    if (store.markDryRun === undefined) {
      throw new ConfigError(["the store has no markDryRun to record a dry run"]);
    }
    await store.markDryRun(deliveryId, ...this.epoch());
  }

  /** Now, or `inMs` from now, as an ISO 8601 time for an event. */
  private at(inMs = 0): string {
    return new Date(this.now() + inMs).toISOString();
  }

  /**
   * The sink a channel's source hands messages to. Given `cut`, the signal of a polled source's pass,
   * it refuses every message once that aborts, before storing it.
   */
  private sinkFor(channel: RunningChannel, cut?: AbortSignal): MessageSink {
    const { config } = channel;
    const { store, logger } = this.options;
    const sink: MessageSink = {
      sourceDown: (code) => this.sourceDown(channel, code),
      sourceUp: () => {
        this.sourceUp(channel);
      },
      receive: async (body, options = {}) => {
        // Before anything is stored: the source keeps the message for a later pass.
        if (cut?.aborted === true) throw new PassCut();
        const { duplicateKey, idempotencyKey, resumed, failure, source } = options;
        let received: ReceivedMessage;
        const receivedAt = this.at();
        // Settled once this message's facts are set or the receive failed, so a pass that takes
        // the message from the store before this call has returned waits for its facts.
        let settle!: () => void;
        const receiving = new Promise<void>((resolve) => (settle = resolve));
        channel.receiving.add(receiving);
        const settled = (): void => {
          channel.receiving.delete(receiving);
          settle();
        };
        try {
          // Checked and copied before anything is stored, so a source that passes what a
          // transform cannot be handed learns it at once and the sender keeps the message, and a
          // source that changes its object afterwards changes nothing the transform reads.
          const passed = source === undefined ? undefined : copyFacts(source);
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
            // Kept with the metadata once the body is dropped, to match a copy held elsewhere.
            ...(config.settings.content === "dropAfterDelivery"
              ? { contentHash: createHash("sha256").update(body).digest("hex") }
              : {}),
          });
          // Set at once, with no wait between the store call and here.
          if (failure === undefined && received.alreadyStored !== true) {
            keepFacts(
              channel.facts,
              received.id,
              sourceFacts(config.source.kind, passed, body.byteLength, receivedAt),
            );
          }
          settled();
        } catch (error) {
          settled();
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

  /**
   * A running source lost its connection: noted, so health shows the source down and readiness
   * fails, logged and sent to the hooks as `source-down`. Returns how long the source should wait
   * before it tries again: 1 second, doubling with each report in a row, to 5 minutes. A code that
   * is not shaped as one (letters, digits and `_.:-`, at most 64) is kept as `UNSPECIFIED`, so no
   * text a source passes reaches a log.
   */
  private sourceDown(channel: RunningChannel, reported: string): number {
    const name = channel.config.name;
    const code = SOURCE_CODE.test(reported) ? reported : "UNSPECIFIED";
    const attempts = (channel.lost?.attempts ?? 0) + 1;
    const wait = retryDelay(attempts);
    channel.lost = { attempts, code };
    this.options.logger.error({
      event: "source-lost",
      channel: name,
      attempt: attempts,
      retryInMs: wait,
      code,
    });
    this.emit(channel, () => ({
      type: "source-down",
      at: this.at(),
      channel: name,
      attempt: attempts,
      retryInMs: wait,
      retryAt: this.at(wait),
      name: "SourceDown",
      code,
    }));
    return wait;
  }

  /** A source that said it lost its connection has it again: health and the hooks hear so. */
  private sourceUp(channel: RunningChannel): void {
    if (channel.lost === undefined) return;
    channel.lost = undefined;
    const name = channel.config.name;
    this.options.logger.info({ event: "source-regained", channel: name });
    this.emit(channel, () => ({ type: "source-up", at: this.at(), channel: name }));
  }

  private async transformAll(channel: RunningChannel): Promise<void> {
    const { store, logger } = this.options;
    // A store that copies bodies hands each one over to whoever reads it, and keeps none it stores:
    // the body moves to the worker rather than being copied, and the outputs are freed once stored.
    const owned = copiesBodies(store);
    for (;;) {
      // A stop ends the pass between messages; a reload swaps the worker and settings between them.
      if (channel.state === "stopped") return;
      const { config, worker } = channel;
      this.options.fence?.check();
      this.step();
      const next = await store.nextToTransform(config.name);
      if (next === undefined) return;
      if (!channel.facts.has(next.id) && channel.receiving.size > 0) {
        // The receive that stored this message may not have set its facts yet.
        await Promise.all(channel.receiving);
      }
      const source = channel.facts.get(next.id);
      channel.facts.delete(next.id);
      const outcome: TransformOutcome = await worker.run(next.body, {
        transfer: owned,
        // Every message the engine transforms is on its first run: a replay runs elsewhere.
        context: { messageId: next.id, attempt: 1, source, meta: {} },
      });
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

  /**
   * Delivers what the channel has due, one attempt at a time, each cut off at its destination's
   * deadline by one timer between them all.
   */
  private async deliverAll(channel: RunningChannel): Promise<void> {
    const deadline = new DeadlineTimer(() => this.now(), this.wait);
    try {
      await this.deliverEach(channel, deadline);
    } finally {
      deadline.close();
    }
  }

  private async deliverEach(channel: RunningChannel, deadline: DeadlineTimer): Promise<void> {
    const { config, connectors } = channel;
    const { store, logger } = this.options;
    for (const [index, destination] of connectors.destinations.entries()) {
      const dry = runsDry(config, index, this.options.dryRun === true);
      const policy = config.destinations[index]?.retry ?? config.settings.retry;
      // With rotate, a delivery waiting for a retry steps aside for the due ones behind it; each is
      // tried once a pass, so a retry due at once waits for the next pass.
      const tried = new Set<number>();
      for (;;) {
        if (channel.state === "stopped") return;
        this.step();
        const delivery = await (policy.rotate
          ? store.nextDelivery(config.name, index, { dueBy: this.now() })
          : store.nextDelivery(config.name, index));
        if (delivery === undefined || delivery.nextAttemptAt > this.now()) break;
        if (tried.has(delivery.id)) break;
        tried.add(delivery.id);
        if (dry) {
          // Everything but the send: the output is recorded already, so the delivery is marked and
          // the destination moves on. Nothing is handed to a connector, so nothing is opened.
          this.options.fence?.check();
          await this.markDryRun(delivery.id);
          logger.info({
            event: "dry-run",
            channel: config.name,
            destination: index,
            delivery: delivery.id,
          });
          continue;
        }
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
        const halt = channel.halt.signal;
        // The whole attempt (connecting, sending, and the receiver's confirmation) is bounded.
        // One controller per attempt: aborted by a halt, with the halt's reason, or at the deadline.
        // A halt replaces the signal it aborts at once, but an `abort` listener never fires on a
        // signal already aborted, so one is checked first: such an attempt is cut before it sends.
        const limitMs = deliveryDeadlineMs(config.destinations[index]);
        const cutOff = new AbortController();
        const { signal } = cutOff;
        let expired = false;
        const onHalt = (): void => {
          cutOff.abort(halt.reason);
        };
        if (halt.aborted) onHalt();
        else halt.addEventListener("abort", onHalt, { once: true });
        deadline.set(this.now() + limitMs, () => {
          expired = true;
          cutOff.abort();
        });
        const ended = (): void => {
          deadline.clear();
          halt.removeEventListener("abort", onHalt);
        };
        try {
          await untilAborted(
            () =>
              destination.deliver({
                messageId: delivery.messageId,
                seq: delivery.seq,
                body: delivery.body,
                ...(resend === undefined ? {} : { resend }),
                signal,
              }),
            signal,
          );
        } catch (thrown) {
          ended();
          if (halt.aborted) {
            // Halted: no outcome is recorded, so the delivery stays pending, and its marker (when
            // written) flags the next send as a possible duplicate, since the receiver may have it.
            logger.warn({
              event: "delivery-halted",
              channel: config.name,
              destination: index,
              delivery: delivery.id,
              attempt,
            });
            return;
          }
          // Cut off at the deadline: an attempt that failed, retried as any other.
          const error = expired ? new DeliveryTimeout(limitMs) : thrown;
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
        ended();
        // Delivered: freed now when the store handed it over and the destination kept none of it.
        if (copiesBodies(store) && copiesBodies(destination)) release(delivery.body);
        faultPoint("after-send-before-record");
        if (config.settings.content === "dropAfterDelivery") {
          // start() refused a store without the method for such a channel.
          const dropping = store as Required<Pick<MessageStore, "markDeliveredAndDropContent">>;
          const dropped = await dropping.markDeliveredAndDropContent(delivery.id, ...this.epoch());
          if (dropped) {
            logger.info({
              event: "content-dropped",
              channel: config.name,
              message: delivery.messageId,
              delivery: delivery.id,
            });
          }
        } else {
          await store.markDelivered(delivery.id, ...this.epoch());
        }
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

/**
 * Starts `send` and settles as it does, or rejects as soon as `signal` aborts, leaving it to settle
 * unheard. A signal already aborted rejects at once, and `send` is never started.
 */
function untilAborted(send: () => Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("the send was cut off"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("the send was cut off"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    send().then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: Error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Whether a cut pass's `poll` rejected with the cut itself: the signal's own reason, an
 * `AbortError` (as a client handed the signal throws), or the sink's refusal after the cut.
 */
function isCutError(error: unknown, cut: AbortSignal): boolean {
  return (
    error === cut.reason ||
    error instanceof PassCut ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** Whether a channel's source is down: it cannot listen, or it said it lost its connection. */
function isDown(channel: { readonly down: unknown; readonly lost: unknown }): boolean {
  return channel.down !== undefined || channel.lost !== undefined;
}

/** Waits for `work` to settle, either way: its own caller handles a rejection. */
async function settled(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    // Seen by the pass's own caller.
  }
}

/** A command's report as an audit entry's particulars: states, counts and names only. */
function auditDetail(
  report: ChannelCommandReport,
): Readonly<Record<string, string | number | boolean>> {
  return {
    ...(report.state === undefined ? {} : { state: report.state }),
    ...(report.refused === undefined ? {} : { reason: report.refused }),
    ...(report.drained === undefined ? {} : { drained: report.drained }),
    ...(report.left === undefined
      ? {}
      : { toTransform: report.left.toTransform, toDeliver: report.left.toDeliver }),
    ...(report.changed === undefined ? {} : { changed: report.changed.join(",") }),
    ...(report.failure === undefined ? {} : { failure: report.failure }),
  };
}

/** An error's name, or the type of what was thrown when it is not an error: never its text. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A key's SHA-256 in hex, as storage keeps it, or undefined when there is no key. */
function hashed(key: string | undefined): string | undefined {
  return key === undefined ? undefined : createHash("sha256").update(key).digest("hex");
}

/**
 * The location an `sftp:` block names: its key and passphrase read through `secrets`, and its host
 * key check from its known hosts file or its one key, read now. `where` names the block.
 *
 * @throws {ConfigError} when the key cannot be read, its file can be read by its group or others,
 *   the known hosts file can be written by its group or others, cannot be read or holds no entry,
 *   or `hostKey` is not a key.
 */
function sftpLocation(sftp: SftpConfig, secrets: Secrets, where: string): SftpLocation {
  if ("file" in sftp.key) keyFileClosed(sftp.key.file, `${where}.key`);
  const privateKey = secrets.read(sftp.key, `${where}.key`);
  const passphrase =
    sftp.passphrase === undefined
      ? undefined
      : secrets.read(sftp.passphrase, `${where}.passphrase`);
  let verifyHost: (host: string, port: number, key: Uint8Array) => void;
  if (sftp.knownHosts === undefined) {
    try {
      verifyHost = pinnedKey(String(sftp.hostKey));
    } catch {
      throw new ConfigError([
        `${where}.hostKey: neither a public key (keytype base64) nor a SHA256: fingerprint`,
      ]);
    }
  } else {
    knownHostsClosed(sftp.knownHosts, `${where}.knownHosts`);
    let known: KnownHosts;
    try {
      known = KnownHosts.parse(readFileSync(sftp.knownHosts, "utf8"));
    } catch (error) {
      throw new ConfigError([
        `${where}.knownHosts: the file could not be read (${errorCode(error) ?? "unknown"})`,
      ]);
    }
    if (known.size === 0) {
      throw new ConfigError([`${where}.knownHosts: the file holds no host key`]);
    }
    verifyHost = (host, port, key) => {
      known.check(host, port, key);
    };
  }
  return new SftpLocation({
    host: sftp.host,
    port: sftp.port,
    user: sftp.user,
    privateKey,
    passphrase,
    verifyHost,
    weakAlgorithms: sftp.weakAlgorithms,
    ...(sftp.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: sftp.connectTimeoutMs }),
    ...(sftp.timeoutMs === undefined ? {} : { timeoutMs: sftp.timeoutMs }),
    ...(sftp.keepaliveMs === undefined ? {} : { keepaliveMs: sftp.keepaliveMs }),
  });
}

/**
 * Refuses a private key file its group or others can read or write, as ssh(1) does: on Linux and
 * macOS. Windows keeps no such mode bits, so there the check is the folder's own access control.
 */
function keyFileClosed(path: string, where: string): void {
  if (modeOpen(path, 0o077)) {
    throw new ConfigError([
      `${where}: the key file can be read by its group or others; chmod 600 it`,
    ]);
  }
}

/**
 * Refuses a known hosts file its group or others can write, as ssh(1) refuses such a config file:
 * whoever can write it can add a key, and so stand in for the server. Others may read it, since it
 * holds only public keys. On Linux and macOS, as {@link keyFileClosed}.
 */
function knownHostsClosed(path: string, where: string): void {
  if (modeOpen(path, 0o022)) {
    throw new ConfigError([
      `${where}: the file can be written by its group or others; chmod go-w it`,
    ]);
  }
}

/**
 * Whether the file at `path` has any of the mode bits in `bits`: never on Windows, which keeps no
 * such bits, nor for a file that cannot be read, which its own read then says, with its code.
 */
function modeOpen(path: string, bits: number): boolean {
  if (process.platform === "win32") return false;
  try {
    return (statSync(path).mode & bits) !== 0;
  } catch {
    return false;
  }
}
