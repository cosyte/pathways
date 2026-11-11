import { existsSync } from "node:fs";
import { stderr } from "node:process";
import { parseArgs } from "node:util";

import { pino, type Logger } from "pino";

import { ConfigError, loadProject } from "./config/load.js";
import type { ProjectConfig } from "./config/schema.js";
import type { Env } from "./connectors/endpoint.js";
import { EncryptionError } from "./encryption/envelope.js";
import { ENCRYPTION_REQUIRED, type KeyProvider } from "./encryption/keys.js";
import { rekey, rekeyComplete, type RekeyCounts } from "./encryption/rekey.js";
import { TransformLoadError } from "./engine/channel-worker.js";
import { Engine, errorCode } from "./engine/engine.js";
import {
  healthEndpointFor,
  type EngineIdentity,
  type HealthEndpoint,
  type HealthReport,
} from "./engine/health.js";
import {
  describeHolder,
  EngineLease,
  LeaseCheckFailed,
  nodeId,
  type LeaseLossReason,
} from "./engine/lease.js";
import {
  askProbe,
  engineProbes,
  probeEndpointFor,
  type EngineState,
  type ProbeEndpoint,
} from "./engine/probes.js";
import { EXIT } from "./exit.js";
import { HookSet } from "./extensions/hooks.js";
import { ExtensionLoadError } from "./extensions/load.js";
import { AuditLog, auditEvent, type AuditListener } from "./operator/audit.js";
import {
  auditCommand,
  clearCommand,
  DEFAULT_LIMIT,
  isChannelName,
  leaseReleaseCommand,
  leaseStatusCommand,
  listCommand,
  migrateCommand,
  parseAction,
  parseId,
  parseLimit,
  parseState,
  parseTime,
  replayCommand,
  retentionCommand,
  showCommand,
  statusCommand,
  type OperatorContext,
} from "./operator/commands.js";
import { recordConfigChanges } from "./operator/config-audit.js";
import { verifyCommand, type VerifySelection } from "./operator/verify.js";
import { InitError, initProject, STARTER_CHANNEL, STARTER_KEY_FILE } from "./starter/init.js";
import { resolveSecrets, type Secrets } from "./secrets/resolve.js";
import type { SecretScope } from "./secrets/sources.js";
import { openRawStore, openStore, startingKeys, type OpenStoreContext } from "./storage/open.js";
import { SchemaVersionError } from "./storage/schema.js";
import {
  isContentStore,
  leaseStore,
  LeaseLostError,
  migrations,
  StorageError,
  type MessageStore,
  type Store,
} from "./storage/store.js";
import { describeFailure, runChannelTests } from "./testing/run-tests.js";
import { VERSION } from "./version.js";

export { EXIT } from "./exit.js";

/** Where the CLI writes, and what it runs with. The process entry passes the real ones. */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Aborts `pathways start`. The process entry wires it to SIGINT and SIGTERM. */
  readonly signal?: AbortSignal;
  /** The engine's logger. Defaults to JSON lines on stdout. */
  readonly logger?: Logger;
  /**
   * Where tokens, secret headers, master keys and the settings written as `{ env: NAME }` are read
   * from. Defaults to `process.env`.
   */
  readonly env?: Env;
  /**
   * Told of every audit entry a command writes, once it is stored: replays, resends, clears,
   * searches and views, retention runs and configuration changes. The engine-wide lifecycle hooks
   * in `pathways.yaml` receive the same entries as `audit` events.
   */
  readonly onAudit?: AuditListener;
}

const HELP = `Usage: pathways <command> [options]

Pathways is a code-first healthcare integration engine. It is early.

Commands:
  init [dir]          Write a starter project, with one channel and its tests,
                      into dir (default: the project folder), which must be
                      empty or not exist yet
  start               Run every channel, and the health endpoint if
                      pathways.yaml configures one, until stopped. Needs
                      pathways.yaml's encryption: its keys, or none. Retention
                      runs at start and then every retentionInterval. Takes
                      the engine lease first: a second engine on the same
                      database is refused. Applies the database's missing
                      expand schema steps first, unless --no-migrate
  test [name...]      Run each channel's tests/ inputs through its transform
                      and compare the output with the saved .expected files
  verify              Run stored messages, or samples, through this project's
                      transforms and compare each output with the recorded
                      one, per channel and destination: same, different (a
                      field path, JSON pointer or byte offset, never a value)
                      or failed. Writes nothing to the message tables and
                      applies no schema step; each stored message read is
                      written to the audit log first
  validate            Check pathways.yaml and every channel.yaml as start
                      does, with every file they name, without reading a
                      secret or opening a connection: for a project's CI.
                      Settings written as { env: NAME } are read as start
                      reads them
  status [name...]    Each channel's counts, retrying deliveries and failed
                      messages, read from the database
  messages            List stored messages, newest first: ids, states, times,
                      sizes and duplicate flags, never content
  messages show <id>  One message and its deliveries; its content only with
                      --content
  replay <id...>      Run each message through its channel's transform again
                      and queue fresh deliveries behind those waiting
  clear <id...>       Mark failed messages cleared, so they leave the failed
                      count and retention can delete them
  retention           Delete delivered, filtered and cleared messages past
                      their channel's retention period (default 30d)
  audit               Read the audit log, newest first
  rekey               Re-encrypt every stored message under the current key
                      of pathways.yaml's encryption, so older keys can be
                      retired
  probe [--ready] [--if-configured]
                      Ask the running engine's probe listener (pathways.yaml's
                      probes block) whether it is alive, or with --ready
                      whether it is ready for traffic: exits 0 if so, 1 if
                      not. For a container's health check
  lease status        Who holds the engine lease, since when, its epoch and
                      the time it has left
  lease release --force
                      Free the engine lease of an engine whose host is gone,
                      so the next start takes it at once. Audited
  migrate             Apply the schema steps this version has and the
                      database lacks, each tagged expand or contract: expand
                      steps always, contract steps with --contract. Audited

The commands that read or change stored messages open the database as start
does, so they need the same encryption keys.

Options:
  -C, --project <dir>   The project folder (default: the current folder)
      --once            start: take in, transform and deliver what is
                        waiting, then exit
      --standby         start: hold no lease and open no source until the
                        engine holding the lease stops, then take over.
                        Needs a database server
      --ready           probe: ask /readyz in place of /livez
      --if-configured   probe: exit 0 when pathways.yaml has no probes block,
                        as the Docker image's health check does
      --no-migrate      start: apply no schema step; refuse a database that
                        lacks one this version needs
      --contract        migrate: apply contract steps too, unless the schema
                        changed within migrations.rollbackWindow. It does
                        not see which versions other engines run: stop or
                        upgrade them first
      --force           lease release: say the lease's host is gone
      --update          test: save the current outputs as the expected ones
      --print           validate: print the configuration as start reads it,
                        as JSON, with each setting read from the environment
                        and the variable it named; secrets stay references
      --json            status, messages, replay, clear, retention, audit,
                        lease, migrate, verify: print one JSON document
                        instead of text
      --channel <name>  messages, audit, verify: only this channel
      --status <state>  messages: only this state: received, queued, retrying,
                        delivered, dry-run, filtered, failed or cleared
      --since <time>    messages, audit, verify: from this time: 2026-11-07,
                        2026-11-07T12:00:00Z (UTC unless a zone is given), or
                        a duration ago, such as 24h or 7d. verify: default 24h
      --ids <id,...>    verify: these stored messages, by id
      --samples <dir>   verify: the inputs in dir/<channel>/ instead of stored
                        messages, each against its .expected file, as in tests/
      --until <time>    messages, audit: before this time
      --limit <n>       messages, audit: at most n rows (default ${DEFAULT_LIMIT}, at most 1000)
      --before <id>     messages, audit: the next page, as the last one says
      --content         messages show: print the content, which is PHI. The
                        view is written to the audit log first
      --resend          replay: send the stored outputs again, untransformed
      --dry-run         start: run every destination dry: transform and
                        record each output, mark its delivery dry-run, send
                        nothing. retention: say what would be deleted, delete
                        nothing. migrate: say which steps would be applied,
                        apply none
      --action <name>   audit: only this action: search, view, content-view,
                        replay, resend, clear, retention, config,
                        lease-release, migrate or verify
      --message <id>    audit: only entries about this message
      --encrypt-plaintext
                        rekey: also encrypt what was stored while encryption
                        was none
  -h, --help            Show this help
  -v, --version         Print the version

Every replay, resend, clear, search, view and content view is written to the
audit log with the operating system user, as are retention runs and the
configuration changes pathways start sees. The hooks in pathways.yaml receive
each entry as an audit event.

Exit codes: 0 done; 1 a test failed, the engine, a command or an extension
module could not start or stopped on an error, init could not write the
project, rekey left a value not under the current key, a replay, resend or
clear was refused or the message failed again, another engine holds the lease,
the engine lost its lease, there was no lease to release, the database schema
is one this version will not run on or migrate, verify found a difference or a
failure, or probe found the engine not alive or not ready (probe exits only 0
or 1); 2 the command line was not
understood; 3 the configuration is invalid; 4 a message named does not exist.
`;

