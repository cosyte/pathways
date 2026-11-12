import { EXIT } from "../exit.js";
import type { AuditDetail, AuditEntry, MessageStore } from "../storage/store.js";
import { replayMessages, type ActionRefusal, type ReplayResult } from "./actions.js";
import type { OperatorContext } from "./commands.js";

/**
 * How many messages a bulk replay replays between two audit entries when `--batch` is not given.
 *
 * @example
 * ```ts
 * DEFAULT_REPLAY_BATCH; // 100
 * ```
 */
export const DEFAULT_REPLAY_BATCH = 100;

/**
 * The most messages one batch of a bulk replay may hold.
 *
 * @example
 * ```ts
 * MAX_REPLAY_BATCH; // 1000
 * ```
 */
export const MAX_REPLAY_BATCH = 1_000;

/** How many message summaries the count reads a page. Summaries carry no content. */
const COUNT_PAGE = 1_000;

/**
 * Which failed messages a bulk replay takes: those failed now that match the filters, were counted
 * no later than `upTo`, and have not changed since `countedAt`. A resumed run reads the same scope
 * back from the audit log, so what the first run replayed, which changed when it was replayed, is
 * never replayed again.
 *
 * @example
 * ```ts
 * const scope: BulkReplayScope = { channel: "adt", upTo: 120, countedAt: "2026-11-11T12:00:00.000Z", resend: false };
 * ```
 */
export interface BulkReplayScope {
  readonly channel?: string | undefined;
  /** Only messages with a failed delivery to this destination, by its place in the channel's list from 0. */
  readonly destination?: number | undefined;
  /** Received at or after this time (ISO 8601, UTC). */
  readonly since?: string | undefined;
  /** Received before this time (ISO 8601, UTC). */
  readonly until?: string | undefined;
  /** The highest message id the count took; 0 before the count. */
  readonly upTo: number;
  /** When the count began (ISO 8601, UTC). A message changed at or after it is skipped. */
  readonly countedAt: string;
  /** Send the stored outputs again instead of transforming. */
  readonly resend: boolean;
}

/**
 * One message a bulk replay counted, and the generation it was at.
 *
 * @example
 * ```ts
 * const counted: CountedMessage = { id: 9, generation: 0 };
 * ```
 */
export interface CountedMessage {
  readonly id: number;
  readonly generation: number;
}

/**
 * The failed messages in `scope`, oldest first: each failed now, received within its times, at or
 * below `upTo` when that is set, unchanged since `countedAt`, and with `destination` set, holding a
 * failed delivery of its current generation to that destination. A message changed at or after
 * `countedAt` is left out, and so is one with a delivery of its current generation that failed for
 * good then: a delivery's failure writes only the delivery, so a message pending at the count and
 * failed after it would otherwise look unchanged. Reads summaries and deliveries only, never
 * content.
 *
 * @example
 * ```ts
 * const counted = await countBulkReplay(store, scope);
 * ```
 */
export async function countBulkReplay(
  store: MessageStore,
  scope: BulkReplayScope,
): Promise<CountedMessage[]> {
  const countedAt = Date.parse(scope.countedAt);
  const counted: CountedMessage[] = [];
  let before = scope.upTo > 0 ? scope.upTo + 1 : undefined;
  do {
    const page = await store.listMessages({
      channel: scope.channel,
      state: "failed",
      since: scope.since,
      until: scope.until,
      before,
      limit: COUNT_PAGE,
    });
    for (const message of page.items) {
      // A custom store's listing is checked again here: a row outside the scope is never replayed.
      if (message.state !== "failed" || Date.parse(message.updatedAt) >= countedAt) continue;
      if (scope.channel !== undefined && message.channel !== scope.channel) continue;
      const current = (await store.deliveries(message.id)).filter(
        (delivery) => delivery.generation === message.generation && delivery.status === "failed",
      );
      const failedLater = current.some(
        (delivery) => delivery.failedAt !== undefined && Date.parse(delivery.failedAt) >= countedAt,
      );
      if (failedLater) continue;
      if (
        scope.destination !== undefined &&
        !current.some((delivery) => delivery.destination === scope.destination)
      ) {
        continue;
      }
      counted.push({ id: message.id, generation: message.generation });
    }
    before = page.next;
  } while (before !== undefined);
  return counted.reverse();
}

