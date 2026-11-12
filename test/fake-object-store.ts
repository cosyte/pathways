import {
  OBJECT_CHANGED,
  type ObjectInfo,
  type ObjectPage,
  type ObjectStore,
  objectFailure,
} from "../src/connectors/object-store.js";

/** One object held by the {@link FakeObjectStore}. */
interface Held {
  body: Uint8Array;
  etag: string;
  modifiedMs: number;
}

/** What the next call of a method does instead of its work: fail with `error`, once. */
type Trap = (key: string) => Error | undefined;

/**
 * An object store in memory, as S3 and Azure Blob behave: each write gets a new entity tag, a
 * conditional write or delete is checked against it, and a listing comes in pages of `pageSize`.
 * With `conditional: false` it ignores `If-None-Match`, as a store without conditional writes does.
 */
export class FakeObjectStore implements ObjectStore {
  readonly scheme = "fake";
  readonly container = "bucket";
  readonly objects = new Map<string, Held>();
  readonly calls: string[] = [];
  conditional = true;
  pageSize = 2;
  now = 1_000_000;
  closed = 0;
  private writes = 0;
  private readonly traps = new Map<string, Trap[]>();

  /** Writes `text` at `key`, `ageMs` old, as a sender would. */
  drop(key: string, text: string, ageMs = 60_000): void {
    this.writes += 1;
    this.objects.set(key, {
      body: new TextEncoder().encode(text),
      etag: `"e${String(this.writes)}"`,
      modifiedMs: this.now - ageMs,
    });
  }

  /** The text at `key`, or `undefined`. */
  text(key: string): string | undefined {
    const held = this.objects.get(key);
    return held === undefined ? undefined : new TextDecoder().decode(held.body);
  }

  /** The keys held, sorted. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  /** Makes `method` fail with what `trap` returns for a key, until it returns undefined. */
  trap(method: string, trap: Trap): void {
    this.traps.set(method, [...(this.traps.get(method) ?? []), trap]);
  }

  /** Notes the call, and the error a trap gives for it, which the method rejects with. */
  private trapped(method: string, key: string): Error | undefined {
    this.calls.push(`${method} ${key}`);
    for (const trap of this.traps.get(method) ?? []) {
      const error = trap(key);
      if (error !== undefined) return error;
    }
    return undefined;
  }

  private info(key: string, held: Held): ObjectInfo {
    return { key, size: held.body.byteLength, etag: held.etag, modifiedMs: held.modifiedMs };
  }

  list(
    prefix: string,
    delimiter: string | undefined,
    token: string | undefined,
  ): Promise<ObjectPage> {
    const error = this.trapped("list", prefix);
    if (error !== undefined) return Promise.reject(error);
    const keys = this.keys().filter(
      (key) =>
        key.startsWith(prefix) &&
        (delimiter === undefined || !key.slice(prefix.length).includes(delimiter)),
    );
    const start = Number(token ?? 0);
    const page = keys.slice(start, start + this.pageSize);
    const next = start + this.pageSize < keys.length ? String(start + this.pageSize) : undefined;
    return Promise.resolve({
      objects: page.map((key) => this.info(key, this.objects.get(key) as Held)),
      next,
    });
  }

  head(key: string): Promise<ObjectInfo | undefined> {
    const error = this.trapped("head", key);
    if (error !== undefined) return Promise.reject(error);
    const held = this.objects.get(key);
    return Promise.resolve(held === undefined ? undefined : this.info(key, held));
  }

  get(key: string, etag: string): Promise<Uint8Array> {
    const error = this.trapped("get", key);
    if (error !== undefined) return Promise.reject(error);
    const held = this.objects.get(key);
    if (held === undefined) return Promise.reject(objectFailure("ENOENT", "gone"));
    if (held.etag !== etag) return Promise.reject(objectFailure(OBJECT_CHANGED, "changed"));
    return Promise.resolve(held.body.slice());
  }

  create(key: string, body: Uint8Array): Promise<boolean> {
    const error = this.trapped("create", key);
    if (error !== undefined) return Promise.reject(error);
    if (this.conditional && this.objects.has(key)) return Promise.resolve(false);
    this.write(key, body);
    return Promise.resolve(true);
  }

  put(key: string, body: Uint8Array): Promise<void> {
    const error = this.trapped("put", key);
    if (error !== undefined) return Promise.reject(error);
    this.write(key, body);
    return Promise.resolve();
  }

  remove(key: string, etag?: string): Promise<void> {
    const error = this.trapped("remove", key);
    if (error !== undefined) return Promise.reject(error);
    const held = this.objects.get(key);
    if (held !== undefined && (etag === undefined || held.etag === etag)) this.objects.delete(key);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }

  private write(key: string, body: Uint8Array): void {
    this.writes += 1;
    this.objects.set(key, {
      body: body.slice(),
      etag: `"e${String(this.writes)}"`,
      modifiedMs: this.now,
    });
  }
}
