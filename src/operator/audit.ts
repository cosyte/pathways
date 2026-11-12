import { userInfo } from "node:os";

import type { AuditEvent } from "../extensions/events.js";
import type { AuditEntry, AuditInput, MessageStore } from "../storage/store.js";

/**
 * Told of each audit entry once it is stored. A lifecycle hook subscribes one to forward the audit
 * log, to a file or a SIEM. It may be async; the action that wrote the entry waits for it to
 * settle, and a listener that throws or rejects never undoes the action or the entry.
 *
 * @example
 * ```ts
 * const forward: AuditListener = async (entry) => {
 *   await siem.send({ at: entry.at, actor: entry.actor, action: entry.action });
 * };
 * ```
 */
export type AuditListener = (entry: AuditEntry) => void | Promise<void>;

/**
 * The operating system user running this process, for the audit log: the account name, or its
 * numeric id when the system has no name for it.
 *
 * @example
 * ```ts
 * operatingSystemUser(); // "ops"
 * ```
 */
export function operatingSystemUser(): string {
  try {
    const { username } = userInfo();
    if (username !== "") return username;
  } catch {
    // A container's user can have no entry in /etc/passwd; fall back to its id.
  }
  const uid = process.getuid?.();
  return uid === undefined ? "unknown" : `uid ${uid}`;
}

/**
 * Options for an {@link AuditLog}.
 *
 * @example
 * ```ts
 * const audit = new AuditLog(store, { actor: "ops", onListenerError: (error) => log(error) });
 * ```
 */
export interface AuditLogOptions {
  /** Who acts; defaults to {@link operatingSystemUser}. */
  readonly actor?: string;
  /** Told when a listener throws or rejects. The engine logs the error's code. */
  readonly onListenerError?: (error: unknown) => void;
}

/**
 * The audit log as the engine and the operator commands use it: appends entries through the store,
 * stamped with the actor, then tells every subscribed listener. It has no way to change or remove
 * an entry, and neither has the store.
 *
 * Entries come from two places: {@link AuditLog.record}, and the store's own `requeue` and `clear`,
 * which write their entry in the same transaction as the change and hand it back for
 * {@link AuditLog.emit}.
 *
 * @example
 * ```ts
 * const audit = new AuditLog(store);
 * const stop = audit.subscribe((entry) => console.log(entry.action, entry.messageId));
 * await audit.record({ action: "content-view", channel: "adt-to-lab", messageId: 12 });
 * stop();
 * ```
 */
export class AuditLog {
  /** Who every entry this log writes names as the actor. */
  readonly actor: string;
  private readonly store: MessageStore;
  private readonly onListenerError: ((error: unknown) => void) | undefined;
  private readonly listeners = new Set<AuditListener>();

  /**
   * @param store Where entries are kept.
   * @param options The actor, and what to do when a listener fails.
   */
  constructor(store: MessageStore, options: AuditLogOptions = {}) {
    this.store = store;
    this.actor = options.actor ?? operatingSystemUser();
    this.onListenerError = options.onListenerError;
  }

  /**
   * Calls `listener` with every entry from now on, in the order they were written. Returns a
   * function that unsubscribes it.
   */
  subscribe(listener: AuditListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Appends entries, durably and together, then tells the listeners. Rejects, and tells no one,
   * when the store cannot write them: a caller about to show content stops there.
   */
  async record(...inputs: readonly AuditInput[]): Promise<AuditEntry[]> {
    const entries = await this.store.appendAudit(this.actor, inputs);
    await this.emit(entries);
    return entries;
  }

  /**
   * As {@link AuditLog.record}, naming `actor` instead of this log's own: for a command another
   * process asked for, such as `pathways channel pause`, which names the user who ran it.
   */
  async recordAs(actor: string, ...inputs: readonly AuditInput[]): Promise<AuditEntry[]> {
    const entries = await this.store.appendAudit(actor, inputs);
    await this.emit(entries);
    return entries;
  }

  /** Tells the listeners of entries already stored, one entry at a time, in order. */
  async emit(entries: readonly AuditEntry[]): Promise<void> {
    for (const entry of entries) {
      const settled = await Promise.allSettled(
        [...this.listeners].map(async (listener) => {
          await listener(entry);
        }),
      );
      for (const result of settled) {
        if (result.status === "rejected") this.onListenerError?.(result.reason);
      }
    }
  }
}

/**
 * An audit entry as the lifecycle event the hooks receive. It carries what the entry holds, which is
 * never content.
 *
 * @example
 * ```ts
 * audit.subscribe((entry) => hooks.emit(auditEvent(entry)));
 * ```
 */
export function auditEvent(entry: AuditEntry): AuditEvent {
  return {
    type: "audit",
    at: entry.at,
    channel: entry.channel ?? undefined,
    entryId: entry.id,
    actor: entry.actor,
    action: entry.action,
    outcome: entry.outcome,
    messageId: entry.messageId ?? undefined,
    detail: entry.detail,
  };
}
