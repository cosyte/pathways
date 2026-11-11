import { access, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";

import { normalisePath } from "../connectors/http-path.js";
import { secretSourceOf, secretUses, type SecretSourceYaml } from "../secrets/sources.js";
import { referencesIn, resolvingEnv, variableAt, type EnvReference } from "./env-ref.js";
import { DEFAULT_INDEX_BITS, isLowEntropyKey } from "./meta-index.js";
import {
  BUILT_IN_SECRET_PROVIDERS,
  channelSchema,
  DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
  DEFAULT_DATABASE_FILE,
  DEFAULT_DATABASE_URL_ENV,
  DEFAULT_HEALTH_TOKEN_ENV,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_HTTP_TOKEN_ENV,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MIN_AGE_MS,
  DEFAULT_READ_TRIES,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_SECRET_TIMEOUT_MS,
  DEFAULT_SETTINGS,
  projectSchema,
  type ChannelConfig,
  type ClientTlsFiles,
  type ContentPolicy,
  type EncryptionConfig,
  type EndpointAuth,
  type HeaderValue,
  type HookConfig,
  type HttpClientConfig,
  type HttpSource,
  type ListenerConfig,
  type ModuleConnector,
  type OnStoreFailure,
  type PathPattern,
  type ProjectConfig,
  type RetryPolicy,
  type SecretProviderConfig,
  type ServerTlsFiles,
  type Settings,
  type StorageConfig,
  type TransformConfigBlock,
} from "./schema.js";

type ChannelYaml = z.infer<typeof channelSchema>;
type ProjectYaml = z.infer<typeof projectSchema>;
type ListenerYaml = NonNullable<ProjectYaml["health"]>;
type StorageYaml = NonNullable<ProjectYaml["storage"]>;
type DestinationYaml = ChannelYaml["destinations"][number];
type HookYaml = NonNullable<ChannelYaml["hooks"]>[number];
type HttpClientYaml = NonNullable<DestinationYaml["http"]>;
type RetryYaml = NonNullable<ChannelYaml["retry"]>;

/**
 * A project that could not be loaded. `problems` name the file and the key at fault; they hold no
 * message content, since configuration never does.
 *
 * @example
 * ```ts
 * try {
 *   await loadProject(".");
 * } catch (error) {
 *   if (error instanceof ConfigError) console.error(error.problems.join("\n"));
 * }
 * ```
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  /** @param problems One line per problem: the file, the key, and what is wrong. */
  constructor(problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * How {@link loadProject} loads a project.
 *
 * @example
 * ```ts
 * const options: LoadOptions = { env: { HEALTH_PORT: "9090" } };
 * ```
 */
export interface LoadOptions {
  /**
   * Where each `{ env: NAME }` setting is read from. Defaults to `process.env`. Only the variables
   * the files name are read: there is no scan for a prefix.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Loads `pathways.yaml` (optional) and every `channels/<name>/channel.yaml` under `root`, validates
 * them, and resolves every relative path against the file that declares it. A setting written as
 * `{ env: NAME, default? }` is read from `options.env` first and checked as if written in the file.
 *
 * @example
 * ```ts
 * const project = await loadProject(process.cwd());
 * console.log(project.channels.map((c) => c.name));
 * ```
 */
export async function loadProject(root: string, options: LoadOptions = {}): Promise<ProjectConfig> {
  const env = options.env ?? process.env;
  const projectRoot = resolve(root);
  const problems: string[] = [];
  // The project folder itself shows as ".", so a problem never repeats the path the caller typed.
  // Folders are joined with "/" on every system, Windows too, so a problem reads as the docs and the
  // YAML write the path.
  const show = (file: string): string => relative(projectRoot, file).split(sep).join("/") || ".";

  const projectFile = join(projectRoot, "pathways.yaml");
  const environment: EnvReference[] = [];
  const warnings: string[] = [];
  let project: ProjectYaml = {};
  let projectEnv: ReadonlyMap<string, string> = new Map();
  if (await exists(projectFile)) {
    const parsed = await readYaml(projectFile, show, problems);
    if (parsed !== undefined) {
      const yaml = parsed ?? {};
      const { result, resolved } = resolvingEnv(env, () => projectSchema.safeParse(yaml));
      if (result.success) {
        project = result.data;
        const references = referencesIn(yaml, resolved, undefined);
        environment.push(...references);
        projectEnv = byKey(references);
      } else {
        problems.push(...describeIssues(show(projectFile), result.error.issues, yaml, resolved));
      }
    }
  }

  const settings: Settings = mergeSettings(DEFAULT_SETTINGS, {
    ...project.defaults,
    content: project.storage?.content,
  });
  const projectRetry: RetryLevel = {
    key: "defaults.retry",
    block: project.defaults?.retry,
    fromEnv: projectEnv,
  };
  problems.push(...retryProblems(show(projectFile), [projectRetry], settings.retry));
  const databaseFile = resolve(projectRoot, project.storage?.sqlite?.file ?? DEFAULT_DATABASE_FILE);
  const storage = resolveStorage(project.storage, projectRoot, databaseFile);
  const hooks = (project.hooks ?? []).map((hook) => resolveHook(hook, projectRoot));
  const encryption = resolveEncryption(project.encryption, projectRoot);
  const secrets: SecretProviderConfig[] = Object.entries(project.secrets ?? {}).map(
    ([name, provider]) => ({
      name,
      module: resolve(projectRoot, provider.module),
      options: provider.options ?? {},
      timeoutMs: provider.timeout ?? DEFAULT_SECRET_TIMEOUT_MS,
    }),
  );
  problems.push(
    ...(await missingModules(show(projectFile), show, projectEnv, [
      [
        "encryption.provider.module",
        encryption?.kind === "provider" ? encryption.module : undefined,
      ],
      ...secrets.map((provider) => [`secrets.${provider.name}.module`, provider.module] as const),
      ["storage.module", storage.kind === "module" ? storage.module : undefined],
      ...hookModules(hooks),
    ])),
  );
  const health =
    project.health === undefined
      ? undefined
      : resolveListener(project.health, projectRoot, DEFAULT_HEALTH_TOKEN_ENV);
  const probes =
    project.probes === undefined
      ? undefined
      : { host: project.probes.host ?? DEFAULT_HOST, port: project.probes.port };
  const lease = {
    ttlMs: project.lease?.ttl ?? DEFAULT_LEASE_TTL_MS,
    standby: project.lease?.standby ?? false,
  };
  if (lease.standby && storage.kind === "sqlite") {
    problems.push(
      `${show(projectFile)}: lease.standby: a standby needs a database server; on SQLite a second engine is refused`,
    );
  }

  const channelsDir = join(projectRoot, "channels");
  const channels: ChannelConfig[] = [];
  let folders: string[] = [];
  try {
    folders = (await readdir(channelsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    problems.push(
      `${show(channelsDir)}: no channels folder; each channel lives in channels/<name>/channel.yaml`,
    );
  }

  for (const folder of folders) {
    const channelDir = join(channelsDir, folder);
    const file = join(channelDir, "channel.yaml");
    if (!(await exists(file))) {
      problems.push(`${show(channelDir)}: no channel.yaml`);
      continue;
    }
    const parsed = await readYaml(file, show, problems);
    if (parsed === undefined) continue;
    const yaml = parsed ?? {};
    const { result, resolved } = resolvingEnv(env, () => channelSchema.safeParse(yaml));
    if (!result.success) {
      problems.push(...describeIssues(show(file), result.error.issues, yaml, resolved));
      continue;
    }
    const channel = result.data;
    const references = referencesIn(yaml, resolved, folder);
    const channelEnv = byKey(references);
    if (channel.name !== undefined && channel.name !== folder) {
      problems.push(
        `${show(file)}: name: "${channel.name}" must match its folder name, "${folder}"`,
      );
      continue;
    }
    const transform =
      channel.transform === undefined ? undefined : resolve(channelDir, channel.transform);
    if (transform !== undefined && !(await exists(transform))) {
      problems.push(
        `${show(file)}: transform: ${absent(transform, "transform", channelEnv, show)}`,
      );
      continue;
    }
    const channelSettings = mergeSettings(settings, {
      ...channel,
      content: channel.storage?.content,
    });
    const source = resolveSource(channel.source, channelDir, channelSettings);
    const destinations = channel.destinations.map(
      (destination): ChannelConfig["destinations"][number] => ({
        ...resolveDestination(destination, channelDir, channelSettings),
        // Set only when true, so a destination that sends resolves as it always has.
        ...(destination.dryRun === true ? { dryRun: true } : {}),
      }),
    );
    const channelRetry: RetryLevel = { key: "retry", block: channel.retry, fromEnv: channelEnv };
    const badRetry = [
      ...retryProblems(show(file), [channelRetry, projectRetry], channelSettings.retry),
      ...destinations.flatMap((destination, index) =>
        retryProblems(
          show(file),
          [
            {
              key: `destinations.${index}.retry`,
              block: channel.destinations[index]?.retry,
              fromEnv: channelEnv,
            },
            channelRetry,
            projectRetry,
          ],
          destination.retry,
        ),
      ),
    ];
    if (badRetry.length > 0) {
      problems.push(...badRetry);
      continue;
    }
    const channelHooks = (channel.hooks ?? []).map((hook) => resolveHook(hook, channelDir));
    const missing = await missingModules(show(file), show, channelEnv, [
      ["source.module", source.kind === "module" ? source.module : undefined],
      ["source.mllp.ackBuilder", source.kind === "mllp" ? source.ackBuilder : undefined],
      ...destinations.map(
        (destination, index) =>
          [
            `destinations.${index}.module`,
            destination.kind === "module" ? destination.module : undefined,
          ] as const,
      ),
      ...hookModules(channelHooks),
    ]);
    if (missing.length > 0) {
      problems.push(...missing);
      continue;
    }
    environment.push(...references);
    const indexes = (channel.index ?? []).map((entry) =>
      typeof entry === "string"
        ? { key: entry, bits: DEFAULT_INDEX_BITS }
        : { key: entry.key, bits: entry.bits ?? DEFAULT_INDEX_BITS },
    );
    for (const [index, { key }] of indexes.entries()) {
      if (encryption?.kind === "none") {
        problems.push(
          `${show(file)}: index.${index}: an index needs encryption keys, and pathways.yaml sets encryption: none`,
        );
      }
      if (isLowEntropyKey(key)) {
        warnings.push(
          `${show(file)}: index.${index}: ${key} has few or guessable values, so the spread of its tags in the database shows how its values are spread; index a key whose values are many and hard to guess, such as an MRN or an accession number`,
        );
      }
    }
    channels.push({
      name: folder,
      dir: channelDir,
      format: channel.format ?? "hl7v2",
      source,
      transform,
      destinations,
      settings: channelSettings,
      hooks: channelHooks,
      // The schema checked each value is JSON.
      config: (channel.config ?? {}) as TransformConfigBlock,
      ...(indexes.length > 0 ? { indexes } : {}),
    });
  }

  if (problems.length === 0 && channels.length === 0) {
    problems.push(
      `${show(channelsDir)}: no channels; each channel lives in channels/<name>/channel.yaml`,
    );
  }
  const providers = new Set([...BUILT_IN_SECRET_PROVIDERS, ...secrets.map(({ name }) => name)]);
  for (const { source, where } of secretUses(
    { storage, encryption, health, hooks, channels },
    "all",
  )) {
    if ("secret" in source && !providers.has(source.secret.provider)) {
      problems.push(
        `${where}: secret.provider: ${source.secret.provider} is not a provider; name env, file, or one under secrets: in pathways.yaml`,
      );
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    root: projectRoot,
    storage,
    databaseFile,
    settings,
    hooks,
    health,
    probes,
    lease,
    migrations: { rollbackWindowMs: project.migrations?.rollbackWindow ?? 0 },
    encryption,
    config: (project.config ?? {}) as TransformConfigBlock,
    secrets,
    channels,
    environment,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The variable each key was read from, by its dotted key. */
function byKey(references: readonly EnvReference[]): ReadonlyMap<string, string> {
  return new Map(references.map((reference) => [reference.key, reference.variable]));
}

/**
 * What a problem says of a file that does not exist: its path, or, when the path was read from the
 * environment, the variable that named it, since a problem never holds a value read from there.
 */
function absent(
  file: string,
  key: string,
  fromEnv: ReadonlyMap<string, string>,
  show: (file: string) => string,
): string {
  const variable = fromEnv.get(key) ?? fromEnv.get(`${key}.module`);
  return variable === undefined
    ? `${show(file)} does not exist`
    : `the file the environment variable ${variable} names does not exist`;
}

/** Each module a list of hooks names, by its key. */
function hookModules(hooks: readonly HookConfig[]): (readonly [string, string | undefined])[] {
  return hooks.map(
    (hook, index) => [`hooks.${index}`, hook.kind === "module" ? hook.module : undefined] as const,
  );
}

/** One problem for each module, named by its key, that does not exist. */
async function missingModules(
  file: string,
  show: (file: string) => string,
  fromEnv: ReadonlyMap<string, string>,
  modules: readonly (readonly [key: string, module: string | undefined])[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const [key, module] of modules) {
    if (module !== undefined && !(await exists(module))) {
      problems.push(`${file}: ${key}: ${absent(module, key, fromEnv, show)}`);
    }
  }
  return problems;
}

function resolveHook(hook: HookYaml, dir: string): HookConfig {
  const settings = { events: hook.events, timeoutMs: hook.timeout ?? DEFAULT_HOOK_TIMEOUT_MS };
  if (hook.webhook !== undefined) {
    return { ...settings, kind: "webhook", webhook: resolveHttpClient(hook.webhook, dir) };
  }
  // The schema lets exactly one kind through, so a hook that is not a webhook is a module.
  return {
    ...settings,
    kind: "module",
    module: resolve(dir, hook.module as string),
    options: hook.options ?? {},
  };
}

function resolveModule(
  block: {
    readonly module?: string | undefined;
    readonly options?: Record<string, unknown> | undefined;
  },
  dir: string,
): ModuleConnector | undefined {
  if (block.module === undefined) return undefined;
  return { kind: "module", module: resolve(dir, block.module), options: block.options ?? {} };
}

/** The encryption settings, with each key file resolved against the project root. */
function resolveEncryption(
  encryption: ProjectYaml["encryption"],
  root: string,
): EncryptionConfig | undefined {
  if (encryption === undefined) return undefined;
  if (encryption === "none") return { kind: "none" };
  if ("provider" in encryption) {
    const { module, options } = encryption.provider;
    return { kind: "provider", module: resolve(root, module), options: options ?? {} };
  }
  return {
    kind: "keys",
    keys: encryption.keys.map((key) => ({ id: key.id, ...secretSourceOf(key, root) })),
    current: encryption.current,
  };
}

/**
 * The storage block, resolved: the SQLite file, TLS files and a custom store's module against the
 * project root, and every default filled in. The connection URL stays a secret reference until startup reads it.
 */
function resolveStorage(
  storage: StorageYaml | undefined,
  root: string,
  databaseFile: string,
): StorageConfig {
  // With no kind, the one block written; the schema lets exactly one through.
  const kind =
    storage?.kind ??
    (["module", "postgres", "mysql", "sqlserver"] as const).find(
      (block) => storage?.[block] !== undefined,
    ) ??
    "sqlite";
  if (kind === "sqlite") return { kind: "sqlite", file: databaseFile };
  if (kind === "module") {
    return {
      kind: "module",
      // The schema refuses a kind whose block is not written.
      module: resolve(root, storage?.module as string),
      options: storage?.options ?? {},
    };
  }
  const server = { kind, ...(storage?.[kind] as NonNullable<StorageYaml[typeof kind]>) };
  return {
    kind: server.kind,
    url:
      server.url === undefined
        ? { env: DEFAULT_DATABASE_URL_ENV }
        : secretSourceOf(server.url, root),
    tls: server.tls === undefined ? undefined : resolveClientTls(server.tls, root),
    plaintext: server.plaintext === true,
    pool: {
      max: server.pool?.max ?? DEFAULT_POOL_MAX,
      idleTimeoutMs: server.pool?.idleTimeout ?? DEFAULT_POOL_IDLE_TIMEOUT_MS,
    },
    connectTimeoutMs: server.connectTimeout ?? DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
  };
}

function resolveSource(
  source: ChannelYaml["source"],
  dir: string,
  settings: Settings,
): ChannelConfig["source"] {
  const { http, mllp } = source;
  const module = resolveModule(source, dir);
  if (module !== undefined) return module;
  if (mllp !== undefined) {
    return {
      kind: "mllp",
      host: mllp.host ?? DEFAULT_HOST,
      port: mllp.port,
      tls: mllp.tls === undefined ? undefined : resolveServerTls(mllp.tls, dir),
      plaintext: mllp.plaintext === true,
      onStoreFailure: mllp.onStoreFailure ?? settings.onStoreFailure,
      ackBuilder: mllp.ackBuilder === undefined ? undefined : resolve(dir, mllp.ackBuilder),
    };
  }
  if (http !== undefined) {
    return {
      kind: "http",
      ...resolveListener(http, dir, DEFAULT_HTTP_TOKEN_ENV),
      // The schema passed each path through the request rule, so it reads as a path here.
      paths: (http.paths ?? [http.path ?? "/"]).map((path) => normalisePath(path) as string),
      methods: http.methods ?? ["POST"],
      response: resolveSourceResponse(http.response, dir),
      maxBytes: http.maxBytes ?? DEFAULT_MAX_BYTES,
      contextHeaders: (http.contextHeaders ?? []).map((name) => name.toLowerCase()),
    };
  }
  // The schema lets exactly one kind through, so a source that is not HTTP is a file source.
  const file = source.file as NonNullable<typeof source.file>;
  return {
    kind: "file",
    dir: resolve(dir, file.dir),
    minAgeMs: file.minAge ?? DEFAULT_MIN_AGE_MS,
    keepProcessed: file.keepProcessed ?? false,
    include: patterns(file.include),
    exclude: patterns(file.exclude),
    recursive: file.recursive ?? false,
    ignoreDot: file.ignoreDot ?? true,
    minSize: file.minSize ?? 1,
    maxSize: file.maxSize,
    maxPerPoll: file.maxPerPoll,
    sortBy: file.sortBy ?? "name",
    stable: file.stable ?? false,
    doneFile: file.doneFile,
    errorDir: file.errorDir === undefined ? undefined : resolve(dir, file.errorDir),
    readTries: file.readTries ?? DEFAULT_READ_TRIES,
  };
}

/** A file source's `include` or `exclude` as written, each glob made a `{ glob }`. */
function patterns(
  written: readonly (string | { readonly regex: string })[] | undefined,
): PathPattern[] {
  return (written ?? []).map((pattern) =>
    typeof pattern === "string" ? { glob: pattern } : { regex: pattern.regex },
  );
}

/**
 * A destination, resolved, with its own retry settings over the channel's when its block has a
 * `retry:`.
 */
function resolveDestination(
  destination: DestinationYaml,
  dir: string,
  settings: Settings,
): ChannelConfig["destinations"][number] {
  const resolved = resolveConnector(destination, dir, settings);
  if (destination.retry === undefined) return resolved;
  return { ...resolved, retry: mergeRetry(settings.retry, destination.retry) };
}

function resolveConnector(
  destination: DestinationYaml,
  dir: string,
  settings: Settings,
): ChannelConfig["destinations"][number] {
  const { http, mllp } = destination;
  const module = resolveModule(destination, dir);
  if (module !== undefined) return module;
  if (mllp !== undefined) {
    return {
      kind: "mllp",
      host: mllp.host,
      port: mllp.port,
      tls: mllp.tls === undefined ? undefined : resolveClientTls(mllp.tls, dir),
      plaintext: mllp.plaintext === true,
      ackTimeoutMs: mllp.ackTimeout ?? settings.ackTimeoutMs,
    };
  }
  if (http === undefined) {
    // The schema lets exactly one kind through, so a destination that is not HTTP is a file one.
    const file = destination.file as NonNullable<typeof destination.file>;
    return { kind: "file", dir: resolve(dir, file.dir) };
  }
  return {
    kind: "http",
    ...resolveHttpClient(http, dir),
    timeoutMs: http.timeout ?? DEFAULT_HTTP_TIMEOUT_MS,
    resendHeader: http.resendHeader,
  };
}

/** An HTTP source's `response:`, resolved: headers marked as written or read at start. */
function resolveSourceResponse(
  response: NonNullable<ChannelYaml["source"]["http"]>["response"],
  dir: string,
): HttpSource["response"] {
  if (response === undefined) return { kind: "id" };
  if (response === "ack") return { kind: "ack" };
  return {
    kind: "fixed",
    status: response.status,
    contentType: response.contentType,
    headers: markHeaders(response.headers, dir),
    body: response.body ?? "",
  };
}

/** Configured headers, each marked as written in the YAML or a secret read at start. */
function markHeaders(
  configured: Readonly<Record<string, string | SecretSourceYaml>> | undefined,
  dir: string,
): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = {};
  for (const [name, value] of Object.entries(configured ?? {})) {
    headers[name] = typeof value === "string" ? { value } : secretSourceOf(value, dir);
  }
  return headers;
}

/** An HTTP client endpoint, resolved: headers marked as written or read at start. */
function resolveHttpClient(http: Omit<HttpClientYaml, "timeout">, dir: string): HttpClientConfig {
  return {
    url: http.url,
    headers: markHeaders(http.headers, dir),
    tls: http.tls === undefined ? undefined : resolveClientTls(http.tls, dir),
    plaintext: http.plaintext === true,
  };
}

/**
 * A listening endpoint, resolved. With no `auth`, mutual TLS authenticates when `tls.ca` is set;
 * otherwise a bearer token is required, read from `defaultTokenEnv`. A token read from a file is
 * resolved against `dir`.
 */
function resolveListener(
  listener: ListenerYaml,
  dir: string,
  defaultTokenEnv: string,
): ListenerConfig {
  const { tls } = listener;
  let auth: EndpointAuth;
  if (listener.auth === "none") auth = { kind: "none" };
  else if (listener.auth !== undefined) {
    auth = { kind: "bearer", ...secretSourceOf(listener.auth.bearer, dir) };
  } else if (tls?.ca !== undefined) auth = { kind: "none" };
  else auth = { kind: "bearer", env: defaultTokenEnv };
  return {
    host: listener.host ?? DEFAULT_HOST,
    port: listener.port,
    tls: tls === undefined ? undefined : resolveServerTls(tls, dir),
    plaintext: listener.plaintext === true,
    auth,
  };
}

function resolveServerTls(
  tls: { cert: string; key: string; ca?: string | undefined },
  dir: string,
): ServerTlsFiles {
  return {
    cert: resolve(dir, tls.cert),
    key: resolve(dir, tls.key),
    ca: tls.ca === undefined ? undefined : resolve(dir, tls.ca),
  };
}

function resolveClientTls(
  tls: { ca?: string | undefined; cert?: string | undefined; key?: string | undefined },
  dir: string,
): ClientTlsFiles {
  const at = (file: string | undefined): string | undefined =>
    file === undefined ? undefined : resolve(dir, file);
  return { ca: at(tls.ca), cert: at(tls.cert), key: at(tls.key) };
}

function mergeSettings(
  base: Settings,
  override: {
    timeout?: number | undefined;
    memory?: number | undefined;
    pollInterval?: number | undefined;
    onStoreFailure?: OnStoreFailure | undefined;
    ackTimeout?: number | undefined;
    retention?: number | undefined;
    resendFlag?: boolean | undefined;
    retentionInterval?: number | undefined;
    content?: ContentPolicy | undefined;
    retry?: RetryYaml | undefined;
  },
): Settings {
  return {
    timeoutMs: override.timeout ?? base.timeoutMs,
    memoryMb: override.memory ?? base.memoryMb,
    pollIntervalMs: override.pollInterval ?? base.pollIntervalMs,
    onStoreFailure: override.onStoreFailure ?? base.onStoreFailure,
    ackTimeoutMs: override.ackTimeout ?? base.ackTimeoutMs,
    retentionMs: override.retention ?? base.retentionMs,
    resendFlag: override.resendFlag ?? base.resendFlag,
    retentionIntervalMs: override.retentionInterval ?? base.retentionIntervalMs,
    content: override.content ?? base.content,
    retry: override.retry === undefined ? base.retry : mergeRetry(base.retry, override.retry),
  };
}

/** `override`'s retry keys over `base`'s, key by key; `none` lifts a limit `base` set. */
function mergeRetry(base: RetryPolicy, override: RetryYaml): RetryPolicy {
  const lifted = (value: number | "none" | undefined, wider: number | undefined) =>
    value === "none" ? undefined : (value ?? wider);
  return {
    firstMs: override.first ?? base.firstMs,
    maxMs: override.max ?? base.maxMs,
    factor: override.factor ?? base.factor,
    jitter: override.jitter ?? base.jitter,
    limit: lifted(override.limit, base.limit),
    maxAgeMs: lifted(override.maxAge, base.maxAgeMs),
    onExhaust: override.onExhaust ?? base.onExhaust,
    rotate: override.rotate ?? base.rotate,
  };
}

/** One level's retry block, its dotted key, and the variables its keys were read from. */
interface RetryLevel {
  readonly key: string;
  readonly block: RetryYaml | undefined;
  readonly fromEnv: ReadonlyMap<string, string>;
}

/** The variable the `first` or `max` in force was read from: at the narrowest level that sets it. */
function retryVariable(levels: readonly RetryLevel[], name: "first" | "max"): string | undefined {
  const level = levels.find((candidate) => candidate.block?.[name] !== undefined);
  return level?.fromEnv.get(`${level.key}.${name}`);
}

/**
 * A problem when the retry settings in force where `levels[0]` sets `first` or `max` wait longer at
 * first than at most: checked where it is set, so a problem names the file and key at fault.
 * `levels` runs from that level out to the widest. When either value in force was read from the
 * environment, the problem names the variable and holds neither value.
 */
function retryProblems(
  file: string,
  levels: readonly [RetryLevel, ...RetryLevel[]],
  policy: RetryPolicy | undefined,
): string[] {
  const [{ key, block }] = levels;
  if (policy === undefined || (block?.first === undefined && block?.max === undefined)) return [];
  if (policy.firstMs <= policy.maxMs) return [];
  const first = retryVariable(levels, "first");
  const max = retryVariable(levels, "max");
  const from = [
    first === undefined ? undefined : `first read from the environment variable ${first}`,
    max === undefined
      ? undefined
      : `max ${first === undefined ? "read from the environment variable" : "from"} ${max}`,
  ].filter((part) => part !== undefined);
  const what =
    from.length === 0
      ? `first (${String(policy.firstMs)}ms) is longer than max (${String(policy.maxMs)}ms)`
      : `first is longer than max (${from.join(", ")})`;
  return [`${file}: ${key}: ${what}; set first no longer than max`];
}

async function readYaml(
  file: string,
  show: (file: string) => string,
  problems: string[],
): Promise<unknown> {
  try {
    return parseYaml(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const at = error.linePos?.[0];
      /* v8 ignore next -- yaml's parse sets linePos on every error it throws (prettyErrors is on) */
      const where = at === undefined ? "" : ` at line ${at.line}, column ${at.col}`;
      problems.push(`${show(file)}: not valid YAML${where} (${error.code})`);
    } else {
      problems.push(`${show(file)}: could not be read`);
    }
    return undefined;
  }
}

/**
 * One line per issue: the file, the key, and what is wrong, with the variable the key was read from
 * when it was. Never the value: Zod's own messages and ours hold none.
 */
function describeIssues(
  file: string,
  issues: ReadonlyArray<{ readonly path: readonly PropertyKey[]; readonly message: string }>,
  yaml: unknown,
  resolved: Parameters<typeof variableAt>[2],
): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    const variable = variableAt(yaml, issue.path, resolved);
    const from = variable === undefined ? "" : ` (read from the environment variable ${variable})`;
    return `${file}: ${path === "" ? "" : `${path}: `}${issue.message}${from}`;
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
