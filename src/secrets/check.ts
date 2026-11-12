import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import { ConfigError } from "../config/load.js";
import { type Env, extensionEnv } from "../env.js";
import type { ProjectConfig, SecretReference } from "../config/schema.js";
import { KEY_BYTES, type KeyProvider } from "../encryption/keys.js";
import { customSecretProvider } from "../extensions/build.js";
import { ExtensionLoadError } from "../extensions/load.js";
import { startingKeys } from "../storage/open.js";
import type { ResolvedSecret, SecretError, SecretProvider } from "./provider.js";
import {
  builtIn,
  describeError,
  keyOf,
  readBuiltIn,
  referenceOf,
  resolveOne,
  Secrets,
  stopProvider,
} from "./resolve.js";
import { secretUses } from "./sources.js";

// `pathways secrets check`: every secret a start reads, resolved now, and a throwaway data key
// wrapped and unwrapped by the key provider, so a deployment learns before it starts that a secret
// or a key cannot be had. What it reports is where each secret is named, its provider and name, and
// the version, identity and expiry the provider answered with: never a value, its length or any
// part of it. A problem is the same fixed text start would give.

/** One place a project reads a secret, and what resolving it now gave. */
export interface SecretCheckEntry {
  /** The file and key that name it, such as `pathways.yaml: health.auth`. */
  readonly where: string;
  /** The provider: `env`, `file`, or a name under `secrets:`. */
  readonly provider: string;
  /** The secret's name in its provider; `null` for the `file` provider, whose name is a path. */
  readonly name: string | null;
  readonly field: string | null;
  /** The version the reference asks for; `null` for the current one. */
  readonly requestedVersion: string | null;
  readonly status: "resolved" | "failed";
  /** The version the provider answered with. */
  readonly version: string | null;
  /** The principal that read it, when the provider says. */
  readonly identity: string | null;
  /** When it stops being good, as an ISO 8601 time, when the provider says. */
  readonly expiresAt: string | null;
  /** Why it could not be had, in the words start uses; `null` when it resolved. */
  readonly problem: string | null;
}

/** What the key provider's round trip of a throwaway data key gave. */
export interface KeyProviderCheck {
  /** `encryption`'s kind: the built-in master keys, a provider module, or none. */
  readonly kind: "keys" | "provider" | "none";
  /** `none` when `encryption: none`, so there is nothing to check. */
  readonly status: "passed" | "failed" | "none";
  /** The id of the master key that wrapped the throwaway key. */
  readonly keyId: string | null;
  readonly problems: readonly string[];
}

/** Everything `pathways secrets check` found. */
export interface SecretCheck {
  /** True when every reference resolved and the key provider's round trip did not fail. */
  readonly ok: boolean;
  readonly references: readonly SecretCheckEntry[];
  readonly keyProvider: KeyProviderCheck;
}

/** What {@link checkSecrets} runs with. */
export interface CheckContext {
  readonly env: Env;
  readonly logger: Logger;
}

/** A provider's answer, or the problem that says why there is none. */
type Outcome = ResolvedSecret | string;

/**
 * Resolves every secret reference a start reads (a destination that runs dry is left out, as start
 * leaves it), each module provider's once per secret, and runs a throwaway data key through the key
 * provider's `wrapKey` and `unwrapKey`. Never throws for a secret or a key that cannot be had: each
 * is reported.
 *
 * @throws Only what is unexpected: a provider module that cannot be built is reported, not thrown.
 * @example
 * ```ts
 * const check = await checkSecrets(project, { env: process.env, logger });
 * if (!check.ok) process.exitCode = 1;
 * ```
 */
export async function checkSecrets(
  project: ProjectConfig,
  context: CheckContext,
): Promise<SecretCheck> {
  const uses = secretUses(project, "all", "each");
  const outcomes = await resolveFromModules(
    project,
    context,
    uses.map(({ source }) => source),
  );
  const resolved = new Map<string, string>();
  const references = uses.map(({ source, where }): SecretCheckEntry => {
    const reference = referenceOf(source);
    const outcome = builtIn(reference.provider)
      ? readNow(context.env, reference)
      : (outcomes.get(keyOf(reference)) as Outcome);
    if (typeof outcome !== "string") resolved.set(keyOf(reference), outcome.value);
    return entryOf(where, reference, outcome);
  });
  const keyProvider = await roundTrip(project, {
    env: context.env,
    logger: context.logger,
    secrets: new Secrets(context.env, resolved),
  });
  const ok =
    references.every((entry) => entry.status === "resolved") && keyProvider.status !== "failed";
  return { ok, references, keyProvider };
}