/**
 * What `pathways replay --status failed` (or `--resume`) runs with, beyond the operator context.
 *
 * @example
 * ```ts
 * const options: BulkReplayOptions = { scope: { channel: "adt", resend: false }, yes: true, batch: 100 };
 * ```
 */
export interface BulkReplayOptions {
  /** A new run's filters; the count sets the rest. Unset when `resume` is. */
  readonly scope?: Omit<BulkReplayScope, "upTo" | "countedAt"> | undefined;
  /** The id of the audit entry that began the run to go on with. */
  readonly resume?: number | undefined;
  /** Go on without asking for the count to be typed. */
  readonly yes: boolean;
  /** Messages a batch. */
  readonly batch: number;
}

/** What one run of a bulk replay did, in counts. */
interface Tally {
  replayed: number;
  failed: number;
  refused: number;
  skipped: number;
}

/**
 * `pathways replay --status failed`: counts the failed messages in scope and shows the scope, then,
 * once the count is typed back (or `--yes` is given), replays them oldest first in batches of
 * `batch`. A message that changed since the count (replayed, resent or cleared by anyone) is
 * skipped. The run is audited: an entry with the scope before anything is replayed (its id names
 * the run), each message's own replay entry, an entry for each batch, and a summary. Stopped by the
 * signal between two batches, it says how to go on: `--resume <run>` counts again under the same
 * scope, and what was replayed has changed since the count, so it is not replayed twice.
 *
 * Exits {@link EXIT.ok} when every message counted was replayed or skipped and none failed again,
 * {@link EXIT.failed} when one was refused or failed again, the count was not typed, or the run was
 * stopped, {@link EXIT.usage} when the count cannot be asked for, and {@link EXIT.notFound} when the
 * run to resume does not exist.
 *
 * @example
 * ```ts
 * const code = await bulkReplayCommand(context, { scope: { channel: "adt", resend: false }, yes: true, batch: 100 });
 * ```
 */
