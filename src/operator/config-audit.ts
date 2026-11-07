import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectConfig } from "../config/schema.js";
import type { AuditDetail, AuditEntry, AuditInput, MessageStore } from "../storage/store.js";
import type { AuditLog } from "./audit.js";

/** The fingerprint of a file that is not there. */
const NONE = "none";
/** The fingerprint of a file that could not be read. */
const UNREADABLE = "unreadable";
/** The audit log's key for `pathways.yaml`, beside the channels' names. */
const PROJECT = "";

/**
 * The configuration's fingerprints: SHA-256 of `pathways.yaml`, and of each channel's
 * `channel.yaml` and transform, keyed by channel name (`""` for `pathways.yaml`). Hashes only:
 * nothing of the files' contents.
 *
 * @example
 * ```ts
 * const prints = await configFingerprints(project);
 * prints.get("adt-to-lab"); // { yaml: "3f2a...", transform: "9c1e..." }
 * ```
 */
export async function configFingerprints(
  project: ProjectConfig,
): Promise<Map<string, Record<string, string>>> {
  const prints = new Map<string, Record<string, string>>();
  prints.set(PROJECT, { yaml: await fingerprint(join(project.root, "pathways.yaml")) });
  for (const channel of project.channels) {
    prints.set(channel.name, {
      yaml: await fingerprint(join(channel.dir, "channel.yaml")),
      transform: channel.transform === undefined ? NONE : await fingerprint(channel.transform),
    });
  }
  return prints;
}

/**
 * Compares the configuration with what the audit log last recorded of it, and records each change:
 * one `config` entry per channel added, changed or removed, and one for `pathways.yaml` (with no
 * channel). Each entry holds the new fingerprints and the kind of change, never content. The first
 * start against a database records everything as added.
 *
 * @example
 * ```ts
 * const changes = await recordConfigChanges(project, store, audit);
 * ```
 */
export async function recordConfigChanges(
  project: ProjectConfig,
  store: MessageStore,
  audit: AuditLog,
): Promise<AuditEntry[]> {
  const current = await configFingerprints(project);
  const known = await lastRecorded(store);
  const changes: AuditInput[] = [];
  for (const [key, prints] of current) {
    const before = known.get(key);
    let change: string | undefined;
    if (before === undefined || before["change"] === "removed") change = "added";
    else if (Object.entries(prints).some(([name, hash]) => before[name] !== hash)) {
      change = "changed";
    }
    if (change !== undefined) changes.push(configEntry(key, { ...prints, change }));
  }
  for (const [key, before] of known) {
    if (!current.has(key) && before["change"] !== "removed") {
      changes.push(configEntry(key, { change: "removed" }));
    }
  }
  return changes.length === 0 ? [] : audit.record(...changes);
}

function configEntry(key: string, detail: AuditDetail): AuditInput {
  return { action: "config", channel: key === PROJECT ? undefined : key, detail };
}

/** The latest `config` entry for each channel, and for `pathways.yaml`. */
async function lastRecorded(store: MessageStore): Promise<Map<string, AuditDetail>> {
  const known = new Map<string, AuditDetail>();
  let before: number | undefined;
  do {
    const page = await store.auditEntries({ action: "config", before, limit: 500 });
    for (const entry of page.items) {
      const key = entry.channel ?? PROJECT;
      if (!known.has(key)) known.set(key, entry.detail);
    }
    before = page.next;
  } while (before !== undefined);
  return known;
}

async function fingerprint(file: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" ? NONE : UNREADABLE;
  }
}
