// An in-memory MessageStore, written as a user would write a storage adapter: against the types the
// package entry exports, in syntax Node's type stripping can erase (no parameter properties, no
// enums), so a project can load it as a module. The tests load it both ways.
import type {
  AuditEntry,
  AuditInput,
  AuditQuery,
  ClearResult,
  DeliveryCounts,
  DeliveryStatus,
  DeliveryTally,
  ExpireResult,
  MessageQuery,
  MessageState,
  MessageStatus,
  MessageStore,
  MessageSummary,
  NextDeliveryOptions,
  Page,
  PendingDelivery,
  PendingMessage,
  ReceivedMessage,
  RequeueRequest,
  RequeueResult,
  RetryingDelivery,
  SendingMarker,
  SendStart,
  StoredDelivery,
  StoredMessage,
  StoreFactory,
  StoreReceiveOptions,
} from "../src/index.js";

interface MessageRow {
  readonly id: number;
  readonly channel: string;
  readonly body: Uint8Array;
  status: MessageStatus;
  error: string | null;
  readonly duplicateKey: string | undefined;
  readonly duplicateOf: number | undefined;
  readonly receivedAt: string;
  updatedAt: string;
  readonly size: number;
  generation: number;
}

interface DeliveryRow {
  readonly id: number;
  readonly messageId: number;
  readonly channel: string;
  readonly destination: number;
  readonly seq: number;
  readonly body: Uint8Array;
  readonly generation: number;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
  deliveredAt: string | null;
  sending: SendingMarker | undefined;
  interruptedAttempt: number | undefined;
  failedAt?: string | undefined;
}

const now = (): string => new Date().toISOString();

/** Keeps every message, delivery and audit entry in arrays: lost on restart, so for tests only. */
export class MemoryStore implements MessageStore {
  readonly messageRows: MessageRow[] = [];
  readonly deliveryRows: DeliveryRow[] = [];
  readonly auditRows: AuditEntry[] = [];
  closed = false;

  receive(
    channel: string,
    body: Uint8Array,
    options: StoreReceiveOptions = {},
  ): Promise<ReceivedMessage> {
    const { duplicateKey, failure, size } = options;
    const earlier =
      duplicateKey === undefined
        ? undefined
        : this.messageRows.findLast(
            (m) => m.channel === channel && m.duplicateKey === duplicateKey,
          );
    const id = this.messageRows.length + 1;
    const at = now();
    this.messageRows.push({
      id,
      channel,
      body,
      status: failure === undefined ? "received" : "failed",
      error: failure ?? null,
      duplicateKey,
      duplicateOf: earlier?.id,
      receivedAt: at,
      updatedAt: at,
      size: size ?? body.byteLength,
      generation: 0,
    });
    return Promise.resolve({ id, duplicateOf: earlier?.id });
  }

  nextToTransform(channel: string): Promise<PendingMessage | undefined> {
    const row = this.messageRows.find((m) => m.channel === channel && m.status === "received");
    return Promise.resolve(row === undefined ? undefined : { id: row.id, body: row.body });
  }

  completeTransform(
    messageId: number,
    outputs: readonly Uint8Array[],
    destinations: number,
  ): Promise<void> {
    const message = this.row(messageId);
    this.queue(message, outputs, destinations);
    message.status = outputs.length === 0 ? "filtered" : "transformed";
    message.updatedAt = now();
    return Promise.resolve();
  }

  failTransform(messageId: number, error: string): Promise<void> {
    const message = this.row(messageId);
    message.status = "failed";
    message.error = error;
    message.updatedAt = now();
    return Promise.resolve();
  }

  nextDelivery(
    channel: string,
    destination: number,
    options: NextDeliveryOptions = {},
  ): Promise<PendingDelivery | undefined> {
    const { dueBy = Number.POSITIVE_INFINITY } = options;
    const row = this.deliveryRows.find(
      (d) =>
        d.channel === channel &&
        d.destination === destination &&
        d.status === "pending" &&
        d.nextAttemptAt <= dueBy,
    );
    if (row === undefined) return Promise.resolve(undefined);
    const { id, messageId, seq, body, attempts, nextAttemptAt, sending, interruptedAttempt } = row;
    return Promise.resolve({
      id,
      messageId,
      seq,
      body,
      attempts,
      nextAttemptAt,
      sending,
      interruptedAttempt,
    });
  }