export async function bulkReplayCommand(
  context: OperatorContext,
  options: BulkReplayOptions,
): Promise<number> {
  const { project, store, audit, env } = context;
  let scope: BulkReplayScope;
  let run: number | undefined;
  if (options.resume !== undefined) {
    const begun = await runEntry(store, options.resume);
    if (begun === undefined) {
      context.err(
        "pathways: there is no bulk replay with that id; it is the id the run printed.\n",
      );
      return EXIT.notFound;
    }
    scope = begun;
    run = options.resume;
  } else {
    // A new run: options.scope is set whenever resume is not.
    const filters = options.scope as Omit<BulkReplayScope, "upTo" | "countedAt">;
    scope = { ...filters, upTo: 0, countedAt: new Date(context.now()).toISOString() };
  }
  // Checked again on a resume: the project may have been reloaded since the run began.
  const refusal = checkFilters(context, scope);
  if (refusal !== undefined) {
    context.err(refusal);
    return EXIT.usage;
  }

  const counted = await countBulkReplay(store, scope);
  const count = counted.length;
  if (run === undefined) scope = { ...scope, upTo: counted.at(-1)?.id ?? 0 };
  const lines = describeScope(scope, count, run);
  if (count === 0) {
    print(context, { run: run ?? null, scope, count, batches: [], summary: null }, [
      ...lines,
      "Nothing to replay.",
    ]);
    return EXIT.ok;
  }
  if (!context.json) context.out(`${lines.join("\n")}\n`);
  if (!options.yes) {
    if (context.ask === undefined || context.json) {
      context.err(
        `pathways: replaying ${String(count)} messages needs their count typed at a terminal; add --yes to go on without it.\n`,
      );
      return EXIT.usage;
    }
    const answer = await context.ask(
      `Type ${String(count)} to ${verbs(scope).verb} ${String(count)} messages: `,
    );
    if (answer?.trim() !== String(count)) {
      context.err("pathways: the count was not typed, so nothing was replayed.\n");
      return EXIT.failed;
    }
  }

  // Audited before the first replay: no entry, no run. Its id names the run.
  const [begun] = await audit.record({
    action: "bulk-replay",
    channel: scope.channel,
    detail:
      run === undefined
        ? { phase: "scope", ...scopeDetail(scope), count, batch: options.batch }
        : { phase: "resume", run, count, batch: options.batch },
  });
  /* v8 ignore next: record returns one entry per input */
  if (begun === undefined) throw new Error("the audit entry was not written");
  run ??= begun.id;

  const expect = {
    generations: new Map(counted.map((message) => [message.id, message.generation])),
    countedAt: scope.countedAt,
  };
  const total: Tally = { replayed: 0, failed: 0, refused: 0, skipped: 0 };
  const batches: (Tally & { batch: number; first: number; last: number })[] = [];
  let stopped = false;
  for (let start = 0; start < count; start += options.batch) {
    if (context.signal?.aborted === true) {
      stopped = true;
      break;
    }
    const ids = counted.slice(start, start + options.batch).map((message) => message.id);
    const results = await replayMessages(ids, {
      project,
      store,
      audit,
      resend: scope.resend,
      env,
      expect,
    });
    const tally = tallyOf(results);
    const batch = {
      batch: batches.length + 1,
      // A batch holds at least one id.
      first: ids[0] as number,
      last: ids.at(-1) as number,
      ...tally,
    };
    batches.push(batch);
    for (const key of ["replayed", "failed", "refused", "skipped"] as const) {
      total[key] += tally[key];
    }
    await audit.record({
      action: "bulk-replay",
      channel: scope.channel,
      detail: { phase: "batch", run, ...batch },
    });
    if (!context.json) {
      context.out(
        `batch ${String(batch.batch)}: messages ${String(batch.first)} to ${String(batch.last)}: ${describeTally(tally)}\n`,
      );
    }
  }
  const done = batches.reduce((n, b) => n + b.replayed + b.failed + b.refused + b.skipped, 0);
  const summary = { ...total, batches: batches.length, left: count - done, stopped };
  await audit.record({
    action: "bulk-replay",
    outcome: stopped ? "refused" : "ok",
    channel: scope.channel,
    detail: {
      phase: "summary",
      run,
      count,
      ...summary,
      ...(stopped ? { reason: "stopped" } : {}),
    },
  });
  const end = [`Run ${String(run)}: ${describeTally(total)} of ${String(count)}.`];
  if (stopped) {
    end.push(
      `Stopped with ${String(summary.left)} left; go on with: pathways replay --resume ${String(run)}`,
    );
  }
  if (context.json) {
    context.out(`${JSON.stringify({ run, scope, count, batches, summary })}\n`);
  } else {
    context.out(`${end.join("\n")}\n`);
  }
  return stopped || total.failed > 0 || total.refused > 0 ? EXIT.failed : EXIT.ok;
}

/** Why the project cannot take `scope`'s channel or destination, or undefined when it can. */
function checkFilters(context: OperatorContext, scope: BulkReplayScope): string | undefined {
  const { channels } = context.project;
  const channel = channels.find((candidate) => candidate.name === scope.channel);
  if (scope.channel !== undefined && channel === undefined) {
    return `pathways: no such channel. The channels are: ${channels.map((c) => c.name).join(", ")}\n`;
  }
  if (scope.destination === undefined) return undefined;
  if (channel === undefined) return "pathways: --destination needs --channel.\n";
  const last = channel.destinations.length - 1;
  if (scope.destination > last) {
    return `pathways: --destination takes the destination's place in the channel's list, from 0 to ${String(last)}.\n`;
  }
  return undefined;
}

