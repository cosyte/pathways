import { access, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";

import { normalisePath } from "../connectors/http-path.js";
import {
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
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_SETTINGS,
  projectSchema,
  type ChannelConfig,
  type ClientTlsFiles,
  type EncryptionConfig,
  type EndpointAuth,
  type HeaderValue,
  type HookConfig,
  type HttpClientConfig,
  type HttpSource,
  type ListenerConfig,
  type ModuleConnector,
  type OnStoreFailure,
  type ProjectConfig,
  type ServerTlsFiles,
  type Settings,
  type StorageConfig,
} from "./schema.js";

type ChannelYaml = z.infer<typeof channelSchema>;
type ProjectYaml = z.infer<typeof projectSchema>;
type ListenerYaml = NonNullable<ProjectYaml["health"]>;
type StorageYaml = NonNullable<ProjectYaml["storage"]>;
type DestinationYaml = ChannelYaml["destinations"][number];
type HookYaml = NonNullable<ChannelYaml["hooks"]>[number];
type HttpClientYaml = NonNullable<DestinationYaml["http"]>;

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
 * Loads `pathways.yaml` (optional) and every `channels/<name>/channel.yaml` under `root`, validates
 * them, and resolves every relative path against the file that declares it.
 *
 * @example
 * ```ts
 * const project = await loadProject(process.cwd());
 * console.log(project.channels.map((c) => c.name));
 * ```
 */
export async function loadProject(root: string): Promise<ProjectConfig> {
  const projectRoot = resolve(root);
  const problems: string[] = [];
  // The project folder itself shows as ".", so a problem never repeats the path the caller typed.
  // Folders are joined with "/" on every system, Windows too, so a problem reads as the docs and the
  // YAML write the path.
  const show = (file: string): string => relative(projectRoot, file).split(sep).join("/") || ".";

  const projectFile = join(projectRoot, "pathways.yaml");
  let project: ProjectYaml = {};
  if (await exists(projectFile)) {
    const parsed = await readYaml(projectFile, show, problems);
    if (parsed !== undefined) {
      const result = projectSchema.safeParse(parsed ?? {});
      if (result.success) project = result.data;
      else problems.push(...describeIssues(show(projectFile), result.error.issues));
    }
  }

  const settings: Settings = mergeSettings(DEFAULT_SETTINGS, project.defaults ?? {});
  const databaseFile = resolve(projectRoot, project.storage?.sqlite?.file ?? DEFAULT_DATABASE_FILE);
  const storage = resolveStorage(project.storage, projectRoot, databaseFile);
  const hooks = (project.hooks ?? []).map((hook) => resolveHook(hook, projectRoot));
  const encryption = resolveEncryption(project.encryption, projectRoot);
  problems.push(
    ...(await missingModules(show(projectFile), show, [
      [
        "encryption.provider.module",
        encryption?.kind === "provider" ? encryption.module : undefined,
      ],
      ["storage.module", storage.kind === "module" ? storage.module : undefined],
      ...hookModules(hooks),
    ])),
  );
  const health =
    project.health === undefined
      ? undefined
      : resolveListener(project.health, projectRoot, DEFAULT_HEALTH_TOKEN_ENV);
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
    const result = channelSchema.safeParse(parsed ?? {});
    if (!result.success) {
      problems.push(...describeIssues(show(file), result.error.issues));
      continue;
    }
    const channel = result.data;
    if (channel.name !== undefined && channel.name !== folder) {
      problems.push(
        `${show(file)}: name: "${channel.name}" must match its folder name, "${folder}"`,
      );
      continue;
    }
    const transform =
      channel.transform === undefined ? undefined : resolve(channelDir, channel.transform);
    if (transform !== undefined && !(await exists(transform))) {
      problems.push(`${show(file)}: transform: ${show(transform)} does not exist`);
      continue;
    }
    const channelSettings = mergeSettings(settings, channel);
    const source = resolveSource(channel.source, channelDir, channelSettings);
    const destinations = channel.destinations.map((destination) =>
      resolveDestination(destination, channelDir, channelSettings),
    );
    const channelHooks = (channel.hooks ?? []).map((hook) => resolveHook(hook, channelDir));
    const absent = await missingModules(show(file), show, [
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
    if (absent.length > 0) {
      problems.push(...absent);
      continue;
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
    });
  }

  if (problems.length === 0 && channels.length === 0) {
    problems.push(
      `${show(channelsDir)}: no channels; each channel lives in channels/<name>/channel.yaml`,
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    root: projectRoot,
    storage,
    databaseFile,
    settings,
    hooks,
    health,
    lease,
    migrations: { rollbackWindowMs: project.migrations?.rollbackWindow ?? 0 },
    encryption,
    channels,
  };
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
  modules: readonly (readonly [key: string, module: string | undefined])[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const [key, module] of modules) {
    if (module !== undefined && !(await exists(module))) {
      problems.push(`${file}: ${key}: ${show(module)} does not exist`);
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
    keys: encryption.keys.map(({ id, env, file }) =>
      // The schema lets exactly one of env and file through.
      env === undefined ? { id, file: resolve(root, file as string) } : { id, env },
    ),
    current: encryption.current,
  };
}

/**
 * The storage block, resolved: the SQLite file, TLS files and a custom store's module against the
 * project root, and every default filled in. The connection URL stays an environment variable name until startup reads it.
 */
function resolveStorage(
  storage: StorageYaml | undefined,
  root: string,
  databaseFile: string,
): StorageConfig {
  const { postgres, mysql, sqlserver, module } = storage ?? {};
  if (module !== undefined) {
    return { kind: "module", module: resolve(root, module), options: storage?.options ?? {} };
  }
  const server =
    (postgres && { kind: "postgres" as const, ...postgres }) ??
    (mysql && { kind: "mysql" as const, ...mysql }) ??
    (sqlserver && { kind: "sqlserver" as const, ...sqlserver });
  if (server === undefined) return { kind: "sqlite", file: databaseFile };
  return {
    kind: server.kind,
    urlEnv: server.url?.env ?? DEFAULT_DATABASE_URL_ENV,
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
      response: resolveSourceResponse(http.response),
      maxBytes: http.maxBytes ?? DEFAULT_MAX_BYTES,
    };
  }
  // The schema lets exactly one kind through, so a source that is not HTTP is a file source.
  const file = source.file as NonNullable<typeof source.file>;
  return {
    kind: "file",
    dir: resolve(dir, file.dir),
    minAgeMs: file.minAge ?? DEFAULT_MIN_AGE_MS,
    keepProcessed: file.keepProcessed ?? false,
  };
}

function resolveDestination(
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

/** An HTTP source's `response:`, resolved: headers marked as written or from the environment. */
function resolveSourceResponse(
  response: NonNullable<ChannelYaml["source"]["http"]>["response"],
): HttpSource["response"] {
  if (response === undefined) return { kind: "id" };
  if (response === "ack") return { kind: "ack" };
  return {
    kind: "fixed",
    status: response.status,
    contentType: response.contentType,
    headers: markHeaders(response.headers),
    body: response.body ?? "",
  };
}

/** Configured headers, each marked as written in the YAML or read from the environment. */
function markHeaders(
  configured: Readonly<Record<string, string | { readonly env: string }>> | undefined,
): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = {};
  for (const [name, value] of Object.entries(configured ?? {})) {
    headers[name] = typeof value === "string" ? { value } : { env: value.env };
  }
  return headers;
}

/** An HTTP client endpoint, resolved: headers marked as written or from the environment. */
function resolveHttpClient(http: Omit<HttpClientYaml, "timeout">, dir: string): HttpClientConfig {
  return {
    url: http.url,
    headers: markHeaders(http.headers),
    tls: http.tls === undefined ? undefined : resolveClientTls(http.tls, dir),
    plaintext: http.plaintext === true,
  };
}

/**
 * A listening endpoint, resolved. With no `auth`, mutual TLS authenticates when `tls.ca` is set;
 * otherwise a bearer token is required, read from `defaultTokenEnv`.
 */
function resolveListener(
  listener: ListenerYaml,
  dir: string,
  defaultTokenEnv: string,
): ListenerConfig {
  const { tls } = listener;
  let auth: EndpointAuth;
  if (listener.auth === "none") auth = { kind: "none" };
  else if (listener.auth !== undefined) auth = { kind: "bearer", env: listener.auth.bearer.env };
  else if (tls?.ca !== undefined) auth = { kind: "none" };
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
  };
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

function describeIssues(
  file: string,
  issues: ReadonlyArray<{ readonly path: readonly PropertyKey[]; readonly message: string }>,
): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${file}: ${path === "" ? "" : `${path}: `}${issue.message}`;
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
