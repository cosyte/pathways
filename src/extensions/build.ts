import type { ModuleConnector, ModuleOptions } from "../config/schema.js";
import type { AckBuilder } from "../connectors/ack.js";
import type { DestinationConnector, SourceConnector } from "../connectors/types.js";
import type { KeyProvider } from "../encryption/keys.js";
import type { MessageStore } from "../storage/store.js";
import { buildFromModule, loadDefaultFunction, methodsMissing, withTimeout } from "./load.js";
import type { ChannelContext, ExtensionContext } from "./types.js";

// Builds the extensions a channel or a project names: custom connectors, an MLLP source's ACK
// builder and a custom store, each from a module whose default export is checked before use.

/**
 * Every method a {@link MessageStore} has, so a custom store is checked for each. The `satisfies`
 * fails the typecheck when the interface gains a method this does not list.
 */
const STORE_METHODS = Object.keys({
  receive: true,
  nextToTransform: true,
  completeTransform: true,
  failTransform: true,
  nextDelivery: true,
  markDelivered: true,
  scheduleRetry: true,
  failDelivery: true,
  messageCounts: true,
  deliveryCounts: true,
  retryingDeliveries: true,
  channels: true,
  message: true,
  messageBody: true,
  deliveries: true,
  outputs: true,
  listMessages: true,
  listRetrying: true,
  requeue: true,
  clear: true,
  expire: true,
  appendAudit: true,
  auditEntries: true,
  close: true,
} satisfies Record<keyof MessageStore, true>);

/**
 * Builds a custom source from its module's default export, a `SourceFactory`. It must return an
 * object with `poll`, or `start` (and, if it keeps anything open, `stop`).
 *
 * @throws {ExtensionLoadError} naming `where` when the module, its factory or what it returns is
 *   wrong.
 * @example
 * ```ts
 * const source = await customSource(config, context, "channels/adt/channel.yaml: source.module");
 * ```
 */
export function customSource(
  config: ModuleConnector,
  context: ChannelContext,
  where: string,
): Promise<SourceConnector> {
  return buildFromModule<SourceConnector>(
    config.module,
    where,
    "a source factory",
    config.options,
    context,
    (value) => {
      const what = "a source connector";
      const wrong = methodsMissing(value, what, [], ["poll", "start", "stop"]);
      if (wrong !== undefined) return wrong;
      const connector = value as SourceConnector;
      return connector.poll === undefined && connector.start === undefined
        ? `${what}: it needs poll or start`
        : undefined;
    },
  );
}

/**
 * Builds a custom destination from its module's default export, a `DestinationFactory`. It must
 * return an object with `deliver`, and may have `stop`.
 *
 * @throws {ExtensionLoadError} naming `where` when the module, its factory or what it returns is
 *   wrong.
 * @example
 * ```ts
 * const destination = await customDestination(config, context, "channels/adt/channel.yaml: destinations.0.module");
 * ```
 */
export function customDestination(
  config: ModuleConnector,
  context: ChannelContext,
  where: string,
): Promise<DestinationConnector> {
  return buildFromModule<DestinationConnector>(
    config.module,
    where,
    "a destination factory",
    config.options,
    context,
    (value) => methodsMissing(value, "a destination connector", ["deliver"], ["stop"]),
  );
}

/**
 * Builds a custom store from its module's default export, a `StoreFactory`. It must return an
 * object with every {@link MessageStore} method.
 *
 * @throws {ExtensionLoadError} naming `where` when the module, its factory or what it returns is
 *   wrong.
 * @example
 * ```ts
 * const store = await customStore(config, context, "pathways.yaml: storage.module");
 * ```
 */
export function customStore(
  config: { readonly module: string; readonly options: ModuleOptions },
  context: ExtensionContext,
  where: string,
): Promise<MessageStore> {
  return buildFromModule<MessageStore>(
    config.module,
    where,
    "a store factory",
    config.options,
    context,
    (value) => methodsMissing(value, "a message store", STORE_METHODS),
  );
}

/** What a key id may hold, as `WrappedKey` says: printable ASCII with no space, 1 to 255 characters. */
const KEY_ID = /^[\x21-\x7e]{1,255}$/;

/**
 * Builds a custom key provider from its module's default export, a `KeyProviderFactory`. It must
 * return an object with `wrapKey` and `unwrapKey`, and a `currentKeyId` that is printable ASCII with
 * no space, 1 to 255 characters.
 *
 * @throws {ExtensionLoadError} naming `where` when the module, its factory or what it returns is
 *   wrong.
 * @example
 * ```ts
 * const keys = await customKeyProvider(config, context, "pathways.yaml: encryption.provider.module");
 * ```
 */
export function customKeyProvider(
  config: { readonly module: string; readonly options: ModuleOptions },
  context: ExtensionContext,
  where: string,
): Promise<KeyProvider> {
  return buildFromModule<KeyProvider>(
    config.module,
    where,
    "a key provider factory",
    config.options,
    context,
    (value) => {
      const what = "a key provider";
      const wrong = methodsMissing(value, what, ["wrapKey", "unwrapKey"]);
      if (wrong !== undefined) return wrong;
      const { currentKeyId } = value as KeyProvider;
      return typeof currentKeyId === "string" && KEY_ID.test(currentKeyId)
        ? undefined
        : `${what}: currentKeyId must be printable ASCII with no space, 1 to 255 characters`;
    },
  );
}

/**
 * Loads an MLLP source's ACK builder: its module's default export, an {@link AckBuilder}. It runs
 * in the engine's thread, once per message, so it gets the channel's transform time limit: past it,
 * the source logs the builder's failure and sends the default ACK, as it does when the builder
 * throws.
 *
 * @throws {ExtensionLoadError} naming `where` when the module will not load or has no default
 *   export function.
 * @example
 * ```ts
 * const ackBuilder = await loadAckBuilder(file, "channels/adt/channel.yaml: source.mllp.ackBuilder", 5_000);
 * ```
 */
export async function loadAckBuilder(
  file: string,
  where: string,
  timeoutMs: number,
): Promise<AckBuilder> {
  const builder = (await loadDefaultFunction(file, where, "an ACK builder")) as AckBuilder;
  return (request) => withTimeout(() => builder(request), timeoutMs);
}