/** The scope a run began with, read back from its first audit entry; undefined when there is none. */
async function runEntry(store: MessageStore, id: number): Promise<BulkReplayScope | undefined> {
  const page = await store.auditEntries({ action: "bulk-replay", before: id + 1, limit: 1 });
  const entry: AuditEntry | undefined = page.items[0];
  if (entry?.id !== id || entry.detail["phase"] !== "scope") return undefined;
  const { detail } = entry;
  const text = (key: string): string | undefined =>
    typeof detail[key] === "string" ? detail[key] : undefined;
  const destination = detail["destination"];
  return {
    channel: entry.channel ?? undefined,
    destination: typeof destination === "number" ? destination : undefined,
    since: text("since"),
    until: text("until"),
    upTo: Number(detail["upTo"]),
    countedAt: String(detail["countedAt"]),
    resend: detail["resend"] === true,
  };
}

/** A scope as its audit entry holds it: the filters given, the count's bounds, never a value. */
function scopeDetail(scope: BulkReplayScope): AuditDetail {
  const detail: Record<string, string | number | boolean> = {
    upTo: scope.upTo,
    countedAt: scope.countedAt,
    resend: scope.resend,
  };
  if (scope.destination !== undefined) detail["destination"] = scope.destination;
  if (scope.since !== undefined) detail["since"] = scope.since;
  if (scope.until !== undefined) detail["until"] = scope.until;
  return detail;
}

/** What the run does to each message, as its text says it. */
function verbs(scope: BulkReplayScope): { readonly verb: string; readonly done: string } {
  return scope.resend ? { verb: "resend", done: "resent" } : { verb: "replay", done: "replayed" };
}

/** The scope, as the run prints it before it asks for the count. */
function describeScope(scope: BulkReplayScope, count: number, run: number | undefined): string[] {
  const { verb, done } = verbs(scope);
  const lines = [
    run === undefined
      ? `${String(count)} failed messages to ${verb}:`
      : `Run ${String(run)}: ${String(count)} failed messages left to ${verb}:`,
    `  channel: ${scope.channel ?? "every channel"}`,
  ];
  if (scope.destination !== undefined) {
    lines.push(
      `  failed at destination ${String(scope.destination)}; each is ${done} to every destination of its channel`,
    );
  }
  if (scope.since !== undefined) lines.push(`  received since ${scope.since}`);
  if (scope.until !== undefined) lines.push(`  received before ${scope.until}`);
  if (scope.upTo > 0) lines.push(`  ids up to ${String(scope.upTo)}`);
  lines.push(`  unchanged since ${scope.countedAt}; one changed later is skipped`);
  return lines;
}

/** The refusals that mean a message moved since the count, so the run skips it. */
const SKIPPED: ReadonlySet<ActionRefusal> = new Set(["changed", "pending", "waiting"]);

/** One batch's results, in counts. A message that changed since the count is skipped. */
function tallyOf(results: readonly ReplayResult[]): Tally {
  const tally: Tally = { replayed: 0, failed: 0, refused: 0, skipped: 0 };
  for (const result of results) {
    if ("status" in result) {
      if (result.status === "failed") tally.failed += 1;
      else tally.replayed += 1;
    } else if (!("reason" in result) || SKIPPED.has(result.reason)) {
      // Gone, or no longer where it was counted: someone else acted on it since.
      tally.skipped += 1;
    } else {
      tally.refused += 1;
    }
  }
  return tally;
}

function describeTally(tally: Tally): string {
  return `${String(tally.replayed)} replayed, ${String(tally.failed)} failed again, ${String(tally.refused)} refused, ${String(tally.skipped)} skipped`;
}

function print(context: OperatorContext, json: unknown, lines: readonly string[]): void {
  context.out(context.json ? `${JSON.stringify(json)}\n` : `${lines.join("\n")}\n`);
}