/** A reference to the built-in `env` or `file` provider, read now. */
function readNow(env: Env, reference: SecretReference): Outcome {
  try {
    return readBuiltIn(env, reference);
  } catch (error) {
    // The built-in providers throw only SecretError, written in fixed words and names.
    return (error as SecretError).message;
  }
}

/** Each module provider's references, resolved: the provider built, asked once per secret, stopped. */
async function resolveFromModules(
  project: ProjectConfig,
  context: CheckContext,
  sources: readonly Parameters<typeof referenceOf>[0][],
): Promise<Map<string, Outcome>> {
  const wanted = new Map<string, Map<string, SecretReference>>();
  for (const source of sources) {
    const reference = referenceOf(source);
    if (builtIn(reference.provider)) continue;
    const byKey = wanted.get(reference.provider) ?? new Map<string, SecretReference>();
    byKey.set(keyOf(reference), reference);
    wanted.set(reference.provider, byKey);
  }
  const outcomes = new Map<string, Outcome>();
  for (const config of project.secrets) {
    const requests = wanted.get(config.name);
    if (requests === undefined) continue;
    const logger = context.logger.child({ extension: "secrets", provider: config.name });
    let provider: SecretProvider;
    try {
      provider = await customSecretProvider(
        config,
        { dir: project.root, env: extensionEnv(context.env), logger },
        `pathways.yaml: secrets.${config.name}.module`,
      );
    } catch (error) {
      /* v8 ignore next: building a provider throws only ExtensionLoadError */
      if (!(error instanceof ExtensionLoadError)) throw error;
      for (const key of requests.keys()) outcomes.set(key, error.message);
      continue;
    }
    try {
      for (const [key, reference] of requests) {
        outcomes.set(key, await resolveOne(provider, reference, config.timeoutMs, {}, Date.now));
      }
    } finally {
      await stopProvider(provider, config.timeoutMs, logger);
    }
  }
  return outcomes;
}

function entryOf(where: string, reference: SecretReference, outcome: Outcome): SecretCheckEntry {
  const base = {
    where,
    provider: reference.provider,
    // A file's name is its path, which in a careless setup can name a patient's folder.
    name: isFile(reference) ? null : reference.name,
    field: reference.field ?? null,
    requestedVersion: reference.version ?? null,
  };
  if (typeof outcome === "string") {
    return {
      ...base,
      status: "failed",
      version: null,
      identity: null,
      expiresAt: null,
      problem: outcome,
    };
  }
  return {
    ...base,
    status: "resolved",
    version: printable(outcome.version),
    identity: printable(outcome.identity),
    expiresAt: outcome.expiresAt?.toISOString() ?? null,
    problem: null,
  };
}

function isFile(reference: SecretReference): boolean {
  return reference.provider === "file";
}

/**
 * `text` when it is printable ASCII with no space, 1 to 256 characters, or `null`: a version or an
 * identity is never secret, and one that does not look like a name is not printed.
 */
function printable(text: unknown): string | null {
  return typeof text === "string" && /^[\x21-\x7e]{1,256}$/.test(text) ? text : null;
}