/** Redaction paths for the engine's logger, in case a field that can hold content is ever logged. */
const REDACT = ["body", "*.body", "detail", "*.detail"];

/** The logger of a command whose stdout is its report: JSON lines on stderr. */
const STDERR_LOG = { redact: REDACT };

type Values = ReturnType<typeof parseCli>["values"];
type OptionName = Exclude<keyof Values, "help" | "version" | "project">;

/** The options each command takes, beyond --project, --help and --version. */
const OPTIONS: Readonly<Record<string, readonly OptionName[]>> = {
  init: [],
  start: ["once", "standby", "no-migrate", "dry-run"],
  test: ["update"],
  validate: ["print"],
  status: ["json"],
  messages: ["json", "channel", "status", "since", "until", "limit", "before", "content"],
  replay: ["json", "resend"],
  clear: ["json"],
  retention: ["json", "dry-run"],
  audit: ["json", "action", "message", "channel", "since", "until", "limit", "before"],
  rekey: ["encrypt-plaintext"],
  lease: ["json", "force"],
  verify: ["json", "channel", "since", "ids", "samples"],
  probe: ["ready", "if-configured"],
  migrate: ["json", "contract", "dry-run"],
};

/**
 * Runs the `pathways` command with the given arguments.
 *
 * Errors never repeat what the caller typed: an argument can hold a path or a value from a
 * message, and stderr often ends up in a log.
 *
 * @example
 * ```ts
 * const code = await run(["test"], { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) });
 * ```
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch {
    io.err('pathways: unknown option. Run "pathways --help" for usage.\n');
    return EXIT.usage;
  }
  const { values, positionals } = parsed;

  if (values.version === true) {
    io.out(`${VERSION}\n`);
    return EXIT.ok;
  }
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) {
    io.out(HELP);
    return EXIT.ok;
  }

  const allowed = OPTIONS[command];
  if (allowed === undefined) {
    io.err('pathways: unknown command. Run "pathways --help" for usage.\n');
    return EXIT.usage;
  }
  const given = (Object.keys(values) as (keyof Values)[]).filter(
    (name) => name !== "help" && name !== "version" && name !== "project",
  );
  if (given.some((name) => !(allowed as readonly string[]).includes(name))) return usage(io);

  const projectDir = values.project ?? process.cwd();
  switch (command) {
    case "init":
      if (rest.length > 1 || (rest.length === 1 && values.project !== undefined)) return usage(io);
      return init(rest[0] ?? projectDir, io);
    case "start":
      if (rest.length > 0) return usage(io);
      if (values.once === true && values.standby === true) return usage(io);
      return start(
        projectDir,
        {
          once: values.once === true,
          standby: values.standby,
          noMigrate: values["no-migrate"] === true,
          dryRun: values["dry-run"] === true,
        },
        io,
      );
    case "test":
      return test(projectDir, rest, values.update === true, io);
    case "validate":
      if (rest.length > 0) return usage(io);
      return validate(projectDir, values.print === true, io);
    case "rekey":
      if (rest.length > 0) return usage(io);
      return rekeyStore(projectDir, values["encrypt-plaintext"] === true, io);
    case "verify": {
      const parsed = parseVerify(rest, values, io);
      if (typeof parsed === "number") return parsed;
      if (parsed.selection.kind === "samples") {
        return verifySamples(projectDir, parsed, values.json === true, io);
      }
      return operator(command, rest, values, projectDir, io);
    }
    case "probe":
      if (rest.length > 0) return usage(io);
      return probe(
        projectDir,
        { ready: values.ready === true, ifConfigured: values["if-configured"] === true },
        io,
      );
    default:
      return operator(command, rest, values, projectDir, io);
  }
}

function usage(io: CliIo): number {
  io.err(
    'pathways: that option does not apply to this command. Run "pathways --help" for usage.\n',
  );
  return EXIT.usage;
}

function invalid(io: CliIo, what: string): number {
  io.err(`pathways: ${what} Run "pathways --help" for usage.\n`);
  return EXIT.usage;
}

async function init(target: string, io: CliIo): Promise<number> {
  let files: string[];
  try {
    files = await initProject(target);
  } catch (error) {
    /* v8 ignore next: initProject rejects only with InitError */
    if (!(error instanceof InitError)) throw error;
    io.err(
      `pathways: ${INIT_REFUSALS[error.reason]}${error.code === undefined ? "" : ` (${error.code})`}\n`,
    );
    return EXIT.failed;
  }
  io.out(
    `Wrote a starter project with one channel, ${STARTER_CHANNEL}:\n` +
      files.map((file) => `  ${file}\n`).join("") +
      `${STARTER_KEY_FILE} is a development key that encrypts stored messages on\n` +
      "this machine; production keys come from a secret store (see pathways.yaml).\n" +
      // The key is written with mode 0600, which Linux and macOS enforce. On Windows Node maps a
      // mode to the read-only attribute alone, so there the folder's access list is the control.
      (process.platform === "win32"
        ? "On Windows the key file's mode does not limit who can read it: the project\n" +
          "folder's access control list does, so keep it to the accounts that run Pathways.\n"
        : "") +
      'Next, in the project folder: "pathways test" runs the channel\'s tests, and\n' +
      '"pathways start" runs the channel.\n',
  );
  return EXIT.ok;
}

