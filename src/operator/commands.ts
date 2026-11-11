import { parseDuration, type ProjectConfig } from "../config/schema.js";
import { channelStatus } from "../engine/health.js";
import { describeHolder } from "../engine/lease.js";
import { EXIT } from "../exit.js";
import {
  AUDIT_ACTIONS,
  ENGINE_LEASE,
  leaseStore,
  MESSAGE_STATES,
  type AuditAction,
  type AuditDetail,
  type AuditEntry,
  type DeliveryTally,
  type MessageState,
  type MessageStore,
  type StoredDelivery,
} from "../storage/store.js";
import {
  clearMessages,
  replayMessages,
  type ActionRefusal,
  type ClearOutcome,
  type ReplayResult,
} from "./actions.js";
import type { AuditLog } from "./audit.js";
import { recordRetention, runRetention } from "./retention.js";

/**
 * What every operator command runs with: the project, its store and audit log, and where to write.
 *
 * @example
 * ```ts
 * const context: OperatorContext = { project, store, audit, json: false, out, err, now: Date.now };
 * ```
 */
export interface OperatorContext {
  readonly project: ProjectConfig;
  readonly store: MessageStore;
  readonly audit: AuditLog;
  /** Print one JSON document instead of text. */
  readonly json: boolean;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Epoch milliseconds now. */
  readonly now: () => number;
}

/**
 * The filters `pathways messages` takes, parsed.
 *
 * @example
 * ```ts
 * const filters: MessageFilters = { channel: "adt", state: "failed", limit: 50 };
 * ```
 */
export interface MessageFilters {
  readonly channel?: string | undefined;
  readonly state?: MessageState | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly before?: number | undefined;
  readonly limit: number;
}

/**
 * The filters `pathways audit` takes, parsed.
 *
 * @example
 * ```ts
 * const filters: AuditFilters = { action: "content-view", messageId: 12, limit: 50 };
 * ```
 */
export interface AuditFilters {
  readonly action?: AuditAction | undefined;
  readonly channel?: string | undefined;
  readonly messageId?: number | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly before?: number | undefined;
  readonly limit: number;
}

/**
 * How many rows a listing shows when `--limit` is not given.
 *
 * @example
 * ```ts
 * DEFAULT_LIMIT; // 50
 * ```
 */
export const DEFAULT_LIMIT = 50;

/**
 * The most rows one listing shows.
 *
 * @example
 * ```ts
 * MAX_LIMIT; // 1000
 * ```
 */
export const MAX_LIMIT = 1_000;

/** How many retrying deliveries and failed messages `pathways status` names per channel. */
const STATUS_LIST = 10;

const ID = /^[1-9]\d{0,15}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const CHANNEL = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A message or entry id from the command line: a positive whole number, or `undefined`.
 *
 * @example
 * ```ts
 * parseId("12"); // 12
 * parseId("12abc"); // undefined
 * ```
 */
