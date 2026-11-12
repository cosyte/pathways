import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

import { configuredName, configuredVariable, type Env } from "../env.js";

// The secret provider interface, and the two providers every project has: env and file. Nothing a
// provider returns is ever written to a log or an error; errors here carry the secret's name and a
// code, which a reader can act on, and never its value.

/**
 * One secret a provider is asked for: its name in the provider, and optionally one field of it and a
 * version. A provider that has no fields or versions refuses a request that names one.
 *
 * @example
 * ```ts
 * const ref: SecretRef = { name: "lab/api", field: "token" };
 * ```
 */
export interface SecretRef {
  /** The secret's name in the provider: a variable, a path, a key. Never secret itself. */
  readonly name: string;
  /** One field of a structured secret, or of a value that is a JSON object. */
  readonly field?: string | undefined;
  /** A version the provider keeps. Undefined asks for the current one. */
  readonly version?: string | undefined;
}

/**
 * What a provider answers: the value, the version it is, and when it stops being good, if it does.
 *
 * @example
 * ```ts
 * const secret: ResolvedSecret = { value: "synthetic-token", version: "3", expiresAt: new Date("2026-12-01T00:00:00Z") };
 * ```
 */
export interface ResolvedSecret {
  /** The secret itself. Pathways never logs it, and never puts it in an error. */
  readonly value: string;
  /** The version resolved, as the provider names it; never secret. */
  readonly version: string;
  /** When the value stops being good, for a lease or a short-lived credential. */
  readonly expiresAt?: Date | undefined;
  /**
   * Who read it, when the provider can tell: the cloud principal its call ran as, such as a role's
   * ARN, a managed identity's id or a service account's email. Never secret. `pathways secrets
   * check` prints it, when it is printable ASCII with no space, 1 to 256 characters.
   */
  readonly identity?: string | undefined;
}

/**
 * Where secrets come from: an environment variable, a file, or a secret store such as a cloud
 * provider's secrets manager. `pathways.yaml` names each provider under `secrets:` by a module whose
 * default export builds it, and a `{ secret: { provider, name, field, version } }` reference anywhere
 * a secret is read asks it for one.
 *
 * `resolve` is called once per secret when the engine starts, with a signal that aborts when the
 * provider's time limit passes or the start is cancelled. It rejects when the secret cannot be had,
 * preferably with a {@link SecretError}. Pathways reports a rejection by the reference's file and key,
 * the secret's name and the error's name and code, never the error's text, so an error may say
 * anything; a value must still never be put in one.
 *
 * @example
 * ```ts
 * const store: SecretProvider = {
 *   async resolve(ref, signal) {
 *     const found = await myStore.get(ref.name, { version: ref.version, signal });
 *     return { value: found.text, version: found.version };
 *   },
 * };
 * ```
 */
export interface SecretProvider {
  /** Resolves one secret. */
  resolve(ref: SecretRef, signal: AbortSignal): Promise<ResolvedSecret>;
  /** Releases what the provider holds open. Called once start has resolved every secret. */
  stop?(): Promise<void> | void;
}

/**
 * The codes a {@link SecretError} carries:
 *
 * - `ERR_PATHWAYS_SECRET_NOT_FOUND`: the provider has no secret by that name;
 * - `ERR_PATHWAYS_SECRET_FIELD`: the secret has no such field, or holds no fields;
 * - `ERR_PATHWAYS_SECRET_VERSION`: the provider has no such version, or keeps none;
 * - `ERR_PATHWAYS_SECRET_UNREADABLE`: the provider could not read it.
 *
 * @example
 * ```ts
 * const code: SecretErrorCode = "ERR_PATHWAYS_SECRET_NOT_FOUND";
 * ```
 */
export type SecretErrorCode =
  | "ERR_PATHWAYS_SECRET_NOT_FOUND"
  | "ERR_PATHWAYS_SECRET_FIELD"
  | "ERR_PATHWAYS_SECRET_VERSION"
  | "ERR_PATHWAYS_SECRET_UNREADABLE";

/**
 * A secret could not be resolved. Its text names the secret, never a value. A provider can reject with
 * one, so the code shows where Pathways reports the failure.
 *
 * @example
 * ```ts
 * throw new SecretError("ERR_PATHWAYS_SECRET_NOT_FOUND", "lab/api");
 * ```
 */
export class SecretError extends Error {
  readonly code: SecretErrorCode;
  /** The secret's name. */
  readonly secret: string;

  /**
   * @param code What went wrong.
   * @param secret The secret's name, never its value.
   * @param detail What went wrong, in words: never a value. Defaults to the code's own words.
   */
  constructor(code: SecretErrorCode, secret: string, detail?: string) {
    super(detail ?? `${secret}: ${SECRET_ERROR_TEXT[code]}`);
    this.name = "SecretError";
    this.code = code;
    this.secret = secret;
  }
}

const SECRET_ERROR_TEXT: Readonly<Record<SecretErrorCode, string>> = {
  ERR_PATHWAYS_SECRET_NOT_FOUND: "no such secret",
  ERR_PATHWAYS_SECRET_FIELD: "no such field",
  ERR_PATHWAYS_SECRET_VERSION: "no such version",
  ERR_PATHWAYS_SECRET_UNREADABLE: "could not be read",
};