/** What `pathways init` says when it stops. None names the folder: the caller typed it. */
const INIT_REFUSALS: Readonly<Record<InitError["reason"], string>> = {
  "not-empty":
    "init writes only into an empty folder or a new one, and this one is not empty. Nothing was changed.",
  "not-a-folder": "init needs a folder, and that path is a file. Nothing was changed.",
  io: "the starter project could not be written",
};

async function load(projectDir: string, io: CliIo): Promise<ProjectConfig | undefined> {
  try {
    return await loadProject(projectDir, { env: io.env ?? process.env });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    reportConfigError(error, io);
    return undefined;
  }
}

function reportConfigError(error: ConfigError, io: CliIo): void {
  io.err(
    `pathways: the configuration is invalid:\n${error.problems.map((p) => `  ${p}\n`).join("")}`,
  );
}

/**
 * The secrets `scope` reads that a provider `secrets:` names holds, resolved now, or, when they
 * cannot be had, the exit code, having said why: `config` for a secret, named by file and key and
 * never by value; `failed` for a provider's module, named by file and key.
 */
async function secretsOrExit(
  project: ProjectConfig,
  context: OpenStoreContext & { readonly signal?: AbortSignal | undefined },
  scope: SecretScope,
  io: CliIo,
): Promise<Secrets | number> {
  if (context.secrets !== undefined) return context.secrets;
  try {
    return await resolveSecrets(project, context, scope);
  } catch (error) {
    if (error instanceof ExtensionLoadError) {
      io.err(`pathways: ${error.message}\n`);
      return EXIT.failed;
    }
    /* v8 ignore next: the rest throw only ConfigError */
    if (!(error instanceof ConfigError)) throw error;
    reportConfigError(error, io);
    return EXIT.config;
  }
}

/**
 * The key provider `pathways.yaml` names, read or loaded now (`undefined` for `encryption: none`), or,
 * when it cannot be had, the exit code, having said why.
 */
async function keysOrExit(
  project: ProjectConfig,
  context: OpenStoreContext,
  io: CliIo,
): Promise<KeyProvider | undefined | number> {
  try {
    return await startingKeys(project, context);
  } catch (error) {
    if (error instanceof ExtensionLoadError) {
      io.err(`pathways: ${error.message}\n`);
      return EXIT.failed;
    }
    /* v8 ignore next: the rest throw only ConfigError */
    if (!(error instanceof ConfigError)) throw error;
    reportConfigError(error, io);
    return EXIT.config;
  }
}

/**
 * Says why the store could not be opened, and returns the exit code: `config` for a connection URL,
 * TLS file or driver package that cannot be had; `failed` for a custom store's module, named by file
 * and key, or a database that cannot be opened, named by its driver's code. None names the
 * database, its server or its login.
 */
function reportStoreError(error: unknown, io: CliIo, command = "start"): number {
  if (error instanceof ConfigError) {
    reportConfigError(error, io);
    return EXIT.config;
  }
  if (error instanceof ExtensionLoadError) {
    io.err(`pathways: ${error.message}\n`);
    return EXIT.failed;
  }
  if (error instanceof SchemaVersionError) {
    const hint =
      command === "verify"
        ? " Run pathways migrate first: verify applies no schema step."
        : " Run pathways migrate first, or start without --no-migrate.";
    io.err(`pathways: ${error.message}.${error.reason === "schema-too-old" ? hint : ""}\n`);
    return EXIT.failed;
  }
  const refusal = error instanceof StorageError ? STORAGE_REFUSALS[error.reason] : undefined;
  const code = errorCode(error);
  io.err(
    `pathways: ${refusal ?? STORAGE_REFUSALS.open}${code === undefined ? "" : ` (${code})`}.\n`,
  );
  return EXIT.failed;
}

/** What `pathways` says when a database will not open. */
const STORAGE_REFUSALS: Readonly<Record<StorageError["reason"], string>> = {
  open: "the database could not be opened",
  schema: "the database schema could not be brought up to date",
};

/**
 * Opens the project's store as every command that reads or writes messages does, through
 * `src/storage/open.ts`: the store `pathways.yaml` names, wrapped in encryption at rest under its
 * keys (read now, like every other secret), or in the plaintext store for `encryption: none`.
 * Returns the exit code when it cannot, having said why.
 */
async function openWrapped(
  project: ProjectConfig,
  given: OpenStoreContext,
  io: CliIo,
  command?: string,
): Promise<{ readonly store: MessageStore; readonly encrypted: boolean } | number> {
  const secrets = await secretsOrExit(project, given, "store", io);
  if (typeof secrets === "number") return secrets;
  const context = { ...given, secrets };
  const keys = await keysOrExit(project, context, io);
  if (typeof keys === "number") return keys;
  const { storage } = project;
  if (storage.kind !== "sqlite" && storage.kind !== "module" && storage.plaintext) {
    context.logger.warn({ event: "plaintext", endpoint: "storage" });
  }
  try {
    return { store: await openStore(project, { ...context, keys }), encrypted: keys !== undefined };
  } catch (error) {
    return reportStoreError(error, io, command);
  }
}

/** The audit log a command writes to, with `io.onAudit` subscribed. */
function auditFor(store: MessageStore, io: CliIo, onListenerError: (error: unknown) => void) {
  const audit = new AuditLog(store, { onListenerError });
  if (io.onAudit !== undefined) audit.subscribe(io.onAudit);
  return audit;
}

