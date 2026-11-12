import type { Logger } from "pino";

import type { AuditDetail, MessageStore } from "../storage/store.js";
import type { AuditLog } from "./audit.js";

/**
 * What the `engine-start` and `engine-stop` entries carry: the version of Pathways that ran, how
 * many channels it ran, and its node id. Numbers and names only.
 *
 * @example
 * ```ts
 * const particulars: EngineParticulars = { version: "0.0.2", channels: 3, node: "3f9a1c2b7d4e5f60" };
 * ```
 */
export interface EngineParticulars {
  readonly version: string;
  readonly channels: number;
  readonly node: string;
}

/**
 * Records that the engine started: first, when the run before it left an `engine-start` and no
 * `engine-stop` after it, an `unclean-shutdown` entry naming that start's entry (`since`) and its
 * version and node; then the `engine-start` entry itself. Rejects when the audit log cannot be read
 * or written.
 *
 * @example
 * ```ts
 * await recordEngineStart(audit, store, { version: VERSION, channels: 2, node });
 * ```
 */
export async function recordEngineStart(
  audit: AuditLog,
  store: MessageStore,
  particulars: EngineParticulars,
): Promise<void> {
  const [started] = (await store.auditEntries({ action: "engine-start", limit: 1 })).items;
  if (started !== undefined) {
    const [stopped] = (await store.auditEntries({ action: "engine-stop", limit: 1 })).items;
    if (stopped === undefined || stopped.id < started.id) {
      const named = Object.entries(started.detail).filter(
        ([key]) => key === "version" || key === "node",
      );
      await audit.record({
        action: "unclean-shutdown",
        detail: { since: started.id, ...Object.fromEntries(named) },
      });
    }
  }
  await audit.record({ action: "engine-start", detail: particularsDetail(particulars) });
}

/**
 * Records that the engine is stopping cleanly, as it begins to: its hooks are still running, so
 * they receive the entry too. A failure to write it is logged by its code and stops nothing: the
 * next start then records an unclean shutdown.
 *
 * @example
 * ```ts
 * await recordEngineStop(audit, { version: VERSION, channels: 2, node }, logger);
 * ```
 */
export async function recordEngineStop(
  audit: AuditLog,
  particulars: EngineParticulars,
  logger: Logger,
): Promise<void> {
  try {
    await audit.record({ action: "engine-stop", detail: particularsDetail(particulars) });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    logger.warn({
      event: "audit-failed",
      action: "engine-stop",
      code: typeof code === "string" ? code : undefined,
    });
  }
}

function particularsDetail(particulars: EngineParticulars): AuditDetail {
  return { version: particulars.version, channels: particulars.channels, node: particulars.node };
}
