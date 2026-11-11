import type { ChannelConfig } from "../config/schema.js";
import type { JsonValue, SourceFacts } from "../transform.js";

/** How deep what a custom source passes as `source` may nest. */
const FACTS_DEPTH = 32;

/**
 * Whether `value` is a map of plain JSON values: strings, finite numbers, booleans, null, lists and
 * maps, nested no deeper than 32 levels. Only such a map is passed to a transform, which receives it
 * as a copy in another thread.
 *
 * @example
 * ```ts
 * isJsonMap({ queue: "inbound", tries: [1, 2] }); // true
 * isJsonMap({ at: new Date() }); // false
 * ```
 */
export function isJsonMap(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isPlainMap(value) && Object.values(value).every((item) => isJson(item, 1));
}

function isPlainMap(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJson(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= FACTS_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  return isPlainMap(value) && Object.values(value).every((item) => isJson(item, depth + 1));
}

/**
 * Refused by `sink.receive` before anything is stored: a custom source passed `source` facts that
 * are not a map of plain JSON values.
 *
 * @example
 * ```ts
 * if (!isJsonMap(source)) throw new SourceFactsError();
 * ```
 */
export class SourceFactsError extends TypeError {
  readonly code = "INVALID_SOURCE_FACTS";

  constructor() {
    super("the source passed facts that are not a map of plain JSON values");
    this.name = "SourceFactsError";
  }
}

/**
 * A copy of what a source passed as `source`, taken when the message is received, so the value the
 * check passed and the value the transform later reads are the same snapshot: a source may reuse or
 * change its object once `sink.receive` is called. Throws {@link SourceFactsError} when the value,
 * or the copy, is not a map of plain JSON values.
 *
 * @example
 * ```ts
 * const facts = { tag: 1 };
 * const kept = copyFacts(facts);
 * facts.tag = 2; // kept.tag is still 1
 * ```
 */
export function copyFacts(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!isJsonMap(value)) throw new SourceFactsError();
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    // A getter that returns something else the second time it is read.
    throw new SourceFactsError();
  }
  // Checked again: a getter can hand the copy what it did not hand the check.
  if (!isJsonMap(copy)) throw new SourceFactsError();
  return copy;
}

/**
 * The most messages a channel holds source facts for while they wait for their transform. Past it
 * the oldest are dropped, and those messages are transformed with `ctx.source` undefined, as after a
 * restart.
 */
export const MAX_WAITING_FACTS = 4_096;

/**
 * Sets the facts of message `id` in `map`, first dropping the oldest entries until it holds fewer
 * than `max`, so the map never holds more than `max`.
 *
 * @example
 * ```ts
 * keepFacts(channel.facts, 12, facts); // drops the oldest when the channel already holds the most
 * ```
 */
export function keepFacts(
  map: Map<number, SourceFacts>,
  id: number,
  facts: SourceFacts,
  max = MAX_WAITING_FACTS,
): void {
  for (const oldest of map.keys()) {
    if (map.size < max) break;
    map.delete(oldest);
  }
  map.set(id, facts);
}

/**
 * What a transform receives as `ctx.source` for a message a channel's source took in: what the
 * source passed to `sink.receive`, with the kind of source and when the message was stored. A file
 * source's facts also carry the body's size. What a custom source passed sits under `facts`.
 *
 * @example
 * ```ts
 * sourceFacts("file", { name: "a01.hl7" }, 512, "2026-11-11T09:00:00.000Z");
 * // { kind: "file", name: "a01.hl7", size: 512, receivedAt: "2026-11-11T09:00:00.000Z" }
 * ```
 */
export function sourceFacts(
  kind: ChannelConfig["source"]["kind"],
  passed: Readonly<Record<string, JsonValue>> | undefined,
  size: number,
  receivedAt: string,
): SourceFacts {
  if (kind === "module") return { kind, facts: passed ?? {}, receivedAt };
  // A built-in source passes the fields of its own kind: the file's name, the request's method,
  // path, address and headers, or the connection's address and TLS peer.
  const facts: Readonly<Record<string, JsonValue>> = {
    ...passed,
    kind,
    ...(kind === "file" ? { size } : {}),
    receivedAt,
  };
  return facts as unknown as SourceFacts;
}
