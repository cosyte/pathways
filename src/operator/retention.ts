import type { ProjectConfig, RetentionClocks } from "../config/schema.js";
import type { KeyProvider } from "../encryption/keys.js";
import {
  retentionStore,
  type AuditEntry,
  type ExpireResult,
  type MessageStore,
  type RetentionQuery,
  type RetentionStep,
  type RetentionStore,
} from "../storage/store.js";
import {
  ARCHIVE_TARGET_BYTES,
  archivedMessage,
  writeArchive,
  type ArchiveFiles,
  type ArchivedMessage,
} from "./archive.js";
import { AuditLog } from "./audit.js";

/**
 * What retention did, or would do, to one channel. Counts and times only.
 *
 * @example
 * ```ts
 * const line = (name: string, c: ChannelRetention): string => `${name}: ${c.messages} before ${c.cutoff}`;
 * ```
 */
export interface ChannelRetention {
  /** How long the channel keeps a done message after its last activity, in milliseconds. */
  readonly retentionMs: number;
  /** Done messages last active before this time (ISO 8601) go. */
  readonly cutoff: string;
  /** False for a channel that has stored messages but is no longer configured. */
  readonly configured: boolean;
  /** Messages, and their deliveries, deleted by the metadata clock. */
  readonly messages: number;
  readonly deliveries: number;
  /**
   * The content clock, when the channel sets one: its period, its cutoff, and the messages whose
   * content went (or would go), with their deliveries.
   */
  readonly content?: StepRetention | undefined;
  /** The failed clock, when the channel sets one: the failed messages deleted, with their deliveries. */
  readonly failed?: StepRetention | undefined;
  /** How many archives were written, when `retention.archive` is set and this is no dry run. */
  readonly archives?: number | undefined;
  /**
   * Set when the channel was left alone part way: the code of what failed (an archive that could
   * not be written or checked, or its audit entry). What came before it was archived and applied.
   */
  readonly skipped?: string | undefined;
}

/**
 * One clock of a channel's retention: its period and cutoff, and what it reached.
 *
 * @example
 * ```ts
 * const step: StepRetention = { retentionMs: 604_800_000, cutoff: "2026-11-04T00:00:00.000Z", messages: 3, deliveries: 3 };
 * ```
 */
export interface StepRetention extends ExpireResult {
  readonly retentionMs: number;
  readonly cutoff: string;
}

/**
 * What one retention run did, or would do. Counts and times only.
 *
 * @example
 * ```ts
 * const report: RetentionReport = await runRetention(store, project, { now: Date.now(), dryRun: true });
 * ```
 */
export interface RetentionReport {
  readonly dryRun: boolean;
  readonly channels: Readonly<Record<string, ChannelRetention>>;
  /** Messages, and their deliveries, deleted by the metadata and failed clocks together. */
  readonly messages: number;
  readonly deliveries: number;
  /** Messages whose content went, when some channel has a content clock. */
  readonly pruned?: number | undefined;
  /** Archives written, when `retention.archive` is set. */
  readonly archives?: number | undefined;
  /** Channels left alone part way, when there were any. */
  readonly skipped?: number | undefined;
}

/**
 * Options for {@link runRetention}.
 *
 * @example
 * ```ts
 * const options: RetentionOptions = { now: Date.now(), dryRun: true };
 * ```
 */
export interface RetentionOptions {
  /** Epoch milliseconds now. */
  readonly now: number;
  /** Count what would go, and delete nothing. */
  readonly dryRun: boolean;
  /** Called after each channel is done, so a caller can see a long run make progress. */
  readonly onChannel?: () => void;
  /**
   * Called when a channel is left alone part way, with the code of what failed: the caller logs it.
   */
  readonly onSkip?: (channel: string, code: string) => void;
  /** Seals the archives, when `retention.archive` is set: the project's encryption keys. */
  readonly keys?: KeyProvider | undefined;
  /** Where each archive is recorded before its messages change. Defaults to one over `store`. */
  readonly audit?: AuditLog | undefined;
  /** The archive file operations; tests pass their own. */
  readonly files?: ArchiveFiles | undefined;
  /** The most messages one batch (and one archive) takes. Default 500. */
  readonly batch?: number | undefined;
  /**
   * How much one archive holds, roughly, in bytes, before the batch ends and the next archive
   * starts. Default 256 MiB, so each opens within `DEFAULT_ARCHIVE_LIMITS`.
   */
  readonly archiveBytes?: number | undefined;
}

/** How many messages one batch, and so one archive, takes by default. */
const BATCH = 500;

/** A channel left alone part way, with the code of what failed. */
class Skip extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "Skip";
  }
}

