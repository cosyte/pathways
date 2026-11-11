import { z } from "zod";

/** The environment a reference is read from: variable names to values. */
type Env = Readonly<Record<string, string | undefined>>;

/** What an environment variable's name may hold. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A setting read from the environment when the configuration is loaded: `{ env: NAME }`, or
 * `{ env: NAME, default: value }` for the value to use when the variable is unset or empty.
 */
export const envReference = z.strictObject({
  env: z.string().regex(ENV_NAME, "an environment variable name, such as PATHWAYS_PORT"),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

/** An `{ env: NAME, default? }` reference, as the YAML holds it. */
type EnvReferenceYaml = z.infer<typeof envReference>;

/**
 * One setting the configuration read from the environment: where it is, the variable it named, and
 * whether the variable was set or the reference's default was used. Never the value.
 *
 * @example
 * ```ts
 * const reference: EnvReference = {
 *   channel: "adt-to-lab",
 *   key: "source.mllp.port",
 *   variable: "ADT_PORT",
 *   from: "environment",
 * };
 * ```
 */
export interface EnvReference {
  /** The channel whose `channel.yaml` holds the setting, or `undefined` for `pathways.yaml`. */
  readonly channel: string | undefined;
  /** The setting's key, dotted: `health.port`, `destinations.0.http.url`. */
  readonly key: string;
  /** The environment variable the reference names. */
  readonly variable: string;
  /** `environment` when the variable was set, `default` when the reference's default was used. */
  readonly from: "environment" | "default";
}

/** The references one parse resolved, by the YAML object that wrote each. */
type Resolved = Map<object, { variable: string; from: EnvReference["from"] }>;

/** What a parse resolves references against, and records them in. */
interface Scope {
  readonly env: Env;
  readonly resolved: Resolved;
}

/**
 * The scope of the parse under way. Zod parses synchronously and passes no context of its own, so
 * {@link resolvingEnv} sets this for the length of one parse and restores it after.
 */
let current: Scope | undefined;

/**
 * Runs `parse` (a synchronous schema parse) with every `{ env: NAME }` reference in it read from
 * `env`, and returns its result with the references it resolved, by the YAML object of each.
 *
 * @example
 * ```ts
 * const { result, resolved } = resolvingEnv(process.env, () => projectSchema.safeParse(yaml));
 * ```
 */
export function resolvingEnv<T>(env: Env, parse: () => T): { result: T; resolved: Resolved } {
  const before = current;
  const scope: Scope = { env, resolved: new Map() };
  current = scope;
  try {
    return { result: parse(), resolved: scope.resolved };
  } finally {
    current = before;
  }
}

/** True when `value` is a mapping that holds an `env` key: a reference, well formed or not. */
function looksLikeReference(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "env" in value;
}

/** A whole number or decimal, as an environment variable holds one. */
const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * The value a variable's text stands for, read as `schema` reads it: the text itself when the
 * schema takes it, and otherwise a number or `true` and `false` when the text spells one. So `8080`
 * is a port, `5000` a duration in milliseconds, and `5s` stays a duration.
 */
function typed(text: string, schema: z.ZodType): unknown {
  if (schema.safeParse(text).success) return text;
  if (NUMBER.test(text)) return Number(text);
  if (text === "true" || text === "false") return text === "true";
  return text;
}

/**
 * `schema`, also accepting `{ env: NAME, default? }`: the variable's value (or the default, when it
 * is unset or empty) is read when the configuration is loaded and parsed by `schema` itself, so it
 * is checked as a value written in the YAML would be. An unset variable with no default is a
 * problem that names the variable, never a value.
 *
 * @example
 * ```ts
 * const port = fromEnvironment(z.number().int().min(1).max(65_535));
 * ```
 */
export function fromEnvironment<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, ctx) => {
    if (!looksLikeReference(value)) return value;
    const parsed = envReference.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
      return z.NEVER;
    }
    const reference: EnvReferenceYaml = parsed.data;
    // A parse outside resolvingEnv, such as a direct safeParse, reads the process's environment.
    const scope = current ?? { env: process.env, resolved: new Map() };
    const text = scope.env[reference.env];
    if (text !== undefined && text !== "") {
      scope.resolved.set(value, { variable: reference.env, from: "environment" });
      return typed(text, schema);
    }
    if (reference.default !== undefined) {
      scope.resolved.set(value, { variable: reference.env, from: "default" });
      return reference.default;
    }
    ctx.addIssue({
      code: "custom",
      message: `the environment variable ${reference.env} is not set, and the reference has no default`,
    });
    return z.NEVER;
  }, schema);
}

/**
 * The variable a problem's key was read from, when it was: the reference found by walking `yaml`
 * along `path`, if the parse resolved it.
 *
 * @example
 * ```ts
 * variableAt(yaml, ["health", "port"], resolved); // "HEALTH_PORT"
 * ```
 */
export function variableAt(
  yaml: unknown,
  path: readonly PropertyKey[],
  resolved: Resolved,
): string | undefined {
  let node = yaml;
  // Indexing a string or a number gives a string or undefined, never a reference.
  for (const key of path) node = (node as Record<PropertyKey, unknown> | undefined)?.[key];
  return typeof node === "object" && node !== null ? resolved.get(node)?.variable : undefined;
}

/**
 * Every reference a parse resolved, with its dotted key: found by walking `yaml`, the document as
 * read, for the objects the parse recorded. A reference an alias repeats is listed at each key.
 *
 * @example
 * ```ts
 * referencesIn(yaml, resolved, undefined); // [{ channel: undefined, key: "health.port", ... }]
 * ```
 */
export function referencesIn(
  yaml: unknown,
  resolved: Resolved,
  channel: string | undefined,
): EnvReference[] {
  const found: EnvReference[] = [];
  const walk = (node: unknown, path: readonly string[]): void => {
    if (typeof node !== "object" || node === null) return;
    const reference = resolved.get(node);
    if (reference !== undefined) {
      found.push({ channel, key: path.join("."), ...reference });
      return;
    }
    for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
  };
  if (resolved.size > 0) walk(yaml, []);
  return found;
}
