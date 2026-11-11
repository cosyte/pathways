import { realpathSync } from "node:fs";
import { basename, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Loads a user's extension module in the engine's own thread, as the worker loads a transform: a
// plain `import()`, so Node's own type stripping reads TypeScript and nothing is compiled. Each check
// fails with an ExtensionLoadError that names the YAML file and key, and describes what went wrong by
// error name, code and location only: an error's own text never reaches a log or the terminal.

/**
 * An extension module could not be loaded or built: a module that will not import, a default export
 * that is missing or not a function, a factory that throws, or one that returns the wrong shape.
 * `where` names the YAML file and key; `problem` says what is wrong in fixed text, with an error's
 * name, code and location at most.
 *
 * @example
 * ```ts
 * try {
 *   await engine.start();
 * } catch (error) {
 *   if (error instanceof ExtensionLoadError) console.error(error.message);
 * }
 * ```
 */
export class ExtensionLoadError extends Error {
  /** The YAML file and key that name the module, such as `channels/adt/channel.yaml: source.module`. */
  readonly where: string;
  /** What is wrong, in fixed text. */
  readonly problem: string;

  /**
   * @param where The YAML file and key that name the module.
   * @param problem What is wrong, in fixed text.
   */
  constructor(where: string, problem: string) {
    super(`${where}: ${problem}`);
    this.name = "ExtensionLoadError";
    this.where = where;
    this.problem = problem;
  }
}

/**
 * Imports `file` and returns its default export, which must be a function. `what` names the export
 * a reader should write, such as `a source factory`.
 *
 * @throws {ExtensionLoadError} when the module will not import or has no default export function.
 * @example
 * ```ts
 * const factory = await loadDefaultFunction(file, "channels/adt/channel.yaml: source.module", "a source factory");
 * ```
 */
export async function loadDefaultFunction(
  file: string,
  where: string,
  what: string,
): Promise<(...args: readonly unknown[]) => unknown> {
  let module: { readonly default?: unknown };
  try {
    module = (await import(pathToFileURL(file).href)) as { readonly default?: unknown };
  } catch (error) {
    throw new ExtensionLoadError(
      where,
      `the module could not be loaded (${describe(error, file)})`,
    );
  }
  if (module.default === undefined) {
    throw new ExtensionLoadError(where, `the module has no default export; export default ${what}`);
  }
  if (typeof module.default !== "function") {
    throw new ExtensionLoadError(
      where,
      `the module's default export is a ${describeType(module.default)}, not a function; export default ${what}`,
    );
  }
  return module.default as (...args: readonly unknown[]) => unknown;
}

/**
 * Loads a factory from `file`, calls it with `options` and `context`, and checks what it returns
 * with `check`, which answers with what is missing, or `undefined` when the value fits.
 *
 * @throws {ExtensionLoadError} when the module will not load, the factory throws, or `check` refuses
 *   what it returned.
 * @example
 * ```ts
 * const source = await buildFromModule<SourceConnector>(file, where, "a source factory", options, context, checkSource);
 * ```
 */
export async function buildFromModule<T>(
  file: string,
  where: string,
  what: string,
  options: unknown,
  context: unknown,
  check: (value: unknown) => string | undefined,
): Promise<T> {
  const factory = await loadDefaultFunction(file, where, what);
  let built: unknown;
  try {
    built = await factory(options, context);
  } catch (error) {
    throw new ExtensionLoadError(where, `the factory threw (${describe(error, file)})`);
  }
  const missing = check(built);
  if (missing !== undefined) {
    throw new ExtensionLoadError(where, `the factory did not return ${missing}`);
  }
  return built as T;
}

/**
 * Checks for an object whose `required` keys are functions, as are those of `optional` it has.
 * Answers with what is wrong, for an {@link ExtensionLoadError}, or `undefined` when it fits.
 *
 * @example
 * ```ts
 * methodsMissing(value, "a destination connector", ["deliver"], ["stop"]);
 * ```
 */
export function methodsMissing(
  value: unknown,
  what: string,
  required: readonly string[],
  optional: readonly string[] = [],
): string | undefined {
  if (typeof value !== "object" || value === null) {
    return `${what}: it returned a ${describeType(value)}`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const absent = required.filter((key) => typeof record[key] !== "function");
  const wrong = optional.filter(
    (key) => record[key] !== undefined && typeof record[key] !== "function",
  );
  const bad = [...absent, ...wrong];
  if (bad.length === 0) return undefined;
  return `${what}: ${bad.join(", ")} must be ${bad.length === 1 ? "a method" : "methods"}`;
}

/**
 * Runs `work` with a time limit. Past `timeoutMs`, the signal handed to `work` aborts and the
 * returned promise rejects with a `TimeoutError`; `work` is abandoned, and a late failure of it is
 * dropped. `work` runs in a later microtask, so a synchronous throw rejects too.
 *
 * @example
 * ```ts
 * await withTimeout((signal) => hook.onEvent(event, signal), 5_000);
 * ```
 */
export function withTimeout<T>(
  work: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const running = Promise.resolve().then(() => work(controller.signal));
  running.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([running, expired]).finally(() => clearTimeout(timer));
}

/** The error {@link withTimeout} rejects with: named `TimeoutError`, coded `EXTENSION_TIMEOUT`. */
function timeoutError(timeoutMs: number): Error & { readonly code: string } {
  return Object.assign(new Error(`the call ran longer than ${timeoutMs} ms`), {
    name: "TimeoutError",
    code: "EXTENSION_TIMEOUT",
  });
}

/**
 * Whether `error` is the one {@link withTimeout} rejects with.
 *
 * @example
 * ```ts
 * if (isTimeout(error)) logger.warn({ event: "hook-timeout" });
 * ```
 */
export function isTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === "EXTENSION_TIMEOUT";
}

/** An error's name, its code and where in `file` it was thrown: never its text. */
function describe(error: unknown, file: string): string {
  const name = error instanceof Error ? error.name : describeType(error);
  const code = (error as { code?: unknown } | undefined)?.code;
  const at = locate(error, file);
  return `${name}${typeof code === "string" ? ` ${code}` : ""}${at === undefined ? "" : ` at ${at}`}`;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * `name:line:column` of the first stack frame inside `file`, if there is one. A frame names its file
 * as a path or a file URL, and Node loads a module from its real path, so a frame names that path
 * when the configured one runs through a link (macOS's temporary folder is one). So each frame's file
 * is read as a path, with the system's own separators, and matched against `file` and its real path.
 * The transform worker holds the same rule in `src/engine/worker-entry.ts`, which imports nothing of
 * the package's own.
 */
function locate(error: unknown, file: string): string | undefined {
  if (!(error instanceof Error) || error.stack === undefined) return undefined;
  const names = new Set([normalize(file)]);
  try {
    // Both: the native one also expands a Windows short name (RUNNER~1) that the other keeps.
    names.add(realpathSync(file)).add(realpathSync.native(file));
  } catch {
    // The file is gone since it loaded: the configured path is all there is to match.
  }
  for (const line of error.stack.split("\n")) {
    const match = /\(?((?:file:\/\/)?[^\s()]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (match === null) continue;
    const [, at, row, column] = match;
    if (names.has(framePath(String(at)))) return `${basename(file)}:${row}:${column}`;
  }
  return undefined;
}

/** A stack frame's file as a path with the system's separators: a file URL is turned into one. */
function framePath(file: string): string {
  if (!file.startsWith("file:")) return normalize(file);
  try {
    return fileURLToPath(file);
  } catch {
    // A file URL no path can be made of here, such as one naming another host: matches nothing.
    return file;
  }
}