/**
 * The schema generation this version brings a built-in store to: its number of schema steps, the
 * generation of its last step. The same on every database, since each runs the same steps under the
 * same names.
 */
const SCHEMA_GENERATION = Object.keys(migrations("sqlite")).length;

/**
 * How `pathways start` runs: one pass, or as a standby (`undefined` leaves it to pathways.yaml), and
 * with every destination dry or not.
 */
interface StartMode {
  readonly once: boolean;
  readonly standby: boolean | undefined;
  /** Apply no schema step, and refuse a database that lacks one this version needs. */
  readonly noMigrate: boolean;
  /** Run every destination dry: record each output, send nothing. */
  readonly dryRun: boolean;
}

async function start(projectDir: string, mode: StartMode, io: CliIo): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  const standby = mode.standby ?? (project.lease.standby && !mode.once);
  const { once } = mode;
  if (standby && project.storage.kind === "sqlite") {
    io.err("pathways: a standby needs a database server; on SQLite a second engine is refused.\n");
    return EXIT.config;
  }
  const env = io.env ?? process.env;
  const logger = io.logger ?? pino({ redact: REDACT });
  // Every secret is read now, at startup, master keys among them: a missing one stops the start.
  const secrets = await secretsOrExit(project, { env, logger, signal: io.signal }, "all", io);
  if (typeof secrets === "number") return secrets;
  const context: OpenStoreContext = mode.noMigrate
    ? { env, logger, secrets, migrate: "none" }
    : { env, logger, secrets };
  const opened = await openWrapped(project, context, io);
  if (typeof opened === "number") return opened;
  const { store } = opened;
  if (!opened.encrypted) logger.warn({ event: "unencrypted-storage" });

  // The engine lease, taken before any source opens. A store without lease methods runs as before.
  const leases = leaseStore(store);
  if (leases === undefined && standby) {
    await store.close();
    io.err("pathways: a standby needs a store with leases, and this custom store has none.\n");
    return EXIT.failed;
  }
  if (leases === undefined) logger.warn({ event: "lease-unsupported" });
  // Said once at start, so a log reader knows why nothing goes out.
  if (mode.dryRun) logger.warn({ event: "dry-run", destinations: "all" });
  // Aborted by the caller's signal, or at once when the lease is lost.
  const stopping = new AbortController();
  const signal = AbortSignal.any([io.signal ?? new AbortController().signal, stopping.signal]);
  // Where this engine stands, for readiness and the health body. Told to stop, it drains: its
  // sources close while the probes still answer, 503 draining.
  let state: EngineState = standby ? "standby" : "starting";
  const lease =
    leases === undefined
      ? undefined
      : new EngineLease({
          store: leases,
          ttlMs: project.lease.ttlMs,
          onLost: (reason) => {
            logger.error({ event: "lease-lost", reason, epoch: lease?.epoch });
            state = "fenced";
            stopping.abort();
          },
        });
  signal.addEventListener("abort", () => {
    if (state !== "fenced") state = "draining";
  });
  const node = lease?.claimant.node ?? nodeId();
  const identity = (): EngineIdentity => ({
    version: VERSION,
    schemaGeneration: project.storage.kind === "module" ? null : SCHEMA_GENERATION,
    node,
    role: lease === undefined ? "single" : state === "standby" ? "standby" : "active",
    leaseEpoch: lease?.epoch ?? null,
    draining: state === "draining",
  });

  const audit = auditFor(store, io, (error) => {
    logger.warn({ event: "audit-listener-failed", code: errorCode(error) });
  });
  const engine = new Engine({
    project,
    store,
    logger,
    env,
    secrets,
    audit,
    dryRun: mode.dryRun,
    ...(lease === undefined ? {} : { fence: lease }),
  });
  let active = !standby;
  const report = async (): Promise<HealthReport> => {
    // A standby answers 503 with no counts until it takes the lease.
    const { channels, ...engineHealth } = active
      ? await engine.health()
      : { status: "standby" as const, storage: "ok" as const, channels: {} };
    return { ...engineHealth, ...identity(), channels };
  };
  const probes = engineProbes({
    state: () => state,
    live: () => engine.live(),
    ready: () => engine.ready(),
  });
  let health: HealthEndpoint | undefined;
  let probeListener: ProbeEndpoint | undefined;
  // A single pass serves neither: it would hold the ports a running engine needs.
  if (!once) {
    try {
      if (project.health !== undefined) {
        health = healthEndpointFor(project.health, report, secrets, logger, probes);
      }
      if (project.probes !== undefined) probeListener = probeEndpointFor(project.probes, probes);
    } catch (error) {
      await store.close();
      /* v8 ignore next: healthEndpointFor throws only ConfigError */
      if (!(error instanceof ConfigError)) throw error;
      reportConfigError(error, io);
      return EXIT.config;
    }
  }

  try {
    // The probes answer from the first moment: starting, or standby, before the lease is taken.
    if (!(await listen(probeListener, "the probe listener", io))) return EXIT.failed;
    if (lease !== undefined) {
      const taken = await takeLease(lease, { standby, health, signal, logger, io });
      if (taken !== true) return taken;
      if (state === "standby") state = "starting";
    }
    return await runEngine(engine, project, store, audit, io, {
      once,
      signal,
      lease,
      // A standby's endpoint is listening already.
      health: standby ? undefined : health,
      logger,
      onActive: () => {
        active = true;
      },
      onRunning: () => {
        if (state === "starting") state = "running";
      },
      onStopping: () => {
        if (state !== "fenced") state = "draining";
      },
      onFenced: () => {
        state = "fenced";
      },
    });
  } finally {
    // The engine has stopped, its sources closed, before the probes stop answering.
    await probeListener?.stop();
    await health?.stop();
    await lease?.release().catch((error: unknown) => {
      logger.warn({ event: "lease-release-failed", code: errorCode(error) });
    });
    await store.close();
  }
}

/** Starts the health endpoint, if there is one; says why and returns false when it cannot listen. */
function listenHealth(health: HealthEndpoint | undefined, io: CliIo): Promise<boolean> {
  return listen(health, "the health endpoint", io);
}

/** Starts a listener, if there is one; says why and returns false when it cannot listen. */
async function listen(
  listener: { start(): Promise<void> } | undefined,
  name: string,
  io: CliIo,
): Promise<boolean> {
  try {
    await listener?.start();
    return true;
  } catch (error) {
    io.err(`pathways: ${name} could not listen (${String(errorCode(error))}).\n`);
    return false;
  }
}

