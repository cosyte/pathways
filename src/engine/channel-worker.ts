import { Worker } from "node:worker_threads";

import type { ChannelConfig } from "../config/schema.js";
import { ownsBuffer } from "../storage/ownership.js";
import type {
  CsvSettings,
  DestinationReply,
  DestinationSetup,
  FailureSummary,
  MessageContext,
  TransformReply,
  TransformRequest,
  WorkerFormat,
  WorkerHello,
  WorkerSetup,
} from "./worker-entry.js";

/**
 * What one destination's transform gave for one message: its outputs, none when it filtered the
 * message for that destination, or why it failed, which fails that destination's delivery only.
 *
 * @example
 * ```ts
 * const filtered = (result: DestinationResult): boolean => result.ok && result.outputs.length === 0;
 * ```
 */
export type DestinationResult = DestinationReply;

/**
 * The result of one message's transform. `destinations` is set on a channel with destination
 * transforms: one result per destination, in order, a destination without a transform holding the
 * channel's `outputs`.
 */
export type TransformOutcome =
  | {
      readonly ok: true;
      readonly outputs: readonly Uint8Array[];
      readonly destinations?: readonly DestinationResult[];
    }
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
  /** The destination whose transform failed to load, by index and `name:`; absent for the channel's. */
  readonly destination: { readonly index: number; readonly name: string | undefined } | undefined;

  /**
   * @param channel The channel whose transform failed to load.
   * @param failure What went wrong, without message content.
   * @param destination The destination whose own transform it was, if it was one.
   */
  constructor(
    channel: string,
    failure: FailureSummary,
    destination?: { readonly index: number; readonly name: string | undefined },
  ) {
    super(
      destination === undefined
        ? `the transform of channel ${channel} could not be loaded (${failure.name})`
        : `the transform of destination ${destinationLabel(destination)} of channel ${channel} could not be loaded (${failure.name})`,
    );
    this.name = "TransformLoadError";
    this.channel = channel;
    this.failure = failure;
    this.destination = destination;
  }
}

/**
 * How a destination is named in a message: its `name:`, else its place in the list from 1.
 *
 * @example
 * ```ts
 * destinationLabel({ index: 1, name: undefined }); // "2"
 * destinationLabel({ index: 0, name: "lab" }); // "lab"
 * ```
 */
export function destinationLabel(destination: {
  readonly index: number;
  readonly name: string | undefined;
}): string {
  return destination.name ?? String(destination.index + 1);
}

/**
 * The destinations a channel's worker runs transforms for, or `undefined` when none of them has a
 * transform, so a channel without destination transforms runs as it always has.
 *
 * @example
 * ```ts
 * new ChannelWorker({ ...options, destinations: destinationSetups(channel) });
 * ```
 */
export function destinationSetups(
  channel: Pick<ChannelConfig, "format" | "destinations">,
): DestinationSetup[] | undefined {
  if (!channel.destinations.some((destination) => destination.transform !== undefined)) {
    return undefined;
  }
  return channel.destinations.map((destination, index) => ({
    index,
    name: destination.name,
    kind: destination.kind,
    format: destination.format ?? channel.format,
    transformFile: destination.transform,
  }));
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
  /**
   * The channel's destinations, given when one of them has a transform: each runs after the
   * channel's transform, in the same request, under the same timeout and memory cap. Leave it out
   * when none has one.
   */
  readonly destinations?: readonly DestinationSetup[] | undefined;
  /** A `csv` channel's `csv:` block, as validated: how its bodies are read and written. */
  readonly csv?: CsvSettings | undefined;
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
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  /** @param options The channel, its transform and format, and the worker's limits. */
  constructor(options: ChannelWorkerOptions) {
    this.options = options;
  }

  /** Starts the worker and loads the transform. Rejects with {@link TransformLoadError}. */
  async start(): Promise<void> {
    this.worker ??= await this.spawn();
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

  /** Waits for queued messages, then stops the worker. */
  async stop(): Promise<void> {
    await this.queue;
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) await worker.terminate();
  }

  private spawn(): Promise<Worker> {
    const { channel, transformFile, format, memoryMb } = this.options;
    const setup: WorkerSetup = {
      pathwaysWorker: true,
      transformFile,
      format,
      config: this.options.config ?? {},
      ...(this.options.destinations === undefined
        ? {}
        : { destinations: this.options.destinations }),
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

    return new Promise((resolve, reject) => {
      const done = (): void => {
        worker.off("message", onHello);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const onHello = (hello: WorkerHello): void => {
        done();
        if (hello.hello === "ready") {
          resolve(worker);
        } else {
          void worker.terminate();
          const destination =
            hello.destination === undefined
              ? undefined
              : this.options.destinations?.[hello.destination];
          reject(
            new TransformLoadError(
              channel,
              hello.failure,
              destination === undefined
                ? undefined
                : { index: destination.index, name: destination.name },
            ),
          );
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
        finish(reply.ok ? success(reply) : { ok: false, failure: reply.failure }, false);
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

/**
 * A successful reply as an outcome: a destination without a transform (`null`) holds the channel's
 * outputs.
 */
function success(reply: Extract<TransformReply, { ok: true }>): TransformOutcome {
  const { outputs, destinations } = reply;
  if (destinations === undefined) return { ok: true, outputs };
  return {
    ok: true,
    outputs,
    destinations: destinations.map((result) => result ?? { ok: true, outputs }),
  };
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