/** The key provider, built as start builds it, run on a throwaway data key. */
async function roundTrip(
  project: ProjectConfig,
  context: CheckContext & { readonly secrets: Secrets },
): Promise<KeyProviderCheck> {
  // The command refuses a project with no `encryption` before it gets here, as validate does.
  const kind = (project.encryption as NonNullable<ProjectConfig["encryption"]>).kind;
  let keys: KeyProvider | undefined;
  try {
    keys = await startingKeys(project, context);
  } catch (error) {
    if (error instanceof ConfigError) {
      return { kind, status: "failed", keyId: null, problems: error.problems };
    }
    /* v8 ignore next: the rest throw only ExtensionLoadError */
    if (!(error instanceof ExtensionLoadError)) throw error;
    return { kind, status: "failed", keyId: null, problems: [error.message] };
  }
  if (keys === undefined) return { kind, status: "none", keyId: null, problems: [] };
  const dataKey = randomBytes(KEY_BYTES);
  const expected = Buffer.from(dataKey);
  const failed = (problem: string, keyId: string | null = null): KeyProviderCheck => ({
    kind,
    status: "failed",
    keyId,
    problems: [problem],
  });
  try {
    let wrapped: Awaited<ReturnType<KeyProvider["wrapKey"]>>;
    try {
      wrapped = await keys.wrapKey(dataKey);
    } catch (error) {
      return failed(`the key provider could not wrap a throwaway key (${describeError(error)})`);
    }
    // A provider module is code Pathways did not write: its answers are checked before they are used.
    const answer = wrapped as Partial<typeof wrapped> | null | undefined;
    if (typeof answer?.keyId !== "string" || !(answer.wrapped instanceof Uint8Array)) {
      return failed("the key provider's wrapKey did not answer with a keyId and wrapped bytes");
    }
    const keyId = printable(answer.keyId);
    let back: unknown;
    try {
      back = await keys.unwrapKey(answer.keyId, answer.wrapped);
    } catch (error) {
      return failed(
        `the key provider could not unwrap the throwaway key it wrapped (${describeError(error)})`,
        keyId,
      );
    }
    if (!(back instanceof Uint8Array)) {
      return failed("the key provider's unwrapKey did not answer with bytes", keyId);
    }
    const same = Buffer.from(back.buffer, back.byteOffset, back.byteLength).equals(expected);
    back.fill(0);
    if (!same) return failed("the key provider unwrapped a different key than it wrapped", keyId);
    return { kind, status: "passed", keyId, problems: [] };
  } finally {
    dataKey.fill(0);
    expected.fill(0);
  }
}

/**
 * The check as text, one line per reference and one for the key provider, then a summary. Never a
 * value.
 *
 * @example
 * ```ts
 * io.out(formatSecretCheck(await checkSecrets(project, context)));
 * ```
 */
export function formatSecretCheck(check: SecretCheck): string {
  const lines = check.references.map((entry) => {
    const facts = [
      `provider ${entry.provider}`,
      ...(entry.name === null ? [] : [`name ${entry.name}`]),
      ...(entry.field === null ? [] : [`field ${entry.field}`]),
    ];
    if (entry.status === "failed")
      return `failed    ${entry.where}: ${facts.join(", ")}: ${entry.problem}`;
    facts.push(`version ${entry.version ?? "(not printable)"}`);
    if (entry.identity !== null) facts.push(`identity ${entry.identity}`);
    if (entry.expiresAt !== null) facts.push(`expires ${entry.expiresAt}`);
    return `resolved  ${entry.where}: ${facts.join(", ")}`;
  });
  const { keyProvider } = check;
  const how =
    keyProvider.kind === "keys" ? "the built-in master keys" : "pathways.yaml: encryption.provider";
  if (keyProvider.status === "none") {
    lines.push("none      key provider: encryption: none, so there is no key to check");
  } else if (keyProvider.status === "passed") {
    lines.push(
      `passed    key provider: ${how} wrapped and unwrapped a throwaway key under the key ${keyProvider.keyId ?? "(not printable)"}`,
    );
  } else {
    lines.push(
      ...keyProvider.problems.map((problem) => `failed    key provider: ${how}: ${problem}`),
    );
  }
  const failed = check.references.filter((entry) => entry.status === "failed").length;
  const count = check.references.length;
  const keyWords =
    keyProvider.status === "none"
      ? "no key provider to check"
      : `the key provider's round trip ${keyProvider.status}`;
  lines.push(
    `pathways: ${count} secret reference${count === 1 ? "" : "s"}, ${count - failed} resolved, ${failed} failed; ${keyWords}.`,
  );
  return `${lines.map((line) => `${line}\n`).join("")}`;
}
