// An in-memory MessageStore, written as a user would write a storage adapter: against the types the
// package entry exports, in syntax Node's type stripping can erase (no parameter properties, no
// enums), so a project can load it as a module. The tests load it both ways.
import type {
  DeliveryStatus,
  MessageStatus,
  MessageStore,
  PendingDelivery,
  PendingMessage,
  ReceivedMessage,
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
}

interface DeliveryRow {
  readonly id: number;
  readonly messageId: number;
  readonly channel: string;
  readonly destination: number;
  readonly seq: number;
  readonly body: Uint8Array;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
}

/** Keeps every message and delivery in arrays: lost on restart, so for tests only. */
export class MemoryStore implements MessageStore {
  readonly messages: MessageRow[] = [];
  readonly deliveries: DeliveryRow[] = [];
  closed = false;

  receive(
    channel: string,
    body: Uint8Array,
    options: StoreReceiveOptions = {},
  ): Promise<ReceivedMessage> {
    const { duplicateKey, failure } = options;
    const earlier =
      duplicateKey === undefined
        ? undefined
        : this.messages.findLast((m) => m.channel === channel && m.duplicateKey === duplicateKey);
    const id = this.messages.length + 1;
    this.messages.push({
      id,
      channel,
      body,
      status: failure === undefined ? "received" : "failed",
      error: failure ?? null,
      duplicateKey,
    });
    return Promise.resolve({ id, duplicateOf: earlier?.id });
  }

  nextToTransform(channel: string): Promise<PendingMessage | undefined> {
    const row = this.messages.find((m) => m.channel === channel && m.status === "received");
    return Promise.resolve(row === undefined ? undefined : { id: row.id, body: row.body });
  }

  completeTransform(
    messageId: number,
    outputs: readonly Uint8Array[],
    destinations: number,
  ): Promise<void> {
    const message = this.message(messageId);
    for (let destination = 0; destination < destinations; destination += 1) {
      for (const [seq, body] of outputs.entries()) {
        this.deliveries.push({
          id: this.deliveries.length + 1,
          messageId,
          channel: message.channel,
          destination,
          seq,
          body,
          status: "pending",
          attempts: 0,
          nextAttemptAt: 0,
          error: null,
        });
      }
    }
    message.status = outputs.length === 0 ? "filtered" : "transformed";
    return Promise.resolve();
  }

  failTransform(messageId: number, error: string): Promise<void> {
    const message = this.message(messageId);
    message.status = "failed";
    message.error = error;
    return Promise.resolve();
  }

  nextDelivery(channel: string, destination: number): Promise<PendingDelivery | undefined> {
    const row = this.deliveries.find(
      (d) => d.channel === channel && d.destination === destination && d.status === "pending",
    );
    if (row === undefined) return Promise.resolve(undefined);
    const { id, messageId, seq, body, attempts, nextAttemptAt } = row;
    return Promise.resolve({ id, messageId, seq, body, attempts, nextAttemptAt });
  }

  markDelivered(deliveryId: number): Promise<void> {
    this.delivery(deliveryId).status = "delivered";
    return Promise.resolve();
  }

  scheduleRetry(
    deliveryId: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
  ): Promise<void> {
    Object.assign(this.delivery(deliveryId), { attempts, nextAttemptAt, error });
    return Promise.resolve();
  }

  failDelivery(deliveryId: number, error: string): Promise<void> {
    Object.assign(this.delivery(deliveryId), { status: "failed", error });
    return Promise.resolve();
  }

  messageCounts(channel: string): Promise<Record<MessageStatus, number>> {
    const counts: Record<MessageStatus, number> = {
      received: 0,
      transformed: 0,
      filtered: 0,
      failed: 0,
    };
    for (const m of this.messages) if (m.channel === channel) counts[m.status] += 1;
    return Promise.resolve(counts);
  }

  deliveryCounts(channel: string): Promise<Record<DeliveryStatus, number>> {
    const counts: Record<DeliveryStatus, number> = { pending: 0, delivered: 0, failed: 0 };
    for (const d of this.deliveries) if (d.channel === channel) counts[d.status] += 1;
    return Promise.resolve(counts);
  }

  retryingDeliveries(channel: string): Promise<number> {
    return Promise.resolve(
      this.deliveries.filter(
        (d) => d.channel === channel && d.status === "pending" && d.attempts > 0,
      ).length,
    );
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private message(id: number): MessageRow {
    const row = this.messages.find((m) => m.id === id);
    if (row === undefined) throw new RangeError("no such message");
    return row;
  }

  private delivery(id: number): DeliveryRow {
    const row = this.deliveries.find((d) => d.id === id);
    if (row === undefined) throw new RangeError("no such delivery");
    return row;
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
