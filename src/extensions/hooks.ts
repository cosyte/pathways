import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "pino";

import type { HookConfig } from "../config/schema.js";
import type { Env } from "../connectors/endpoint.js";
import type { LifecycleEvent, LifecycleEventType } from "./events.js";
import { buildFromModule, isTimeout, methodsMissing, withTimeout } from "./load.js";
import type { HookContext, LifecycleHook } from "./types.js";
import { webhookHook } from "./webhook.js";

/**
 * How many events may wait for one hook. Past it, new events for that hook are dropped and logged.
 *
 * @example
 * ```ts
 * MAX_QUEUED_EVENTS; // 1000
 * ```
 */
export const MAX_QUEUED_EVENTS = 1_000;

/**
 * Where a list of hooks comes from, and what its hooks are built with.
 *
 * @example
 * ```ts
 * const scope: HookScope = { file: "pathways.yaml", channel: undefined, dir: root, env: process.env, logger };
 * ```
 */
export interface HookScope {
  /** The YAML file that lists the hooks, for errors and logs: `pathways.yaml` or a channel's. */
  readonly file: string;
  /** The channel, for a channel's own hooks; `undefined` for the engine-wide ones. */
  readonly channel: string | undefined;
  /** The folder that file is in. */
  readonly dir: string;
  readonly env: Env;
  readonly logger: Logger;
}

interface RunnerOptions {
  /** The file and key that name the hook, such as `pathways.yaml: hooks.0`. */
  readonly where: string;
  readonly timeoutMs: number;
  readonly events: ReadonlySet<LifecycleEventType> | undefined;
  readonly logger: Logger;
}

/**
 * Feeds one hook its events, one at a time and in order, without ever holding up the caller:
 * `emit` only queues. Each call gets the hook's time limit; a call that throws or runs past it is
 * logged by error name and code, and the next event goes ahead.
 */
class HookRunner {
  private readonly hook: LifecycleHook;
  private readonly options: RunnerOptions;
  private readonly queue: LifecycleEvent[] = [];
  private draining: Promise<void> | undefined;
  private stopped = false;

  constructor(hook: LifecycleHook, options: RunnerOptions) {
    this.hook = hook;
    this.options = options;
  }

  emit(event: LifecycleEvent): void {
    const { events, logger, where } = this.options;
    if (this.stopped || (events !== undefined && !events.has(event.type))) return;
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      logger.warn({
        event: "hook-dropped",
        hook: where,
        on: event.type,
        channel: event.channel,
        queued: this.queue.length,
      });
      return;
    }
    this.queue.push(event);
    this.draining ??= this.drain();
  }

  /**
   * Gives the hook up to its time limit to work through what is queued, drops (and logs) what is
   * left, then calls its `stop` under the same limit.
   */
  async stop(): Promise<void> {
    const { logger, timeoutMs, where } = this.options;
    if (this.draining !== undefined) {
      const grace = new AbortController();
      await Promise.race([
        this.draining,
        sleep(timeoutMs, undefined, { signal: grace.signal }).catch(() => undefined),
      ]);
      grace.abort();
    }
    this.stopped = true;
    const left = this.queue.splice(0).length;
    if (left > 0) logger.warn({ event: "hook-dropped", hook: where, count: left, stopping: true });
    const { hook } = this;
    if (hook.stop === undefined) return;
    try {
      await withTimeout(() => hook.stop?.(), timeoutMs);
    } catch (error) {
      logger.warn({ event: "hook-stop-failed", hook: where, ...describeError(error) });
    }
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
      await this.call(next);
    }
    this.draining = undefined;
  }

  private async call(event: LifecycleEvent): Promise<void> {
    const { logger, timeoutMs, where } = this.options;
    const { hook } = this;
    try {
      await withTimeout((signal) => hook.onEvent(event, signal), timeoutMs);
    } catch (error) {
      const fields = { hook: where, on: event.type, channel: event.channel };
      if (isTimeout(error)) logger.warn({ event: "hook-timeout", ...fields, timeoutMs });
      else logger.warn({ event: "hook-failed", ...fields, ...describeError(error) });
    }
  }
}

/**
 * The hooks of one scope (the engine, or one channel), fed the same events. Emitting never waits
 * and never throws: each hook has its own queue, time limit and failure handling.
 *
 * This is the seam for any other source of events: whatever holds a `HookSet` (the engine holds the
 * engine-wide one) can `emit` to it. The audit log's entries go through here as `audit` events: the
 * engine forwards its own, and each operator command that writes to the log opens the engine-wide
 * hooks and forwards its entries the same way.
 *
 * @example
 * ```ts
 * const hooks = await HookSet.open(project.hooks, { file: "pathways.yaml", channel: undefined, dir, env, logger });
 * hooks.emit({ type: "source-up", at: new Date().toISOString(), channel: "adt" });
 * await hooks.stop();
 * ```
 */
export class HookSet {
  private readonly runners: readonly HookRunner[];

  /** @param runners One runner per hook. */
  private constructor(runners: readonly HookRunner[]) {
    this.runners = runners;
  }

  /**
   * Builds each hook a list names, in order. A webhook's secrets and TLS files are read now. If one
   * cannot be built, those built before it are stopped.
   *
   * @throws {ExtensionLoadError} when a hook module, its factory or what it returns is wrong.
   * @throws {ConfigError} when a webhook's header variable or TLS file cannot be had.
   */
  static async open(configs: readonly HookConfig[], scope: HookScope): Promise<HookSet> {
    const runners: HookRunner[] = [];
    try {
      for (const [index, config] of configs.entries()) {
        const where = `${scope.file}: hooks.${index}`;
        const hook = await buildHook(config, scope, where);
        runners.push(
          new HookRunner(hook, {
            where,
            timeoutMs: config.timeoutMs,
            events: config.events === undefined ? undefined : new Set(config.events),
            logger: scope.logger,
          }),
        );
      }
    } catch (error) {
      await new HookSet(runners).stop();
      throw error;
    }
    return new HookSet(runners);
  }

  /** True when the set holds no hooks, so an event for it need not be built. */
  get empty(): boolean {
    return this.runners.length === 0;
  }

  /** Queues `event` for every hook that takes it. Never waits, never throws. */
  emit(event: LifecycleEvent): void {
    if (this.runners.length === 0) return;
    // Every hook sees the same object, so none can change what the next one sees.
    const frozen = Object.freeze(event);
    for (const runner of this.runners) runner.emit(frozen);
  }

  /** Lets each hook finish what is queued, within its time limit, then stops it. */
  async stop(): Promise<void> {
    await Promise.all(this.runners.map((runner) => runner.stop()));
  }
}

async function buildHook(
  config: HookConfig,
  scope: HookScope,
  where: string,
): Promise<LifecycleHook> {
  const { channel, dir, env } = scope;
  const logger = scope.logger.child({ hook: where });
  if (config.kind === "webhook") {
    if (config.webhook.plaintext) {
      logger.warn({
        event: "plaintext",
        endpoint: "hook",
        ...(channel === undefined ? {} : { channel }),
      });
    }
    return webhookHook(config.webhook, { timeoutMs: config.timeoutMs, env, where });
  }
  const context: HookContext = { dir, env, logger, channel };
  return buildFromModule<LifecycleHook>(
    config.module,
    where,
    "a hook factory",
    config.options,
    context,
    (value) => methodsMissing(value, "a lifecycle hook", ["onEvent"], ["stop"]),
  );
}

/** An error's name and code, for a log line: never its text. */
function describeError(error: unknown): { name: string; code: string | undefined } {
  const code = (error as { code?: unknown } | undefined)?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : undefined,
  };
}
