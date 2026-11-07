// The transform worker: one per channel, in its own thread, so a stuck or runaway transform can be
// stopped without stopping the engine.
//
// SELF-CONTAINED ON PURPOSE. The engine starts this file as a worker: from `dist/` when installed,
// and straight from `src/` under the tests, where Node runs it through its own type stripping. So it
// imports only Node built-ins and packages, never a relative module, and uses only syntax that type
// stripping can erase (no enums, no namespaces, no parameter properties).
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

import { Hl7Message, parseHL7 } from "@cosyte/hl7";

/** The formats this worker can parse. Kept equal to `FORMATS` in the config schema by a test. */
export type WorkerFormat = "hl7v2" | "text";

/** A user's transform, as loaded from its module's default export. */
export type TransformFunction = (message: unknown) => unknown;

/** What stage a failure happened in. */
export type FailureKind =
  | "load"
  | "parse"
  | "transform"
  | "output"
  | "timeout"
  | "memory"
  | "crash";

/**
 * A failure, described without the message's content: an error name, a stable code where there is
 * one, and where in the transform it was thrown. `detail` is the error's own text, which can quote
 * message content, so callers store it and never print or log it.
 */
export interface FailureSummary {
  readonly kind: FailureKind;
  readonly name: string;
  readonly code?: string;
  readonly where?: string;
  readonly detail: string;
}

/** The engine's request: transform one message. */
export interface TransformRequest {
  readonly id: number;
  readonly body: Uint8Array;
}

/** The worker's reply to one request. */
export type TransformReply =
  | { readonly id: number; readonly ok: true; readonly outputs: readonly Uint8Array[] }
  | { readonly id: number; readonly ok: false; readonly failure: FailureSummary };

/** The worker's first message: ready, or the transform could not be loaded. */
export type WorkerHello =
  | { readonly hello: "ready" }
  | { readonly hello: "load-failed"; readonly failure: FailureSummary };

/** What the engine hands a new worker. */
export interface WorkerSetup {
  /** Always true: marks a thread the engine started, as opposed to a test runner's own thread. */
  readonly pathwaysWorker: true;
  readonly transformFile: string | undefined;
  readonly format: WorkerFormat;
}

function isWorkerSetup(data: unknown): data is WorkerSetup {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { pathwaysWorker?: unknown }).pathwaysWorker === true
  );
}

class StageError extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind, cause: unknown) {
    super("stage failed", { cause });
    this.kind = kind;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Parses a stored body into what the transform receives for `format`.
 *
 * @example
 * ```ts
 * const message = decode("hl7v2", body); // an Hl7Message
 * ```
 */
export function decode(format: WorkerFormat, body: Uint8Array): unknown {
  if (format === "text") return decoder.decode(body);
  return parseHL7(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
}

/**
 * Serializes one transform output back to bytes.
 *
 * @example
 * ```ts
 * const bytes = encode(message); // message.toString(), as UTF-8
 * ```
 */
export function encode(output: unknown): Uint8Array {
  if (typeof output === "string") return encoder.encode(output);
  if (output instanceof Hl7Message) return encoder.encode(output.toString());
  throw new TypeError("the transform returned something that is neither a message nor a string");
}

/**
 * Runs one message through `transform`: parse, call, serialize. `null` or `undefined` filters the
 * message out; an array sends several.
 *
 * @example
 * ```ts
 * const outputs = await runTransform((msg) => msg, "text", new TextEncoder().encode("hello"));
 * ```
 */
export async function runTransform(
  transform: TransformFunction,
  format: WorkerFormat,
  body: Uint8Array,
): Promise<Uint8Array[]> {
  let message: unknown;
  try {
    message = decode(format, body);
  } catch (error) {
    throw new StageError("parse", error);
  }
  let result: unknown;
  try {
    result = await transform(message);
  } catch (error) {
    throw new StageError("transform", error);
  }
  if (result === null || result === undefined) return [];
  const outputs: unknown[] = Array.isArray(result) ? result : [result];
  try {
    return outputs.map(encode);
  } catch (error) {
    throw new StageError("output", error);
  }
}

/**
 * Loads the transform module's default export, or the identity function when there is none.
 *
 * @example
 * ```ts
 * const transform = await loadTransform("/project/channels/adt-to-lab/transform.ts");
 * ```
 */
export async function loadTransform(transformFile: string | undefined): Promise<TransformFunction> {
  if (transformFile === undefined) return (message) => message;
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(transformFile).href)) as { default?: unknown };
  } catch (error) {
    throw new StageError("load", error);
  }
  if (typeof module.default !== "function") {
    throw new StageError(
      "load",
      new TypeError("the transform module has no default export function"),
    );
  }
  return module.default as TransformFunction;
}

/**
 * Describes a failure by name, code and location, keeping the error's text in `detail` only.
 *
 * @example
 * ```ts
 * summarize(new TypeError("..."), "/project/channels/adt-to-lab/transform.ts").name; // "TypeError"
 * ```
 */
export function summarize(error: unknown, transformFile?: string): FailureSummary {
  const kind = error instanceof StageError ? error.kind : "transform";
  const cause = error instanceof StageError ? error.cause : error;
  const name = cause instanceof Error ? cause.name : typeof cause;
  const rawCode = cause instanceof Error ? (cause as Error & { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  const detail = cause instanceof Error ? cause.message : String(cause);
  const where = transformFile === undefined ? undefined : locate(cause, transformFile);
  return {
    kind,
    name,
    detail,
    ...(code === undefined ? {} : { code }),
    ...(where === undefined ? {} : { where }),
  };
}

/** `file:line:column` of the first stack frame inside the transform module, if there is one. */
function locate(error: unknown, transformFile: string): string | undefined {
  if (!(error instanceof Error) || error.stack === undefined) return undefined;
  const href = pathToFileURL(transformFile).href;
  for (const line of error.stack.split("\n")) {
    const match = /\(?((?:file:\/\/)?[^\s()]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (match === null) continue;
    const [, file, row, column] = match;
    if (file === href || file === transformFile) {
      const name = transformFile.split(/[\\/]/).pop() ?? transformFile;
      return `${name}:${row}:${column}`;
    }
  }
  return undefined;
}

/* v8 ignore start: runs only inside a worker thread, which the coverage of the test process does not
   reach. The functions above carry the logic and are tested directly. */
// No top-level await: the shared build also emits this entry as CommonJS.
if (!isMainThread && parentPort !== null && isWorkerSetup(workerData)) {
  const port = parentPort;
  const setup = workerData;
  loadTransform(setup.transformFile).then(
    (transform) => {
      port.on("message", (request: TransformRequest) => {
        runTransform(transform, setup.format, request.body).then(
          (outputs) =>
            port.postMessage({ id: request.id, ok: true, outputs } satisfies TransformReply),
          (error: unknown) =>
            port.postMessage({
              id: request.id,
              ok: false,
              failure: summarize(error, setup.transformFile),
            } satisfies TransformReply),
        );
      });
      port.postMessage({ hello: "ready" } satisfies WorkerHello);
    },
    (error: unknown) => {
      port.postMessage({
        hello: "load-failed",
        failure: summarize(error, setup.transformFile),
      } satisfies WorkerHello);
    },
  );
}
/* v8 ignore stop */
