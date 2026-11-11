// Who holds a body's memory, so a stage can hand a body on or free it once it is done with it,
// rather than leave a copy for the collector. A large payload the engine only passes through was
// held many times over: read, encrypted, stored, read back, decrypted, sent to the worker and back,
// encrypted, stored and read again, each a copy of its own until the next collection.
//
// Two rules keep this safe. A body is freed or moved only by the code that made it, or when the one
// it was handed to says it keeps no reference to it ({@link copiesBodies}). And only a view over the
// whole of its own ArrayBuffer is ever freed or moved ({@link ownsBuffer}), so a slice of Node's
// shared Buffer pool, or of a driver's network buffer, is never touched.

/**
 * An ArrayBuffer as ES2024 has it (Node 24 and later), which the compiler's library here predates:
 * `transfer(0)` detaches it and frees its memory at once.
 */
type Es2024ArrayBuffer = ArrayBuffer & {
  readonly detached: boolean;
  transfer(newLength?: number): ArrayBuffer;
};

/** The stores, sinks and destinations that keep no reference to a body once a call resolves. */
const copying = new WeakSet<object>();

/**
 * Marks `target` as one that copies every body it is handed before the call that hands it over
 * resolves, and keeps no reference to it. For a store, it also means every body it reads is in a
 * buffer of its own, which the caller alone then holds. Returns `target`.
 *
 * @example
 * ```ts
 * markCopiesBodies(this); // in a store's constructor
 * ```
 */
export function markCopiesBodies<T extends object>(target: T): T {
  copying.add(target);
  return target;
}

/**
 * Whether `target` was marked by {@link markCopiesBodies}.
 *
 * @example
 * ```ts
 * if (copiesBodies(store)) release(stored);
 * ```
 */
export function copiesBodies(target: object): boolean {
  return copying.has(target);
}

/**
 * Whether `bytes` is a view over the whole of an ArrayBuffer (never a SharedArrayBuffer), so moving
 * or freeing that buffer touches nothing else.
 *
 * @example
 * ```ts
 * ownsBuffer(new Uint8Array(8)); // true
 * ownsBuffer(Buffer.from("ab")); // false: a slice of Node's Buffer pool
 * ```
 */
export function ownsBuffer(bytes: Uint8Array): boolean {
  const buffer = bytes.buffer as Es2024ArrayBuffer;
  return (
    buffer instanceof ArrayBuffer &&
    !buffer.detached &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength &&
    buffer.byteLength > 0
  );
}

/**
 * Frees the memory of `bytes` now, rather than at the next collection, when it is a view over the
 * whole of its own ArrayBuffer; otherwise leaves it as it is. Call it only on a body nothing else
 * holds: once freed, every view of it reads as empty.
 *
 * @example
 * ```ts
 * await inner.receive(channel, encrypted);
 * release(encrypted);
 * ```
 */
export function release(bytes: Uint8Array): void {
  if (ownsBuffer(bytes)) (bytes.buffer as Es2024ArrayBuffer).transfer(0);
}
