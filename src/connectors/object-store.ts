import { randomBytes } from "node:crypto";

import type { PathPattern } from "../config/schema.js";
import { faultPoint } from "../fault-points.js";
import { copiesBodies, markCopiesBodies, release } from "../storage/ownership.js";
import { decodePath, encodePath, type FileFault, matcher } from "./file.js";
import { isLocationDown } from "./file-system.js";
import {
  DeliveryRejected,
  type DestinationConnector,
  type MessageSink,
  type OutgoingMessage,
  type SourceConnector,
} from "./types.js";

/**
 * One object in a bucket or container: its key, its size in bytes, its entity tag as the store gave
 * it, and its last modification time in epoch milliseconds.
 */
export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly modifiedMs: number;
}

/** One page of a listing: the objects on it and the token for the next page, when there is one. */
export interface ObjectPage {
  readonly objects: readonly ObjectInfo[];
  readonly next: string | undefined;
}

/**
 * An object store a file source or destination reads and writes: an Amazon S3 bucket or an Azure
 * Blob Storage container. An object store has no rename, so a source claims an object by writing a
 * marker only when no object has the marker's key (`If-None-Match: *`), which one writer wins.
 *
 * Every error that says the store cannot be reached, or refused the credentials, carries `down:
 * true` and a code; none carries the store's own text, a key or a body.
 */
export interface ObjectStore {
  /** `s3` or `azblob`, the start of every idempotency key a source builds. */
  readonly scheme: string;
  /** The bucket or container, the second part of every idempotency key. */
  readonly container: string;
  /**
   * One page of the objects whose key starts with `prefix`. With `delimiter`, only those with no
   * `delimiter` after `prefix`: a listing of one folder.
   */
  list(
    prefix: string,
    delimiter: string | undefined,
    token: string | undefined,
  ): Promise<ObjectPage>;
  /** The object's size, entity tag and modification time, or `undefined` when there is none. */
  head(key: string): Promise<ObjectInfo | undefined>;
  /**
   * The whole object, only while its entity tag is `etag`. Fails with the code
   * {@link OBJECT_CHANGED} when it is not, and `ENOENT` when the object is gone.
   */
  get(key: string, etag: string): Promise<Uint8Array>;
  /**
   * Writes `body` at `key` only when no object is there (`If-None-Match: *`): true when written,
   * false when an object was there or another writer won the race to it.
   */
  create(key: string, body: Uint8Array): Promise<boolean>;
  /** Writes `body` at `key`, replacing an object there. */
  put(key: string, body: Uint8Array): Promise<void>;
  /**
   * Deletes the object at `key`, only while its entity tag is `etag` when one is given. Nothing
   * happens when it is gone, or when its tag is another (a writer replaced it since).
   */
  remove(key: string, etag?: string): Promise<void>;
  /** Ends the client, where it holds connections. */
  close?(): Promise<void>;
}

/** The code of the error {@link ObjectStore.get} gives for an object replaced since it was read. */
export const OBJECT_CHANGED = "ERR_PATHWAYS_OBJECT_CHANGED";

/**
 * The code of the error a source gives at start on a store that does not honour `If-None-Match: *`,
 * unless its channel says only one engine reads the prefix (`singleNode: true`).
 */
export const NO_CONDITIONAL_WRITE = "ERR_PATHWAYS_OBJECT_NO_CONDITIONAL_WRITE";

/** The folder under a source's prefix where its claim markers wait while an object is stored. */
export const OBJECT_CLAIMED_DIR = ".claimed";

/**
 * An error with `code`, and `down: true` when it says the store cannot be reached. Its text is ours,
 * never the store's.
 *
 * @example
 * ```ts
 * throw objectFailure("ERR_PATHWAYS_S3_HTTP_503", "the S3 request failed", true);
 * ```
 */
export function objectFailure(code: string, message: string, down = false): Error {
  return Object.assign(new Error(message), down ? { code, down: true } : { code });
}

/** What a claim marker holds: the channel that wrote it and the version of the object it claims. */
interface Marker {
  readonly channel: string;
  readonly etag: string;
  readonly modifiedMs: number;
}