/**
 * Takes the engine lease: at once, or as a standby once the holder stops. Returns true when it is
 * held, or the exit code, having said why not: another engine holds it (naming the holder: node,
 * host, since, epoch and time left, never a URL), the database refused, or a standby was stopped.
 */
async function takeLease(
  lease: EngineLease,
  run: {
    readonly standby: boolean;
    readonly health: HealthEndpoint | undefined;
    readonly signal: AbortSignal;
    readonly logger: Logger;
    readonly io: CliIo;
  },
): Promise<true | number> {
  const { logger, io } = run;
  try {
    if (run.standby) {
      // A standby serves health (standby, 503) and nothing else until it holds the lease.
      if (!(await listenHealth(run.health, io))) return EXIT.failed;
      logger.info({ event: "standby", node: lease.claimant.node });
      const taken = await lease.waitFor(run.signal, (holder) => {
        logger.info({ event: "standby-waiting", holder: holder.node, epoch: holder.epoch });
      });
      if (!taken) return EXIT.ok;
    } else {
      const claim = await lease.acquire();
      if (!claim.acquired) {
        io.err(
          `pathways: another engine holds the engine lease on this database: ${describeHolder(claim.holder)}. ` +
            "Stop it first, or start this one with --standby to take over when it stops.\n",
        );
        return EXIT.failed;
      }
    }
  } catch (error) {
    // The database refused the request or went away; its own text can name the server.
    const code = errorCode(error);
    io.err(
      `pathways: the engine lease could not be taken${code === undefined ? "" : ` (${code})`}.\n`,
    );
    return EXIT.failed;
  }
  logger.info({ event: "lease-acquired", node: lease.claimant.node, epoch: lease.epoch });
  return true;
}

/** Says the engine stopped on a lost lease, and returns the exit code for its supervisor. */
function leaseLost(io: CliIo, reason: LeaseLossReason): number {
  io.err(
    `pathways: the engine lease was lost (${reason}); this engine stopped sending and taking in. Another engine may hold it now.\n`,
  );
  return EXIT.failed;
}

/**
 * Starts the engine under a held lease (or none), records configuration changes, starts the health
 * endpoint when it is not listening yet, and runs until `signal` aborts (or one pass). Returns the
 * exit code, having said why on a failure; stops the engine before it returns.
 */
async function runEngine(
  engine: Engine,
  project: ProjectConfig,
  store: MessageStore,
  audit: AuditLog,
  io: CliIo,
  run: {
    readonly once: boolean;
    readonly signal: AbortSignal;
    readonly lease: EngineLease | undefined;
    readonly health: HealthEndpoint | undefined;
    readonly logger: Logger;
    readonly onActive: () => void;
    /** The engine loop is about to start: ready for traffic. */
    readonly onRunning: () => void;
    /** The engine is about to stop, its sources to close. */
    readonly onStopping: () => void;
    /** The engine lease was found lost, or a write was refused under its epoch. */
    readonly onFenced: () => void;
  },
): Promise<number> {
  try {
    await engine.start();
  } catch (error) {
    if (error instanceof ConfigError) {
      reportConfigError(error, io);
      return EXIT.config;
    }
    if (error instanceof ExtensionLoadError) {
      io.err(`pathways: ${error.message}\n`);
      return EXIT.failed;
    }
    if (!(error instanceof TransformLoadError)) throw error;
    const channel = project.channels.find((c) => c.name === error.channel);
    /* v8 ignore next: the engine names only channels it was given */
    const detail =
      channel === undefined ? error.failure.name : describeFailure(error.failure, channel);
    io.err(`pathways: channel ${error.channel}: ${detail}\n`);
    return EXIT.failed;
  }
  run.onActive();

  try {
    try {
      // After the engine has started, so its hooks receive these entries too.
      await recordConfigChanges(project, store, audit);
    } catch {
      io.err("pathways: the audit log could not be written.\n");
      return EXIT.failed;
    }
    if (!(await listenHealth(run.health, io))) return EXIT.failed;
    run.onRunning();
    if (run.once) await engine.tick();
    else await engine.run(run.signal);
  } catch (error) {
    // The lease was found lost before a send or a take: logged when it was lost.
    if (error instanceof LeaseCheckFailed) {
      run.onFenced();
      return leaseLost(io, error.reason);
    }
    if (error instanceof LeaseLostError) {
      run.onFenced();
      // A write the database refused under this engine's epoch: logged as such even when a late
      // renewal was noticed first, since the refusal is what shows another engine took over.
      if (run.lease?.lossReason === undefined) run.lease?.writeRefused();
      else
        run.logger.error({ event: "lease-lost", reason: "write-refused", epoch: run.lease.epoch });
      return leaseLost(io, "write-refused");
    }
    // A stored value that cannot be decrypted stops the engine, as any storage failure does, and is
    // never handed on garbled. Its message is fixed text and at most a key id.
    if (error instanceof EncryptionError) {
      io.err(`pathways: the engine stopped: ${error.message} (${error.code}).\n`);
      return EXIT.failed;
    }
    // Anything else (a database server that went away, say) is reported by its code alone: a
    // driver's own text can name the server, the login or a stored value.
    const code = errorCode(error);
    io.err(`pathways: the engine stopped on an error${code === undefined ? "" : ` (${code})`}.\n`);
    return EXIT.failed;
  } finally {
    run.onStopping();
    await engine.stop();
  }
  // The lease was lost between passes: the run ended at once, before the next check.
  if (run.lease?.lossReason !== undefined) return leaseLost(io, run.lease.lossReason);
  return EXIT.ok;
}

/**
 * `pathways probe [--ready] [--if-configured]`: asks the probe listener of the engine running in
 * this project for `/livez`, or `/readyz`, and exits 0 on a 200 and 1 on anything else, a
 * configuration without a `probes` block or one that is invalid among them, so a container's health
 * check reads only 0 or 1. Prints the one word the engine answered, or why there was none. With
 * `--if-configured`, a configuration without a `probes` block exits 0 and prints `not-configured`:
 * the image's health check then has nothing to ask, and a running container is all it can say.
 */