/**
 * One field of a secret that holds a JSON object: `value` itself when `field` is undefined. `what`
 * names where the value came from, for the error.
 *
 * @throws {SecretError} `ERR_PATHWAYS_SECRET_FIELD` when `value` is not a JSON object, or the field is
 *   missing or not a string. Its text never holds the value.
 * @example
 * ```ts
 * pickField('{"token":"synthetic"}', "token", "lab/api"); // "synthetic"
 * ```
 */
export function pickField(
  value: string,
  field: string | undefined,
  name: string,
  what = name,
): string {
  if (field === undefined) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const picked =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)[field]
      : undefined;
  if (typeof picked !== "string") {
    throw new SecretError(
      "ERR_PATHWAYS_SECRET_FIELD",
      name,
      `${what} does not hold a JSON object with the string field ${field}`,
    );
  }
  return picked;
}

/** The version the built-in providers answer with: they keep none. */
export const LATEST = "latest";

/** Refuses a version, for a provider that keeps none. */
function noVersion(ref: SecretRef, what: string): void {
  if (ref.version !== undefined && ref.version !== LATEST) {
    throw new SecretError(
      "ERR_PATHWAYS_SECRET_VERSION",
      ref.name,
      `${what} has no versions; leave version out`,
    );
  }
}

/**
 * The built-in `env` provider, read now: the variable `ref.name`, or one field of the JSON object it
 * holds. Unset and empty are the same.
 *
 * @throws {SecretError} naming the variable, never its value.
 * @example
 * ```ts
 * readEnvSecret(process.env, { name: "LAB_TOKEN" }).value;
 * ```
 */
export function readEnvSecret(env: Env, ref: SecretRef): ResolvedSecret {
  const what = `the environment variable ${ref.name}`;
  noVersion(ref, what);
  const value = configuredVariable(env, configuredName(ref.name));
  if (value === undefined || value === "") {
    throw new SecretError("ERR_PATHWAYS_SECRET_NOT_FOUND", ref.name, `${what} is not set`);
  }
  return { value: pickField(value, ref.field, ref.name, what), version: LATEST };
}

/**
 * The built-in `file` provider, read now: the file at `ref.name`, an absolute path, with one line
 * break at its end dropped (as `echo` and most editors leave one), or one field of the JSON object it
 * holds. This is how a container platform's mounted secrets are read. A symbolic link is followed;
 * a file larger than 1 MiB is refused unread.
 *
 * @throws {SecretError} saying the file could not be read, with the system's code, is too large, or
 *   holds nothing.
 *   Never the path, which may name a patient's folder in a careless setup, nor the value.
 * @example
 * ```ts
 * readFileSecret({ name: "/run/secrets/lab-token" }).value;
 * ```
 */
export function readFileSecret(ref: SecretRef): ResolvedSecret {
  const what = "its file";
  noVersion(ref, what);
  let text: string | undefined;
  try {
    // A symbolic link is followed, as a mounted Kubernetes secret needs. The size is checked on the
    // open file, so a file swapped after the check is not the one read.
    const fd = openSync(ref.name, "r");
    try {
      if (fstatSync(fd).size <= SECRET_FILE_LIMIT) text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new SecretError(
      code === "ENOENT" ? "ERR_PATHWAYS_SECRET_NOT_FOUND" : "ERR_PATHWAYS_SECRET_UNREADABLE",
      ref.name,
      /* v8 ignore next -- readFileSync's errors all carry a code */
      `${what} could not be read${typeof code === "string" ? ` (${code})` : ""}`,
    );
  }
  if (text === undefined) {
    throw new SecretError(
      "ERR_PATHWAYS_SECRET_UNREADABLE",
      ref.name,
      `${what} is larger than 1 MiB`,
    );
  }
  const value = text.replace(/\r?\n$/, "");
  if (value === "") {
    throw new SecretError("ERR_PATHWAYS_SECRET_NOT_FOUND", ref.name, `${what} is empty`);
  }
  return { value: pickField(value, ref.field, ref.name, what), version: LATEST };
}

/** The largest file the `file` provider reads, in bytes: 1 MiB, a Kubernetes secret's limit. */
const SECRET_FILE_LIMIT = 1024 * 1024;

/**
 * The built-in `env` provider as a {@link SecretProvider}.
 *
 * @example
 * ```ts
 * const env = envSecretProvider(process.env);
 * ```
 */
export function envSecretProvider(env: Env): SecretProvider {
  return { resolve: (ref) => new Promise((done) => done(readEnvSecret(env, ref))) };
}

/**
 * The built-in `file` provider as a {@link SecretProvider}. Names are absolute paths.
 *
 * @example
 * ```ts
 * const files = fileSecretProvider();
 * ```
 */
export function fileSecretProvider(): SecretProvider {
  return { resolve: (ref) => new Promise((done) => done(readFileSecret(ref))) };
}