/** An error's string `code`, the only part of it that is safe to log. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "ERR_PATHWAYS_ARCHIVE";
}

/**
 * Runs retention once. For each channel, in this order, each clock it has:
 *
 * 1. `content`: done messages (delivered, filtered or cleared) last active before its cutoff lose
 *    their bodies, error texts and `ctx.meta`, and keep their rows;
 * 2. `failed`: failed messages last active before its cutoff are deleted, with their deliveries;
 * 3. `metadata` (`retention: 30d`, the default): done messages last active before its cutoff are
 *    deleted, with their deliveries. With a written-out `retention:` block, that takes messages
 *    whose content was dropped too; with the shorthand it leaves them, as it always has.
 *
 * Messages with deliveries still pending are never touched. A channel no longer configured keeps
 * the engine's default clocks. With `project.archive` set, every batch is first written to a sealed
 * archive, read back and checked, and recorded in the audit log, and only then changed; when any of
 * that fails, the channel is left alone from there and `onSkip` hears its code. A dry run counts.
 *
 * @example
 * ```ts
 * const report = await runRetention(store, project, { now: Date.now(), dryRun: true });
 * console.log(report.messages, report.deliveries);
 * ```
 */
export async function runRetention(
  store: MessageStore,
  project: ProjectConfig,
  options: RetentionOptions,
): Promise<RetentionReport> {
  const periods = new Map<
    string,
    { retentionMs: number; clocks: RetentionClocks | undefined; configured: boolean }
  >();
  for (const name of await store.channels()) {
    const { retentionMs, retentionClocks: clocks } = project.settings;
    periods.set(name, { retentionMs, clocks, configured: false });
  }
  for (const channel of project.channels) {
    const { retentionMs, retentionClocks: clocks } = channel.settings;
    periods.set(channel.name, { retentionMs, clocks, configured: true });
  }
  const steps = retentionStore(store);
  const channels: Record<string, ChannelRetention> = {};
  let messages = 0;
  let deliveries = 0;
  let pruned: number | undefined;
  let archives: number | undefined;
  let skipped = 0;
  const byName = [...periods.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, { retentionMs, clocks, configured }] of byName) {
    const cutoff = new Date(options.now - retentionMs).toISOString();
    const result: Clocked =
      clocks === undefined && project.archive === undefined
        ? // The metadata clock alone, as `retention: 30d` has always run it.
          await store.expire(name, cutoff, options.dryRun)
        : await clocked(store, steps, project, name, { retentionMs, clocks }, options);
    channels[name] = { retentionMs, cutoff, configured, ...result };
    messages += result.messages + (result.failed?.messages ?? 0);
    deliveries += result.deliveries + (result.failed?.deliveries ?? 0);
    if (result.content !== undefined) pruned = (pruned ?? 0) + result.content.messages;
    if (result.archives !== undefined) archives = (archives ?? 0) + result.archives;
    if (result.skipped !== undefined) {
      skipped += 1;
      options.onSkip?.(name, result.skipped);
    }
    options.onChannel?.();
  }
  return {
    dryRun: options.dryRun,
    channels,
    messages,
    deliveries,
    ...(pruned === undefined ? {} : { pruned }),
    ...(archives === undefined ? {} : { archives }),
    ...(skipped === 0 ? {} : { skipped }),
  };
}

type Clocked = Pick<
  ChannelRetention,
  "messages" | "deliveries" | "content" | "failed" | "archives" | "skipped"
>;

/** Every clock of one channel, archiving first when the project archives. */
async function clocked(
  store: MessageStore,
  steps: RetentionStore | undefined,
  project: ProjectConfig,
  channel: string,
  clock: { readonly retentionMs: number; readonly clocks: RetentionClocks | undefined },
  options: RetentionOptions,
): Promise<Clocked> {
  const { now, dryRun } = options;
  const at = (ms: number): string => new Date(now - ms).toISOString();
  const plan: { step: RetentionStep; retentionMs: number; query: RetentionQuery }[] = [];
  const { contentMs, failedMs } = clock.clocks ?? {};
  if (contentMs !== undefined) {
    plan.push({
      step: "content",
      retentionMs: contentMs,
      query: { step: "content", cutoff: at(contentMs) },
    });
  }
  if (failedMs !== undefined) {
    plan.push({
      step: "failed",
      retentionMs: failedMs,
      query: { step: "failed", cutoff: at(failedMs) },
    });
  }
  plan.push({
    step: "metadata",
    retentionMs: clock.retentionMs,
    query: {
      step: "metadata",
      cutoff: at(clock.retentionMs),
      includeDropped: clock.clocks !== undefined,
    },
  });
  const archiving = project.archive !== undefined && !dryRun;
  const done: Partial<Record<RetentionStep, ExpireResult>> = {};
  let archives = 0;
  let skipped: string | undefined;
  if (steps === undefined) {
    // A store without the retention methods can neither archive nor run the other clocks.
    skipped = "ERR_PATHWAYS_RETENTION_UNSUPPORTED";
  } else {
    try {
      for (const { step, query } of plan) {
        if (dryRun) {
          done[step] = await steps.countExpiring(channel, query);
          continue;
        }
        const ran = await runStep(store, steps, project, channel, query, options);
        done[step] = ran;
        archives += ran.archives;
      }
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped = error.code;
    }
  }
  const of = (step: RetentionStep): ExpireResult => {
    const result = done[step] ?? { messages: 0, deliveries: 0 };
    return { messages: result.messages, deliveries: result.deliveries };
  };
  const stepReport = (step: "content" | "failed"): StepRetention | undefined => {
    const entry = plan.find((candidate) => candidate.step === step);
    if (entry === undefined) return undefined;
    return { retentionMs: entry.retentionMs, cutoff: entry.query.cutoff, ...of(step) };
  };
  const content = stepReport("content");
  const failed = stepReport("failed");
  return {
    ...of("metadata"),
    ...(content === undefined ? {} : { content }),
    ...(failed === undefined ? {} : { failed }),
    ...(archiving ? { archives } : {}),
    ...(skipped === undefined ? {} : { skipped }),
  };
}