async function probe(
  projectDir: string,
  options: { readonly ready: boolean; readonly ifConfigured: boolean },
  io: CliIo,
): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.failed;
  if (project.probes === undefined) {
    if (options.ifConfigured) {
      io.out("not-configured\n");
      return EXIT.ok;
    }
    io.err("pathways: pathways.yaml has no probes block, so there is nothing to ask.\n");
    return EXIT.failed;
  }
  const { ready } = options;
  const result = await askProbe(project.probes, { ready });
  if (result.status === undefined) {
    io.err(
      `pathways: the probe listener did not answer${result.code === undefined ? "" : ` (${result.code})`}.\n`,
    );
    return EXIT.failed;
  }
  // Only a word the engine answers is printed, never whatever else held the port.
  io.out(`${/^[a-z-]{1,40}$/.test(result.word) ? result.word : String(result.status)}\n`);
  return result.status === 200 ? EXIT.ok : EXIT.failed;
}

/**
 * `pathways validate`: the configuration checks `start` makes before it reads a secret, opens the
 * store or listens, with the same messages and exit code. That is everything `loadProject` checks
 * (the schema with its refinements, and every transform, module and hook file named), and that
 * `pathways.yaml` sets `encryption`. Secrets, TLS files and connections are left to `start`, since a
 * CI run seldom has them. With `--print`, the configuration as `start` reads it goes to stdout as
 * JSON in place of the summary: every setting resolved, secrets as the references start reads.
 */
async function validate(projectDir: string, print: boolean, io: CliIo): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  if (project.encryption === undefined) {
    reportConfigError(new ConfigError([ENCRYPTION_REQUIRED]), io);
    return EXIT.config;
  }
  if (print) {
    // The configuration holds no secret: tokens, secret headers, connection URLs and master keys
    // stay the names of the variables or files start reads them from. A URL read from the
    // environment may carry a token in its query string, so that query string is masked.
    const hidden = urlsFromEnvironment(project, io.env ?? process.env);
    const replacer = (key: string, value: unknown): unknown =>
      key === "url" && typeof value === "string" && hidden.has(value) ? maskQuery(value) : value;
    io.out(`${JSON.stringify(project, replacer, 2)}\n`);
    return EXIT.ok;
  }
  const names = project.channels.map((channel) => channel.name);
  io.out(
    `pathways: the configuration is valid: ${names.length} channel${names.length === 1 ? "" : "s"} (${names.join(", ")}).\n`,
  );
  return EXIT.ok;
}

/** The text `validate --print` shows in place of a masked query string. */
const MASKED_QUERY = "?(hidden)";

/** The URLs the configuration read from environment variables (not from a reference's default). */
function urlsFromEnvironment(project: ProjectConfig, env: Env): ReadonlySet<string> {
  const urls = new Set<string>();
  for (const reference of project.environment ?? []) {
    if (reference.from !== "environment" || !reference.key.endsWith(".url")) continue;
    const value = env[reference.variable];
    if (value !== undefined) urls.add(value);
  }
  return urls;
}

/** `url` with everything from its first `?` replaced by {@link MASKED_QUERY}, if it has one. */
function maskQuery(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : `${url.slice(0, query)}${MASKED_QUERY}`;
}

/** What `rekey` says when `pathways.yaml` names no keys. */
const REKEY_NEEDS_KEYS =
  "pathways.yaml: encryption: rekey needs encryption: { keys: [{ id, env: NAME }, { id, file: path } or { id, secret: { provider, name } }], current: id } or { provider: { module: path } }";

/** What `rekey` says about a custom store that cannot list and replace what it holds. */
const REKEY_NEEDS_CONTENT_STORE =
  "pathways: pathways.yaml: storage.module: rekey needs a store that also implements ContentStore (storedContent and replaceContent).\n";

async function rekeyStore(
  projectDir: string,
  encryptPlaintext: boolean,
  io: CliIo,
): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  if (project.encryption === undefined || project.encryption.kind === "none") {
    reportConfigError(new ConfigError([REKEY_NEEDS_KEYS]), io);
    return EXIT.config;
  }
  // An extension's log lines go to stderr here, so stdout holds only the counts.
  const bare = { env: io.env ?? process.env, logger: io.logger ?? pino(STDERR_LOG, stderr) };
  const secrets = await secretsOrExit(project, bare, "store", io);
  if (typeof secrets === "number") return secrets;
  const context = { ...bare, secrets };
  const keys = await keysOrExit(project, context, io);
  if (typeof keys === "number") return keys;
  /* v8 ignore next: every encryption but none has keys */
  if (keys === undefined) return EXIT.config;
  let store: MessageStore;
  try {
    // Rekey works on the store as it is, below encryption, to rewrite what it holds.
    store = await openRawStore(project, context);
  } catch (error) {
    return reportStoreError(error, io);
  }
  if (!isContentStore(store)) {
    await store.close();
    io.err(REKEY_NEEDS_CONTENT_STORE);
    return EXIT.failed;
  }
  let counts: RekeyCounts;
  try {
    counts = await rekey(store, keys, { encryptPlaintext });
  } finally {
    await store.close();
  }
  io.out(
    `re-encrypted under the current key: ${counts.reencrypted}\n` +
      `already under the current key: ${counts.current}\n` +
      `encrypted, stored while encryption was none: ${counts.encrypted}\n` +
      `left unencrypted: ${counts.unencrypted}\n` +
      `unreadable: ${counts.unreadable}\n` +
      `changed while rekey ran: ${counts.changed}\n`,
  );
  if (counts.unencrypted > 0) {
    io.err(
      "pathways: some values were stored while encryption was none; run rekey --encrypt-plaintext to encrypt them.\n",
    );
  }
  if (counts.unreadable > 0) {
    io.err(
      "pathways: some values could not be decrypted: they name a key that is not configured, or fail their integrity check. Keep every older key until rekey reports none.\n",
    );
  }
  if (counts.changed > 0) {
    io.err("pathways: some values changed while rekey ran; run it again.\n");
  }
  return rekeyComplete(counts) ? EXIT.ok : EXIT.failed;
}

async function test(
  projectDir: string,
  names: readonly string[],
  update: boolean,
  io: CliIo,
): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;

  const known = new Set(project.channels.map((channel) => channel.name));
  if (names.some((name) => !known.has(name))) {
    io.err(`pathways: no such channel. The channels are: ${[...known].join(", ")}\n`);
    return EXIT.usage;
  }
  const channels =
    names.length === 0 ? project.channels : project.channels.filter((c) => names.includes(c.name));
  const summary = await runChannelTests(channels, {
    update,
    out: (line) => io.out(`${line}\n`),
    project,
    env: io.env ?? process.env,
  });
  const parts = [`${summary.passed} passed`, `${summary.failed} failed`];
  if (summary.updated > 0) parts.push(`${summary.updated} updated`);
  io.out(`${parts.join(", ")}\n`);
  return summary.failed > 0 ? EXIT.failed : EXIT.ok;
}

