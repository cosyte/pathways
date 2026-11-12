import type { ChannelConfig, ProjectConfig } from "../config/schema.js";
import { transformConfigFor } from "../config/transform-config.js";
import type { Env } from "../connectors/endpoint.js";
import { EncryptionError } from "../encryption/envelope.js";
import { ChannelWorker, inboundOf, TransformLoadError } from "../engine/channel-worker.js";
import { storedFailure } from "../engine/engine.js";
import type { FailureSummary } from "../engine/worker-entry.js";
import type { MessageStatus, MessageStore, RequeueResult } from "../storage/store.js";
import { describeFailure } from "../testing/run-tests.js";
import type { AuditLog } from "./audit.js";

/**
 * Why a replay, a resend or a clear was not done to a message:
 *
 * - `waiting`: it has not been transformed yet, and the engine will;
 * - `pending`: some of its deliveries still wait to be sent;
 * - `no-output`: a resend, but its current transform produced nothing to send;
 * - `no-channel`: its channel is no longer configured;
 * - `transform-load`: its channel's transform could not be loaded;
 * - `changed`: it changed while the replay ran, so nothing was recorded;
 * - `unreadable`: what is stored of it could not be decrypted;
 * - `not-failed`: a clear, but nothing about it had failed;
 * - `content-dropped`: its content was dropped after delivery (`storage.content:
 *   dropAfterDelivery`), so there is nothing to replay or resend.
 *
 * @example
 * ```ts
 * const tryLater = (reason: ActionRefusal): boolean => reason === "pending" || reason === "changed";
 * ```
 */
export type ActionRefusal =
  | "waiting"
  | "pending"
  | "no-output"
  | "no-channel"
  | "transform-load"
  | "changed"
  | "unreadable"
  | "not-failed"
  | "content-dropped";

/**
 * What a replay or a resend did to one message. Ids, counts, states and codes only.
 *
 * @example
 * ```ts
 * const queued = (results: readonly ReplayResult[]): number =>
 *   results.reduce((n, r) => n + ("queued" in r ? r.queued : 0), 0);
 * ```
 */
export type ReplayResult =
  | {
      readonly id: number;
      readonly outcome: "replayed" | "resent";
      readonly status: MessageStatus;
      /** Deliveries queued, at the back of each destination's queue. */
      readonly queued: number;
      /** Earlier deliveries that had failed for good, now cleared by the replay. */
      readonly superseded: number;
      /** When the replayed transform failed: what happened, without the error's own text. */
      readonly failure?: string;
    }
  | { readonly id: number; readonly outcome: "not-found" }
  | {
      readonly id: number;
      readonly outcome: "refused";
      readonly reason: ActionRefusal;
      /** For `transform-load` and `unreadable`: what happened, in fixed text and codes. */
      readonly failure?: string;
    };

/**
 * What a clear did to one message.
 *
 * @example
 * ```ts
 * const cleared = (results: readonly ClearOutcome[]) => results.filter((r) => r.outcome === "cleared");
 * ```
 */
export type ClearOutcome =
  | {
      readonly id: number;
      readonly outcome: "cleared";
      readonly messages: number;
      readonly deliveries: number;
    }
  | { readonly id: number; readonly outcome: "not-found" }
  | { readonly id: number; readonly outcome: "refused"; readonly reason: "not-failed" };

/**
 * What {@link replayMessages} works with.
 *
 * @example
 * ```ts
 * const context: ReplayContext = { project, store, audit, resend: false };
 * ```
 */
export interface ReplayContext {
  readonly project: ProjectConfig;
  readonly store: MessageStore;
  readonly audit: AuditLog;
  /** Re-send the stored outputs instead of transforming again. */
  readonly resend: boolean;
  /** Where the transform's configuration reads its environment variables. Defaults to `process.env`. */
  readonly env?: Env | undefined;
}

/**
 * Replays messages, one after another, in the order given: runs each through its channel's
 * transform as it is on disk now, in the same kind of worker the engine runs (with the channel's
 * timeout and memory cap, and its configuration as it is now), and queues the outputs as fresh deliveries at the back of each
 * destination's queue. With `resend`, queues the outputs stored from the last transform instead.
 *
 * It is safe beside a running engine on the same database: it never touches a message the engine
 * is still working on (one not yet transformed, or with deliveries pending), and storage records
 * each replay in one transaction that first checks the message has not moved. Every attempt,
 * done or refused, is written to the audit log.
 *
 * @example
 * ```ts
 * const results = await replayMessages([9, 17], { project, store, audit, resend: false });
 * ```
 */
