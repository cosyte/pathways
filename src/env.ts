// The one place in src/ that touches the process's environment. eslint.config.js refuses
// `process.env`, `process["env"]`, `globalThis.process`, `const { env } = process`, an `env` import
// from `node:process`, and a read on an `env` object (`env.NAME`, `env[name]`, `scope.env[name]`,
// a spread or `Object.keys` of one) everywhere else in src/. So every variable Pathways reads by a
// fixed name is in ENGINE_VARIABLES, which test/env-example.test.ts holds the three .env.example
// files to, and every name that comes from configuration goes through configuredVariable.

/** The environment Pathways reads: `process.env`, or a stand-in in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

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
 * The variable `name`, one of {@link ENGINE_VARIABLES}, from `env`: the process's environment
 * unless a stand-in is given.
 *
 * @example
 * ```ts
 * engineVariable("XDG_RUNTIME_DIR"); // "/run/user/1000", or undefined
 * ```
 */
export function engineVariable(name: EngineVariable, env: Env = processEnv()): string | undefined {
  return env[name];
}

/**
 * The variable `name` from `env`, where the name comes from configuration: a `{ env: NAME }`
 * reference, a transform's config or the `env` secret provider. A name Pathways itself knows is read
 * with {@link engineVariable} instead.
 *
 * @example
 * ```ts
 * configuredVariable(processEnv(), reference.env);
 * ```
 */
export function configuredVariable(env: Env, name: string): string | undefined {
  return env[name];
}
