// A secret provider module, written as a project would write one over the fake kit, for the tests to
// name in a temporary project's pathways.yaml (`secrets: { vault: { module: <this file> } }`). It
// holds the secrets its options give it, so a test needs no cloud store, and notes each provider it
// builds on a global, where the tests read the calls it was given. Every value is synthetic.

import { fakeSecretProvider, type FakeSecretEntry, type FakeSecretProvider } from "../src/index.js";
import type { SecretProvider, SecretProviderFactory } from "../src/index.js";

interface VaultOptions {
  /** The secrets it holds, by name. */
  readonly secrets?: Readonly<Record<string, FakeSecretEntry>>;
  /** Names whose requests reject, with this error's name and code and a text holding `leak`. */
  readonly failing?: Readonly<Record<string, { name: string; code: string; leak: string }>>;
  /** Names whose requests never settle, to run past the time limit. */
  readonly hanging?: readonly string[];
  /** Answers every request with this, in place of a resolved secret. */
  readonly answer?: unknown;
  /** Expiry for every secret, as epoch milliseconds. */
  readonly expiresAt?: number;
  /** Rejects every request with this value as it is, an Error or not. */
  readonly rejectWith?: unknown;
  /** Makes `stop` throw an error with this code. */
  readonly stopFails?: string;
  /** Builds a provider with no `stop`. */
  readonly noStop?: boolean;
}

/** The providers this module built, newest last, with the options each was given. */
export const built: { provider: FakeSecretProvider; options: VaultOptions; dir: string }[] = ((
  globalThis as { pathwaysVaults?: typeof built }
).pathwaysVaults ??= []);

export default ((options, context) => {
  const secrets: Record<string, FakeSecretEntry> = {};
  for (const [name, entry] of Object.entries(options.secrets ?? {})) {
    secrets[name] =
      options.expiresAt !== undefined && typeof entry === "string"
        ? { value: entry, expiresAt: new Date(options.expiresAt) }
        : entry;
  }
  const provider = fakeSecretProvider(secrets);
  for (const [name, failure] of Object.entries(options.failing ?? {})) {
    const error = Object.assign(new Error(`could not read ${failure.leak}`), {
      code: failure.code,
    });
    error.name = failure.name;
    provider.fail(name, error);
  }
  built.push({ provider, options, dir: context.dir });
  const hanging = new Set(options.hanging ?? []);
  const resolve: SecretProvider["resolve"] = (ref, signal) => {
    if (hanging.has(ref.name)) return new Promise<never>(() => undefined);
    if (options.answer !== undefined) return Promise.resolve(options.answer as never);
    if ("rejectWith" in options) {
      // A provider that rejects with no Error at all is what this option is for.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(options.rejectWith);
    }
    return provider.resolve(ref, signal);
  };
  if (options.noStop === true) return { resolve };
  return {
    resolve,
    stop: () => {
      void provider.stop?.();
      if (options.stopFails !== undefined) {
        throw Object.assign(new Error("synthetic stop failure"), { code: options.stopFails });
      }
    },
  };
}) satisfies SecretProviderFactory<VaultOptions>;
