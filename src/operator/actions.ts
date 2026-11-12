import type { ChannelConfig, ProjectConfig } from "../config/schema.js";
import { transformConfigFor } from "../config/transform-config.js";
import type { Env } from "../connectors/endpoint.js";
import { EncryptionError } from "../encryption/envelope.js";
import { processEnv } from "../env.js";
import { ChannelWorker, destinationSetups, TransformLoadError } from "../engine/channel-worker.js";
import { destinationKeys } from "../engine/destination-key.js";
import { destinationOutcomes, storedFailure } from "../engine/engine.js";
import type { FailureSummary } from "../engine/worker-entry.js";
import type {
  DestinationOutcome,
  MessageStatus,
  MessageStore,
  RequeueResult,
} from "../storage/store.js";
import { describeFailure } from "../testing/run-tests.js";
import type { AuditLog } from "./audit.js";

/**
 * Why a replay, a resend or a clear was not done to a message:
 *
 * - `waiting`: it has not been transformed yet, and the engine will;
 * - `pending`: some of its deliveries still wait to be sent;
 * - `no-output`: a resend, but its current transform produced nothing to send, to any destination;
 * - `no-channel`: its channel is no longer configured;
 * - `transform-load`: its channel's transform could not be loaded;
 * - `changed`: it changed while the replay ran, so nothing was recorded;
 * - `unreadable`: what is stored of it could not be decrypted;
 * - `not-failed`: a clear, but nothing about it had failed;
 * - `routes`: a replay whose transform handed messages to other channels with `ctx.route`, which a
 *   replay does not hand over yet: nothing was recorded, and a resend still works;
 * - `content-dropped`: its content was dropped after delivery (`storage.content:
 *   dropAfterDelivery`), so there is nothing to replay or resend;
 * - `destination-unknown`: a resend, but its outputs were stored before deliveries recorded their
 *   destination, so which destination each was for cannot be told; a replay runs it again.
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
  | "content-dropped"
  | "destination-unknown"
  | "routes";

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
      /**
       * A resend: destinations with nothing stored for the message's last transform (added to the
       * channel since, or renamed), which were sent nothing. Absent when there were none.
       */
      readonly notStored?: number;
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
  /**
   * What a bulk replay counted: each message is refused as `changed`, and not replayed, unless it is
   * still at the generation counted and has not changed at or after `countedAt`.
   */
  readonly expect?: ReplayExpectation | undefined;
}

/**
 * The state a bulk replay counted its messages in, which each must still be in to be replayed.
 *
 * @example
 * ```ts
 * const expect: ReplayExpectation = { generations: new Map([[9, 0]]), countedAt: "2026-11-11T12:00:00.000Z" };
 * ```
 */
export interface ReplayExpectation {
  /** Each message's generation when it was counted, by id. */
  readonly generations: ReadonlyMap<number, number>;
  /** When the count began, in ISO 8601 UTC. */
  readonly countedAt: string;
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
    const expectedGeneration = context.expect?.generations.get(id);
    if (context.expect !== undefined && !unchanged(message, context.expect)) {
      return refuse(id, channel.name, "changed");
    }

    const keys = destinationKeys(project.root, channel.destinations);
    let outputs: readonly Uint8Array[] = [];
    let byDestination: DestinationOutcome[] | undefined;
    let failure: FailureSummary | undefined;
    if (resend) {
      if (message.status === "transformed") {
        const stored = await storedByDestination(store, id, message.generation, keys);
        if (stored === undefined) return refuse(id, channel.name, "destination-unknown");
        byDestination = stored;
        const same = sameForEvery(byDestination);
        if (same !== undefined) {
          // Every destination has the same outputs: queued as one list, as a store always took them.
          outputs = same;
          byDestination = undefined;
        }
      }
      const sends =
        byDestination === undefined
          ? outputs.length > 0
          : byDestination.some((o) => "outputs" in o && o.outputs.length > 0);
      if (!sends) return refuse(id, channel.name, "no-output");
    } else {
      const env = context.env ?? processEnv();
      const worker = await workerFor(project, channel, workers, env);
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
      // Its hand-offs would have to be stored with the replay's record, in its transaction, which a
      // replay does not do: refused, rather than queue the outputs and drop the hand-offs.
      if (outcome.ok && (outcome.routes?.length ?? 0) > 0)
        return refuse(id, channel.name, "routes");
      outputs = outcome.ok ? outcome.outputs : [];
      byDestination = outcome.ok ? destinationOutcomes(outcome) : undefined;
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
        keys,
        ...(byDestination === undefined ? {} : { byDestination }),
        expectedGeneration,
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

/** Whether a message stands as a bulk replay counted it: the same generation, no change since. */
function unchanged(
  message: { readonly id: number; readonly generation: number; readonly updatedAt: string },
  expect: ReplayExpectation,
): boolean {
  return (
    expect.generations.get(message.id) === message.generation &&
    Date.parse(message.updatedAt) < Date.parse(expect.countedAt)
  );
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
    format: channel.format,
    csv: channel.csv,
    hl7v2: channel.hl7v2,
    xml: channel.xml,
    timeoutMs: channel.settings.timeoutMs,
    memoryMb: channel.settings.memoryMb,
    config: config.resolved,
    destinations: destinationSetups(channel),
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

/**
 * What a resend sends to each destination: the outputs stored for it in the message's current
 * generation, so a destination transform changed since is not run again. A destination whose
 * transform filtered the message stays filtered, and one whose transform failed keeps its failure.
 *
 * Each destination is matched to what was stored for it by its key (see {@link destinationKeys}),
 * never by its place in the list, so adding, removing or moving a destination since gives none of
 * them another's outputs. A destination with no delivery of that generation under its key (added
 * since, or renamed) is `notStored` and gets nothing. A generation stored before deliveries
 * recorded their destination cannot be matched at all: `undefined`, and the resend is refused.
 */
async function storedByDestination(
  store: MessageStore,
  id: number,
  generation: number,
  keys: readonly string[],
): Promise<DestinationOutcome[] | undefined> {
  const current = (await store.deliveries(id)).filter((d) => d.generation === generation);
  if (current.some((d) => d.destinationKey === undefined)) return undefined;
  const outcomes: DestinationOutcome[] = [];
  for (const key of keys) {
    const rows = current.filter((d) => d.destinationKey === key);
    if (rows.length === 0) {
      outcomes.push({ notStored: true });
      continue;
    }
    const none = rows.find((d) => d.seq < 0);
    if (none === undefined) {
      outcomes.push({ outputs: await store.outputs(id, { key }) });
    } else if (none.status === "filtered") {
      outcomes.push({ outputs: [] });
    } else {
      // Its transform failed: there is nothing stored to send, and the failure stands. A row with
      // no output that is not filtered was written failed, with its error.
      outcomes.push({ failure: String(none.error) });
    }
  }
  return outcomes;
}

/** The outputs every destination has, when each has the same ones, byte for byte; else undefined. */
function sameForEvery(outcomes: readonly DestinationOutcome[]): readonly Uint8Array[] | undefined {
  const [first] = outcomes;
  if (first === undefined || !("outputs" in first)) return undefined;
  const equal = (a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean =>
    a.length === b.length &&
    a.every((output, index) => Buffer.from(output).equals(b[index] ?? new Uint8Array()));
  return outcomes.every((o) => "outputs" in o && equal(o.outputs, first.outputs))
    ? first.outputs
    : undefined;
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
    ...(recorded.notStored === undefined || recorded.notStored === 0
      ? {}
      : { notStored: recorded.notStored }),
  };
  return failure === undefined ? done : { ...done, failure: describeFailure(failure, channel) };
}