export async function replayMessages(
  ids: readonly number[],
  context: ReplayContext,
): Promise<ReplayResult[]> {
  const { project, store, audit, resend } = context;
  const mode = resend ? "resend" : "replay";
  const workers = new Map<string, ChannelWorker | FailureSummary>();
  const results: ReplayResult[] = [];

  const refuse = async (
    id: number,
    channel: string,
    reason: ActionRefusal,
    failure?: string,
  ): Promise<ReplayResult> => {
    await audit.record({
      action: mode,
      outcome: "refused",
      channel,
      messageId: id,
      detail: { reason },
    });
    return failure === undefined
      ? { id, outcome: "refused", reason }
      : { id, outcome: "refused", reason, failure };
  };

  const replayOne = async (id: number): Promise<ReplayResult> => {
    const message = await store.message(id);
    if (message === undefined) {
      await audit.record({ action: mode, outcome: "not-found", messageId: id });
      return { id, outcome: "not-found" };
    }
    const channel = project.channels.find((c) => c.name === message.channel);
    if (channel === undefined) return refuse(id, message.channel, "no-channel");
    if (message.status === "received") return refuse(id, channel.name, "waiting");
    if (message.contentDroppedAt !== undefined) return refuse(id, channel.name, "content-dropped");
    if (message.deliveries.pending > 0) return refuse(id, channel.name, "pending");

    let outputs: readonly Uint8Array[];
    let failure: FailureSummary | undefined;
    if (resend) {
      outputs = message.status === "transformed" ? await store.outputs(id) : [];
      if (outputs.length === 0) return refuse(id, channel.name, "no-output");
    } else {
      const worker = await workerFor(project, channel, workers, context.env ?? process.env);
      if (!(worker instanceof ChannelWorker)) {
        return refuse(id, channel.name, "transform-load", describeFailure(worker, channel));
      }
      const body = await store.messageBody(id);
      if (body === undefined) {
        await audit.record({ action: mode, outcome: "not-found", messageId: id });
        return { id, outcome: "not-found" };
      }
      // The run after this message's generation: the first transform was run 1. What its source
      // knew is not stored, so a replay runs without it.
      const outcome = await worker.run(body, {
        context: { messageId: id, attempt: message.generation + 2, source: undefined, meta: {} },
      });
      outputs = outcome.ok ? outcome.outputs : [];
      failure = outcome.ok ? undefined : outcome.failure;
    }

    const recorded: RequeueResult = await store.requeue(
      id,
      {
        mode,
        expected: message.status,
        outputs,
        failure: failure === undefined ? undefined : storedFailure(failure),
        destinations: channel.destinations.length,
      },
      audit.actor,
    );
    await audit.emit([recorded.entry]);
    return describeRequeue(id, recorded, resend, failure, channel);
  };

  try {
    for (const id of ids) {
      try {
        results.push(await replayOne(id));
      } catch (error) {
        // A stored value that will not decrypt: this message is refused by the error's fixed text
        // and code, never shown garbled, and the others go on.
        if (!(error instanceof EncryptionError)) throw error;
        await audit.record({
          action: mode,
          outcome: "refused",
          messageId: id,
          detail: { reason: "unreadable", code: error.code },
        });
        results.push({
          id,
          outcome: "refused",
          reason: "unreadable",
          failure: `${error.message} (${error.code})`,
        });
      }
    }
  } finally {
    await Promise.all(
      [...workers.values()].map(async (worker) => {
        if (worker instanceof ChannelWorker) await worker.stop();
      }),
    );
  }
  return results;
}

/**
 * Clears failed messages, one after another: marks each, and its deliveries that failed for good,
 * `cleared`, so they leave the failed count and retention may delete them in time. Every attempt is
 * written to the audit log, in the same transaction as the change.
 *
 * @example
 * ```ts
 * const results = await clearMessages([9], { store, audit });
 * ```
 */
export async function clearMessages(
  ids: readonly number[],
  context: { readonly store: MessageStore; readonly audit: AuditLog },
): Promise<ClearOutcome[]> {
  const { store, audit } = context;
  const results: ClearOutcome[] = [];
  for (const id of ids) {
    const result = await store.clear(id, audit.actor);
    await audit.emit([result.entry]);
    if (result.done) {
      results.push({
        id,
        outcome: "cleared",
        messages: result.messages,
        deliveries: result.deliveries,
      });
    } else if (result.reason === "not-found") {
      results.push({ id, outcome: "not-found" });
    } else {
      results.push({ id, outcome: "refused", reason: result.reason });
    }
  }
  return results;
}

/**
 * The channel's worker, started once per run; or why its transform would not load, or its
 * configuration could not be resolved.
 */
async function workerFor(
  project: ProjectConfig,
  channel: ChannelConfig,
  workers: Map<string, ChannelWorker | FailureSummary>,
  env: Env,
): Promise<ChannelWorker | FailureSummary> {
  const known = workers.get(channel.name);
  if (known !== undefined) return known;
  const config = transformConfigFor(project, channel, env);
  if (!("resolved" in config)) {
    workers.set(channel.name, config);
    return config;
  }
  const worker = new ChannelWorker({
    channel: channel.name,
    transformFile: channel.transform,
    ...inboundOf(channel),
    format: channel.format,
    csv: channel.csv,
    timeoutMs: channel.settings.timeoutMs,
    memoryMb: channel.settings.memoryMb,
    config: config.resolved,
  });
  try {
    await worker.start();
    workers.set(channel.name, worker);
    return worker;
  } catch (error) {
    /* v8 ignore next: start() rejects only with TransformLoadError */
    if (!(error instanceof TransformLoadError)) throw error;
    workers.set(channel.name, error.failure);
    return error.failure;
  }
}

function describeRequeue(
  id: number,
  recorded: RequeueResult,
  resend: boolean,
  failure: FailureSummary | undefined,
  channel: ChannelConfig,
): ReplayResult {
  if (!recorded.done) {
    if (recorded.reason === "not-found") return { id, outcome: "not-found" };
    return { id, outcome: "refused", reason: recorded.reason };
  }
  const done = {
    id,
    outcome: resend ? ("resent" as const) : ("replayed" as const),
    status: recorded.status,
    queued: recorded.queued,
    superseded: recorded.superseded,
  };
  return failure === undefined ? done : { ...done, failure: describeFailure(failure, channel) };
}
