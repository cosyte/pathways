// The interfaces an extension is written against: a source or destination connector's factory, a
// lifecycle hook's factory, a storage adapter's factory and a secret provider's factory. Types
// only: the package entry exports them, so this module imports nothing at runtime.

import type { Format } from "../config/schema.js";
import type { DestinationConnector, SourceConnector } from "../connectors/types.js";
import type { KeyProvider } from "../encryption/keys.js";
import type { SecretProvider } from "../secrets/provider.js";
import type { MessageStore } from "../storage/store.js";
import type { LifecycleEvent } from "./events.js";

/**
 * The `options:` an extension's YAML block gives it, as parsed: plain YAML values, not checked by
 * Pathways. A factory names its own shape as the type parameter and should check what it reads.
 * Credentials never go in `options`; read them from `context.env`.
 *
 * @example
 * ```ts
 * const folder = typeof options["folder"] === "string" ? options["folder"] : "./in";
 * ```
 */
export type ExtensionOptions = Readonly<Record<string, unknown>>;

/**
 * A value a log line may carry. Objects are left out on purpose: an error or a message object can
 * carry content.
 *
 * @example
 * ```ts
 * const value: LogValue = 42;
 * ```
 */
export type LogValue = string | number | boolean | null | undefined;

/**
 * One structured log line: an `event` name, then fields that are ids, counts, codes and error
 * names. Never message content, never an error's own text, never a credential.
 *
 * @example
 * ```ts
 * const fields: LogFields = { event: "inbox-read-failed", code: "EACCES" };
 * ```
 */
export interface LogFields {
  readonly event: string;
  readonly [field: string]: LogValue;
}

/**
 * The engine's logger, handed to an extension. Lines land in the same JSON log as the engine's,
 * tagged with the channel and which extension wrote them.
 *
 * @example
 * ```ts
 * context.logger.warn({ event: "inbox-read-failed", code: "EACCES" });
 * ```
 */
export interface ExtensionLogger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

/**
 * What every extension factory is given beside its options.
 *
 * @example
 * ```ts
 * const token = context.env["INBOX_TOKEN"];
 * const folder = path.resolve(context.dir, "./in");
 * ```
 */
