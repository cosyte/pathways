import type { Logger } from "pino";

import type { ProjectConfig } from "../config/schema.js";
import type { Env } from "../connectors/endpoint.js";
import { EncryptedStore, UnencryptedStore } from "../encryption/encrypted-store.js";
import { keysToStart, type KeyProvider } from "../encryption/keys.js";
import { customKeyProvider, customStore } from "../extensions/build.js";
import { resolveSecrets, type Secrets } from "../secrets/resolve.js";
import { Store, type MessageStore } from "./store.js";

/**
 * What opening a store, or its keys, needs beside the project.
 *
 * @example
 * ```ts
 * const context: OpenStoreContext = { env: process.env, logger };
 * ```
 */
export interface OpenStoreContext {
  /** Where master keys, and a custom store's or key provider's credentials, are read from. */
  readonly env: Env;
  readonly logger: Logger;
  /**
   * The secrets a start resolved. Without them, the connection URL's and master keys' references
   * to a provider `secrets:` names are resolved here.
   */
  readonly secrets?: Secrets | undefined;
}

/**
 * The secrets opening the store reads: `context.secrets`, or the connection URL's and the master
 * keys' resolved now.
 *
 * @throws {ConfigError} when a secret a provider holds cannot be had.
 * @throws {ExtensionLoadError} when a provider's module, factory or result is wrong.
 * @example
 * ```ts
 * const secrets = await storeSecrets(project, { env: process.env, logger });
 * ```
 */
export async function storeSecrets(
  project: ProjectConfig,
  context: OpenStoreContext,
): Promise<Secrets> {
  return context.secrets ?? (await resolveSecrets(project, context, "store"));
}

/**
 * The key provider `pathways.yaml`'s `encryption` names, ready to use: the built-in one over master
 * keys read now from their files, environment variables or secret providers, or a custom one a module builds
 * (`encryption: { provider: { module, options } }`). `undefined` for `encryption: none`.
 *
 * @throws {ConfigError} when `encryption` is not set, or a master key cannot be read.
 * @throws {ExtensionLoadError} when a custom provider's module, factory or result is wrong.
 * @example
 * ```ts
 * const keys = await startingKeys(project, { env: process.env, logger });
 * ```
 */
export async function startingKeys(
  project: ProjectConfig,
  context: OpenStoreContext,
): Promise<KeyProvider | undefined> {
  const { encryption } = project;
  if (encryption?.kind !== "provider") {
    if (encryption?.kind !== "keys") return keysToStart(encryption, context.env);
    return keysToStart(encryption, await storeSecrets(project, context));
  }
  return customKeyProvider(
    encryption,
    {
      dir: project.root,
      env: context.env,
      logger: context.logger.child({ extension: "encryption" }),
    },
    "pathways.yaml: encryption.provider.module",
  );
}

/**
 * Opens the store `pathways.yaml` names as it is, with no encryption layer: SQLite by default, a
 * database server, or a custom store from a module whose default export is a `StoreFactory`. Only `pathways rekey`, which
 * rewrites what a store holds, works on a store this way; everything else uses {@link openStore}.
 *
 * @throws {ConfigError} when a database server's URL, TLS files or driver package cannot be had.
 * @throws {StorageError} when the database cannot be opened or its schema brought up to date.
 * @throws {ExtensionLoadError} when a custom store's module, factory or result is wrong.
 * @example
 * ```ts
 * const raw = await openRawStore(project, { env: process.env, logger });
 * ```
 */
export async function openRawStore(
  project: ProjectConfig,
  context: OpenStoreContext,
): Promise<MessageStore> {
  const { storage } = project;
  if (storage.kind === "sqlite") return Store.open(storage, { env: context.env });
  if (storage.kind !== "module") {
    return Store.open(storage, { env: await storeSecrets(project, context) });
  }
  return customStore(
    storage,
    {
      dir: project.root,
      env: context.env,
      logger: context.logger.child({ extension: "storage" }),
    },
    "pathways.yaml: storage.module",
  );
}

/**
 * Opens the store the engine runs on: the one `pathways.yaml` names, built in or custom, inside an
 * `EncryptedStore` under `keys`, or an `UnencryptedStore` when `keys` is `undefined`
 * (`encryption: none`).
 *
 * Every store the engine runs on comes out of here, so a custom store gets the same encryption at
 * rest as SQLite: it only ever holds encrypted bodies and error texts.
 *
 * @throws {ExtensionLoadError} when a custom store's module, factory or result is wrong.
 * @example
 * ```ts
 * const keys = await startingKeys(project, context);
 * const store = await openStore(project, { ...context, keys });
 * ```
 */
export async function openStore(
  project: ProjectConfig,
  context: OpenStoreContext & { readonly keys: KeyProvider | undefined },
): Promise<MessageStore> {
  const raw = await openRawStore(project, context);
  const { keys } = context;
  return keys === undefined ? new UnencryptedStore(raw) : new EncryptedStore(raw, keys);
}