export function parseId(text: string): number | undefined {
  if (!ID.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * A time from the command line, as ISO 8601 UTC: a date (`2026-11-07`), a date and time
 * (`2026-11-07T12:00:00Z`; with no zone, UTC), or a duration before `now` (`24h`, `7d`).
 *
 * @example
 * ```ts
 * parseTime("2026-11-07", Date.now()); // "2026-11-07T00:00:00.000Z"
 * parseTime("24h", Date.parse("2026-11-07T12:00:00Z")); // "2026-11-06T12:00:00.000Z"
 * ```
 */
export function parseTime(text: string, now: number): string | undefined {
  const ago = parseDuration(text);
  if (ago !== undefined) return new Date(now - ago).toISOString();
  if (!DATE.test(text)) return undefined;
  const zoned = /T.*(Z|[+-]\d{2}:\d{2})$/.test(text) || !text.includes("T") ? text : `${text}Z`;
  const time = Date.parse(zoned);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * A `--limit` from the command line: 1 to {@link MAX_LIMIT}, or `undefined`.
 *
 * @example
 * ```ts
 * parseLimit("20"); // 20
 * parseLimit("0"); // undefined
 * ```
 */
export function parseLimit(text: string): number | undefined {
  const limit = parseId(text);
  return limit !== undefined && limit <= MAX_LIMIT ? limit : undefined;
}

/**
 * A `--status` for `pathways messages`: one of {@link MESSAGE_STATES}, or `undefined`.
 *
 * @example
 * ```ts
 * parseState("failed"); // "failed"
 * ```
 */
export function parseState(text: string): MessageState | undefined {
  return MESSAGE_STATES.find((state) => state === text);
}

/**
 * An `--action` for `pathways audit`: one of {@link AUDIT_ACTIONS}, or `undefined`.
 *
 * @example
 * ```ts
 * parseAction("replay"); // "replay"
 * ```
 */
export function parseAction(text: string): AuditAction | undefined {
  return AUDIT_ACTIONS.find((action) => action === text);
}

/**
 * Whether `text` could name a channel: lowercase letters, digits and hyphens.
 *
 * @example
 * ```ts
 * isChannelName("adt-to-lab"); // true
 * ```
 */
export function isChannelName(text: string): boolean {
  return CHANNEL.test(text);
}

/**
 * `pathways status`: each channel's counts, its retrying deliveries and its failed messages, from
 * the database. Ids, counts, states and times only. Names a channel only once it is known.
 *
 * @example
 * ```ts
 * const code = await statusCommand(context, []);
 * ```
 */
export async function statusCommand(
  context: OperatorContext,
  names: readonly string[],
): Promise<number> {
  const { project, store } = context;
  const configured = new Set(project.channels.map((channel) => channel.name));
  const known = [...new Set([...configured, ...(await store.channels())])].sort();
  if (names.some((name) => !known.includes(name))) return noSuchChannel(context, known);
  const chosen = names.length === 0 ? known : known.filter((name) => names.includes(name));

  const channels: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const name of chosen) {
    const [messages, counts, retryingCount, retrying, failed] = await Promise.all([
      store.messageCounts(name),
      store.deliveryCounts(name),
      store.retryingDeliveries(name),
      store.listRetrying(name, STATUS_LIST + 1),
      store.listMessages({ channel: name, state: "failed", limit: STATUS_LIST }),
    ]);
    const deliveries = { ...counts, retrying: retryingCount };
    const status = channelStatus(messages, deliveries);
    const shown = retrying.slice(0, STATUS_LIST).map((delivery) => ({
      delivery: delivery.id,
      message: delivery.messageId,
      destination: delivery.destination,
      attempts: delivery.attempts,
      nextAttemptAt: new Date(delivery.nextAttemptAt).toISOString(),
    }));
    const failures = failed.items.map((message) => ({
      message: message.id,
      since: message.updatedAt,
    }));
    const more = { retrying: retrying.length > STATUS_LIST, failed: failed.next !== undefined };
    channels[name] = {
      status,
      configured: configured.has(name),
      messages,
      deliveries,
      retrying: shown,
      failed: failures,
      more,
    };

    lines.push(`${name}: ${status}${configured.has(name) ? "" : " (not configured)"}`);
    lines.push(`  messages: ${tally(messages)}`);
    lines.push(
      `  deliveries: ${counts.pending} pending (${retryingCount} retrying), ${counts.delivered} delivered, ${counts.failed} failed, ${counts.cleared} cleared`,
    );
    for (const d of shown) {
      lines.push(
        `  retrying: delivery ${d.delivery} (message ${d.message}, destination ${d.destination}), ${count(d.attempts, "attempt")}, next try ${d.nextAttemptAt}`,
      );
    }
    if (more.retrying) lines.push(`  more retrying deliveries than shown`);
    for (const f of failures) lines.push(`  failed: message ${f.message}, since ${f.since}`);
    if (more.failed) {
      lines.push(`  more failed: pathways messages --channel ${name} --status failed`);
    }
  }
  print(context, { channels }, lines);
  return EXIT.ok;
}

/**
 * `pathways messages`: a page of stored messages, newest first, with ids, states, times, sizes and
 * duplicate flags, never content. The search is written to the audit log.
 *
 * @example
 * ```ts
 * const code = await listCommand(context, { state: "failed", limit: 20 });
 * ```
 */
export async function listCommand(
  context: OperatorContext,
  filters: MessageFilters,
): Promise<number> {
  const { project, store, audit } = context;
  if (filters.channel !== undefined) {
    const known = [
      ...new Set([...project.channels.map((c) => c.name), ...(await store.channels())]),
    ].sort();
    if (!known.includes(filters.channel)) return noSuchChannel(context, known);
  }
  const page = await store.listMessages(filters);
  const { state, since, until } = filters;
  await audit.record({
    action: "search",
    channel: filters.channel,
    detail: {
      results: page.items.length,
      ...(state === undefined ? {} : { state }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    },
  });

  const lines =
    page.items.length === 0
      ? ["No messages match."]
      : table([
          ["ID", "CHANNEL", "STATE", "RECEIVED", "BYTES", "DUPLICATE OF", "DELIVERIES"],
          ...page.items.map((m) => [
            String(m.id),
            m.channel,
            m.state,
            m.receivedAt,
            m.size === null ? "-" : String(m.size),
            m.duplicateOf === null ? "-" : String(m.duplicateOf),
            deliverySummary(m.deliveries),
          ]),
        ]);
  if (page.next !== undefined) lines.push(`More: add --before ${page.next} for the next page.`);
  print(context, { messages: page.items, next: page.next ?? null }, lines);
  return EXIT.ok;
}

/**
 * `pathways messages show <id>`: one message and its deliveries, with stored errors cut to their
 * stage, name, code and location. Its content (as received, and its current outputs) only with
 * `content`; that view is written to the audit log first, and not shown if it cannot be.
 *
 * @example
 * ```ts
 * const code = await showCommand(context, 12, false);
 * ```
 */
export async function showCommand(
  context: OperatorContext,
  id: number,
  content: boolean,
): Promise<number> {
  const { store, audit } = context;
  const action = content ? "content-view" : "view";
  const message = await store.message(id);
  if (message === undefined) {
    await audit.record({ action, outcome: "not-found", messageId: id });
    context.err("pathways: there is no such message.\n");
    return EXIT.notFound;
  }
  const deliveries = await store.deliveries(id);
  let received: Uint8Array | undefined;
  let outputs: Uint8Array[] = [];
  if (content) {
    try {
      await audit.record({ action, channel: message.channel, messageId: id });
    } catch {
      context.err("pathways: the audit log could not be written, so the content is not shown.\n");
      return EXIT.failed;
    }
    received = await store.messageBody(id);
    outputs = await store.outputs(id);
  } else {
    await audit.record({ action, channel: message.channel, messageId: id });
  }

  const { error, ...summary } = message;
  const shownDeliveries = deliveries.map((delivery) => ({
    ...delivery,
    error: safeError(delivery.error),
  }));
  const lines = [
    `Message ${message.id}`,
    ...table([
      ["  channel", message.channel],
      ["  state", message.state],
      ["  status", message.status],
      ["  received", message.receivedAt],
      ["  updated", message.updatedAt],
      ["  bytes", message.size === null ? "-" : String(message.size)],
      ["  duplicate of", message.duplicateOf === null ? "-" : String(message.duplicateOf)],
      ["  generation", String(message.generation)],
      ["  error", safeError(error) ?? "-"],
    ]),
    deliveries.length === 0 ? "No deliveries." : "Deliveries:",
    ...(deliveries.length === 0 ? [] : indent(deliveryTable(deliveries))),
  ];
  let json: Record<string, unknown> = {
    message: { ...summary, error: safeError(error) },
    deliveries: shownDeliveries,
  };
  if (received === undefined) {
    if (!content) {
      lines.push("Content not shown: add --content to print it. Each view is audited.");
    }
  } else {
    const decoder = new TextDecoder();
    json = {
      ...json,
      content: {
        received: decoder.decode(received),
        outputs: outputs.map((output) => decoder.decode(output)),
      },
    };
    lines.push(`Content as received (${received.byteLength} bytes):`, display(received));
    for (const [index, output] of outputs.entries()) {
      lines.push(
        `Output ${index + 1} of ${outputs.length} (${output.byteLength} bytes):`,
        display(output),
      );
    }
  }
  print(context, json, lines);
  return EXIT.ok;
}

/**
 * `pathways replay <id...>` (and `--resend`): replays each message and prints what became of it.
 * Exits {@link EXIT.notFound} when a message does not exist, else {@link EXIT.failed} when one was
 * refused or failed again, else {@link EXIT.ok}.
 *
 * @example
 * ```ts
 * const code = await replayCommand(context, [9, 17], false);
 * ```
 */
export async function replayCommand(
  context: OperatorContext,
  ids: readonly number[],
  resend: boolean,
): Promise<number> {
  const { project, store, audit } = context;
  const results = await replayMessages(ids, { project, store, audit, resend });
  print(
    context,
    { results },
    results.map((result) => `message ${result.id}: ${describeReplay(result)}`),
  );
  return actionCode(
    results,
    (result) => result.outcome === "refused" || ("status" in result && result.status === "failed"),
  );
}

/**
 * `pathways clear <id...>`: clears each failed message and prints what became of it. Exit codes as
 * for {@link replayCommand}.
 *
 * @example
 * ```ts
 * const code = await clearCommand(context, [9]);
 * ```
 */
export async function clearCommand(
  context: OperatorContext,
  ids: readonly number[],
): Promise<number> {
  const results = await clearMessages(ids, context);
  print(
    context,
    { results },
    results.map((result) => `message ${result.id}: ${describeClear(result)}`),
  );
  return actionCode(results, (result) => result.outcome === "refused");
}

/**
 * `pathways retention [--dry-run]`: deletes done messages past their channel's retention period,
 * or with `dryRun` reports what would go. Counts and times only. A real run is audited.
 *
 * @example
 * ```ts
 * const code = await retentionCommand(context, true);
 * ```
 */
export async function retentionCommand(context: OperatorContext, dryRun: boolean): Promise<number> {
  const { project, store, audit } = context;
  const report = await runRetention(store, project, { now: context.now(), dryRun });
  await recordRetention(audit, report);
  const totals = `${count(report.messages, "message")} and ${count(report.deliveries, "delivery", "deliveries")}`;
  const lines = [
    dryRun
      ? `Retention dry run: ${totals} would be deleted. Nothing was deleted.`
      : `Retention deleted ${totals}.`,
  ];
  for (const [name, channel] of Object.entries(report.channels)) {
    lines.push(
      `  ${name}: ${count(channel.messages, "message")}, ${count(channel.deliveries, "delivery", "deliveries")} (done, and last active before ${channel.cutoff})`,
    );
  }
  print(context, report, lines);
  return EXIT.ok;
}

/**
 * `pathways lease status`: who holds the engine lease, since when, under which epoch, and how long
 * it has left, by the database's clock. Ids, a host name, times and numbers only.
 *
 * @example
 * ```ts
 * const code = await leaseStatusCommand(context);
 * ```
 */
export async function leaseStatusCommand(context: OperatorContext): Promise<number> {
  const leases = leaseStore(context.store);
  if (leases === undefined) return noLeases(context);
  const holder = await leases.leaseHolder(ENGINE_LEASE);
  const held = holder !== undefined && holder.expiresInMs > 0;
  let line = "Engine lease: never taken.";
  if (holder !== undefined) {
    line = held
      ? `Engine lease: held by ${describeHolder(holder)}.`
      : `Engine lease: free; last held by ${describeHolder(holder)}.`;
  }
  print(context, { lease: ENGINE_LEASE, held, holder: holder ?? null }, [line]);
  return EXIT.ok;
}

/**
 * `pathways lease release --force`: frees the engine lease of an engine whose host is gone, so the
 * next engine takes it at once rather than after it lapses. The release is written to the audit
 * log, whichever way it goes. An engine still running under it stops at its next renewal.
 *
 * @example
 * ```ts
 * const code = await leaseReleaseCommand(context);
 * ```
 */
export async function leaseReleaseCommand(context: OperatorContext): Promise<number> {
  const leases = leaseStore(context.store);
  if (leases === undefined) return noLeases(context);
  const holder = await leases.leaseHolder(ENGINE_LEASE);
  const held = holder !== undefined && holder.expiresInMs > 0 ? holder : undefined;
  if (held === undefined || !(await leases.releaseLease(ENGINE_LEASE, held.epoch))) {
    await context.audit.record({
      action: "lease-release",
      outcome: "refused",
      detail: { reason: "free" },
    });
    print(context, { released: false, holder: holder ?? null }, [
      "Engine lease: nothing to release; it is free.",
    ]);
    return EXIT.failed;
  }
  await context.audit.record({
    action: "lease-release",
    detail: { node: held.node, epoch: held.epoch, leftMs: held.expiresInMs },
  });
  print(context, { released: true, holder: held }, [
    `Engine lease released: it was held by ${describeHolder(held)}. The next engine to start takes it.`,
  ]);
  return EXIT.ok;
}

function noLeases(context: OperatorContext): number {
  context.err(
    "pathways: this store has no engine lease: a custom store without the lease methods runs one engine, unfenced.\n",
  );
  return EXIT.failed;
}

/**
 * `pathways audit`: a page of the audit log, newest first.
 *
 * @example
 * ```ts
 * const code = await auditCommand(context, { action: "content-view", limit: 50 });
 * ```
 */
export async function auditCommand(
  context: OperatorContext,
  filters: AuditFilters,
): Promise<number> {
  const page = await context.store.auditEntries(filters);
  const lines =
    page.items.length === 0
      ? ["No audit entries match."]
      : table([
          ["ID", "AT", "ACTOR", "ACTION", "OUTCOME", "CHANNEL", "MESSAGE", "DETAIL"],
          ...page.items.map((entry: AuditEntry) => [
            String(entry.id),
            entry.at,
            entry.actor,
            entry.action,
            entry.outcome,
            entry.channel ?? "-",
            entry.messageId === null ? "-" : String(entry.messageId),
            describeDetail(entry.detail),
          ]),
        ]);
  if (page.next !== undefined) lines.push(`More: add --before ${page.next} for the next page.`);
  print(context, { entries: page.items, next: page.next ?? null }, lines);
  return EXIT.ok;
}

/**
 * A stored error cut to what is safe to print: its stage, and the name, code and location after
 * it. The error's own text, after the second `": "`, can quote the message, so it is dropped.
 *
 * @example
 * ```ts
 * safeError("transform: TypeError at transform.ts:4:9: cannot read MSH"); // "transform: TypeError at transform.ts:4:9"
 * ```
 */
export function safeError(stored: string | null): string | null {
  if (stored === null) return null;
  return stored.split(": ").slice(0, 2).join(": ");
}

const REFUSALS: Readonly<Record<ActionRefusal, string>> = {
  waiting: "it has not been transformed yet; the engine will transform it",
  pending: "some of its deliveries are still pending; try again once they are sent or failed",
  "no-output": "its last transform produced nothing to send; replay it without --resend",
  "no-channel": "its channel is no longer configured",
  "transform-load": "its channel's transform could not be loaded",
  changed: "it changed while the replay ran, so nothing was recorded; try again",
  unreadable: "what is stored of it could not be decrypted",
  "not-failed": "nothing about it has failed",
};

function describeReplay(result: ReplayResult): string {
  switch (result.outcome) {
    case "not-found":
      return "not found";
    case "refused":
      return `refused: ${result.failure ?? REFUSALS[result.reason]}`;
    case "replayed":
    case "resent": {
      const cleared =
        result.superseded === 0
          ? ""
          : `; ${count(result.superseded, "earlier failed delivery", "earlier failed deliveries")} cleared`;
      if (result.status === "failed") {
        return `${result.outcome}, and failed again: ${result.failure ?? "the transform failed"}${cleared}`;
      }
      if (result.status === "filtered") {
        return `${result.outcome}: filtered out, nothing queued${cleared}`;
      }
      return `${result.outcome}: ${count(result.queued, "delivery", "deliveries")} queued${cleared}`;
    }
  }
}

function describeClear(result: ClearOutcome): string {
  switch (result.outcome) {
    case "not-found":
      return "not found";
    case "refused":
      return `refused: ${REFUSALS[result.reason]}`;
    case "cleared":
      return `cleared (${result.messages === 0 ? "its" : "the message and"} ${count(result.deliveries, "failed delivery", "failed deliveries")})`;
  }
}

function actionCode<T extends { readonly outcome: string }>(
  results: readonly T[],
  failed: (result: T) => boolean,
): number {
  if (results.some((result) => result.outcome === "not-found")) return EXIT.notFound;
  return results.some(failed) ? EXIT.failed : EXIT.ok;
}

function noSuchChannel(context: OperatorContext, known: readonly string[]): number {
  context.err(`pathways: no such channel. The channels are: ${known.join(", ")}\n`);
  return EXIT.usage;
}

function print(context: OperatorContext, json: unknown, lines: readonly string[]): void {
  context.out(context.json ? `${JSON.stringify(json)}\n` : lines.map((l) => `${l}\n`).join(""));
}

function tally(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
}

function deliverySummary(deliveries: DeliveryTally): string {
  const parts = (["delivered", "pending", "failed", "cleared"] as const)
    .filter((status) => deliveries[status] > 0)
    .map((status) =>
      status === "pending" && deliveries.retrying > 0
        ? `${deliveries.pending} pending (${deliveries.retrying} retrying)`
        : `${deliveries[status]} ${status}`,
    );
  return parts.length === 0 ? "-" : parts.join(", ");
}

function deliveryTable(deliveries: readonly StoredDelivery[]): string[] {
  return table([
    ["ID", "GENERATION", "DESTINATION", "OUTPUT", "STATUS", "ATTEMPTS", "WHEN", "ERROR", "RESENT"],
    ...deliveries.map((d) => [
      String(d.id),
      String(d.generation),
      String(d.destination),
      String(d.seq + 1),
      d.status,
      String(d.attempts),
      when(d),
      safeError(d.error) ?? "-",
      // A possible duplicate: an attempt was cut off after the send, and the message sent again.
      d.interruptedAttempt === undefined
        ? "-"
        : `after attempt ${String(d.interruptedAttempt)} cut off`,
    ]),
  ]);
}

function when(delivery: StoredDelivery): string {
  if (delivery.deliveredAt !== null) return `delivered ${delivery.deliveredAt}`;
  if (delivery.status === "pending" && delivery.nextAttemptAt > 0) {
    return `next try ${new Date(delivery.nextAttemptAt).toISOString()}`;
  }
  return "-";
}

function describeDetail(detail: AuditDetail): string {
  const parts = Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`);
  return parts.length === 0 ? "-" : parts.join(" ");
}

/** Content for a terminal: segments that end in a carriage return go on lines of their own. */
function display(body: Uint8Array): string {
  const text = new TextDecoder().decode(body).replace(/\r\n?/g, "\n");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function indent(lines: readonly string[]): string[] {
  return lines.map((line) => `  ${line}`);
}

/** Lines of aligned columns, two spaces apart, without trailing spaces. */
function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [column, cell] of row.entries()) {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    }
  }
  return rows.map((row) =>
    row
      .map((cell, column) => {
        if (column === row.length - 1) return cell;
        /* v8 ignore next -- the loop above set a width for every column of every row */
        return cell.padEnd(widths[column] ?? 0);
      })
      .join("  "),
  );
}
