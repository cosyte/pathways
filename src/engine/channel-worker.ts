import { Worker } from "node:worker_threads";

import type { Logger } from "pino";

import { ownsBuffer } from "../storage/ownership.js";
import type {
  CsvSettings,
  FailureSummary,
  MessageContext,
  ScriptLogMessage,
  StopReply,
  StopRequest,
  TransformReply,
  TransformRequest,
  WorkerFormat,
  WorkerHello,
  WorkerSetup,
} from "./worker-entry.js";

/** The result of one message's transform. */
export type TransformOutcome =
  | { readonly ok: true; readonly outputs: readonly Uint8Array[] }
  | { readonly ok: false; readonly failure: FailureSummary };

/**
 * A channel's transform could not be loaded, so the channel cannot run.
 *
 * @example
 * ```ts
 * try {
 *   await worker.start();
 * } catch (error) {
 *   if (error instanceof TransformLoadError) console.error(error.channel, error.failure.name);
 * }
 * ```
 */
export class TransformLoadError extends Error {
  readonly channel: string;
  readonly failure: FailureSummary;

  /**
   * @param channel The channel whose transform failed to load.
   * @param failure What went wrong, without message content.
   */
  constructor(channel: string, failure: FailureSummary) {
    super(`the transform of channel ${channel} could not be loaded (${failure.name})`);
    this.name = "TransformLoadError";
    this.channel = channel;
    this.failure = failure;
  }
}

/**
 * Where the worker's entry file is. Built, it sits beside the bundled CLI as `pathways-worker.mjs`;
 * under the tests, this module is TypeScript and the entry is its `.ts` sibling, which Node runs
 * through its own type stripping.
 *
 * @example
 * ```ts
 * defaultWorkerUrl("file:///app/dist/bin/pathways.mjs").href; // ".../dist/bin/pathways-worker.mjs"
 * ```
 */
export function defaultWorkerUrl(moduleUrl: string = import.meta.url): URL {
  return moduleUrl.endsWith(".ts")
    ? new URL("./worker-entry.ts", moduleUrl)
    : new URL("./pathways-worker.mjs", moduleUrl);
}

/** What a channel's worker needs. */
export interface ChannelWorkerOptions {
  readonly channel: string;
  readonly transformFile: string | undefined;
  readonly format: WorkerFormat;
  readonly timeoutMs: number;
  readonly memoryMb: number;
  /**
   * The channel's configuration, resolved already: plain JSON values, which each message's context
   * holds as `config`. Defaults to none.
   */
  readonly config?: Readonly<Record<string, unknown>>;
  /** A `csv` channel's `csv:` block, as validated: how its bodies are read and written. */
  readonly csv?: CsvSettings | undefined;
  /**
   * How long the module's `onStart` may run on each spawn, and its `onStop` when the worker stops,
   * in milliseconds. Defaults to `timeoutMs`.
   */
  readonly scriptTimeoutMs?: number | undefined;
  /**
   * Where the lines `onStart`'s logger writes go, with the channel's name, and where an `onStop`
   * that failed or ran past its limit is noted. Without it they are dropped.
   */
  readonly logger?: Logger | undefined;
  readonly workerUrl?: URL;
}

/**
 * The context of a message that is not stored, as the worker's `UNSTORED` holds it: kept here too,
 * so this module loads nothing of the worker's at run time.
 */
const UNSTORED: MessageContext = { messageId: 0, attempt: 1, source: undefined, meta: {} };

/** How {@link ChannelWorker.run} runs one message. */
export interface RunOptions {
  /**
   * Moves a body over the whole of its own buffer to the worker instead of copying it; it reads as
   * empty here once sent. Pass it only for a body nothing else holds.
   */
  readonly transfer?: boolean;
  /**
   * What the message's context is built from: its id, run, source facts and per-message map, plain
   * data the worker copies. Defaults to that of a message that is not stored.
   */
  readonly context?: MessageContext;
}

/**
 * One channel's transform worker. Messages run one at a time, in the order given. A message that
 * runs past the timeout, or a worker that runs out of memory or crashes, fails that message only:
 * the worker is replaced and the next message runs in a fresh one.
 *
 * @example
 * ```ts
 * const worker = new ChannelWorker({ channel: "adt-to-lab", transformFile, format: "hl7v2", timeoutMs: 5_000, memoryMb: 256 });
 * await worker.start();
 * const outcome = await worker.run(body);
 * await worker.stop();
 * ```
 */
export class ChannelWorker {
  private readonly options: ChannelWorkerOptions;
  private worker: Worker | undefined;
  /** Set while a worker is being spawned: its module loading and its `onStart` running. */
  private starting: Promise<Worker> | undefined;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  /** @param options The channel, its transform and format, and the worker's limits. */
  constructor(options: ChannelWorkerOptions) {
    this.options = options;
  }

