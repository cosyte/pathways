import type { Env } from "../connectors/endpoint.js";
import type { FailureSummary } from "../engine/worker-entry.js";
import type { JsonValue } from "../transform.js";
import { ConfigError } from "./load.js";
import type { ChannelConfig, ProjectConfig, TransformConfigBlock } from "./schema.js";

/**
 * A channel's transform configuration, resolved: the project's `config:` block with the channel's
 * own over it, key by key, and each `{ env: NAME }` replaced by that variable's value, read from
 * `env` now. Runs in the engine's process (or the command's) when it starts, never in a worker.
 *
 * A variable that is not set, or is empty, fails the whole resolution with one problem per
 * reference, each naming its file, key and variable, never a value.
 *
 * @throws {ConfigError} when a referenced variable is not set.
 * @example
 * ```ts
 * const config = resolveTransformConfig(project.config, channel, process.env);
 * ```
 */
export function resolveTransformConfig(
  project: TransformConfigBlock,
  channel: Pick<ChannelConfig, "name" | "config">,
  env: Env,
): Record<string, JsonValue> {
  const problems: string[] = [];
  const resolved: Record<string, JsonValue> = {};
  const own = `channels/${channel.name}/channel.yaml`;
  for (const [file, block] of [
    ["pathways.yaml", project],
    [own, channel.config],
  ] as const) {
    for (const [key, value] of Object.entries(block)) {
      resolved[key] = resolveValue(value, `${file}: config.${key}`, env, problems);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return resolved;
}

/** A value with every `{ env: NAME }` in it read from `env`; a problem for each that is not set. */
function resolveValue(value: JsonValue, where: string, env: Env, problems: string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveValue(item, `${where}.${index}`, env, problems));
  }
  if (typeof value !== "object" || value === null) return value;
  const reference = envReference(value);
  if (reference !== undefined) {
    const read = env[reference];
    if (read === undefined || read === "") {
      problems.push(`${where}: the environment variable ${reference} is not set`);
      return null;
    }
    return read;
  }
  const map: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    map[key] = resolveValue(item, `${where}.${key}`, env, problems);
  }
  return map;
}

/** The variable a map names when it is `{ env: NAME }`, its one key, as the schema checked. */
function envReference(value: { readonly [key: string]: JsonValue }): string | undefined {
  const keys = Object.keys(value);
  const name = value["env"];
  return keys.length === 1 && typeof name === "string" ? name : undefined;
}

/**
 * A channel's transform configuration, resolved from `env`; or, when a variable it names is not
 * set, a load failure whose code is `TRANSFORM_CONFIG` and whose detail names the file, key and
 * variable, never a value.
 *
 * @example
 * ```ts
 * const config = transformConfigFor(project, channel, process.env);
 * if ("resolved" in config) console.log(Object.keys(config.resolved));
 * ```
 */
export function transformConfigFor(
  project: Pick<ProjectConfig, "config">,
  channel: Pick<ChannelConfig, "name" | "config">,
  env: Env,
): { readonly resolved: Readonly<Record<string, unknown>> } | FailureSummary {
  try {
    return { resolved: resolveTransformConfig(project.config, channel, env) };
  } catch (error) {
    /* v8 ignore next: resolveTransformConfig throws only a ConfigError */
    if (!(error instanceof ConfigError)) throw error;
    return { kind: "load", name: error.name, code: "TRANSFORM_CONFIG", detail: error.message };
  }
}
