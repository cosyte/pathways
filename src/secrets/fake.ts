import {
  pickField,
  SecretError,
  type ResolvedSecret,
  type SecretProvider,
  type SecretRef,
} from "./provider.js";

/**
 * One version of a secret a {@link fakeSecretProvider} holds: its value, and optionally its version's
 * name (by default its place in the list, from `"1"`) and when it expires.
 *
 * @example
 * ```ts
 * const secret: FakeSecret = { value: "synthetic-token", version: "v2" };
 * ```
 */
export interface FakeSecret {
  readonly value: string;
  readonly version?: string | undefined;
  readonly expiresAt?: Date | undefined;
}

/** What a fake holds for one name: a value, a version, or every version with the current one last. */
export type FakeSecretEntry = string | FakeSecret | readonly FakeSecret[];

/**
 * A {@link SecretProvider} held in memory, for tests: no network, no cloud account. It answers as the
 * contract asks of every provider, so a channel that reads `{ secret: { provider, name } }` can be
 * tested against it in place of a cloud store.
 *
 * @example
 * ```ts
 * const vault = fakeSecretProvider({ "lab/api": '{"token":"synthetic-token"}' });
 * await vault.resolve({ name: "lab/api", field: "token" }, AbortSignal.timeout(1_000));
 * vault.calls; // [{ name: "lab/api", field: "token" }]
 * ```
 */
export interface FakeSecretProvider extends SecretProvider {
  /** Every request it was given, in order. */
  readonly calls: readonly SecretRef[];
  /** Sets or replaces `name`; a single value or secret adds it as a new current version. */
  set(name: string, entry: FakeSecretEntry): void;
  /** Removes `name`, so a later request for it is not found. */
  delete(name: string): void;
  /** Makes every later request for `name` reject with `error`, as a store that fails would. */
  fail(name: string, error: Error): void;
  /** How many times `stop` was called. */
  readonly stopped: number;
}

/**
 * A provider for tests, holding `secrets` by name. It keeps versions, takes `field` from a value that
 * is a JSON object as the built-in providers do, honours the abort signal, and rejects a missing
 * name, field or version with a {@link SecretError}.
 *
 * @example
 * ```ts
 * // test/fake-vault.ts, named in a test project's pathways.yaml as secrets: { vault: { module: ./fake-vault.ts } }
 * export default () => fakeSecretProvider({ "lab/api": "synthetic-token-0123456789" });
 * ```
 */
export function fakeSecretProvider(
  secrets: Readonly<Record<string, FakeSecretEntry>> = {},
): FakeSecretProvider {
  const held = new Map<string, FakeSecret[]>();
  const failing = new Map<string, Error>();
  const calls: SecretRef[] = [];
  let stopped = 0;
  const set = (name: string, entry: FakeSecretEntry): void => {
    if (Array.isArray(entry)) {
      held.set(name, [...(entry as readonly FakeSecret[])]);
      return;
    }
    const versions = held.get(name) ?? [];
    versions.push(typeof entry === "string" ? { value: entry } : (entry as FakeSecret));
    held.set(name, versions);
  };
  const answer = (ref: SecretRef, signal: AbortSignal): ResolvedSecret => {
    calls.push({ ...ref });
    signal.throwIfAborted();
    const failure = failing.get(ref.name);
    if (failure !== undefined) throw failure;
    const versions = (held.get(ref.name) ?? []).map((secret, index) => ({
      ...secret,
      version: secret.version ?? String(index + 1),
    }));
    if (versions.length === 0) throw new SecretError("ERR_PATHWAYS_SECRET_NOT_FOUND", ref.name);
    const found =
      ref.version === undefined
        ? versions.at(-1)
        : versions.find((secret) => secret.version === ref.version);
    if (found === undefined) throw new SecretError("ERR_PATHWAYS_SECRET_VERSION", ref.name);
    return {
      value: pickField(found.value, ref.field, ref.name),
      version: found.version,
      ...(found.expiresAt === undefined ? {} : { expiresAt: found.expiresAt }),
    };
  };
  for (const [name, entry] of Object.entries(secrets)) set(name, entry);
  return {
    get calls() {
      return calls;
    },
    get stopped() {
      return stopped;
    },
    set,
    delete: (name) => {
      held.delete(name);
      failing.delete(name);
    },
    fail: (name, error) => {
      failing.set(name, error);
    },
    // Whatever answer throws, pickField's refusal among it, rejects the promise.
    resolve: (ref, signal) => new Promise((done) => done(answer(ref, signal))),
    stop() {
      stopped += 1;
    },
  };
}