  markSending(deliveryId: number, start: SendStart): Promise<void> {
    const row = this.delivery(deliveryId);
    row.sending = { attempt: start.attempt, at: start.at };
    if (start.interruptedAttempt !== undefined) row.interruptedAttempt = start.interruptedAttempt;
    return Promise.resolve();
  }

  markDryRun(deliveryId: number): Promise<void> {
    Object.assign(this.delivery(deliveryId), { status: "dry-run", sending: undefined });
    return Promise.resolve();
  }

  markDelivered(deliveryId: number): Promise<void> {
    Object.assign(this.delivery(deliveryId), {
      status: "delivered",
      deliveredAt: now(),
      sending: undefined,
    });
    return Promise.resolve();
  }

  scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
  ): Promise<void> {
    Object.assign(this.delivery(deliveryId), {
      attempts,
      nextAttemptAt,
      error,
      sending: undefined,
    });
    return Promise.resolve();
  }

  failDelivery(deliveryId: number, error: string): Promise<void> {
    Object.assign(this.delivery(deliveryId), {
      status: "failed",
      error,
      sending: undefined,
      failedAt: now(),
    });
    return Promise.resolve();
  }

  messageCounts(channel: string): Promise<Record<MessageStatus, number>> {
    const counts: Record<MessageStatus, number> = {
      received: 0,
      transformed: 0,
      filtered: 0,
      failed: 0,
      cleared: 0,
    };
    for (const m of this.messageRows) if (m.channel === channel) counts[m.status] += 1;
    return Promise.resolve(counts);
  }

  deliveryCounts(channel: string): Promise<DeliveryCounts> {
    const counts: { -readonly [K in keyof DeliveryCounts]: DeliveryCounts[K] } = {
      pending: 0,
      delivered: 0,
      failed: 0,
      cleared: 0,
    };
    for (const d of this.deliveryRows) {
      if (d.channel === channel) counts[d.status] = (counts[d.status] ?? 0) + 1;
    }
    return Promise.resolve(counts);
  }

  retryingDeliveries(channel: string): Promise<number> {
    return Promise.resolve(
      this.deliveryRows.filter(
        (d) => d.channel === channel && d.status === "pending" && d.attempts > 0,
      ).length,
    );
  }

  channels(): Promise<string[]> {
    return Promise.resolve([...new Set(this.messageRows.map((m) => m.channel))].sort());
  }

  message(id: number): Promise<StoredMessage | undefined> {
    const row = this.messageRows.find((m) => m.id === id);
    return Promise.resolve(
      row === undefined ? undefined : { ...this.summary(row), error: row.error },
    );
  }

  messageBody(id: number): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.messageRows.find((m) => m.id === id)?.body);
  }

  deliveries(messageId: number): Promise<StoredDelivery[]> {
    return Promise.resolve(
      this.deliveryRows
        .filter((d) => d.messageId === messageId)
        .map((d) => ({
          id: d.id,
          destination: d.destination,
          seq: d.seq,
          generation: d.generation,
          status: d.status,
          attempts: d.attempts,
          nextAttemptAt: d.nextAttemptAt,
          deliveredAt: d.deliveredAt,
          error: d.error,
          interruptedAttempt: d.interruptedAttempt,
          ...(d.failedAt === undefined ? {} : { failedAt: d.failedAt }),
        })),
    );
  }

  outputs(messageId: number): Promise<Uint8Array[]> {
    const message = this.messageRows.find((m) => m.id === messageId);
    const current = this.deliveryRows.filter(
      (d) => d.messageId === messageId && d.generation === message?.generation,
    );
    const first = Math.min(...current.map((d) => d.destination));
    return Promise.resolve(
      current
        .filter((d) => d.destination === first)
        .sort((a, b) => a.seq - b.seq)
        .map((d) => d.body),
    );
  }

  listMessages(query: MessageQuery): Promise<Page<MessageSummary>> {
    const { channel, state, since, until, before, limit } = query;
    const matching = this.messageRows
      .filter(
        (m) =>
          (channel === undefined || m.channel === channel) &&
          (since === undefined || m.receivedAt >= since) &&
          (until === undefined || m.receivedAt < until) &&
          (before === undefined || m.id < before),
      )
      .map((m) => this.summary(m))
      .filter((m) => state === undefined || m.state === state)
      .sort((a, b) => b.id - a.id);
    const items = matching.slice(0, limit);
    return Promise.resolve({
      items,
      next: matching.length > limit ? items.at(-1)?.id : undefined,
    });
  }

  listRetrying(channel: string, limit: number): Promise<RetryingDelivery[]> {
    return Promise.resolve(
      this.deliveryRows
        .filter((d) => d.channel === channel && d.status === "pending" && d.attempts > 0)
        .slice(0, limit)
        .map((d) => ({
          id: d.id,
          messageId: d.messageId,
          destination: d.destination,
          attempts: d.attempts,
          nextAttemptAt: d.nextAttemptAt,
        })),
    );
  }

  requeue(messageId: number, request: RequeueRequest, actor: string): Promise<RequeueResult> {
    const { mode, expected, outputs, failure, destinations, expectedGeneration } = request;
    const message = this.messageRows.find((m) => m.id === messageId);
    const refuse = (reason: "not-found" | "changed" | "pending"): Promise<RequeueResult> => {
      const entry = this.audit(actor, {
        action: mode,
        outcome: reason === "not-found" ? "not-found" : "refused",
        channel: message?.channel,
        messageId,
        detail: reason === "not-found" ? {} : { reason },
      });
      return Promise.resolve({ done: false, reason, entry });
    };
    if (message === undefined) return refuse("not-found");
    if (message.status !== expected) return refuse("changed");
    if (expectedGeneration !== undefined && message.generation !== expectedGeneration) {
      return refuse("changed");
    }
    const mine = this.deliveryRows.filter((d) => d.messageId === messageId);
    if (mine.some((d) => d.status === "pending")) return refuse("pending");
    const superseded = mine.filter((d) => d.status === "failed");
    for (const d of superseded) d.status = "cleared";
    message.status =
      failure !== undefined ? "failed" : outputs.length === 0 ? "filtered" : "transformed";
    message.error = failure ?? null;
    message.updatedAt = now();
    message.generation += 1;
    const queued = failure === undefined ? this.queue(message, outputs, destinations) : 0;
    const done = {
      status: message.status,
      queued,
      superseded: superseded.length,
      generation: message.generation,
    };
    const entry = this.audit(actor, {
      action: mode,
      channel: message.channel,
      messageId,
      detail: done,
    });
    return Promise.resolve({ done: true, ...done, entry });
  }

  clear(messageId: number, actor: string): Promise<ClearResult> {
    const message = this.messageRows.find((m) => m.id === messageId);
    if (message === undefined) {
      const entry = this.audit(actor, { action: "clear", outcome: "not-found", messageId });
      return Promise.resolve({ done: false, reason: "not-found", entry });
    }
    const failed = this.deliveryRows.filter(
      (d) => d.messageId === messageId && d.status === "failed",
    );
    const messages = message.status === "failed" ? 1 : 0;
    if (messages + failed.length === 0) {
      const entry = this.audit(actor, {
        action: "clear",
        outcome: "refused",
        channel: message.channel,
        messageId,
        detail: { reason: "not-failed" },
      });
      return Promise.resolve({ done: false, reason: "not-failed", entry });
    }
    if (messages === 1) message.status = "cleared";
    for (const d of failed) d.status = "cleared";
    message.updatedAt = now();
    const done = { messages, deliveries: failed.length };
    const entry = this.audit(actor, {
      action: "clear",
      channel: message.channel,
      messageId,
      detail: done,
    });
    return Promise.resolve({ done: true, ...done, entry });
  }

  expire(channel: string, cutoff: string, dryRun: boolean): Promise<ExpireResult> {
    const gone = this.messageRows.filter((m) => {
      if (m.channel !== channel || m.updatedAt >= cutoff) return false;
      if (m.status === "filtered" || m.status === "cleared") return true;
      if (m.status !== "transformed") return false;
      return this.deliveryRows.every(
        (d) =>
          d.messageId !== m.id ||
          (d.status !== "pending" &&
            d.status !== "failed" &&
            (d.deliveredAt === null || d.deliveredAt < cutoff)),
      );
    });
    const ids = new Set(gone.map((m) => m.id));
    const deliveries = this.deliveryRows.filter((d) => ids.has(d.messageId)).length;
    if (!dryRun) {
      remove(this.messageRows, (m) => ids.has(m.id));
      remove(this.deliveryRows, (d) => ids.has(d.messageId));
    }
    return Promise.resolve({ messages: ids.size, deliveries });
  }

  appendAudit(actor: string, entries: readonly AuditInput[]): Promise<AuditEntry[]> {
    return Promise.resolve(entries.map((input) => this.audit(actor, input)));
  }

  auditEntries(query: AuditQuery): Promise<Page<AuditEntry>> {
    const { action, channel, messageId, since, until, before, limit } = query;
    const matching = this.auditRows
      .filter(
        (e) =>
          (action === undefined || e.action === action) &&
          (channel === undefined || e.channel === channel) &&
          (messageId === undefined || e.messageId === messageId) &&
          (since === undefined || e.at >= since) &&
          (until === undefined || e.at < until) &&
          (before === undefined || e.id < before),
      )
      .reverse();
    const items = matching.slice(0, limit);
    return Promise.resolve({
      items,
      next: matching.length > limit ? items.at(-1)?.id : undefined,
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private row(id: number): MessageRow {
    const row = this.messageRows.find((m) => m.id === id);
    if (row === undefined) throw new RangeError("no such message");
    return row;
  }

  private delivery(id: number): DeliveryRow {
    const row = this.deliveryRows.find((d) => d.id === id);
    if (row === undefined) throw new RangeError("no such delivery");
    return row;
  }

  private queue(message: MessageRow, outputs: readonly Uint8Array[], destinations: number): number {
    let queued = 0;
    for (let destination = 0; destination < destinations; destination += 1) {
      for (const [seq, body] of outputs.entries()) {
        this.deliveryRows.push({
          id: this.deliveryRows.reduce((max, d) => Math.max(max, d.id), 0) + 1,
          messageId: message.id,
          channel: message.channel,
          destination,
          seq,
          body,
          generation: message.generation,
          status: "pending",
          attempts: 0,
          nextAttemptAt: 0,
          error: null,
          deliveredAt: null,
          sending: undefined,
          interruptedAttempt: undefined,
        });
        queued += 1;
      }
    }
    return queued;
  }

  private audit(actor: string, input: AuditInput): AuditEntry {
    const entry: AuditEntry = {
      id: this.auditRows.length + 1,
      at: now(),
      actor,
      action: input.action,
      outcome: input.outcome ?? "ok",
      channel: input.channel ?? null,
      messageId: input.messageId ?? null,
      detail: input.detail ?? {},
    };
    this.auditRows.push(entry);
    return entry;
  }

  private summary(row: MessageRow): MessageSummary {
    const tally: { -readonly [K in keyof DeliveryTally]: DeliveryTally[K] } = {
      pending: 0,
      retrying: 0,
      delivered: 0,
      failed: 0,
      cleared: 0,
    };
    for (const d of this.deliveryRows) {
      if (d.messageId !== row.id || d.generation !== row.generation) continue;
      tally[d.status] = (tally[d.status] ?? 0) + 1;
      if (d.status === "pending" && d.attempts > 0) tally.retrying += 1;
    }
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      state: stateOf(row.status, tally),
      receivedAt: row.receivedAt,
      updatedAt: row.updatedAt,
      size: row.size,
      duplicateOf: row.duplicateOf ?? null,
      generation: row.generation,
      deliveries: tally,
    };
  }
}

/** A message's state, as the package's own store works it out. */
function stateOf(status: MessageStatus, deliveries: DeliveryTally): MessageState {
  if (status !== "transformed") return status;
  if (deliveries.failed > 0) return "failed";
  if (deliveries.retrying > 0) return "retrying";
  if (deliveries.pending > 0) return "queued";
  if (deliveries.cleared > 0) return "cleared";
  if ((deliveries["dry-run"] ?? 0) > 0) return "dry-run";
  return "delivered";
}

function remove<T>(rows: T[], gone: (row: T) => boolean): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && gone(row)) rows.splice(index, 1);
  }
}

/** Every store this module's factory made, in order, so a test can look inside the one in use. */
export const opened: MemoryStore[] = [];

/** A storage adapter module's default export: `storage: { module: ./memory-store.ts }`. */
const memoryStore = ((options) => {
  if (options["refuse"] === true) throw new RangeError("the store refused to open");
  const store = new MemoryStore();
  opened.push(store);
  return store;
}) satisfies StoreFactory;

export default memoryStore;
