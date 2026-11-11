import { resolve } from "node:path";

import type {
  ChannelConfig,
  HeaderValue,
  HookConfig,
  ProjectConfig,
  SecretSource,
} from "../config/schema.js";

// Where a project reads its secrets: each reference, by the file and key that wrote it. The loader
// checks every reference names a provider the project has, and start resolves the ones a provider
// outside the engine holds before anything reads them.

/** A secret reference as the YAML holds it, with exactly one of its keys set. */
export interface SecretSourceYaml {
  readonly env?: string | undefined;
  readonly file?: string | undefined;
  readonly secret?:
    | {
        readonly provider: string;
        readonly name: string;
        readonly field?: string | undefined;
        readonly version?: string | undefined;
      }
    | undefined;
}

/**
 * A secret reference as the YAML wrote it, resolved: a file, and the name the `file` provider is
 * given, against `dir`, the folder of the file that wrote it.
 *
 * @example
 * ```ts
 * secretSourceOf({ file: "secrets/token" }, "/srv/project"); // { file: "/srv/project/secrets/token" }
 * ```
 */
export function secretSourceOf(source: SecretSourceYaml, dir: string): SecretSource {
  if (source.env !== undefined) return { env: source.env };
  if (source.file !== undefined) return { file: resolve(dir, source.file) };
  // The schema lets exactly one of the three through.
  const secret = source.secret as NonNullable<SecretSourceYaml["secret"]>;
  return {
    secret: {
      provider: secret.provider,
      name: secret.provider === "file" ? resolve(dir, secret.name) : secret.name,
      field: secret.field,
      version: secret.version,
    },
  };
}

/** One place a project reads a secret: the reference, and the file and key that wrote it. */
export interface SecretUse {
  readonly source: SecretSource;
  /** The file and key, such as `channels/adt/channel.yaml: destinations.0.http.headers.Authorization`. */
  readonly where: string;
}

/**
 * Which secrets to list: those opening the store reads (its connection URL and the master keys), or
 * every one the engine reads at start.
 */
export type SecretScope = "store" | "all";

/**
 * Every secret reference `project` holds, in `scope`, each with the file and key that wrote it. A
 * header written in the YAML is no secret and is not listed.
 *
 * @example
 * ```ts
 * for (const { source, where } of secretUses(project, "all")) console.log(where);
 * ```
 */
export function secretUses(
  project: Pick<ProjectConfig, "storage" | "encryption" | "health" | "hooks" | "channels">,
  scope: SecretScope,
): SecretUse[] {
  const uses: SecretUse[] = [];
  const { storage, encryption } = project;
  if (storage.kind !== "sqlite" && storage.kind !== "module") {
    uses.push({ source: storage.url, where: `pathways.yaml: storage.${storage.kind}.url` });
  }
  if (encryption?.kind === "keys") {
    for (const [index, key] of encryption.keys.entries()) {
      uses.push({
        source: key,
        where: `pathways.yaml: encryption.keys.${index}: the key ${key.id}`,
      });
    }
  }
  if (scope === "store") return uses;
  if (project.health?.auth.kind === "bearer") {
    uses.push({ source: project.health.auth, where: "pathways.yaml: health.auth" });
  }
  uses.push(...hookUses(project.hooks, "pathways.yaml"));
  for (const channel of project.channels) uses.push(...channelUses(channel));
  return uses;
}

function channelUses(channel: ChannelConfig): SecretUse[] {
  const file = `channels/${channel.name}/channel.yaml`;
  const uses: SecretUse[] = [];
  const { source } = channel;
  if (source.kind === "http") {
    if (source.auth.kind === "bearer") {
      uses.push({ source: source.auth, where: `${file}: source.http.auth` });
    }
    if (source.response.kind === "fixed") {
      uses.push(...headerUses(source.response.headers, `${file}: source.http.response`));
    }
  }
  for (const [index, destination] of channel.destinations.entries()) {
    if (destination.kind === "http") {
      uses.push(...headerUses(destination.headers, `${file}: destinations.${index}.http`));
    }
  }
  uses.push(...hookUses(channel.hooks, file));
  return uses;
}

function hookUses(hooks: readonly HookConfig[], file: string): SecretUse[] {
  return hooks.flatMap((hook, index) =>
    hook.kind === "webhook"
      ? headerUses(hook.webhook.headers, `${file}: hooks.${index}.webhook`)
      : [],
  );
}

function headerUses(headers: Readonly<Record<string, HeaderValue>>, where: string): SecretUse[] {
  const uses: SecretUse[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!("value" in value)) uses.push({ source: value, where: `${where}.headers.${name}` });
  }
  return uses;
}