  /**
   * Starts the worker, loads the transform and runs its `onStart`, when it has one. Rejects with
   * {@link TransformLoadError}, also when `onStart` throws or runs past its limit. Each new worker
   * runs `onStart` again, a replacement after a timeout or a crash among them.
   */
  async start(): Promise<void> {
    if (this.worker !== undefined) return;
    const starting = (this.starting ??= this.spawn());
    try {
      const worker = await starting;
      if (this.starting === starting) this.worker = worker;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  /** How long `onStart` and `onStop` may run, in milliseconds. */
  private get scriptTimeoutMs(): number {
    return this.options.scriptTimeoutMs ?? this.options.timeoutMs;
  }

  /**
   * Transforms one message, with its context. Calls are queued, so outputs come back in the order
   * messages went in. With `transfer`, a body over the whole of its own buffer moves to the worker
   * instead of being copied, and reads as empty here once sent: pass it only for a body nothing
   * else holds.
   */
  run(body: Uint8Array, options: RunOptions = {}): Promise<TransformOutcome> {
    const transfer = options.transfer === true;
    const context = options.context ?? UNSTORED;
    const result = this.queue.then(() => this.runOne(body, transfer, context));
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Waits for queued messages and for a start under way (its `onStart` is cut at its limit), then
   * runs the module's `onStop`, when it has one, cut at its limit too, and ends the worker.
   */
  async stop(): Promise<void> {
    await this.queue;
    const starting = this.starting;
    const started = starting === undefined ? undefined : await starting.catch(() => undefined);
    if (this.starting === starting) this.starting = undefined;
    const worker = this.worker ?? started;
    this.worker = undefined;
    if (worker === undefined) return;
    await this.runOnStop(worker);
    await worker.terminate();
  }

  /** Asks the worker to run `onStop`, and waits for it up to the limit; notes a failure or a cut. */
  private runOnStop(worker: Worker): Promise<void> {
    const { channel, logger } = this.options;
    const limitMs = this.scriptTimeoutMs;
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        worker.off("message", onReply);
        worker.off("error", finish);
        worker.off("exit", finish);
        resolve();
      };
      const onReply = (reply: unknown): void => {
        if (!isStopReply(reply)) return;
        if (reply.failure !== undefined) {
          const { name, code, where } = reply.failure;
          logger?.warn({ event: "on-stop-failed", channel, name, code, where });
        }
        finish();
      };
      const timer = setTimeout(() => {
        logger?.warn({ event: "on-stop-timeout", channel, limitMs });
        finish();
      }, limitMs);
      worker.on("message", onReply);
      worker.on("error", finish);
      worker.on("exit", finish);
      worker.postMessage({ stop: true } satisfies StopRequest);
    });
  }