/** A marker's body as JSON. */
function markerBody(marker: Marker): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(marker));
}

/** The marker in `body`, or `undefined` when it is not one this source wrote. */
function parseMarker(body: Uint8Array): Marker | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as Partial<Marker> | null;
    if (
      typeof value?.channel === "string" &&
      typeof value.etag === "string" &&
      typeof value.modifiedMs === "number"
    ) {
      return { channel: value.channel, etag: value.etag, modifiedMs: value.modifiedMs };
    }
  } catch {
    // Not ours: left as it is.
  }
  return undefined;
}

/** Compares two strings as code units, not by locale. */
function compare(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/** An object found in a pass, with its path from the prefix. */
interface Found extends ObjectInfo {
  readonly rel: string;
}

/** Options for an {@link ObjectSource}. */
export interface ObjectSourceOptions {
  readonly store: ObjectStore;
  /** The folder in the bucket or container: its key prefix, without a slash at either end. */
  readonly prefix: string;
  /** The channel the source reads for, kept in each claim marker. */
  readonly channel: string;
  readonly minAgeMs: number;
  /** Epoch milliseconds now. */
  readonly now?: () => number;
  /** Told when a ready object cannot be claimed or read; it stays where it is for the next pass. */
  readonly onReadError?: (error: unknown) => void;
  /** As the file source's: only objects whose path from the prefix matches one are taken. */
  readonly include?: readonly PathPattern[];
  /** As the file source's: objects whose path matches one are left. */
  readonly exclude?: readonly PathPattern[];
  /** Reads every key under the prefix, not only those with no `/` after it. Default false. */
  readonly recursive?: boolean;
  /** Leaves objects with a path segment that starts with a dot. Default true. */
  readonly ignoreDot?: boolean;
  /** The smallest object taken, in bytes. Default 1. */
  readonly minSize?: number;
  /** The largest object taken, in bytes, read by a `HEAD` just before the claim. Default: none. */
  readonly maxSize?: number | undefined;
  /** The most objects claimed in one pass. Default: no limit. */
  readonly maxPerPoll?: number | undefined;
  /** The order objects are claimed in: by path (the default) or least recently modified first. */
  readonly sortBy?: "name" | "mtime";
  /** Takes an object only once two passes in a row find the same size and modification time. */
  readonly stable?: boolean;
  /** Told of each object larger than `maxSize`, which stays where it is. */
  readonly onFileFault?: (fault: FileFault) => void;
  /**
   * Runs on a store that does not honour `If-None-Match: *`, claiming nothing and deleting each
   * object once it is stored: safe only when one engine, and one channel, reads the prefix.
   * Default false, which refuses such a store at start.
   */
  readonly singleNode?: boolean;
}

/** How long a source waits to try a store again when its sink gives no wait, in milliseconds. */
const DOWN_WAIT_MS = 1_000;

/**
 * Reads each object that lands under a prefix in an object store as one message, and deletes it
 * once the message is stored.
 *
 * An object store has no rename, so the claim is a marker: before it reads an object, the source
 * reads its size and entity tag (`HEAD`), then writes `<prefix>/.claimed/<path>` only when no object
 * is there (`If-None-Match: *`). Of two engines that try, the store lets one write it and answers
 * the other `412 Precondition Failed`, so one engine reads the object. It reads the object only
 * while its tag is the one the marker holds (`If-Match`), stores it under the idempotency key
 * `<scheme>:<container>/<key>@<etag>@<modified>`, deletes the object (again `If-Match`, so a newer
 * object written at that key since stays) and then the marker. Each pass first finishes the markers
 * its own channel left: the store answers with the message it already holds, so a stop at any step
 * stores nothing twice.
 *
 * At its first pass it checks that the store honours `If-None-Match: *`, by writing one probe object
 * twice. A store that does not is refused, unless the channel says `singleNode`: then nothing is
 * claimed, and each object is read, stored under the same key (as a resumed message, so the store
 * looks it up) and deleted, which is safe only while one engine reads the prefix.
 *
 * @example
 * ```ts
 * const source = new ObjectSource({ store, prefix: "inbox", channel: "adt", minAgeMs: 1_000 });
 * await source.poll(sink);
 * ```
 */
export class ObjectSource implements SourceConnector {
  private readonly options: ObjectSourceOptions;
  private readonly store: ObjectStore;
  private readonly include: readonly ((rel: string) => boolean)[];
  private readonly exclude: readonly ((rel: string) => boolean)[];
  /** The prefix and a slash, or nothing for the whole bucket. */
  private readonly base: string;
  /** Where markers go: `<prefix>/.claimed/`. */
  private readonly claims: string;
  /** Whether the store honours `If-None-Match: *`, once the first pass has asked. */
  private conditional: boolean | undefined;
  /** The size and modification time each object had at the last pass, for `stable`. */
  private seen = new Map<string, string>();
  /** When the store was found down: the time to try it again, in epoch milliseconds. */
  private down: number | undefined;

  /** @param options The store and prefix to read, the channel, and which objects to take. */
  constructor(options: ObjectSourceOptions) {
    this.options = options;
    this.store = options.store;
    this.include = (options.include ?? []).map(matcher);
    this.exclude = (options.exclude ?? []).map(matcher);
    this.base = options.prefix === "" ? "" : `${options.prefix}/`;
    this.claims = `${this.base}${OBJECT_CLAIMED_DIR}/`;
  }

  /** Stores what this channel claimed and did not finish, then every ready object. */
  async poll(sink: MessageSink): Promise<void> {
    const { now = Date.now } = this.options;
    if (this.down !== undefined && now() < this.down) return;
    try {
      await this.pass(sink);
    } catch (error) {
      if (!isLocationDown(error)) throw error;
      // The store cannot be reached: the source is down, not the engine. The objects stay.
      this.down = now() + (sink.sourceDown?.(error.code) ?? DOWN_WAIT_MS);
      return;
    }
    if (this.down !== undefined) {
      this.down = undefined;
      sink.sourceUp?.();
    }
  }

  /** Ends the store's client. */
  async stop(): Promise<void> {
    await this.store.close?.();
  }

  /** One pass of {@link ObjectSource.poll}. */
  private async pass(sink: MessageSink): Promise<void> {
    this.conditional ??= await this.probe();
    if (!this.conditional && this.options.singleNode !== true) {
      throw objectFailure(
        NO_CONDITIONAL_WRITE,
        "this object store does not honour If-None-Match, so two engines could store one object twice",
      );
    }
    if (this.conditional) await this.resume(sink);
    const { maxPerPoll = Infinity } = this.options;
    let taken = 0;
    for (const found of await this.ready()) {
      if (taken >= maxPerPoll) break;
      if (await this.take(found, sink)) taken += 1;
    }
  }

  /**
   * Whether the store honours `If-None-Match: *`: a probe object written twice under one new key.
   * Only a second write that succeeds, or a conditional write the store fails as not implemented
   * (a code ending `_NOT_IMPLEMENTED`, as for a `501`), says it does not; a write it refuses says
   * it does. Every other error, a missing package or bucket among them, is thrown with its own code
   * and decides nothing, so the next pass asks again.
   */
  private async probe(): Promise<boolean> {
    const key = `${this.claims}.probe/${randomBytes(8).toString("hex")}`;
    const empty = new Uint8Array(0);
    try {
      return !((await this.store.create(key, empty)) && (await this.store.create(key, empty)));
    } catch (error) {
      if (notImplemented(error)) return false;
      throw error;
    } finally {
      await this.store.remove(key).catch(() => undefined);
    }
  }

  /** Every object of one listing, page by page. */
  private async listAll(prefix: string, delimiter: string | undefined): Promise<ObjectInfo[]> {
    const all: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const page = await this.store.list(prefix, delimiter, token);
      all.push(...page.objects);
      token = page.next;
    } while (token !== undefined);
    return all;
  }

  /**
   * Finishes each marker this channel left: hands the object in again, marked `resumed`, when it is
   * still the version the marker claims, then deletes it and the marker. A marker whose object is
   * gone or replaced is deleted: its object was stored and deleted, or a writer replaced it.
   */
  private async resume(sink: MessageSink): Promise<void> {
    const markers = (await this.listAll(this.claims, "/")).sort((a, b) => compare(a.key, b.key));
    for (const found of markers) {
      const rel = decodePath(found.key.slice(this.claims.length));
      let now: ObjectInfo | undefined;
      try {
        const marker = parseMarker(await this.store.get(found.key, found.etag));
        if (marker?.channel !== this.options.channel) continue;
        now = await this.store.head(`${this.base}${rel}`);
        if (now?.etag !== marker.etag || now.modifiedMs !== marker.modifiedMs) now = undefined;
      } catch (error) {
        if (isLocationDown(error)) throw error;
        this.options.onReadError?.(error);
        continue;
      }
      // A store that refuses the message ends the pass, as a claim's does, and the marker stays.
      if (now !== undefined && !(await this.keep(rel, now, sink, true))) continue;
      await this.store.remove(found.key, found.etag);
    }
  }

  /** Whether `rel` passes `include` and `exclude`; a pattern that runs too long leaves it. */
  private judged(rel: string): boolean {
    try {
      const included = this.include.length === 0 || this.include.some((test) => test(rel));
      return included && !this.exclude.some((test) => test(rel));
    } catch (error) {
      this.options.onReadError?.(error);
      return false;
    }
  }

  /** The objects ready to be claimed this pass, in the order they are to be claimed. */
  private async ready(): Promise<Found[]> {
    const { minAgeMs, now = Date.now, recursive = false, ignoreDot = true } = this.options;
    const { minSize = 1, stable = false, sortBy = "name" } = this.options;
    const at = now();
    const seen = new Map<string, string>();
    const ready: Found[] = [];
    for (const object of await this.listAll(this.base, recursive ? undefined : "/")) {
      const rel = object.key.slice(this.base.length);
      // A folder placeholder, the claim folder, and (by default) any dot segment are passed over.
      if (rel === "" || rel.endsWith("/")) continue;
      if (rel.startsWith(`${OBJECT_CLAIMED_DIR}/`)) continue;
      if (ignoreDot && rel.split("/").some((part) => part.startsWith("."))) continue;
      const state = `${String(object.size)}:${String(object.modifiedMs)}`;
      const unchanged = this.seen.get(rel) === state;
      seen.set(rel, state);
      if (at - object.modifiedMs < minAgeMs || object.size < minSize) continue;
      if (stable && !unchanged) continue;
      if (!this.judged(rel)) continue;
      ready.push({ ...object, rel });
    }
    this.seen = seen;
    return ready.sort(
      (a, b) => (sortBy === "mtime" ? a.modifiedMs - b.modifiedMs : 0) || compare(a.rel, b.rel),
    );
  }

  /**
   * Claims, stores and deletes `found`: true once it is claimed. Nothing is claimed when the object
   * is gone, larger than `maxSize` by a `HEAD` made now, or another engine wrote its marker first.
   */
  private async take(found: Found, sink: MessageSink): Promise<boolean> {
    const { maxSize = Infinity, onReadError, onFileFault, channel } = this.options;
    const marker = `${this.claims}${encodePath(found.rel)}`;
    let now: ObjectInfo | undefined;
    try {
      // The object as it is now: its size is held to maxSize, and its version is what is claimed.
      now = await this.store.head(found.key);
      if (now === undefined) return false;
      if (now.size > maxSize) {
        onFileFault?.({ reason: "too-large", moved: false });
        return false;
      }
      if (this.conditional === true) {
        faultPoint("before-claim-move");
        const body = markerBody({ channel, etag: now.etag, modifiedMs: now.modifiedMs });
        if (!(await this.store.create(marker, body))) return false;
        faultPoint("after-claim-flush");
      }
    } catch (error) {
      if (isLocationDown(error)) throw error;
      onReadError?.(error);
      return false;
    }
    if (this.conditional !== true) {
      // No marker: the store looks each object up by its key, so a stop after the store and before
      // the delete stores nothing twice while one engine reads the prefix.
      return this.keep(found.rel, now, sink, true);
    }
    // A read that failed leaves the marker, and the next pass finishes it.
    if (await this.keep(found.rel, now, sink, false)) await this.store.remove(marker);
    return true;
  }

  /**
   * Reads the version of the object `info` names, stores it, and deletes that version: true when
   * done with it. An object gone or replaced since is not read, and is done with too: a replacement
   * is found by a later pass. A read that fails otherwise is said, and answers false. A store that
   * refuses the message, or a delete that fails, ends the pass.
   */
  private async keep(
    rel: string,
    info: ObjectInfo,
    sink: MessageSink,
    resumed: boolean,
  ): Promise<boolean> {
    const { scheme, container } = this.store;
    let body: Uint8Array;
    try {
      body = await this.store.get(info.key, info.etag);
    } catch (error) {
      if (gone(error)) return true;
      if (isLocationDown(error)) throw error;
      this.options.onReadError?.(error);
      return false;
    }
    await sink.receive(body, {
      idempotencyKey: `${scheme}:${container}/${info.key}@${info.etag}@${String(info.modifiedMs)}`,
      resumed,
      source: { name: rel },
    });
    // A sink that copied the body keeps none of it, and this source is done with it.
    if (copiesBodies(sink)) release(body);
    await this.store.remove(info.key, info.etag);
    return true;
  }
}