/** A command that reads or acts on stored messages, parsed: what to run once the store is open. */
type OperatorRun = (context: OperatorContext) => Promise<number>;

/**
 * The operator commands: status, messages, replay, clear, retention, audit, lease and migrate.
 * Parses and checks the arguments first, so a mistake changes nothing and opens nothing; then loads
 * the project, opens its store and runs.
 */
async function operator(
  command: string,
  rest: readonly string[],
  values: Values,
  projectDir: string,
  io: CliIo,
): Promise<number> {
  const parsed = parseOperator(command, rest, values, io);
  if (typeof parsed === "number") return parsed;

  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  // verify reads what a running engine stored, so where SQLite has no file there is nothing to read,
  // and opening it would leave an empty database behind.
  if (
    command === "verify" &&
    project.storage.kind === "sqlite" &&
    !existsSync(project.storage.file)
  ) {
    io.err(
      "pathways: there is no database to verify against; give --samples to verify synthetic inputs.\n",
    );
    return EXIT.failed;
  }
  // Extensions log to stderr, so stdout holds only the report.
  const bare = { env: io.env ?? process.env, logger: io.logger ?? pino(STDERR_LOG, stderr) };
  // The engine-wide hooks receive each audit entry this command writes, as `pathways start`'s do.
  // status and audit write none, so they load no hooks.
  const withHooks =
    command !== "status" && command !== "audit" && !(command === "lease" && rest[0] === "status");
  // Every secret the command reads, resolved once: the store and the hooks share the one result.
  const secrets = await secretsOrExit(project, bare, withHooks ? "operator" : "store", io);
  if (typeof secrets === "number") return secrets;
  const context = { ...bare, secrets };
  // verify runs a candidate project, which may be on a newer Pathways than the engine running on
  // this database: it applies no schema step, so it never changes the schema under that engine.
  const wrapped =
    command === "migrate"
      ? await openForMigrate(project, context, io)
      : command === "verify"
        ? await openWrapped(project, { ...context, migrate: "none" }, io, command)
        : await openWrapped(project, context, io);
  if (typeof wrapped === "number") return wrapped;
  const { store } = wrapped;
  const audit = auditFor(store, io, (error) => {
    io.err(`pathways: an audit listener failed (${errorCode(error) ?? "no code"}).\n`);
  });
  let hooks: HookSet | undefined;
  if (withHooks) {
    const opened = await hooksOrExit(project, context, io);
    if (typeof opened === "number") {
      await store.close();
      return opened;
    }
    hooks = opened;
    audit.subscribe((entry) => {
      opened.emit(auditEvent(entry));
    });
  }
  try {
    return await parsed({
      project,
      store,
      audit,
      json: values.json === true,
      out: io.out,
      err: io.err,
      now: Date.now,
      env: context.env,
    });
  } catch (error) {
    // A stored value that cannot be decrypted: never shown garbled. Fixed text and at most a key id.
    if (error instanceof EncryptionError) {
      io.err(`pathways: the command stopped: ${error.message} (${error.code}).\n`);
      return EXIT.failed;
    }
    // The database refused a read or a write (it can be busy for longer than the wait, or full).
    const code = errorCode(error) ?? (error instanceof Error ? error.name : "error");
    io.err(`pathways: the command could not finish (${code}).\n`);
    return EXIT.failed;
  } finally {
    // Each hook gets up to its time limit to send what is queued; the command waits no longer.
    await hooks?.stop();
    await store.close();
  }
}

/** What `migrate` says about a custom store, which keeps its own schema. */
const MIGRATE_NEEDS_BUILT_IN_STORE =
  "pathways: pathways.yaml: storage.module: migrate changes the schema of the built-in stores; a custom store keeps its own.\n";

/**
 * Opens the project's built-in store for `migrate`: below encryption, which a schema step does not
 * need, and with the schema read and left as it is, so the command applies what it is asked to.
 */
async function openForMigrate(
  project: ProjectConfig,
  context: OpenStoreContext,
  io: CliIo,
): Promise<{ readonly store: MessageStore } | number> {
  if (project.storage.kind === "module") {
    io.err(MIGRATE_NEEDS_BUILT_IN_STORE);
    return EXIT.failed;
  }
  try {
    return { store: await openRawStore(project, { ...context, migrate: "inspect" }) };
  } catch (error) {
    return reportStoreError(error, io);
  }
}

/** The engine-wide hooks of `pathways.yaml`, started, or the exit code, having said why not. */
async function hooksOrExit(
  project: ProjectConfig,
  context: OpenStoreContext,
  io: CliIo,
): Promise<HookSet | number> {
  try {
    return await HookSet.open(project.hooks, {
      file: "pathways.yaml",
      channel: undefined,
      dir: project.root,
      ...context,
    });
  } catch (error) {
    if (error instanceof ExtensionLoadError) {
      io.err(`pathways: ${error.message}\n`);
      return EXIT.failed;
    }
    /* v8 ignore next: HookSet.open throws only ExtensionLoadError and ConfigError */
    if (!(error instanceof ConfigError)) throw error;
    reportConfigError(error, io);
    return EXIT.config;
  }
}

