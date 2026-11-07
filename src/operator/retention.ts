import type { ProjectConfig } from "../config/schema.js";
import type { AuditEntry, MessageStore } from "../storage/store.js";
import type { AuditLog } from "./audit.js";

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
  readonly messages: number;
  readonly deliveries: number;
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
  readonly messages: number;
  readonly deliveries: number;
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
}

/**
 * Runs retention once: for each channel, deletes the messages that are done (delivered, filtered
 * or cleared) and whose last activity is older than the channel's `retention` setting, with their
 * deliveries. Failed messages, and messages with deliveries still pending, are never touched. A
 * channel no longer configured keeps the engine's default period.
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
  const periods = new Map<string, { retentionMs: number; configured: boolean }>();
  for (const name of await store.channels()) {
    periods.set(name, { retentionMs: project.settings.retentionMs, configured: false });
  }
  for (const channel of project.channels) {
    periods.set(channel.name, { retentionMs: channel.settings.retentionMs, configured: true });
  }
  const channels: Record<string, ChannelRetention> = {};
  let messages = 0;
  let deliveries = 0;
  const byName = [...periods.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, { retentionMs, configured }] of byName) {
    const cutoff = new Date(options.now - retentionMs).toISOString();
    const result = await store.expire(name, cutoff, options.dryRun);
    channels[name] = { retentionMs, cutoff, configured, ...result };
    messages += result.messages;
    deliveries += result.deliveries;
  }
  return { dryRun: options.dryRun, channels, messages, deliveries };
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
    },
  });
  return entry;
}