  private spawn(): Promise<Worker> {
    const { channel, transformFile, format, memoryMb, logger } = this.options;
    const setup: WorkerSetup = {
      pathwaysWorker: true,
      transformFile,
      format,
      config: this.options.config ?? {},
      channel,
      ...(this.options.csv === undefined ? {} : { formatSettings: { csv: this.options.csv } }),
    };
    const worker = new Worker(this.options.workerUrl ?? defaultWorkerUrl(), {
      workerData: setup,
      resourceLimits: { maxOldGenerationSizeMb: memoryMb },
      // The worker runs a file, so it takes none of this process's flags: a flag meant for the
      // parent (a test runner's, an `--input-type`) can stop a worker from starting at all.
      execArgv: [],
    });
    // A worker that dies between messages must not take the engine with it: an `error` event with no
    // listener would. Forget it, and the next message starts a fresh one.
    const forget = (): void => {
      if (this.worker === worker) this.worker = undefined;
    };
    worker.on("error", forget);
    worker.on("exit", forget);
    // What onStart (or anything else in the worker) logs: a code and numbers, checked again here.
    worker.on("message", (message: unknown) => {
      if (!isScriptLog(message)) return;
      const { level, code, ids } = message.scriptLog;
      logger?.[level]({ event: "channel-script", channel, code, ids: safeIds(ids) });
    });

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(timer);
        worker.off("message", onHello);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const onHello = (hello: unknown): void => {
        if (!isHello(hello)) return;
        if (hello.hello === "starting") {
          // onStart runs from here, and is cut at its limit: the worker is ended, as for a load
          // that failed.
          const limitMs = this.scriptTimeoutMs;
          timer = setTimeout(() => {
            done();
            void worker.terminate();
            reject(
              new TransformLoadError(channel, {
                kind: "timeout",
                name: "Timeout",
                code: "ON_START_TIMEOUT",
                detail: `onStart ran longer than ${limitMs} ms`,
              }),
            );
          }, limitMs);
          return;
        }
        done();
        if (hello.hello === "ready") {
          resolve(worker);
        } else {
          void worker.terminate();
          reject(new TransformLoadError(channel, hello.failure));
        }
      };
      const onError = (error: Error): void => {
        done();
        reject(new TransformLoadError(channel, describeWorkerError(error, "load")));
      };
      const onExit = (code: number): void => {
        done();
        reject(new TransformLoadError(channel, exited(code)));
      };
      worker.on("message", onHello);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });
  }

  private async runOne(
    body: Uint8Array,
    transfer: boolean,
    context: MessageContext,
  ): Promise<TransformOutcome> {
    await this.start();
    const worker = this.worker;
    /* v8 ignore next: start() either sets the worker or throws */
    if (worker === undefined) throw new Error("the transform worker did not start");
    const id = this.nextId++;
    const { timeoutMs } = this.options;

    return new Promise((resolve) => {
      const finish = (outcome: TransformOutcome, replace: boolean): void => {
        clearTimeout(timer);
        worker.off("message", onReply);
        worker.off("error", onError);
        worker.off("exit", onExit);
        if (replace) {
          if (this.worker === worker) this.worker = undefined;
          void worker.terminate();
        }
        resolve(outcome);
      };
      const onReply = (reply: unknown): void => {
        // The transform runs in this worker and can post its own messages through parentPort. Only
        // a reply that carries this message's id settles it; anything else is ignored.
        if (!isReplyTo(reply, id)) return;
        finish(
          reply.ok ? { ok: true, outputs: reply.outputs } : { ok: false, failure: reply.failure },
          false,
        );
      };
      const onError = (error: Error): void => {
        finish({ ok: false, failure: describeWorkerError(error, "crash") }, true);
      };
      const onExit = (code: number): void => {
        finish({ ok: false, failure: exited(code) }, true);
      };
      const timer = setTimeout(() => {
        finish(
          {
            ok: false,
            failure: {
              kind: "timeout",
              name: "Timeout",
              detail: `the transform ran longer than ${timeoutMs} ms`,
            },
          },
          true,
        );
      }, timeoutMs);
      worker.on("message", onReply);
      worker.on("error", onError);
      worker.on("exit", onExit);
      const { messageId, attempt, source, meta } = context;
      worker.postMessage(
        { id, body, messageId, attempt, source, meta } satisfies TransformRequest,
        transfer && ownsBuffer(body) ? [body.buffer as ArrayBuffer] : [],
      );
    });
  }
}

/** Whether a message from the worker is one of its first: starting, ready or load-failed. */
function isHello(message: unknown): message is WorkerHello {
  const hello = (message as { hello?: unknown } | null)?.hello;
  return hello === "starting" || hello === "ready" || hello === "load-failed";
}

/** Whether a message from the worker is the reply to a stop request. */
function isStopReply(message: unknown): message is StopReply {
  return (message as { stopped?: unknown } | null)?.stopped === true;
}

/** Whether a message from the worker is a line a script logged. */
function isScriptLog(message: unknown): message is ScriptLogMessage {
  const line = (message as { scriptLog?: unknown } | null)?.scriptLog as
    { level?: unknown; code?: unknown; ids?: unknown } | undefined;
  return (
    typeof line === "object" &&
    line !== null &&
    (line.level === "info" || line.level === "warn" || line.level === "error") &&
    typeof line.code === "string" &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(line.code) &&
    line.code.length <= 64
  );
}

/**
 * A script log line's ids, checked again on this side: the transform runs in the worker and can post
 * its own messages, so only finite numbers under plain names, at most 16, reach the log.
 */
function safeIds(ids: unknown): Record<string, number> {
  const kept: Record<string, number> = {};
  if (typeof ids !== "object" || ids === null) return kept;
  for (const [name, value] of Object.entries(ids)) {
    if (Object.keys(kept).length >= 16) break;
    if (name.length > 64 || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) continue;
    if (typeof value === "number" && Number.isFinite(value)) kept[name] = value;
  }
  return kept;
}

/** Whether a message from the worker is the reply to request `id`. */
function isReplyTo(message: unknown, id: number): message is TransformReply {
  return typeof message === "object" && message !== null && (message as { id?: unknown }).id === id;
}

function describeWorkerError(error: Error, kind: "load" | "crash"): FailureSummary {
  const code = (error as Error & { code?: unknown }).code;
  const memory = code === "ERR_WORKER_OUT_OF_MEMORY";
  return {
    kind: memory ? "memory" : kind,
    name: error.name,
    detail: error.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}

function exited(code: number): FailureSummary {
  return {
    kind: "crash",
    name: "WorkerExit",
    detail: `the transform worker exited with code ${code}`,
  };
}
