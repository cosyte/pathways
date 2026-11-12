// The one place in src/ meant to touch the process's environment. Two checks refuse the listed ways
// of reading a variable around it. The types: an Env is opaque, so the type checker refuses `.NAME`,
// `["NAME"]`, a destructure or a copy of one elsewhere; engineVariable takes only a name in
// ENGINE_VARIABLES; and a secret's variable (configuredVariable, a SecretSource's `env`, readEnv,
// the env provider's request) is a VariableName: a listed name, or a ConfiguredVariableName, which
// configuredName makes where a name comes from configuration (test/env-access.test.ts lists those
// calls). test/env-types.ts holds the type checker to each case. And the lint rule in
// eslint.config.js refuses `process.env` and the other listed ways to the process's own environment,
// processEnv() anywhere but bound to an `env`, and a literal where configuration gives a name. Any
// other route is caught by review, not by a check. test/env-example.test.ts compares the three
// .env.example files both ways with ENGINE_VARIABLES.

/**
 * The environment Pathways reads: `process.env`, or a stand-in in tests. Any object is one, so a
 * caller hands in a plain record, and the type checker refuses reading a name from it outside this
 * file: {@link engineVariable} and {@link configuredVariable} read it.
 */
export type Env = object;

/** What {@link Env} holds, seen only inside this file. */
type Variables = Readonly<Record<string, string | undefined>>;

declare const CONFIGURED: unique symbol;

/**
 * A variable's name that configuration gave, made by {@link configuredName}. A string literal is not
 * one, so a name Pathways itself reads goes through {@link engineVariable} and so
 * {@link ENGINE_VARIABLES}.
 */
export type ConfiguredVariableName = string & { readonly [CONFIGURED]: true };

/**
 * Every environment variable Pathways reads by a fixed name. The first three are the defaults a
 * configuration falls back to when it names no variable of its own; the fault points are read only
 * by the source the tests run, never by the published build.
 *
 * @example
 * ```ts
 * ENGINE_VARIABLES.includes("PATHWAYS_DATABASE_URL"); // true
 * ```
 */
export const ENGINE_VARIABLES = [
  "PATHWAYS_DATABASE_URL",
  "PATHWAYS_HTTP_TOKEN",
  "PATHWAYS_HEALTH_TOKEN",
  "XDG_RUNTIME_DIR",
  "PATHWAYS_TEST_FAULT_POINT",
  "PATHWAYS_TEST_FAULT_POINT_RESUME",
] as const;

/** One of {@link ENGINE_VARIABLES}. */
export type EngineVariable = (typeof ENGINE_VARIABLES)[number];

/**
 * A variable's name wherever a secret is read from the environment: one of
 * {@link ENGINE_VARIABLES}, such as a default a configuration falls back to, or a name configuration
 * gave, made by {@link configuredName}. A plain string is neither.
 */
export type VariableName = EngineVariable | ConfiguredVariableName;

/**
 * The process's own environment, for a caller that takes an {@link Env} and was given none.
 *
 * @example
 * ```ts
 * const env = io.env ?? processEnv();
 * ```
 */
export function processEnv(): Env {
  return process.env;
}

/**
 * `env` as an extension is given it, `context.env`: the variables an extension reads for itself,
 * such as its own credentials, by whatever names its options give. The lint rule lets this be called
 * only as the value of an `env` property.
 *
 * @example
 * ```ts
 * const context: ExtensionContext = { dir, env: extensionEnv(env), logger };
 * ```
 */
export function extensionEnv(env: Env): Variables {
  return env as Variables;
}

/**
 * `name`, read from configuration (a `{ env: NAME }` reference, a transform's config or the `env`
 * secret provider's reference), as a name {@link configuredVariable} takes. It is called only where
 * such a name is parsed; test/env-access.test.ts lists those places, and the lint rule refuses a
 * string literal here.
 *
 * @example
 * ```ts
 * configuredVariable(env, configuredName(reference.env));
 * ```
 */
export function configuredName(name: string): ConfiguredVariableName {
  return name as ConfiguredVariableName;
}

/**
 * The variable `name`, one of {@link ENGINE_VARIABLES}, from `env`: the process's environment
 * unless a stand-in is given.
 *
 * @example
 * ```ts
 * engineVariable("XDG_RUNTIME_DIR"); // "/run/user/1000", or undefined
 * ```
 */
export function engineVariable(name: EngineVariable, env: Env = processEnv()): string | undefined {
  return (env as Variables)[name];
}

/**
 * The variable `name` from `env`, where the name comes from configuration: a `{ env: NAME }`
 * reference, a transform's config or the `env` secret provider, which also reads the listed defaults
 * a configuration falls back to. A name Pathways itself reads elsewhere is read with
 * {@link engineVariable} instead.
 *
 * @example
 * ```ts
 * configuredVariable(env, configuredName(reference.env));
 * ```
 */
export function configuredVariable(env: Env, name: VariableName): string | undefined {
  return (env as Variables)[name];
}