/** Whether `error` says the store does not do what was asked: a code ending `_NOT_IMPLEMENTED`. */
function notImplemented(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.endsWith("_NOT_IMPLEMENTED");
}

/** Whether `error` says an object is gone, or is no longer the version asked for. */
function gone(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === OBJECT_CHANGED;
}

/** Whether two bodies hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
}

/** Options for an {@link ObjectDestination}. */
export interface ObjectDestinationOptions {
  readonly store: ObjectStore;
  /** The folder in the bucket or container: its key prefix, without a slash at either end. */
  readonly prefix: string;
  /** The extension of the objects written, without the dot. */
  readonly extension: string;
  /**
   * `create` (the default) writes only where no object is (`If-None-Match: *`); `overwrite`
   * replaces one.
   */
  readonly mode?: "create" | "overwrite";
}

/**
 * Writes each output as the object `<prefix>/<message id>-<output number>.<extension>`, whole in one
 * request, so a reader never sees half of one. In `create` mode it writes only where no object is
 * (`If-None-Match: *`). An object already there that holds the same bytes is an earlier attempt of
 * this delivery, cut off before it was recorded, and counts as delivered; one that holds other bytes
 * is rejected with the reason `OBJECT_EXISTS` and never replaced.
 *
 * @example
 * ```ts
 * const destination = new ObjectDestination({ store, prefix: "outbox", extension: "hl7" });
 * await destination.deliver({ messageId: 1, seq: 0, body });
 * ```
 */
export class ObjectDestination implements DestinationConnector {
  private readonly options: ObjectDestinationOptions;

  /** @param options The store and prefix to write into, the extension, and the write mode. */
  constructor(options: ObjectDestinationOptions) {
    this.options = options;
    // The object is written before `deliver` resolves, and the body is not kept.
    markCopiesBodies(this);
  }

  /** Ends the store's client. */
  async stop(): Promise<void> {
    await this.options.store.close?.();
  }

  /** Writes one output as an object. */
  async deliver(message: OutgoingMessage): Promise<void> {
    const { store, prefix, extension, mode = "create" } = this.options;
    const base = prefix === "" ? "" : `${prefix}/`;
    const key = `${base}${String(message.messageId)}-${String(message.seq + 1)}.${extension}`;
    if (mode === "overwrite") {
      await store.put(key, message.body);
      return;
    }
    if (await store.create(key, message.body)) return;
    const there = await store.head(key);
    if (there !== undefined && same(await store.get(key, there.etag), message.body)) return;
    throw new DeliveryRejected("OBJECT_EXISTS");
  }
}
