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
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MIN_AGE_MS,
  DEFAULT_POLL_DEADLINE_MS,
  DEFAULT_READ_TRIES,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_SECRET_TIMEOUT_MS,
  DEFAULT_SETTINGS,
  DEFAULT_SMTP_BODY,
  DEFAULT_SMTP_CONNECT_TIMEOUT_MS,
  DEFAULT_SMTP_GREETING_TIMEOUT_MS,
  DEFAULT_SMTP_SOCKET_TIMEOUT_MS,
  DEFAULT_SMTP_SUBJECT,
  DEFAULT_TCP_IDLE_TIMEOUT_MS,
  DEFAULT_TCP_STALL_TIMEOUT_MS,
  DEFAULT_TCP_TIMEOUT_MS,
  projectSchema,
  type AzblobConfig,
  type ChannelConfig,
  type ClientTlsFiles,
  type MllpClientTlsFiles,
  type MllpServerTlsFiles,
  type MllpTlsChoices,
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
  type PollConfig,
  type ProjectConfig,
  type RetryPolicy,
  type SecretProviderConfig,
  type S3Config,
  type ServerTlsFiles,
  type SftpConfig,
  type Settings,
  type SmtpDestination,
  type StorageConfig,
  type TcpFraming,
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
type PollYaml = NonNullable<ChannelYaml["source"]["poll"]>;
type TcpFramingYaml = NonNullable<ChannelYaml["source"]["tcp"]>["framing"];

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
  problems.push(...retentionProblem(show(projectFile), settings));
  const databaseFile = resolve(projectRoot, project.storage?.sqlite?.file ?? DEFAULT_DATABASE_FILE);
  const storage = resolveStorage(project.storage, projectRoot, databaseFile);
  const hooks = (project.hooks ?? []).map((hook) => resolveHook(hook, projectRoot));
  const encryption = resolveEncryption(project.encryption, projectRoot);
  const retention = project.defaults?.retention;
  const archiveDir = typeof retention === "object" ? retention.archive?.dir : undefined;
  const archive = archiveDir === undefined ? undefined : { dir: resolve(projectRoot, archiveDir) };
  if (archive !== undefined && encryption?.kind === "none") {
    problems.push(
      `${show(projectFile)}: defaults.retention.archive: an archive is sealed under encryption keys, and pathways.yaml sets encryption: none`,
    );
  }
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
      : {
          ...resolveListener(project.health, projectRoot, DEFAULT_HEALTH_TOKEN_ENV),
          metrics: {
            enabled: project.health.metrics?.enabled ?? true,
            allowUnauthenticated: project.health.metrics?.allowUnauthenticated ?? false,
          },
        };
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
      passTimeout: channel.storage?.passTimeout,
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
    badRetry.push(...retentionProblem(show(file), channelSettings));
    if (badRetry.length > 0) {
      problems.push(...badRetry);
      continue;
    }
    const channelHooks = (channel.hooks ?? []).map((hook) => resolveHook(hook, channelDir));
    const missing = await missingModules(show(file), show, channelEnv, [
      ["source.module", source.kind === "module" ? source.module : undefined],
      ["source.mllp.ackBuilder", source.kind === "mllp" ? source.ackBuilder : undefined],
      [
        "source.tcp.reply.builder",
        source.kind === "tcp" && source.reply?.kind === "builder" ? source.reply.module : undefined,
      ],
      ...destinations.map(
        (destination, index) =>
          [
            `destinations.${index}.tcp.replyCheck`,
            destination.kind === "tcp" ? destination.replyCheck : undefined,
          ] as const,
      ),
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
    const format = channel.format ?? "hl7v2";
    const tcp = [
      ...(source.kind === "tcp" ? ["source.tcp"] : []),
      ...destinations.flatMap((destination, index) =>
        destination.kind === "tcp" ? [`destinations.${index}.tcp`] : [],
      ),
    ];
    if (format === "hl7v2") {
      for (const key of tcp) {
        warnings.push(
          `${show(file)}: ${key}: tcp sends no HL7 ACK and checks no MSH-10, and this channel's format is hl7v2; for HL7 v2 with ACKs use mllp, or set the format this feed carries`,
        );
      }
    }
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
      format,
      ...(channel.csv === undefined ? {} : { csv: channel.csv }),
      source,
      transform,
      destinations,
      settings: channelSettings,
      hooks: channelHooks,
      // Set only when the source has a poll:, so a channel without one resolves as it always has.
      ...(channel.source.poll === undefined ? {} : { poll: resolvePoll(channel.source.poll) }),
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
    node: { id: project.node?.id, heartbeatMs: project.node?.heartbeat ?? DEFAULT_HEARTBEAT_MS },
    migrations: { rollbackWindowMs: project.migrations?.rollbackWindow ?? 0 },
    drain: {
      notReadyDelayMs: project.drain?.notReadyDelay ?? 0,
      timeoutMs: project.drain?.timeout ?? DEFAULT_DRAIN_TIMEOUT_MS,
    },
    encryption,
    config: (project.config ?? {}) as TransformConfigBlock,
    secrets,
    channels,
    environment,
    ...(warnings.length > 0 ? { warnings } : {}),
    // Set only when pathways.yaml names one, so a project without resolves as it always has.
    ...(archive === undefined ? {} : { archive }),
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
  const { http, mllp, tcp } = source;
  const module = resolveModule(source, dir);
  if (module !== undefined) return module;
  if (tcp !== undefined) {
    const { reply } = tcp;
    return {
      kind: "tcp",
      host: tcp.host ?? DEFAULT_HOST,
      port: tcp.port,
      tls: tcp.tls === undefined ? undefined : resolveServerTls(tcp.tls, dir),
      plaintext: tcp.plaintext === true,
      framing: resolveFraming(tcp.framing),
      ...(tcp.maxConnections === undefined ? {} : { maxConnections: tcp.maxConnections }),
      maxMessageSize: tcp.maxMessageSize ?? DEFAULT_MAX_BYTES,
      idleTimeoutMs: tcp.idleTimeout ?? DEFAULT_TCP_IDLE_TIMEOUT_MS,
      stallTimeoutMs: tcp.stallTimeout ?? DEFAULT_TCP_STALL_TIMEOUT_MS,
      reply:
        reply === undefined
          ? undefined
          : reply.builder === undefined
            ? // The schema lets exactly one of hex and builder through.
              { kind: "fixed", hex: (reply.hex as string).toLowerCase() }
            : { kind: "builder", module: resolve(dir, reply.builder) },
    };
  }
  if (mllp !== undefined) {
    return {
      kind: "mllp",
      host: mllp.host ?? DEFAULT_HOST,
      // The schema lets a source without connect through only with a port; one with connect listens
      // on none.
      port: mllp.port ?? 0,
      tls: mllp.tls === undefined ? undefined : resolveMllpServerTls(mllp.tls, dir),
      plaintext: mllp.plaintext === true,
      onStoreFailure: mllp.onStoreFailure ?? settings.onStoreFailure,
      ackBuilder: mllp.ackBuilder === undefined ? undefined : resolve(dir, mllp.ackBuilder),
      ...(mllp.maxConnections === undefined ? {} : { maxConnections: mllp.maxConnections }),
      ...(mllp.receiveTimeout === undefined ? {} : { receiveTimeoutMs: mllp.receiveTimeout }),
      ...(mllp.maxConnectionAge === undefined ? {} : { maxConnectionAgeMs: mllp.maxConnectionAge }),
      ...(mllp.maxMessageSize === undefined ? {} : { maxMessageSize: mllp.maxMessageSize }),
      ...(mllp.keepOpen === undefined ? {} : { keepOpen: mllp.keepOpen }),
      ...(mllp.connect === undefined ? {} : { connect: mllp.connect }),
      ...(mllp.replyTo === undefined ? {} : { replyTo: mllp.replyTo }),
      ...(mllp.connectTimeout === undefined ? {} : { connectTimeoutMs: mllp.connectTimeout }),
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
  const sftp = resolveSftp(file.sftp, dir);
  const objects = resolveObjectStores(file, dir);
  // On an SFTP server the folders are the server's own absolute paths, never this machine's, and
  // in an object store dir is a key prefix.
  const remote = sftp !== undefined || objects.s3 !== undefined || objects.azblob !== undefined;
  const place = (written: string): string => (remote ? written : resolve(dir, written));
  return {
    kind: "file",
    dir: place(file.dir),
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
    errorDir: file.errorDir === undefined ? undefined : place(file.errorDir),
    readTries: file.readTries ?? DEFAULT_READ_TRIES,
    sftp,
    ...objects,
  };
}

/** An `s3:` and an `azblob:` block as the YAML wrote them. */
type ObjectYaml = Pick<NonNullable<DestinationYaml["file"]>, "s3" | "azblob">;

/**
 * A file block's `s3:` and `azblob:`, resolved, each only when written: the connection string's
 * file against `dir`.
 */
function resolveObjectStores(
  file: ObjectYaml,
  dir: string,
): { s3?: S3Config; azblob?: AzblobConfig } {
  const { s3, azblob } = file;
  if (s3 !== undefined) {
    return {
      s3: {
        bucket: s3.bucket,
        region: s3.region,
        endpoint: s3.endpoint,
        pathStyle: s3.pathStyle ?? false,
        timeoutMs: s3.timeout,
        singleNode: s3.singleNode ?? false,
        mode: s3.mode ?? "create",
      },
    };
  }
  if (azblob !== undefined) {
    return {
      azblob: {
        account: azblob.account,
        container: azblob.container,
        endpoint: azblob.endpoint,
        connectionString:
          azblob.connectionString === undefined
            ? undefined
            : secretSourceOf(azblob.connectionString, dir),
        plaintext: azblob.plaintext === true,
        singleNode: azblob.singleNode ?? false,
        mode: azblob.mode ?? "create",
      },
    };
  }
  return {};
}

/** An MLLP block's TLS keys beyond the shared ones, as the YAML wrote them. */
interface MllpTlsYaml {
  readonly minVersion?: MllpTlsChoices["minVersion"];
  readonly profile?: MllpTlsChoices["profile"];
  readonly ciphers?: string | undefined;
  readonly pfx?: string | undefined;
  readonly passphrase?: SecretSourceYaml | undefined;
}

/** An `sftp:` block as the YAML wrote it. */
type SftpYaml = NonNullable<NonNullable<DestinationYaml["file"]>["sftp"]>;

/** A file block's `sftp:`, resolved: `knownHosts` and secret files against `dir`. */
function resolveSftp(sftp: SftpYaml | undefined, dir: string): SftpConfig | undefined {
  if (sftp === undefined) return undefined;
  return {
    host: sftp.host,
    port: sftp.port ?? 22,
    user: sftp.user,
    key: secretSourceOf(sftp.key, dir),
    passphrase: sftp.passphrase === undefined ? undefined : secretSourceOf(sftp.passphrase, dir),
    knownHosts: sftp.knownHosts === undefined ? undefined : resolve(dir, sftp.knownHosts),
    hostKey: sftp.hostKey,
    weakAlgorithms: sftp.weakAlgorithms ?? [],
    connectTimeoutMs: sftp.connectTimeout,
    timeoutMs: sftp.timeout,
    keepaliveMs: sftp.keepalive,
  };
}

/** A tcp block's `framing:`, resolved: hex in lower case, and each default filled in. */
function resolveFraming(framing: TcpFramingYaml): TcpFraming {
  const { delimiter, lengthPrefix, startEnd } = framing;
  if (delimiter !== undefined) return { kind: "delimiter", delimiter: delimiter.toLowerCase() };
  if (lengthPrefix !== undefined) {
    return {
      kind: "lengthPrefix",
      size: lengthPrefix.bytes,
      endian: lengthPrefix.endian ?? "big",
      inclusive: lengthPrefix.inclusive ?? false,
    };
  }
  if (startEnd !== undefined) {
    return {
      kind: "startEnd",
      start: startEnd.start.toLowerCase(),
      end: startEnd.end.toLowerCase(),
    };
  }
  // The schema lets exactly one framing through, so one that is none of the others is raw.
  return { kind: "raw" };
}

/** A source's `poll:`, resolved: its schedule, and its deadline or the default. */
function resolvePoll(poll: PollYaml): PollConfig {
  if (poll === "onStart")
    return { schedule: { kind: "onStart" }, deadlineMs: DEFAULT_POLL_DEADLINE_MS };
  if (typeof poll === "number") {
    return { schedule: { kind: "interval", everyMs: poll }, deadlineMs: DEFAULT_POLL_DEADLINE_MS };
  }
  const deadlineMs = poll.deadline ?? DEFAULT_POLL_DEADLINE_MS;
  if (poll.every !== undefined)
    return { schedule: { kind: "interval", everyMs: poll.every }, deadlineMs };
  if (poll.cron !== undefined) {
    const timezone = poll.timezone ?? "UTC";
    return { schedule: { kind: "cron", expression: poll.cron, timezone }, deadlineMs };
  }
  // The schema lets exactly one of every, cron and onStart through.
  return { schedule: { kind: "onStart" }, deadlineMs };
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
  const connector = resolveConnector(destination, dir, settings);
  // Set only when the block has a timeout:, which the schema lets through for file and module alone.
  const resolved =
    destination.timeout === undefined
      ? connector
      : { ...connector, timeoutMs: destination.timeout };
  if (destination.retry === undefined) return resolved;
  return { ...resolved, retry: mergeRetry(settings.retry, destination.retry) };
}

function resolveConnector(
  destination: DestinationYaml,
  dir: string,
  settings: Settings,
): ChannelConfig["destinations"][number] {
  const { http, mllp, smtp, tcp } = destination;
  const module = resolveModule(destination, dir);
  if (module !== undefined) return module;
  if (smtp !== undefined) {
    return resolveSmtp(smtp, dir, destination.timeout ?? DEFAULT_DELIVERY_TIMEOUT_MS);
  }
  if (tcp !== undefined) {
    return {
      kind: "tcp",
      host: tcp.host,
      port: tcp.port,
      tls: tcp.tls === undefined ? undefined : resolveClientTls(tcp.tls, dir),
      plaintext: tcp.plaintext === true,
      framing: resolveFraming(tcp.framing),
      maxMessageSize: tcp.maxMessageSize ?? DEFAULT_MAX_BYTES,
      timeoutMs: tcp.timeout ?? DEFAULT_TCP_TIMEOUT_MS,
      expectReply: tcp.expectReply === true,
      replyCheck: tcp.replyCheck === undefined ? undefined : resolve(dir, tcp.replyCheck),
    };
  }
  if (mllp !== undefined) {
    return {
      kind: "mllp",
      host: mllp.host,
      port: mllp.port,
      tls: mllp.tls === undefined ? undefined : resolveMllpClientTls(mllp.tls, dir),
      plaintext: mllp.plaintext === true,
      ackTimeoutMs: mllp.ackTimeout ?? settings.ackTimeoutMs,
    };
  }
  if (http === undefined) {
    // The schema lets exactly one kind through, so a destination that is not HTTP is a file one.
    const file = destination.file as NonNullable<typeof destination.file>;
    const sftp = resolveSftp(file.sftp, dir);
    const objects = resolveObjectStores(file, dir);
    const remote = sftp !== undefined || objects.s3 !== undefined || objects.azblob !== undefined;
    return { kind: "file", dir: remote ? file.dir : resolve(dir, file.dir), sftp, ...objects };
  }
  return {
    kind: "http",
    ...resolveHttpClient(http, dir),
    timeoutMs: http.timeout ?? DEFAULT_HTTP_TIMEOUT_MS,
    resendHeader: http.resendHeader,
  };
}

/** An `smtp:` block as the YAML wrote it. */
type SmtpYaml = NonNullable<DestinationYaml["smtp"]>;

/** The port each way of running SMTP listens on by default: 465, 587, or 25 without TLS. */
const SMTP_PORTS = { implicit: 465, starttls: 587, none: 25 } as const;

/**
 * An `smtp:` block, resolved: its CA and secret files against `dir`, and every default filled in,
 * each time limit no longer than `totalMs`, the delivery's own.
 */
function resolveSmtp(smtp: SmtpYaml, dir: string, totalMs: number): SmtpDestination {
  const tls = smtp.tls === undefined ? undefined : (smtp.tls.mode ?? "implicit");
  const within = (written: number | undefined, fallback: number): number =>
    written ?? Math.min(fallback, totalMs);
  return {
    kind: "smtp",
    host: smtp.host,
    port: smtp.port ?? SMTP_PORTS[tls ?? "none"],
    tls,
    ca: smtp.tls?.ca === undefined ? undefined : resolve(dir, smtp.tls.ca),
    plaintext: smtp.plaintext === true,
    user: smtp.user === undefined ? undefined : secretSourceOf(smtp.user, dir),
    password: smtp.password === undefined ? undefined : secretSourceOf(smtp.password, dir),
    from: smtp.from,
    to: smtp.to,
    cc: smtp.cc ?? [],
    subject: smtp.subject ?? DEFAULT_SMTP_SUBJECT,
    body: smtp.body ?? DEFAULT_SMTP_BODY,
    attach: smtp.attach ?? false,
    onPartialRefusal: smtp.onPartialRefusal ?? "rejected",
    maxBytes: smtp.maxSize ?? DEFAULT_MAX_BYTES,
    connectTimeoutMs: within(smtp.connectTimeout, DEFAULT_SMTP_CONNECT_TIMEOUT_MS),
    greetingTimeoutMs: within(smtp.greetingTimeout, DEFAULT_SMTP_GREETING_TIMEOUT_MS),
    socketTimeoutMs: within(smtp.socketTimeout, DEFAULT_SMTP_SOCKET_TIMEOUT_MS),
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

/** An MLLP block's TLS keys beyond the shared ones, resolved: only those the YAML set. */
function resolveMllpTls(tls: MllpTlsYaml, dir: string): MllpTlsChoices {
  return {
    ...(tls.minVersion === undefined ? {} : { minVersion: tls.minVersion }),
    ...(tls.profile === undefined ? {} : { profile: tls.profile }),
    ...(tls.ciphers === undefined ? {} : { ciphers: tls.ciphers }),
    ...(tls.pfx === undefined ? {} : { pfx: resolve(dir, tls.pfx) }),
    ...(tls.passphrase === undefined ? {} : { passphrase: secretSourceOf(tls.passphrase, dir) }),
  };
}

/** An MLLP source's `tls:`, resolved against `dir`. */
function resolveMllpServerTls(
  tls: MllpTlsYaml & {
    cert?: string | undefined;
    key?: string | undefined;
    ca?: string | undefined;
  },
  dir: string,
): MllpServerTlsFiles {
  const at = (file: string | undefined): string | undefined =>
    file === undefined ? undefined : resolve(dir, file);
  return { cert: at(tls.cert), key: at(tls.key), ca: at(tls.ca), ...resolveMllpTls(tls, dir) };
}

/** An MLLP destination's `tls:`, resolved against `dir`. */
function resolveMllpClientTls(
  tls: MllpTlsYaml & {
    cert?: string | undefined;
    key?: string | undefined;
    ca?: string | undefined;
  },
  dir: string,
): MllpClientTlsFiles {
  return { ...resolveClientTls(tls, dir), ...resolveMllpTls(tls, dir) };
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
    retention?: RetentionYaml;
    resendFlag?: boolean | undefined;
    retentionInterval?: number | undefined;
    content?: ContentPolicy | undefined;
    passTimeout?: number | undefined;
    retry?: RetryYaml | undefined;
  },
): Settings {
  return {
    timeoutMs: override.timeout ?? base.timeoutMs,
    memoryMb: override.memory ?? base.memoryMb,
    pollIntervalMs: override.pollInterval ?? base.pollIntervalMs,
    onStoreFailure: override.onStoreFailure ?? base.onStoreFailure,
    ackTimeoutMs: override.ackTimeout ?? base.ackTimeoutMs,
    resendFlag: override.resendFlag ?? base.resendFlag,
    retentionIntervalMs: override.retentionInterval ?? base.retentionIntervalMs,
    ...mergeRetention(base, override.retention),
    content: override.content ?? base.content,
    // Set only by a channel with content: none, so every other channel's settings are as before.
    ...(override.passTimeout === undefined ? {} : { passTimeoutMs: override.passTimeout }),
    retry: override.retry === undefined ? base.retry : mergeRetry(base.retry, override.retry),
  };
}

/** A `retention:` value as parsed: the shorthand duration, or the block written out. */
type RetentionYaml =
  | number
  | {
      readonly content?: number | undefined;
      readonly metadata?: number | undefined;
      readonly failed?: number | undefined;
    }
  | undefined;

/**
 * `retention`'s clocks over `base`'s, key by key. The shorthand sets the metadata clock alone; a
 * block written out sets the clocks it names and turns the others on with what `base` holds.
 */
function mergeRetention(
  base: Settings,
  retention: RetentionYaml,
): Pick<Settings, "retentionMs" | "retentionClocks"> {
  const inherited =
    base.retentionClocks === undefined ? {} : { retentionClocks: base.retentionClocks };
  if (retention === undefined) return { retentionMs: base.retentionMs, ...inherited };
  if (typeof retention === "number") return { retentionMs: retention, ...inherited };
  const contentMs = retention.content ?? base.retentionClocks?.contentMs;
  const failedMs = retention.failed ?? base.retentionClocks?.failedMs;
  return {
    retentionMs: retention.metadata ?? base.retentionMs,
    retentionClocks: {
      ...(contentMs === undefined ? {} : { contentMs }),
      ...(failedMs === undefined ? {} : { failedMs }),
    },
  };
}

/** A problem when the metadata clock in force is shorter than the content clock. */
function retentionProblem(file: string, settings: Settings): string[] {
  const contentMs = settings.retentionClocks?.contentMs;
  if (contentMs === undefined || settings.retentionMs >= contentMs) return [];
  return [
    `${file}: retention.metadata: ${String(settings.retentionMs)}ms is shorter than retention.content, ${String(contentMs)}ms; a message's row must outlive its content`,
  ];
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
