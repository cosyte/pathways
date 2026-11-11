import type { Logger } from "pino";

import { ConfigError } from "../config/load.js";
import type { ProjectConfig, SecretReference, SecretSource } from "../config/schema.js";
import { customSecretProvider } from "../extensions/build.js";
import { withTimeout } from "../extensions/load.js";
import {
  readEnvSecret,
  readFileSecret,
  type ResolvedSecret,
  type SecretError,
  type SecretProvider,
  type SecretRef,
} from "./provider.js";
import { secretUses, type DrySkip, type SecretScope } from "./sources.js";

// The one resolver every secret goes through: a token, a header, a connection URL, a master key.
// `{ env: NAME }` and `{ file: path }` are the built-in env and file providers by another spelling,
// read when they are used; a provider a module builds is asked for each of its secrets once, at
// start, before anything reads them. Errors name the file and key, the secret's name and a code,
// never a value, nor a provider's own error text.

/** The environment Pathways reads secrets from: `process.env`, or a stand-in in tests. */
type Env = Readonly<Record<string, string | undefined>>;

/** The built-in providers, which the resolver reads itself. */
function builtIn(provider: string): provider is "env" | "file" {
  return provider === "env" || provider === "file";
}

/**
 * A secret reference, whichever way it was written, as the provider and request it stands for.
 *
 * @example
 * ```ts
 * referenceOf({ env: "LAB_TOKEN" }); // { provider: "env", name: "LAB_TOKEN", field: undefined, version: undefined }
 * ```
 */
export function referenceOf(source: SecretSource): SecretReference {
  if ("env" in source) {
    return { provider: "env", name: source.env, field: undefined, version: undefined };
  }
  if ("file" in source) {
    return { provider: "file", name: source.file, field: undefined, version: undefined };
  }
  return source.secret;
}

/** The same secret, asked for the same way, has the same key. */
function keyOf(reference: SecretReference): string {
  const { provider, name, field, version } = reference;
  return JSON.stringify([provider, name, field ?? null, version ?? null]);
}

/**
 * Where a secret is read from, in the words a problem uses: the variable's name, `its file`, or the
 * secret's name and provider. Never the value.
 *
 * @example
 * ```ts
 * secretHolder({ env: "LAB_TOKEN" }); // "LAB_TOKEN"
 * ```
 */
export function secretHolder(source: SecretSource): string {
  if ("env" in source) return source.env;
  if ("file" in source) return "its file";
  return describeReference(source.secret);
}

/**
 * Where a secret is read from, as the subject of a sentence: `the environment variable NAME`,
 * `its file`, or the secret's name and provider. Never the value.
 *
 * @example
 * ```ts
 * secretPlace({ env: "LAB_TOKEN" }); // "the environment variable LAB_TOKEN"
 * ```
 */
export function secretPlace(source: SecretSource): string {
  return "env" in source ? `the environment variable ${source.env}` : secretHolder(source);
}

function describeReference(reference: SecretReference): string {
  const field = reference.field === undefined ? "" : ` (field ${reference.field})`;
  const version = reference.version === undefined ? "" : ` (version ${reference.version})`;
  return `the secret ${reference.name}${field}${version} from the provider ${reference.provider}`;
}

/**
 * The secrets a start has to hand: the environment and files, read when a secret is used, and the
 * values a provider resolved at start. `read` is the one way a token, a header, a connection URL or
 * a master key is read. Its errors name the file and key, never a value.
 *
 * @example
 * ```ts
 * const secrets = await resolveSecrets(project, { env: process.env, logger }, "all");
 * const token = secrets.read({ env: "LAB_TOKEN" }, "channels/adt/channel.yaml: source.http.auth");
 * ```
 */
export class Secrets {
  readonly #env: Env;
  readonly #resolved: ReadonlyMap<string, string>;

  /**
   * @param env Where `{ env: NAME }` is read.
   * @param resolved Values providers resolved at start, by reference.
   */
  constructor(env: Env, resolved: ReadonlyMap<string, string> = new Map()) {
    this.#env = env;
    this.#resolved = resolved;
  }

  /** The environment `{ env: NAME }` is read from, which extensions are also given. */
  get env(): Env {
    return this.#env;
  }