/**
 * One clock of one channel, a batch at a time: with an archive, each batch is written, read back,
 * checked and audited before it is changed. Throws a {@link Skip} when the archive or its audit
 * entry fails, having changed nothing of that batch.
 */
async function runStep(
  store: MessageStore,
  steps: RetentionStore,
  project: ProjectConfig,
  channel: string,
  query: RetentionQuery,
  options: RetentionOptions,
): Promise<ExpireResult & { readonly archives: number }> {
  const limit = options.batch ?? BATCH;
  let messages = 0;
  let deliveries = 0;
  let archives = 0;
  let after = 0;
  for (;;) {
    const ids = await steps.listExpiring(channel, query, limit, after);
    if (ids.length === 0) break;
    // How many of `ids` this batch went through: all of them, unless one archive filled first.
    let seen = ids.length;
    let batch: readonly number[] = ids;
    if (project.archive !== undefined) {
      const read = await readBatch(store, ids, options.archiveBytes ?? ARCHIVE_TARGET_BYTES);
      seen = read.seen;
      batch = read.records.map((record) => record.id);
      if (read.records.length > 0) {
        await archiveBatch(store, project.archive.dir, channel, query.step, read.records, options);
        archives += 1;
      }
    }
    const applied = await steps.applyExpiry(channel, batch, query);
    messages += applied.messages;
    deliveries += applied.deliveries;
    // Past what this batch went through, so a message that changed meanwhile, and was left, is
    // not taken again.
    after = ids[seen - 1] as number;
    if (ids.length < limit && seen === ids.length) break;
  }
  return { messages, deliveries, archives };
}

/**
 * The records of `ids`, decrypted, until they hold `bytes`, and how many of `ids` that went through.
 * A message deleted since it was listed is passed over.
 */
async function readBatch(
  store: MessageStore,
  ids: readonly number[],
  bytes: number,
): Promise<{ readonly records: ArchivedMessage[]; readonly seen: number }> {
  const records: ArchivedMessage[] = [];
  let held = 0;
  let seen = 0;
  for (const id of ids) {
    seen += 1;
    const record = await archivedMessage(store, id);
    // Listed a moment ago: another run can have deleted it meanwhile.
    if (record === undefined) continue;
    records.push(record);
    held += JSON.stringify(record).length;
    if (held >= bytes) break;
  }
  return { records, seen };
}

/** Writes, checks and audits one batch's archive; any failure is a {@link Skip}. */
async function archiveBatch(
  store: MessageStore,
  dir: string,
  channel: string,
  step: RetentionStep,
  records: readonly ArchivedMessage[],
  options: RetentionOptions,
): Promise<void> {
  const { keys } = options;
  if (keys === undefined) throw new Skip("ERR_PATHWAYS_ARCHIVE_NO_KEYS");
  try {
    await writeArchive({
      dir,
      channel,
      step,
      messages: records,
      keys,
      now: new Date(options.now),
      files: options.files,
    });
    const audit = options.audit ?? new AuditLog(store);
    await audit.record({
      action: "archive",
      channel,
      detail: {
        step,
        messages: records.length,
        first: (records[0] as ArchivedMessage).id,
        last: (records.at(-1) as ArchivedMessage).id,
      },
    });
  } catch (error) {
    throw new Skip(codeOf(error));
  }
}

/**
 * Writes a retention run to the audit log: one entry with the totals deleted and how many
 * channels were looked at. A dry run deletes nothing and is not recorded.
 *
 * @example
 * ```ts
 * await recordRetention(audit, await runRetention(store, project, { now: Date.now(), dryRun: false }));
 * ```
 */
export async function recordRetention(
  audit: AuditLog,
  report: RetentionReport,
): Promise<AuditEntry | undefined> {
  if (report.dryRun) return undefined;
  const [entry] = await audit.record({
    action: "retention",
    detail: {
      messages: report.messages,
      deliveries: report.deliveries,
      channels: Object.keys(report.channels).length,
      ...(report.pruned === undefined ? {} : { pruned: report.pruned }),
      ...(report.archives === undefined ? {} : { archives: report.archives }),
      ...(report.skipped === undefined ? {} : { skipped: report.skipped }),
    },
  });
  return entry;
}