function parseOperator(
  command: string,
  rest: readonly string[],
  values: Values,
  io: CliIo,
): OperatorRun | number {
  switch (command) {
    case "status":
      return (context) => statusCommand(context, rest);
    case "messages": {
      if (rest[0] === "show") {
        const listing = ["channel", "status", "since", "until", "limit", "before"] as const;
        if (rest.length !== 2 || listing.some((name) => values[name] !== undefined)) {
          return usage(io);
        }
        /* v8 ignore next -- rest holds exactly two entries here, so rest[1] is set */
        const id = parseId(rest[1] ?? "");
        if (id === undefined) return invalid(io, "a message id is a positive whole number.");
        return (context) => showCommand(context, id, values.content === true);
      }
      if (rest.length > 0 || values.content !== undefined) return usage(io);
      const filters = parseListing(values, io);
      if (typeof filters === "number") return filters;
      const state = values.status === undefined ? undefined : parseState(values.status);
      if (values.status !== undefined && state === undefined) {
        return invalid(io, "--status takes a message state.");
      }
      return (context) => listCommand(context, { ...filters, state });
    }
    case "replay":
    case "clear": {
      if (rest.length === 0) return invalid(io, `${command} needs at least one message id.`);
      const ids = rest.map(parseId);
      if (ids.some((id) => id === undefined)) {
        return invalid(io, "a message id is a positive whole number.");
      }
      const unique = [...new Set(ids as number[])];
      return command === "replay"
        ? (context) => replayCommand(context, unique, values.resend === true)
        : (context) => clearCommand(context, unique);
    }
    case "retention":
      if (rest.length > 0) return usage(io);
      return (context) => retentionCommand(context, values["dry-run"] === true);
    case "verify": {
      // run() parsed these already, and sent samples elsewhere.
      const parsed = parseVerify(rest, values, io) as ParsedVerify;
      return (context) =>
        knownChannel(context.project, parsed.channel, io) ??
        verifyCommand(context, parsed.selection, parsed.channel);
    }
    case "migrate": {
      if (rest.length > 0) return usage(io);
      const flags = { contract: values.contract === true, dryRun: values["dry-run"] === true };
      // openForMigrate opens a built-in store, which is a Store.
      return (context) =>
        migrateCommand(context, (options) => (context.store as Store).migrate(options), flags);
    }
    case "lease":
      if (rest.length !== 1) return usage(io);
      if (rest[0] === "status") {
        return values.force === undefined ? leaseStatusCommand : usage(io);
      }
      if (rest[0] !== "release") return usage(io);
      if (values.force !== true) {
        return invalid(
          io,
          "lease release frees the lease of an engine whose host is gone; add --force to say it is.",
        );
      }
      return leaseReleaseCommand;
    default: {
      // audit: OPTIONS lists exactly these commands.
      if (rest.length > 0) return usage(io);
      const filters = parseListing(values, io);
      if (typeof filters === "number") return filters;
      const action = values.action === undefined ? undefined : parseAction(values.action);
      if (values.action !== undefined && action === undefined) {
        return invalid(io, "--action takes an audit action.");
      }
      const messageId = values.message === undefined ? undefined : parseId(values.message);
      if (values.message !== undefined && messageId === undefined) {
        return invalid(io, "a message id is a positive whole number.");
      }
      return (context) => auditCommand(context, { ...filters, action, messageId });
    }
  }
}

/** `pathways verify`'s arguments, parsed. */
interface ParsedVerify {
  readonly selection: VerifySelection;
  readonly channel: string | undefined;
}

/** How far back `pathways verify` reads stored messages when no selection is given. */
const VERIFY_DEFAULT_SINCE = "24h";

/**
 * `pathways verify`'s arguments, parsed, or the exit code of a usage error: at most one of
 * `--since`, `--ids` and `--samples`, stored messages since {@link VERIFY_DEFAULT_SINCE} by default.
 */
function parseVerify(rest: readonly string[], values: Values, io: CliIo): ParsedVerify | number {
  if (rest.length > 0) return usage(io);
  const chosen = [values.since, values.ids, values.samples].filter((v) => v !== undefined);
  if (chosen.length > 1) return invalid(io, "verify takes one of --since, --ids and --samples.");
  if (values.channel !== undefined && !isChannelName(values.channel)) {
    return invalid(io, "--channel takes a channel name.");
  }
  const { channel } = values;
  if (values.samples !== undefined) {
    return { selection: { kind: "samples", dir: values.samples }, channel };
  }
  if (values.ids !== undefined) {
    const ids = values.ids.split(",").map(parseId);
    if (ids.some((id) => id === undefined)) {
      return invalid(io, "--ids takes message ids, positive whole numbers joined by commas.");
    }
    return { selection: { kind: "ids", ids: [...new Set(ids as number[])] }, channel };
  }
  const since = parseTime(values.since ?? VERIFY_DEFAULT_SINCE, Date.now());
  if (since === undefined) {
    return invalid(io, "--since takes a date, a date and time, or a duration such as 24h or 7d.");
  }
  return { selection: { kind: "since", since }, channel };
}

/** Undefined when `channel` is not given or the project has it; else says so and returns 2. */
function knownChannel(
  project: ProjectConfig,
  channel: string | undefined,
  io: CliIo,
): Promise<number> | undefined {
  if (channel === undefined || project.channels.some((c) => c.name === channel)) return undefined;
  io.err(
    `pathways: no such channel. The channels are: ${project.channels.map((c) => c.name).join(", ")}\n`,
  );
  return Promise.resolve(EXIT.usage);
}

/**
 * `pathways verify --samples`: synthetic inputs, so no store is opened and nothing is audited. The
 * project is loaded as `test` loads it.
 */
async function verifySamples(
  projectDir: string,
  parsed: ParsedVerify,
  json: boolean,
  io: CliIo,
): Promise<number> {
  const project = await load(projectDir, io);
  if (project === undefined) return EXIT.config;
  return (
    (await knownChannel(project, parsed.channel, io)) ??
    verifyCommand({ project, json, out: io.out, err: io.err }, parsed.selection, parsed.channel)
  );
}

/** The filters `messages` and `audit` share, parsed, or the exit code of a usage error. */
function parseListing(
  values: Values,
  io: CliIo,
):
  | {
      channel: string | undefined;
      since: string | undefined;
      until: string | undefined;
      before: number | undefined;
      limit: number;
    }
  | number {
  const now = Date.now();
  if (values.channel !== undefined && !isChannelName(values.channel)) {
    return invalid(io, "--channel takes a channel name.");
  }
  const since = values.since === undefined ? undefined : parseTime(values.since, now);
  const until = values.until === undefined ? undefined : parseTime(values.until, now);
  if (
    (values.since !== undefined && since === undefined) ||
    (values.until !== undefined && until === undefined)
  ) {
    return invalid(
      io,
      "--since and --until take a date, a date and time, or a duration such as 24h or 7d.",
    );
  }
  const before = values.before === undefined ? undefined : parseId(values.before);
  if (values.before !== undefined && before === undefined) {
    return invalid(io, "--before takes an id from the last page.");
  }
  const limit = values.limit === undefined ? DEFAULT_LIMIT : parseLimit(values.limit);
  if (limit === undefined) return invalid(io, "--limit takes a whole number from 1 to 1000.");
  return { channel: values.channel, since, until, before, limit };
}

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      project: { type: "string", short: "C" },
      once: { type: "boolean" },
      standby: { type: "boolean" },
      ready: { type: "boolean" },
      "if-configured": { type: "boolean" },
      "no-migrate": { type: "boolean" },
      contract: { type: "boolean" },
      force: { type: "boolean" },
      update: { type: "boolean" },
      print: { type: "boolean" },
      json: { type: "boolean" },
      channel: { type: "string" },
      status: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "string" },
      before: { type: "string" },
      content: { type: "boolean" },
      resend: { type: "boolean" },
      "dry-run": { type: "boolean" },
      action: { type: "string" },
      message: { type: "string" },
      "encrypt-plaintext": { type: "boolean" },
      ids: { type: "string" },
      samples: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
}