  /**
   * The value of `source`. `where` names the file and key that wrote it.
   *
   * @throws {ConfigError} naming `where` and the secret, never its value, when it cannot be had.
   */
  read(source: SecretSource, where: string): string {
    const reference = referenceOf(source);
    if (builtIn(reference.provider)) {
      try {
        return readBuiltIn(this.#env, reference).value;
      } catch (error) {
        // The built-in providers' errors are written here, in fixed words and names.
        throw new ConfigError([`${where}: ${(error as SecretError).message}`]);
      }
    }
    const value = this.#resolved.get(keyOf(reference));
    if (value === undefined) {
      throw new ConfigError([
        `${where}: ${describeReference(reference)} was not resolved at start`,
      ]);
    }
    return value;
  }
}

function readBuiltIn(env: Env, reference: SecretReference): ResolvedSecret {
  const ref = requestOf(reference);
  return reference.provider === "env" ? readEnvSecret(env, ref) : readFileSecret(ref);
}

/** What a provider is asked: the reference without its provider's name. */
function requestOf(reference: SecretReference): SecretRef {
  return Object.freeze({
    name: reference.name,
    ...(reference.field === undefined ? {} : { field: reference.field }),
    ...(reference.version === undefined ? {} : { version: reference.version }),
  });
}

/**
 * Where secrets are read: the environment alone, or the {@link Secrets} a start resolved.
 *
 * @example
 * ```ts
 * const reader: SecretReader = process.env;
 * ```
 */
export type SecretReader = Env | Secrets;

/**
 * `reader` as {@link Secrets}: the environment alone becomes a `Secrets` with nothing resolved.
 *
 * @example
 * ```ts
 * secretsOf(process.env).read({ env: "LAB_TOKEN" }, "pathways.yaml: health.auth");
 * ```
 */
export function secretsOf(reader: SecretReader): Secrets {
  return reader instanceof Secrets ? reader : new Secrets(reader);
}

/** One secret to ask a provider for, and the file and key that first named it. */
interface Request {
  readonly reference: SecretReference;
  readonly where: string;
}

/** What {@link resolveSecrets} runs with. */
export interface ResolveContext {
  /** Where `{ env: NAME }` is read, and what a provider's module is given as `context.env`. */
  readonly env: Env;
  readonly logger: Logger;
  /** Cancels the start: each request in flight is aborted. */
  readonly signal?: AbortSignal | undefined;
  /** Epoch milliseconds now, to judge an expiry. Tests pass their own. */
  readonly now?: () => number;
  /**
   * A start's dry destinations, whose secrets are not resolved: `"each"` for those whose block sets
   * `dryRun: true`, `"all"` under `pathways start --dry-run`. Unset, every destination's are.
   */
  readonly skipDry?: DrySkip | undefined;
}

/**
 * Resolves every `{ secret: { provider, name } }` reference `project` holds in `scope` whose
 * provider is a module `pathways.yaml`'s `secrets:` names: builds each provider those references
 * name, asks it for each secret once, then stops it. References to the built-in `env` and `file`
 * providers are read when they are used. Logs one `secrets-resolved` line per provider, with the
 * count.
 *
 * @throws {ConfigError} with one problem per secret that could not be had, each naming the file and
 *   key, the secret and the provider's error by name and code; never a value nor the error's text.
 * @throws {ExtensionLoadError} when a provider's module, factory or result is wrong.
 * @example
 * ```ts
 * const secrets = await resolveSecrets(project, { env: process.env, logger }, "all");
 * ```
 */
export async function resolveSecrets(
  project: ProjectConfig,
  context: ResolveContext,
  scope: SecretScope,
): Promise<Secrets> {
  const wanted = new Map<string, Map<string, Request>>();
  for (const { source, where } of secretUses(project, scope, context.skipDry)) {
    const reference = referenceOf(source);
    if (builtIn(reference.provider)) continue;
    const byKey = wanted.get(reference.provider) ?? new Map<string, Request>();
    if (!byKey.has(keyOf(reference))) byKey.set(keyOf(reference), { reference, where });
    wanted.set(reference.provider, byKey);
  }
  const resolved = new Map<string, string>();
  const problems: string[] = [];
  const now = context.now ?? Date.now;
  for (const config of project.secrets) {
    const requests = wanted.get(config.name);
    if (requests === undefined) continue;
    const logger = context.logger.child({ extension: "secrets", provider: config.name });
    const provider = await customSecretProvider(
      config,
      { dir: project.root, env: context.env, logger },
      `pathways.yaml: secrets.${config.name}.module`,
    );
    let count = 0;
    try {
      for (const [key, { reference, where }] of requests) {
        const problem = await resolveOne(provider, reference, config.timeoutMs, context, now);
        if (typeof problem === "string") problems.push(`${where}: ${problem}`);
        else {
          resolved.set(key, problem.value);
          count += 1;
        }
      }
    } finally {
      await stopProvider(provider, config.timeoutMs, logger);
    }
    logger.info({ event: "secrets-resolved", count });
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return new Secrets(context.env, resolved);
}

/** One secret from `provider`, checked, or the problem that says why it could not be had. */
async function resolveOne(
  provider: SecretProvider,
  reference: SecretReference,
  timeoutMs: number,
  context: ResolveContext,
  now: () => number,
): Promise<ResolvedSecret | string> {
  const what = describeReference(reference);
  let answer: unknown;
  try {
    answer = await withTimeout(
      (expired) =>
        provider.resolve(
          requestOf(reference),
          context.signal === undefined ? expired : AbortSignal.any([expired, context.signal]),
        ),
      timeoutMs,
    );
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === "EXTENSION_TIMEOUT") {
      return `${what} was not resolved within ${timeoutMs} ms`;
    }
    return `${what} could not be resolved (${describeError(error)})`;
  }
  const secret = answer as Partial<ResolvedSecret> | null | undefined;
  if (typeof secret?.value !== "string" || secret.value === "") {
    return `${what}: the provider answered with no value`;
  }
  if (typeof secret.version !== "string") {
    return `${what}: the provider answered with no version`;
  }
  const { expiresAt } = secret;
  if (expiresAt !== undefined) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      return `${what}: the provider answered with an expiry that is not a date`;
    }
    if (expiresAt.getTime() <= now()) {
      return `${what} expired at ${expiresAt.toISOString()}`;
    }
  }
  return secret as ResolvedSecret;
}

/** Stops a provider under its time limit; a failure is logged by name and code, never its text. */
async function stopProvider(
  provider: SecretProvider,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  if (provider.stop === undefined) return;
  try {
    await withTimeout(() => provider.stop?.(), timeoutMs);
  } catch (error) {
    logger.warn({ event: "secrets-stop-failed", error: errorName(error), code: errorCode(error) });
  }
}

/** An error's name and code: never its text, which a provider's own errors may fill with anything. */
function describeError(error: unknown): string {
  const code = errorCode(error);
  return `${errorName(error)}${code === undefined ? "" : ` ${code}`}`;
}

/** An error's class name, when it reads as one; a name that does not is no place for words. */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return error === null ? "null" : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}