export interface ExtensionContext {
  /**
   * The folder of the YAML file that names the extension: the channel's folder, or the project
   * root for `pathways.yaml`. Resolve relative paths in `options` against it.
   */
  readonly dir: string;
  /** Where to read credentials and other settings from: `process.env` when the engine runs. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: ExtensionLogger;
}

/**
 * What a connector factory is given beside its options: the context, the channel's name and its
 * format.
 *
 * @example
 * ```ts
 * context.logger.info({ event: "inbox-ready", channel: context.channel, format: context.format });
 * ```
 */
export interface ChannelContext extends ExtensionContext {
  readonly channel: string;
  readonly format: Format;
}

/**
 * What a hook factory is given beside its options: the context, and the channel for a hook a
 * channel's YAML names (`undefined` for an engine-wide one in `pathways.yaml`).
 *
 * @example
 * ```ts
 * const scope = context.channel ?? "engine";
 * ```
 */
export interface HookContext extends ExtensionContext {
  readonly channel: string | undefined;
}

/**
 * Builds a custom source: a module's default export, named in a channel's YAML as
 * `source: { module: ./my-source.ts, options: {...} }`. It may return the connector or a promise of
 * it. The engine calls `poll` on every pass, or `start` once and `stop` at shutdown.
 *
 * @example
 * ```ts
 * // channels/inbox/my-source.ts
 * import type { SourceFactory } from "@cosyte/pathways";
 *
 * export default ((options, context) => ({
 *   async poll(sink) {
 *     for (const body of await fetchWaiting(options.queue, context.env["QUEUE_TOKEN"])) {
 *       await sink.receive(body); // stored before it resolves: acknowledge only after
 *       await acknowledge(body);
 *     }
 *   },
 * })) satisfies SourceFactory<{ queue: string }>;
 * ```
 */
export type SourceFactory<Options = ExtensionOptions> = (
  options: Options,
  context: ChannelContext,
) => SourceConnector | Promise<SourceConnector>;

/**
 * Builds a custom destination: a module's default export, named in a channel's YAML as
 * `destinations: [{ module: ./my-destination.ts, options: {...} }]`. Its `deliver` throws to have the
 * engine retry, or throws a `DeliveryRejected` when sending again cannot help.
 *
 * @example
 * ```ts
 * // channels/inbox/my-destination.ts
 * import { DeliveryRejected, type DestinationFactory } from "@cosyte/pathways";
 *
 * export default ((options) => ({
 *   async deliver(message) {
 *     const status = await putObject(options.bucket, `${message.messageId}-${message.seq}`, message.body);
 *     if (status === 400) throw new DeliveryRejected("HTTP 400");
 *     if (status !== 200) throw Object.assign(new Error("not stored"), { code: `HTTP_${status}` });
 *   },
 * })) satisfies DestinationFactory<{ bucket: string }>;
 * ```
 */
export type DestinationFactory<Options = ExtensionOptions> = (
  options: Options,
  context: ChannelContext,
) => DestinationConnector | Promise<DestinationConnector>;

/**
 * A lifecycle hook: told of each {@link LifecycleEvent}, one at a time and in order. Paging,
 * webhooks and forwarding to a SIEM are hooks.
 *
 * A hook cannot hold the engine up. Each call has a time limit (the hook entry's `timeout`, 5
 * seconds unless set): past it, `signal` aborts, the call is abandoned and logged, and the hook gets
 * the next event. A call that throws is logged by error name and code, and the next event goes
 * ahead. Events queue for a busy hook; past 1,000 waiting, new ones are dropped and logged. On stop,
 * the engine gives a hook up to its time limit to finish what is queued, then calls `stop`.
 *
 * Hooks run in the engine's own thread: an endless synchronous loop stops everything, so a hook
 * awaits its I/O and does little work itself.
 *
 * @example
 * ```ts
 * // A webhook, much as the built-in `webhook:` hook does it.
 * import type { HookFactory } from "@cosyte/pathways";
 *
 * export default ((options, context) => ({
 *   async onEvent(event, signal) {
 *     const response = await fetch(options.url, {
 *       method: "POST",
 *       headers: {
 *         "Content-Type": "application/json",
 *         Authorization: `Bearer ${context.env["OPS_WEBHOOK_TOKEN"] ?? ""}`,
 *       },
 *       body: JSON.stringify(event),
 *       signal,
 *     });
 *     if (!response.ok) throw Object.assign(new Error("webhook refused"), { code: `HTTP_${response.status}` });
 *   },
 * })) satisfies HookFactory<{ url: string }>;
 * ```
 */
export interface LifecycleHook {
  /**
   * Handles one event. Resolve when done; reject to have the failure logged. `signal` aborts when
   * the call runs past its time limit.
   */
  onEvent(event: LifecycleEvent, signal: AbortSignal): void | Promise<void>;
  /** Releases what the hook keeps open, such as connections. Called once, after the last event. */
  stop?(): void | Promise<void>;
}

/**
 * Builds a lifecycle hook: a module's default export, named in `pathways.yaml` (engine-wide) or a
 * channel's YAML (that channel only) as `hooks: [./hooks/pager.ts]` or
 * `hooks: [{ module: ./hooks/pager.ts, options: {...}, events: [...], timeout: 2s }]`.
 *
 * @example
 * ```ts
 * // hooks/pager.ts
 * import type { HookFactory } from "@cosyte/pathways";
 *
 * export default ((_options, context) => ({
 *   async onEvent(event, signal) {
 *     if (event.type !== "delivery-rejected" && event.type !== "source-down") return;
 *     await page(context.env["PAGER_KEY"], `${event.channel}: ${event.type}`, signal);
 *   },
 * })) satisfies HookFactory;
 * ```
 */
export type HookFactory<Options = ExtensionOptions> = (
  options: Options,
  context: HookContext,
) => LifecycleHook | Promise<LifecycleHook>;

/**
 * Builds a custom storage adapter: a module's default export, named in `pathways.yaml` as
 * `storage: { module: ./my-store.ts, options: {...} }`. It returns a {@link MessageStore}, ready to
 * use (its schema created or migrated), or a promise of one. The engine calls `close` at shutdown.
 *
 * @example
 * ```ts
 * // stores/my-store.ts
 * import type { MessageStore, StoreFactory } from "@cosyte/pathways";
 *
 * export default (async (options, context) => {
 *   const pool = await connect(options.url, context.env["STORE_PASSWORD"]);
 *   await migrate(pool);
 *   return new PoolStore(pool) satisfies MessageStore;
 * }) satisfies StoreFactory<{ url: string }>;
 * ```
 */
export type StoreFactory<Options = ExtensionOptions> = (
  options: Options,
  context: ExtensionContext,
) => MessageStore | Promise<MessageStore>;

/**
 * Builds a custom key provider for encryption at rest: a module's default export, named in
 * `pathways.yaml` as `encryption: { provider: { module: ./kms.ts, options: {...} } }`. It returns a
 * `KeyProvider` (or a promise of one) that wraps each data key under its current master key and
 * unwraps keys under its older ones, such as one over a cloud key service. It is built once, when
 * the engine (or `pathways rekey`) starts.
 *
 * @example
 * ```ts
 * // kms.ts
 * import type { KeyProviderFactory } from "@cosyte/pathways";
 *
 * export default (async (options, context) => {
 *   const kms = await connectKms(options.region, context.env["KMS_CREDENTIALS"]);
 *   return {
 *     currentKeyId: options.keyId,
 *     wrapKey: async (dataKey) => ({ keyId: options.keyId, wrapped: await kms.encrypt(options.keyId, dataKey) }),
 *     unwrapKey: (keyId, wrapped) => kms.decrypt(keyId, wrapped),
 *   };
 * }) satisfies KeyProviderFactory<{ region: string; keyId: string }>;
 * ```
 */
export type KeyProviderFactory<Options = ExtensionOptions> = (
  options: Options,
  context: ExtensionContext,
) => KeyProvider | Promise<KeyProvider>;

/**
 * Builds a secret provider: a module's default export, named in `pathways.yaml` as
 * `secrets: { vault: { module: ./vault.ts, options: {...} } }`. It returns a `SecretProvider` (or a
 * promise of one) that `{ secret: { provider: vault, name } }` references are resolved through. It
 * is built when the engine (or a command that opens the store) starts, asked for each secret, and
 * stopped. Its own credentials come from `context.env`, or from a file its options name.
 *
 * @example
 * ```ts
 * // vault.ts
 * import type { SecretProviderFactory } from "@cosyte/pathways";
 *
 * export default (async (options, context) => {
 *   const client = await connectStore(options.address, context.env["STORE_ROLE_TOKEN"]);
 *   return {
 *     resolve: async (ref, signal) => {
 *       const found = await client.read(ref.name, { field: ref.field, version: ref.version, signal });
 *       return { value: found.value, version: found.version };
 *     },
 *     stop: () => client.close(),
 *   };
 * }) satisfies SecretProviderFactory<{ address: string }>;
 * ```
 */
export type SecretProviderFactory<Options = ExtensionOptions> = (
  options: Options,
  context: ExtensionContext,
) => SecretProvider | Promise<SecretProvider>;
